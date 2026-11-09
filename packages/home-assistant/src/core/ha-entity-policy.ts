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
