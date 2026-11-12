import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { HomeRuntime } from "../runtime/home.js";
import { createHomeTools } from "../runtime/tools/home-tools.js";

for (const stage of ["write", "readback"] as const) {
  test(`home tools preserve ${stage} HTTP failure through the runtime and SQLite evidence`, async () => {
    let writes = 0;
    const now = new Date().toISOString();
    const state = { entity_id: "light.hall", state: "off", attributes: {
      friendly_name: "大厅台灯", brightness: 1, supported_color_modes: ["brightness"],
    }, last_changed: now, last_updated: now };
    const slots = new Map<string, string>();
    const home = new HomeRuntime({
      vault: { get: key => slots.get(key) ?? "", set: (key, value) => { slots.set(key, value); }, remove: key => { slots.delete(key); } },
      registry: async () => new Map([["light.hall", { device_id: "lamp", device_name: "大厅台灯", room: "大厅" }]]),
      fetch: async (input) => {
        const url = String(input);
        if (url.includes("/services/")) {
          writes++;
          return stage === "write" ? new Response("fixture-token", { status: 403 }) : new Response("[]");
        }
        if (writes && stage === "readback") return new Response("fixture-token", { status: 503 });
        return new Response(JSON.stringify(url.endsWith("/states") ? [state] : state));
      },
    });
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE home_action_evidence (request_id TEXT PRIMARY KEY, task_id TEXT, evidence TEXT NOT NULL)");
    try {
      await home.configure({ mode: "external_ha", haUrl: "https://fixture.invalid", haToken: "fixture-token" });
      const connection = await home.connect();
      const tool = createHomeTools({ home, database: db, getActiveTaskId: () => "task-lamp" }).find(tool => tool.name === "control_home_device")!;
      const result = await tool.execute(`call-${stage}`, {
        entity_id: "light.hall", connectionId: connection.connectionId, service: "turn_on", brightness: 255,
      });
      const outcome = JSON.parse(result.content.find(item => item.type === "text")!.text);
      assert.equal(outcome.receipt.reason_code, stage === "write" ? "ha_http_403" : "ha_http_503");
      assert.equal(outcome.receipt.diagnostics.stage, stage);
      assert.equal(outcome.receipt.diagnostics.write_acknowledged, stage === "readback");
      assert.equal(writes, 1);
      if (stage === "write") assert.match(outcome.instruction, /指令写入未确认成功/);
      const saved = JSON.parse(String(db.prepare("SELECT evidence FROM home_action_evidence").get()!.evidence));
      assert.deepEqual(saved.receipt, outcome.receipt);
      assert.ok(!JSON.stringify(saved).includes("fixture-token"));
    } finally { home.close(); db.close(); }
  });
}

test("connection and multi-source read failures retain upstream details without hiding healthy devices", async () => {
  let fail = true;
  const slots = new Map<string, string>(), cache = new Map<string, string>();
  const now = new Date().toISOString();
  const state = { entity_id: "light.hall", state: "off", attributes: { friendly_name: "大厅台灯" }, last_changed: now, last_updated: now };
  const home = new HomeRuntime({
    vault: { get: key => slots.get(key) ?? "", set: (key, value) => { slots.set(key, value); }, remove: key => { slots.delete(key); } },
    cache: { get: key => cache.get(key) ?? null, set: (key, value) => { cache.set(key, value); }, remove: key => { cache.delete(key); } },
    registry: async () => new Map([["light.hall", { device_id: "lamp", device_name: "大厅台灯" }]]),
    fetch: async () => fail ? new Response("fixture-token", { status: 503 }) : new Response(JSON.stringify([state])),
  });
  try {
    await home.configure({ mode: "external_ha", haUrl: "https://fixture.invalid", haToken: "fixture-token" });
    const unavailable = await home.list();
    assert.equal(unavailable.error, "ha_http_503");
    assert.match(JSON.stringify(unavailable.diagnostics), /"http_status":503/);
    fail = false;
    await home.connect();
    await home.dashboard();
    fail = true;
    await home.dashboard();
    const single = JSON.parse(cache.get("dashboard-v1")!);
    assert.equal(single.records[0].snapshot.attributes.read_error.http_status, 503);
    assert.equal(home.connection().sources?.external_ha.error, "ha_http_503");
    fail = false;
    await home.dashboard();
    assert.equal(home.connection().sources?.external_ha.error, null);
    fail = true;
    await home.configure({ mode: "external_ha", enabledSources: { external_ha: true, simulation: true, direct_miot: false } });
    const partial = await home.connect();
    assert.equal(partial.sources?.external_ha.error, "ha_http_503");
    assert.match(JSON.stringify(partial.sources?.external_ha.diagnostics), /"http_status":503/);
    fail = false;
    await home.connect();
    await home.dashboard();
    fail = true;
    const dashboard = await home.dashboard();
    const saved = JSON.parse(cache.get("dashboard-v1")!);
    const lamps = saved.records.filter((record: { entity_id: string }) => record.entity_id === "light.hall");
    assert.equal(lamps.length, 1);
    assert.equal(lamps[0].snapshot.attributes.read_error.http_status, 503);
    assert.ok(dashboard.totalAppliances > 1);
    assert.equal(home.connection().sources?.external_ha.error, "ha_http_503");
    fail = false;
    await home.dashboard();
    assert.equal(home.connection().sources?.external_ha.error, null);
  } finally { home.close(); }
});

test("an old source read cannot overwrite a newer connection's status", async () => {
  let hold = false;
  let finish!: (value: Response) => void, started!: () => void;
  const pending = new Promise<void>(resolve => { started = resolve; });
  const now = new Date().toISOString();
  const state = { entity_id: "light.hall", state: "off", attributes: { friendly_name: "大厅台灯" }, last_changed: now, last_updated: now };
  const slots = new Map<string, string>();
  const home = new HomeRuntime({
    vault: { get: key => slots.get(key) ?? "", set: (key, value) => { slots.set(key, value); }, remove: key => { slots.delete(key); } },
    registry: async () => new Map([["light.hall", { device_id: "lamp", device_name: "大厅台灯" }]]),
    fetch: async () => hold ? new Promise<Response>(resolve => { finish = resolve; started(); }) : new Response(JSON.stringify([state])),
  });
  try {
    await home.configure({ mode: "external_ha", haUrl: "https://fixture.invalid", haToken: "fixture-token", enabledSources: { external_ha: true, simulation: true } });
    await home.connect();
    hold = true;
    const old = home.dashboard();
    await pending;
    hold = false;
    await home.connect();
    finish(new Response("old request failed", { status: 503 }));
    await assert.rejects(old, /home_connection_changed/);
    assert.equal(home.connection().sources?.external_ha.healthy, true);
    assert.equal(home.connection().sources?.external_ha.error, null);
  } finally { home.close(); }
});
