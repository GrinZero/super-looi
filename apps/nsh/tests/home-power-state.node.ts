import test from "node:test";
import assert from "node:assert/strict";
import { buildHomeDashboardModel, createSimulationRawRecords } from "../../../packages/home-devices/src/index.js";
import { HomePowerState } from "../runtime/home-power-state.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const command = (service = "turn_off") => ({ entity_id: "switch.desk_fan", domain: "switch", service });
const verified = { receipt: { status: "verified" } };

function fixture() {
  const records = createSimulationRawRecords();
  const record = records.find((record) => record.entity_id === "switch.desk_fan")!;
  record.snapshot = { ...record.snapshot!, state: "on" };
  const dashboard = buildHomeDashboardModel(records);
  let visible = dashboard;
  const state = new HomePowerState(dashboard, (next) => { visible = next; });
  state.replaceDashboard(dashboard, "home-a");
  const fan = () => visible.allAppliances.find((appliance) => appliance.entityIds.includes("switch.desk_fan"))!;
  return { records, dashboard, state, fan, visible: () => visible };
}

test("fan turns off synchronously, updates summaries and stays in place through an older poll", async () => {
  const f = fixture();
  const reply = deferred<typeof verified>();
  const order = f.visible().allAppliances.map((appliance) => appliance.id);
  const active = f.visible().activeAppliances;
  const pending = f.state.control(command(), () => reply.promise, async () => false);
  assert.equal(f.fan().capabilities.power?.isOn, false);
  assert.equal(f.fan().isActive, false);
  assert.equal(f.fan().statusBadge, "已关闭");
  assert.equal(f.fan().conciseSubtitle, "已关闭");
  assert.equal(f.visible().activeAppliances, active - 1);
  assert.deepEqual(f.visible().allAppliances.map((appliance) => appliance.id), order);
  f.state.replaceDashboard(f.dashboard, "home-a");
  assert.equal(f.fan().isActive, false);
  reply.resolve(verified);
  await pending;
  assert.equal(f.fan().isActive, false);
  assert.equal(f.dashboard.allAppliances.find((appliance) => appliance.id === f.fan().id)?.isActive, true);
});

test("rejected and unknown receipts restore readback before waiting for refresh", async () => {
  for (const status of ["rejected", "unknown"]) {
    const f = fixture();
    const reply = deferred<typeof verified>();
    const refresh = deferred<boolean>();
    const pending = f.state.control(command(), () => reply.promise, () => refresh.promise);
    reply.resolve({ receipt: { status } });
    await Promise.resolve();
    assert.equal(f.fan().isActive, true);
    refresh.resolve(false);
    await pending;
  }
});

test("a transport rejection removes the optimistic state", async () => {
  const f = fixture();
  const reply = deferred<typeof verified>();
  const pending = f.state.control(command(), () => reply.promise, async () => false);
  reply.reject(new Error("offline"));
  await assert.rejects(pending, /offline/);
  assert.equal(f.fan().isActive, true);
});

test("verified power survives an older in-flight poll followed by a failed refresh", async () => {
  const f = fixture();
  await f.state.control(command(), async () => verified, async () => {
    f.state.replaceDashboard(f.dashboard, "home-a");
    return false;
  });
  assert.equal(f.fan().isActive, false);
});

test("a successful fresh read supersedes the optimistic intent", async () => {
  const f = fixture();
  await f.state.control(command(), async () => verified, async () => {
    f.state.replaceDashboard(f.dashboard, "home-a");
    return true;
  });
  assert.equal(f.fan().isActive, true);
});

test("an earlier response and poll cannot undo a second click", async () => {
  const f = fixture();
  const first = deferred<typeof verified>();
  const second = deferred<typeof verified>();
  const off = f.state.control(command(), () => first.promise, async () => false);
  const on = f.state.control(command("turn_on"), () => second.promise, async () => false);
  assert.equal(f.fan().isActive, true);
  first.resolve(verified);
  await off;
  f.state.replaceDashboard(buildHomeDashboardModel(f.records.map((record) => record.entity_id === "switch.desk_fan"
    ? { ...record, snapshot: { ...record.snapshot!, state: "off" } } : record)), "home-a");
  assert.equal(f.fan().isActive, true);
  second.resolve(verified);
  await on;
  assert.equal(f.fan().isActive, true);
});

test("switching connections clears pending power and ignores the previous response", async () => {
  const f = fixture();
  const reply = deferred<typeof verified>();
  let refreshed = false;
  const pending = f.state.control(command(), () => reply.promise, async () => { refreshed = true; return false; });
  f.state.replaceDashboard(f.dashboard, "home-b");
  assert.equal(f.fan().isActive, true);
  reply.resolve(verified);
  await pending;
  assert.equal(f.fan().isActive, true);
  assert.equal(refreshed, false);
});

test("a verified close is published after a later unknown open removes its pending intent", async () => {
  const f = fixture();
  const firstRefresh = deferred<boolean>();
  const off = f.state.control(command(), async () => verified, () => firstRefresh.promise);
  await Promise.resolve();
  const on = f.state.control(command("turn_on"), async () => ({ receipt: { status: "unknown" } }), async () => false);
  await on;
  firstRefresh.resolve(false);
  await off;
  assert.equal(f.fan().isActive, false);
});

test("multi-gang changes update channels, active counts and room batch targets together", async () => {
  const f = fixture();
  const gang = f.visible().allAppliances.find((appliance) => appliance.capabilities.multiGang)!;
  const channel = gang.capabilities.multiGang!.channels[0]!;
  const reply = deferred<typeof verified>();
  const pending = f.state.control({ entity_id: channel.entityId, domain: channel.domain,
    service: channel.isOn ? "turn_off" : "turn_on" }, () => reply.promise, async () => false);
  const updated = f.visible().allAppliances.find((appliance) => appliance.id === gang.id)!;
  assert.equal(updated.capabilities.multiGang!.channels[0]!.isOn, !channel.isOn);
  const targets = f.visible().rooms.find((room) => room.name === gang.room)!.roomPowerEntities;
  assert.ok(targets[channel.isOn ? "turnOnIds" : "turnOffIds"].includes(channel.entityId));
  reply.resolve(verified);
  await pending;
});

test("non-power commands wait for readback without changing power", async () => {
  const f = fixture();
  const reply = deferred<typeof verified>();
  const pending = f.state.control(command("set_percentage"), () => reply.promise, async () => false);
  assert.equal(f.visible(), f.dashboard);
  reply.resolve(verified);
  await pending;
});
