export type StudyDeviceId = "light.study_ceiling" | "light.study_desk" | "fan.study_fresh_air";

export interface StudyDeviceSnapshot {
  entityId: StudyDeviceId;
  on: boolean;
  brightness: number;
  kelvin: number;
  updatedAt: string;
}

export interface StudyRuleProposal {
  id: string;
  count: number;
  kelvin: number;
  brightness: number;
  status: "proposed" | "confirmed" | "dismissed";
  confirmedBy?: string;
}

export interface StudyDeviceResult {
  status: "verified" | "unverified" | "rejected";
  reason: string;
  snapshot?: StudyDeviceSnapshot;
}

/** Explicitly local demonstration transport. It never sends physical HA commands. */
export class StudyHomeDemo {
  private readonly devices: Record<StudyDeviceId, StudyDeviceSnapshot>;
  private healthy = true;
  private adjustmentCount = 2;
  private proposal: StudyRuleProposal | null = null;
  private sentCommands = 0;
  readonly sensorUpdatedAt: string;

  constructor() {
    const now = new Date().toISOString();
    this.sensorUpdatedAt = now;
    this.devices = {
      "light.study_ceiling": { entityId: "light.study_ceiling", on: true, brightness: 180, kelvin: 4000, updatedAt: now },
      "light.study_desk": { entityId: "light.study_desk", on: true, brightness: 120, kelvin: 3000, updatedAt: now },
      "fan.study_fresh_air": { entityId: "fan.study_fresh_air", on: false, brightness: 0, kelvin: 0, updatedAt: now },
    };
  }

  setHealthy(healthy: boolean): void { this.healthy = healthy; }
  getCommandCount(): number { return this.sentCommands; }
  getSnapshot(entityId: StudyDeviceId): StudyDeviceSnapshot { return { ...this.devices[entityId] }; }
  getProposal(): StudyRuleProposal | null { return this.proposal ? { ...this.proposal } : null; }

  async execute(entityId: string, target: { on?: boolean; brightness?: number; kelvin?: number }): Promise<StudyDeviceResult> {
    // Reject high risk targets before transport access, even while disconnected.
    if (["lock", "alarm_control_panel", "gas", "water_heater", "garage_door"].includes(entityId.split(".")[0])) {
      return { status: "rejected", reason: "forbidden_high_risk_domain" };
    }
    if (!(entityId in this.devices)) return { status: "rejected", reason: "entity_not_whitelisted" };
    if (target.brightness !== undefined && (!Number.isInteger(target.brightness) || target.brightness < 1 || target.brightness > 255)) {
      return { status: "rejected", reason: "brightness_out_of_range" };
    }
    if (target.kelvin !== undefined && ![3000, 4000, 5500].includes(target.kelvin)) {
      return { status: "rejected", reason: "color_temperature_not_supported" };
    }
    if (!this.healthy) return { status: "unverified", reason: "gateway_offline" };
    const id = entityId as StudyDeviceId;
    this.sentCommands += 1;
    this.devices[id] = { ...this.devices[id], ...target, updatedAt: new Date().toISOString() };
    // Read the transport state back and compare every requested target field.
    await Promise.resolve();
    if (!this.healthy) return { status: "unverified", reason: "readback_unavailable" };
    const readback = this.getSnapshot(id);
    const matches = Object.entries(target).every(([key, value]) => readback[key as keyof StudyDeviceSnapshot] === value);
    return matches
      ? { status: "verified", reason: "local_demo_readback", snapshot: readback }
      : { status: "unverified", reason: "readback_mismatch" };
  }

  recordThirdAdjustment(): StudyRuleProposal {
    this.adjustmentCount += 1;
    if (this.proposal && this.proposal.status !== "dismissed") return { ...this.proposal };
    const ceiling = this.getSnapshot("light.study_ceiling");
    this.proposal = {
      id: `study_evening_${this.adjustmentCount}`,
      count: this.adjustmentCount,
      kelvin: ceiling.kelvin,
      brightness: ceiling.brightness,
      status: "proposed",
    };
    return { ...this.proposal };
  }

  confirmProposal(userEventId: string): StudyRuleProposal {
    if (!this.proposal || this.proposal.status !== "proposed") throw new Error("No pending rule proposal");
    if (!userEventId.trim()) throw new Error("Explicit user confirmation is required");
    this.proposal = { ...this.proposal, status: "confirmed", confirmedBy: userEventId };
    return { ...this.proposal };
  }

  dismissProposal(): void {
    if (this.proposal?.status === "proposed") this.proposal = { ...this.proposal, status: "dismissed" };
  }

  reconcile(): { deviceOn: boolean; explanation: string } {
    const deviceOn = this.devices["light.study_ceiling"].on;
    return {
      deviceOn,
      explanation: `本地演示: 视觉观察为${deviceOn ? "画面偏暗" : "画面明亮"}，设备回读为${deviceOn ? "开启" : "关闭"}。两条证据分别保留，灯的开关以设备回读为准；画面亮度不能推断 CO2、温度或湿度。`,
    };
  }
}
