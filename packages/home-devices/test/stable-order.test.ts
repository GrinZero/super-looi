import test from "node:test";
import assert from "node:assert/strict";
import { buildHomeDashboardModel, createSimulationRawRecords, updateApplianceOrder, createEmptyLayoutPreferences } from "../src/index.js";

test("power and availability changes preserve device order, including equal names and saved positions", () => {
  const fan = createSimulationRawRecords().find((record) => record.entity_id === "switch.desk_fan")!;
  const records = ["b", "a", "c"].map((id, index) => ({ ...fan, device_id: id, device_name: "风扇",
    entity_id: `switch.fan_${id}`, snapshot: { ...fan.snapshot!, entity_id: `switch.fan_${id}`, state: index === 0 ? "on" : "off" } }));
  const initial = buildHomeDashboardModel(records);
  const order = initial.allAppliances.map((appliance) => appliance.id);
  const changed = records.map((record, index) => ({ ...record,
    snapshot: { ...record.snapshot, state: index === 0 ? "off" : index === 1 ? "on" : "unavailable" } }));
  assert.deepEqual(buildHomeDashboardModel(changed.reverse()).allAppliances.map((appliance) => appliance.id), order);
  const layout = updateApplianceOrder(createEmptyLayoutPreferences(), order[2]!, 1);
  const saved = buildHomeDashboardModel(records, layout).allAppliances.map((appliance) => appliance.id);
  assert.equal(saved[0], order[2]);
  assert.deepEqual(buildHomeDashboardModel(changed, layout).allAppliances.map((appliance) => appliance.id), saved);
});
