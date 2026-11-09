import { discoverMiotCamera, type MiotCameraCapability } from "../camera/miot-camera.js";
import type { HomeEntityDefinition, HomeStateSnapshot } from "@super-looi/contracts";
import type { HaTransportAdapter } from "../types.js";
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
      } catch { this.cameras = []; this.bindings.clear(); this.healthy = false; this.error = "miot_discovery_failed"; throw new Error(this.error); }
    })();
    this.discovering = promise;
    try { return await promise; } finally { if (this.discovering === promise) this.discovering = null; }
  }

  listCameraCapabilities(): MiotCameraCapability[] { return this.cameras.map(camera => JSON.parse(JSON.stringify(camera)) as MiotCameraCapability); }

  listEntities(): HomeEntityDefinition[] { return [...this.bindings.values()].map((binding) => JSON.parse(JSON.stringify(binding.definition)) as HomeEntityDefinition); }

  private async read(bindings: MiotEntityBinding[]): Promise<HomeStateSnapshot[]> {
    try {
      const result = await this.options.client.getProperties(bindings.flatMap(bindingProperties));
      const values = new Map<string, MiotPropertyResult>(result.map((property) => [miotPropertyKey(property), property]));
      const observedAt = this.observedAt();
      this.lastVerifiedAt = observedAt; this.healthy = true; this.error = null;
      return bindings.map((binding) => miotSnapshot(binding, values, observedAt));
    } catch { this.healthy = false; this.error = "miot_read_failed"; throw new Error(this.error); }
  }
  async listStates(): Promise<HomeStateSnapshot[]> {
    if (!this.bindings.size) return [];
    return this.read([...this.bindings.values()]);
  }
  async fetchState(entityId: string): Promise<HomeStateSnapshot | null> {
    const binding = this.bindings.get(entityId);
    if (!binding) return null;
    try { return (await this.read([binding]))[0]; } catch { return null; }
  }

  normalizeServiceData(entityId: string, data: Record<string, unknown>): Record<string, unknown> {
    const binding = this.bindings.get(entityId);
    if (!binding) return { ...data };
    const normalized = { ...data };
    if (typeof data.brightness === "number" && binding.brightness) normalized.brightness = brightnessFromMiot(brightnessToMiot(data.brightness, binding.brightness), binding.brightness);
    if (typeof data.color_temp_kelvin === "number" && binding.colorTemperature) normalized.color_temp_kelvin = quantizeMiot(data.color_temp_kelvin, binding.colorTemperature.range!);
    return normalized;
  }

  async callService(domain: string, service: string, data: Record<string, unknown>): Promise<{ success: boolean; error?: string }> {
    const binding = typeof data.entity_id === "string" ? this.bindings.get(data.entity_id) : undefined;
    if (!binding || !binding.definition.is_whitelisted || domain !== binding.definition.domain || !["turn_on", "turn_off"].includes(service)
      || !binding.definition.supported_features.includes(service) || Object.keys(data).some((key) => !["entity_id", "brightness", "color_temp_kelvin"].includes(key))) {
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
    try {
      const results = await this.options.client.setProperties(params);
      const resultsByKey = new Map(results.map((property) => [miotPropertyKey(property), property]));
      const success = params.every((property) => resultsByKey.get(miotPropertyKey(property))?.code === 0);
      return success ? { success: true } : { success: false, error: "miot_property_write_failed" };
    } catch { this.healthy = false; this.error = "miot_write_failed"; return { success: false, error: this.error }; }
  }
}
