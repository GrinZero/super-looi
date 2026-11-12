import { discoverMiotCamera, type MiotCameraCapability } from "../camera/miot-camera.js";
import type { HomeEntityDefinition, HomeStateSnapshot } from "@super-looi/contracts";
import type { HaTransportAdapter, HomeServiceResult } from "../types.js";
import { HomeTransportError, transportErrorDetails } from "../transport-error.js";
import { bindingProperties, brightnessFromMiot, brightnessToMiot, mapMiotDevice, miotSnapshot, quantizeMiot, type MiotEntityBinding } from "../miot/miot-entity-mapper.js";
import { MiotHttpClient, miotPropertyKey, type MiotPropertyResult, type MiotPropertyWrite } from "../miot/miot-http-client.js";
import { MiotSpecResolver } from "../miot/miot-spec-resolver.js";

/** HTTPS cloud transport. A set acknowledgement never changes a cached device state. */
export class DirectMiotTransportAdapter implements HaTransportAdapter {
  private cameras: MiotCameraCapability[] = [];
  private bindings = new Map<string, MiotEntityBinding>();
  private discovering: Promise<HomeEntityDefinition[]> | null = null;
  private lastVerifiedAt: string | null = null;
  private healthy = false;
  private error: string | null = null;
  private discoveryFailures: string[] = [];
  private readonly allowed: Set<string>;

  constructor(private readonly options: { client: MiotHttpClient; specs: MiotSpecResolver; allowedEntities?: readonly string[]; now?: () => number }) {
    this.allowed = new Set(options.allowedEntities ?? []);
  }

  private observedAt() { return new Date((this.options.now ?? Date.now)()).toISOString(); }
  isHealthy(): boolean { return this.healthy && this.lastVerifiedAt !== null && (this.options.now ?? Date.now)() - Date.parse(this.lastVerifiedAt) < 30_000; }
  getLastVerifiedAt(): string | null { return this.lastVerifiedAt; }
  getStatus() { return { healthy: this.isHealthy(), lastVerifiedAt: this.lastVerifiedAt,
    error: this.error ?? (this.discoveryFailures.length ? "miot_discovery_partial" : null),
    entityCount: this.bindings.size, discoveryFailures: [...this.discoveryFailures] }; }

  async discover(): Promise<HomeEntityDefinition[]> {
    if (this.discovering) return this.discovering;
    const promise = (async () => {
      try {
        const homes = await this.options.client.listHomes();
        const devices = await this.options.client.listDevices(homes);
        const bindings = new Map<string, MiotEntityBinding>();
        const failures: string[] = [];
        const cameras: MiotCameraCapability[] = [];
        // Resolve schemas sequentially to bound requests; the resolver coalesces identical URNs.
        for (const device of devices) {
          try {
            const spec = await this.options.specs.resolve(device.urn);
            const camera = discoverMiotCamera(device, spec);
            if (camera) cameras.push(camera);
            for (const binding of mapMiotDevice(device, spec, this.allowed)) bindings.set(binding.definition.entity_id, binding);
          } catch { failures.push(device.did); }
        }
        this.cameras = cameras;
        this.bindings = bindings; this.discoveryFailures = failures; this.error = null; this.healthy = false;
        return this.listEntities();
      } catch (error) {
        this.cameras = []; this.bindings.clear(); this.healthy = false;
        const details = transportErrorDetails(error, "miot_discovery_failed");
        this.error = String(details.code);
        throw new HomeTransportError(this.error, details);
      }
    })();
    this.discovering = promise;
    try { return await promise; } finally { if (this.discovering === promise) this.discovering = null; }
  }

  listCameraCapabilities(): MiotCameraCapability[] { return this.cameras.map(camera => JSON.parse(JSON.stringify(camera)) as MiotCameraCapability); }

  listEntities(): HomeEntityDefinition[] { return [...this.bindings.values()].map((binding) => JSON.parse(JSON.stringify(binding.definition)) as HomeEntityDefinition); }

  private async read(bindings: MiotEntityBinding[]): Promise<HomeStateSnapshot[]> {
    try {
      const requested = bindings.flatMap(bindingProperties);
      const result = requested.length ? await this.options.client.getProperties(requested) : [];
      const values = new Map<string, MiotPropertyResult>(result.map((property) => [miotPropertyKey(property), property]));
      const observedAt = this.observedAt();
      this.lastVerifiedAt = observedAt; this.healthy = true; this.error = null;
      return bindings.map((binding) => {
        const snapshot = miotSnapshot(binding, values, observedAt);
        const failures = bindingProperties(binding).flatMap((property) => {
          const result = values.get(miotPropertyKey(property));
          const is = (candidate: MiotEntityBinding["primary"] | undefined) => candidate?.siid === property.siid && candidate.piid === property.piid;
          const attribute = is(binding.brightness) ? "brightness" : is(binding.colorTemperature) ? "color_temp_kelvin"
            : is(binding.primary) || is(binding.statusProperty) ? "state" : "action_input";
          return result?.code === 0 ? [] : [{ ...property, code: result?.code ?? null, attribute }];
        });
        if (failures.length) snapshot.attributes.miot_read_errors = failures;
        return snapshot;
      });
    } catch (error) {
      this.healthy = false;
      const details = transportErrorDetails(error, "miot_read_failed");
      this.error = String(details.code);
      throw new HomeTransportError(this.error, details);
    }
  }
  async listStates(): Promise<HomeStateSnapshot[]> {
    if (!this.bindings.size) return [];
    return this.read([...this.bindings.values()]);
  }
  async fetchState(entityId: string, requiredAttributes: readonly string[] = []): Promise<HomeStateSnapshot | null> {
    const binding = this.bindings.get(entityId);
    if (!binding) return null;
    const snapshot = (await this.read([binding]))[0];
    const failures = snapshot.attributes.miot_read_errors;
    if (Array.isArray(failures)) {
      const required = failures.filter((failure) => failure && typeof failure === "object" && !Array.isArray(failure)
        && (failure.attribute === "state" || requiredAttributes.includes(String(failure.attribute))));
      if (required.length) throw new HomeTransportError("miot_property_read_failed", { operation: "miotspec/prop/get", properties: required });
    }
    return snapshot;
  }

  normalizeServiceData(entityId: string, data: Record<string, unknown>): Record<string, unknown> {
    const binding = this.bindings.get(entityId);
    if (!binding) return { ...data };
    const normalized = { ...data };
    if (typeof data.brightness === "number" && binding.brightness) normalized.brightness = brightnessFromMiot(brightnessToMiot(data.brightness, binding.brightness), binding.brightness);
    if (typeof data.color_temp_kelvin === "number" && binding.colorTemperature) normalized.color_temp_kelvin = quantizeMiot(data.color_temp_kelvin, binding.colorTemperature.range!);
    if (binding.definition.domain === "select" && binding.primary.valueList && (typeof data.option === "string" || typeof data.option === "number")) {
      const matched = binding.primary.valueList.find((item) => item.description === String(data.option) || String(item.value) === String(data.option));
      if (matched) normalized.option = matched.description;
    }
    if (binding.definition.domain === "number" && binding.primary.range && typeof data.value === "number" && Number.isFinite(data.value)) {
      normalized.value = quantizeMiot(data.value, binding.primary.range);
    }
    return normalized;
  }

  private writeFailure(error: unknown): HomeServiceResult {
    const diagnostics = transportErrorDetails(error, "miot_write_failed");
    this.healthy = false;
    this.error = String(diagnostics.code);
    return { success: false, error: this.error, diagnostics };
  }

  private async writeProperties(params: MiotPropertyWrite[]): Promise<HomeServiceResult> {
    try {
      const results = await this.options.client.setProperties(params);
      const resultsByKey = new Map(results.map((property) => [miotPropertyKey(property), property]));
      const properties = params.map(({ did, siid, piid }) => ({ did, siid, piid,
        code: resultsByKey.get(miotPropertyKey({ did, siid, piid }))?.code ?? null }));
      // Xiaomi accepts both 0 (completed) and 1 (accepted); neither replaces a readback.
      const success = properties.every((property) => property.code === 0 || property.code === 1);
      const diagnostics = { operation: "miotspec/prop/set", properties };
      return success ? { success: true, diagnostics }
        : { success: false, error: "miot_property_write_failed", diagnostics: { code: "miot_property_write_failed", ...diagnostics } };
    } catch (error) { return this.writeFailure(error); }
  }

  async callService(domain: string, service: string, data: Record<string, unknown>): Promise<HomeServiceResult> {
    const binding = typeof data.entity_id === "string" ? this.bindings.get(data.entity_id) : undefined;
    if (!binding || !binding.definition.is_whitelisted || domain !== binding.definition.domain || !binding.definition.supported_features.includes(service)) {
      return { success: false, error: "miot_unsupported_command" };
    }
    if (service === "press" && domain === "button" && binding.action) {
      if (Object.keys(data).some((key) => !["entity_id", "in"].includes(key))) {
        return { success: false, error: "miot_unsupported_command" };
      }
      const args = Array.isArray(data.in)
        ? data.in.filter((item): item is string | number | boolean => typeof item === "string" || typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item)))
        : (binding.actionDefaultArgs ?? []);
      try {
        const result = await this.options.client.callAction({
          did: binding.did,
          siid: binding.action.siid,
          aiid: binding.action.aiid,
          in: args,
        });
        const diagnostics = { operation: "miotspec/action", upstream_code: result.code, did: result.did, siid: result.siid, aiid: result.aiid };
        return result.code === 0 || result.code === 1 ? { success: true, diagnostics }
          : { success: false, error: "miot_action_failed", diagnostics: { code: "miot_action_failed", ...diagnostics } };
      } catch (error) { return this.writeFailure(error); }
    }
    if (service === "select_option" && domain === "select" && binding.primary.valueList) {
      if (Object.keys(data).some((key) => !["entity_id", "option"].includes(key))) {
        return { success: false, error: "miot_unsupported_command" };
      }
      const optionStr = typeof data.option === "string" || typeof data.option === "number" ? String(data.option) : "";
      const matched = binding.primary.valueList.find((item) => item.description === optionStr || String(item.value) === optionStr);
      if (!matched) {
        return { success: false, error: "miot_invalid_parameter" };
      }
      return this.writeProperties([
          { did: binding.did, siid: binding.primary.siid, piid: binding.primary.piid, value: matched.value },
      ]);
    }
    if (service === "set_value" && domain === "number" && binding.primary.range) {
      if (Object.keys(data).some((key) => !["entity_id", "value"].includes(key))) {
        return { success: false, error: "miot_unsupported_command" };
      }
      const rawValue = typeof data.value === "number" ? data.value : Number(data.value);
      const [min, max] = binding.primary.range;
      if (!Number.isFinite(rawValue) || rawValue < min || rawValue > max) {
        return { success: false, error: "miot_invalid_parameter" };
      }
      const quantized = quantizeMiot(rawValue, binding.primary.range);
      return this.writeProperties([
          { did: binding.did, siid: binding.primary.siid, piid: binding.primary.piid, value: quantized },
      ]);
    }
    if (!["turn_on", "turn_off"].includes(service) || Object.keys(data).some((key) => !["entity_id", "brightness", "color_temp_kelvin"].includes(key))) {
      return { success: false, error: "miot_unsupported_command" };
    }
    for (const key of ["brightness", "color_temp_kelvin"]) {
      if (data[key] === undefined) continue;
      const range = binding.definition.allowed_range?.[key];
      if (service !== "turn_on" || !range || typeof data[key] !== "number" || !Number.isInteger(data[key]) || data[key] < range[0] || data[key] > range[1]) return { success: false, error: "miot_invalid_parameter" };
    }
    const write = (property: MiotEntityBinding["primary"], value: boolean | number): MiotPropertyWrite => ({ did: binding.did, siid: property.siid, piid: property.piid, value });
    const params = [write(binding.primary, service === "turn_on")];
    if (typeof data.brightness === "number" && binding.brightness) params.push(write(binding.brightness, brightnessToMiot(data.brightness, binding.brightness)));
    if (typeof data.color_temp_kelvin === "number" && binding.colorTemperature) params.push(write(binding.colorTemperature, quantizeMiot(data.color_temp_kelvin, binding.colorTemperature.range!)));
    return this.writeProperties(params);
  }
}
