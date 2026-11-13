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

it("resets readable filter usage to zero while preserving explicit action arguments", async () => {
  const actions: unknown[] = [];
  const urn = "urn:miot-spec-v2:device:air-purifier:0000A007:zhimi-va2:1";
  const network = (async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "miot-spec.org") return new Response(JSON.stringify({
      type: urn,
      services: [{
        iid: 3, type: "urn:miot-spec-v2:service:filter:0000780B:zhimi-va2:1", description: "Filter",
        properties: [specProperty(3, "filter-used-time", "uint32", { access: ["read"], "value-range": [0, 10000, 1] })],
        actions: [{ iid: 1, type: "urn:miot-spec-v2:action:reset-filter-life:00002803:zhimi-va2:1", description: "Reset Filter Life", in: [3], out: [] }],
      }],
    }));
    const data = JSON.parse(String(init?.body));
    if (url.pathname.endsWith("/gethome")) return jsonResponse({ homelist: [{ id: "home1", name: "家", dids: ["purifier.1"], roomlist: [] }] });
    if (url.pathname.endsWith("/device_list_page")) return jsonResponse({ list: [{ did: "purifier.1", name: "净化器", model: "zhimi.airp.va2", spec_type: urn, isOnline: true }] });
    if (url.pathname.endsWith("/prop/get")) return jsonResponse(data.params.map((prop: object) => ({ ...prop, code: 0, value: 5000 })));
    if (url.pathname.endsWith("/action")) {
      actions.push(data.params.in);
      return jsonResponse({ ...data.params, code: 0, out: [] });
    }
    throw new Error(`unexpected endpoint ${url.pathname}`);
  }) as typeof fetch;
  const transport = new DirectMiotTransportAdapter({
    client: new MiotHttpClient({ fetch: network, getAccessToken: async () => "test-token" }),
    specs: new MiotSpecResolver({ fetch: network }), allowedEntities: ["*"],
  });
  const definitions = await transport.discover();
  await transport.listStates();
  const reset = definitions.find((entity) => entity.entity_id.endsWith("_reset_filter_life"))!;
  assert.ok(reset);
  assert.equal((await transport.callService("button", "press", { entity_id: reset.entity_id })).success, true);
  assert.equal((await transport.callService("button", "press", { entity_id: reset.entity_id, in: [7] })).success, true);
  assert.deepEqual(actions, [[0], [7]]);
});

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

it("converges cooker action-arg cook-mode, kettle multi-param start-cook, feeder portion dispense, and camera rollover select", async () => {
  const cookerUrn = "urn:miot-spec-v2:device:cooker:0000A00B:chunmi-cmwy4:1";
  const kettleUrn = "urn:miot-spec-v2:device:kettle:0000A009:xiaomi-mek01:2";
  const feederUrn = "urn:miot-spec-v2:device:pet-feeder:0000A06C:xiaomi-pi2001:3";
  const cameraUrn = "urn:miot-spec-v2:device:camera:0000A01C:chuangmi-039a01:2";

  const stateStore = new Map<string, string | number | boolean>([
    ["cooker.1/2/1", 1],
    ["kettle.1/2/1", 1],
    ["kettle.1/2/5", 85],
    ["kettle.1/2/7", true],
    ["kettle.1/2/8", 55],
    ["kettle.1/2/10", true],
    ["kettle.1/2/12", false],
    ["kettle.1/2/13", 50],
    ["kettle.1/2/14", 45],
    ["kettle.1/2/17", "mode_tap"],
    ["feeder.1/2/7", 12],
    ["cam.1/2/1", true],
    ["cam.1/2/2", 0],
  ]);
  const propWrites: Array<{ did: string; siid: number; piid: number; value: unknown }> = [];
  const actionsCalled: Array<{ did: string; siid: number; aiid: number; in: unknown[] }> = [];

  const network = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === "miot-spec.org") {
      const requestedType = url.searchParams.get("type");
      if (requestedType === cookerUrn) {
        return new Response(JSON.stringify({
          type: cookerUrn,
          services: [{
            iid: 2,
            type: "urn:miot-spec-v2:service:cooker:00007815:chunmi-cmwy4:1",
            description: "Cooker",
            properties: [
              {
                iid: 1,
                type: "urn:miot-spec-v2:property:status:00000007:chunmi-cmwy4:1",
                description: "Status",
                format: "uint8",
                access: ["read"],
                "value-list": [{ value: 1, description: "Idle" }, { value: 2, description: "Running" }],
              },
              {
                iid: 5,
                type: "urn:miot-spec-v2:property:cook-mode:00000037:chunmi-cmwy4:1",
                description: "Cook Mode",
                format: "uint8",
                access: [],
                "value-list": [
                  { value: 1, description: "Fine Cook" },
                  { value: 2, description: "Quick Cook" },
                  { value: 3, description: "Cook Congee" },
                ],
              },
            ],
            actions: [{
              iid: 1,
              type: "urn:miot-spec-v2:action:start-cook:00002806:chunmi-cmwy4:1",
              description: "Start Cook",
              in: [5],
              out: [],
            }],
          }],
        }));
      }
      if (requestedType === kettleUrn) {
        return new Response(JSON.stringify({
          type: kettleUrn,
          services: [{
            iid: 2,
            type: "urn:miot-spec-v2:service:kettle:00007813:xiaomi-mek01:1",
            description: "Kettle",
            properties: [
              {
                iid: 1,
                type: "urn:miot-spec-v2:property:status:00000007:xiaomi-mek01:1",
                description: "Status",
                format: "uint8",
                access: ["read"],
                "value-list": [{ value: 1, description: "Standby" }, { value: 2, description: "Heating" }],
              },
              specProperty(5, "target-temperature", "uint16", { access: ["read", "write"], unit: "celsius", "value-range": [40, 100, 1] }),
              specProperty(7, "auto-keep-warm", "bool", { access: ["read", "write"] }),
              specProperty(8, "keep-warm-temperature", "uint16", { access: ["read", "write"], unit: "celsius", "value-range": [40, 95, 1] }),
              specProperty(10, "dechlorination", "bool", { access: ["read", "write"] }),
              specProperty(12, "rapid-cooling", "bool", { access: ["read", "write"] }),
              specProperty(13, "pure-water-keep-warm-temperature", "uint16", { access: ["read", "write"], "value-range": [40, 90, 1] }),
              specProperty(14, "tap-water-keep-warm-temperature", "uint16", { access: ["read", "write"], "value-range": [40, 90, 1] }),
              specProperty(17, "mode-id", "string", { access: ["read", "write"] }),
            ],
            actions: [{
              iid: 1,
              type: "urn:miot-spec-v2:action:start-cook:00002806:xiaomi-mek01:1",
              description: "Start Cook",
              in: [17, 5, 7, 8, 10, 12, 13, 14],
              out: [],
            }],
          }],
        }));
      }
      if (requestedType === feederUrn) {
        return new Response(JSON.stringify({
          type: feederUrn,
          services: [{
            iid: 2,
            type: "urn:miot-spec-v2:service:pet-feeder:00007847:xiaomi-pi2001:1",
            description: "Pet Feeder",
            properties: [
              specProperty(7, "target-feeding-measure", "uint8", { access: ["read", "write"], "value-range": [1, 30, 1] }),
              specProperty(8, "feeding-measure", "uint16", { access: [], "value-range": [0, 150, 1] }),
            ],
            actions: [
              { iid: 1, type: "urn:miot-spec-v2:action:pet-food-out:0000282B:xiaomi-pi2001:1", description: "Pet Food Out", in: [8], out: [] },
              { iid: 2, type: "urn:miot-spec-v2:action:weigh-manual-calibrate:000028C5:xiaomi-pi2001:1", description: "Weigh Manual Calibrate", in: [], out: [] },
            ],
          }],
        }));
      }
      return new Response(JSON.stringify({
        type: cameraUrn,
        services: [{
          iid: 2,
          type: "urn:miot-spec-v2:service:camera-control:0000782F:chuangmi-039a01:1",
          description: "Camera Control",
          properties: [
            specProperty(1, "on", "bool", { access: ["read", "write"] }),
            specProperty(2, "image-rollover", "uint16", { access: ["read", "write"], "value-range": [0, 180, 180], unit: "arcdegrees" }),
          ],
        }],
      }));
    }
    const data = JSON.parse(String(init?.body));
    if (url.pathname.endsWith("/gethome")) {
      return jsonResponse({ homelist: [{ id: "h1", name: "家", dids: ["cooker.1", "kettle.1", "feeder.1", "cam.1"], roomlist: [] }] });
    }
    if (url.pathname.endsWith("/device_list_page")) {
      return jsonResponse({
        list: [
          { did: "cooker.1", name: "电饭煲", model: "chunmi.cooker.cmwy4", spec_type: cookerUrn, isOnline: true },
          { did: "kettle.1", name: "电热水瓶", model: "xiaomi.kettle.mek01", spec_type: kettleUrn, isOnline: true },
          { did: "feeder.1", name: "宠物喂食器", model: "xiaomi.feeder.pi2001", spec_type: feederUrn, isOnline: true },
          { did: "cam.1", name: "监控", model: "chuangmi.camera.039a01", spec_type: cameraUrn, isOnline: true },
        ],
      });
    }
    if (url.pathname.endsWith("/prop/set")) {
      const params = data.params as Array<{ did: string; siid: number; piid: number; value: number | boolean }>;
      for (const p of params) {
        propWrites.push(p);
        stateStore.set(`${p.did}/${p.siid}/${p.piid}`, p.value);
      }
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
      if (p.did === "cooker.1") stateStore.set("cooker.1/2/1", 2);
      if (p.did === "kettle.1") stateStore.set("kettle.1/2/1", 2);
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

  // 1. Cooker cook-mode updates local action argument without /prop/set, then start-cook sends [3]
  const cookMode = definitions.find((d) => d.device_id === "cooker.1" && d.domain === "select")!;
  assert.ok(cookMode);
  const rMode = await gateway.executeCommand({
    entity_id: cookMode.entity_id,
    domain: "select",
    service: "select_option",
    service_data: { option: "Cook Congee" },
    timeout_ms: 50,
  });
  assert.equal(rMode.status, "verified");
  assert.equal(propWrites.length, 0);

  const cookerStart = definitions.find((d) => d.device_id === "cooker.1" && d.domain === "button" && d.entity_id.endsWith("_start_cook"))!;
  const rCookerStart = await gateway.executeCommand({
    entity_id: cookerStart.entity_id,
    domain: "button",
    service: "press",
    service_data: {},
    timeout_ms: 50,
  });
  assert.equal(rCookerStart.status, "verified");
  assert.deepEqual(actionsCalled[0], { did: "cooker.1", siid: 2, aiid: 1, in: [3] });

  // 2. Kettle 8-param start-cook reads live device properties including string mode-id
  const kettleStart = definitions.find((d) => d.device_id === "kettle.1" && d.domain === "button" && d.entity_id.endsWith("_start_cook"))!;
  assert.ok(kettleStart);
  const rKettleStart = await gateway.executeCommand({
    entity_id: kettleStart.entity_id,
    domain: "button",
    service: "press",
    service_data: {},
    timeout_ms: 50,
  });
  assert.equal(rKettleStart.status, "verified");
  assert.deepEqual(actionsCalled[1], {
    did: "kettle.1",
    siid: 2,
    aiid: 1,
    in: ["mode_tap", 85, true, 55, true, false, 50, 45],
  });

  // 3. Feeder pet-food-out dynamically uses sibling target-feeding-measure (12) + weigh-manual-calibrate exists
  const feederCalibrate = definitions.find((d) => d.device_id === "feeder.1" && d.entity_id.endsWith("_weigh_manual_calibrate"));
  assert.ok(feederCalibrate);
  const feederOut = definitions.find((d) => d.device_id === "feeder.1" && d.entity_id.endsWith("_pet_food_out"))!;
  const rFeederOut = await gateway.executeCommand({
    entity_id: feederOut.entity_id,
    domain: "button",
    service: "press",
    service_data: {},
    timeout_ms: 20,
  });
  assert.equal(rFeederOut.reason_code, "action_accepted_no_state_criterion");
  assert.deepEqual(actionsCalled[2], { did: "feeder.1", siid: 2, aiid: 1, in: [12] });

  // 4. Camera image-rollover (0..180 step 180) is mapped as controllable select
  const camRollover = definitions.find((d) => d.device_id === "cam.1" && d.domain === "select" && d.entity_id.endsWith("_image_rollover"))!;
  assert.ok(camRollover);
  const rRollover = await gateway.executeCommand({
    entity_id: camRollover.entity_id,
    domain: "select",
    service: "select_option",
    service_data: { option: "180°" },
    timeout_ms: 50,
  });
  assert.equal(rRollover.status, "verified");
  assert.equal(stateStore.get("cam.1/2/2"), 180);
});
