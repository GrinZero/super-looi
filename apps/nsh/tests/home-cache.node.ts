import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createMiotCredentials, MIOT_CLIENT_ID } from "@super-looi/home-assistant";
import { createHomeCache } from "../runtime/home-cache.js";
import { HomeRuntime, type HomeVault } from "../runtime/home.js";
import { lightSpec, lightUrn } from "../../../packages/home-assistant/test/miot-fixtures.js";

function vaultFixture(): HomeVault {
  const slots = new Map<string, string>();
  return {
    get: (key) => slots.get(key) ?? "",
    set: (key, value) => { slots.set(key, value); },
    remove: (key) => { slots.delete(key); },
  };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
const registry = async () => new Map([
  ["light.study", { device_id: "study-lamp", room: "书房" }],
]);
const haState = (state: string) => ({
  entity_id: "light.study", state,
  attributes: { friendly_name: "书房灯", brightness: 128, supported_color_modes: ["brightness"] },
  last_changed: new Date().toISOString(),
  last_updated: new Date().toISOString(),
});

test("home restores SQLite inventory before a delayed refresh and persists the new state", async () => {
  const directory = mkdtempSync(join(tmpdir(), "looi-home-cache-"));
  const path = join(directory, "runtime.sqlite");
  const vault = vaultFixture();
  let db = new DatabaseSync(path);
  let home = new HomeRuntime({
    vault, cache: createHomeCache(db), registry,
    fetch: async () => new Response(JSON.stringify([haState("off")])),
  });
  try {
    assert.equal(home.cachedDashboard(), null);
    await home.configure({ mode: "external_ha", haUrl: "https://fixture.invalid", haToken: "fixture" });
    const initial = await home.dashboard();
    assert.equal(initial.totalAppliances, 1);
    assert.equal(initial.allAppliances[0].capabilities.power?.isOn, false);
    home.close();
    db.close();

    db = new DatabaseSync(path);
    const entered = deferred(), release = deferred();
    let requests = 0;
    home = new HomeRuntime({
      vault, cache: createHomeCache(db), registry,
      fetch: async () => {
        requests++;
        entered.resolve();
        await release.promise;
        return new Response(JSON.stringify([haState("on")]));
      },
    });
    const restored = home.cachedDashboard()!;
    assert.equal(requests, 0);
    assert.equal(restored.allAppliances[0].capabilities.power?.isOn, false);
    assert.equal(home.connection().healthy, false);
    assert.equal(home.connection().connectionId, null);
    assert.equal(home.connection().lastVerifiedAt, null);
    home.setApplianceLayout(restored.allAppliances[0].id, { span: "2x2" });
    assert.equal(home.cachedDashboard()!.allAppliances[0].span, "2x2");
    assert.equal(home.cachedDashboard("en-US")!.homeName, "My Home");

    const refresh = home.dashboard();
    await entered.promise;
    assert.equal(home.cachedDashboard()!.allAppliances[0].capabilities.power?.isOn, false);
    release.resolve();
    assert.equal((await refresh).allAppliances[0].capabilities.power?.isOn, true);
    home.close();
    db.close();

    db = new DatabaseSync(path);
    home = new HomeRuntime({ vault, cache: createHomeCache(db), registry });
    assert.equal(home.cachedDashboard()!.allAppliances[0].capabilities.power?.isOn, true);
    assert.equal(home.cachedDashboard()!.allAppliances[0].span, "2x2");
  } finally {
    home.close(); db.close(); rmSync(directory, { recursive: true });
  }
});

test("failed refresh retains the snapshot while a new binding or empty inventory replaces it", async () => {
  const vault = vaultFixture(), db = new DatabaseSync(":memory:"), cache = createHomeCache(db);
  let fail = false, empty = false;
  const options = { vault, cache, registry, fetch: (async () => {
    if (fail) throw new Error("offline");
    return new Response(JSON.stringify(empty ? [] : [haState("on")]));
  }) as typeof fetch };
  let home = new HomeRuntime(options);
  try {
    await home.configure({ mode: "external_ha", haUrl: "https://fixture.invalid", haToken: "fixture" });
    await home.dashboard();
    home.close();
    fail = true;
    home = new HomeRuntime(options);
    assert.equal((await home.dashboard()).totalAppliances, 1);
    assert.equal(home.connection().healthy, false);
    fail = false;
    await home.connect();
    fail = true;
    assert.equal((await home.dashboard()).allAppliances[0].capabilities.power?.isOn, true);
    fail = false;
    empty = true;
    await home.connect();
    assert.equal((await home.dashboard()).totalAppliances, 0);
    assert.equal(home.cachedDashboard()!.totalAppliances, 0);
    empty = false;
    await home.connect();
    await home.dashboard();
    await home.configure({ mode: "external_ha", haToken: "replacement-account" });
    assert.equal(home.cachedDashboard(), null);
    assert.equal(cache.get("dashboard-v1"), null);
    await home.dashboard();
    await home.setSourceEnabled("external_ha", false);
    assert.equal(home.cachedDashboard(), null);
    assert.equal((await home.dashboard()).totalAppliances, 0);
  } finally { home.close(); db.close(); }
});

test("a failed source keeps its cached cards alongside refreshed sources until its inventory recovers", async () => {
  const vault = vaultFixture(), db = new DatabaseSync(":memory:"), cache = createHomeCache(db);
  let fail = false, empty = false;
  const options = { vault, cache, registry, fetch: (async () => {
    if (fail) throw new Error("offline");
    return new Response(JSON.stringify(empty ? [] : [haState("on")]));
  }) as typeof fetch };
  let home = new HomeRuntime(options);
  try {
    await home.configure({ mode: "external_ha", haUrl: "https://fixture.invalid", haToken: "fixture",
      enabledSources: { external_ha: true, simulation: true } });
    await home.dashboard();
    home.close();
    fail = true;
    home = new HomeRuntime(options);
    const partial = await home.dashboard();
    assert.equal(partial.allAppliances.filter((a) => a.source === "external_ha").length, 1);
    assert.ok(partial.allAppliances.some((a) => a.source === "simulation"));
    assert.equal(home.connection().sources?.external_ha.healthy, false);
    assert.equal(home.cachedDashboard()!.allAppliances.filter((a) => a.source === "external_ha").length, 1);
    home.close();
    home = new HomeRuntime(options);
    assert.equal(home.cachedDashboard()!.allAppliances.filter((a) => a.source === "external_ha").length, 1);
    fail = false; empty = true;
    assert.equal((await home.dashboard()).allAppliances.filter((a) => a.source === "external_ha").length, 0);
  } finally { home.close(); db.close(); }
});

for (const multiSource of [false, true]) {
  test(`MIoT ${multiSource ? "multi-source" : "single-source"} reuses schemas across reconnect/restart and clears rebound snapshots`, async () => {
    const vault = vaultFixture(), db = new DatabaseSync(":memory:"), cache = createHomeCache(db);
    const callbackId = "00000000-0000-0000-0000-000000000001";
    const scope = { region: "cn" as const, clientId: MIOT_CLIENT_ID, redirectUri: `http://homeassistant.local:8123/api/webhook/${callbackId}` };
    const credentialKey = `super-looi.miot.cn.${MIOT_CLIENT_ID}.${encodeURIComponent(scope.redirectUri)}`;
    const credentials = createMiotCredentials(scope, "ha.cache-fixture", { accessToken: "fixture", refreshToken: "refresh", expiresIn: 3600 }, Date.now());
    vault.set("home", JSON.stringify({
      version: 1,
      config: { mode: "direct_miot", region: "cn", haUrl: "", callbackId,
        ...(multiSource ? { enabledSources: { direct_miot: true, simulation: true } } : {}) },
      credentials: { [credentialKey]: JSON.stringify(credentials) },
    }));
    let specs = 0, refreshes = 0, failRead = false;
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      let value: unknown;
      if (url.includes("miot-spec.org")) { specs++; value = lightSpec(); }
      else if (url.includes("/oauth/get_token")) {
        refreshes++;
        value = { code: 0, result: { access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 } };
      } else if (url.endsWith("/homeroom/gethome")) value = { code: 0, result: { homelist: [] } };
      else if (url.endsWith("/home/device_list_page")) value = { code: 0, result: { list: [
        { did: "lamp-1", name: "书房灯", model: "test.light.v1", spec_type: lightUrn, isOnline: true },
      ] } };
      else if (url.endsWith("/miotspec/prop/get")) {
        if (failRead) return new Response("fixture read unavailable", { status: 503 });
        const body = JSON.parse(String(init?.body));
        value = { code: 0, result: body.params.map((property: { piid: number }) => ({ ...property, code: 0, value: property.piid === 1 ? true : property.piid === 2 ? 50 : 4000 })) };
      } else throw new Error(`unexpected URL ${url}`);
      return new Response(JSON.stringify(value));
    };
    let home = new HomeRuntime({ vault, cache, fetch: fetcher });
    try {
      const initial = await home.dashboard();
      const lamp = initial.allAppliances.find(appliance => appliance.deviceId === "lamp-1")!;
      assert.equal(lamp.capabilities.power?.entityId, "light.miot:lamp_u00002d1_s2");
      home.setApplianceLayout(lamp.id, { span: "2x2" });
      assert.equal(specs, 1);
      await home.connect();
      await home.dashboard();
      assert.equal(specs, 1);
      home.close();
      const legacyDashboard = JSON.parse(cache.get("dashboard-v1")!);
      for (const record of legacyDashboard.records) {
        if (record.device_id !== "lamp-1") continue;
        record.entity_id = record.entity_id.replace("miot:lamp_u00002d1_", "miot_00006c00006100006d00007000002d000031_");
        if (record.snapshot) record.snapshot.entity_id = record.entity_id;
      }
      cache.set("dashboard-v1", JSON.stringify(legacyDashboard));
      const saved = JSON.parse(vault.get("home"));
      saved.credentials[credentialKey] = JSON.stringify(createMiotCredentials(scope, credentials.deviceId,
        { accessToken: "expired", refreshToken: "refresh", expiresIn: 3600 }, Date.now() - 3600_000));
      vault.set("home", JSON.stringify(saved));
      home = new HomeRuntime({ vault, cache, fetch: fetcher });
      const restored = home.cachedDashboard()!.allAppliances.find(appliance => appliance.deviceId === "lamp-1")!;
      assert.equal(restored.id, lamp.id);
      assert.equal(restored.span, "2x2");
      assert.equal(restored.capabilities.power?.entityId, lamp.capabilities.power?.entityId);
      assert.equal(restored.capabilities.power?.isOn, true);
      await home.connect();
      assert.equal(refreshes, 1);
      assert.ok(home.cachedDashboard(), "token refresh must keep the same account's snapshot");
      assert.equal(specs, 1);
      failRead = true;
      const offline = await home.dashboard();
      assert.equal(offline.allAppliances.find(appliance => appliance.id === lamp.id)?.capabilities.power?.isOn, true);
      const upgraded = JSON.parse(cache.get("dashboard-v1")!).records.find((record: { entity_id: string }) =>
        record.entity_id === lamp.capabilities.power?.entityId);
      assert.equal(upgraded.snapshot.entity_id, lamp.capabilities.power?.entityId);
      failRead = false;
      const key = `miot-spec-v1:${lightUrn}`;
      const schema = JSON.parse(cache.get(key)!);
      schema.expiresAt = Date.now() - 1;
      cache.set(key, JSON.stringify(schema));
      await home.connect();
      assert.equal(specs, 2);
      const session = await home.beginMiotLogin();
      home.interceptMiotCallback(`${session.redirectUri}?state=${session.state}&code=fixture`);
      await home.finishMiotLogin("fixture");
      assert.equal(home.cachedDashboard(), null);
      assert.equal(specs, 2, "public specs survive account changes");
      await home.dashboard();
      await home.logoutMiot();
      assert.equal(home.cachedDashboard(), null);
      assert.equal(cache.get("dashboard-v1"), null);
    } finally { home.close(); db.close(); }
  });
}

test("direct MIoT and external HA route independent writes for a matching device ID", async () => {
  const vault = vaultFixture();
  const callbackId = "00000000-0000-0000-0000-000000000001";
  const redirectUri = `http://homeassistant.local:8123/api/webhook/${callbackId}`;
  const credentialKey = `super-looi.miot.cn.${MIOT_CLIENT_ID}.${encodeURIComponent(redirectUri)}`;
  const credentials = createMiotCredentials({ region: "cn", clientId: MIOT_CLIENT_ID, redirectUri },
    "ha.routing-fixture", { accessToken: "fixture", refreshToken: "refresh", expiresIn: 3600 }, Date.now());
  vault.set("home", JSON.stringify({
    version: 1,
    config: { mode: "direct_miot", region: "cn", haUrl: "", callbackId },
    credentials: { [credentialKey]: JSON.stringify(credentials) },
  }));

  const did = "1083378395";
  const haId = "light.miot_1083378395_s2";
  const directId = "light.miot:1083378395_s2";
  const writes: string[] = [];
  let miotOn = true, haOn = true;
  const home = new HomeRuntime({
    vault,
    registry: async () => new Map([[haId, { device_id: "ha-light", device_name: "HA 台灯" }]]),
    fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname === "fixture.invalid") {
        if (url.pathname === "/api/services/light/turn_off") {
          assert.equal(JSON.parse(String(init?.body)).entity_id, haId);
          writes.push("external_ha");
          haOn = false;
          return Response.json([]);
        }
        const state = { ...haState(haOn ? "on" : "off"), entity_id: haId };
        return Response.json(url.pathname === "/api/states" ? [state] : state);
      }
      if (url.hostname === "miot-spec.org") return Response.json(lightSpec());
      if (url.pathname.endsWith("/homeroom/gethome")) return Response.json({ code: 0, result: { homelist: [] } });
      if (url.pathname.endsWith("/home/device_list_page")) {
        return Response.json({ code: 0, result: { list: [
          { did, name: "米家台灯", model: "test.light.v1", spec_type: lightUrn, isOnline: true },
        ] } });
      }
      const { params } = JSON.parse(String(init?.body));
      if (url.pathname.endsWith("/miotspec/prop/set")) {
        assert.deepEqual(params, [{ did, siid: 2, piid: 1, value: false }]);
        writes.push("direct_miot");
        miotOn = false;
        return Response.json({ code: 0, result: [{ did, siid: 2, piid: 1, code: 0 }] });
      }
      assert.ok(url.pathname.endsWith("/miotspec/prop/get"));
      return Response.json({ code: 0, result: params.map((property: { piid: number }) => ({
        ...property, code: 0, value: property.piid === 1 ? miotOn : property.piid === 2 ? 50 : 4000,
      })) });
    },
  });
  try {
    await home.configure({
      mode: "direct_miot", haUrl: "https://fixture.invalid", haToken: "fixture",
      enabledSources: { direct_miot: true, external_ha: true },
    });
    const dashboard = await home.dashboard();
    const direct = dashboard.allAppliances.find(appliance => appliance.source === "direct_miot")?.capabilities.power;
    const external = dashboard.allAppliances.find(appliance => appliance.source === "external_ha")?.capabilities.power;
    assert.equal(direct?.entityId, directId);
    assert.equal(external?.entityId, haId);
    const { connectionId } = home.connection();
    assert.ok(connectionId);
    const turnOff = (entity_id: string) => home.control(
      { entity_id, domain: "light", service: "turn_off", service_data: {} },
      { connectionId, requestId: entity_id },
    );
    assert.equal((await turnOff(directId)).receipt.status, "verified");
    assert.deepEqual(writes, ["direct_miot"]);
    assert.equal((await turnOff(haId)).receipt.status, "verified");
    assert.deepEqual(writes, ["direct_miot", "external_ha"]);
  } finally {
    home.close();
  }
});
