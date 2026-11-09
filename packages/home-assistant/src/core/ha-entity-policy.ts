import type { HomeEntityDefinition, HomeStateSnapshot } from "@super-looi/contracts";
import type { HomeEntityMetadata } from "../transports/ha-registry.js";

/** Discovery is not permission to operate a device. Unidentified entities stay read-only. */
export function defineHaEntity(state: HomeStateSnapshot, metadata?: HomeEntityMetadata): HomeEntityDefinition {
  const domain = state.entity_id.split(".")[0];
  const name = String(state.attributes.friendly_name ?? state.entity_id);
  const restricted = !metadata?.device_id || !metadata.device_name?.trim() || metadata.control_restricted
    || /lock|gas|heater|valve|garage|siren|alarm_control_panel|门锁|燃气|煤气|热水器|水阀|车库门|警笛|警报|童锁|保护/i.test(`${name} ${state.entity_id}`);
  const hasClimateModes = domain === "climate" && Array.isArray(state.attributes.hvac_modes);
  const power = !restricted && (["light", "fan"].includes(domain) || hasClimateModes || (domain === "switch" && metadata?.power_control === true));
  const supported = power ? ["turn_on", "turn_off"] : ["read"];
  if (!restricted && hasClimateModes) {
    supported.push("set_temperature", "set_hvac_mode");
    if (Array.isArray(state.attributes.fan_modes)) supported.push("set_fan_mode");
    if (Array.isArray(state.attributes.swing_modes)) supported.push("set_swing_mode");
    if (Array.isArray(state.attributes.preset_modes)) supported.push("set_preset_mode");
  } else if (!restricted && domain === "fan") {
    const features = typeof state.attributes.supported_features === "number" ? state.attributes.supported_features : 0;
    if ((features & 1) !== 0 || typeof state.attributes.percentage === "number" || typeof state.attributes.percentage_step === "number") {
      supported.push("set_percentage");
    }
    if ((features & 2) !== 0 || typeof state.attributes.oscillating === "boolean") {
      supported.push("oscillate");
    }
    if ((features & 4) !== 0 || typeof state.attributes.direction === "string") {
      supported.push("set_direction");
    }
    if ((features & 8) !== 0 || Array.isArray(state.attributes.preset_modes)) {
      supported.push("set_preset_mode");
    }
  } else if (!restricted && domain === "button") {
    supported.push("press");
  } else if (!restricted && domain === "notify") {
    supported.push("send_message");
  } else if (!restricted && domain === "select" && Array.isArray(state.attributes.options)) {
    supported.push("select_option");
  } else if (!restricted && domain === "number" && typeof state.attributes.min === "number" && typeof state.attributes.max === "number") {
    supported.push("set_value");
  }
  const ranges: Record<string, [number, number]> = {};
  if (!restricted && hasClimateModes && typeof state.attributes.min_temp === "number" && typeof state.attributes.max_temp === "number") {
    ranges.temperature = [state.attributes.min_temp, state.attributes.max_temp];
  }
  if (!restricted && domain === "fan" && supported.includes("set_percentage")) {
    ranges.percentage = [0, 100];
  }
  if (!restricted && domain === "number" && typeof state.attributes.min === "number" && typeof state.attributes.max === "number") {
    ranges.value = [state.attributes.min, state.attributes.max];
  }
  const modes = state.attributes.supported_color_modes;
  if (power && domain === "light" && Array.isArray(modes) && modes.some((mode) => !["onoff", "unknown"].includes(String(mode)))) {
    supported.push("brightness"); ranges.brightness = [1, 255];
  }
  const min = state.attributes.min_color_temp_kelvin, max = state.attributes.max_color_temp_kelvin;
  if (power && domain === "light" && Array.isArray(modes) && modes.includes("color_temp") && typeof min === "number" && Number.isFinite(min)
    && typeof max === "number" && Number.isFinite(max) && Math.max(2200, min) <= Math.min(6500, max)) {
    supported.push("color_temp"); ranges.color_temp_kelvin = [Math.max(2200, min), Math.min(6500, max)];
  }
  return {
    entity_id: state.entity_id,
    friendly_name: name,
    device_id: metadata?.device_id,
    device_name: metadata?.device_name,
    ...(metadata?.device_model ? { device_model: metadata.device_model } : {}),
    ...(metadata?.original_name ? { original_name: metadata.original_name } : {}),
    entity_category: metadata?.entity_category,
    room: metadata?.room,
    domain,
    supported_features: supported,
    allowed_range: ranges,
    is_whitelisted: true,
    max_state_age_ms: 15000,
  } as HomeEntityDefinition;
}
