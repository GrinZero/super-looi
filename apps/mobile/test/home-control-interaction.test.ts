import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import type { HomeControlCommand, HomeStateSnapshot } from "@super-looi/contracts";
import {
  HomeControlInteraction,
  buildKelvinPresets,
  formatDeviceDisplay,
  formatSensorReading,
  isKelvinPresetActive,
  mergeHomeSnapshots,
  resolveOptimisticHomeState,
} from "../src/ui/home-control-interaction.js";

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
const defer = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };
const command = (service = "turn_on", service_data = {}, entity_id = "light.desk"): HomeControlCommand => ({ entity_id, domain: "light", service, service_data });
const state = (attributes = {}, value = "on"): HomeStateSnapshot => ({ entity_id: "light.desk", state: value, attributes, last_changed: new Date().toISOString(), last_updated: new Date().toISOString() });
const verified = (snapshot = state()) => ({ receipt: { status: "verified", readbacks: [{ kind: "device_state", observed_at: snapshot.last_updated, value: { state: snapshot.state, attributes: snapshot.attributes } }] } });

it("shows the target immediately and serializes rapid on/off/on into the first and latest writes", async () => {
  const replies = [defer<ReturnType<typeof verified>>(), defer<ReturnType<typeof verified>>()];
  const sent: HomeControlCommand[] = []; const observed: HomeStateSnapshot[] = []; const settled: string[] = [];
  const interaction = new HomeControlInteraction({ execute: (request) => { sent.push(request); return replies[sent.length - 1].promise; },
    changed() {}, observed: (_, snapshot) => observed.push(snapshot), settled: (_, phase) => settled.push(phase) });
  interaction.request(command()); interaction.request(command("turn_off")); interaction.request(command("turn_on", { brightness: 204 }));
  assert.equal(interaction.get("light.desk")?.command.service_data.brightness, 204);
  assert.equal(interaction.get("light.desk")?.phase, "pending"); assert.equal(sent.length, 1);
  replies[0].resolve(verified()); await turn();
  assert.equal(sent.length, 2); assert.deepEqual(sent[1].service_data, { brightness: 204 });
  assert.equal(interaction.get("light.desk")?.phase, "pending"); assert.deepEqual(settled, []);
  replies[1].resolve(verified(state({ brightness: 204 }))); await turn();
  assert.equal(interaction.get("light.desk"), undefined); assert.equal(observed.at(-1)?.attributes.brightness, 204);
  assert.deepEqual(settled, ["verified"]);
});

it("merges brightness and color targets and lets another device proceed independently", async () => {
  const first = defer<ReturnType<typeof verified>>(); const sent: HomeControlCommand[] = [];
  const interaction = new HomeControlInteraction({ execute: async (request) => { sent.push(request); return sent.length === 1 ? first.promise : verified(); }, changed() {}, observed() {}, settled() {} });
  interaction.request(command("turn_on", { brightness: 51 }));
  interaction.request(command("turn_on", { brightness: 153 }));
  interaction.request(command("turn_on", { color_temp_kelvin: 4000 }));
  interaction.request(command("turn_on", {}, "light.other"));
  await turn(); assert.equal(sent.length, 2); assert.equal(sent[1].entity_id, "light.other");
  first.resolve(verified()); await turn();
  assert.deepEqual(sent[2].service_data, { brightness: 153, color_temp_kelvin: 4000 });
});

it("off clears queued dimming targets and a later on does not resurrect them", async () => {
  const first = defer<ReturnType<typeof verified>>(); const sent: HomeControlCommand[] = [];
  const interaction = new HomeControlInteraction({ execute: async (request) => { sent.push(request); return sent.length === 1 ? first.promise : verified(); }, changed() {}, observed() {}, settled() {} });
  interaction.request(command("turn_on", { brightness: 51 })); interaction.request(command("turn_off")); interaction.request(command());
  first.resolve(verified()); await turn(); assert.deepEqual(sent[1].service_data, {});
});

it("recovers uncertainty only from fresh matching physical state, including requested attributes", async () => {
  const observed: HomeStateSnapshot[] = [];
  const interaction = new HomeControlInteraction({ execute: async () => ({ receipt: { status: "unverified" } }), changed() {}, observed: (_, snapshot) => observed.push(snapshot), settled() {} });
  interaction.request(command("turn_on", { brightness: 153 })); await turn();
  const requestedAt = interaction.get("light.desk")!.requestedAt;
  const reconcile = (snapshot: HomeStateSnapshot) => interaction.reconcile([{ entity_id: "light.desk", snapshot }]);
  reconcile(state({ brightness: 51 })); assert.equal(interaction.get("light.desk")?.phase, "uncertain");
  reconcile(state({ brightness: 153 }, "off")); assert.equal(interaction.get("light.desk")?.phase, "uncertain");
  reconcile({ ...state({ brightness: 153 }), last_updated: new Date(requestedAt - 1000).toISOString() });
  assert.equal(interaction.get("light.desk")?.phase, "uncertain");
  reconcile({ ...state({ brightness: 153 }), last_updated: new Date(Date.now() + 60000).toISOString() });
  assert.equal(interaction.get("light.desk")?.phase, "uncertain");
  reconcile(state({ brightness: 153 })); assert.equal(interaction.get("light.desk"), undefined); assert.equal(observed.length, 0);
});

it("preserves the physical state after rejection or a lost response and never automatically replays", async () => {
  for (const reject of [true, false]) {
    let writes = 0; let observations = 0;
    const interaction = new HomeControlInteraction({ execute: async () => { writes++; if (!reject) throw new Error("connection lost"); return { receipt: { status: "rejected" } }; },
      changed() {}, observed() { observations++; }, settled() {} });
    interaction.request(command()); await turn();
    assert.equal(interaction.get("light.desk")?.phase, reject ? "rejected" : "uncertain");
    assert.equal(writes, 1); assert.equal(observations, 0);
  }
});

it("fences late replies and queued writes on unmount, including a development effect restart", async () => {
  const oldReply = defer<ReturnType<typeof verified>>(); const newReply = defer<ReturnType<typeof verified>>(); let writes = 0; let observations = 0;
  const interaction = new HomeControlInteraction({ execute: async () => { writes++; return writes === 1 ? oldReply.promise : newReply.promise; },
    changed() {}, observed() { observations++; }, settled() {} });
  interaction.request(command()); interaction.request(command("turn_off"));
  interaction.dispose(); interaction.activate(); interaction.request(command("turn_on", { brightness: 204 }));
  oldReply.resolve(verified()); await turn(); assert.equal(observations, 0); assert.equal(writes, 2);
  assert.equal(interaction.get("light.desk")?.command.service_data.brightness, 204);
  newReply.resolve(verified()); await turn(); assert.equal(observations, 1); assert.equal(interaction.get("light.desk"), undefined);
});

it("keeps a verified receipt when a subsequent poll returns older HA cache, then accepts newer physical changes", async () => {
  const now = Date.now();
  const old = { ...state({}, "off"), last_updated: new Date(now - 5000).toISOString() };
  const receipt = { ...state({ brightness: 204 }), last_updated: new Date(now).toISOString() };
  let devices = [{ entity_id: "light.desk", snapshot: old }];
  const interaction = new HomeControlInteraction({ execute: async () => verified(receipt), changed() {}, settled() {},
    observed: (entityId, snapshot) => { devices = devices.map((entity) => entity.entity_id === entityId ? { ...entity, snapshot } : entity); } });
  const pollRevision = interaction.revision;
  interaction.request(command("turn_on", { brightness: 204 })); await turn();
  assert.notEqual(interaction.revision, pollRevision, "poll started before control must be discarded");
  devices = mergeHomeSnapshots(devices, [{ entity_id: "light.desk", snapshot: old }]);
  assert.equal(devices[0].snapshot.state, "on"); assert.equal(devices[0].snapshot.attributes.brightness, 204);
  const newer = { ...old, last_updated: new Date(now + 1).toISOString() };
  devices = mergeHomeSnapshots(devices, [{ entity_id: "light.desk", snapshot: newer }]);
  assert.equal(devices[0].snapshot.state, "off");
  const missing = mergeHomeSnapshots(devices, [{ entity_id: "light.desk", snapshot: null }]);
  assert.equal(missing[0].snapshot, null, "an unavailable device must not be presented as healthy stale evidence");
});

it("maintains optimistic on, brightness, and kelvin across pending and uncertain states without snapping back", async () => {
  const interaction = new HomeControlInteraction({
    execute: async () => ({ receipt: { status: "unverified" } }),
    changed() {},
    observed() {},
    settled() {},
  });
  const baseSnapshot = state({ brightness: 80, color_temp_kelvin: 3000 }, "off");

  interaction.request(command("turn_on", { brightness: 204 }));
  const whilePending = resolveOptimisticHomeState(baseSnapshot, interaction.get("light.desk"));
  assert.equal(whilePending.on, true);
  assert.equal(whilePending.brightness, 204);
  assert.equal(whilePending.kelvin, 3000);
  assert.equal(whilePending.syncing, true);

  await turn();
  assert.equal(interaction.get("light.desk")?.phase, "uncertain");
  const whileUncertain = resolveOptimisticHomeState(baseSnapshot, interaction.get("light.desk"));
  assert.equal(whileUncertain.on, true, "must not snap back to off while waiting for cloud state sync");
  assert.equal(whileUncertain.brightness, 204, "must not snap back to old brightness while uncertain");

  // A subsequent color-temperature change while uncertain keeps both brightness and kelvin in optimistic UI
  interaction.request(command("turn_on", { color_temp_kelvin: 5000 }));
  await turn();
  const afterSecond = resolveOptimisticHomeState(baseSnapshot, interaction.get("light.desk"));
  assert.equal(afterSecond.on, true);
  assert.equal(afterSecond.brightness, 204);
  assert.equal(afterSecond.kelvin, 5000);

  // Partial poll that only reflects kelvin must NOT prematurely clear uncertain feedback before brightness catches up
  interaction.reconcile([
    {
      entity_id: "light.desk",
      snapshot: state({ brightness: 80, color_temp_kelvin: 5000 }, "on", Date.now() + 100),
    },
  ]);
  assert.equal(interaction.get("light.desk")?.phase, "uncertain");

  // Full poll reflecting both brightness and kelvin clears the uncertain feedback
  interaction.reconcile([
    {
      entity_id: "light.desk",
      snapshot: state({ brightness: 204, color_temp_kelvin: 5000 }, "on", Date.now() + 200),
    },
  ]);
  assert.equal(interaction.get("light.desk"), undefined);
});

it("reverts optimistic state to physical snapshot when explicitly rejected", async () => {
  const interaction = new HomeControlInteraction({
    execute: async () => ({ receipt: { status: "rejected" } }),
    changed() {},
    observed() {},
    settled() {},
  });
  const baseSnapshot = state({ brightness: 100, color_temp_kelvin: 3000 }, "off");
  interaction.request(command("turn_on", { brightness: 255 }));
  await turn();
  const afterRejected = resolveOptimisticHomeState(baseSnapshot, interaction.get("light.desk"));
  assert.equal(afterRejected.on, false);
  assert.equal(afterRejected.brightness, 100);
  assert.equal(afterRejected.rejected, true);
});

it("normalizes redundant device names, builds clean kelvin presets, and humanizes sensor states", () => {
  const lamp = formatDeviceDisplay({ entity_id: "light.hall", friendly_name: "台灯 (大厅) 灯", domain: "light" });
  assert.equal(lamp.title, "台灯");
  assert.equal(lamp.roomLabel, "大厅");
  assert.equal(lamp.icon, "lamp");

  const miotLamp = formatDeviceDisplay({ entity_id: "light.miot_lamp", friendly_name: "台灯 (大厅) · Light", room: "大厅", domain: "light" });
  assert.equal(miotLamp.title, "台灯");
  assert.equal(miotLamp.roomLabel, "大厅");

  const ceiling = formatDeviceDisplay({ entity_id: "light.study_ceiling", friendly_name: "书房吸顶灯", room: "书房", domain: "light" });
  assert.equal(ceiling.title, "书房吸顶灯");
  assert.equal(ceiling.roomLabel, "书房");
  assert.equal(ceiling.icon, "sun");

  const presets3 = buildKelvinPresets([2200, 6500], 3);
  assert.deepEqual(presets3.map((p) => p.kelvin), [3000, 4000, 5500]);
  assert.equal(isKelvinPresetActive(3980, 4000, presets3), true);
  assert.equal(isKelvinPresetActive(3980, 3000, presets3), false);

  const presets5 = buildKelvinPresets([2700, 6500], 5);
  assert.equal(presets5.length, 5);

  assert.equal(formatSensorReading(state({ unit_of_measurement: "°C" }, "24.5"), true).valueText, "24.5");
  assert.equal(formatSensorReading(state({}, "on"), true).valueText, "开启");
  assert.equal(formatSensorReading(state({}, "unavailable"), true).valueText, "—");
});

it("wires unified top bar, optimistic card controls, detail sheet trigger, and quiet background sync", () => {
  const connected = readFileSync(new URL("../src/ui/spaces/ConnectedHomeSpaceView.tsx", import.meta.url), "utf8");
  const local = readFileSync(new URL("../src/ui/spaces/LocalHomeSpaceView.tsx", import.meta.url), "utf8");
  const detail = readFileSync(new URL("../src/ui/spaces/HomeDeviceDetailModal.tsx", import.meta.url), "utf8");

  assert.match(connected, /resolveOptimisticHomeState/u);
  assert.match(connected, /<HomeDeviceDetailModal/u);
  assert.match(connected, /setSelectedEntityId\(device\.entity_id\)/u);
  assert.doesNotMatch(connected, /尚未确认，正在同步设备状态/u);
  assert.match(local, /onOpenSettings=\{openSettings\}/u);
  assert.match(local, /saveAllSettings/u);
  assert.match(detail, /快捷光效场景/u);
  assert.match(detail, /精细亮度调节/u);
  assert.match(detail, /色温冷暖调节/u);
});
