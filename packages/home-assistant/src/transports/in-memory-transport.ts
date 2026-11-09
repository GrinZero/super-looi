import type { HomeStateSnapshot } from "@super-looi/contracts";
import type { HaTransportAdapter } from "../types.js";

export class InMemoryHaTransportAdapter implements HaTransportAdapter {
  private readonly states = new Map<string, HomeStateSnapshot>();
  private healthy = true;
  private lastVerifiedAt: string | null = new Date().toISOString();
  private simulateTimeout = false;

  constructor(initialStates?: Record<string, HomeStateSnapshot>) {
    if (initialStates) {
      for (const [k, v] of Object.entries(initialStates)) {
        this.states.set(k, v);
      }
    }
  }

  public setHealthy(healthy: boolean): void {
    this.healthy = healthy;
  }

  public setSimulateTimeout(simulate: boolean): void {
    this.simulateTimeout = simulate;
  }

  public isHealthy(): boolean {
    return this.healthy;
  }

  public getLastVerifiedAt(): string | null {
    return this.lastVerifiedAt;
  }

  public async fetchState(entityId: string): Promise<HomeStateSnapshot | null> {
    if (!this.healthy) return null;
    return this.states.get(entityId) ?? null;
  }

  public async listStates(): Promise<HomeStateSnapshot[]> {
    if (!this.healthy) return [];
    return Array.from(this.states.values());
  }

  public async callService(
    domain: string,
    service: string,
    serviceData: Record<string, unknown>
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.healthy) {
      return { success: false, error: "Home Assistant gateway disconnected" };
    }
    if (this.simulateTimeout) {
      return { success: false, error: "Network timeout waiting for device readback" };
    }

    const entityId = String(serviceData.entity_id || `${domain}.default`);
    const existing = this.states.get(entityId);
    const now = new Date().toISOString();
    this.lastVerifiedAt = now;

    let targetState = existing?.state ?? "on";
    if (service === "turn_off") {
      targetState = "off";
    } else if (service === "turn_on") {
      targetState = domain === "climate" ? String(existing?.attributes?.hvac_mode ?? "cool") : "on";
    } else if (service === "set_percentage" && typeof serviceData.percentage === "number") {
      targetState = serviceData.percentage > 0 ? "on" : "off";
    } else if (service === "set_hvac_mode" && typeof serviceData.hvac_mode === "string") {
      targetState = serviceData.hvac_mode;
    } else if (service === "select_option" && typeof serviceData.option === "string") {
      targetState = serviceData.option;
    } else if (service === "set_value" && serviceData.value !== undefined) {
      targetState = String(serviceData.value);
    } else if (service === "press" || service === "send_message") {
      targetState = now;
    }

    this.states.set(entityId, {
      entity_id: entityId,
      state: targetState,
      attributes: { ...existing?.attributes, ...serviceData } as any,
      last_changed: now,
      last_updated: now,
    });

    // Update companion simulation states when pressing cycle appliance action buttons
    if (entityId === "button.rice_cooker_start") {
      const st = this.states.get("sensor.rice_cooker_status");
      if (st) this.states.set("sensor.rice_cooker_status", { ...st, state: "沸腾中", last_updated: now });
      const lt = this.states.get("sensor.rice_cooker_left_time");
      if (lt) this.states.set("sensor.rice_cooker_left_time", { ...lt, state: "18", last_updated: now });
    } else if (entityId === "button.rice_cooker_cancel") {
      const st = this.states.get("sensor.rice_cooker_status");
      if (st) this.states.set("sensor.rice_cooker_status", { ...st, state: "保温", last_updated: now });
      const lt = this.states.get("sensor.rice_cooker_left_time");
      if (lt) this.states.set("sensor.rice_cooker_left_time", { ...lt, state: "0", last_updated: now });
    } else if (entityId === "button.rooftop_washer_pause") {
      const st = this.states.get("sensor.rooftop_washer_status");
      if (st) {
        const nextSt = st.state === "暂停" ? "洗涤" : "暂停";
        this.states.set("sensor.rooftop_washer_status", { ...st, state: nextSt, last_updated: now });
      }
    } else if (entityId === "button.rooftop_washer_shake") {
      const st = this.states.get("sensor.rooftop_washer_status");
      if (st) this.states.set("sensor.rooftop_washer_status", { ...st, state: "抖散", last_updated: now });
    } else if (entityId === "button.pet_feeder_dispense") {
      const eaten = this.states.get("sensor.pet_feeder_eaten");
      if (eaten) {
        const cur = Number(eaten.state) || 45;
        this.states.set("sensor.pet_feeder_eaten", { ...eaten, state: String(cur + 10), last_updated: now });
      }
    } else if (entityId === "button.vacuum_start") {
      const st = this.states.get("sensor.vacuum_status");
      if (st) this.states.set("sensor.vacuum_status", { ...st, state: "清扫中", last_updated: now });
    } else if (entityId === "button.vacuum_stop") {
      const st = this.states.get("sensor.vacuum_status");
      if (st) this.states.set("sensor.vacuum_status", { ...st, state: "已暂停", last_updated: now });
    } else if (entityId === "button.vacuum_charge") {
      const st = this.states.get("sensor.vacuum_status");
      if (st) this.states.set("sensor.vacuum_status", { ...st, state: "13", last_updated: now });
    } else if (entityId === "button.vacuum_dust") {
      const st = this.states.get("sensor.vacuum_status");
      if (st) this.states.set("sensor.vacuum_status", { ...st, state: "集尘中", last_updated: now });
    } else if (entityId === "button.vacuum_wash_mop") {
      const st = this.states.get("sensor.vacuum_status");
      if (st) this.states.set("sensor.vacuum_status", { ...st, state: "清洗拖布中", last_updated: now });
    } else if (entityId === "button.vacuum_dry") {
      const st = this.states.get("sensor.vacuum_status");
      if (st) this.states.set("sensor.vacuum_status", { ...st, state: "烘干拖布中", last_updated: now });
    }

    return { success: true };
  }

  public setInternalState(entityId: string, snapshot: HomeStateSnapshot): void {
    this.states.set(entityId, snapshot);
    this.lastVerifiedAt = snapshot.last_updated;
  }
}

