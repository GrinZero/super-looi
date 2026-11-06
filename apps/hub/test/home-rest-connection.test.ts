import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import fastify from "fastify";
import { buildApp } from "../src/app.js";
import { HomeAssistantRestTransport } from "../src/home/rest-transport.js";
import { createHomeConnection } from "../src/home/connection.js";
import { HomeAssistantGateway } from "../src/home/gateway.js";
import { executeHomeVoiceTool } from "../src/home/voice-tools.js";

const state = (id = "light.actual", value = "off") => ({
  entity_id: id, state: value, attributes: { friendly_name: "真实设备", supported_color_modes: ["brightness"] },
  last_changed: new Date().toISOString(), last_updated: new Date().toISOString(),
});

async function fixture(run: (url: string, requests: Array<{ path: string; authorization?: string; body: unknown }>) => Promise<void>, failState = false) {
  const requests: Array<{ path: string; authorization?: string; body: unknown }> = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ path: req.url!, authorization: req.headers.authorization, body: body ? JSON.parse(body) : null });
    res.setHeader("Content-Type", "application/json");
    if (failState && (req.url !== "/api/states" || requests.filter((r) => r.path === "/api/states").length > 1)) { res.statusCode = 401; res.end("{}"); return; }
    const camera = { ...state("camera.private"), attributes: { access_token: "camera-secret", entity_picture: "/api/camera_proxy?token=camera-secret" } };
    res.end(JSON.stringify(req.url === "/api/states" ? [state(), state("lock.front_door"), state("fan.actual"), camera] : req.method === "POST" ? [] : state()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as { port: number };
    await run(`http://127.0.0.1:${address.port}`, requests);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
  }
}

describe("Real Home Assistant transport", () => {
  it("uses authenticated REST reads and service calls without treating acknowledgement as a changed state", async () => fixture(async (url, requests) => {
    const transport = new HomeAssistantRestTransport({ url, token: "private-token" });
    assert.equal(transport.isHealthy(), false);
    assert.equal((await transport.listStates()).length, 4);
    assert.equal(transport.isHealthy(), true);
    assert.equal((await transport.callService("light", "turn_on", { entity_id: "light.actual" })).success, true);
    assert.equal((await transport.fetchState("light.actual"))?.state, "off");
    assert.equal(requests[0].authorization, "Bearer private-token");
    assert.equal(requests[1].path, "/api/services/light/turn_on");
    assert.deepEqual(requests[1].body, { entity_id: "light.actual" });
    assert.ok(!JSON.stringify(transport.getStatus()).includes("private-token"));
  }));

  it("has no fake demo entities without configuration and only enables explicit supported entities", async () => {
    const unconfigured = createHomeConnection({});
    await unconfigured.refresh();
    assert.equal(unconfigured.transport.isHealthy(), false);
    assert.deepEqual(await unconfigured.gateway.listEntities(), []);
    await fixture(async (url) => {
      const connection = createHomeConnection({ HA_URL: url, HA_TOKEN: "token", HA_ALLOWED_ENTITIES: "light.actual,lock.front_door" });
      await connection.refresh();
      assert.deepEqual((await connection.gateway.listEntities()).map((s) => s.entity_id), ["light.actual", "lock.front_door"]);
      assert.equal((await connection.gateway.executeCommand({ entity_id: "lock.front_door", domain: "lock", service: "turn_on", service_data: {} })).status, "rejected");
      const all = createHomeConnection({ HA_URL: url, HA_TOKEN: "token", HA_ALLOWED_ENTITIES: "*" });
      await all.refresh();
      assert.deepEqual((await all.gateway.listEntities()).map((s) => s.entity_id), ["light.actual", "lock.front_door", "fan.actual", "camera.private"]);
    });
  });

  it("redacts upstream errors and rejects malformed states and redirects", async () => {
    for (const response of [new Response("secret", { status: 401 }), Response.json({ wrong: true })]) {
      const adapter = new HomeAssistantRestTransport({ url: "http://localhost:8123", token: "secret", fetch: async () => response });
      await assert.rejects(adapter.listStates());
      assert.equal(adapter.isHealthy(), false);
      assert.ok(!JSON.stringify(adapter.getStatus()).includes("secret"));
    }
    assert.throws(() => new HomeAssistantRestTransport({ url: "http://user:secret@localhost" }));
    await fixture(async (url) => {
      const adapter = new HomeAssistantRestTransport({ url, token: "token", fetch: async (_url, options) => {
        assert.equal(options?.redirect, "error"); throw new Error("secret url failure");
      } });
      assert.equal(await adapter.fetchState("light.actual"), null);
      assert.equal(adapter.getStatus().error, "ha_connection_failed");
    });
  });

  it("does not expose camera credentials through discovery", async () => fixture(async (url) => {
    const connection = createHomeConnection({ HA_URL: url, HA_TOKEN: "token", HA_ALLOWED_ENTITIES: "*" });
    const app = fastify();
    connection.register(app);
    try {
      const response = await app.inject({ url: "/api/home/connection" });
      assert.equal(response.statusCode, 200);
      assert.ok(!response.body.includes("camera-secret"));
      assert.ok(!response.body.includes("access_token"));
      assert.ok(response.body.includes("camera.private"));
    } finally { await app.close(); }
  }));

  it("redacts text entity contents on list and individual reads, preserving explicit unknown values", async () => {
    for (const value of ["private-text-secret", "unknown", "unavailable", ""]) {
      const text = state("text.private", value);
      const adapter = new HomeAssistantRestTransport({ url: "http://localhost", token: "token",
        fetch: async (url) => Response.json(String(url).endsWith("/states") ? [text] : text) });
      const list = await adapter.listStates(); const single = await adapter.fetchState(text.entity_id);
      assert.equal(single?.state, value === "private-text-secret" ? "已隐藏" : value);
      assert.ok(!JSON.stringify([list, single]).includes("private-text-secret"));
    }
  });

  it("uses one bulk request for a thousand-entity dashboard instead of per-entity GETs", async () => {
    let requests = 0;
    const snapshots = Array.from({ length: 1100 }, (_, index) => state(`light.actual_${index}`));
    const transport = new HomeAssistantRestTransport({ url: "http://localhost", token: "token", fetch: async (url) => {
      requests++; assert.equal(String(url), "http://localhost/api/states"); return Response.json(snapshots);
    } });
    const gateway = new HomeAssistantGateway({ transport, initialEntities: snapshots.map((s) => ({ entity_id: s.entity_id,
      friendly_name: s.entity_id, domain: "light", supported_features: ["turn_on", "turn_off"], is_whitelisted: true })) });
    const app = buildApp({ homeGateway: gateway });
    try {
      const response = await app.inject({ url: "/api/home/states" });
      assert.equal(response.json().entities.length, 1100); assert.equal(requests, 1);
    } finally { await app.close(); }
  });

  it("reports failed state reads as unhealthy and prevents demo seeding into a real gateway", async () => fixture(async (url) => {
    const connection = createHomeConnection({ HA_URL: url, HA_TOKEN: "token", HA_ALLOWED_ENTITIES: "*" });
    const app = buildApp({ homeGateway: connection.gateway });
    connection.register(app);
    try {
      const response = await app.inject({ url: "/api/home/states" });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().healthy, false);
      assert.ok(response.json().entities.every((s: { snapshot: unknown }) => s.snapshot === null));
      await app.inject({ method: "POST", url: "/api/demo/seed" });
      assert.ok(!(await connection.gateway.listEntities()).some((e) => e.entity_id.includes("study")));
    } finally { await app.close(); }
  }, true));

  it("rejects nonnumeric sensors instead of inventing zero", async () => {
    const gateway = new HomeAssistantGateway({ transport: {
      async callService() { return { success: true }; }, async fetchState() { return state("sensor.study_temperature", "unavailable"); },
      isHealthy() { return true; }, getLastVerifiedAt() { return null; },
    } });
    await assert.rejects(gateway.readEnvironmentalMetric("temperature"), /valid numeric reading/);
  });

  it("voice tools list observed devices and never claim an unverified or blocked control succeeded", async () => fixture(async (url, requests) => {
    const connection = createHomeConnection({ HA_URL: url, HA_TOKEN: "token", HA_ALLOWED_ENTITIES: "*" });
    await connection.refresh();
    const listed = await executeHomeVoiceTool("list_home_devices", { query: "light.actual" }, connection.gateway);
    assert.ok(JSON.stringify(listed).includes('"state":"off"'));
    const blocked = await executeHomeVoiceTool("control_home_device", { entity_id: "lock.front_door", service: "turn_on" }, connection.gateway);
    assert.ok(JSON.stringify(blocked).includes("rejected"));
    assert.equal(requests.filter((r) => r.path.startsWith("/api/services/")).length, 0);
    const unverified = await executeHomeVoiceTool("control_home_device", { entity_id: "light.actual", service: "turn_on" }, connection.gateway);
    assert.ok(JSON.stringify(unverified).includes("unverified"));
    assert.ok(String(unverified.instruction).includes("尚未确认"));
  }));

  it("blocks domain spoofing, arbitrary services, alternate target selectors and invalid parameters before transport", async () => {
    let calls = 0;
    const gateway = new HomeAssistantGateway({ transport: {
      async callService() { calls++; return { success: true }; }, async fetchState() { calls++; return null; },
      isHealthy() { return true; }, getLastVerifiedAt() { return null; },
    } });
    const base = { entity_id: "light.study_ceiling", domain: "light", service: "turn_on", service_data: {} };
    for (const patch of [{ domain: "homeassistant" }, { service: "reload" }, { service_data: { area_id: "all" } },
      { service_data: { entity_id: ["lock.front_door"] } }, { service_data: { brightness: "200" } },
      { service_data: { brightness: NaN } }]) {
      assert.equal((await gateway.executeCommand({ ...base, ...patch })).status, "rejected");
    }
    assert.equal(calls, 0);
  });

  it("polls delayed readback without reissuing the service and refuses unchanged stale snapshots", async () => {
    let writes = 0; let reads = 0;
    const initial = state("light.study_ceiling");
    const adapter = {
      async callService() { writes++; return { success: true }; },
      async fetchState() { reads++; return reads < 3 ? initial : { ...state("light.study_ceiling", "on"), attributes: {} }; },
      isHealthy() { return true; }, getLastVerifiedAt() { return null; },
    };
    const gateway = new HomeAssistantGateway({ transport: adapter });
    assert.equal((await gateway.executeCommand({ entity_id: initial.entity_id, domain: "light", service: "turn_on", service_data: {}, timeout_ms: 600 })).status, "verified");
    assert.equal(writes, 1);
    const stale = { ...state("light.study_ceiling", "on"), last_updated: new Date(Date.now() - 60000).toISOString() };
    adapter.fetchState = async () => stale;
    assert.equal((await gateway.executeCommand({ entity_id: stale.entity_id, domain: "light", service: "turn_on", service_data: {}, timeout_ms: 0 })).status, "unverified");
  });
});
