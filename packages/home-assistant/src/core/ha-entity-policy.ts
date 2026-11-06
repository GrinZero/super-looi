import type { HomeEntityDefinition, HomeStateSnapshot } from "@super-looi/contracts";
import type { HomeEntityMetadata } from "../transports/ha-registry.js";

/** Discovery is not permission to operate a device. Unidentified entities stay read-only. */
export function defineHaEntity(state: HomeStateSnapshot, metadata?: HomeEntityMetadata): HomeEntityDefinition {
  const domain = state.entity_id.split(".")[0];
  const name = String(state.attributes.friendly_name ?? state.entity_id);
  const restricted = !metadata?.device_id || !metadata.device_name?.trim() || metadata.control_restricted
    || /lock|gas|heater|valve|garage|门锁|燃气|煤气|热水器|水阀|车库门|童锁|保护/i.test(`${name} ${state.entity_id}`);
  const power = !restricted && (["light", "fan"].includes(domain) || (domain === "switch" && metadata?.power_control === true));
  const supported = power ? ["turn_on", "turn_off"] : ["read"];
  const ranges: Record<string, [number, number]> = {};
  const modes = state.attributes.supported_color_modes;
  if (power && domain === "light" && Array.isArray(modes) && modes.some((mode) => !["onoff", "unknown"].includes(String(mode)))) {
    supported.push("brightness"); ranges.brightness = [1, 255];
  }
  const min = state.attributes.min_color_temp_kelvin, max = state.attributes.max_color_temp_kelvin;
  if (power && domain === "light" && Array.isArray(modes) && modes.includes("color_temp") && typeof min === "number" && Number.isFinite(min)
    && typeof max === "number" && Number.isFinite(max) && Math.max(2200, min) <= Math.min(6500, max)) {
    supported.push("color_temp"); ranges.color_temp_kelvin = [Math.max(2200, min), Math.min(6500, max)];
  }
  return { entity_id: state.entity_id, friendly_name: name, device_id: metadata?.device_id, device_name: metadata?.device_name,
    entity_category: metadata?.entity_category, room: metadata?.room, domain, supported_features: supported, allowed_range: ranges,
    is_whitelisted: true, max_state_age_ms: 15000 };
}
