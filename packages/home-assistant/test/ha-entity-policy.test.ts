import { test } from "node:test";
import assert from "node:assert/strict";
import { defineHaEntity } from "../src/core/ha-entity-policy.js";
import type { HomeStateSnapshot } from "@super-looi/contracts";

const state = (entity_id: string, name = "Fixture device"): HomeStateSnapshot => ({ entity_id, state: "off",
  attributes: { friendly_name: name, supported_color_modes: ["color_temp"], min_color_temp_kelvin: 1000, max_color_temp_kelvin: 9000 },
  last_changed: new Date().toISOString(), last_updated: new Date().toISOString() });
const metadata = { device_id: "fixture", device_name: "Fixture device" };

test("HA metadata grants only identifiable safe power controls and bounded light attributes", () => {
  assert.deepEqual(defineHaEntity(state("light.fixture")).supported_features, ["read"]);
  assert.deepEqual(defineHaEntity(state("switch.fixture"), metadata).supported_features, ["read"]);
  assert.deepEqual(defineHaEntity(state("switch.fixture"), { ...metadata, power_control: true }).supported_features, ["turn_on", "turn_off"]);
  const light = defineHaEntity(state("light.fixture"), metadata);
  assert.deepEqual(light.supported_features, ["turn_on", "turn_off", "brightness", "color_temp"]);
  assert.deepEqual(light.allowed_range?.color_temp_kelvin, [2200, 6500]);
  for (const device of ["lock.fixture", "climate.fixture", "water_heater.fixture", "sensor.fixture"]) {
    assert.deepEqual(defineHaEntity(state(device), { ...metadata, power_control: true }).supported_features, ["read"]);
  }
  assert.deepEqual(defineHaEntity(state("switch.fixture", "燃气保护"), { ...metadata, power_control: true }).supported_features, ["read"]);
  assert.deepEqual(defineHaEntity(state("light.fixture"), { ...metadata, control_restricted: true }).supported_features, ["read"]);

  const fanState: HomeStateSnapshot = {
    entity_id: "fan.dmaker_p45",
    state: "off",
    attributes: {
      friendly_name: "风扇",
      percentage: 25,
      percentage_step: 25,
      preset_mode: "直吹风",
      preset_modes: ["直吹风", "自然风", "睡眠风"],
      oscillating: false,
      supported_features: 59,
    },
    last_changed: new Date().toISOString(),
    last_updated: new Date().toISOString(),
  };
  const fanDef = defineHaEntity(fanState, metadata);
  assert.deepEqual(fanDef.supported_features, ["turn_on", "turn_off", "set_percentage", "oscillate", "set_preset_mode"]);
  assert.deepEqual(fanDef.allowed_range?.percentage, [0, 100]);
});
