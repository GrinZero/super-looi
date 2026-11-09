import type { HomeEntityDefinition, HomeStateSnapshot, JsonObject } from "@super-looi/contracts";
import { miotPropertyKey, type MiotDevice, type MiotPropertyRef, type MiotPropertyResult } from "./miot-http-client.js";
import type { MiotSpec, MiotSpecAction, MiotSpecProperty } from "./miot-spec-resolver.js";

export interface MiotEntityBinding {
  definition: HomeEntityDefinition; did: string;
  primary: MiotSpecProperty; brightness?: MiotSpecProperty; colorTemperature?: MiotSpecProperty;
  action?: MiotSpecAction;
  actionDefaultArgs?: Array<string | number | boolean>;
  statusProperty?: MiotSpecProperty;
  expectedStatuses?: string[];
  serviceName?: string;
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
  "camera-control": "switch", washer: "switch", dishwasher: "switch",
  "electric-blanket": "switch", dehumidifier: "switch", television: "switch",
};
const controllableBoolProperties = new Set([
  "horizontal-swing", "vertical-swing",
  "eco", "heater", "dryer", "sleep-mode", "un-straight-blowing", "favorite-on",
  "anion", "alarm", "physical-controls-locked",
  "auto-keep-warm", "keep-warm", "dechlorination", "rapid-cooling", "pure-water-keep-warm",
  "mute",
  "motion-detection", "motion-tracking", "time-watermark", "wdr-mode", "glimmer-full-color", "cruise-switch",
  "steam-sterilization", "high-water-switch", "one-click-wash", "ai-mode",
]);
const controllableNumberProperties = new Set([
  "target-temperature", "target-humidity", "keep-warm-temperature",
  "volume", "target-feeding-measure", "countdown-time",
  "rinsh-times", "rinse-times", "soak-time", "wash-time", "drying-time", "shake-time",
  "alarm-interval",
]);
const controllableActions = new Set([
  "start-sweep", "stop-sweeping", "start-dust-arrest", "start-mop-wash",
  "start-dry", "stop-dry", "start-eject", "start-charge",
  "start-wash", "stop-washing", "pause", "start-shake-disperse", "stop-shake-disperse",
  "start-cook", "cancel-cooking",
  "pet-food-out",
  "turn-left", "turn-right",
  "play", "next", "previous", "stop-alarm",
  "turn-on", "turn-off",
  "reset-brush-life", "reset-filter-life", "reset-mop-life", "reset-desiccant-life",
  "start-p2p-stream", "stop-stream",
]);
const actionExpectedStatuses: Record<string, string[]> = {
  "start-sweep": ["Sweeping", "Sweeping and Mopping", "Mopping", "RemoteClean", "1", "7", "12", "23"],
  "stop-sweeping": ["Paused", "Idle", "Charging", "Charging Completed", "3", "2", "6", "13"],
  "start-charge": ["Go Charging", "Charging", "Charging Completed", "5", "6", "13"],
  "start-dust-arrest": ["DustCollecting", "22"],
  "start-mop-wash": ["Go Washing", "Washing", "10", "9"],
  "start-dry": ["Drying", "8"],
  "stop-dry": ["Charging", "Charging Completed", "Idle", "6", "13", "2"],
  "start-wash": ["Busy", "Washing", "Soaking", "Weighing", "Prewashing", "Rinsing", "Spinning", "Drying", "2", "3"],
  "pause": ["Paused", "Pause", "2", "4", "9"],
  "stop-washing": ["Idle", "Off", "1", "6", "0"],
  "start-cook": ["Running", "Heating", "AptRunning", "2", "3"],
  "cancel-cooking": ["Idle", "Standby", "KeepWarm", "DeviceSleep", "1", "4", "6", "12"],
};
const metrics: Record<string, string> = { "temperature": "temperature", "relative-humidity": "humidity", "pm2.5-density": "pm25", "pm2-5-density": "pm25", "carbon-dioxide-density": "co2", "co2-density": "co2" };

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
  const deviceStatusProp = spec.services
    .flatMap((s) => s.properties)
    .find((p) => p.name === "status" && p.readable && (numericFormats.has(p.format) || p.format === "bool"));
  for (const service of spec.services) {
    const consumed = new Set<number>();
    const domain = Object.hasOwn(powerDomains, service.name) ? powerDomains[service.name] : undefined;
    const power = service.properties.find((property) => property.name === "on" && property.format === "bool" && property.readable);
    if (domain && power) {
      const entity = definition(`${domain}.${base}_s${service.siid}`, domain, `${device.name} · ${service.description}`, service.description);
      const controllable = !restricted && power.writable;
      if (controllable) entity.supported_features = ["turn_on", "turn_off"];
      const binding: MiotEntityBinding = { did: device.did, definition: entity, primary: power, serviceName: service.name };
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
    const serviceStatusProp = service.properties.find((p) => p.name === "status" && p.readable) ?? deviceStatusProp;
    for (const rawProperty of service.properties) {
      if (!rawProperty.readable || consumed.has(rawProperty.piid) || !(numericFormats.has(rawProperty.format) || rawProperty.format === "bool")) continue;
      let property = rawProperty;
      if (
        service.name === "light" &&
        rawProperty.name === "mode" &&
        rawProperty.writable &&
        !rawProperty.valueList &&
        rawProperty.range &&
        rawProperty.range[0] === 0 &&
        rawProperty.range[1] === 3 &&
        rawProperty.range[2] === 1
      ) {
        property = {
          ...rawProperty,
          valueList: [
            { value: 0, description: "Custom" },
            { value: 1, description: "Reading" },
            { value: 2, description: "Phone" },
            { value: 3, description: "Computer" },
          ],
        };
      }
      const metric = Object.hasOwn(metrics, property.name) ? metrics[property.name] : undefined;
      const propSlug = property.name.replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "").toLowerCase();
      const suffix = metric ? `_${metric}` : propSlug ? `_${propSlug}` : "";
      const isControllableBool = !restricted && property.writable && property.format === "bool"
        && (controllableBoolProperties.has(property.name) || (service.name === "indicator-light" && property.name === "on"));
      const isControllableSelect = !restricted && property.writable && !!property.valueList && property.valueList.length > 0
        && property.name !== "default-power-on-state"
        && !(service.name === "switch" && property.name === "mode")
        && service.name !== "self-check";
      const isControllableNumber = !restricted && property.writable && !property.valueList
        && canDim(property) && controllableNumberProperties.has(property.name);
      const propDomain = isControllableBool
        ? "switch"
        : isControllableSelect
          ? "select"
          : isControllableNumber
            ? "number"
            : property.format === "bool"
              ? "binary_sensor"
              : "sensor";
      const originalLabel = `${service.name} ${property.name} ${service.description} ${property.description}`.trim();
      const friendlyLabel = service.description && !property.description.toLowerCase().includes(service.description.toLowerCase()) && property.name === "on"
        ? `${device.name} · ${service.description}`
        : `${device.name} · ${property.description}`;
      const entity = definition(`${propDomain}.${base}_s${service.siid}_p${property.piid}${suffix}`, propDomain, friendlyLabel, originalLabel);
      if (isControllableBool) {
        entity.supported_features = ["turn_on", "turn_off"];
      } else if (isControllableSelect) {
        entity.supported_features = ["read", "select_option"];
      } else if (isControllableNumber && property.range) {
        entity.supported_features = ["read", "set_value"];
        entity.allowed_range = { value: [property.range[0], property.range[1]] };
      } else if (!metric) {
        entity.entity_category = "diagnostic";
      }
      bindings.push({ did: device.did, definition: entity, primary: property, serviceName: service.name });
    }
    if (!restricted && service.actions) {
      for (const action of service.actions) {
        if (!controllableActions.has(action.name)) continue;
        let defaultArgs: Array<string | number | boolean> | undefined;
        if (action.in.length === 0) {
          defaultArgs = [];
        } else if (action.in.length === 1 && (action.name === "start-cook" || action.name === "pet-food-out")) {
          defaultArgs = [1];
        } else if (action.in.length === 1 && action.name === "start-shake-disperse") {
          defaultArgs = [30];
        } else if (action.in.length === 1 && action.name === "reset-filter-life") {
          defaultArgs = [0];
        }
        if (!defaultArgs) continue;
        const actionSlug = action.name.replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "").toLowerCase();
        const originalLabel = `${service.name} ${action.name} ${service.description} ${action.description}`.trim();
        const entity = definition(
          `button.${base}_s${service.siid}_a${action.aiid}_${actionSlug}`,
          "button",
          `${device.name} · ${action.description}`,
          originalLabel,
        );
        entity.supported_features = ["press"];
        const syntheticPrimary: MiotSpecProperty = {
          siid: action.siid,
          piid: action.aiid,
          name: action.name,
          description: action.description,
          format: "action",
          readable: false,
          writable: true,
        };
        const expected = Object.hasOwn(actionExpectedStatuses, action.name)
          ? actionExpectedStatuses[action.name]
          : undefined;
        bindings.push({
          did: device.did,
          definition: entity,
          primary: syntheticPrimary,
          action,
          actionDefaultArgs: defaultArgs,
          ...(serviceStatusProp ? { statusProperty: serviceStatusProp } : {}),
          ...(expected ? { expectedStatuses: expected } : {}),
          serviceName: service.name,
        });
      }
    }
  }
  return bindings;
}

export function bindingProperties(binding: MiotEntityBinding): MiotPropertyRef[] {
  if (binding.action) {
    return binding.statusProperty
      ? [{ did: binding.did, siid: binding.statusProperty.siid, piid: binding.statusProperty.piid }]
      : [];
  }
  return [binding.primary, binding.brightness, binding.colorTemperature].filter((item): item is MiotSpecProperty => !!item && item.readable)
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
  const attributes: JsonObject = { friendly_name: binding.definition.friendly_name };
  if (binding.action) {
    attributes.action_name = binding.action.name;
    attributes.siid = binding.action.siid;
    attributes.aiid = binding.action.aiid;
    if (binding.statusProperty && binding.expectedStatuses) {
      const rawStatus = value(binding.statusProperty);
      const statusEnum = typeof rawStatus === "number" && binding.statusProperty.valueList
        ? binding.statusProperty.valueList.find((item) => item.value === rawStatus)
        : undefined;
      attributes.has_status_criterion = true;
      attributes.related_status = rawStatus === undefined
        ? "unavailable"
        : statusEnum
          ? statusEnum.description
          : String(rawStatus);
      attributes.expected_statuses = binding.expectedStatuses;
    } else {
      attributes.has_status_criterion = false;
    }
    return {
      entity_id: binding.definition.entity_id,
      state: "idle",
      attributes,
      last_changed: observedAt,
      last_updated: observedAt,
    };
  }
  const primary = value(binding.primary);
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
  if (binding.definition.domain === "select" && binding.primary.valueList) {
    attributes.options = binding.primary.valueList.map((item) => item.description);
    attributes.raw_options = binding.primary.valueList.map((item) => ({ value: item.value, label: item.description }));
  }
  if (binding.definition.domain === "number" && binding.primary.range) {
    attributes.min = binding.primary.range[0];
    attributes.max = binding.primary.range[1];
    attributes.step = binding.primary.range[2];
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
