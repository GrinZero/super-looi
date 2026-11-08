import {
  DirectMiotTransportAdapter, HomeAssistantGateway, HomeAssistantRestTransport, InMemoryHaTransportAdapter,
  MiotOAuthClient, MiotHttpClient, MiotSpecResolver, executeHomeVoiceTool, HOME_VOICE_TOOLS,
  readHomeRegistry,
  type CredentialStore, type MiotCryptoProvider, type MiotRegion, type HaTransportAdapter, type HomeEntityMetadata,
} from "@super-looi/home-assistant";
import type { HomeControlCommand, HomeEntityDefinition, HomeStateSnapshot } from "@super-looi/contracts";
import { LocalPersonalMemoryStore, type LocalStorage } from "./local-memory.js";
import type { HubMemoryItem } from "./live-voice-client.js";

export type HomeMode = "hub" | "direct_miot" | "external_ha" | "simulation";
export interface HomeConnection {
  configured: boolean; healthy: boolean; lastVerifiedAt: string | null; deviceCount?: number; label?: string;
  entities: Array<HomeEntityDefinition & { snapshot: HomeStateSnapshot | null }>;
  readOnlyEntities: Array<HomeEntityDefinition & { snapshot: HomeStateSnapshot | null }>;
}
export interface HomeClient { normalizeServiceData?(entityId: string, data: HomeControlCommand["service_data"]): HomeControlCommand["service_data"]; getConnection(): Promise<HomeConnection>; execute(command: HomeControlCommand): Promise<{ receipt: { status: string; [key: string]: unknown } }> }
interface Preferences { mode: HomeMode; region: MiotRegion; haUrl: string; voiceMode: "local" | "hub"; callbackId: string }
const modeNames = { hub: "Hub 家居", direct_miot: "米家直连", external_ha: "Home Assistant", simulation: "离线演示" };

export class LocalControlCenter implements HomeClient {
  readonly memories: LocalPersonalMemoryStore;
  preferences: Preferences;
  private listeners = new Set<() => void>();
  private generation = 0;
  private gateway: HomeAssistantGateway | null = null;
  private transport: HaTransportAdapter | null = null;
  private definitions: HomeEntityDefinition[] = [];
  private oauth: MiotOAuthClient | null = null;
  private ready: Promise<void> | null = null;
  private connecting: Promise<void> | null = null;
  private setupWrites: Promise<void> = Promise.resolve();
  private lastError: string | null = null;
  constructor(readonly options: { credentials: CredentialStore; storage: LocalStorage; crypto: MiotCryptoProvider; hubOrigin: string; fetch?: typeof fetch; registry?: typeof readHomeRegistry }) {
    this.preferences = { mode: "hub", region: "cn", haUrl: "", voiceMode: "hub", callbackId: options.crypto.randomUUID() };
    this.memories = new LocalPersonalMemoryStore(options.storage, () => options.crypto.randomUUID(), () => this.changed());
  }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private changed() { for (const listener of this.listeners) listener(); }
  get revision() { return this.generation; }
  get error() { return this.lastError; }
  get modeLabel() { return modeNames[this.preferences.mode]; }
  initialize(): Promise<void> {
    if (!this.ready) this.ready = (async () => {
      const raw = await this.options.storage.get("local-center-v1");
      if (raw) {
        const saved = JSON.parse(raw) as Preferences;
        if (!Object.hasOwn(modeNames, saved.mode) || !["cn", "de", "i2", "ru", "sg", "us"].includes(saved.region)
          || !["local", "hub"].includes(saved.voiceMode) || typeof saved.haUrl !== "string" || !/^[a-f0-9-]{36}$/i.test(saved.callbackId)) throw new Error("本机连接配置无法读取");
        this.preferences = saved;
      }
      await this.memories.initialize();
      void this.reconnect();
    })();
    return this.ready;
  }
  async configure(patch: Partial<Omit<Preferences, "callbackId">>, secrets?: { haToken?: string; voiceKey?: string }, connect = true): Promise<void> {
    await this.initialize();
    const task = this.setupWrites.then(async () => {
      if (patch.voiceMode && patch.voiceMode !== this.preferences.voiceMode) this.memories.invalidateCaptures();
      this.invalidate();
      const next = { ...this.preferences, ...patch };
      if (secrets?.haToken !== undefined) await this.options.credentials.set(`external-ha-token:${next.haUrl}`, secrets.haToken.trim());
      if (secrets?.voiceKey !== undefined) await this.options.credentials.set("doubao-api-key", secrets.voiceKey.trim());
      await this.options.storage.set("local-center-v1", JSON.stringify(next));
      this.preferences = next; this.oauth = null; this.changed();
      if (connect) void this.reconnect();
    });
    this.setupWrites = task.catch(() => {});
    return task;
  }
  private invalidate() { this.oauth?.cancelAuthSession(); ++this.generation; this.gateway = null; this.transport = null; this.definitions = []; this.lastError = null; this.changed(); }
  private auth(region = this.preferences.region) {
    if (!this.oauth) this.oauth = new MiotOAuthClient({ region, redirectUri: `http://homeassistant.local:8123/api/webhook/${this.preferences.callbackId}`,
      store: this.options.credentials, crypto: this.options.crypto, fetch: this.options.fetch });
    return this.oauth;
  }
  async beginMiotLogin(region: MiotRegion) { await this.configure({ mode: "direct_miot", region }, undefined, false); return this.auth().beginAuthSession(); }
  interceptMiotCallback(url: string) { return this.auth().tryInterceptCallbackUrl(url); }
  async finishMiotLogin(code: string) {
    const auth = this.auth(); const generation = this.generation;
    await auth.completeAuthWithCode(code);
    if (auth !== this.oauth || generation !== this.generation) throw new Error("连接已切换，请重新登录");
    void this.reconnect();
  }
  cancelMiotLogin() { this.oauth?.cancelAuthSession(); }
  async logoutMiot() { this.invalidate(); await this.auth().logout(); this.lastError = "米家账号已退出"; this.changed(); }
  async voiceKey() { return this.options.credentials.get("doubao-api-key"); }
  async forgetMemory(id: string): Promise<HubMemoryItem[]> {
    const generation = this.generation;
    if (this.preferences.voiceMode === "local") { await this.memories.forget(id); if (generation !== this.generation) throw new Error("记忆来源已切换"); return this.memories.list(); }
    const result = await this.requestHub(`/api/agent/memories/${encodeURIComponent(id)}`, undefined, "DELETE") as { memories: HubMemoryItem[] };
    if (generation !== this.generation) throw new Error("记忆来源已切换");
    return result.memories;
  }
  async correctMemory(id: string, location: string): Promise<HubMemoryItem[]> {
    const generation = this.generation;
    if (this.preferences.voiceMode === "local") { await this.memories.correct(id, location); if (generation !== this.generation) throw new Error("记忆来源已切换"); return this.memories.list(); }
    throw new Error("Hub 记忆请在桌面端按原记录更正位置");
  }

  reconnect(): Promise<void> {
    const task = this.connect();
    this.connecting = task;
    void task.finally(() => { if (this.connecting === task) this.connecting = null; });
    return task;
  }
  private async connect(): Promise<void> {
    this.invalidate();
    const generation = this.generation;
    const { mode, region, haUrl } = this.preferences;
    // This boundary runs after any credential refresh and immediately before native dispatch.
    const guardedFetch: typeof fetch = (input, init) => {
      if (generation !== this.generation) return Promise.reject(new Error("连接已切换"));
      return (this.options.fetch ?? fetch)(input, init);
    };
    try {
      let transport: HaTransportAdapter;
      let definitions: HomeEntityDefinition[];
      if (mode === "hub") { this.lastError = null; this.changed(); return; }
      if (mode === "direct_miot") {
        const auth = this.auth();
        await auth.tokens.getAccessToken();
        const direct = new DirectMiotTransportAdapter({ client: new MiotHttpClient({ region, fetch: guardedFetch, getAccessToken: () => auth.tokens.getAccessToken() }),
          specs: new MiotSpecResolver({ cache: this.options.storage, fetch: guardedFetch }), allowedEntities: ["*"] });
        transport = direct; definitions = await direct.discover();
      } else if (mode === "external_ha") {
        const token = await this.options.credentials.get(`external-ha-token:${haUrl}`);
        if (!token || !haUrl) throw new Error("请填写 Home Assistant 地址与访问令牌");
        const rest = new HomeAssistantRestTransport({ url: haUrl, token, fetch: guardedFetch });
        const states = await rest.listStates();
        const metadata = await (this.options.registry ?? readHomeRegistry)(haUrl, token, "");
        transport = rest; definitions = states.map((state) => externalDefinition(state, metadata.get(state.entity_id)));
      } else {
        const now = new Date().toISOString();
        transport = new InMemoryHaTransportAdapter(Object.fromEntries([
          ["light.study_ceiling", "off", { brightness: 128, color_temp_kelvin: 4000 }], ["light.study_desk", "off", { brightness: 128 }],
          ["switch.desk_fan", "off", {}], ["sensor.study_temperature", "24.5", { unit_of_measurement: "°C" }], ["sensor.study_humidity", "48", { unit_of_measurement: "%" }],
        ].map(([id, state, attributes]) => [id, { entity_id: id, state, attributes, last_changed: now, last_updated: now }])));
        definitions = await new HomeAssistantGateway({ transport }).listEntities();
      }
      if (generation !== this.generation) return;
      this.transport = transport; this.definitions = definitions;
      this.gateway = new HomeAssistantGateway({ transport, initialEntities: definitions }); this.lastError = null; this.changed();
    } catch {
      if (generation === this.generation) { this.lastError = mode === "direct_miot" ? "请登录米家，或检查账号地区与网络" : "连接未就绪，请检查地址、令牌和网络"; this.changed(); }
    }
  }
  async getConnection(): Promise<HomeConnection> {
    await this.initialize();
    const generation = this.generation;
    if (this.connecting) await this.connecting;
    if (generation !== this.generation) throw new Error("连接已切换，请重新刷新");
    if (this.preferences.mode === "hub") {
      const connection = await this.requestHub("/api/home/connection") as HomeConnection;
      if (generation !== this.generation) throw new Error("连接已切换，请重新刷新");
      return connection;
    }
    const gateway = this.gateway;
    if (!gateway || !this.transport) return { configured: false, healthy: false, lastVerifiedAt: null, label: this.modeLabel, entities: [], readOnlyEntities: [] };
    let snapshots: HomeStateSnapshot[] = [];
    try { snapshots = this.transport.listStates ? await this.transport.listStates() : (await gateway.getStates()).map((entity) => entity.snapshot).filter((state): state is HomeStateSnapshot => !!state); }
    catch { /* A failed real read returns unavailable entities, never simulation. */ }
    if (generation !== this.generation) throw new Error("连接已切换，请重新刷新");
    const states = new Map(snapshots.map((state) => [state.entity_id, state]));
    return { configured: true, healthy: this.transport.isHealthy(), lastVerifiedAt: this.transport.getLastVerifiedAt(), label: this.modeLabel,
      deviceCount: new Set(this.definitions.map((entity) => entity.device_id ?? entity.entity_id)).size,
      entities: this.definitions.map((entity) => ({ ...entity, snapshot: states.get(entity.entity_id) ?? null })), readOnlyEntities: [] };
  }
  normalizeServiceData(entityId: string, data: HomeControlCommand["service_data"]): HomeControlCommand["service_data"] {
    return this.transport?.normalizeServiceData?.(entityId, data) as HomeControlCommand["service_data"] ?? data;
  }
  async execute(command: HomeControlCommand): Promise<{ receipt: { status: string; [key: string]: unknown } }> {
    await this.initialize();
    const generation = this.generation;
    if (this.preferences.mode === "hub") {
      const result = await this.requestHub("/api/home/execute", command) as Awaited<ReturnType<LocalControlCenter["execute"]>>;
      if (generation !== this.generation) throw new Error("连接已切换，旧操作结果待核实");
      return result;
    }
    if (!this.gateway) throw new Error("请先连接家居服务");
    const receipt = await this.gateway.executeCommand(command);
    if (generation !== this.generation) throw new Error("连接已切换，旧操作结果待核实");
    return { receipt: { ...receipt } };
  }
  private async requestHub(path: string, body?: unknown, method?: "DELETE"): Promise<unknown> {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), body ? 20_000 : 12_000);
    try {
      const response = await (this.options.fetch ?? fetch)(`${this.options.hubOrigin.replace(/\/$/, "")}${path}`, { method: method ?? (body ? "POST" : "GET"), signal: controller.signal,
        headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      if (!response.ok) throw new Error(); return await response.json();
    } catch { throw new Error("Hub 暂时无法连接"); } finally { clearTimeout(timer); }
  }
  readonly voiceTools = [...HOME_VOICE_TOOLS];
  async executeText(text: string): Promise<string> {
    await this.initialize();
    const input = text.trim().replace(/[。！？!?]+$/, "");
    const revision = this.revision; const generation = this.memories.captureGeneration();
    const remember = input.match(/^(?:请|帮我)?(?:记住|记一下)[，,:：\s]*(.+)$/);
    if (remember) { await this.executeTool("remember_fact", { fact: remember[1] }, generation, revision); return `已保存到本机记忆：${remember[1]}`; }
    const forget = input.match(/^(?:请|帮我)?(?:忘掉|忘记|删除记忆)[，,:：\s]*(.+)$/);
    if (forget) { const result = await this.executeTool("forget_memory", { query: forget[1] }, generation, revision) as { removedCount: number }; return `已从本机记忆删除 ${result.removedCount} 条匹配记录`; }
    const control = input.match(/^(?:请|帮我)?(打开|开启|关闭|关掉)(.+)$/);
    if (control) {
      const connection = await this.getConnection();
      if (revision !== this.revision) throw new Error("连接已切换，请重新操作");
      const query = control[2].trim();
      const candidates = connection.entities.filter((entity) => entity.is_whitelisted && entity.friendly_name.includes(query));
      if (candidates.length !== 1) return candidates.length ? `有多个匹配，请说完整设备名称：${candidates.slice(0, 6).map((entity) => entity.friendly_name).join("、")}` : "没有找到唯一匹配的已连接设备，请先在家居页确认名称";
      const entity = candidates[0];
      const result = await this.execute({ entity_id: entity.entity_id, domain: entity.domain, service: ["打开", "开启"].includes(control[1]) ? "turn_on" : "turn_off", service_data: {} });
      return `${this.preferences.mode === "simulation" ? "离线演示：" : ""}${entity.friendly_name}${result.receipt.status === "verified" ? "已回读确认" : "操作结果待核实"}`;
    }
    const query = input.replace(/^(?:请|帮我)?(?:查询|回忆|查找|找一下)[，,:：\s]*/, "").replace(/(?:放)?在哪里$|在哪$|的位置$/u, "").trim();
    const matches = this.memories.list(query).slice(0, 8);
    if (matches.length) return matches.map((entry) => entry.fact).join("；");
    return "本机没有找到这条记忆。文字支持“记住钥匙在抽屉”“钥匙在哪”“忘记钥匙”和明确设备开关；自由对话请点 LIVE 直接说话。";
  }
  async executeTool(name: string, args: Record<string, unknown>, memoryGeneration: number, expectedRevision: number): Promise<unknown> {
    if (expectedRevision !== this.generation) throw new Error("连接已切换，请重新提出请求");
    if (name === "remember_fact") {
      if (typeof args.fact !== "string") throw new Error("请提供明确的记忆内容");
      return this.memories.remember({ fact: args.fact, subject: typeof args.subject === "string" ? args.subject : undefined, location: typeof args.location === "string" ? args.location : undefined }, memoryGeneration);
    }
    if (name === "recall_memory") return { memories: this.memories.list(typeof args.query === "string" ? args.query : "").slice(0, 20) };
    if (name === "forget_memory") return { removedCount: await this.memories.forget(typeof args.query === "string" ? args.query : "") };
    if (!["list_home_devices", "control_home_device"].includes(name)) throw new Error("本机暂不支持这个工具");
    if (this.preferences.mode === "hub") {
      if (name === "control_home_device") return this.execute({ entity_id: String(args.entity_id ?? ""), domain: String(args.entity_id ?? "").split(".")[0], service: String(args.service ?? ""),
        service_data: { ...(args.brightness === undefined ? {} : { brightness: args.brightness as number }), ...(args.color_temp_kelvin === undefined ? {} : { color_temp_kelvin: args.color_temp_kelvin as number }) } });
      return this.getConnection();
    }
    if (!this.gateway) throw new Error("家居尚未连接");
    const result = await executeHomeVoiceTool(name, args, this.gateway);
    if (expectedRevision !== this.generation) throw new Error("连接已切换，旧结果待核实");
    return { ...result, mode: this.preferences.mode, ...(this.preferences.mode === "simulation" ? { instruction: "这是离线演示结果，明确说明没有控制真实设备。" } : {}) };
  }
}

function externalDefinition(state: HomeStateSnapshot, metadata?: HomeEntityMetadata): HomeEntityDefinition {
  const domain = state.entity_id.split(".")[0]; const name = String(state.attributes.friendly_name ?? state.entity_id);
  const restricted = !metadata?.device_id || !metadata.device_name?.trim() || metadata.control_restricted || /lock|gas|heater|valve|garage|门锁|燃气|煤气|热水器|水阀|车库门|童锁|保护/i.test(`${name} ${state.entity_id}`);
  const power = !restricted && (["light", "fan"].includes(domain) || (domain === "switch" && metadata?.power_control === true));
  const supported = power ? ["turn_on", "turn_off"] : ["read"];
  const ranges: Record<string, [number, number]> = {};
  const modes = state.attributes.supported_color_modes;
  if (power && domain === "light" && Array.isArray(modes) && modes.some((mode) => !["onoff", "unknown"].includes(String(mode)))) { supported.push("brightness"); ranges.brightness = [1, 255]; }
  const min = state.attributes.min_color_temp_kelvin; const max = state.attributes.max_color_temp_kelvin;
  if (power && domain === "light" && Array.isArray(modes) && modes.includes("color_temp") && typeof min === "number" && typeof max === "number" && Math.max(2200, min) <= Math.min(6500, max)) { supported.push("color_temp"); ranges.color_temp_kelvin = [Math.max(2200, min), Math.min(6500, max)]; }
  return { entity_id: state.entity_id, friendly_name: name, device_id: metadata?.device_id, device_name: metadata?.device_name, room: metadata?.room,
    domain, supported_features: supported, allowed_range: ranges, is_whitelisted: true, max_state_age_ms: 15000 };
}
