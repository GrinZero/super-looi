import type { HomeControlCommand, HomeStateSnapshot } from "@super-looi/contracts";
import type { HomeClient } from "../runtime/local-control-center.js";
import type { LooiIconName } from "./components/LooiIcon.js";

export interface KelvinPreset {
  kelvin: number;
  label: string;
  shortLabel: string;
  color: string;
}

const MIOT_SUFFIX_TRANSLATIONS: ReadonlyArray<[RegExp, string]> = [
  [/\s*·\s*(?:light|fan|switch|outlet|air\s*purifier|ceiling\s*fan\s*light)$/iu, ""],
  [/\s*·\s*temperature$/iu, " · 温度"],
  [/\s*·\s*(?:relative\s*)?humidity$/iu, " · 湿度"],
  [/\s*·\s*battery(?:\s*level)?$/iu, " · 电量"],
  [/\s*·\s*pm2[._-]?5(?:\s*density)?$/iu, " · PM2.5"],
  [/\s*·\s*(?:carbon\s*dioxide(?:\s*density)?|co2)$/iu, " · CO₂"],
  [/\s*·\s*indicator\s*light$/iu, " · 指示灯"],
  [/\s*·\s*physical\s*control\s*locked$/iu, " · 童锁"],
  [/\s*·\s*alarm$/iu, " · 提示音"],
  [/\s*·\s*illumination$/iu, " · 光照度"],
];

/** Clean up redundant suffixes from Mijia / HA entity names while keeping full clarity. */
export function formatDeviceDisplay(device: {
  entity_id: string;
  friendly_name: string;
  device_name?: string;
  room?: string;
  domain?: string;
}): { title: string; roomLabel: string | null; icon: LooiIconName } {
  const domain = device.domain ?? device.entity_id.split(".")[0];
  let raw = device.friendly_name.trim();
  for (const [pattern, replacement] of MIOT_SUFFIX_TRANSLATIONS) {
    raw = raw.replace(pattern, replacement);
  }
  raw = raw.replace(/^(.*灯(?:\s*[（(][^）)]+[）)])?)\s+灯$/u, "$1");
  raw = raw.replace(/^(.*开关(?:\s*[（(][^）)]+[）)])?)\s+开关$/u, "$1");
  raw = raw.replace(/^(.*风扇(?:\s*[（(][^）)]+[）)])?)\s+风扇$/u, "$1");

  let roomLabel = device.room?.trim() || null;
  const parenMatch = raw.match(/^(.*?)\s*[（(]([^）)]+)[）)](\s*·\s*.*)?$/u);
  if (parenMatch) {
    const inParen = parenMatch[2].trim();
    if (!roomLabel || roomLabel === inParen) {
      roomLabel = inParen;
      raw = `${parenMatch[1].trim()}${parenMatch[3] ?? ""}`.trim();
    }
  }

  const parts = raw.split(/\s*·\s*/u);
  if (
    parts.length === 2 &&
    (parts[0].toLowerCase() === parts[1].toLowerCase() ||
      (parts[1].length > 0 && parts[0].endsWith(parts[1])))
  ) {
    raw = parts[0];
  }
  raw = raw.replace(/\s*·\s*$/u, "").trim();

  let icon: LooiIconName = "sensor";
  if (domain === "light") {
    icon = /ceiling|吸顶|主灯|吊灯/i.test(`${raw} ${device.entity_id}`) ? "sun" : "lamp";
  } else if (domain === "fan" || /fan|风|净化/i.test(`${raw} ${device.entity_id}`)) {
    icon = "wind";
  } else if (domain === "switch") {
    icon = "sparkles";
  } else if (domain === "binary_sensor") {
    icon = "radar";
  }

  return { title: raw || device.entity_id, roomLabel, icon };
}

function quantizeStep(value: number, min: number, max: number): number {
  const clamped = Math.max(min, Math.min(max, value));
  const rounded = Math.round(clamped / 100) * 100;
  return Math.max(min, Math.min(max, rounded));
}

export function buildKelvinPresets(range: [number, number] | undefined, count: 3 | 5 = 3): KelvinPreset[] {
  if (!range || range[0] >= range[1]) return [];
  const [min, max] = range;
  const candidates: Array<{ target: number; label: string; shortLabel: string; color: string }> = count === 3
    ? [
        { target: 3000, label: "暖黄光", shortLabel: "暖光", color: "#FFB347" },
        { target: 4000, label: "自然白", shortLabel: "自然", color: "#FFF4E0" },
        { target: 5500, label: "清冷光", shortLabel: "清冷", color: "#8CE0FF" },
      ]
    : [
        { target: 2700, label: "柔和暖光", shortLabel: "柔暖", color: "#FF9E44" },
        { target: 3200, label: "温馨暖白", shortLabel: "暖白", color: "#FFC168" },
        { target: 4000, label: "自然阅读", shortLabel: "自然", color: "#FFF4E0" },
        { target: 5000, label: "明亮日光", shortLabel: "日光", color: "#D6F0FF" },
        { target: 6000, label: "清冷专注", shortLabel: "清冷", color: "#8CE0FF" },
      ];

  const seen = new Set<number>();
  const presets: KelvinPreset[] = [];
  for (let i = 0; i < candidates.length; i += 1) {
    const item = candidates[i];
    const fallback = Math.round(min + ((max - min) * i) / Math.max(1, candidates.length - 1));
    const preferred = item.target >= min && item.target <= max ? item.target : fallback;
    const kelvin = quantizeStep(preferred, min, max);
    if (!seen.has(kelvin)) {
      seen.add(kelvin);
      presets.push({ kelvin, label: item.label, shortLabel: item.shortLabel, color: item.color });
    }
  }
  return presets;
}

export function isKelvinPresetActive(
  currentKelvin: number | undefined,
  presetKelvin: number,
  allPresets: readonly KelvinPreset[],
): boolean {
  if (currentKelvin === undefined || !allPresets.length) return false;
  let closest = allPresets[0].kelvin;
  let minDiff = Math.abs(currentKelvin - closest);
  for (const preset of allPresets) {
    const diff = Math.abs(currentKelvin - preset.kelvin);
    if (diff < minDiff) {
      minDiff = diff;
      closest = preset.kelvin;
    }
  }
  return closest === presetKelvin && minDiff <= 450;
}

export function formatSensorReading(
  state: HomeStateSnapshot | null,
  healthy: boolean,
): { valueText: string; unitText: string; statusLabel: string } {
  if (!healthy || !state || ["unavailable", "unknown"].includes(state.state)) {
    return { valueText: "—", unitText: "", statusLabel: "暂不可读" };
  }
  if (state.state === "on") return { valueText: "开启", unitText: "", statusLabel: "状态触发" };
  if (state.state === "off") return { valueText: "关闭", unitText: "", statusLabel: "状态正常" };
  const unit = typeof state.attributes.unit_of_measurement === "string" ? state.attributes.unit_of_measurement : "";
  return { valueText: state.state, unitText: unit, statusLabel: "实时采样" };
}

export interface HomeControlFeedback {
  command: HomeControlCommand;
  optimisticAttributes: Record<string, unknown>;
  phase: "pending" | "uncertain" | "rejected";
  requestedAt: number;
}

export interface OptimisticHomeDeviceState {
  on: boolean;
  brightness: number;
  kelvin: number | undefined;
  syncing: boolean;
  rejected: boolean;
}

/** Compute immediate optimistic UI state from the latest user intent and physical snapshot. */
export function resolveOptimisticHomeState(
  snapshot: HomeStateSnapshot | null | undefined,
  feedback: HomeControlFeedback | undefined,
): OptimisticHomeDeviceState {
  const activeIntent = feedback && (feedback.phase === "pending" || feedback.phase === "uncertain");
  const attrs = activeIntent
    ? { ...snapshot?.attributes, ...feedback.optimisticAttributes, ...feedback.command.service_data }
    : snapshot?.attributes;
  const on = activeIntent ? feedback.command.service === "turn_on" : snapshot?.state === "on";
  const brightness = typeof attrs?.brightness === "number" && Number.isFinite(attrs.brightness)
    ? Math.max(1, Math.min(255, Math.round(attrs.brightness)))
    : 128;
  const kelvin = typeof attrs?.color_temp_kelvin === "number" && Number.isFinite(attrs.color_temp_kelvin)
    ? Math.round(attrs.color_temp_kelvin)
    : undefined;
  return {
    on,
    brightness,
    kelvin,
    syncing: Boolean(activeIntent),
    rejected: feedback?.phase === "rejected",
  };
}

/** Serialize writes per device, retaining the latest explicit intent while a readback is in flight. */
export class HomeControlInteraction {
  private feedback = new Map<string, HomeControlFeedback>();
  private queued = new Map<string, HomeControlCommand>();
  private running = new Map<string, number>();
  private lifecycle = 0;
  private active = true;
  revision = 0;

  constructor(private readonly options: {
    execute: HomeClient["execute"];
    changed: () => void;
    observed: (entityId: string, snapshot: HomeStateSnapshot) => void;
    settled: (entityId: string, phase: "verified" | "uncertain" | "rejected") => void;
  }) {}

  get(entityId: string) { return this.feedback.get(entityId); }
  get isActive() { return this.active; }
  activate() { this.active = true; }
  dispose() {
    this.active = false; ++this.lifecycle; ++this.revision;
    this.queued.clear(); this.feedback.clear(); this.running.clear();
  }

  request(command: HomeControlCommand): void {
    if (!this.active) return;
    const previous = this.feedback.get(command.entity_id);
    // A color adjustment after a brightness adjustment must retain both targets.
    const next = { ...command, service_data: command.service === "turn_on" && previous?.phase === "pending" && previous.command.service === "turn_on"
      ? { ...previous.command.service_data, ...command.service_data } : { ...command.service_data } };
    const optimisticAttributes = command.service === "turn_on"
      ? (previous && (previous.phase === "pending" || previous.phase === "uncertain") && previous.command.service === "turn_on"
        ? { ...previous.optimisticAttributes, ...next.service_data }
        : { ...next.service_data })
      : {};
    this.feedback.set(command.entity_id, { command: next, optimisticAttributes, phase: "pending", requestedAt: Date.now() });
    this.queued.set(command.entity_id, next);
    ++this.revision;
    this.options.changed();
    if (!this.running.has(command.entity_id)) void this.drain(command.entity_id);
  }

  reconcile(snapshots: Array<{ entity_id: string; snapshot: HomeStateSnapshot | null; max_state_age_ms?: number }>): void {
    for (const entity of snapshots) {
      const feedback = this.feedback.get(entity.entity_id);
      const snapshot = entity.snapshot;
      if (feedback?.phase !== "uncertain" || !snapshot) continue;
      const observedAt = Date.parse(snapshot.last_updated);
      if (observedAt < feedback.requestedAt || !Number.isFinite(observedAt) || observedAt > Date.now() + 5000
        || Date.now() - observedAt > (entity.max_state_age_ms ?? 15000)) continue;
      if (snapshot.state === (feedback.command.service === "turn_on" ? "on" : "off")
        && Object.entries(feedback.optimisticAttributes).every(([key, value]) => snapshot.attributes[key] === value)) {
        this.feedback.delete(entity.entity_id);
      }
    }
  }

  private async drain(entityId: string): Promise<void> {
    const lifecycle = this.lifecycle;
    this.running.set(entityId, lifecycle);
    try {
      while (this.active && this.queued.has(entityId)) {
        const command = this.queued.get(entityId)!;
        this.queued.delete(entityId);
        let result: Awaited<ReturnType<HomeClient["execute"]>> | undefined;
        try { result = await this.options.execute(command); } catch { /* Dispatch may have succeeded; never replay it. */ }
        if (!this.active || lifecycle !== this.lifecycle) return;
        ++this.revision;
        const snapshot = receiptSnapshot(entityId, result?.receipt);
        if (snapshot) this.options.observed(entityId, snapshot);
        if (this.queued.has(entityId)) continue;
        const phase = result?.receipt.status === "verified" ? "verified" : result?.receipt.status === "rejected" ? "rejected" : "uncertain";
        if (phase === "verified") this.feedback.delete(entityId);
        else this.feedback.set(entityId, { ...this.feedback.get(entityId)!, phase });
        this.options.changed();
        this.options.settled(entityId, phase);
      }
    } finally { if (this.running.get(entityId) === lifecycle) this.running.delete(entityId); }
  }
}

function receiptSnapshot(entityId: string, receipt: { status: string; [key: string]: unknown } | undefined): HomeStateSnapshot | null {
  if (receipt?.status !== "verified" || !Array.isArray(receipt.readbacks)) return null;
  for (const readback of receipt.readbacks) {
    if (readback?.kind !== "device_state" || !["on", "off"].includes(readback.value?.state)
      || !readback.value?.attributes || typeof readback.value.attributes !== "object" || Array.isArray(readback.value.attributes)
      || typeof readback.observed_at !== "string" || !Number.isFinite(Date.parse(readback.observed_at))) continue;
    return { entity_id: entityId, state: readback.value.state, attributes: readback.value.attributes,
      last_changed: readback.observed_at, last_updated: readback.observed_at };
  }
  return null;
}

/** Keep newer physical evidence when HA returns an older cached state after a receipt. */
export function mergeHomeSnapshots<T extends { entity_id: string; snapshot: HomeStateSnapshot | null }>(previous: T[], incoming: T[]): T[] {
  const byId = new Map(previous.map((entity) => [entity.entity_id, entity.snapshot]));
  return incoming.map((entity) => {
    const before = byId.get(entity.entity_id);
    const after = entity.snapshot;
    if (!before || !after || ["unavailable", "unknown"].includes(after.state)) return entity;
    const beforeAt = Date.parse(before.last_updated);
    const afterAt = Date.parse(after.last_updated);
    return Number.isFinite(beforeAt) && beforeAt <= Date.now() + 5000 && Number.isFinite(afterAt) && afterAt < beforeAt
      ? { ...entity, snapshot: before } : entity;
  });
}
