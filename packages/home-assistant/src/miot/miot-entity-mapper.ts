import type { HomeEntityDefinition, HomeStateSnapshot, JsonObject } from "@super-looi/contracts";
import { miotPropertyKey, type MiotDevice, type MiotPropertyRef, type MiotPropertyResult } from "./miot-http-client.js";
import type { MiotSpec, MiotSpecProperty } from "./miot-spec-resolver.js";

export interface MiotEntityBinding {
  definition: HomeEntityDefinition; did: string;
  primary: MiotSpecProperty; brightness?: MiotSpecProperty; colorTemperature?: MiotSpecProperty;
}
const numericFormats = new Set(["uint8", "uint16", "uint32", "uint64", "int8", "int16", "int32", "int64", "float"]);
const safeDevices = new Set([
  "light", "fan", "outlet", "switch", "air-purifier", "ceiling-fan-light",
  "vacuum", "cooker", "microwave-oven", "washer", "dishwasher", "air-conditioner",
  "camera", "kettle", "electric-blanket", "dehumidifier", "pet-feeder", "pet-drinking-fountain",
  "television", "speaker",
]);
const powerDomains: Record<string, string> = {
  light: "light", fan: "fan", switch: "switch", outlet: "switch",
  "air-purifier": "switch", "air-conditioner": "switch", camera: "switch",
  washer: "switch", dishwasher: "switch", "electric-blanket": "switch",
  dehumidifier: "switch", television: "switch",
};
const metrics: Record<string, string> = { "temperature": "temperature", "relative-humidity": "humidity", "pm2.5-density": "pm25", "pm2-5-density": "pm25", "carbon-dioxide-density": "co2" };

/** A reversible, collision-free ASCII identifier; never merge dids such as a.b and a_b. */
function deviceKey(did: string): string { return [...did].map((char) => char.codePointAt(0)!.toString(16).padStart(6, "0")).join(""); }
function canDim(property: MiotSpecProperty | undefined): property is MiotSpecProperty & { range: [number, number, number] } {
  return !!property && numericFormats.has(property.format) && property.readable && property.writable && !!property.range
    && property.range[2] <= property.range[1] - property.range[0];
}

export function quantizeMiot(value: number, range: [number, number, number]): number {
  const [min, max, step] = range;
  const steps = Math.min(Math.floor((max - min) / step + 1e-9), Math.max(0, Math.round((value - min) / step)));
  return Number((min + steps * step).toFixed(8));
}
export function brightnessToMiot(value: number, property: MiotSpecProperty): number {
  const [min, declaredMax, step] = property.range!;
  const max = quantizeMiot(declaredMax, [min, declaredMax, step]);
  return quantizeMiot(min + (value - 1) * (max - min) / 254, property.range!);
}
export function brightnessFromMiot(value: number, property: MiotSpecProperty): number {
  const [min, declaredMax, step] = property.range!;
  const max = quantizeMiot(declaredMax, [min, declaredMax, step]);
  return Math.max(1, Math.min(255, Math.round(1 + (value - min) * 254 / (max - min))));
}

export function mapMiotDevice(device: MiotDevice, spec: MiotSpec, allowedEntities: ReadonlySet<string>): MiotEntityBinding[] {
  const bindings: MiotEntityBinding[] = [];
  const restricted = !safeDevices.has(spec.deviceType)
    || /lock|gas|water.?heater|garage|valve|门锁|燃气|煤气|热水器|水阀|车库门/i.test(`${device.model} ${device.name} ${spec.deviceType}`);
  const base = `miot_${deviceKey(device.did)}`;
  const definition = (entityId: string, domain: string, name: string, originalName?: string): HomeEntityDefinition => ({
    entity_id: entityId, domain, friendly_name: name, device_id: device.did, device_name: device.name,
    ...(device.model ? { device_model: device.model } : {}),
    ...(originalName ? { original_name: originalName } : {}),
    room: device.room ?? device.home, supported_features: ["read"],
    is_whitelisted: allowedEntities.has("*") || allowedEntities.has(entityId), max_state_age_ms: 15_000,
  });
  for (const service of spec.services) {
    const consumed = new Set<number>();
    const domain = Object.hasOwn(powerDomains, service.name) ? powerDomains[service.name] : undefined;
    const power = service.properties.find((property) => property.name === "on" && property.format === "bool" && property.readable);
    if (domain && power) {
      const entity = definition(`${domain}.${base}_s${service.siid}`, domain, `${device.name} · ${service.description}`, service.description);
      const controllable = !restricted && power.writable;
      if (controllable) entity.supported_features = ["turn_on", "turn_off"];
      const binding: MiotEntityBinding = { did: device.did, definition: entity, primary: power };
      consumed.add(power.piid);
      if (domain === "light") {
        const brightness = service.properties.find((property) => property.name === "brightness");
        const temperature = service.properties.find((property) => property.name === "color-temperature");
        if (controllable && canDim(brightness) && brightness.range[0] >= 0) {
          binding.brightness = brightness; consumed.add(brightness.piid);
          entity.supported_features.push("brightness"); entity.allowed_range = { brightness: [1, 255] };
        }
        if (controllable && canDim(temperature) && temperature.unit === "kelvin") {
          const [min, max, step] = temperature.range;
          const low = min + Math.max(0, Math.ceil((2200 - min) / step)) * step;
          const high = min + Math.floor((Math.min(6500, max) - min) / step) * step;
          if (Number.isInteger(low) && Number.isInteger(high) && low <= high && low >= 2200 && high <= 6500) {
            binding.colorTemperature = temperature; consumed.add(temperature.piid);
            entity.supported_features.push("color_temp"); entity.allowed_range = { ...entity.allowed_range, color_temp_kelvin: [low, high] };
          }
        }
      }
      bindings.push(binding);
    }
    for (const property of service.properties) {
      if (!property.readable || consumed.has(property.piid) || !(numericFormats.has(property.format) || property.format === "bool")) continue;
      const domain = property.format === "bool" ? "binary_sensor" : "sensor";
      const metric = Object.hasOwn(metrics, property.name) ? metrics[property.name] : undefined;
      const propSlug = property.name.replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "").toLowerCase();
      const suffix = metric ? `_${metric}` : propSlug ? `_${propSlug}` : "";
      const entity = definition(`${domain}.${base}_s${service.siid}_p${property.piid}${suffix}`, domain, `${device.name} · ${property.description}`, `${service.description} ${property.description}`.trim());
      if (!metric) entity.entity_category = "diagnostic";
      bindings.push({ did: device.did, definition: entity, primary: property });
    }
  }
  return bindings;
}

export function bindingProperties(binding: MiotEntityBinding): MiotPropertyRef[] {
  return [binding.primary, binding.brightness, binding.colorTemperature].filter((item): item is MiotSpecProperty => !!item)
    .map((property) => ({ did: binding.did, siid: property.siid, piid: property.piid }));
}

export function miotSnapshot(binding: MiotEntityBinding, values: Map<string, MiotPropertyResult>, observedAt: string): HomeStateSnapshot {
  function value(property: MiotSpecProperty): number | boolean | undefined {
    const result = values.get(miotPropertyKey({ did: binding.did, siid: property.siid, piid: property.piid }));
    if (!result || result.code !== 0) return;
    if (property.format === "bool") return typeof result.value === "boolean" ? result.value : undefined;
    if (!numericFormats.has(property.format) || typeof result.value !== "number" || !Number.isFinite(result.value)) return;
    if (property.format !== "float" && !Number.isSafeInteger(result.value)) return;
    if (property.range && (result.value < property.range[0] || result.value > property.range[1])) return;
    return result.value;
  }
  const primary = value(binding.primary);
  const attributes: JsonObject = { friendly_name: binding.definition.friendly_name };
  if (binding.primary.unit) {
    const units: Record<string, string> = { celsius: "°C", percentage: "%", kelvin: "K", "microgram-per-cubic-meter": "μg/m³" };
    attributes.unit_of_measurement = Object.hasOwn(units, binding.primary.unit) ? units[binding.primary.unit] : binding.primary.unit;
  }
  if (binding.brightness) {
    const brightness = value(binding.brightness);
    if (typeof brightness === "number") attributes.brightness = brightnessFromMiot(brightness, binding.brightness);
  }
  if (binding.colorTemperature) {
    const temperature = value(binding.colorTemperature);
    if (typeof temperature === "number") attributes.color_temp_kelvin = temperature;
    const range = binding.definition.allowed_range!.color_temp_kelvin;
    attributes.min_color_temp_kelvin = range[0]; attributes.max_color_temp_kelvin = range[1];
  }
  const enumMatch = typeof primary === "number" && binding.primary.valueList
    ? binding.primary.valueList.find((item) => item.value === primary)
    : undefined;
  if (enumMatch && typeof primary === "number") {
    attributes.raw_value = primary;
  }
  const resolvedState = primary === undefined
    ? "unavailable"
    : typeof primary === "boolean"
      ? (primary ? "on" : "off")
      : enumMatch
        ? enumMatch.description
        : String(primary);
  return { entity_id: binding.definition.entity_id, state: resolvedState,
    attributes, last_changed: observedAt, last_updated: observedAt };
}
