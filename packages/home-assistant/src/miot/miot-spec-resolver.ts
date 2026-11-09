import { miotJson, record, type MiotNetworkOptions } from "./protocol.js";

export interface StorageCache { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<void> }
export interface MiotSpecValueOption { value: number; description: string }
export interface MiotSpecProperty {
  siid: number; piid: number; name: string; description: string; format: string;
  readable: boolean; writable: boolean; unit?: string; range?: [number, number, number];
  valueList?: MiotSpecValueOption[];
}
export interface MiotSpecAction {
  siid: number; aiid: number; name: string; description: string; in: number[]; out: number[];
}
export interface MiotSpecService { siid: number; name: string; description: string; properties: MiotSpecProperty[]; actions?: MiotSpecAction[] }
export interface MiotSpec { urn: string; deviceType: string; services: MiotSpecService[] }

function urnName(value: unknown, kind: string): string | null {
  if (typeof value !== "string") return null;
  return new RegExp(`^urn:miot-spec-v2:${kind}:([a-z0-9.-]+):`).exec(value)?.[1] ?? null;
}
export function parseMiotSpec(value: unknown, urn: string): MiotSpec {
  if (!record(value) || value.type !== urn || !Array.isArray(value.services)) throw new Error("miot_invalid_spec");
  const deviceType = urnName(urn, "device");
  if (!deviceType) throw new Error("miot_invalid_spec");
  const services: MiotSpecService[] = [];
  const serviceIds = new Set<number>();
  for (const service of value.services) {
    if (!record(service) || !Number.isSafeInteger(service.iid) || Number(service.iid) <= 0 || serviceIds.has(Number(service.iid))) throw new Error("miot_invalid_spec");
    serviceIds.add(Number(service.iid));
    const name = urnName(service.type, "service");
    if (!name) continue;
    const properties: MiotSpecProperty[] = [];
    const propertyIds = new Set<number>();
    if (service.properties !== undefined && !Array.isArray(service.properties)) throw new Error("miot_invalid_spec");
    for (const property of service.properties ?? []) {
      if (!record(property) || !Number.isSafeInteger(property.iid) || Number(property.iid) <= 0 || propertyIds.has(Number(property.iid))) throw new Error("miot_invalid_spec");
      propertyIds.add(Number(property.iid));
      const propertyName = urnName(property.type, "property");
      if (!propertyName || typeof property.format !== "string" || !Array.isArray(property.access)) continue;
      const rawRange = property["value-range"];
      const range: [number, number, number] | undefined = Array.isArray(rawRange) && rawRange.length === 3
        && rawRange.every((n) => typeof n === "number" && Number.isFinite(n)) && rawRange[0] < rawRange[1] && rawRange[2] > 0
        ? [rawRange[0], rawRange[1], rawRange[2]] : undefined;
      const rawValueList = property["value-list"];
      const valueList: MiotSpecValueOption[] | undefined = Array.isArray(rawValueList)
        ? rawValueList
            .filter((item): item is Record<string, unknown> => record(item) && typeof item.value === "number" && Number.isFinite(item.value) && typeof item.description === "string" && item.description.trim().length > 0)
            .map((item) => ({ value: item.value as number, description: (item.description as string).trim() }))
        : undefined;
      properties.push({ siid: Number(service.iid), piid: Number(property.iid), name: propertyName,
        description: typeof property.description === "string" ? property.description : propertyName,
        format: property.format, readable: property.access.includes("read"), writable: property.access.includes("write"),
        ...(typeof property.unit === "string" ? { unit: property.unit } : {}), ...(range ? { range } : {}),
        ...(valueList && valueList.length > 0 ? { valueList } : {}) });
    }
    const actions: MiotSpecAction[] = [];
    const actionIds = new Set<number>();
    if (Array.isArray(service.actions)) {
      for (const action of service.actions) {
        if (!record(action) || !Number.isSafeInteger(action.iid) || Number(action.iid) <= 0 || actionIds.has(Number(action.iid))) continue;
        actionIds.add(Number(action.iid));
        const actionName = urnName(action.type, "action");
        if (!actionName) continue;
        const inPiids = Array.isArray(action.in)
          ? action.in.filter((n): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0)
          : [];
        const outPiids = Array.isArray(action.out)
          ? action.out.filter((n): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0)
          : [];
        actions.push({
          siid: Number(service.iid),
          aiid: Number(action.iid),
          name: actionName,
          description: typeof action.description === "string" && action.description.trim() ? action.description.trim() : actionName,
          in: inPiids,
          out: outPiids,
        });
      }
    }
    services.push({
      siid: Number(service.iid),
      name,
      description: typeof service.description === "string" ? service.description : name,
      properties,
      ...(actions.length > 0 ? { actions } : {}),
    });
  }
  return { urn, deviceType, services };
}

export class MiotSpecResolver {
  private readonly memory = new Map<string, { spec: MiotSpec; expiresAt: number }>();
  private readonly inflight = new Map<string, Promise<MiotSpec>>();
  constructor(private readonly options: MiotNetworkOptions & { cache?: StorageCache; now?: () => number; ttlMs?: number } = {}) {}

  async resolve(urn: string): Promise<MiotSpec> {
    if (!urnName(urn, "device")) throw new Error("miot_invalid_spec_urn");
    const now = (this.options.now ?? Date.now)();
    const cached = this.memory.get(urn);
    if (cached && cached.expiresAt > now) return JSON.parse(JSON.stringify(cached.spec)) as MiotSpec;
    let promise = this.inflight.get(urn);
    if (!promise) {
      promise = this.load(urn, now);
      this.inflight.set(urn, promise);
    }
    try { return JSON.parse(JSON.stringify(await promise)) as MiotSpec; } finally { if (this.inflight.get(urn) === promise) this.inflight.delete(urn); }
  }

  private async load(urn: string, now: number): Promise<MiotSpec> {
    const key = `miot-spec-v1:${urn}`;
    if (this.options.cache) {
      try {
        const cached = JSON.parse(await this.options.cache.get(key) ?? "null");
        if (record(cached) && typeof cached.expiresAt === "number" && cached.expiresAt > now) {
          const spec = parseMiotSpec(cached.raw, urn);
          this.memory.set(urn, { spec, expiresAt: cached.expiresAt }); return spec;
        }
      } catch { /* Corrupt/unavailable caches are optional; always revalidate from the origin. */ }
    }
    const raw = await miotJson(`https://miot-spec.org/miot-spec-v2/instance?${new URLSearchParams({ type: urn })}`, {}, this.options);
    const spec = parseMiotSpec(raw, urn);
    const expiresAt = now + (this.options.ttlMs ?? 14 * 24 * 3600_000);
    this.memory.set(urn, { spec, expiresAt });
    try { await this.options.cache?.set(key, JSON.stringify({ raw, expiresAt })); } catch { /* Public schema caching is best effort. */ }
    return spec;
  }
}
