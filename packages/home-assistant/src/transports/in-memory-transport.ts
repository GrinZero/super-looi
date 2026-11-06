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

    let targetState = "on";
    if (service === "turn_off") {
      targetState = "off";
    }

    this.states.set(entityId, {
      entity_id: entityId,
      state: targetState,
      attributes: { ...existing?.attributes, ...serviceData } as any,
      last_changed: now,
      last_updated: now,
    });

    return { success: true };
  }

  public setInternalState(entityId: string, snapshot: HomeStateSnapshot): void {
    this.states.set(entityId, snapshot);
    this.lastVerifiedAt = snapshot.last_updated;
  }
}

