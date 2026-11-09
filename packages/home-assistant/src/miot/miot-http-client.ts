import { MIOT_CLIENT_ID, miotHost, miotJson, record, unwrapMiot, validateClientId, type MiotNetworkOptions, type MiotRegion } from "./protocol.js";

/** Only action callers need the cloud rejection code to distinguish a rejected
 * start from an unknown transport outcome. */
export class MiotActionRequestError extends Error {
  constructor(readonly code: number) { super("miot_action_rejected"); }
}

export interface MiotHome { id: string; name: string; dids: string[]; rooms: Array<{ id: string; name: string; dids: string[] }> }
/** Public inventory intentionally excludes LAN tokens, IPs, network names and owner data. */
export interface MiotDevice { did: string; name: string; model: string; urn: string; online: boolean; home?: string; room?: string }
export interface MiotPropertyRef { did: string; siid: number; piid: number }
export interface MiotPropertyResult extends MiotPropertyRef { code: number; value?: string | number | boolean }
export interface MiotPropertyWrite extends MiotPropertyRef { value: number | boolean }
export interface MiotActionCall { did: string; siid: number; aiid: number; in?: Array<string | number | boolean> }
export interface MiotActionResult { did: string; siid: number; aiid: number; code: number; out?: unknown[] }
export const miotPropertyKey = (property: MiotPropertyRef): string => `${property.did}/${property.siid}/${property.piid}`;

function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || !value.every(record)) throw new Error("miot_invalid_response");
  return value;
}
function ids(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || !value.every((id) => typeof id === "string" && id.length > 0)) throw new Error("miot_invalid_response");
  return value;
}
function id(value: unknown): string {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  throw new Error("miot_invalid_response");
}
function validateRef(property: MiotPropertyRef): void {
  if (typeof property.did !== "string" || !property.did || !Number.isSafeInteger(property.siid) || property.siid <= 0
    || !Number.isSafeInteger(property.piid) || property.piid <= 0) throw new Error("miot_invalid_property");
}

export class MiotHttpClient {
  private readonly region: MiotRegion;
  private readonly clientId: string;
  constructor(private readonly options: MiotNetworkOptions & {
    region?: MiotRegion; clientId?: string; getAccessToken: () => Promise<string>;
  }) {
    this.region = options.region ?? "cn"; this.clientId = options.clientId ?? MIOT_CLIENT_ID;
    miotHost(this.region); validateClientId(this.clientId);
  }

  private async post(path: string, data: Record<string, unknown>): Promise<unknown> {
    let token: string;
    try { token = await this.options.getAccessToken(); }
    catch { throw new Error("miot_auth_required"); }
    if (!token) throw new Error("miot_auth_required");
    const response = await miotJson(`${miotHost(this.region)}/app/v2/${path}`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer${token}`,
        "X-Client-BizId": "haapi", "X-Client-AppId": this.clientId }, body: JSON.stringify(data),
    }, this.options);
    if (path === "miotspec/action" && record(response) && typeof response.code === "number" && response.code !== 0) throw new MiotActionRequestError(response.code);
    return unwrapMiot(response);
  }

  async listHomes(): Promise<MiotHome[]> {
    const result = await this.post("homeroom/gethome", { limit: 150, fetch_share: true, fetch_share_dev: true, plat_form: 0, app_ver: 9 });
    if (!record(result)) throw new Error("miot_invalid_response");
    const homes = new Map<string, MiotHome>();
    for (const item of [...rows(result.homelist ?? []), ...rows(result.share_home_list ?? [])]) {
      if (typeof item.name !== "string") throw new Error("miot_invalid_response");
      const home: MiotHome = { id: id(item.id), name: item.name, dids: ids(item.dids), rooms: rows(item.roomlist ?? []).map((room) => {
        if (typeof room.name !== "string") throw new Error("miot_invalid_response");
        return { id: id(room.id), name: room.name, dids: ids(room.dids) };
      }) };
      homes.set(home.id, home);
    }
    let page = result;
    const cursors = new Set<string>();
    while (page.has_more) {
      if (typeof page.max_id !== "string" || !page.max_id || cursors.has(page.max_id) || cursors.size >= 100) throw new Error("miot_invalid_pagination");
      cursors.add(page.max_id);
      const next = await this.post("homeroom/get_dev_room_page", { start_id: page.max_id, limit: 150 });
      if (!record(next)) throw new Error("miot_invalid_response");
      for (const item of rows(next.info)) {
        const home = homes.get(id(item.id));
        if (!home) continue;
        home.dids.push(...ids(item.dids));
        for (const itemRoom of rows(item.roomlist ?? [])) {
          const room = home.rooms.find((room) => room.id === id(itemRoom.id));
          if (room) room.dids.push(...ids(itemRoom.dids));
          else home.rooms.push({ id: id(itemRoom.id), name: "", dids: ids(itemRoom.dids) });
        }
      }
      page = next;
    }
    return [...homes.values()];
  }

  async listDevices(homes: MiotHome[] = []): Promise<MiotDevice[]> {
    const locations = new Map<string, { home: string; room?: string }>();
    for (const home of homes) {
      for (const did of home.dids) locations.set(did, { home: home.name });
      for (const room of home.rooms) for (const did of room.dids) locations.set(did, { home: home.name, room: room.name });
    }
    const devices = new Map<string, MiotDevice>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const result = await this.post("home/device_list_page", { limit: 200, get_split_device: true, get_third_device: true, dids: [], ...(cursor ? { start_did: cursor } : {}) });
      if (!record(result)) throw new Error("miot_invalid_response");
      for (const item of rows(result.list ?? [])) {
        if (typeof item.did !== "string" || !item.did || typeof item.name !== "string" || typeof item.model !== "string"
          || typeof item.spec_type !== "string" || item.did.startsWith("miwifi.")) continue;
        devices.set(item.did, { did: item.did, name: item.name, model: item.model, urn: item.spec_type,
          online: item.isOnline === true, ...locations.get(item.did) });
      }
      if (!result.has_more) break;
      if (typeof result.next_start_did !== "string" || !result.next_start_did || cursors.has(result.next_start_did) || cursors.size >= 100) throw new Error("miot_invalid_pagination");
      cursor = result.next_start_did; cursors.add(cursor);
    } while (true);
    return [...devices.values()];
  }

  /** At most three batches in flight; no automatic retries of reads or writes. */
  async getProperties(properties: MiotPropertyRef[]): Promise<MiotPropertyResult[]> {
    properties.forEach(validateRef);
    const unique = [...new Map(properties.map((property) => [miotPropertyKey(property), property])).values()];
    const batches = Array.from({ length: Math.ceil(unique.length / 150) }, (_, i) => unique.slice(i * 150, (i + 1) * 150));
    const results: MiotPropertyResult[][] = Array(batches.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(3, batches.length) }, async () => {
      while (next < batches.length) {
        const index = next++;
        results[index] = this.propertyResults(await this.post("miotspec/prop/get", { datasource: 1, params: batches[index] }), batches[index]);
      }
    }));
    return results.flat();
  }

  async setProperties(properties: MiotPropertyWrite[]): Promise<MiotPropertyResult[]> {
    if (!properties.length || properties.length > 150) throw new Error("miot_invalid_property");
    for (const property of properties) {
      validateRef(property);
      if (typeof property.value !== "boolean" && !(typeof property.value === "number" && Number.isFinite(property.value))) throw new Error("miot_invalid_property");
    }
    return this.propertyResults(await this.post("miotspec/prop/set", { params: properties }), properties);
  }

  async callAction(action: MiotActionCall): Promise<MiotActionResult> {
    if (typeof action.did !== "string" || !action.did || !Number.isSafeInteger(action.siid) || action.siid <= 0
      || !Number.isSafeInteger(action.aiid) || action.aiid <= 0) throw new Error("miot_invalid_action");
    const args = action.in ?? [];
    if (!Array.isArray(args) || args.some((item) => typeof item !== "boolean" && typeof item !== "string" && !(typeof item === "number" && Number.isFinite(item)))) {
      throw new Error("miot_invalid_action");
    }
    const result = await this.post("miotspec/action", {
      params: { did: action.did, siid: action.siid, aiid: action.aiid, in: args },
    });
    if (!record(result)) throw new Error("miot_invalid_response");
    const code = typeof result.code === "number" && Number.isFinite(result.code) ? result.code : 0;
    return {
      did: action.did,
      siid: action.siid,
      aiid: action.aiid,
      code,
      ...(Array.isArray(result.out) ? { out: result.out } : {}),
    };
  }

  private propertyResults(value: unknown, requested: MiotPropertyRef[]): MiotPropertyResult[] {
    const allowed = new Set(requested.map(miotPropertyKey));
    const seen = new Set<string>();
    return rows(value).map((item) => {
      const property = { did: item.did, siid: item.siid, piid: item.piid } as MiotPropertyRef;
      validateRef(property);
      const key = miotPropertyKey(property);
      if (!allowed.has(key) || seen.has(key) || typeof item.code !== "number" || !Number.isFinite(item.code)) throw new Error("miot_invalid_response");
      seen.add(key);
      const validValue = typeof item.value === "boolean" || typeof item.value === "string" || (typeof item.value === "number" && Number.isFinite(item.value));
      return { ...property, code: item.code, ...(validValue ? { value: item.value as string | number | boolean } : {}) };
    });
  }
}
