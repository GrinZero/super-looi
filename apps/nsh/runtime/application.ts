import { uiMessage } from "./messages.js";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { UserActionRef } from "@super-looi/contracts";
import { PiAgentExecutor } from "@super-looi/runtime/agent/pi-executor";
import type {
  AgentInteraction,
  AgentInteractionAnswer,
  AgentStepEvent,
  AgentStopResult,
  AgentTask,
} from "@super-looi/runtime/agent/executor";
import {
  PostTurnScheduleObserver,
  ScheduleEngine,
  type CreateScheduleRuleInput,
  type NativePermissionStatusResult,
  type NativeScheduleEvent,
  type NativeSchedulePort,
  type QuietHoursWindow,
  type ScheduleActivityEvent,
  type ScheduleDeliveryContext,
  type ScheduleExecutionPolicy,
  type ScheduleFailure,
  type ScheduleImportance,
  type ScheduleOrigin,
  type ScheduleReportSource,
  type ScheduleRule,
  type ScheduleRuleState,
  type ScheduleRunRecord,
  type ScheduleRunStatus,
  type ScheduleRunTriggerReason,
  type ScheduleSettings,
  type ScheduleSnapshot,
  type ScheduleToolFailure,
  type ScheduleTrigger,
  type UpdateScheduleRuleInput,
} from "@super-looi/runtime/schedule";
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
import {
  clearGitHubToken,
  createBodyTools,
  createGitHubPrStatusTool,
  createHomeTools,
  createScheduleTools,
  githubCredentialStatus,
  readGitHubToken,
  saveGitHubToken,
  verifyGitHubToken,
  type GitHubCredentialStatus,
  type GitHubTokenVerificationResult,
} from "./tools/index.js";
import {
  createScheduleNativePort,
  isNativeScheduleHost,
  type NativeScheduleExactAlarmStatus,
  type NativeScheduleHost,
} from "./schedule-native-adapter.js";
import type { VoiceSchedule } from "./voice/tools/schedule.js";
import { deviceControlInstructions } from "./device-control-instructions.js";
import { createLangfuseTracer } from "../../../packages/looi-runtime/src/telemetry/langfuse.js";
import type { TraceContext } from "../../../packages/looi-runtime/src/telemetry/langfuse.js";
import { VoiceConversationWindow } from "./voice/conversation-window.js";
import { directVoiceToolName, voiceToolTask, voiceToolTaskPrefix } from "./voice-tool-history.js";
import { PluginHost } from "./plugins/host.js";
import type {
  NshPackageEnvelope,
  VerifiedNshPackage,
  VerifyNshPackageOptions,
} from "./plugins/package-loader.js";
import type { DualLoopAiBusBridge } from "./plugins/ai-bus.js";
import {
  FaceDriverHub,
  createBodyCapability,
  createMotionCapability,
  createVisionCapability,
  uint8ArrayToBase64,
} from "./plugins/embodied-drivers.js";
import {
  MotionBroker,
  type MotionBrokerAttachOptions,
  type NativeDeviceMotionPort,
} from "./device-motion.js";
import {
  VisionBroker,
  type NativeDeviceCameraPort,
  type VisionBrokerAttachOptions,
} from "./device-camera.js";
import {
  LanRoomBroker,
  createLanRoomCapability,
  type NativeLanRoomPort,
} from "./lan-room.js";
import { createBuiltinPluginDefinitions } from "../plugins/registry.js";
import type { PluginDefinition, PluginEvent } from "./plugins/contracts.js";
import type { RobotFaceController } from "../../../packages/looi-runtime/src/ui/robot-face-controller.js";

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
  CreateScheduleRuleInput,
  UpdateScheduleRuleInput,
  ScheduleRule,
  ScheduleRunRecord,
  ScheduleSettings,
  ScheduleSnapshot,
  QuietHoursWindow,
  ScheduleTrigger,
  ScheduleOrigin,
  ScheduleExecutionPolicy,
  ScheduleRuleState,
  ScheduleRunTriggerReason,
  ScheduleRunStatus,
  ScheduleReportSource,
  ScheduleImportance,
  ScheduleFailure,
  ScheduleToolFailure,
  ScheduleActivityEvent,
  NativePermissionStatusResult,
  NativeScheduleEvent,
  NativeSchedulePort,
  NativeScheduleHost,
  NativeScheduleExactAlarmStatus,
  GitHubCredentialStatus,
  GitHubTokenVerificationResult,
  AgentStopResult,
  VoiceSchedule,
};

export type ScheduleActivityNotification = ScheduleActivityEvent & {
  rule?: ScheduleRule;
  run?: ScheduleRunRecord;
  merged?: boolean;
  isQuietHours?: boolean;
  foregroundActive?: boolean;
  notificationPosted?: boolean;
  notificationError?: ScheduleFailure;
};

export type ScheduleInteractionEvent =
  | {
      type: "requested";
      taskId: string;
      ruleId?: string;
      ruleTitle?: string;
      runId?: string;
      interaction: AgentInteraction;
    }
  | {
      type: "cleared";
      taskId: string;
      interactionId: string;
      taskState: string;
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
  private readonly taskActivityListeners = new Set<(historyChanged: boolean) => void>();
  private pendingTaskActivity?: { historyChanged: boolean };
  private readonly database = new DatabaseSync("/home/looi.sqlite");
  private readonly storage = new SqliteRuntimeStore(this.database);
  readonly tracer = createLangfuseTracer({
    baseUrl: process.env.LANGFUSE_BASE_URL,
    publicKey: process.env.LANGFUSE_PUBLIC_KEY,
    secretKey: process.env.LANGFUSE_SECRET_KEY,
    onObservation: (observation) => {
      this.storage.saveObservation(observation);
      this.emitTaskActivity(Boolean(directVoiceToolName(observation)));
    },
  });
  private readonly home: HomeRuntime;
  private readonly body: BodyRuntime;
  private readonly faceHub = new FaceDriverHub();
  private readonly visionBroker = new VisionBroker();
  private readonly motionBroker = new MotionBroker();
  private readonly lanRoomBroker = new LanRoomBroker();
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
  private activeForegroundSessionId?: string;
  private readonly activePluginTaskIds = new Set<string>();
  private readonly scheduleActivityListeners = new Set<(event: ScheduleActivityNotification) => void>();
  private readonly scheduleInteractionListeners = new Set<(event: ScheduleInteractionEvent) => void>();
  private readonly activeScheduleInteractions = new Map<string, ScheduleInteractionEvent & { type: "requested" }>();
  private readonly mutatedScheduleTaskIds = new Set<string>();
  private readonly pendingMergedRules = new Set<string>();
  private readonly handledSettledRuns = new Set<string>();
  private readonly scheduleEngine: ScheduleEngine;
  private readonly postTurnObserver: PostTurnScheduleObserver;
  private attachedSchedulePort: NativeSchedulePort | null = null;
  private attachedScheduleHost?: NativeScheduleHost;
  private scheduleForegroundActive = false;
  private lastDefaultLanguage: "zh-CN" | "en-US" = "zh-CN";
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
      this.plugins = new PluginHost(
        this.database,
        createBuiltinPluginDefinitions({
          codex: {
            tracer: this.tracer,
            traceContext: () => {
              const trace = this.taskId ? this.executor?.getTask(this.taskId)?.trace : undefined;
              return trace ? { traceId: trace.traceId, parentSpanId: trace.spanId, traceName: "codex" } : undefined;
            },
          },
        }),
        {
          createFaceCapability: (manifest, scope) => this.faceHub.createCapability(manifest, scope),
          createBodyCapability: (manifest, scope) => createBodyCapability(manifest, scope, this.body),
          createVisionCapability: (manifest, scope) =>
            createVisionCapability(manifest, scope, this.visionBroker),
          createMotionCapability: (manifest, scope) =>
            createMotionCapability(manifest, scope, this.motionBroker),
          createLanCapability: (manifest, scope) =>
            createLanRoomCapability(manifest, scope, this.lanRoomBroker),
          aiBridge: {
            runBackgroundTask: ({ pluginId, prompt: bgPrompt }) =>
              this.runPluginBackgroundTask(pluginId, bgPrompt),
          },
        },
      );
      this.credentialStore = new VaultCredentialStore(vault, {
        conversationId: () => this.conversationId,
      });
      this.modelsRegistry = createLooiModelsRegistry(this.credentialStore);
      this.registerGitHubSecret();
      this.scheduleEngine = new ScheduleEngine({
        store: this.storage,
        getExecutor: () => this.executor,
        tracer: this.tracer,
        defaultLanguage: () => this.lastDefaultLanguage,
        onRuleCreated: (rule, merged) => {
          if (merged) {
            this.pendingMergedRules.add(rule.id);
          }
        },
        onRunSettled: async (context) => {
          await this.handleScheduleRunSettled(context);
        },
        onActivity: (event) => {
          this.emitScheduleActivity(event);
        },
      });
      this.postTurnObserver = new PostTurnScheduleObserver({
        engine: this.scheduleEngine,
        store: this.storage,
        tracer: this.tracer,
        redactSecrets: (text) => this.redactSecrets(text),
        getModelConfig: () => this.resolveCurrentModelStreamConfig(),
      });

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
            queueMicrotask(() => {
              if (!this.closed) {
                void this.scheduleEngine.reconcileDueRules().catch(() => {});
              }
            });
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

  voiceHome(): import("./voice/tools/home.js").VoiceHome | undefined {
    return this.home.configuration().mode === "disabled" ? undefined : this.home;
  }

  voiceSchedule(): VoiceSchedule {
    return this.scheduleEngine;
  }

  pluginsSnapshot() { return this.plugins.snapshots(); }
  startPlugins() { return this.plugins.startStartupPlugins(); }
  activeStagePresentation() { return this.plugins.stage.activePresentation(); }
  resumableStage() { return this.plugins.resumableStage(); }
  resumePluginStage(id?: string) { return this.plugins.resumePluginStage(id); }
  setPluginsForegroundActive(active: boolean) { this.plugins.setForegroundActive(active); }
  exitPluginStage(id: string) { this.plugins.stage.exitPluginStage(id); }
  reportPluginStageCrash(
    id: string,
    slot: "StageCanvas" | "StageCompanion" | "StageCapsule" | "StageDrawer",
    error: unknown,
  ) {
    return this.plugins.reportStageCrash(id, slot, error);
  }
  installMarketplacePlugin(
    rawArchive: string | Uint8Array | NshPackageEnvelope,
    verifyOptions: VerifyNshPackageOptions,
    createDefinition: (verified: VerifiedNshPackage) => PluginDefinition<any, any>,
    action: UserActionRef,
  ) {
    if (this.closed) throw new Error("@looi:runtimeLocalRuntimeIsNotReady");
    assertFreshUiAction(action);
    if (action.ui_session_id !== this.uiSessionId) {
      throw new Error("@looi:runtimeThisPageExpiredOpenItAgain");
    }
    return this.plugins.installMarketplacePackage(rawArchive, verifyOptions, createDefinition);
  }
  attachFaceController(controller: RobotFaceController | undefined) { this.faceHub.attachController(controller); }
  attachNativeDeviceCamera(
    port: NativeDeviceCameraPort | null,
    options?: VisionBrokerAttachOptions,
  ) {
    const effectiveOptions =
      options ?? (process.env.LOOI_IOS_SIMULATOR === "1" ? { useSampleStream: true } : undefined);
    this.visionBroker.attachNativePort(port, effectiveOptions);
  }
  setDeviceCameraForegroundActive(active: boolean) {
    this.visionBroker.setForegroundActive(active);
  }
  attachNativeDeviceMotion(
    port: NativeDeviceMotionPort | null,
    options?: MotionBrokerAttachOptions,
  ) {
    const effectiveOptions =
      options ?? (process.env.LOOI_IOS_SIMULATOR === "1" ? { useSampleStream: true } : undefined);
    this.motionBroker.attachNativePort(port, effectiveOptions);
  }
  setDeviceMotionForegroundActive(active: boolean) {
    this.motionBroker.setForegroundActive(active);
  }
  attachNativeLanRoom(port: NativeLanRoomPort | null) {
    this.lanRoomBroker.attachNativePort(port);
  }
  setLanRoomForegroundActive(active: boolean) {
    this.lanRoomBroker.setForegroundActive(active);
  }
  setPluginAiBridge(bridge: DualLoopAiBusBridge) { this.plugins.ai.setBridge(bridge); }
  pluginAmbientVoiceContext() { return this.plugins.ai.renderAmbientInstructions(); }
  pluginVoiceTools() { return this.plugins.ai.voiceTools(); }
  evaluateVoiceToolCall(call: { toolName: string; arguments: Record<string, unknown> }) {
    return this.plugins.ai.evaluateToolCall({
      channel: "voice",
      toolName: call.toolName,
      approvalMode: "ask",
      arguments: call.arguments,
    });
  }
  evaluateVoiceUserTurn(text: string) {
    return this.plugins.ai.evaluateUserTurn({ channel: "voice", text });
  }
  assembleVoiceTurn(text: string) {
    return this.plugins.ai.assembleTurn({ channel: "voice", userText: text });
  }
  private async runPluginBackgroundTask(
    pluginId: string,
    prompt: string,
  ): Promise<{ readonly taskId: string; readonly answer: string }> {
    const text = prompt.trim();
    if (!text) {
      throw Object.assign(new Error("@looi:runtimeEnterAMessage"), {
        stage: `plugin:${pluginId}:ai.runBackgroundTask`,
        code: "ERR_PLUGIN_EMPTY_PROMPT",
      });
    }
    if (this.closed || this.loginPending || Boolean(this.llmOAuthAbort)) {
      throw Object.assign(new Error("@looi:runtimeATaskOrSigninIsActiveStopIt"), {
        stage: `plugin:${pluginId}:ai.runBackgroundTask`,
        code: "ERR_PLUGIN_RUNTIME_BUSY",
      });
    }
    if (this.activePluginTaskIds.size >= 1) {
      throw Object.assign(new Error("Another plugin background task is already running"), {
        stage: `plugin:${pluginId}:ai.runBackgroundTask`,
        code: "ERR_PLUGIN_BACKGROUND_TASK_BUSY",
      });
    }
    const turnGuard = await this.plugins.ai.evaluateUserTurn({
      channel: "task",
      text,
    });
    if (turnGuard?.decision === "block") {
      const message =
        turnGuard.spokenReply && turnGuard.spokenReply !== turnGuard.reason
          ? `${turnGuard.spokenReply} (${turnGuard.reason})`
          : turnGuard.reason;
      throw Object.assign(new Error(message), {
        stage: turnGuard.stage ?? `${turnGuard.pluginId}:ai.interceptUserTurn`,
        code: turnGuard.code ?? "ERR_PLUGIN_USER_TURN_BLOCKED",
        ...(turnGuard.spokenReply ? { spokenReply: turnGuard.spokenReply } : {}),
        ...(turnGuard.cause !== undefined ? { cause: turnGuard.cause } : {}),
      });
    }
    if (turnGuard?.decision === "handled") {
      return {
        taskId: "",
        answer: turnGuard.answer ?? turnGuard.spokenReply ?? "",
      };
    }
    if (!this.executor) {
      throw Object.assign(new Error("@looi:runtimeConfigureAChatModelInConnectionsFirst"), {
        stage: `plugin:${pluginId}:ai.runBackgroundTask`,
        code: "ERR_PLUGIN_MODEL_UNCONFIGURED",
      });
    }
    const bgTaskId = `task_plugin_${randomUUID()}`;
    this.activePluginTaskIds.add(bgTaskId);
    try {
      const result = await this.executor.run(text, {
        taskId: bgTaskId,
        lane: "plugin",
        sessionId: `plugin_${pluginId}_${randomUUID()}`,
        mode: "text",
        approvalMode: "ask",
        onStep: (event) => {
          if (event.interaction) {
            try {
              this.executor?.respond(
                bgTaskId,
                event.interaction.id,
                event.interaction.kind === "approval"
                  ? { outcome: "rejected" }
                  : { cancelled: true },
              );
            } catch {
              // Interaction already settled or task cancelled.
            }
          }
        },
      });
      return { taskId: result.taskId, answer: result.answer };
    } finally {
      this.activePluginTaskIds.delete(bgTaskId);
    }
  }
  subscribePlugins(listener: (event: PluginEvent) => void) { return this.plugins.subscribe(listener); }
  async refreshPlugin(id: string) { await this.plugins.get(id).auth?.refresh(); return this.pluginsSnapshot(); }
  private assertPluginAction(action: UserActionRef) {
    if (this.closed) throw new Error("Runtime is closed");
    assertFreshUiAction(action);
    if (action.ui_session_id !== this.uiSessionId) throw new Error("@looi:runtimeThisPageExpiredOpenItAgain");
  }
  async setPluginEnabled(id: string, enabled: boolean, action: UserActionRef) { this.assertPluginAction(action); return this.plugins.setEnabled(id, enabled); }
  async configurePlugin(id: string, enabled: boolean, values: Record<string, string>, action: UserActionRef) { this.assertPluginAction(action); return this.plugins.configure(id, enabled, values); }
  async sendPluginCommand<TCommand = unknown, TResult = unknown>(id: string, command: TCommand, action: UserActionRef): Promise<TResult> { this.assertPluginAction(action); return this.plugins.sendCommand<TCommand, TResult>(id, command); }
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
      await this.closeExecutorForRebuild();
      this.setExecutorFromSelection(envelope.active);
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
        await this.closeExecutorForRebuild();
        this.setExecutorFromSelection(envelope.active);
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

  async stopVoiceMotion(): Promise<BodyStatusSnapshot> {
    return this.body.stopNonPluginMotion();
  }

  redactSecrets(text: string): string {
    if (!text) return text;
    let scrubbed = text;
    try {
      const envelope = this.credentialStore.readEnvelope();
      for (const cred of Object.values(envelope.credentials)) {
        if (!cred) continue;
        if (cred.type === "api_key" && cred.key && cred.key.length >= 4) {
          scrubbed = scrubbed.replaceAll(cred.key, "[redacted]");
        } else if (cred.type === "oauth") {
          const oauth = cred as unknown as { access?: string; refresh?: string };
          if (oauth.access && oauth.access.length >= 4) {
            scrubbed = scrubbed.replaceAll(oauth.access, "[redacted]");
          }
          if (oauth.refresh && oauth.refresh.length >= 4) {
            scrubbed = scrubbed.replaceAll(oauth.refresh, "[redacted]");
          }
        }
      }
      for (const slot of ["home", "voice"]) {
        const rawSlot = this.vault.get(slot);
        if (!rawSlot) continue;
        try {
          const parsed = JSON.parse(rawSlot) as Record<string, unknown>;
          for (const val of Object.values(parsed)) {
            if (typeof val === "string" && val.length >= 8 && !val.startsWith("http")) {
              scrubbed = scrubbed.replaceAll(val, "[redacted]");
            }
          }
        } catch {
          // Non-JSON slot or empty.
        }
      }
      const githubToken = readGitHubToken(this.vault);
      if (githubToken && githubToken.length >= 4) {
        scrubbed = scrubbed.replaceAll(githubToken, "[redacted]");
      }
    } catch {
      // Never throw during error redaction.
    }
    return scrubbed;
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

  taskPage(offset = 0) {
    if (this.closed) throw new Error("@looi:runtimeRuntimeClosed");
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new Error("@looi:runtimeInvalidTaskPage");
    const { total, entries } = this.storage.taskHistoryPage(offset, 10);
    return {
      total,
      offset,
      items: entries.map((entry) => {
        if (!("spanId" in entry)) return entry;
        const { id, voiceToolName, prompt, state, updatedAt } = voiceToolTask(entry, directVoiceToolName(entry)!);
        return { id, voiceToolName, prompt, state, updatedAt };
      }),
    };
  }

  taskDetails(id: string) {
    if (this.closed) throw new Error("@looi:runtimeRuntimeClosed");
    if (id.startsWith(voiceToolTaskPrefix)) {
      const observation = this.storage.observation(id.slice(voiceToolTaskPrefix.length));
      const name = observation && directVoiceToolName(observation);
      if (!observation || !name) throw new Error("@looi:runtimeTaskNotFound");
      return {
        ...voiceToolTask(observation, name),
        sessionId: String(observation.attributes["session.id"] ?? ""),
        steps: [],
        homeActions: [],
        observations: this.storage.traceObservations(observation.traceId),
      };
    }
    const task = this.executor ? this.executor.getTask(id) : this.storage.task(id);
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
    return { ...task, homeActions, bodyActions,
      observations: task.trace ? this.storage.traceObservations(task.trace.traceId) : [] };
  }

  subscribeTaskActivity(listener: (historyChanged: boolean) => void): () => void {
    this.taskActivityListeners.add(listener);
    return () => this.taskActivityListeners.delete(listener);
  }

  private emitTaskActivity(historyChanged: boolean) {
    if (this.taskActivityListeners.size === 0) return;
    if (this.pendingTaskActivity) {
      this.pendingTaskActivity.historyChanged ||= historyChanged;
      return;
    }
    const update = { historyChanged };
    this.pendingTaskActivity = update;
    // Publish after the executor updates its in-memory snapshot following persistence.
    void Promise.resolve().then(() => {
      this.pendingTaskActivity = undefined;
      for (const listener of this.taskActivityListeners) listener(update.historyChanged);
    });
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

  activeConversationId(): string {
    return this.conversationId;
  }

  adoptConversationSession(
    sessionId: string,
    action: UserActionRef,
  ): { conversationId: string } {
    if (
      this.closed ||
      this.busy ||
      this.loginPending ||
      Boolean(this.llmOAuthAbort)
    ) {
      throw new Error("@looi:runtimeStopTheCurrentTaskOrCancelSigninFirst");
    }
    this.assertUiAction(action);
    const trimmed = typeof sessionId === "string" ? sessionId.trim() : "";
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(trimmed)) {
      throw new Error("@looi:runtimeInvalidScheduleSession");
    }
    const raw = this.vault.get("model");
    if (raw) {
      this.credentialStore.updateEnvelope((draft) => {
        draft.conversationId = trimmed;
        return draft;
      });
      this.conversationPersisted = true;
    } else {
      this.conversationPersisted = false;
    }
    this.conversationId = trimmed;
    return { conversationId: this.conversationId };
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
      await this.closeExecutorForRebuild();
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
            this.setExecutorFromSelection(prevEnvelope.active);
          }
        }
        throw error;
      }
      this.conversationId = conversationId;
      this.conversationPersisted = true;
      syncLooiModelsRegistry(this.modelsRegistry, nextEnvelope);
      this.setExecutorFromSelection(nextEnvelope.active!);
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
    this.registerGitHubSecret();
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
      redactSecrets: (text) => this.redactSecrets(text),
      taskPersistence: {
        load: this.storage.tasks.load,
        save: (task) => {
          this.storage.tasks.save(task);
          this.handlePersistedTaskUpdate(task);
          this.emitTaskActivity(true);
        },
      },
      approvalUiSessionId: this.uiSessionId,
      requireApprovalForAllWrites: true,
      maxConcurrentTasks: 3,
      laneLimits: {
        foreground: 1,
        plugin: 1,
        schedule: 1,
      },
      deadlineMs: 600_000,
      systemPrompt:
        deviceControlInstructions +
        "\n家居查询使用 list_home_devices；仅在用户要求控制时，再用返回的 entity_id 和 connectionId 调用 control_home_device。不要先检查底座状态。工具未提供时，说明当前未启用对应能力。" +
        "\nPR 与云端任务只读查询：使用 github_pr_status 查询 GitHub PR 状态、checks 与 reviews；使用 codex_cloud_status 查询 Codex 云端任务状态。需要定时或延后无打扰复查同一 PR/任务时，调用 manage_schedule（origin 设为 \"agent_inferred\"，executionPolicy 设为 \"check_only\"，使用唯一 dedupeKey，prompt 必须自包含完整 owner/repo/pullNumber 或 taskId 等标识）。",
      additionalTools: [
        createGitHubPrStatusTool({ vault: this.vault }),
      ],
      taskTools: context => {
        const pluginContribution = this.plugins.contribution(context);
        const taskSessionId =
          this.executor?.getTask(context.taskId)?.sessionId ??
          (context.taskId === this.taskId ? this.activeForegroundSessionId : undefined);
        const scheduleTools = createScheduleTools({
          engine: this.scheduleEngine,
          sourceSessionId: taskSessionId,
          sourceTaskId: context.taskId,
          checkOnly: context.scheduleExecutionPolicy === "check_only",
          onMutated: () => {
            if (context.taskId === this.taskId) {
              this.mutatedScheduleTaskIds.add(context.taskId);
            }
          },
        });
        const tools: AgentTool<any>[] = [
          ...pluginContribution.tools,
          ...(homeEnabled
            ? createHomeTools({
                home: this.home,
                database: this.database,
                getActiveTaskId: () => context.taskId,
              })
            : []),
          ...(bodyEnabled
            ? createBodyTools({
                body: this.body,
                database: this.database,
                getActiveTaskId: () => context.taskId,
              })
            : []),
          ...scheduleTools,
        ];
        return {
          tools,
          ...(pluginContribution.skillPaths ? { skillPaths: pluginContribution.skillPaths } : {}),
        };
      },
      beforeToolCall: call =>
        this.plugins.ai.evaluateToolCall({
          channel: "task",
          toolName: call.toolName,
          approvalMode: call.approvalMode,
          arguments: call.arguments,
          scheduleExecutionPolicy: call.scheduleExecutionPolicy,
        }),
      assembleTurnContext: async turn => {
        const draft = await this.plugins.ai.assembleTurn({
          channel: "task",
          userText: turn.prompt,
        });
        const contextText = draft.contextBlocks
          .map(block => block.text.trim())
          .filter(Boolean)
          .join("\n");
        const images = draft.ephemeralImages.map(img => ({
          type: "image" as const,
          data: uint8ArrayToBase64(img.bytes),
          mimeType: img.mimeType,
        }));
        if (!contextText && images.length === 0) return undefined;
        return {
          ...(contextText ? { contextText } : {}),
          ...(images.length > 0 ? { images } : {}),
        };
      },
      approvalRequiredTools: homeEnabled ? ["control_home_device"] : [],
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
      const turnGuard = await this.plugins.ai.evaluateUserTurn({
        channel: "task",
        text,
      });
      if (turnGuard?.decision === "block") {
        const message =
          turnGuard.spokenReply && turnGuard.spokenReply !== turnGuard.reason
            ? `${turnGuard.spokenReply} (${turnGuard.reason})`
            : turnGuard.reason;
        throw Object.assign(
          new Error(message),
          {
            stage: turnGuard.stage ?? `${turnGuard.pluginId}:ai.interceptUserTurn`,
            code: turnGuard.code ?? "ERR_PLUGIN_USER_TURN_BLOCKED",
            ...(turnGuard.spokenReply ? { spokenReply: turnGuard.spokenReply } : {}),
            ...(turnGuard.cause !== undefined ? { cause: turnGuard.cause } : {}),
          },
        );
      }
      if (turnGuard?.decision === "handled") {
        return {
          answer: turnGuard.answer ?? turnGuard.spokenReply ?? "",
          taskId: "",
          runtimeExited: true,
        };
      }
      if (!this.executor) throw new Error("@looi:runtimeConfigureAChatModelInConnectionsFirst");
      if (!this.conversationPersisted && this.vault.get("model")) {
        this.credentialStore.updateEnvelope((draft) => {
          draft.conversationId = this.conversationId;
          return draft;
        });
        this.conversationPersisted = true;
      }
      this.lastDefaultLanguage = options.defaultLanguage ?? this.lastDefaultLanguage;
      this.activeForegroundSessionId = sessionId;
      this.taskId = `task_${randomUUID()}`;
      const result = await this.executor.run(text, {
        taskId: this.taskId,
        lane: "foreground",
        sessionId,
        mode: options.mode,
        approvalMode: options.approvalMode,
        defaultLanguage: options.defaultLanguage,
        traceContext: options.traceContext,
        onStep,
        onShellOutput: options.onShellOutput,
      });
      const manageScheduleMutated = this.mutatedScheduleTaskIds.has(result.taskId);
      const completedTask =
        this.executor.getTask(result.taskId) ?? this.storage.task(result.taskId);
      if (completedTask && completedTask.state === "succeeded") {
        this.postTurnObserver.maybeObserve({
          task: completedTask,
          result,
          userPrompt: text,
          manageScheduleMutated,
        });
      }
      return {
        answer: result.answer,
        taskId: result.taskId,
        runtimeExited: result.runtimeExited,
      };
    } finally {
      if (this.taskId) {
        this.mutatedScheduleTaskIds.delete(this.taskId);
      }
      if (options.mode === "voice") this.voiceConversation.finish();
      this.activeForegroundSessionId = undefined;
      this.busy = false;
      this.taskId = undefined;
    }
  }

  respond(taskId: string, requestId: string, answer: AgentInteractionAnswer) {
    if (this.closed || !this.executor) throw new Error("@looi:runtimeRuntimeUnavailable");
    this.executor.respond(taskId, requestId, answer);
  }

  respondTask(taskId: string, requestId: string, answer: AgentInteractionAnswer) {
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

  async cancelTask(taskId: string): Promise<AgentStopResult> {
    if (this.closed || !this.executor) throw new Error("@looi:runtimeRuntimeUnavailable");
    if (taskId === this.taskId) {
      return this.cancel();
    }
    return this.executor.cancel(taskId);
  }

  async cancel(): Promise<AgentStopResult> {
    this.cancelMiotLogin();
    this.cancelProviderOAuth();
    this.home.suspend();
    void this.body.control({ action: "stop" });
    const taskId = this.taskId;
    const result: AgentStopResult =
      taskId && this.executor
        ? await this.executor.cancel(taskId)
        : { state: "cancelled", runtimeExited: true, confirmed: true };
    return result;
  }

  async close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.cancelProviderOAuth();
    this.faceHub.attachController(undefined);
    this.visionBroker.setForegroundActive(false);
    this.motionBroker.setForegroundActive(false);
    this.lanRoomBroker.setForegroundActive(false);
    this.home.close();
    this.body.close();
    for (const bgTaskId of this.activePluginTaskIds) {
      void this.executor?.cancel(bgTaskId).catch(() => {});
    }
    this.closing = (async () => {
      try {
        await this.scheduleEngine.close().catch(() => {});
        await this.executor?.close();
      } finally {
        this.attachedSchedulePort = null;
        this.attachedScheduleHost = undefined;
        this.scheduleActivityListeners.clear();
        this.scheduleInteractionListeners.clear();
        this.activeScheduleInteractions.clear();
        this.mutatedScheduleTaskIds.clear();
        this.pendingMergedRules.clear();
        this.handledSettledRuns.clear();
        try { await this.plugins.close(); }
        finally {
          this.lanRoomBroker.close();
          this.visionBroker.close();
          this.motionBroker.close();
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
    const willRebuildExecutor =
      shouldSetActive || prevEnvelope.active?.providerId === input.providerId;
    const prevConversationId = this.conversationId;
    const prevConversationPersisted = this.conversationPersisted;
    const nextConversationId = shouldSetActive
      ? `session_${randomUUID()}`
      : this.conversationId;

    this.busy = true;
    try {
      if (willRebuildExecutor) {
        await this.closeExecutorForRebuild();
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
          willRebuildExecutor &&
          prevEnvelope.active &&
          prevEnvelope.credentials[prevEnvelope.active.providerId]
        ) {
          let customValid = true;
          if (prevEnvelope.active.providerId === "custom") {
            customValid = this.isValidCustomEndpoint(prevEnvelope.custom);
          }
          if (customValid) {
            this.setExecutorFromSelection(prevEnvelope.active);
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
        willRebuildExecutor &&
        nextEnvelope.active &&
        nextEnvelope.credentials[nextEnvelope.active.providerId]
      ) {
        this.setExecutorFromSelection(nextEnvelope.active);
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
    const willRebuild = changed || !this.executor;

    const prevEnvelope = envelope;
    const prevConversationId = this.conversationId;
    const prevConversationPersisted = this.conversationPersisted;
    const nextConversationId = changed
      ? `session_${randomUUID()}`
      : this.conversationId;

    this.busy = true;
    try {
      if (willRebuild) {
        await this.closeExecutorForRebuild();
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
          willRebuild &&
          prevEnvelope.active &&
          prevEnvelope.credentials[prevEnvelope.active.providerId]
        ) {
          let customValid = true;
          if (prevEnvelope.active.providerId === "custom") {
            customValid = this.isValidCustomEndpoint(prevEnvelope.custom);
          }
          if (customValid) {
            this.setExecutorFromSelection(prevEnvelope.active);
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
        willRebuild &&
        nextEnvelope.active &&
        nextEnvelope.credentials[nextEnvelope.active.providerId]
      ) {
        this.setExecutorFromSelection(nextEnvelope.active);
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
        await this.closeExecutorForRebuild();
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
        await this.closeExecutorForRebuild();
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
        this.setExecutorFromSelection(nextEnvelope.active!);
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

  async attachNativeSchedule(
    hostOrPort: NativeScheduleHost | NativeSchedulePort | null,
    options?: { foregroundActive?: boolean },
  ): Promise<void> {
    if (this.closed) return;
    if (hostOrPort === null) {
      this.attachedScheduleHost = undefined;
      this.attachedSchedulePort = null;
    } else if (isNativeScheduleHost(hostOrPort)) {
      this.attachedScheduleHost = hostOrPort;
      this.attachedSchedulePort = createScheduleNativePort(hostOrPort);
    } else {
      this.attachedScheduleHost = undefined;
      this.attachedSchedulePort = hostOrPort;
    }
    await this.scheduleEngine.attachNativePort(this.attachedSchedulePort);
    if (typeof options?.foregroundActive === "boolean") {
      this.scheduleForegroundActive = options.foregroundActive;
      this.attachedScheduleHost?.setForeground(options.foregroundActive);
      await this.scheduleEngine.setForegroundActive(options.foregroundActive);
    }
  }

  async setScheduleForegroundActive(active: boolean): Promise<void> {
    if (this.closed) return;
    this.scheduleForegroundActive = active;
    this.attachedScheduleHost?.setForeground(active);
    await this.scheduleEngine.setForegroundActive(active);
  }

  async handleNativeScheduleEvents(
    events?: readonly NativeScheduleEvent[],
  ): Promise<{ tappedRule?: ScheduleRule; tappedRun?: ScheduleRunRecord }> {
    if (this.closed) return {};
    return this.scheduleEngine.handleNativeEvents(events);
  }

  async reconcileScheduleDueRules(): Promise<ScheduleRunRecord[]> {
    if (this.closed) return [];
    return this.scheduleEngine.reconcileDueRules();
  }

  scheduleExactAlarmStatus(): NativeScheduleExactAlarmStatus | null {
    return this.attachedScheduleHost?.exactAlarmStatus() ?? null;
  }

  async openScheduleExactAlarmSettings(): Promise<boolean> {
    if (this.closed) throw new Error("@looi:runtimeRuntimeClosed");
    if (this.attachedScheduleHost) {
      return this.attachedScheduleHost.openExactAlarmSettings();
    }
    if (this.attachedSchedulePort?.openExactAlarmSettings) {
      await this.attachedSchedulePort.openExactAlarmSettings();
      return true;
    }
    return false;
  }

  async requestSchedulePermission(
    action?: UserActionRef,
  ): Promise<NativePermissionStatusResult> {
    if (action) this.assertUiAction(action);
    else if (this.closed) throw new Error("@looi:runtimeRuntimeClosed");
    if (!this.attachedSchedulePort) {
      return { notification: "unavailable" };
    }
    const status = await this.attachedSchedulePort.requestPermission();
    this.emitScheduleActivity({ kind: "settings_updated" });
    return status;
  }

  scheduleSnapshot(): Promise<ScheduleSnapshot> {
    if (this.closed) throw new Error("@looi:runtimeRuntimeClosed");
    return this.scheduleEngine.snapshot();
  }

  scheduleSnapshotSync(): Omit<ScheduleSnapshot, "permissionStatus"> {
    if (this.closed) throw new Error("@looi:runtimeRuntimeClosed");
    return this.scheduleEngine.snapshotSync();
  }

  subscribeScheduleActivity(
    listener: (event: ScheduleActivityNotification) => void,
  ): () => void {
    this.scheduleActivityListeners.add(listener);
    return () => this.scheduleActivityListeners.delete(listener);
  }

  subscribeScheduleInteractions(
    listener: (event: ScheduleInteractionEvent) => void,
  ): () => void {
    this.scheduleInteractionListeners.add(listener);
    return () => this.scheduleInteractionListeners.delete(listener);
  }

  pendingScheduleInteractions(): Array<
    ScheduleInteractionEvent & { type: "requested" }
  > {
    return Array.from(this.activeScheduleInteractions.values());
  }

  listScheduleRules(filter?: {
    state?: ScheduleRuleState;
    origin?: ScheduleOrigin;
  }): ScheduleRule[] {
    if (this.closed) throw new Error("@looi:runtimeRuntimeClosed");
    return this.scheduleEngine.listRules(filter);
  }

  listScheduleRuns(ruleId?: string, limit?: number): ScheduleRunRecord[] {
    if (this.closed) throw new Error("@looi:runtimeRuntimeClosed");
    return this.scheduleEngine.listRuns(ruleId, limit);
  }

  createScheduleRule(
    input: CreateScheduleRuleInput,
    action?: UserActionRef,
  ): { rule: ScheduleRule; merged: boolean } {
    if (action) this.assertUiAction(action);
    else if (this.closed) throw new Error("@looi:runtimeRuntimeClosed");
    return this.scheduleEngine.createRule(input);
  }

  updateScheduleRule(
    id: string,
    patch: UpdateScheduleRuleInput,
    action?: UserActionRef,
  ): ScheduleRule {
    if (action) this.assertUiAction(action);
    else if (this.closed) throw new Error("@looi:runtimeRuntimeClosed");
    return this.scheduleEngine.updateRule(id, patch);
  }

  setScheduleRuleEnabled(
    id: string,
    enabled: boolean,
    action?: UserActionRef,
  ): ScheduleRule {
    if (action) this.assertUiAction(action);
    else if (this.closed) throw new Error("@looi:runtimeRuntimeClosed");
    return this.scheduleEngine.setRuleEnabled(id, enabled);
  }

  cancelScheduleRule(id: string, action?: UserActionRef): Promise<ScheduleRule> {
    if (action) this.assertUiAction(action);
    else if (this.closed) throw new Error("@looi:runtimeRuntimeClosed");
    return this.scheduleEngine.cancelRule(id);
  }

  deleteScheduleRule(id: string, action?: UserActionRef): Promise<boolean> {
    if (action) this.assertUiAction(action);
    else if (this.closed) throw new Error("@looi:runtimeRuntimeClosed");
    return this.scheduleEngine.deleteRule(id);
  }

  runScheduleRuleNow(
    id: string,
    action?: UserActionRef,
  ): Promise<ScheduleRunRecord> {
    if (action) this.assertUiAction(action);
    else if (this.closed) throw new Error("@looi:runtimeRuntimeClosed");
    return this.scheduleEngine.runNow(id);
  }

  updateScheduleSettings(
    patch: Partial<ScheduleSettings>,
    action?: UserActionRef,
  ): ScheduleSettings {
    if (action) this.assertUiAction(action);
    else if (this.closed) throw new Error("@looi:runtimeRuntimeClosed");
    return this.scheduleEngine.updateSettings(patch);
  }

  addQuietHoursWindow(
    input: Omit<QuietHoursWindow, "id"> & { id?: string },
    action?: UserActionRef,
  ): ScheduleSettings {
    if (action) this.assertUiAction(action);
    else if (this.closed) throw new Error("@looi:runtimeRuntimeClosed");
    return this.scheduleEngine.addQuietHoursWindow(input);
  }

  updateQuietHoursWindow(
    id: string,
    patch: Partial<Omit<QuietHoursWindow, "id">>,
    action?: UserActionRef,
  ): ScheduleSettings {
    if (action) this.assertUiAction(action);
    else if (this.closed) throw new Error("@looi:runtimeRuntimeClosed");
    return this.scheduleEngine.updateQuietHoursWindow(id, patch);
  }

  removeQuietHoursWindow(
    id: string,
    action?: UserActionRef,
  ): ScheduleSettings {
    if (action) this.assertUiAction(action);
    else if (this.closed) throw new Error("@looi:runtimeRuntimeClosed");
    return this.scheduleEngine.removeQuietHoursWindow(id);
  }

  setQuietHoursEnabled(
    enabled: boolean,
    action?: UserActionRef,
  ): ScheduleSettings {
    if (action) this.assertUiAction(action);
    else if (this.closed) throw new Error("@looi:runtimeRuntimeClosed");
    return this.scheduleEngine.setQuietHoursEnabled(enabled);
  }

  isQuietHoursNow(): boolean {
    if (this.closed) return false;
    return this.scheduleEngine.isQuietHoursNow();
  }

  githubCredentialStatus(): GitHubCredentialStatus {
    if (this.closed) throw new Error("@looi:runtimeRuntimeClosed");
    return githubCredentialStatus(this.vault);
  }

  saveGitHubToken(
    token: string,
    action: UserActionRef,
  ): GitHubCredentialStatus {
    this.assertUiAction(action);
    const status = saveGitHubToken(this.vault, token);
    this.registerGitHubSecret();
    return status;
  }

  async verifyGitHubToken(
    action: UserActionRef,
  ): Promise<GitHubTokenVerificationResult> {
    this.assertUiAction(action);
    return verifyGitHubToken(this.vault);
  }

  clearGitHubToken(action: UserActionRef): GitHubCredentialStatus {
    this.assertUiAction(action);
    return clearGitHubToken(this.vault);
  }

  private assertUiAction(action: UserActionRef): void {
    if (this.closed) throw new Error("@looi:runtimeRuntimeClosed");
    assertFreshUiAction(action);
    if (action.ui_session_id !== this.uiSessionId) {
      throw new Error("@looi:runtimeThisPageExpiredOpenItAgain");
    }
  }

  private registerGitHubSecret(): void {
    const token = readGitHubToken(this.vault);
    if (token && token.length >= 4) {
      this.tracer.registerSecret(token);
    }
  }

  private resolveCurrentModelStreamConfig() {
    const envelope = this.credentialStore.readEnvelope();
    const active = envelope.active;
    if (!active) return undefined;
    const cred = envelope.credentials[active.providerId];
    if (!cred) return undefined;
    if (
      active.providerId === "custom" &&
      !this.isValidCustomEndpoint(envelope.custom)
    ) {
      return undefined;
    }
    let apiKey: string | undefined;
    if (cred.type === "api_key" && cred.key) {
      apiKey = cred.key;
    } else if (cred.type === "oauth") {
      const oauth = cred as unknown as { access?: string };
      if (oauth.access) apiKey = oauth.access;
    }
    const baseUrl =
      active.providerId === "custom"
        ? envelope.custom?.baseUrl
        : resolveProviderBaseUrl(active.providerId);
    return {
      modelsRegistry: this.modelsRegistry,
      providerId: active.providerId,
      model: active.modelId,
      ...(apiKey ? { apiKey } : {}),
      ...(baseUrl ? { baseUrl } : {}),
    };
  }

  private async closeExecutorForRebuild(): Promise<void> {
    await this.scheduleEngine.cancelActiveRun().catch(() => {});
    for (const bgTaskId of this.activePluginTaskIds) {
      await this.executor?.cancel(bgTaskId).catch(() => {});
    }
    await this.executor?.close();
    this.executor = undefined;
  }

  private setExecutorFromSelection(selection: ActiveLlmSelection): void {
    this.executor = this.createExecutorForSelection(selection);
    if (!this.closed) {
      void this.scheduleEngine.reconcileDueRules().catch(() => {});
    }
  }

  private handlePersistedTaskUpdate(task: AgentTask): void {
    if (task.lane !== "schedule") return;
    const prev = this.activeScheduleInteractions.get(task.id);
    if (task.interaction) {
      if (!prev || prev.interaction.id !== task.interaction.id) {
        const runs = this.scheduleEngine.listRuns(undefined, 20);
        const matchedRun =
          runs.find((run) => run.taskId === task.id) ??
          runs.find((run) => run.sessionId === task.sessionId);
        const matchedRule = matchedRun
          ? this.scheduleEngine.getRule(matchedRun.ruleId)
          : undefined;
        const event: ScheduleInteractionEvent & { type: "requested" } = {
          type: "requested",
          taskId: task.id,
          ...(matchedRun
            ? {
                ruleId: matchedRun.ruleId,
                ruleTitle: matchedRule?.title ?? matchedRun.ruleTitle,
                runId: matchedRun.id,
              }
            : {}),
          interaction: task.interaction,
        };
        this.activeScheduleInteractions.set(task.id, event);
        for (const listener of this.scheduleInteractionListeners) {
          listener(event);
        }
      }
      return;
    }
    if (prev) {
      this.activeScheduleInteractions.delete(task.id);
      const cleared: ScheduleInteractionEvent = {
        type: "cleared",
        taskId: task.id,
        interactionId: prev.interaction.id,
        taskState: task.state,
      };
      for (const listener of this.scheduleInteractionListeners) {
        listener(cleared);
      }
    }
  }

  private emitScheduleActivity(event: ScheduleActivityEvent): void {
    if (event.kind === "run_settled" && event.runId) {
      if (this.handledSettledRuns.has(event.runId)) {
        this.handledSettledRuns.delete(event.runId);
        return;
      }
      const existingRun = this.scheduleEngine.getRun(event.runId);
      if (
        existingRun &&
        existingRun.status !== "missed" &&
        existingRun.status !== "skipped"
      ) {
        return;
      }
    }
    const rule = event.ruleId
      ? this.scheduleEngine.getRule(event.ruleId)
      : undefined;
    const run = event.runId
      ? this.scheduleEngine.getRun(event.runId)
      : undefined;
    const merged =
      event.kind === "rule_created" && event.ruleId
        ? this.pendingMergedRules.delete(event.ruleId)
        : undefined;
    const notification: ScheduleActivityNotification = {
      ...event,
      ...(rule ? { rule } : {}),
      ...(run ? { run } : {}),
      ...(merged !== undefined ? { merged } : {}),
      isQuietHours: this.scheduleEngine.isQuietHoursNow(),
      foregroundActive: this.scheduleForegroundActive,
      ...(event.kind === "run_settled" ? { notificationPosted: false } : {}),
    };
    for (const listener of this.scheduleActivityListeners) {
      listener(notification);
    }
  }

  private extractScheduleFailure(stage: string, error: unknown): ScheduleFailure {
    const info =
      error && typeof error === "object"
        ? (error as {
            stage?: unknown;
            code?: unknown;
            errno?: unknown;
            status?: unknown;
            statusCode?: unknown;
            reason?: unknown;
            message?: unknown;
          })
        : undefined;
    const rawStage = typeof info?.stage === "string" && info.stage ? info.stage : stage;
    const rawCode =
      typeof info?.code === "string" || typeof info?.code === "number"
        ? info.code
        : typeof info?.errno === "string" || typeof info?.errno === "number"
          ? info.errno
          : typeof info?.status === "number"
            ? info.status
            : typeof info?.statusCode === "number"
              ? info.statusCode
              : undefined;
    const rawReason =
      typeof info?.reason === "string" && info.reason
        ? info.reason
        : error instanceof Error
          ? error.message
          : String(error);
    return {
      stage: rawStage,
      ...(rawCode !== undefined ? { code: rawCode } : {}),
      reason: this.redactSecrets(rawReason),
    };
  }

  private async handleScheduleRunSettled(
    context: ScheduleDeliveryContext,
  ): Promise<void> {
    if (this.handledSettledRuns.size > 100) {
      this.handledSettledRuns.clear();
    }
    this.handledSettledRuns.add(context.run.id);
    let notificationPosted = false;
    let notificationError: ScheduleFailure | undefined;
    try {
      if (
        !context.foregroundActive &&
        context.run.importance === "notify" &&
        this.attachedSchedulePort
      ) {
        try {
          await this.attachedSchedulePort.postNotification({
            id: context.run.id,
            ruleId: context.rule.id,
            runId: context.run.id,
            sessionId: context.run.sessionId ?? context.rule.sourceSessionId,
            title: context.rule.title,
            body: context.run.summary?.trim() || context.rule.title,
            silent: context.isQuietHours,
          });
          notificationPosted = true;
        } catch (error) {
          notificationPosted = false;
          notificationError = this.extractScheduleFailure(
            "schedule.notification",
            error,
          );
        }
      }
    } finally {
      const notification: ScheduleActivityNotification = {
        kind: "run_settled",
        ruleId: context.rule.id,
        runId: context.run.id,
        rule: context.rule,
        run: context.run,
        isQuietHours: context.isQuietHours,
        foregroundActive: context.foregroundActive,
        notificationPosted,
        ...(notificationError ? { notificationError } : {}),
      };
      for (const listener of this.scheduleActivityListeners) {
        listener(notification);
      }
    }
  }
}
