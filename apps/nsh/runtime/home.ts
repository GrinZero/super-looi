import { createHash, randomUUID } from "node:crypto";
import type {
  ActionReceipt,
  HomeControlCommand,
  HomeEntityDefinition,
  HomeStateSnapshot,
  JsonObject,
} from "@super-looi/contracts";
import {
  defineHaEntity,
  DirectMiotTransportAdapter,
  executeHomeVoiceTool,
  HomeAssistantGateway,
  HomeAssistantRestTransport,
  InMemoryHaTransportAdapter,
  MiotHttpClient,
  MIOT_CLIENT_ID,
  MiotOAuthClient,
  MiotSpecResolver,
  readHomeRegistry,
  type CredentialStore,
  type HaTransportAdapter,
  type HomeEntityMetadata,
  type HomeRegistryOptions,
  type HomeRegistrySocket,
  type MiotAuthSession,
  type MiotCallbackResult,
  type MiotCryptoProvider,
  type MiotRegion,
} from "@super-looi/home-assistant";

export type HomeMode =
  | "disabled"
  | "simulation"
  | "external_ha"
  | "direct_miot";
export interface HomeVault {
  get(key: string): string;
  set(key: string, value: string): void;
  remove(key: string): void;
}
export interface HomeSettings {
  mode: HomeMode;
  haUrl?: string;
  haToken?: string;
  region?: MiotRegion;
}
export interface HomeConfiguration {
  mode: HomeMode;
  haUrl: string;
  region: MiotRegion;
  hasToken: boolean;
  hasMiotAccount: boolean;
}
export interface HomeConnection {
  mode: HomeMode;
  simulation: boolean;
  configured: boolean;
  healthy: boolean;
  connectionId: string | null;
  lastVerifiedAt: string | null;
  error: string | null;
  entityCount: number;
}
export interface HomeControlResult {
  receipt: ActionReceipt;
  simulation: boolean;
  connectionId: string;
  instruction: string;
}
export interface HomeAction {
  requestId: string;
  connectionId: string;
  signal?: AbortSignal;
}

interface SavedHome {
  version: 1;
  config: {
    mode: HomeMode;
    haUrl: string;
    region: MiotRegion;
    callbackId: string;
  };
  credentials: Record<string, string>;
}
function validateSaved(saved: SavedHome): void {
  if (
    saved.version !== 1 || !saved.config ||
    !modes.includes(saved.config.mode) || !regions.includes(saved.config.region) ||
    typeof saved.config.haUrl !== "string" ||
    !/^[a-f0-9-]{36}$/i.test(saved.config.callbackId) ||
    !saved.credentials || typeof saved.credentials !== "object" ||
    Array.isArray(saved.credentials) ||
    Object.entries(saved.credentials).some(([key, value]) => !key || typeof value !== "string")
  ) throw new Error("home_configuration_unavailable");
  if (saved.config.haUrl) saved.config.haUrl = httpsAddress(saved.config.haUrl);
}
interface ConnectionOwner {
  generation: number;
  id: string;
  gateway: HomeAssistantGateway;
  transport: HaTransportAdapter;
}
const modes: HomeMode[] = [
  "disabled",
  "simulation",
  "external_ha",
  "direct_miot",
];
const regions: MiotRegion[] = ["cn", "de", "i2", "ru", "sg", "us"];
const defaultCrypto: MiotCryptoProvider = {
  randomUUID,
  async sha1(value) {
    return createHash("sha1").update(value).digest("hex");
  },
};
function httpsAddress(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("home_https_url_required");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.href.length > 2048
  )
    throw new Error("home_https_url_required");
  return url.href.replace(/\/$/, "");
}
function credentialKey(url: string) {
  return `ha:${url}`;
}
function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Foreground-only home owner. Secrets are held in the native encrypted `home`
 * slot, never in NodeCompat files or public state. No commands are retried. */
export class HomeRuntime {
  private saved: SavedHome;
  private generation = 0;
  private closed = false;
  private owner?: ConnectionOwner;
  private connecting?: Promise<HomeConnection>;
  private oauth?: MiotOAuthClient;
  private lastError: string | null = null;
  private controllers = new Set<AbortController>();
  private sockets = new Set<HomeRegistrySocket>();
  private actions = new Set<string>();
  private commandQueue: Promise<unknown> = Promise.resolve();
  private readonly sessionId: string;
  private readonly crypto: MiotCryptoProvider;

  constructor(
    private readonly options: {
      vault: HomeVault;
      fetch?: typeof fetch;
      crypto?: MiotCryptoProvider;
      registry?: (
        url: string,
        token: string,
        integration: string,
        options: HomeRegistryOptions,
      ) => Promise<Map<string, HomeEntityMetadata>>;
      createWebSocket?: (url: string) => HomeRegistrySocket;
    },
  ) {
    this.crypto = options.crypto ?? defaultCrypto;
    this.sessionId = this.crypto.randomUUID();
    try {
      const raw = options.vault.get("home");
      const saved: SavedHome = raw
        ? JSON.parse(raw)
        : {
            version: 1,
            config: {
              mode: "disabled",
              haUrl: "",
              region: "cn",
              callbackId: this.crypto.randomUUID(),
            },
            credentials: {},
          };
      validateSaved(saved);
      this.saved = saved;
    } catch {
      throw new Error("home_configuration_unavailable");
    }
  }

  configuration(): HomeConfiguration {
    const { mode, haUrl, region } = this.saved.config;
    return {
      mode,
      haUrl,
      region,
      hasToken: Boolean(this.saved.credentials[credentialKey(haUrl)]),
      hasMiotAccount: Boolean(this.saved.credentials[`super-looi.miot.${region}.${MIOT_CLIENT_ID}.${encodeURIComponent(`http://homeassistant.local:8123/api/webhook/${this.saved.config.callbackId}`)}`]),
    };
  }
  connection(): HomeConnection {
    const { mode, haUrl } = this.saved.config,
      owner = this.owner;
    return {
      mode,
      simulation: mode === "simulation",
      configured:
        mode === "simulation" ||
        (mode === "external_ha"
          ? Boolean(haUrl && this.saved.credentials[credentialKey(haUrl)])
          : Boolean(owner)),
      healthy: Boolean(!this.closed && owner?.transport.isHealthy()),
      connectionId: this.closed ? null : (owner?.id ?? null),
      lastVerifiedAt: owner?.transport.getLastVerifiedAt() ?? null,
      error: this.lastError,
      entityCount: this.entityCount,
    };
  }
  private entityCount = 0;
  private assertOpen() {
    if (this.closed) throw new Error("home_runtime_closed");
  }
  private assertCurrent(generation: number) {
    this.assertOpen();
    if (generation !== this.generation)
      throw new Error("home_connection_changed");
  }
  /** Every mutation of the encrypted envelope is synchronous: no await can split
   * read/modify/commit and concurrent OAuth/configuration writes cannot lose data. */
  private commit(next: SavedHome) {
    const raw = JSON.stringify(next);
    if (new TextEncoder().encode(raw).byteLength > 32_768)
      throw new Error("home_credential_capacity_exceeded");
    try {
      this.options.vault.set("home", raw);
    } catch {
      throw new Error("home_credential_store_failed");
    }
    this.saved = next;
  }
  private invalidate() {
    ++this.generation;
    this.oauth?.cancelAuthSession();
    this.oauth = undefined;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    for (const socket of this.sockets) {
      try {
        socket.close();
      } catch {
        /* teardown continues */
      }
    }
    this.sockets.clear();
    this.owner = undefined;
    this.connecting = undefined;
    this.entityCount = 0;
    this.actions.clear();
    this.lastError = null;
    // An old queue is allowed to settle as unknown, never to hold new commands.
    this.commandQueue = Promise.resolve();
  }

  async configure(input: HomeSettings): Promise<HomeConfiguration> {
    this.assertOpen();
    if (
      !modes.includes(input.mode) ||
      (input.region !== undefined && !regions.includes(input.region))
    )
      throw new Error("home_invalid_configuration");
    const haUrl =
      input.haUrl !== undefined
        ? input.haUrl.trim()
          ? httpsAddress(input.haUrl.trim())
          : ""
        : this.saved.config.haUrl;
    if (input.mode === "external_ha" && !haUrl)
      throw new Error("home_https_url_required");
    if (
      input.haToken !== undefined &&
      (typeof input.haToken !== "string" ||
        input.haToken.length > 8192 ||
        /[\r\n]/.test(input.haToken))
    )
      throw new Error("home_invalid_token");
    const next = copy(this.saved);
    next.config = {
      ...next.config,
      mode: input.mode,
      haUrl,
      region: input.region ?? next.config.region,
    };
    if (input.haToken !== undefined) {
      if (!haUrl) throw new Error("home_https_url_required");
      if (input.haToken.trim())
        next.credentials[credentialKey(haUrl)] = input.haToken.trim();
      else delete next.credentials[credentialKey(haUrl)];
    }
    // Stop old work before persistence, including on a failing credential write.
    this.invalidate();
    this.commit(next);
    return this.configuration();
  }

  private network(generation: number): typeof fetch {
    return async (input, init) => {
      this.assertCurrent(generation);
      const controller = new AbortController(),
        upstream = init?.signal;
      const release = () => {
        this.controllers.delete(controller);
        upstream?.removeEventListener("abort", abort);
      };
      const abort = () => {
        controller.abort();
        release();
      };
      if (upstream?.aborted) abort();
      else upstream?.addEventListener("abort", abort, { once: true });
      this.controllers.add(controller);
      try {
        const response = await (this.options.fetch ?? fetch)(input, {
          ...init,
          signal: controller.signal,
        });
        this.assertCurrent(generation);
        if (!response.ok) {
          release();
          return response;
        }
        // Keep the abort relay until the body has settled. Dropping it at the
        // headers would disable both configuration cancellation and HA's timeout.
        return new Proxy(response, {
          get: (target, key) => {
            if (key === "json")
              return async () => {
                try {
                  this.assertCurrent(generation);
                  const value = await target.json();
                  this.assertCurrent(generation);
                  return value;
                } finally {
                  release();
                }
              };
            const value = Reflect.get(target, key, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      } catch (error) {
        release();
        throw error;
      }
    };
  }
  private credentialStore(generation: number): CredentialStore {
    return {
      get: async (key) => {
        this.assertCurrent(generation);
        return this.saved.credentials[key] ?? null;
      },
      set: async (key, value) => {
        this.assertCurrent(generation);
        const next = copy(this.saved);
        next.credentials[key] = value;
        this.commit(next);
      },
      delete: async (key) => {
        this.assertCurrent(generation);
        const next = copy(this.saved);
        delete next.credentials[key];
        this.commit(next);
      },
      restoreIfUnchanged: async (key, attempted, previous) => {
        // Cancellation invalidates normal writes; rollback is a narrow CAS over
        // the current envelope and never restores an old configuration snapshot.
        let current: SavedHome;
        try {
          const raw = this.options.vault.get("home");
          if (!raw) return false;
          current = JSON.parse(raw);
          validateSaved(current);
        } catch { throw new Error("home_credential_store_failed"); }
        this.saved = current;
        if (current.credentials[key] !== attempted) return false;
        const next = copy(current);
        if (previous === null) delete next.credentials[key];
        else next.credentials[key] = previous;
        this.commit(next);
        return true;
      },
    };
  }
  private auth(): MiotOAuthClient {
    this.assertOpen();
    if (this.saved.config.mode !== "direct_miot")
      throw new Error("miot_mode_required");
    return (this.oauth ??= new MiotOAuthClient({
      region: this.saved.config.region,
      redirectUri: `http://homeassistant.local:8123/api/webhook/${this.saved.config.callbackId}`,
      store: this.credentialStore(this.generation),
      crypto: this.crypto,
      fetch: this.network(this.generation),
    }));
  }
  async beginMiotLogin(
    region: MiotRegion = this.saved.config.region,
  ): Promise<MiotAuthSession> {
    const configured = this.configure({ mode: "direct_miot", region });
    const generation = this.generation;
    await configured;
    this.assertCurrent(generation);
    return this.auth().beginAuthSession();
  }
  interceptMiotCallback(url: string): MiotCallbackResult {
    return this.auth().tryInterceptCallbackUrl(url);
  }
  async finishMiotLogin(code: string, isCurrent: () => boolean = () => true): Promise<HomeConnection> {
    const generation = this.generation;
    await this.auth().completeAuthWithCode(code, () =>
      !this.closed && generation === this.generation &&
      this.saved.config.mode === "direct_miot" && isCurrent());
    this.assertCurrent(generation);
    return this.connect();
  }
  cancelMiotLogin() {
    this.oauth?.cancelAuthSession();
  }
  async logoutMiot(): Promise<void> {
    const auth = this.auth();
    const generation = this.generation;
    await auth.logout();
    this.assertCurrent(generation);
    this.invalidate();
  }

  private registrySocket(url: string, generation: number): HomeRegistrySocket {
    this.assertCurrent(generation);
    const socket = (
      this.options.createWebSocket ?? ((address) => new WebSocket(address))
    )(url);
    this.sockets.add(socket);
    return {
      send: (data) => {
        this.assertCurrent(generation);
        socket.send(data);
      },
      close: () => {
        this.sockets.delete(socket);
        socket.close();
      },
      addEventListener: socket.addEventListener.bind(socket),
      removeEventListener: socket.removeEventListener.bind(socket),
    } as HomeRegistrySocket;
  }
  private guardTransport(
    transport: HaTransportAdapter,
    generation: number,
  ): HaTransportAdapter {
    const run = async <T>(operation: () => Promise<T>): Promise<T> => {
      this.assertCurrent(generation);
      const result = await operation();
      this.assertCurrent(generation);
      return result;
    };
    return {
      fetchState: (id) => run(() => transport.fetchState(id)),
      callService: (domain, service, data) =>
        run(() => transport.callService(domain, service, data)),
      ...(transport.listStates
        ? { listStates: () => run(() => transport.listStates!()) }
        : {}),
      ...(transport.normalizeServiceData
        ? {
            normalizeServiceData: (
              id: string,
              data: Record<string, unknown>,
            ) => {
              this.assertCurrent(generation);
              return transport.normalizeServiceData!(id, data);
            },
          }
        : {}),
      isHealthy: () =>
        generation === this.generation && !this.closed && transport.isHealthy(),
      getLastVerifiedAt: () => transport.getLastVerifiedAt(),
    };
  }
  /** A fresh connection has a new opaque identity; callers cannot replay an old
   * task's command against a different account, reconnect or app session. */
  connect(): Promise<HomeConnection> {
    this.assertOpen();
    if (this.connecting) return this.connecting;
    this.invalidate();
    const generation = this.generation;
    const promise = this.openConnection(generation);
    this.connecting = promise;
    void promise.then(
      () => {
        if (this.connecting === promise) this.connecting = undefined;
      },
      () => {
        if (this.connecting === promise) this.connecting = undefined;
      },
    );
    return promise;
  }
  private async openConnection(generation: number): Promise<HomeConnection> {
    const { mode, haUrl, region } = this.saved.config;
    try {
      let transport: HaTransportAdapter, definitions: HomeEntityDefinition[];
      if (mode === "disabled") {
        this.lastError = "home_disabled";
        return this.connection();
      }
      if (mode === "simulation") {
        const now = new Date().toISOString();
        transport = new InMemoryHaTransportAdapter({
          "light.study_ceiling": {
            entity_id: "light.study_ceiling",
            state: "off",
            attributes: { brightness: 128, color_temp_kelvin: 4000 },
            last_changed: now,
            last_updated: now,
          },
        });
        definitions = [
          {
            entity_id: "light.study_ceiling",
            friendly_name: "演示书房吸顶灯",
            domain: "light",
            room: "演示书房",
            supported_features: [
              "turn_on",
              "turn_off",
              "brightness",
              "color_temp",
            ],
            allowed_range: {
              brightness: [1, 255],
              color_temp_kelvin: [2200, 6500],
            },
            is_whitelisted: true,
            max_state_age_ms: 15000,
          },
        ];
      } else if (mode === "external_ha") {
        const token = this.saved.credentials[credentialKey(haUrl)];
        if (!haUrl || !token) throw new Error("home_not_configured");
        const rest = new HomeAssistantRestTransport({
          url: haUrl,
          token,
          fetch: this.network(generation),
        });
        const states = await rest.listStates();
        this.assertCurrent(generation);
        let metadata = new Map<string, HomeEntityMetadata>();
        try {
          metadata = await (this.options.registry ?? readHomeRegistry)(
            haUrl,
            token,
            "",
            { createWebSocket: (url) => this.registrySocket(url, generation) },
          );
        } catch {
          this.assertCurrent(generation);
          this.lastError = "ha_registry_unavailable";
        }
        this.assertCurrent(generation);
        definitions = states.map((state) =>
          defineHaEntity(state, metadata.get(state.entity_id)),
        );
        transport = rest;
      } else {
        const auth = this.auth();
        await auth.tokens.getAccessToken();
        this.assertCurrent(generation);
        const direct = new DirectMiotTransportAdapter({
          client: new MiotHttpClient({
            region,
            fetch: this.network(generation),
            getAccessToken: () => auth.tokens.getAccessToken(),
          }),
          specs: new MiotSpecResolver({ fetch: this.network(generation) }),
          allowedEntities: ["*"],
        });
        definitions = await direct.discover();
        transport = direct;
      }
      this.assertCurrent(generation);
      const guarded = this.guardTransport(transport, generation);
      this.owner = {
        generation,
        id: `${this.sessionId}:${generation}`,
        transport: guarded,
        gateway: new HomeAssistantGateway({
          transport: guarded,
          initialEntities: definitions,
        }),
      };
      this.entityCount = definitions.length;
      return this.connection();
    } catch (error) {
      this.assertCurrent(generation);
      const message = error instanceof Error ? error.message : "";
      this.lastError = ["home_not_configured", "miot_auth_required"].includes(
        message,
      )
        ? message
        : "home_connection_failed";
      this.owner = undefined;
      this.entityCount = 0;
      return this.connection();
    }
  }

  async list(query = "", offset = 0): Promise<JsonObject> {
    this.assertOpen();
    if (!this.owner) await (this.connecting ?? this.connect());
    const owner = this.owner;
    if (!owner)
      return {
        devices: [],
        total: 0,
        next_offset: null,
        ...this.connection(),
        instruction: "家居未连接，不能声称读取或控制了真实设备。",
      };
    const result = await executeHomeVoiceTool(
      "list_home_devices",
      { query, offset },
      owner.gateway,
    );
    this.assertCurrent(owner.generation);
    return {
      ...result,
      simulation: this.saved.config.mode === "simulation",
      connectionId: owner.id,
      instruction:
        this.saved.config.mode === "simulation"
          ? "离线演示数据，未读取或控制真实设备。"
          : result.instruction,
    };
  }
  /** requestId is an authenticated UI event/tool-call identity, not model text.
   * Consume it before queueing. Failures and unknown outcomes are never replayed. */
  control(
    command: HomeControlCommand,
    action: HomeAction,
  ): Promise<HomeControlResult> {
    this.assertOpen();
    if (action.signal?.aborted)
      return Promise.reject(new Error("home_action_cancelled"));
    const owner = this.owner;
    if (!owner || action.connectionId !== owner.id)
      return Promise.reject(new Error("home_connection_changed"));
    if (!/^[a-zA-Z0-9_.:-]{1,160}$/.test(action.requestId))
      return Promise.reject(new Error("home_invalid_request_id"));
    if (this.actions.has(action.requestId))
      return Promise.reject(new Error("home_action_already_consumed"));
    if (this.actions.size >= 256)
      return Promise.reject(new Error("home_action_capacity_exceeded"));
    this.actions.add(action.requestId);
    const requestId = action.requestId;
    const simulation = this.saved.config.mode === "simulation";
    const captured = copy(command);
    const abort = () => {
      if (owner.generation === this.generation) this.invalidate();
    };
    action.signal?.addEventListener("abort", abort, { once: true });
    const pending = this.commandQueue.then(
      async (): Promise<HomeControlResult> => {
        try {
          if (action.signal?.aborted) throw new Error("home_action_cancelled");
          this.assertCurrent(owner.generation);
          const receipt = await owner.gateway.executeCommand(captured);
          this.assertCurrent(owner.generation);
          return {
            receipt,
            simulation,
            connectionId: owner.id,
            instruction: simulation
              ? "仅离线演示，未控制真实设备。"
              : receipt.status === "verified"
                ? "设备状态已回读确认。"
                : "执行尚未确认成功，如实说明回执，不能声称已经完成。",
          };
        } catch {
          return {
            simulation,
            connectionId: owner.id,
            receipt: {
              schema_version: "0.2",
              receipt_id: `home_${randomUUID()}`,
              action_id: requestId,
              task_id: null,
              receipt_seq: 1,
              executor_id: "nsh_home_runtime",
              recorded_at: new Date().toISOString(),
              status: "unknown",
              reason_code:
                this.closed || owner.generation !== this.generation
                  ? "connection_changed_requires_verification"
                  : "home_execution_requires_verification",
              readbacks: [],
            },
            instruction:
              "操作结果未知，需要核实真实设备；不得自动重试或声称已完成。",
          };
        } finally {
          action.signal?.removeEventListener("abort", abort);
        }
      },
    );
    this.commandQueue = pending.catch(() => {});
    return pending;
  }
  suspend(): void {
    if (!this.closed) this.invalidate();
  }
  close(): void {
    if (!this.closed) {
      this.closed = true;
      this.invalidate();
    }
  }
}
