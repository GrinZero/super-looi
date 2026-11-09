import type { HomeStateSnapshot } from "@super-looi/contracts";
import type { HaTransportAdapter } from "../types.js";

/** Real HA REST transport. Service acknowledgements are never device readbacks. */
export class HomeAssistantRestTransport implements HaTransportAdapter {
  private verifiedAt: string | null = null;
  private healthy = false;
  private error: string | null = null;
  private discoveryError: string | null = null;
  private readonly baseUrl: string | null;

  constructor(private readonly options: { url?: string; token?: string; timeoutMs?: number; fetch?: typeof fetch }) {
    if (options.url) {
      const url = new URL(options.url);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new Error("HA_URL must be an HTTP(S) URL without credentials, query or fragment");
      }
      this.baseUrl = url.href.replace(/\/$/, "");
    } else this.baseUrl = null;
  }

  isHealthy(): boolean { return !this.discoveryError && this.healthy && this.verifiedAt !== null && Date.now() - Date.parse(this.verifiedAt) < 30_000; }
  setDiscoveryAvailable(available: boolean): void { this.discoveryError = available ? null : "ha_registry_unavailable"; }
  getLastVerifiedAt(): string | null { return this.verifiedAt; }
  getStatus() {
    return { configured: Boolean(this.baseUrl && this.options.token), healthy: this.isHealthy(), lastVerifiedAt: this.verifiedAt, error: this.discoveryError ?? this.error };
  }

  private async request(path: string, data?: Record<string, unknown>): Promise<unknown> {
    if (!this.baseUrl || !this.options.token) {
      this.healthy = false;
      this.error = "home_assistant_not_configured";
      throw new Error(this.error);
    }
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.options.timeoutMs ?? 5000);
    try {
      const response = await (this.options.fetch ?? fetch)(`${this.baseUrl}/api/${path}`, {
        method: data ? "POST" : "GET",
        headers: { Authorization: `Bearer ${this.options.token}`, "Content-Type": "application/json" },
        body: data ? JSON.stringify(data) : undefined,
        signal: abort.signal,
        redirect: "error",
      });
      if (!response.ok) throw new Error(`ha_http_${response.status}`);
      const result: unknown = await response.json();
      this.healthy = true;
      this.verifiedAt = new Date().toISOString();
      this.error = null;
      return result;
    } catch (error) {
      this.healthy = false;
      // Never forward response bodies, URLs or fetch exceptions containing credentials.
      this.error = error instanceof Error && /^ha_http_\d+$/.test(error.message) ? error.message : "ha_connection_failed";
      throw new Error(this.error);
    } finally { clearTimeout(timer); }
  }

  async listStates(): Promise<HomeStateSnapshot[]> {
    const result = await this.request("states");
    if (!Array.isArray(result) || !result.every(isSnapshot)) {
      this.healthy = false;
      this.error = "ha_invalid_states";
      throw new Error(this.error);
    }
    return result.map(publicSnapshot);
  }

  async fetchState(entityId: string): Promise<HomeStateSnapshot | null> {
    try {
      const result = await this.request(`states/${encodeURIComponent(entityId)}`);
      if (!isSnapshot(result) || result.entity_id !== entityId) {
        this.healthy = false;
        this.error = "ha_invalid_state";
        return null;
      }
      return publicSnapshot(result);
    } catch { return null; }
  }

  async callService(domain: string, service: string, serviceData: Record<string, unknown>) {
    try {
      await this.request(`services/${encodeURIComponent(domain)}/${encodeURIComponent(service)}`, serviceData);
      return { success: true };
    } catch { return { success: false, error: this.error ?? "ha_connection_failed" }; }
  }
}

function isSnapshot(value: unknown): value is HomeStateSnapshot {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<HomeStateSnapshot>;
  return typeof state.entity_id === "string" && /^[a-z_]+\.[a-z0-9_]+$/.test(state.entity_id)
    && typeof state.state === "string" && !!state.attributes && typeof state.attributes === "object" && !Array.isArray(state.attributes)
    && typeof state.last_changed === "string" && Number.isFinite(Date.parse(state.last_changed))
    && typeof state.last_updated === "string" && Number.isFinite(Date.parse(state.last_updated));
}

/** HA attributes may contain camera tokens and signed URLs. Expose telemetry only. */
function publicSnapshot(state: HomeStateSnapshot): HomeStateSnapshot {
  const keys = new Set(["friendly_name", "supported_color_modes", "supported_features", "brightness", "color_temp_kelvin",
    "min_color_temp_kelvin", "max_color_temp_kelvin", "unit_of_measurement", "device_class", "percentage",
    "temperature", "current_temperature", "min_temp", "max_temp", "target_temp_step", "humidity", "hvac_modes", "hvac_action",
    "options", "min", "max", "step", "fan_modes", "swing_modes", "preset_modes", "battery_level"]);
  return { entity_id: state.entity_id, state: state.entity_id.startsWith("text.") && !["unknown", "unavailable", ""].includes(state.state) ? "已隐藏" : state.state,
    last_changed: state.last_changed, last_updated: state.last_updated,
    attributes: Object.fromEntries(Object.entries(state.attributes).filter(([key]) => keys.has(key))) };
}
