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
  MiotCameraError,
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
import {
  buildHomeDashboardModel,
  createEmptyLayoutPreferences,
  createRichSimulationCatalog,
  updateApplianceOrder,
  updateApplianceSpan,
  type HomeDashboardModel,
  type HomeLayoutPreferences,
  type HomeSourceId,
  type RawHomeEntityRecord,
  type TileSpan,
} from "@super-looi/home-devices";
import type { NativeCamera } from "./camera.js";

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
  enabledSources?: Partial<Record<HomeSourceId, boolean>>;
}
export type HomeSourceStatus = {
  enabled: boolean;
  configured: boolean;
  healthy: boolean;
  entityCount: number;
  error: string | null;
};
export interface HomeConfiguration {
  mode: HomeMode;
  haUrl: string;
  region: MiotRegion;
  hasToken: boolean;
  hasMiotAccount: boolean;
  enabledSources?: Record<HomeSourceId, boolean>;
  layout?: HomeLayoutPreferences;
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
  sources?: Record<HomeSourceId, HomeSourceStatus>;
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
    enabledSources?: Partial<Record<HomeSourceId, boolean>>;
    layout?: HomeLayoutPreferences;
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
  uiGateway: HomeAssistantGateway;
  directMiot?: DirectMiotTransportAdapter;
  dashboardEntities: Array<
    HomeEntityDefinition & {
      source: HomeSourceId;
      device_model?: string;
      original_name?: string;
    }
  >;
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

function resolveEnabledSources(config: SavedHome["config"]): Record<HomeSourceId, boolean> {
  if (config.enabledSources) {
    return {
      direct_miot: Boolean(config.enabledSources.direct_miot),
      external_ha: Boolean(config.enabledSources.external_ha),
      simulation: Boolean(config.enabledSources.simulation),
    };
  }
  return {
    direct_miot: config.mode === "direct_miot",
    external_ha: config.mode === "external_ha",
    simulation: config.mode === "simulation",
  };
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
  private sourceStatuses: Record<HomeSourceId, HomeSourceStatus> = {
    direct_miot: { enabled: false, configured: false, healthy: false, entityCount: 0, error: null },
    external_ha: { enabled: false, configured: false, healthy: false, entityCount: 0, error: null },
    simulation: { enabled: false, configured: true, healthy: false, entityCount: 0, error: null },
  };
  private controllers = new Set<AbortController>();
  private sockets = new Set<HomeRegistrySocket>();
  private actions = new Set<string>();
  private commandQueue: Promise<unknown> = Promise.resolve();
  private cameraGeneration = 0;
  private cameraSession?: string;
  private camera?: NativeCamera;
  private cameraQueue: Promise<unknown> = Promise.resolve();
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

  private hasMiotCredential(region = this.saved.config.region): boolean {
    const key = `super-looi.miot.${region}.${MIOT_CLIENT_ID}.${encodeURIComponent(`http://homeassistant.local:8123/api/webhook/${this.saved.config.callbackId}`)}`;
    return Boolean(this.saved.credentials[key]);
  }

  configuration(): HomeConfiguration {
    const { mode, haUrl, region, layout } = this.saved.config;
    const enabledSources = resolveEnabledSources(this.saved.config);
    return {
      mode,
      haUrl,
      region,
      hasToken: Boolean(this.saved.credentials[credentialKey(haUrl)]),
      hasMiotAccount: this.hasMiotCredential(region),
      enabledSources,
      layout: layout ?? createEmptyLayoutPreferences(),
    };
  }
  connection(): HomeConnection {
    const { mode, haUrl, region } = this.saved.config,
      owner = this.owner;
    const enabledSources = resolveEnabledSources(this.saved.config);
    const hasHaToken = Boolean(haUrl && this.saved.credentials[credentialKey(haUrl)]);
    const hasMiot = this.hasMiotCredential(region);
    return {
      mode,
      simulation: mode === "simulation" && !enabledSources.direct_miot && !enabledSources.external_ha,
      configured:
        mode === "simulation" ||
        (mode === "external_ha"
          ? hasHaToken
          : Boolean(owner)),
      healthy: Boolean(!this.closed && owner?.transport.isHealthy()),
      connectionId: this.closed ? null : (owner?.id ?? null),
      lastVerifiedAt: owner?.transport.getLastVerifiedAt() ?? null,
      error: this.lastError,
      entityCount: this.entityCount,
      sources: {
        direct_miot: {
          ...this.sourceStatuses.direct_miot,
          enabled: enabledSources.direct_miot,
          configured: hasMiot,
        },
        external_ha: {
          ...this.sourceStatuses.external_ha,
          enabled: enabledSources.external_ha,
          configured: hasHaToken,
        },
        simulation: {
          ...this.sourceStatuses.simulation,
          enabled: enabledSources.simulation,
          configured: true,
        },
      },
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
      if (Object.keys(next.credentials).length > 0) {
        throw new Error("home_credential_store_failed");
      }
    }
    this.saved = next;
  }
  private invalidate() {
    this.camera?.stopAll();
    void this.stopCamera().catch(() => {});
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
    this.sourceStatuses = {
      direct_miot: { enabled: false, configured: false, healthy: false, entityCount: 0, error: null },
      external_ha: { enabled: false, configured: false, healthy: false, entityCount: 0, error: null },
      simulation: { enabled: false, configured: true, healthy: false, entityCount: 0, error: null },
    };
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
    const enabledSources: Partial<Record<HomeSourceId, boolean>> | undefined = input.enabledSources
      ? {
          direct_miot: Boolean(input.enabledSources.direct_miot),
          external_ha: Boolean(input.enabledSources.external_ha),
          simulation: Boolean(input.enabledSources.simulation),
        }
      : undefined;
    next.config = {
      ...next.config,
      mode: input.mode,
      haUrl,
      region: input.region ?? next.config.region,
      ...(enabledSources ? { enabledSources } : { enabledSources: undefined }),
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

  async setSourceEnabled(source: HomeSourceId, enabled: boolean): Promise<HomeConnection> {
    this.assertOpen();
    const currentSources = resolveEnabledSources(this.saved.config);
    const nextSources: Record<HomeSourceId, boolean> = {
      ...currentSources,
      [source]: enabled,
    };
    const nextMode: HomeMode = nextSources.direct_miot
      ? "direct_miot"
      : nextSources.external_ha
        ? "external_ha"
        : nextSources.simulation
          ? "simulation"
          : "disabled";
    const next = copy(this.saved);
    next.config = {
      ...next.config,
      mode: nextMode,
      enabledSources: nextSources,
    };
    this.invalidate();
    this.commit(next);
    if (nextMode === "disabled") {
      return this.connection();
    }
    return this.connect();
  }

  setApplianceLayout(
    applianceId: string,
    patch: { span?: TileSpan; order?: number },
  ): HomeLayoutPreferences {
    this.assertOpen();
    const next = copy(this.saved);
    let layout = next.config.layout ?? createEmptyLayoutPreferences();
    if (patch.span) {
      layout = updateApplianceSpan(layout, applianceId, patch.span);
    }
    if (patch.order !== undefined) {
      layout = updateApplianceOrder(layout, applianceId, patch.order);
    }
    next.config.layout = layout;
    this.commit(next);
    return layout;
  }

  /** Release only the preview consumer; Agent captures keep their own lease. */
  stopCamera(): Promise<void> {
    ++this.cameraGeneration;
    if (this.cameraSession) this.camera?.closePreview(this.cameraSession);
    this.cameraSession = undefined;
    const pending = this.cameraQueue.then(() => undefined, () => undefined);
    this.cameraQueue = pending;
    return pending;
  }

  startCamera(did: string) {
    this.assertOpen();
    const generation = ++this.cameraGeneration;
    const connectionGeneration = this.generation;
    if (this.cameraSession) this.camera?.closePreview(this.cameraSession);
    this.cameraSession = undefined;
    const current = () =>
      !this.closed &&
      generation === this.cameraGeneration &&
      connectionGeneration === this.generation;
    const pending = this.cameraQueue
      .catch(() => {})
      .then(async () => {
        if (!current()) throw new MiotCameraError("cancelled");
        const capability = this.owner?.directMiot
          ?.listCameraCapabilities()
          .find((camera) => camera.did === did);
        if (!capability) throw new MiotCameraError("unsupported");
        if (!this.camera) throw new Error("camera_decoder_unavailable");
        const session = await this.camera.openPreview(did);
        this.cameraSession = session;
        try {
          if (!current()) {
            this.camera.closePreview(session);
            throw new MiotCameraError("cancelled");
          }
          return { sessionId: session, protocol: "native" as const };
        } catch (error) {
          if (this.cameraSession === session) this.cameraSession = undefined;
          throw error;
        }
      });
    this.cameraQueue = pending;
    return pending;
  }

  attachCamera(camera: NativeCamera) { this.camera = camera; }

  async captureCamera(did: string, connectionId: string, signal?: AbortSignal) {
    this.assertOpen();
    const owner = this.owner;
    if (!owner || owner.id !== connectionId || !owner.directMiot?.listCameraCapabilities().some(camera => camera.did === did))
      throw new Error("camera_device_not_in_connection");
    if (signal?.aborted) throw new Error("camera_request_cancelled");
    if (!this.camera) throw new Error("camera_decoder_unavailable");
    const camera=this.camera;
    const requestId=camera.beginCapture(did);
    const cancel=() => camera.cancelCapture(requestId);
    signal?.addEventListener("abort",cancel,{once:true});
    let frame;
    try { frame=await camera.captureDevice(requestId); } finally { signal?.removeEventListener("abort",cancel); }
    if (signal?.aborted || owner !== this.owner) throw new Error("camera_request_cancelled");
    return frame;
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
  private auth(allowMultiSource = false): MiotOAuthClient {
    this.assertOpen();
    const enabled = resolveEnabledSources(this.saved.config);
    if (this.saved.config.mode !== "direct_miot" && !(allowMultiSource && enabled.direct_miot))
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
    const prevSources = resolveEnabledSources(this.saved.config);
    const hasOtherSources = Boolean(this.saved.config.enabledSources && (prevSources.external_ha || prevSources.simulation));
    const configured = this.configure({
      mode: "direct_miot",
      region,
      ...(hasOtherSources ? { enabledSources: { ...prevSources, direct_miot: true } } : {}),
    });
    const generation = this.generation;
    await configured;
    this.assertCurrent(generation);
    return this.auth(true).beginAuthSession();
  }
  interceptMiotCallback(url: string): MiotCallbackResult {
    return this.auth(true).tryInterceptCallbackUrl(url);
  }
  async finishMiotLogin(code: string, isCurrent: () => boolean = () => true): Promise<HomeConnection> {
    const generation = this.generation;
    await this.auth(true).completeAuthWithCode(code, () =>
      !this.closed && generation === this.generation &&
      this.saved.config.mode === "direct_miot" && isCurrent());
    this.assertCurrent(generation);
    return this.connect();
  }
  cancelMiotLogin() {
    this.oauth?.cancelAuthSession();
  }
  async logoutMiot(): Promise<void> {
    const auth = this.auth(true);
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
    const { mode, haUrl, region, enabledSources: rawMulti } = this.saved.config;
    const enabled = resolveEnabledSources(this.saved.config);
    const activeSources = (["direct_miot", "external_ha", "simulation"] as HomeSourceId[]).filter((s) => enabled[s]);

    try {
      if (mode === "disabled" || activeSources.length === 0) {
        this.lastError = "home_disabled";
        return this.connection();
      }

      // Single-source classic path (preserves exact error semantics for existing tests)
      if (!rawMulti && activeSources.length === 1) {
        let transport: HaTransportAdapter;
        let definitions: HomeEntityDefinition[];
        let dashboardEntities: Array<HomeEntityDefinition & { source: HomeSourceId; device_model?: string; original_name?: string }> = [];

        if (mode === "simulation") {
          const now = new Date().toISOString();
          const richCatalog = createRichSimulationCatalog(now);
          // Start study_ceiling off so existing simulation control tests verify off -> on transition
          richCatalog.states["light.study_ceiling"] = {
            entity_id: "light.study_ceiling",
            state: "off",
            attributes: { friendly_name: "演示书房吸顶灯", brightness: 128, color_temp_kelvin: 4000 },
            last_changed: now,
            last_updated: now,
          };
          transport = new InMemoryHaTransportAdapter(richCatalog.states);
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
          dashboardEntities = richCatalog.entities.map((e) => ({ ...e, source: "simulation" as const }));
          this.sourceStatuses.simulation = {
            enabled: true,
            configured: true,
            healthy: true,
            entityCount: dashboardEntities.length,
            error: null,
          };
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
          dashboardEntities = definitions.map((d) => ({ ...d, source: "external_ha" as const }));
          transport = rest;
          this.sourceStatuses.external_ha = {
            enabled: true,
            configured: true,
            healthy: true,
            entityCount: definitions.length,
            error: this.lastError,
          };
        } else {
          const auth = this.auth(true);
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
          dashboardEntities = definitions.map((d) => ({ ...d, source: "direct_miot" as const }));
          transport = direct;
          this.sourceStatuses.direct_miot = {
            enabled: true,
            configured: true,
            healthy: true,
            entityCount: definitions.length,
            error: null,
          };
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
          uiGateway: new HomeAssistantGateway({
            transport: guarded,
            initialEntities: dashboardEntities,
          }),
          dashboardEntities,
          ...(transport instanceof DirectMiotTransportAdapter
            ? { directMiot: transport }
            : {}),
        };
        this.entityCount = definitions.length;
        return this.connection();
      }

      // Multi-source concurrent aggregation path
      const subTransports = new Map<HomeSourceId, HaTransportAdapter>();
      const entityOwnerMap = new Map<string, HomeSourceId>();
      const allDefinitions: HomeEntityDefinition[] = [];
      const allDashboardEntities: Array<HomeEntityDefinition & { source: HomeSourceId; device_model?: string; original_name?: string }> = [];

      const connectSource = async (src: HomeSourceId) => {
        try {
          if (src === "simulation") {
            const now = new Date().toISOString();
            const rich = createRichSimulationCatalog(now);
            const simTransport = new InMemoryHaTransportAdapter(rich.states);
            subTransports.set("simulation", simTransport);
            for (const ent of rich.entities) {
              if (!entityOwnerMap.has(ent.entity_id)) {
                entityOwnerMap.set(ent.entity_id, "simulation");
                allDefinitions.push(ent);
              }
              allDashboardEntities.push({ ...ent, source: "simulation" });
            }
            this.sourceStatuses.simulation = {
              enabled: true,
              configured: true,
              healthy: true,
              entityCount: rich.entities.length,
              error: null,
            };
          } else if (src === "external_ha") {
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
            }
            this.assertCurrent(generation);
            const defs = states.map((state) => defineHaEntity(state, metadata.get(state.entity_id)));
            subTransports.set("external_ha", rest);
            for (const d of defs) {
              entityOwnerMap.set(d.entity_id, "external_ha");
              allDefinitions.push(d);
              allDashboardEntities.push({ ...d, source: "external_ha" });
            }
            this.sourceStatuses.external_ha = {
              enabled: true,
              configured: true,
              healthy: true,
              entityCount: defs.length,
              error: null,
            };
          } else if (src === "direct_miot") {
            const auth = this.auth(true);
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
            const defs = await direct.discover();
            subTransports.set("direct_miot", direct);
            for (const d of defs) {
              entityOwnerMap.set(d.entity_id, "direct_miot");
              allDefinitions.push(d);
              allDashboardEntities.push({ ...d, source: "direct_miot" });
            }
            this.sourceStatuses.direct_miot = {
              enabled: true,
              configured: true,
              healthy: true,
              entityCount: defs.length,
              error: null,
            };
          }
        } catch (err) {
          this.assertCurrent(generation);
          const msg = err instanceof Error ? err.message : "";
          const normErr = ["home_not_configured", "miot_auth_required"].includes(msg)
            ? msg
            : "home_connection_failed";
          this.sourceStatuses[src] = {
            enabled: true,
            configured: src === "simulation",
            healthy: false,
            entityCount: 0,
            error: normErr,
          };
          if (!this.lastError) this.lastError = normErr;
        }
      };

      for (const src of activeSources) {
        await connectSource(src);
      }
      this.assertCurrent(generation);

      if (subTransports.size === 0) {
        if (!this.lastError) this.lastError = "home_connection_failed";
        this.owner = undefined;
        this.entityCount = 0;
        return this.connection();
      }

      const compositeTransport: HaTransportAdapter = {
        fetchState: async (entityId) => {
          const ownerSrc = entityOwnerMap.get(entityId);
          const t = ownerSrc ? subTransports.get(ownerSrc) : subTransports.values().next().value;
          return t ? t.fetchState(entityId) : null;
        },
        callService: async (domain, service, serviceData) => {
          const entityId = String(serviceData.entity_id ?? "");
          const ownerSrc = entityOwnerMap.get(entityId);
          const t = ownerSrc ? subTransports.get(ownerSrc) : subTransports.values().next().value;
          if (!t) return { success: false, error: "No transport for entity" };
          return t.callService(domain, service, serviceData);
        },
        listStates: async () => {
          const out: HomeStateSnapshot[] = [];
          for (const t of subTransports.values()) {
            if (t.listStates) {
              try {
                out.push(...(await t.listStates()));
              } catch {
                /* partial source failure tolerated */
              }
            }
          }
          return out;
        },
        normalizeServiceData: (entityId, data) => {
          const ownerSrc = entityOwnerMap.get(entityId);
          const t = ownerSrc ? subTransports.get(ownerSrc) : undefined;
          return t?.normalizeServiceData ? t.normalizeServiceData(entityId, data) : data;
        },
        isHealthy: () => Array.from(subTransports.values()).some((t) => t.isHealthy()),
        getLastVerifiedAt: () => {
          for (const t of subTransports.values()) {
            const v = t.getLastVerifiedAt();
            if (v) return v;
          }
          return null;
        },
      };

      const guarded = this.guardTransport(compositeTransport, generation);
      this.owner = {
        generation,
        id: `${this.sessionId}:${generation}`,
        transport: guarded,
        gateway: new HomeAssistantGateway({
          transport: guarded,
          initialEntities: allDefinitions,
        }),
        uiGateway: new HomeAssistantGateway({
          transport: guarded,
          initialEntities: allDashboardEntities,
        }),
        dashboardEntities: allDashboardEntities,
        directMiot: subTransports.get("direct_miot") as
          | DirectMiotTransportAdapter
          | undefined,
      };
      this.entityCount = allDashboardEntities.length;
      if (subTransports.size > 0) this.lastError = null;
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

  async dashboard(
    lang: "zh-CN" | "en-US" = "zh-CN",
  ): Promise<HomeDashboardModel> {
    this.assertOpen();
    if (!this.owner && this.saved.config.mode !== "disabled") {
      await (this.connecting ?? this.connect());
    }
    const owner = this.owner;
    if (!owner) {
      return buildHomeDashboardModel([], this.saved.config.layout, lang);
    }
    const states = await owner.uiGateway.getStates();
    this.assertCurrent(owner.generation);
    const snapshotMap = new Map(states.map((s) => [s.entity_id, s.snapshot]));
    const rawRecords: RawHomeEntityRecord[] = owner.dashboardEntities.map((ent) => ({
      ...ent,
      snapshot: snapshotMap.get(ent.entity_id) ?? null,
    }));
    const dashboard = buildHomeDashboardModel(
      rawRecords,
      this.saved.config.layout,
      lang,
    );
    const cameras = owner.directMiot?.listCameraCapabilities() ?? [];
    for (const appliance of dashboard.allAppliances) {
      if (
        appliance.source !== "direct_miot" ||
        !appliance.capabilities.visionStream
      )
        continue;
      const vision = appliance.capabilities.visionStream;
      vision.playbackKind =
        cameras.some((camera) => camera.did === appliance.deviceId) ? "native" : "unsupported";
      const powerState = rawRecords.find(
        (record) => record.entity_id === appliance.capabilities.power?.entityId,
      )?.snapshot?.state;
      if (powerState === "on" || powerState === "off")
        vision.cameraOn = powerState === "on";
      vision.streamActive = false;
      delete vision.resolutionBadge;
      vision.statusText =
        vision.playbackKind === "native"
          ? lang === "en-US"
            ? "Open to view"
            : "打开详情查看画面"
          : lang === "en-US"
            ? "Video not connected"
            : "实时视频暂未接通";
    }
    return dashboard;
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
    const captured = copy(command);
    const matchedDashboardEntity = owner.dashboardEntities.find(
      (e) => e.entity_id === captured.entity_id,
    );
    const simulation =
      this.saved.config.mode === "simulation" ||
      matchedDashboardEntity?.source === "simulation";
    const abort = () => {
      if (owner.generation === this.generation) this.invalidate();
    };
    action.signal?.addEventListener("abort", abort, { once: true });
    const pending = this.commandQueue.then(
      async (): Promise<HomeControlResult> => {
        try {
          if (action.signal?.aborted) throw new Error("home_action_cancelled");
          this.assertCurrent(owner.generation);
          const targetGateway = owner.dashboardEntities.some((e) => e.entity_id === captured.entity_id)
            ? owner.uiGateway
            : owner.gateway;
          const receipt = await targetGateway.executeCommand(captured);
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
