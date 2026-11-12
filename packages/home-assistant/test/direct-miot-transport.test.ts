import assert from "node:assert/strict";
import { it } from "node:test";
import { DirectMiotTransportAdapter, HomeAssistantGateway, MiotHttpClient, MiotSpecResolver } from "../src/index.js";
import { jsonResponse, lightSpec, lightUrn, specProperty } from "./miot-fixtures.js";

function fixture() {
  const values = new Map<number, boolean | number>([[1, false], [2, 1], [3, 2700]]);
  const writes: Array<Record<string, unknown>[]> = [];
  const failedReads = new Set<number>();
  let online = true;
  let applyWrites = true;
  let failedWrite = false;
  const network = (async (input, init) => {
    const url = new URL(String(input));
    if (!online) throw new Error("private-secret-in-url");
    if (url.hostname === "miot-spec.org") return new Response(JSON.stringify(lightSpec()));
    const data = JSON.parse(String(init?.body));
    if (url.pathname.endsWith("/gethome")) return jsonResponse({ homelist: [{ id: "home1", name: "家", dids: ["lamp.1"], roomlist: [{ id: "study", name: "书房", dids: ["lamp.1"] }] }] });
    if (url.pathname.endsWith("/device_list_page")) return jsonResponse({ list: [{ did: "lamp.1", name: "阅读灯", model: "test.light.v1", spec_type: lightUrn, isOnline: true, token: "LAN_SECRET", local_ip: "192.0.2.1" }] });
    const params = data.params as Array<{ did: string; siid: number; piid: number; value?: number | boolean }>;
    if (url.pathname.endsWith("/prop/set")) {
      writes.push(params);
      if (applyWrites) for (const property of params) if (!failedWrite || property.piid !== 2) values.set(property.piid, property.value!);
      return jsonResponse(params.map(({ did, siid, piid }) => ({ did, siid, piid, code: failedWrite && piid === 2 ? -1 : 0 })));
    }
    if (url.pathname.endsWith("/prop/get")) return jsonResponse(params.map(({ did, siid, piid }) => ({ did, siid, piid,
      code: failedReads.has(piid) ? -704042011 : 0, value: values.get(piid) })));
    throw new Error(`unexpected endpoint ${url.pathname}`);
  }) as typeof fetch;
  const client = new MiotHttpClient({ fetch: network, getAccessToken: async () => "access-secret" });
  const specs = new MiotSpecResolver({ fetch: network });
  const transport = new DirectMiotTransportAdapter({ client, specs, allowedEntities: ["*"] });
  return { client, specs, transport, writes, values, failedReads,
    setOnline(value: boolean) { online = value; }, setApplyWrites(value: boolean) { applyWrites = value; }, setFailedWrite(value: boolean) { failedWrite = value; } };
}

it("discovers real topology, quantizes lighting targets, and verifies only subsequent reads", async () => {
  const { transport, writes } = fixture();
  const definitions = await transport.discover();
  assert.equal(definitions.length, 1);
  const light = definitions[0];
  assert.equal(light.room, "书房");
  assert.deepEqual(light.allowed_range, { brightness: [1, 255], color_temp_kelvin: [2700, 6500] });
  assert.deepEqual(light.supported_features, ["turn_on", "turn_off", "brightness", "color_temp"]);
  assert.ok(!JSON.stringify(definitions).includes("LAN_SECRET"));
  const gateway = new HomeAssistantGateway({ transport, initialEntities: definitions });
  const command = { entity_id: light.entity_id, domain: "light", service: "turn_on", service_data: { brightness: 128, color_temp_kelvin: 4050 }, timeout_ms: 20 };
  const receipt = await gateway.executeCommand(command);
  assert.equal(receipt.status, "verified"); assert.equal(receipt.outcome, "applied");
  assert.deepEqual(writes[0].map((property) => property.value), [true, 51, 4100]);
  const state = await gateway.getState(light.entity_id);
  assert.equal(state?.attributes.brightness, 129); assert.equal(state?.attributes.color_temp_kelvin, 4100);
  const repeated = await gateway.executeCommand(command);
  assert.equal(repeated.outcome, "noop"); assert.equal(writes.length, 1);
});

it("never verifies a successful write acknowledgement with an unchanged contradictory readback", async () => {
  const test = fixture();
  const definitions = await test.transport.discover();
  test.setApplyWrites(false);
  const gateway = new HomeAssistantGateway({ transport: test.transport, initialEntities: definitions });
  const receipt = await gateway.executeCommand({ entity_id: definitions[0].entity_id, domain: "light", service: "turn_on", service_data: { brightness: 200 }, timeout_ms: 15 });
  assert.equal(receipt.status, "unverified"); assert.equal(test.writes.length, 1);
  assert.equal((await gateway.getState(definitions[0].entity_id))?.state, "off");
});

it("reports partial property writes and missing readbacks honestly, and never replays on reconnect", async () => {
  const test = fixture();
  const definitions = await test.transport.discover();
  const gateway = new HomeAssistantGateway({ transport: test.transport, initialEntities: definitions });
  test.setFailedWrite(true);
  const command = { entity_id: definitions[0].entity_id, domain: "light", service: "turn_on", service_data: { brightness: 128 }, timeout_ms: 15 };
  assert.equal((await gateway.executeCommand(command)).status, "unverified");
  assert.equal(test.values.get(1), true); assert.equal(test.values.get(2), 1);
  test.setFailedWrite(false); test.failedReads.add(2);
  assert.equal((await gateway.executeCommand(command)).status, "unverified");
  test.setOnline(false);
  await assert.rejects(test.transport.fetchState(definitions[0].entity_id), /miot_request_failed/);
  assert.equal(test.transport.isHealthy(), false);
  const count = test.writes.length;
  test.setOnline(true); test.failedReads.clear();
  await test.transport.listStates();
  assert.equal(test.writes.length, count);
  assert.equal(test.transport.isHealthy(), true);
});

it("keeps unapproved and unsupported commands from reaching the cloud even when bypassing the gateway", async () => {
  const test = fixture();
  const unapproved = new DirectMiotTransportAdapter({ client: test.client, specs: test.specs });
  const definitions = await unapproved.discover();
  const entity_id = definitions[0].entity_id;
  assert.equal((await unapproved.callService("light", "turn_on", { entity_id })).success, false);
  await test.transport.discover();
  for (const [domain, service, data] of [
    ["switch", "turn_on", {}], ["light", "toggle", {}], ["light", "turn_on", { brightness: 256 }],
    ["light", "turn_off", { brightness: 128 }], ["light", "turn_on", { color_temp_kelvin: 2100 }],
    ["light", "turn_on", { area_id: "all" }],
  ] as const) assert.equal((await test.transport.callService(domain, service, { entity_id, ...data })).success, false);
  assert.equal(test.writes.length, 0);
});

it("reads 45 devices / 1121 sensor entities in bounded 150-property batches", async () => {
  const urn = (count: number) => `urn:miot-spec-v2:device:environment:0000A00A:test-sensor:${count}`;
  let requests = 0; let inflight = 0; let maxInflight = 0;
  const network = (async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "miot-spec.org") {
      const count = url.searchParams.get("type")!.endsWith(":21") ? 21 : 25;
      return new Response(JSON.stringify({ type: urn(count), services: [{ iid: 2,
        type: "urn:miot-spec-v2:service:environment:0000780A:test:1",
        properties: Array.from({ length: count }, (_, i) => specProperty(i + 1, i === 0 ? "temperature" : `metric-${i}`)) }] }));
    }
    if (url.pathname.endsWith("/gethome")) return jsonResponse({ homelist: [] });
    if (url.pathname.endsWith("/device_list_page")) return jsonResponse({ list: Array.from({ length: 45 }, (_, i) => ({ did: `sensor.${i}`, name: `传感器 ${i}`, model: "test.sensor.v1", spec_type: urn(i === 44 ? 21 : 25), isOnline: true })) });
    assert.ok(url.pathname.endsWith("/prop/get"));
    const data = JSON.parse(String(init?.body));
    assert.equal(data.datasource, 1); assert.ok(data.params.length <= 150);
    requests++; inflight++; maxInflight = Math.max(maxInflight, inflight);
    await new Promise((resolve) => setTimeout(resolve, 2)); inflight--;
    return jsonResponse(data.params.map((property: object) => ({ ...property, code: 0, value: 23.5 })));
  }) as typeof fetch;
  const transport = new DirectMiotTransportAdapter({ client: new MiotHttpClient({ fetch: network, getAccessToken: async () => "token" }), specs: new MiotSpecResolver({ fetch: network }), allowedEntities: ["*"] });
  const entities = await transport.discover();
  assert.equal(entities.length, 1121);
  const states = await transport.listStates();
  assert.equal(states.length, 1121); assert.equal(requests, 8); assert.ok(maxInflight <= 3);
  assert.ok(states.every((state) => state.state === "23.5"));
  assert.ok(entities.every((entity) => entity.supported_features.join(",") === "read"));
  const gateway = new HomeAssistantGateway({ transport, initialEntities: entities });
  assert.equal((await gateway.readEnvironmentalMetric("temperature")).value, 23.5);
});

it("keeps available devices during a partial spec failure and clears stale control bindings after discovery failure", async () => {
  let offline = false;
  const unknownUrn = `${lightUrn}-unknown`;
  const network = (async (input) => {
    if (offline) throw new Error("private-network-detail");
    const url = new URL(String(input));
    if (url.hostname === "miot-spec.org") return new Response(JSON.stringify(url.searchParams.get("type") === lightUrn ? lightSpec() : {}));
    if (url.pathname.endsWith("/gethome")) return jsonResponse({ homelist: [] });
    return jsonResponse({ list: [lightUrn, unknownUrn].map((spec_type, index) => ({ did: `lamp${index}`, name: "灯", model: "test.light", spec_type, isOnline: true })) });
  }) as typeof fetch;
  const transport = new DirectMiotTransportAdapter({ client: new MiotHttpClient({ fetch: network, getAccessToken: async () => "token" }),
    specs: new MiotSpecResolver({ fetch: network }), allowedEntities: ["*"] });
  const definitions = await transport.discover();
  assert.equal(definitions.length, 1);
  assert.equal(transport.getStatus().error, "miot_discovery_partial");
  assert.deepEqual(transport.getStatus().discoveryFailures, ["lamp1"]);
  offline = true;
  await assert.rejects(transport.discover(), /miot_request_failed/);
  assert.equal(transport.listEntities().length, 0);
  assert.equal((await transport.callService("light", "turn_on", { entity_id: definitions[0].entity_id })).success, false);
});

it("retains gateway range and target checks after transport quantization", async () => {
  let calls = 0;
  for (const normalized of [{ brightness: 999 }, {}, { brightness: 128, entity_id: "light.other" }]) {
    const gateway = new HomeAssistantGateway({ transport: {
      normalizeServiceData: () => normalized,
      async fetchState() { calls++; return null; }, async callService() { calls++; return { success: true }; },
      isHealthy: () => true, getLastVerifiedAt: () => null,
    } });
    const receipt = await gateway.executeCommand({ entity_id: "light.study_ceiling", domain: "light", service: "turn_on", service_data: { brightness: 128 } });
    assert.equal(receipt.status, "rejected");
  }
  assert.equal(calls, 0);
});

it("maps writable MIoT select, number, switch, and button capabilities and verifies action status criteria", async () => {
  const fanUrn = "urn:miot-spec-v2:device:fan:0000A005:dmaker-p45:1";
  const vacuumUrn = "urn:miot-spec-v2:device:vacuum:0000A006:xiaomi-d103cn:1";
  const stateStore = new Map<string, boolean | number>([
    ["fan.1/2/1", false],
    ["fan.1/2/2", 1],
    ["fan.1/2/3", 0],
    ["fan.1/2/4", false],
    ["fan.1/2/5", 90],
    ["fan.1/2/6", 22.5],
    ["vac.1/2/1", 13],
  ]);
  let applyActionStatusTransition = true;
  const actionsCalled: Array<{ did: string; siid: number; aiid: number; in: unknown[] }> = [];
  const network = (async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "miot-spec.org") {
      const requestedType = url.searchParams.get("type");
      if (requestedType === fanUrn) {
        return new Response(JSON.stringify({
          type: fanUrn,
          services: [
            {
              iid: 2,
              type: "urn:miot-spec-v2:service:fan:00007808:dmaker-p45:1",
              description: "Fan",
              properties: [
                specProperty(1, "on", "bool", { access: ["read", "write"] }),
                {
                  iid: 2,
                  type: "urn:miot-spec-v2:property:fan-level:00000016:dmaker-p45:1",
                  description: "Fan Level",
                  format: "uint8",
                  access: ["read", "write"],
                  "value-list": [
                    { value: 1, description: "Level1" },
                    { value: 2, description: "Level2" },
                    { value: 3, description: "Level3" },
                    { value: 4, description: "Level4" },
                  ],
                },
                {
                  iid: 3,
                  type: "urn:miot-spec-v2:property:mode:00000008:dmaker-p45:1",
                  description: "Mode",
                  format: "uint8",
                  access: ["read", "write"],
                  "value-list": [
                    { value: 0, description: "Straight Wind" },
                    { value: 1, description: "Natural Wind" },
                    { value: 2, description: "Sleep" },
                  ],
                },
                specProperty(4, "horizontal-swing", "bool", { access: ["read", "write"] }),
                {
                  iid: 5,
                  type: "urn:miot-spec-v2:property:horizontal-swing-included-angle:0000011B:dmaker-p45:1",
                  description: "Horizontal Swing Included Angle",
                  format: "uint16",
                  access: ["read", "write"],
                  "value-list": [
                    { value: 30, description: "30" },
                    { value: 60, description: "60" },
                    { value: 90, description: "90" },
                    { value: 120, description: "120" },
                    { value: 150, description: "150" },
                  ],
                },
                {
                  iid: 6,
                  type: "urn:miot-spec-v2:property:target-temperature:00000021:dmaker-p45:1",
                  description: "Target Temperature",
                  format: "float",
                  access: ["read", "write"],
                  unit: "celsius",
                  "value-range": [16, 31, 0.5],
                },
              ],
              actions: [
                {
                  iid: 2,
                  type: "urn:miot-spec-v2:action:turn-left:00002886:dmaker-p45:1",
                  description: "Turn Left",
                  in: [],
                  out: [],
                },
              ],
            },
          ],
        }));
      }
      return new Response(JSON.stringify({
        type: vacuumUrn,
        services: [
          {
            iid: 2,
            type: "urn:miot-spec-v2:service:vacuum:00007810:xiaomi-d103cn:1",
            description: "Robot Cleaner",
            properties: [
              {
                iid: 1,
                type: "urn:miot-spec-v2:property:status:00000007:xiaomi-d103cn:1",
                description: "Status",
                format: "uint8",
                access: ["read"],
                "value-list": [
                  { value: 1, description: "Sweeping" },
                  { value: 13, description: "Charging Completed" },
                ],
              },
            ],
            actions: [
              {
                iid: 1,
                type: "urn:miot-spec-v2:action:start-sweep:00002804:xiaomi-d103cn:1",
                description: "Start Sweep",
                in: [],
                out: [],
              },
            ],
          },
        ],
      }));
    }
    const data = JSON.parse(String(init?.body));
    if (url.pathname.endsWith("/gethome")) {
      return jsonResponse({ homelist: [{ id: "home1", name: "家", dids: ["fan.1", "vac.1"], roomlist: [{ id: "hall", name: "大厅", dids: ["fan.1", "vac.1"] }] }] });
    }
    if (url.pathname.endsWith("/device_list_page")) {
      return jsonResponse({
        list: [
          { did: "fan.1", name: "风扇", model: "dmaker.fan.p45", spec_type: fanUrn, isOnline: true },
          { did: "vac.1", name: "扫地机器人", model: "xiaomi.vacuum.d103cn", spec_type: vacuumUrn, isOnline: true },
        ],
      });
    }
    if (url.pathname.endsWith("/prop/set")) {
      const params = data.params as Array<{ did: string; siid: number; piid: number; value: number | boolean }>;
      for (const p of params) stateStore.set(`${p.did}/${p.siid}/${p.piid}`, p.value);
      return jsonResponse(params.map(({ did, siid, piid }) => ({ did, siid, piid, code: 0 })));
    }
    if (url.pathname.endsWith("/prop/get")) {
      const params = data.params as Array<{ did: string; siid: number; piid: number }>;
      return jsonResponse(params.map(({ did, siid, piid }) => ({
        did,
        siid,
        piid,
        code: 0,
        value: stateStore.get(`${did}/${siid}/${piid}`),
      })));
    }
    if (url.pathname.endsWith("/action")) {
      const p = data.params as { did: string; siid: number; aiid: number; in: unknown[] };
      actionsCalled.push(p);
      if (p.did === "vac.1" && p.siid === 2 && p.aiid === 1 && applyActionStatusTransition) {
        stateStore.set("vac.1/2/1", 1);
      }
      return jsonResponse({ did: p.did, siid: p.siid, aiid: p.aiid, code: 0, out: [] });
    }
    throw new Error(`unexpected endpoint ${url.pathname}`);
  }) as typeof fetch;

  let clock = Date.now();
  const client = new MiotHttpClient({ fetch: network, getAccessToken: async () => "token" });
  const specs = new MiotSpecResolver({ fetch: network });
  const transport = new DirectMiotTransportAdapter({ client, specs, allowedEntities: ["*"], now: () => (clock += 5) });
  const definitions = await transport.discover();
  const gateway = new HomeAssistantGateway({ transport, initialEntities: definitions });

  const fanLevel = definitions.find((d) => d.domain === "select" && d.entity_id.endsWith("_fan_level"))!;
  assert.ok(fanLevel);
  const rLevel = await gateway.executeCommand({
    entity_id: fanLevel.entity_id,
    domain: "select",
    service: "select_option",
    service_data: { option: "3" },
    timeout_ms: 50,
  });
  assert.equal(rLevel.status, "verified");
  assert.equal(stateStore.get("fan.1/2/2"), 3);

  const swingSwitch = definitions.find((d) => d.domain === "switch" && d.entity_id.endsWith("_horizontal_swing"))!;
  assert.ok(swingSwitch);
  const rSwing = await gateway.executeCommand({
    entity_id: swingSwitch.entity_id,
    domain: "switch",
    service: "turn_on",
    service_data: {},
    timeout_ms: 50,
  });
  assert.equal(rSwing.status, "verified");
  assert.equal(stateStore.get("fan.1/2/4"), true);

  const targetTemp = definitions.find((d) => d.domain === "number" && d.entity_id.endsWith("_temperature"))!;
  assert.ok(targetTemp);
  const rTemp = await gateway.executeCommand({
    entity_id: targetTemp.entity_id,
    domain: "number",
    service: "set_value",
    service_data: { value: 24.5 },
    timeout_ms: 50,
  });
  assert.equal(rTemp.status, "verified");
  assert.equal(stateStore.get("fan.1/2/6"), 24.5);

  // Instantaneous action (turn-left) has no status criterion: accepted without falsely claiming state verified
  const turnLeft = definitions.find((d) => d.domain === "button" && d.entity_id.endsWith("_turn_left"))!;
  assert.ok(turnLeft);
  const rLeft = await gateway.executeCommand({
    entity_id: turnLeft.entity_id,
    domain: "button",
    service: "press",
    service_data: {},
    timeout_ms: 20,
  });
  assert.equal(rLeft.status, "unverified");
  assert.equal(rLeft.reason_code, "action_accepted_no_state_criterion");
  assert.equal(actionsCalled.length, 1);

  // State-transition action (start-sweep): fails verification if status stays Charging Completed, succeeds when status becomes Sweeping
  const startSweep = definitions.find((d) => d.domain === "button" && d.entity_id.endsWith("_start_sweep"))!;
  assert.ok(startSweep);
  applyActionStatusTransition = false;
  const rSweepUnverified = await gateway.executeCommand({
    entity_id: startSweep.entity_id,
    domain: "button",
    service: "press",
    service_data: {},
    timeout_ms: 20,
  });
  assert.equal(rSweepUnverified.status, "unverified");
  assert.equal(rSweepUnverified.reason_code, "action_accepted_state_unverified");

  applyActionStatusTransition = true;
  const rSweepVerified = await gateway.executeCommand({
    entity_id: startSweep.entity_id,
    domain: "button",
    service: "press",
    service_data: {},
    timeout_ms: 20,
  });
  assert.equal(rSweepVerified.status, "verified");
  assert.equal(rSweepVerified.outcome, "applied");
});
