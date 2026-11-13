import { uiMessage } from "./messages.js";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { UserActionRef } from "@super-looi/contracts";
import { PiAgentExecutor } from "@super-looi/runtime/agent/pi-executor";
import type {
  AgentTask,
  AgentStepEvent,
  AgentInteractionAnswer,
} from "@super-looi/runtime/agent/executor";
import { SqliteRuntimeStore } from "@super-looi/runtime/storage/sqlite";
import { assertFreshUiAction } from "@super-looi/runtime/productivity/authorization";
import { AgentTaskStore } from "@super-looi/runtime/agent/task-store";
import {
  LLM_PROVIDER_CATALOG,
  VaultCredentialStore,
  createLooiModelsRegistry,
  syncLooiModelsRegistry,
  resolveProviderBaseUrl,
  type ActiveLlmSelection,
  type CompatibleApiProtocol,
  type CustomEndpointConfig,
  type LlmBrandId,
  type LlmChannelSpec,
  type ModelVaultEnvelope,
} from "@super-looi/runtime/agent/llm-providers";

import type { NativeCamera } from "./camera.js";
import { HomeRuntime, type HomeSettings } from "./home.js";
import { createHomeCache } from "./home-cache.js";
import {
  BodyRuntime,
  type BodyActionReceipt,
  type BodyConfiguration,
  type BodyConnectionMode,
  type BodyControlAction,
  type BodyControlInput,
  type BodyStatusSnapshot,
  type NativeBlePort,
} from "./body.js";
import { chooseConnectedModelId, fetchOnlineModels, type OnlineModel } from "./model-list.js";
import { createBodyTools, createHomeTools } from "./tools/index.js";
import { deviceControlInstructions } from "./device-control-instructions.js";
import { createLangfuseTracer } from "../../../packages/looi-runtime/src/telemetry/langfuse.js";
import type { TraceContext } from "../../../packages/looi-runtime/src/telemetry/langfuse.js";
import { VoiceConversationWindow } from "./voice/conversation-window.js";
import { PluginHost } from "./plugins/host.js";
import { codexDefinition } from "./plugins/codex/index.js";
import type { PluginEvent } from "./plugins/contracts.js";

type MutableModels = ReturnType<typeof createLooiModelsRegistry>;
type Credential = ModelVaultEnvelope["credentials"][string];

export interface ModelConfiguration {
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface Vault {
  get(key: string): string;
  set(key: string, value: string): void;
  remove(key: string): void;
}

export type {
  LlmBrandId,
  CompatibleApiProtocol,
  CustomEndpointConfig,
  ActiveLlmSelection,
  ModelVaultEnvelope,
  BodyConfiguration,
  BodyConnectionMode,
  BodyControlAction,
  BodyControlInput,
  BodyStatusSnapshot,
  BodyActionReceipt,
  NativeBlePort,
};

export interface LlmModelItem {
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  isCustom: boolean;
}

export interface LlmChannelStatus {
  providerId: string;
  label: string;
  baseUrl: string;
  protocolLabel: string;
  authTypes: Array<"api_key" | "oauth">;
  defaultModelId: string;
  hasApiKey: boolean;
  hasOAuth: boolean;
  oauthExpiresAt: number | null;
  models: LlmModelItem[];
  modelsFetched?: boolean;
  modelsError?: string;
}

export interface LlmBrandStatus {
  brandId: LlmBrandId;
  label: string;
  shortLabel: string;
  configured: boolean;
  channels: LlmChannelStatus[];
}

export interface LlmCatalogSnapshot {
  brands: LlmBrandStatus[];
  active: {
    brandId: LlmBrandId;
    providerId: string;
    modelId: string;
    authType: "api_key" | "oauth";
  } | null;
  custom: CustomEndpointConfig;
}

export type LlmOAuthUiEvent =
  | {
      kind: "device_code";
      userCode: string;
      verificationUri: string;
      expiresInSeconds?: number;
    }
  | { kind: "auth_url"; url: string; instructions?: string }
  | { kind: "awaiting_callback"; message: string; placeholder: string }
  | { kind: "progress"; message: string };

/** One foreground app owns the database and executor. No Hub endpoint exists. */
export class MobileRuntime {
  private readonly voiceConversation = new VoiceConversationWindow();
  private readonly traceListeners = new Set<() => void>();
  private readonly database = new DatabaseSync("/home/looi.sqlite");
  private readonly storage = new SqliteRuntimeStore(this.database);
  readonly tracer = createLangfuseTracer({
    baseUrl: process.env.LANGFUSE_BASE_URL,
    publicKey: process.env.LANGFUSE_PUBLIC_KEY,
    secretKey: process.env.LANGFUSE_SECRET_KEY,
    onObservation: (observation) => {
      this.storage.saveObservation(observation);
      for (const listener of this.traceListeners) listener();
    },
  });
  private readonly home: HomeRuntime;
  private readonly body: BodyRuntime;
  private readonly plugins: PluginHost;
  private readonly credentialStore: VaultCredentialStore;
  private readonly modelsRegistry: MutableModels;
  private readonly fetchedModels = new Map<string, OnlineModel[]>();
  private readonly modelFetchErrors = new Map<string, string>();
  private readonly modelFetchVersions = new Map<string, number>();
  private executor?: PiAgentExecutor;
  private conversationId = `session_${randomUUID()}`;
  private conversationPersisted = false;
  private taskId?: string;
  private closed = false;
  private busy = false;
  private loginPending = false;
  private loginAttempt = 0;
  private closing?: Promise<void>;
  private llmOAuthAbort?: AbortController;
  private llmOAuthManualPrompt?: {
    resolve: (value: string) => void;
    reject: (error: Error) => void;
    providerId: string;
    authorizationUrl: string;
  };
  readonly uiSessionId = `ui_${randomUUID()}`;

  constructor(
    private readonly vault: Vault,
    private readonly releaseHost: () => void,
  ) {
    try {
      new AgentTaskStore("/home/agent/tasks", this.storage.tasks);
      this.database.exec(
        "CREATE TABLE IF NOT EXISTS home_action_evidence (request_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, evidence TEXT NOT NULL)",
      );
      this.database.exec(
        "CREATE TABLE IF NOT EXISTS body_action_evidence (request_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, evidence TEXT NOT NULL)",
      );
      this.home = new HomeRuntime({ vault, cache: createHomeCache(this.database) });
      this.body = new BodyRuntime({ vault });
      this.plugins = new PluginHost(this.database, [codexDefinition({
        tracer: this.tracer,
        traceContext: () => {
          const trace = this.taskId ? this.executor?.getTask(this.taskId)?.trace : undefined;
          return trace ? { traceId: trace.traceId, parentSpanId: trace.spanId, traceName: "codex" } : undefined;
        },
      })]);
      this.credentialStore = new VaultCredentialStore(vault, {
        conversationId: () => this.conversationId,
      });
      this.modelsRegistry = createLooiModelsRegistry(this.credentialStore);

      const raw = vault.get("model");
      if (raw) {
        const stored = JSON.parse(raw);
        const envelope = this.credentialStore.readEnvelope();
        if (
          typeof stored?.conversationId === "string" &&
          /^[a-zA-Z0-9_-]{1,100}$/.test(stored.conversationId)
        ) {
          this.conversationId = stored.conversationId;
          this.conversationPersisted = true;
        }
        if (
          envelope.active &&
          envelope.credentials[envelope.active.providerId]
        ) {
          let customValid = true;
          if (envelope.active.providerId === "custom") {
            customValid = this.isValidCustomEndpoint(envelope.custom);
          }
          if (customValid) {
            syncLooiModelsRegistry(this.modelsRegistry, envelope);
            this.executor = this.createExecutorForSelection(envelope.active);
          }
        }
      }
    } catch (error) {
      this.storage.close();
      throw error;
    }
  }

  homeConfiguration() {
    return this.home.configuration();
  }

  pluginsSnapshot() { return this.plugins.snapshots(); }
  subscribePlugins(listener: (event: PluginEvent) => void) { return this.plugins.subscribe(listener); }
  async refreshPlugin(id: string) { await this.plugins.get(id).auth?.refresh(); return this.pluginsSnapshot(); }
  private assertPluginAction(action: UserActionRef) {
    if (this.closed) throw new Error("Runtime is closed");
    assertFreshUiAction(action);
    if (action.ui_session_id !== this.uiSessionId) throw new Error("@looi:runtimeThisPageExpiredOpenItAgain");
  }
  async configurePlugin(id: string, enabled: boolean, values: Record<string, string>, action: UserActionRef) { this.assertPluginAction(action); return this.plugins.configure(id, enabled, values); }
  async beginPluginLogin(id: string, action: UserActionRef) { this.assertPluginAction(action); const auth = this.plugins.get(id).auth; if (!auth) throw new Error(`Plugin has no login: ${id}`); return auth.begin(); }
  async cancelPluginLogin(id: string) { await this.plugins.get(id).auth?.cancel(); }
  async logoutPlugin(id: string, action: UserActionRef) { this.assertPluginAction(action); await this.plugins.get(id).auth?.logout(); }

  homeConnection() {
    return this.home.connection();
  }

  async configureHome(input: HomeSettings, action: UserActionRef) {
    if (
      this.closed ||
      this.busy ||
      this.loginPending ||
      Boolean(this.llmOAuthAbort)
    )
      throw new Error("@looi:runtimeStopTheCurrentTaskOrCancelSigninFirst");
    assertFreshUiAction(action);
    if (action.ui_session_id !== this.uiSessionId)
      throw new Error("@looi:runtimeThisPageExpiredOpenItAgain");
    const result = await this.home.configure(input);
    const envelope = this.credentialStore.readEnvelope();
    if (
      envelope.active &&
      envelope.credentials[envelope.active.providerId] &&
      !this.closed
    ) {
      await this.executor?.close();
      this.executor = this.createExecutorForSelection(envelope.active);
    }
    return result;
  }

  async connectHome() {
    if (this.loginPending) throw new Error("@looi:runtimeFinishOrCancelXiaomiSigninFirst");
    return this.home.connect();
  }

  async beginMiotLogin(
    region: NonNullable<HomeSettings["region"]>,
    action: UserActionRef,
  ) {
    if (
      this.closed ||
      this.busy ||
      this.loginPending ||
      Boolean(this.llmOAuthAbort)
    )
      throw new Error("@looi:runtimeStopTheCurrentTaskOrCancelSigninFirst");
    assertFreshUiAction(action);
    if (action.ui_session_id !== this.uiSessionId)
      throw new Error("@looi:runtimeThisPageExpiredOpenItAgain");
    const attempt = ++this.loginAttempt;
    this.loginPending = true;
    try {
      const session = await this.home.beginMiotLogin(region);
      if (attempt !== this.loginAttempt || this.closed)
        throw new Error("@looi:runtimeXiaomiSigninCancelled");
      return { ...session, attempt };
    } catch (error) {
      if (attempt === this.loginAttempt) this.cancelMiotLogin();
      throw error;
    }
  }

  async finishMiotLogin(
    attempt: number,
    callback: string,
    isCurrent: () => boolean,
  ) {
    if (!this.loginPending || attempt !== this.loginAttempt || this.closed)
      throw new Error("@looi:runtimeXiaomiSigninCancelled");
    try {
      const result = this.home.interceptMiotCallback(callback);
      if (!result.intercepted || "error" in result)
        throw new Error("@looi:runtimeXiaomiCallbackIsInvalidOrExpired");
      return await this.home.finishMiotLogin(
        result.code,
        () =>
          this.loginPending &&
          attempt === this.loginAttempt &&
          !this.closed &&
          isCurrent(),
      );
    } catch (error) {
      if (attempt === this.loginAttempt) this.cancelMiotLogin();
      throw error;
    } finally {
      if (attempt === this.loginAttempt) this.loginPending = false;
    }
  }

  cancelMiotLogin() {
    ++this.loginAttempt;
    if (!this.loginPending) return;
    this.loginPending = false;
    // Invalidate the pending OAuth exchange and abort its native network request.
    this.home.suspend();
  }

  async logoutMiot(action: UserActionRef) {
    if (
      this.closed ||
      this.busy ||
      this.loginPending ||
      Boolean(this.llmOAuthAbort)
    )
      throw new Error("@looi:runtimeStopTheCurrentTaskOrCancelSigninFirst");
    assertFreshUiAction(action);
    if (action.ui_session_id !== this.uiSessionId)
      throw new Error("@looi:runtimeThisPageExpiredOpenItAgain");
    await this.home.logoutMiot();
  }

  async listHome(query = "", offset = 0) {
    if (this.loginPending) throw new Error("@looi:runtimeFinishOrCancelXiaomiSigninFirst");
    return this.home.list(query, offset);
  }

  async homeDashboard(lang: "zh-CN" | "en-US" = "zh-CN") {
    if (this.loginPending) throw new Error("@looi:runtimeFinishOrCancelXiaomiSigninFirst");
    return this.home.dashboard(lang);
  }

  cachedHomeDashboard(lang: "zh-CN" | "en-US" = "zh-CN") {
    return this.home.cachedDashboard(lang);
  }

  async setHomeSourceEnabled(
    source: "direct_miot" | "external_ha" | "simulation",
    enabled: boolean,
    action: UserActionRef,
  ) {
    if (
      this.closed ||
      this.busy ||
      this.loginPending ||
      Boolean(this.llmOAuthAbort)
    )
      throw new Error("@looi:runtimeStopTheCurrentTaskOrCancelSigninFirst");
    assertFreshUiAction(action);
    if (action.ui_session_id !== this.uiSessionId)
      throw new Error("@looi:runtimeThisPageExpiredOpenItAgain");
    return this.home.setSourceEnabled(source, enabled);
  }

  setHomeApplianceLayout(
    applianceId: string,
    patch: { span?: "1x1" | "2x1" | "2x2"; order?: number },
  ) {
    if (this.closed) throw new Error("@looi:runtimeLocalRuntimeIsNotReady");
    return this.home.setApplianceLayout(applianceId, patch);
  }

  startHomeCamera(did: string) {
    return this.home.startCamera(did);
  }
  attachNativeCamera(camera: NativeCamera) { this.home.attachCamera(camera); }
  stopHomeCamera() {
    return this.home.stopCamera();
  }
  async panTiltHomeCamera(
    did: string,
    direction: "left" | "right" | "up" | "down",
    action: UserActionRef,
  ) {
    if (this.closed || this.loginPending)
      throw new Error("@looi:runtimeFinishOrCancelXiaomiSigninFirst");
    assertFreshUiAction(action);
    if (action.ui_session_id !== this.uiSessionId)
      throw new Error("@looi:runtimeThisPageExpiredOpenItAgain");
    return this.home.panTiltCamera(did, direction);
  }

  async controlHomeAppliance(
    command: {
      entity_id: string;
      domain: string;
      service: string;
      service_data?: Record<string, unknown>;
      timeout_ms?: number;
    },
    action: UserActionRef,
  ) {
    if (this.closed || this.loginPending)
      throw new Error("@looi:runtimeFinishOrCancelXiaomiSigninFirst");
    assertFreshUiAction(action);
    if (action.ui_session_id !== this.uiSessionId)
      throw new Error("@looi:runtimeThisPageExpiredOpenItAgain");
    let conn = this.home.connection();
    if (!conn.connectionId && this.home.configuration().mode !== "disabled") {
      conn = await this.home.connect();
    }
    if (!conn.connectionId) {
      throw new Error("home_not_configured");
    }
    return this.home.control(
      {
        entity_id: command.entity_id,
        domain: command.domain,
        service: command.service,
        service_data: (command.service_data ?? {}) as Record<string, string | number | boolean | null>,
        timeout_ms: command.timeout_ms ?? 1500,
      },
      {
        connectionId: conn.connectionId,
        requestId: action.event_id,
      },
    );
  }

  bodyConfiguration(): BodyConfiguration {
    return this.body.configuration();
  }

  bodyStatus(): BodyStatusSnapshot {
    return this.body.status();
  }

  attachNativeBle(port: NativeBlePort | null): BodyStatusSnapshot {
    return this.body.attachNativeBle(port);
  }

  setBodyForegroundActive(active: boolean): BodyStatusSnapshot {
    return this.body.setForegroundActive(active);
  }

  async configureBody(
    input: Partial<BodyConfiguration>,
    action: UserActionRef,
  ): Promise<BodyStatusSnapshot> {
    if (
      this.closed ||
      this.busy ||
      this.loginPending ||
      Boolean(this.llmOAuthAbort)
    )
      throw new Error("@looi:runtimeStopTheCurrentTaskOrCancelSigninFirst");
    assertFreshUiAction(action);
    if (action.ui_session_id !== this.uiSessionId)
      throw new Error("@looi:runtimeThisPageExpiredOpenItAgain");
    const prevMode = this.body.configuration().mode;
    const result = await this.body.configure(input);
    const nextMode = this.body.configuration().mode;
    if (prevMode !== nextMode) {
      const envelope = this.credentialStore.readEnvelope();
      if (
        envelope.active &&
        envelope.credentials[envelope.active.providerId] &&
        !this.closed
      ) {
        await this.executor?.close();
        this.executor = this.createExecutorForSelection(envelope.active);
      }
    }
    return result;
  }

  async scanBodyDevices(timeoutMs?: number): Promise<BodyStatusSnapshot> {
    return this.body.scan(timeoutMs);
  }

  async connectBodyDevice(target?: {
    deviceId?: string;
    deviceName?: string;
  }): Promise<BodyStatusSnapshot> {
    return this.body.connect(target);
  }

  async disconnectBody(): Promise<BodyStatusSnapshot> {
    return this.body.disconnect();
  }

  async forgetSavedDock(): Promise<BodyStatusSnapshot> {
    return this.body.forgetSavedDock();
  }

  setSimulatedDock(docked: boolean): BodyStatusSnapshot {
    return this.body.setSimulatedDock(docked);
  }

  async controlBody(
    input: BodyControlInput,
    holder = "user_panel",
  ): Promise<BodyActionReceipt> {
    return this.body.control(input, holder);
  }

  async stopBody(): Promise<BodyStatusSnapshot> {
    return this.body.stop("user_stop");
  }

  async startBodyDrive(action: "forward" | "backward" | "turn_left" | "turn_right"): Promise<BodyStatusSnapshot> {
    return this.body.startDrive(action);
  }

  renewBodyDrive(): boolean {
    return this.body.renewDrive();
  }

  async setBodyDriveVector(speed: number, turn: number): Promise<BodyStatusSnapshot> {
    return this.body.setDriveVector(speed, turn);
  }

  async readBodyPower(): Promise<BodyStatusSnapshot> {
    return this.body.readPowerStatus();
  }

  configuration(): { baseUrl: string; model: string; hasKey: boolean } {
    const envelope = this.credentialStore.readEnvelope();
    if (envelope.active) {
      const providerId = envelope.active.providerId;
      const baseUrl =
        providerId === "custom"
          ? (envelope.custom?.baseUrl ?? "")
          : (resolveProviderBaseUrl(providerId) ??
            envelope.custom?.baseUrl ??
            "");
      return {
        baseUrl,
        model: envelope.active.modelId ?? "",
        hasKey: Boolean(envelope.credentials[providerId]),
      };
    }
    return {
      baseUrl: envelope.custom?.baseUrl ?? "",
      model: envelope.custom?.modelId ?? "",
      hasKey: Boolean(envelope.credentials["custom"]),
    };
  }

  private allTasks(): AgentTask[] {
    if (this.closed) throw new Error("@looi:runtimeRuntimeClosed");
    return this.executor?.listTasks() ?? this.storage.tasks.load();
  }

  taskPage(offset = 0) {
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new Error("@looi:runtimeInvalidTaskPage");
    const tasks = this.allTasks().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return {
      total: tasks.length,
      offset,
      items: tasks.slice(offset, offset + 10).map((task) => ({
        id: task.id,
        prompt: task.prompt.slice(0, 160),
        state: task.state,
        updatedAt: task.updatedAt,
      })),
    };
  }

  taskDetails(id: string) {
    const task = this.allTasks().find((item) => item.id === id);
    if (!task) throw new Error("@looi:runtimeTaskNotFound");
    const homeActions = this.database
      .prepare(
        "SELECT evidence FROM home_action_evidence WHERE task_id = ? ORDER BY rowid",
      )
      .all(task.id)
      .map((row) => JSON.parse(String(row.evidence)));
    const bodyActions = this.database
      .prepare(
        "SELECT evidence FROM body_action_evidence WHERE task_id = ? ORDER BY rowid",
      )
      .all(task.id)
      .map((row) => JSON.parse(String(row.evidence)));
    return { ...structuredClone(task), homeActions, bodyActions,
      observations: task.trace ? this.storage.traceObservations(task.trace.traceId) : [] };
  }

  subscribeTrace(listener: () => void): () => void {
    this.traceListeners.add(listener);
    return () => this.traceListeners.delete(listener);
  }

  newConversation(action: UserActionRef): void {
    if (
      this.closed ||
      this.busy ||
      this.loginPending ||
      Boolean(this.llmOAuthAbort)
    )
      throw new Error("@looi:runtimeStopTheCurrentTaskOrCancelSigninFirst");
    assertFreshUiAction(action);
    if (action.ui_session_id !== this.uiSessionId)
      throw new Error("@looi:runtimeThisPageExpiredOpenItAgain");
    const conversationId = `session_${randomUUID()}`;
    const raw = this.vault.get("model");
    if (raw) {
      this.credentialStore.updateEnvelope((draft) => {
        draft.conversationId = conversationId;
        return draft;
      });
      this.conversationPersisted = true;
    } else {
      this.conversationPersisted = false;
    }
    this.conversationId = conversationId;
  }

  private validate(config: ModelConfiguration): ModelConfiguration {
    if (
      typeof config?.baseUrl !== "string" ||
      typeof config.model !== "string" ||
      typeof config.apiKey !== "string"
    )
      throw new Error("@looi:runtimeModelSettingsAreIncomplete");
    let url: URL;
    try {
      url = new URL(config.baseUrl);
    } catch {
      throw new Error("@looi:runtimeUseAnHttpsModelUrlWithoutCredentialsOr");
    }
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error("@looi:runtimeUseAnHttpsModelUrlWithoutCredentialsOr");
    if (
      !config.model.trim() ||
      config.model.length > 256 ||
      !config.apiKey.trim() ||
      config.apiKey.length > 8192
    )
      throw new Error("@looi:runtimeEnterAModelNameAndApiKey");
    return {
      baseUrl: url.href.replace(/\/$/, ""),
      model: config.model.trim(),
      apiKey: config.apiKey.trim(),
    };
  }

  private isValidCustomEndpoint(custom?: CustomEndpointConfig): boolean {
    if (
      !custom ||
      typeof custom.baseUrl !== "string" ||
      typeof custom.modelId !== "string"
    )
      return false;
    let url: URL;
    try {
      url = new URL(custom.baseUrl);
    } catch {
      return false;
    }
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return false;
    return Boolean(custom.modelId.trim() && custom.modelId.length <= 256);
  }

  private validateCustomEndpoint(
    custom?: CustomEndpointConfig,
  ): CustomEndpointConfig {
    if (
      !custom ||
      typeof custom.baseUrl !== "string" ||
      typeof custom.modelId !== "string"
    )
      throw new Error("@looi:runtimeCustomEndpointSettingsAreIncomplete");
    let url: URL;
    try {
      url = new URL(custom.baseUrl);
    } catch {
      throw new Error("@looi:runtimeUseAnHttpsModelUrlWithoutCredentialsOr");
    }
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error("@looi:runtimeUseAnHttpsModelUrlWithoutCredentialsOr");
    const model = custom.modelId.trim();
    if (!model || model.length > 256) throw new Error("@looi:runtimeEnterAModelName");
    const validProtocols: CompatibleApiProtocol[] = [
      "openai-completions",
      "openai-responses",
      "anthropic-messages",
    ];
    const api = validProtocols.includes(custom.api)
      ? custom.api
      : "openai-completions";
    return {
      api,
      baseUrl: url.href.replace(/\/$/, ""),
      modelId: model,
    };
  }

  async configure(input: ModelConfiguration): Promise<void> {
    if (
      this.closed ||
      this.busy ||
      this.loginPending ||
      Boolean(this.llmOAuthAbort)
    )
      throw new Error("@looi:runtimeStopTheCurrentTaskOrCancelSigninFirst");
    const prevEnvelope = this.credentialStore.readEnvelope();
    const existingCustomKey =
      prevEnvelope.credentials.custom?.type === "api_key"
        ? (prevEnvelope.credentials.custom.key ?? "")
        : "";
    let sameOrigin = false;
    if (prevEnvelope.custom?.baseUrl && existingCustomKey) {
      try {
        sameOrigin =
          new URL(input.baseUrl).origin ===
          new URL(prevEnvelope.custom.baseUrl).origin;
      } catch {
        sameOrigin = false;
      }
    }
    const next = this.validate({
      ...input,
      apiKey: input.apiKey || (sameOrigin ? existingCustomKey : ""),
    });
    this.busy = true;
    const prevConversationId = this.conversationId;
    const prevConversationPersisted = this.conversationPersisted;
    try {
      await this.executor?.close();
      this.executor = undefined;
      if (this.closed) throw new Error("@looi:runtimePageClosed");
      const conversationId = `session_${randomUUID()}`;
      let nextEnvelope: ModelVaultEnvelope;
      try {
        nextEnvelope = await this.credentialStore.updateEnvelopeAsync((draft) => {
          draft.conversationId = conversationId;
          draft.custom = {
            api: draft.custom?.api ?? "openai-completions",
            baseUrl: next.baseUrl,
            modelId: next.model,
          };
          draft.credentials.custom = {
            type: "api_key",
            key: next.apiKey,
          };
          draft.active = {
            providerId: "custom",
            modelId: next.model,
            authType: "api_key",
          };
          return draft;
        });
      } catch (error) {
        // A native vault failure must leave the previous configuration usable.
        this.conversationId = prevConversationId;
        this.conversationPersisted = prevConversationPersisted;
        syncLooiModelsRegistry(this.modelsRegistry, prevEnvelope);
        if (
          prevEnvelope.active &&
          prevEnvelope.credentials[prevEnvelope.active.providerId]
        ) {
          let customValid = true;
          if (prevEnvelope.active.providerId === "custom") {
            customValid = this.isValidCustomEndpoint(prevEnvelope.custom);
          }
          if (customValid) {
            this.executor = this.createExecutorForSelection(prevEnvelope.active);
          }
        }
        throw error;
      }
      this.conversationId = conversationId;
      this.conversationPersisted = true;
      syncLooiModelsRegistry(this.modelsRegistry, nextEnvelope);
      this.executor = this.createExecutorForSelection(nextEnvelope.active!);
    } finally {
      this.busy = false;
    }
  }

  private createExecutorForSelection(
    selection: ActiveLlmSelection,
  ): PiAgentExecutor {
    process.env.PI_CODING_AGENT_DIR = "/home/agent";
    const credential = this.credentialStore.readEnvelope().credentials[selection.providerId];
    if (credential?.type === "api_key" && credential.key) this.tracer.registerSecret(credential.key);
    const homeEnabled = this.home.configuration().mode !== "disabled";
    const bodyEnabled = this.body.configuration().mode !== "disabled";
    return new PiAgentExecutor({
      tracer: this.tracer,
      modelsRegistry: this.modelsRegistry,
      credentialStore: this.credentialStore,
      providerId: selection.providerId,
      model: selection.modelId,
      stateDirectory: "/home/agent",
      workspaceRoot: "/workspace",
      taskPersistence: this.storage.tasks,
      approvalUiSessionId: this.uiSessionId,
      requireApprovalForAllWrites: true,
      maxConcurrentTasks: 1,
      deadlineMs: 600_000,
      systemPrompt: deviceControlInstructions + "\n家居查询使用 list_home_devices；仅在用户要求控制时，再用返回的 entity_id 和 connectionId 调用 control_home_device。不要先检查底座状态。工具未提供时，说明当前未启用对应能力。",
      additionalTools: [
        ...(homeEnabled ? this.homeTools() : []),
        ...(bodyEnabled ? this.bodyTools() : []),
      ],
      taskTools: context => this.plugins.contribution(context),
      toolApprovalRules: Object.fromEntries(["codex_exec", "codex_cloud"].map(name => [name, ({ approvalMode, arguments: input }: { approvalMode: string; arguments: Record<string, unknown> }) => approvalMode === "ask" ? { operation: name, ...input } : undefined])),
      approvalRequiredTools: homeEnabled ? ["control_home_device"] : [],
    });
  }

  private bodyTools(): AgentTool<any>[] {
    return createBodyTools({
      body: this.body,
      database: this.database,
      getActiveTaskId: () => this.taskId,
    });
  }

  private homeTools(): AgentTool<any>[] {
    return createHomeTools({
      home: this.home,
      database: this.database,
      getActiveTaskId: () => this.taskId,
    });
  }

  touchVoiceConversation(): void {
    this.voiceConversation.touch();
  }

  voiceConversationId(): string {
    return this.voiceConversation.current();
  }

  async run(
    prompt: string,
    action: UserActionRef,
    onStep: (event: AgentStepEvent) => void,
    options: { onShellOutput?: import("@super-looi/runtime/agent/executor").AgentRunOptions["onShellOutput"]; agentOnly?: boolean; defaultLanguage?: "zh-CN" | "en-US"; mode?: "text" | "voice"; approvalMode?: "ask" | "local_auto" | "yolo"; traceContext?: TraceContext } = {},
  ): Promise<{ answer: string; taskId: string; runtimeExited: boolean }> {
    if (
      this.closed ||
      this.busy ||
      this.loginPending ||
      Boolean(this.llmOAuthAbort)
    )
      throw new Error("@looi:runtimeATaskOrSigninIsActiveStopIt");
    assertFreshUiAction(action);
    if (action.ui_session_id !== this.uiSessionId)
      throw new Error("@looi:runtimeThisPageExpiredOpenItAgain");
    const text = prompt.trim();
    if (!text) throw new Error("@looi:runtimeEnterAMessage");
    this.busy = true;
    const sessionId = options.mode === "voice"
      ? this.voiceConversation.begin()
      : this.conversationId;
    try {
      if (!this.executor) throw new Error("@looi:runtimeConfigureAChatModelInConnectionsFirst");
      if (!this.conversationPersisted && this.vault.get("model")) {
        this.credentialStore.updateEnvelope((draft) => {
          draft.conversationId = this.conversationId;
          return draft;
        });
        this.conversationPersisted = true;
      }
      this.taskId = `task_${randomUUID()}`;
      const result = await this.executor.run(text, {
        taskId: this.taskId,
        sessionId,
        mode: options.mode,
        approvalMode: options.approvalMode,
        defaultLanguage: options.defaultLanguage,
        traceContext: options.traceContext,
        onStep,
        onShellOutput: options.onShellOutput,
      });
      return {
        answer: result.answer,
        taskId: result.taskId,
        runtimeExited: result.runtimeExited,
      };
    } finally {
      if (options.mode === "voice") this.voiceConversation.finish();
      this.busy = false;
      this.taskId = undefined;
    }
  }

  respond(taskId: string, requestId: string, answer: AgentInteractionAnswer) {
    if (this.closed || !this.executor) throw new Error("@looi:runtimeRuntimeUnavailable");
    this.executor.respond(taskId, requestId, answer);
  }

  sendTaskMessage(taskId: string, message: string, behavior: "steer" | "followUp", action: UserActionRef): Promise<"queued" | "handled"> {
    assertFreshUiAction(action);
    if (action.ui_session_id !== this.uiSessionId) throw new Error("@looi:runtimeThisPageExpiredOpenItAgain");
    if (this.closed || !this.executor) throw new Error("@looi:runtimeRuntimeUnavailable");
    if (taskId !== this.taskId) throw new Error("Task has no active Pi run");
    return this.executor.sendMessage(taskId, message, behavior);
  }

  async cancel() {
    this.cancelMiotLogin();
    this.cancelProviderOAuth();
    this.home.suspend();
    void this.body.stop("user_stop");
    const taskId = this.taskId;
    const result =
      taskId && this.executor
        ? await this.executor.cancel(taskId)
        : { state: "cancelled", runtimeExited: true, confirmed: true };
    return result;
  }

  async close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.cancelProviderOAuth();
    this.home.close();
    this.body.close();
    this.closing = (async () => {
      try {
        await this.executor?.close();
      } finally {
        try { await this.plugins.close(); }
        finally {
          try { await this.tracer.shutdown(); }
          finally { this.storage.close(); this.releaseHost(); }
        }
      }
    })();
    return this.closing;
  }

  llmSnapshot(): LlmCatalogSnapshot {
    const envelope = this.credentialStore.readEnvelope();
    const customModelsMap = envelope.customModelsByProvider ?? {};

    const brands: LlmBrandStatus[] = LLM_PROVIDER_CATALOG.map((brandSpec) => {
      const channels: LlmChannelStatus[] = brandSpec.channels.map((ch) => {
        const cred = envelope.credentials[ch.providerId];
        const hasApiKey = cred?.type === "api_key";
        const hasOAuth = cred?.type === "oauth";
        const oauthExpiresAt =
          cred?.type === "oauth" && typeof cred.expires === "number"
            ? cred.expires
            : null;

        const customIds = new Set(customModelsMap[ch.providerId] ?? []);
        const activeIdOnChannel =
          envelope.active?.providerId === ch.providerId
            ? envelope.active.modelId
            : "";
        const visibleModels = new Map<string, { id: string; name: string }>();
        if (hasApiKey || hasOAuth) {
          for (const model of this.fetchedModels.get(ch.providerId) ?? []) {
            visibleModels.set(model.id, model);
          }
          for (const id of customIds) {
            if (!visibleModels.has(id)) visibleModels.set(id, { id, name: id });
          }
          if (
            activeIdOnChannel &&
            !this.fetchedModels.has(ch.providerId) &&
            !this.modelFetchErrors.has(ch.providerId) &&
            !visibleModels.has(activeIdOnChannel)
          ) {
            visibleModels.set(activeIdOnChannel, {
              id: activeIdOnChannel,
              name: activeIdOnChannel,
            });
          }
        }
        const models: LlmModelItem[] = [...visibleModels.values()]
          .map((m) => {
            const known = this.modelsRegistry.getModel(ch.providerId, m.id);
            return {
              id: m.id,
              name: m.name,
              reasoning: Boolean(known?.reasoning),
              contextWindow: known?.contextWindow ?? 32768,
              isCustom: customIds.has(m.id) || ch.providerId === "custom",
            };
          })
          .sort((a, b) => {
            const rank = (item: LlmModelItem) => {
              if (activeIdOnChannel && item.id === activeIdOnChannel) return 0;
              if (item.id === ch.defaultModelId) return 1;
              if (item.isCustom) return 2;
              return 3;
            };
            return rank(a) - rank(b);
          });

        const baseUrl =
          ch.providerId === "custom"
            ? (envelope.custom?.baseUrl ?? "")
            : ch.baseUrl;

        return {
          providerId: ch.providerId,
          label: ch.label,
          baseUrl,
          protocolLabel: ch.protocolLabel,
          authTypes: [...ch.authTypes] as Array<"api_key" | "oauth">,
          defaultModelId: ch.defaultModelId,
          hasApiKey,
          hasOAuth,
          oauthExpiresAt,
          models,
          modelsFetched: this.fetchedModels.has(ch.providerId),
          modelsError: this.modelFetchErrors.get(ch.providerId),
        };
      });

      const configured = channels.some((c) => c.hasApiKey || c.hasOAuth);

      return {
        brandId: brandSpec.brandId,
        label: brandSpec.label,
        shortLabel: brandSpec.shortLabel,
        configured,
        channels,
      };
    });

    let active: LlmCatalogSnapshot["active"] = null;
    if (envelope.active) {
      let activeBrandId: LlmBrandId = "custom";
      for (const b of LLM_PROVIDER_CATALOG) {
        if (
          b.channels.some((c) => c.providerId === envelope.active!.providerId)
        ) {
          activeBrandId = b.brandId;
          break;
        }
      }
      active = {
        brandId: activeBrandId,
        providerId: envelope.active.providerId,
        modelId: envelope.active.modelId,
        authType: envelope.active.authType === "oauth" ? "oauth" : "api_key",
      };
    }

    return {
      brands,
      active,
      custom: envelope.custom ?? {
        api: "openai-completions",
        baseUrl: "",
        modelId: "",
      },
    };
  }

  async refreshProviderModels(providerId: string, signal?: AbortSignal): Promise<LlmCatalogSnapshot> {
    const envelope = this.credentialStore.readEnvelope();
    const credential = envelope.credentials[providerId];
    if (!credential) return this.llmSnapshot();
    const channel = LLM_PROVIDER_CATALOG.flatMap((brand) => brand.channels)
      .find((item) => item.providerId === providerId);
    if (!channel) throw new Error(uiMessage("unknownProvider", { provider: providerId }));

    const version = this.invalidateFetchedModels(providerId);
    try {
      const auth = await this.modelsRegistry.getAuth(providerId, { signal });
      if (!auth) throw new Error("@looi:runtimeConnectAModelServiceFirst");
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(auth.auth.headers ?? {})) {
        if (value !== null) headers[name] = value;
      }
      if (auth.auth.apiKey) headers.Authorization = `Bearer ${auth.auth.apiKey}`;
      const baseUrl = providerId === "custom"
        ? envelope.custom?.baseUrl
        : channel.baseUrl;
      if (!baseUrl) return this.llmSnapshot();
      const knownChatIds = credential.type === "api_key"
        ? new Set(this.modelsRegistry.getModels(providerId).map((model) => model.id))
        : undefined;
      const models = await fetchOnlineModels(baseUrl, headers, { knownChatIds, signal });
      signal?.throwIfAborted();
      if (this.modelFetchVersions.get(providerId) !== version) return this.llmSnapshot();
      this.fetchedModels.set(providerId, models);
    } catch (error) {
      if (signal?.aborted) throw error;
      if (this.modelFetchVersions.get(providerId) === version) {
        this.modelFetchErrors.set(
          providerId,
          error instanceof Error ? error.message : "@looi:runtimeCouldNotLoadOnlineModels",
        );
      }
    }
    return this.llmSnapshot();
  }

  private invalidateFetchedModels(providerId: string): number {
    const version = (this.modelFetchVersions.get(providerId) ?? 0) + 1;
    this.modelFetchVersions.set(providerId, version);
    this.fetchedModels.delete(providerId);
    this.modelFetchErrors.delete(providerId);
    return version;
  }

  async saveProviderApiKey(
    input: {
      providerId: string;
      apiKey?: string;
      modelId?: string;
      custom?: CustomEndpointConfig;
      setActive?: boolean;
    },
    action: UserActionRef,
  ): Promise<LlmCatalogSnapshot> {
    if (
      this.closed ||
      this.busy ||
      this.loginPending ||
      Boolean(this.llmOAuthAbort)
    )
      throw new Error("@looi:runtimeStopTheCurrentTaskOrCancelSigninFirst");
    assertFreshUiAction(action);
    if (action.ui_session_id !== this.uiSessionId)
      throw new Error("@looi:runtimeThisPageExpiredOpenItAgain");

    let targetChannel: LlmChannelSpec | undefined;
    for (const b of LLM_PROVIDER_CATALOG) {
      const ch = b.channels.find((c) => c.providerId === input.providerId);
      if (ch) {
        targetChannel = ch;
        break;
      }
    }
    if (!targetChannel) throw new Error(uiMessage("unknownProvider", { provider: input.providerId }));

    let validatedCustom: CustomEndpointConfig | undefined;
    if (input.providerId === "custom") {
      validatedCustom = this.validateCustomEndpoint(input.custom);
    }

    const envelope = this.credentialStore.readEnvelope();
    const existingCred = envelope.credentials[input.providerId];
    let nextCred: Credential;
    const trimmedKey = input.apiKey?.trim();
    if (trimmedKey) {
      if (trimmedKey.length > 8192) throw new Error("@looi:runtimeApiKeyIsTooLong");
      nextCred = { type: "api_key", key: trimmedKey };
    } else if (existingCred) {
      nextCred = existingCred;
    } else {
      throw new Error("@looi:runtimeEnterAnApiKey");
    }

    const targetModelId =
      input.modelId?.trim() ||
      (input.providerId === "custom" ? validatedCustom?.modelId : "") ||
      targetChannel.defaultModelId;
    if (!targetModelId) throw new Error("@looi:runtimeSelectOrEnterAModelId");

    const isKnownModel = Boolean(
      this.modelsRegistry.getModel(input.providerId, targetModelId),
    );

    const shouldSetActive = input.setActive !== false;
    const prevEnvelope = envelope;
    const prevConversationId = this.conversationId;
    const prevConversationPersisted = this.conversationPersisted;
    const nextConversationId = shouldSetActive
      ? `session_${randomUUID()}`
      : this.conversationId;

    this.busy = true;
    try {
      if (shouldSetActive) {
        await this.executor?.close();
        this.executor = undefined;
      }
      let nextEnvelope: ModelVaultEnvelope;
      try {
        nextEnvelope = await this.credentialStore.updateEnvelopeAsync((draft) => {
          draft.credentials[input.providerId] = nextCred;
          if (validatedCustom) {
            draft.custom = validatedCustom;
          }
          if (
            input.providerId !== "custom" &&
            !isKnownModel &&
            !this.fetchedModels.get(input.providerId)?.some((model) => model.id === targetModelId)
          ) {
            draft.customModelsByProvider ??= {};
            draft.customModelsByProvider[input.providerId] ??= [];
            if (
              !draft.customModelsByProvider[input.providerId].includes(
                targetModelId,
              )
            ) {
              draft.customModelsByProvider[input.providerId].push(
                targetModelId,
              );
            }
          }
          if (shouldSetActive) {
            draft.conversationId = nextConversationId;
            draft.active = {
              providerId: input.providerId,
              modelId: targetModelId,
              authType: nextCred.type,
            };
          }
          return draft;
        });
      } catch (error) {
        // Rollback
        this.conversationId = prevConversationId;
        this.conversationPersisted = prevConversationPersisted;
        syncLooiModelsRegistry(this.modelsRegistry, prevEnvelope);
        if (
          prevEnvelope.active &&
          prevEnvelope.credentials[prevEnvelope.active.providerId]
        ) {
          let customValid = true;
          if (prevEnvelope.active.providerId === "custom") {
            customValid = this.isValidCustomEndpoint(prevEnvelope.custom);
          }
          if (customValid) {
            this.executor = this.createExecutorForSelection(prevEnvelope.active);
          }
        }
        throw error;
      }

      if (shouldSetActive) {
        this.conversationId = nextConversationId;
        this.conversationPersisted = true;
      }
      syncLooiModelsRegistry(this.modelsRegistry, nextEnvelope);
      if (
        nextEnvelope.active &&
        nextEnvelope.credentials[nextEnvelope.active.providerId]
      ) {
        this.executor = this.createExecutorForSelection(nextEnvelope.active);
      }
      this.invalidateFetchedModels(input.providerId);
      return this.llmSnapshot();
    } finally {
      this.busy = false;
    }
  }

  async selectActiveModel(
    input: { providerId: string; modelId: string; addCustomModel?: boolean },
    action: UserActionRef,
  ): Promise<LlmCatalogSnapshot> {
    if (
      this.closed ||
      this.busy ||
      this.loginPending ||
      Boolean(this.llmOAuthAbort)
    )
      throw new Error("@looi:runtimeStopTheCurrentTaskOrCancelSigninFirst");
    assertFreshUiAction(action);
    if (action.ui_session_id !== this.uiSessionId)
      throw new Error("@looi:runtimeThisPageExpiredOpenItAgain");

    const envelope = this.credentialStore.readEnvelope();
    const cred = envelope.credentials[input.providerId];
    if (!cred) throw new Error("@looi:runtimeConfigureThisProvidersApiKeyOrSignIn");

    const targetModelId = input.modelId.trim();
    if (!targetModelId) throw new Error("@looi:runtimeSelectOrEnterAModelId");

    const isKnownModel = Boolean(
      this.modelsRegistry.getModel(input.providerId, targetModelId),
    );

    const changed =
      envelope.active?.providerId !== input.providerId ||
      envelope.active?.modelId !== targetModelId;

    const prevEnvelope = envelope;
    const prevConversationId = this.conversationId;
    const prevConversationPersisted = this.conversationPersisted;
    const nextConversationId = changed
      ? `session_${randomUUID()}`
      : this.conversationId;

    this.busy = true;
    try {
      if (changed) {
        await this.executor?.close();
        this.executor = undefined;
      }
      let nextEnvelope: ModelVaultEnvelope;
      try {
        nextEnvelope = await this.credentialStore.updateEnvelopeAsync((draft) => {
          if (
            !isKnownModel &&
            input.providerId !== "custom" &&
            !this.fetchedModels.get(input.providerId)?.some((model) => model.id === targetModelId)
          ) {
            draft.customModelsByProvider ??= {};
            draft.customModelsByProvider[input.providerId] ??= [];
            if (
              !draft.customModelsByProvider[input.providerId].includes(
                targetModelId,
              )
            ) {
              draft.customModelsByProvider[input.providerId].push(
                targetModelId,
              );
            }
          }
          if (input.providerId === "custom" && draft.custom) {
            draft.custom.modelId = targetModelId;
          }
          if (changed) {
            draft.conversationId = nextConversationId;
          }
          draft.active = {
            providerId: input.providerId,
            modelId: targetModelId,
            authType: cred.type,
          };
          return draft;
        });
      } catch (error) {
        // Rollback
        this.conversationId = prevConversationId;
        this.conversationPersisted = prevConversationPersisted;
        syncLooiModelsRegistry(this.modelsRegistry, prevEnvelope);
        if (
          prevEnvelope.active &&
          prevEnvelope.credentials[prevEnvelope.active.providerId]
        ) {
          let customValid = true;
          if (prevEnvelope.active.providerId === "custom") {
            customValid = this.isValidCustomEndpoint(prevEnvelope.custom);
          }
          if (customValid) {
            this.executor = this.createExecutorForSelection(prevEnvelope.active);
          }
        }
        throw error;
      }

      if (changed) {
        this.conversationId = nextConversationId;
        this.conversationPersisted = true;
      }
      syncLooiModelsRegistry(this.modelsRegistry, nextEnvelope);
      if (
        nextEnvelope.active &&
        nextEnvelope.credentials[nextEnvelope.active.providerId]
      ) {
        this.executor = this.createExecutorForSelection(nextEnvelope.active);
      }
      return this.llmSnapshot();
    } finally {
      this.busy = false;
    }
  }

  async removeProviderCredential(
    providerId: string,
    action: UserActionRef,
  ): Promise<LlmCatalogSnapshot> {
    if (
      this.closed ||
      this.busy ||
      this.loginPending ||
      Boolean(this.llmOAuthAbort)
    )
      throw new Error("@looi:runtimeStopTheCurrentTaskOrCancelSigninFirst");
    assertFreshUiAction(action);
    if (action.ui_session_id !== this.uiSessionId)
      throw new Error("@looi:runtimeThisPageExpiredOpenItAgain");

    const envelope = this.credentialStore.readEnvelope();
    const isActive = envelope.active?.providerId === providerId;
    const nextConversationId = `session_${randomUUID()}`;

    this.busy = true;
    try {
      if (isActive) {
        await this.executor?.close();
        this.executor = undefined;
      }
      const nextEnvelope = await this.credentialStore.updateEnvelopeAsync(
        (draft) => {
          delete draft.credentials[providerId];
          if (draft.active?.providerId === providerId) {
            draft.active = undefined;
            draft.conversationId = nextConversationId;
          }
          return draft;
        },
      );
      if (isActive) {
        this.conversationId = nextConversationId;
        this.conversationPersisted = true;
      }
      syncLooiModelsRegistry(this.modelsRegistry, nextEnvelope);
      this.invalidateFetchedModels(providerId);
      return this.llmSnapshot();
    } finally {
      this.busy = false;
    }
  }

  async startProviderOAuth(
    providerId: string,
    action: UserActionRef,
    onEvent: (event: LlmOAuthUiEvent) => void,
  ): Promise<LlmCatalogSnapshot> {
    if (
      this.closed ||
      this.busy ||
      this.loginPending ||
      Boolean(this.llmOAuthAbort)
    )
      throw new Error("@looi:runtimeStopTheCurrentTaskOrCancelSigninFirst");
    assertFreshUiAction(action);
    if (action.ui_session_id !== this.uiSessionId)
      throw new Error("@looi:runtimeThisPageExpiredOpenItAgain");

    let targetChannel: LlmChannelSpec | undefined;
    for (const b of LLM_PROVIDER_CATALOG) {
      const ch = b.channels.find((c) => c.providerId === providerId);
      if (ch) {
        targetChannel = ch;
        break;
      }
    }
    if (!targetChannel) throw new Error(uiMessage("unknownProvider", { provider: providerId }));

    const abort = new AbortController();
    this.llmOAuthAbort = abort;
    let authorizationUrl = "";

    try {
      await this.modelsRegistry.login(
        providerId,
        "oauth",
        {
          signal: abort.signal,
          notify: (ev: {
            type: string;
            userCode?: string;
            verificationUri?: string;
            expiresInSeconds?: number;
            url?: string;
            instructions?: string;
            message?: string;
          }) => {
            if (ev.type === "device_code" && ev.userCode && ev.verificationUri) {
              onEvent({
                kind: "device_code",
                userCode: ev.userCode,
                verificationUri: ev.verificationUri,
                expiresInSeconds: ev.expiresInSeconds,
              });
            } else if (ev.type === "auth_url" && ev.url) {
              authorizationUrl = ev.url;
              onEvent({
                kind: "auth_url",
                url: ev.url,
                instructions: ev.instructions,
              });
            } else if (
              (ev.type === "progress" || ev.type === "info") &&
              typeof ev.message === "string"
            ) {
              onEvent({
                kind: "progress",
                message: ev.message,
              });
            }
          },
          prompt: async (p: {
            type: string;
            message: string;
            placeholder?: string;
            signal?: AbortSignal;
          }) => {
            if (p.type === "manual_code") {
              onEvent({
                kind: "awaiting_callback",
                message: p.message,
                placeholder: p.placeholder ?? "",
              });
              return await new Promise<string>((resolve, reject) => {
                this.llmOAuthManualPrompt = { resolve, reject, providerId, authorizationUrl };
                const onAbort = () => {
                  if (this.llmOAuthManualPrompt) {
                    this.llmOAuthManualPrompt = undefined;
                    reject(new Error("@looi:runtimeSigninCancelled"));
                  }
                };
                p.signal?.addEventListener("abort", onAbort, { once: true });
                abort.signal.addEventListener("abort", onAbort, { once: true });
              });
            }
            throw new Error("@looi:runtimeUnsupportedInteractionType");
          },
        },
        {
          getDeviceId: () => this.credentialStore.readEnvelope().deviceId,
          agentName: "Super LOOI",
        },
      );

      abort.signal.throwIfAborted();
      await this.refreshProviderModels(providerId, abort.signal);
      const envelope = this.credentialStore.readEnvelope();
      const targetModelId = chooseConnectedModelId(
        this.fetchedModels.get(providerId),
        envelope.active?.providerId === providerId ? envelope.active.modelId : "",
        targetChannel.defaultModelId,
        this.modelsRegistry.getModels(providerId)[0]?.id ?? "",
      );

      this.busy = true;
      try {
        const conversationId = `session_${randomUUID()}`;
        await this.executor?.close();
        this.executor = undefined;
        abort.signal.throwIfAborted();

        const nextEnvelope = await this.credentialStore.updateEnvelopeAsync(
          (draft) => {
            draft.conversationId = conversationId;
            draft.active = {
              providerId,
              modelId: targetModelId,
              authType: "oauth",
            };
            return draft;
          },
          { signal: abort.signal },
        );

        this.conversationId = conversationId;
        this.conversationPersisted = true;
        syncLooiModelsRegistry(this.modelsRegistry, nextEnvelope);
        this.executor = this.createExecutorForSelection(nextEnvelope.active!);
        return this.llmSnapshot();
      } finally {
        this.busy = false;
      }
    } finally {
      if (this.llmOAuthAbort === abort) {
        this.llmOAuthAbort = undefined;
        this.llmOAuthManualPrompt = undefined;
      }
    }
  }

  submitProviderOAuthCallback(callbackUrl: string): void {
    const prompt = this.llmOAuthManualPrompt;
    if (!prompt) throw new Error("@looi:runtimeNoSigninIsAwaitingACallback");
    if (prompt.providerId === "openai") {
      let callback: URL;
      try {
        callback = new URL(callbackUrl.trim());
      } catch {
        throw new Error("@looi:runtimePasteFullChatgptCallbackUrl");
      }
      const authorization = new URL(prompt.authorizationUrl);
      if (
        callback.origin !== "http://127.0.0.1:1455" ||
        callback.pathname !== "/auth/callback" ||
        callback.searchParams.has("error") ||
        !callback.searchParams.get("code") ||
        !callback.searchParams.get("client_id")
      ) {
        throw new Error("@looi:runtimePasteFullChatgptCallbackUrl");
      }
      if (callback.searchParams.get("state") !== authorization.searchParams.get("state")) {
        throw new Error("@looi:runtimeChatgptCallbackDoesNotMatchSignin");
      }
    }
    this.llmOAuthManualPrompt = undefined;
    prompt.resolve(callbackUrl.trim());
  }

  cancelProviderOAuth(): void {
    if (this.llmOAuthManualPrompt) {
      const prompt = this.llmOAuthManualPrompt;
      this.llmOAuthManualPrompt = undefined;
      prompt.reject(new Error("@looi:runtimeSigninCancelled"));
    }
    if (this.llmOAuthAbort) {
      const abort = this.llmOAuthAbort;
      this.llmOAuthAbort = undefined;
      abort.abort();
    }
  }
}
