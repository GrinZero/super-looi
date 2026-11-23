import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { UserActionRef } from "@super-looi/contracts";
import type {
  AgentInteractionAnswer,
  AgentStepEvent,
  AgentStopResult,
} from "@super-looi/runtime/agent/executor";
import type {
  ActiveLlmSelection,
  CompatibleApiProtocol,
  CustomEndpointConfig,
  LlmBrandId,
  ModelVaultEnvelope,
} from "@super-looi/runtime/agent/llm-providers";
import { AgentTaskStore } from "@super-looi/runtime/agent/task-store";
import { assertFreshUiAction } from "@super-looi/runtime/productivity/authorization";
import type {
  CreateScheduleRuleInput,
  NativePermissionStatusResult,
  NativeScheduleEvent,
  NativeSchedulePort,
  QuietHoursWindow,
  ScheduleActivityEvent,
  ScheduleExecutionPolicy,
  ScheduleFailure,
  ScheduleImportance,
  ScheduleOrigin,
  ScheduleReportSource,
  ScheduleRule,
  ScheduleRuleState,
  ScheduleRunRecord,
  ScheduleRunStatus,
  ScheduleRunTriggerReason,
  ScheduleSettings,
  ScheduleSnapshot,
  ScheduleToolFailure,
  ScheduleTrigger,
  UpdateScheduleRuleInput,
} from "@super-looi/runtime/schedule";
import { SqliteRuntimeStore } from "@super-looi/runtime/storage/sqlite";
import {
  createLangfuseTracer,
  type TraceContext,
} from "../../../packages/looi-runtime/src/telemetry/langfuse.js";
import type { RobotFaceController } from "../../../packages/looi-runtime/src/ui/robot-face-controller.js";
import {
  AgentRuntime,
  LlmModelManager,
  LlmOAuthFlow,
  TaskHistoryStore,
  type AgentRunInputOptions,
  type LlmBrandStatus,
  type LlmCatalogSnapshot,
  type LlmChannelStatus,
  type LlmModelItem,
  type LlmOAuthUiEvent,
  type ModelConfiguration,
} from "./agent.js";
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
import type { NativeCamera } from "./camera.js";
import type {
  MotionBrokerAttachOptions,
  NativeDeviceMotionPort,
} from "./device-motion.js";
import type {
  NativeDeviceCameraPort,
  VisionBrokerAttachOptions,
} from "./device-camera.js";
import { deviceControlInstructions } from "./device-control-instructions.js";
import type { HomeSettings } from "./home.js";
import { HomeController } from "./home-controller.js";
import type { NativeLanRoomPort } from "./lan-room.js";
import type { DualLoopAiBusBridge } from "./plugins/ai-bus.js";
import type { PluginDefinition, PluginEvent } from "./plugins/contracts.js";
import { PluginController } from "./plugins/controller.js";
import { uint8ArrayToBase64 } from "./plugins/embodied-drivers.js";
import type {
  NshPackageEnvelope,
  VerifiedNshPackage,
  VerifyNshPackageOptions,
} from "./plugins/package-loader.js";
import {
  ScheduleRuntime,
  type ScheduleActivityNotification,
  type ScheduleInteractionEvent,
} from "./schedule.js";
import type {
  NativeScheduleExactAlarmStatus,
  NativeScheduleHost,
} from "./schedule-native-adapter.js";
import {
  createBodyTools,
  createGitHubCredentials,
  createGitHubPrStatusTool,
  createHomeTools,
  readGitHubToken,
  type GitHubCredentialStatus,
  type GitHubCredentials,
  type GitHubTokenVerificationResult,
} from "./tools/index.js";
import type { Vault } from "./vault.js";
import { directVoiceToolName } from "./voice-tool-history.js";
import type { VoiceSchedule } from "./voice/tools/schedule.js";

export {
  AgentRuntime,
  LlmModelManager,
  LlmOAuthFlow,
  TaskHistoryStore,
  ScheduleRuntime,
  HomeController,
  PluginController,
};

export type {
  Vault,
  ModelConfiguration,
  LlmModelItem,
  LlmChannelStatus,
  LlmBrandStatus,
  LlmCatalogSnapshot,
  LlmOAuthUiEvent,
  AgentRunInputOptions,
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
  ScheduleActivityNotification,
  ScheduleInteractionEvent,
  NativePermissionStatusResult,
  NativeScheduleEvent,
  NativeSchedulePort,
  NativeScheduleHost,
  NativeScheduleExactAlarmStatus,
  GitHubCredentialStatus,
  GitHubTokenVerificationResult,
  GitHubCredentials,
  AgentStopResult,
  VoiceSchedule,
};

const AGENT_SYSTEM_PROMPT =
  deviceControlInstructions +
  "\n家居查询使用 list_home_devices；仅在用户要求控制时，再用返回的 entity_id 和 connectionId 调用 control_home_device。不要先检查底座状态。工具未提供时，说明当前未启用对应能力。" +
  "\nPR 与云端任务只读查询：使用 github_pr_status 查询 GitHub PR 状态、checks 与 reviews；使用 codex_cloud_status 查询 Codex 云端任务状态。需要定时或延后无打扰复查同一 PR/任务时，调用 manage_schedule（origin 设为 \"agent_inferred\"，executionPolicy 设为 \"check_only\"，使用唯一 dedupeKey，prompt 必须自包含完整 owner/repo/pullNumber 或 taskId 等标识）。";

/** Composition root for the mobile runtime; owns shared resources and domain sub-facades. */
export class MobileRuntime {
  private readonly database = new DatabaseSync("/home/looi.sqlite");
  private readonly storage = new SqliteRuntimeStore(this.database);
  readonly uiSessionId = `ui_${randomUUID()}`;
  readonly tracer = createLangfuseTracer({
    baseUrl: process.env.LANGFUSE_BASE_URL,
    publicKey: process.env.LANGFUSE_PUBLIC_KEY,
    secretKey: process.env.LANGFUSE_SECRET_KEY,
    onObservation: (observation) => {
      this.storage.saveObservation(observation);
      this.agent?.history.emit(Boolean(directVoiceToolName(observation)));
    },
  });
  readonly agent: AgentRuntime;
  readonly schedule: ScheduleRuntime;
  readonly home: HomeController;
  readonly body: BodyRuntime;
  readonly plugins: PluginController;
  readonly github: GitHubCredentials;
  private closed = false;
  private closing?: Promise<void>;

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

      this.home = new HomeController({
        vault,
        database: this.database,
        assertUiAction: (action) => this.assertUiAction(action),
        isClosed: () => this.closed,
      });

      this.body = new BodyRuntime({
        vault,
        assertUiAction: (action) => {
          if (!action) {
            this.assertOpen();
            throw new Error("@looi:runtimeThisPageExpiredOpenItAgain");
          }
          this.assertUiAction(action);
        },
      });

      this.plugins = new PluginController({
        database: this.database,
        body: this.body,
        tracer: this.tracer,
        traceContext: () => this.agent?.activeForegroundTraceContext("codex"),
        runBackgroundTask: ({ pluginId, prompt }) =>
          this.agent.runPluginBackgroundTask(pluginId, prompt),
        assertUiAction: (action) => this.assertUiAction(action),
        isClosed: () => this.closed,
      });

      this.github = createGitHubCredentials({
        vault,
        assertOpen: () => this.assertOpen(),
        assertUiAction: (action) => this.assertUiAction(action),
        onSecretChanged: (token) => this.registerGitHubSecret(token),
      });
      this.registerGitHubSecret();

      this.schedule = new ScheduleRuntime({
        store: this.storage,
        getExecutor: () => this.agent?.currentExecutor(),
        getModelStreamConfig: () => this.agent?.models.resolveStreamConfig(),
        tracer: this.tracer,
        defaultLanguage: () => this.agent?.defaultLanguage() ?? "zh-CN",
        assertUiAction: (action) => this.assertUiAction(action),
        isClosed: () => this.closed,
        redactSecrets: (text) => this.redactSecrets(text),
      });

      this.agent = new AgentRuntime({
        vault,
        database: this.database,
        storage: this.storage,
        tracer: this.tracer,
        uiSessionId: this.uiSessionId,
        assertUiAction: (action) => this.assertUiAction(action),
        redactSecrets: (text) => this.redactSecrets(text),
        isClosed: () => this.closed,
        systemPrompt: AGENT_SYSTEM_PROMPT,
        additionalTools: [createGitHubPrStatusTool({ vault: this.vault })],
        approvalRequiredTools: ["control_home_device"],
        resolveTaskTools: (context) => {
          const pluginContribution = this.plugins.contribution(context);
          const homeEnabled = this.home.configuration().mode !== "disabled";
          const bodyEnabled = this.body.configuration().mode !== "disabled";
          const scheduleTools = this.schedule.createTaskTools({
            taskId: context.taskId,
            sessionId: context.sessionId,
            checkOnly: context.scheduleExecutionPolicy === "check_only",
            isForegroundTask: context.isForegroundTask,
          });
          return {
            tools: [
              ...pluginContribution.tools,
              ...(homeEnabled
                ? createHomeTools({
                    home: this.home.raw,
                    database: this.database,
                    getActiveTaskId: () => context.taskId,
                    isLoginPending: () => this.home.isLoginPending,
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
            ],
            ...(pluginContribution.skillPaths
              ? { skillPaths: pluginContribution.skillPaths }
              : {}),
          };
        },
        evaluateUserTurn: (text) =>
          this.plugins.ai.evaluateUserTurn({ channel: "task", text }),
        beforeToolCall: (call) =>
          this.plugins.ai.evaluateToolCall({
            channel: "task",
            toolName: call.toolName,
            approvalMode: call.approvalMode,
            arguments: call.arguments,
            scheduleExecutionPolicy: call.scheduleExecutionPolicy,
          }),
        assembleTurnContext: async (turn) => {
          const draft = await this.plugins.ai.assembleTurn({
            channel: "task",
            userText: turn.prompt,
          });
          const contextText = draft.contextBlocks
            .map((block) => block.text.trim())
            .filter(Boolean)
            .join("\n");
          const images = draft.ephemeralImages.map((img) => ({
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
        beforeExecutorClose: () => this.schedule.cancelActiveRun(),
        onExecutorReady: () => {
          if (!this.closed) {
            void this.schedule.reconcileDueRules().catch(() => {});
          }
        },
        onTaskPersisted: (task) => this.schedule.handlePersistedTask(task),
        onForegroundTurnSucceeded: (input) =>
          this.schedule.observeForegroundTurn(input),
        onForegroundTurnFinished: (taskId) =>
          this.schedule.clearMutatedTask(taskId),
      });
    } catch (error) {
      this.storage.close();
      throw error;
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("@looi:runtimeRuntimeClosed");
  }

  private assertUiAction(action: UserActionRef): void {
    this.assertOpen();
    assertFreshUiAction(action);
    if (action.ui_session_id !== this.uiSessionId) {
      throw new Error("@looi:runtimeThisPageExpiredOpenItAgain");
    }
  }

  private registerGitHubSecret(token = readGitHubToken(this.vault)): void {
    if (token && token.length >= 4) {
      this.tracer.registerSecret(token);
    }
  }

  redactSecrets(text: string): string {
    if (!text) return text;
    let scrubbed = text;
    try {
      for (const secret of this.agent.models.secretValues()) {
        scrubbed = scrubbed.replaceAll(secret, "[redacted]");
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

  async cancelForeground(): Promise<AgentStopResult> {
    this.home.cancelMiotLogin();
    this.home.suspend();
    void this.body.control({ action: "stop" });
    return this.agent.cancelForeground();
  }

  async close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.agent.models.cancelOAuth();
    this.plugins.deactivateBrokers();
    this.home.close();
    this.body.close();
    this.closing = (async () => {
      try {
        await this.schedule.close().catch(() => {});
        await this.agent.close();
      } finally {
        try {
          await this.plugins.close();
        } finally {
          try {
            await this.tracer.shutdown();
          } finally {
            this.storage.close();
            this.releaseHost();
          }
        }
      }
    })();
    return this.closing;
  }

  // Phase 1 compatibility forwarding wrappers (removed in Phase 2).
  homeConfiguration() { return this.home.configuration(); }
  voiceHome() { return this.home.voiceHome(); }
  voiceSchedule() { return this.schedule.voiceSchedule(); }
  pluginsSnapshot() { return this.plugins.snapshots(); }
  startPlugins() { return this.plugins.startStartupPlugins(); }
  activeStagePresentation() { return this.plugins.activeStagePresentation(); }
  resumableStage() { return this.plugins.resumableStage(); }
  resumePluginStage(id?: string) { return this.plugins.resumeStage(id); }
  setPluginsForegroundActive(active: boolean) { this.plugins.setForegroundActive(active); }
  exitPluginStage(id: string) { this.plugins.exitStage(id); }
  reportPluginStageCrash(id: string, slot: "StageCanvas" | "StageCompanion" | "StageCapsule" | "StageDrawer", error: unknown) { return this.plugins.reportStageCrash(id, slot, error); }
  installMarketplacePlugin(rawArchive: string | Uint8Array | NshPackageEnvelope, verifyOptions: VerifyNshPackageOptions, createDefinition: (verified: VerifiedNshPackage) => PluginDefinition<any, any>, action: UserActionRef) { return this.plugins.installMarketplacePackage(rawArchive, verifyOptions, createDefinition, action); }
  attachFaceController(controller: RobotFaceController | undefined) { this.plugins.attachFaceController(controller); }
  attachNativeDeviceCamera(port: NativeDeviceCameraPort | null, options?: VisionBrokerAttachOptions) { this.plugins.attachNativeDeviceCamera(port, options); }
  setDeviceCameraForegroundActive(active: boolean) { this.plugins.setDeviceCameraForegroundActive(active); }
  attachNativeDeviceMotion(port: NativeDeviceMotionPort | null, options?: MotionBrokerAttachOptions) { this.plugins.attachNativeDeviceMotion(port, options); }
  setDeviceMotionForegroundActive(active: boolean) { this.plugins.setDeviceMotionForegroundActive(active); }
  attachNativeLanRoom(port: NativeLanRoomPort | null) { this.plugins.attachNativeLanRoom(port); }
  setLanRoomForegroundActive(active: boolean) { this.plugins.setLanRoomForegroundActive(active); }
  setPluginAiBridge(bridge: DualLoopAiBusBridge) { this.plugins.setAiBridge(bridge); }
  pluginAmbientVoiceContext() { return this.plugins.ambientVoiceContext(); }
  pluginVoiceTools() { return this.plugins.voiceTools(); }
  evaluateVoiceToolCall(call: { toolName: string; arguments: Record<string, unknown> }) { return this.plugins.evaluateVoiceToolCall(call); }
  evaluateVoiceUserTurn(text: string) { return this.plugins.evaluateVoiceUserTurn(text); }
  assembleVoiceTurn(text: string) { return this.plugins.assembleVoiceTurn(text); }
  subscribePlugins(listener: (event: PluginEvent) => void) { return this.plugins.subscribe(listener); }
  refreshPlugin(id: string) { return this.plugins.refresh(id); }
  setPluginEnabled(id: string, enabled: boolean, action: UserActionRef) { return this.plugins.setEnabled(id, enabled, action); }
  configurePlugin(id: string, enabled: boolean, values: Record<string, string>, action: UserActionRef) { return this.plugins.configure(id, enabled, values, action); }
  sendPluginCommand<TCommand = unknown, TResult = unknown>(id: string, command: TCommand, action: UserActionRef): Promise<TResult> { return this.plugins.sendCommand<TCommand, TResult>(id, command, action); }
  beginPluginLogin(id: string, action: UserActionRef) { return this.plugins.beginLogin(id, action); }
  cancelPluginLogin(id: string) { return this.plugins.cancelLogin(id); }
  logoutPlugin(id: string, action: UserActionRef) { return this.plugins.logout(id, action); }
  homeConnection() { return this.home.connection(); }
  configureHome(input: HomeSettings, action: UserActionRef) { return this.home.configure(input, action); }
  connectHome() { return this.home.connect(); }
  beginMiotLogin(region: NonNullable<HomeSettings["region"]>, action: UserActionRef) { return this.home.beginMiotLogin(region, action); }
  finishMiotLogin(attempt: number, callback: string, isCurrent: () => boolean) { return this.home.finishMiotLogin(attempt, callback, isCurrent); }
  cancelMiotLogin() { this.home.cancelMiotLogin(); }
  logoutMiot(action: UserActionRef) { return this.home.logoutMiot(action); }
  listHome(query = "", offset = 0) { return this.home.list(query, offset); }
  homeDashboard(lang: "zh-CN" | "en-US" = "zh-CN") { return this.home.dashboard(lang); }
  cachedHomeDashboard(lang: "zh-CN" | "en-US" = "zh-CN") { return this.home.cachedDashboard(lang); }
  setHomeSourceEnabled(source: "direct_miot" | "external_ha" | "simulation", enabled: boolean, action: UserActionRef) { return this.home.setSourceEnabled(source, enabled, action); }
  setHomeApplianceLayout(applianceId: string, patch: { span?: "1x1" | "2x1" | "2x2"; order?: number }) { return this.home.setApplianceLayout(applianceId, patch); }
  startHomeCamera(did: string) { return this.home.startCamera(did); }
  attachNativeCamera(camera: NativeCamera) { this.home.attachCamera(camera); }
  stopHomeCamera() { return this.home.stopCamera(); }
  panTiltHomeCamera(did: string, direction: "left" | "right" | "up" | "down", action: UserActionRef) { return this.home.panTiltCamera(did, direction, action); }
  controlHomeAppliance(command: { entity_id: string; domain: string; service: string; service_data?: Record<string, unknown>; timeout_ms?: number }, action: UserActionRef) { return this.home.controlAppliance(command, action); }
  bodyConfiguration() { return this.body.configuration(); }
  bodyStatus() { return this.body.status(); }
  attachNativeBle(port: NativeBlePort | null) { return this.body.attachNativeBle(port); }
  setBodyForegroundActive(active: boolean) { return this.body.setForegroundActive(active); }
  configureBody(input: Partial<BodyConfiguration>, action: UserActionRef) { return this.body.configure(input, action); }
  scanBodyDevices(timeoutMs?: number) { return this.body.scan(timeoutMs); }
  connectBodyDevice(target?: { deviceId?: string; deviceName?: string }) { return this.body.connect(target); }
  disconnectBody() { return this.body.disconnect(); }
  forgetSavedDock() { return this.body.forgetSavedDock(); }
  setSimulatedDock(docked: boolean) { return this.body.setSimulatedDock(docked); }
  controlBody(input: BodyControlInput, holder = "user_panel") { return this.body.control(input, holder); }
  stopBody() { return this.body.stop("user_stop"); }
  stopVoiceMotion() { return this.body.stopNonPluginMotion(); }
  startBodyDrive(action: "forward" | "backward" | "turn_left" | "turn_right") { return this.body.startDrive(action); }
  renewBodyDrive() { return this.body.renewDrive(); }
  setBodyDriveVector(speed: number, turn: number) { return this.body.setDriveVector(speed, turn); }
  readBodyPower() { return this.body.readPowerStatus(); }
  configuration() { return this.agent.models.configuration(); }
  taskPage(offset = 0) { return this.agent.history.page(offset); }
  taskDetails(id: string) { return this.agent.history.details(id); }
  subscribeTaskActivity(listener: (historyChanged: boolean) => void) { return this.agent.history.subscribe(listener); }
  newConversation(action: UserActionRef) { this.agent.newConversation(action); }
  activeConversationId() { return this.agent.activeConversationId(); }
  adoptConversationSession(sessionId: string, action: UserActionRef) { return this.agent.adoptConversationSession(sessionId, action); }
  configure(input: ModelConfiguration) { return this.agent.models.configureLegacy(input); }
  touchVoiceConversation() { this.agent.touchVoiceConversation(); }
  voiceConversationId() { return this.agent.voiceConversationId(); }
  run(prompt: string, action: UserActionRef, onStep: (event: AgentStepEvent) => void, options: AgentRunInputOptions = {}) { return this.agent.run(prompt, action, onStep, options); }
  respond(taskId: string, requestId: string, answer: AgentInteractionAnswer) { this.agent.respond(taskId, requestId, answer); }
  respondTask(taskId: string, requestId: string, answer: AgentInteractionAnswer) { this.agent.respond(taskId, requestId, answer); }
  sendTaskMessage(taskId: string, message: string, behavior: "steer" | "followUp", action: UserActionRef) { return this.agent.sendMessage(taskId, message, behavior, action); }
  async cancelTask(taskId: string): Promise<AgentStopResult> { if (taskId === this.agent.activeForegroundTaskId()) return this.cancelForeground(); return this.agent.cancelTask(taskId); }
  cancel() { return this.cancelForeground(); }
  llmSnapshot() { return this.agent.models.snapshot(); }
  refreshProviderModels(providerId: string, signal?: AbortSignal) { return this.agent.models.refreshModels(providerId, signal); }
  saveProviderApiKey(input: { providerId: string; apiKey?: string; modelId?: string; custom?: CustomEndpointConfig; setActive?: boolean }, action: UserActionRef) { return this.agent.models.saveApiKey(input, action); }
  selectActiveModel(input: { providerId: string; modelId: string; addCustomModel?: boolean }, action: UserActionRef) { return this.agent.models.selectActive(input, action); }
  removeProviderCredential(providerId: string, action: UserActionRef) { return this.agent.models.removeCredential(providerId, action); }
  startProviderOAuth(providerId: string, action: UserActionRef, onEvent: (event: LlmOAuthUiEvent) => void) { return this.agent.models.startOAuth(providerId, action, onEvent); }
  submitProviderOAuthCallback(callbackUrl: string) { this.agent.models.submitOAuthCallback(callbackUrl); }
  cancelProviderOAuth() { this.agent.models.cancelOAuth(); }
  attachNativeSchedule(hostOrPort: NativeScheduleHost | NativeSchedulePort | null, options?: { foregroundActive?: boolean }) { return this.schedule.attachNative(hostOrPort, options); }
  setScheduleForegroundActive(active: boolean) { return this.schedule.setForegroundActive(active); }
  handleNativeScheduleEvents(events?: readonly NativeScheduleEvent[]) { return this.schedule.handleNativeEvents(events); }
  reconcileScheduleDueRules() { return this.schedule.reconcileDueRules(); }
  scheduleExactAlarmStatus() { return this.schedule.exactAlarmStatus(); }
  openScheduleExactAlarmSettings() { return this.schedule.openExactAlarmSettings(); }
  requestSchedulePermission(action?: UserActionRef) { return this.schedule.requestPermission(action); }
  scheduleSnapshot() { return this.schedule.snapshot(); }
  scheduleSnapshotSync() { return this.schedule.snapshotSync(); }
  subscribeScheduleActivity(listener: (event: ScheduleActivityNotification) => void) { return this.schedule.subscribeActivity(listener); }
  subscribeScheduleInteractions(listener: (event: ScheduleInteractionEvent) => void) { return this.schedule.subscribeInteractions(listener); }
  pendingScheduleInteractions() { return this.schedule.pendingInteractions(); }
  listScheduleRules(filter?: { state?: ScheduleRuleState; origin?: ScheduleOrigin }) { return this.schedule.listRules(filter); }
  listScheduleRuns(ruleId?: string, limit?: number) { return this.schedule.listRuns(ruleId, limit); }
  createScheduleRule(input: CreateScheduleRuleInput, action?: UserActionRef) { return this.schedule.createRule(input, action); }
  updateScheduleRule(id: string, patch: UpdateScheduleRuleInput, action?: UserActionRef) { return this.schedule.updateRule(id, patch, action); }
  setScheduleRuleEnabled(id: string, enabled: boolean, action?: UserActionRef) { return this.schedule.setRuleEnabled(id, enabled, action); }
  cancelScheduleRule(id: string, action?: UserActionRef) { return this.schedule.cancelRule(id, action); }
  deleteScheduleRule(id: string, action?: UserActionRef) { return this.schedule.deleteRule(id, action); }
  runScheduleRuleNow(id: string, action?: UserActionRef) { return this.schedule.runRuleNow(id, action); }
  updateScheduleSettings(patch: Partial<ScheduleSettings>, action?: UserActionRef) { return this.schedule.updateSettings(patch, action); }
  addQuietHoursWindow(input: Omit<QuietHoursWindow, "id"> & { id?: string }, action?: UserActionRef) { return this.schedule.addQuietHoursWindow(input, action); }
  updateQuietHoursWindow(id: string, patch: Partial<Omit<QuietHoursWindow, "id">>, action?: UserActionRef) { return this.schedule.updateQuietHoursWindow(id, patch, action); }
  removeQuietHoursWindow(id: string, action?: UserActionRef) { return this.schedule.removeQuietHoursWindow(id, action); }
  setQuietHoursEnabled(enabled: boolean, action?: UserActionRef) { return this.schedule.setQuietHoursEnabled(enabled, action); }
  isQuietHoursNow() { return this.schedule.isQuietHoursNow(); }
  githubCredentialStatus() { return this.github.status(); }
  saveGitHubToken(token: string, action: UserActionRef) { return this.github.save(token, action); }
  verifyGitHubToken(action: UserActionRef) { return this.github.verify(action); }
  clearGitHubToken(action: UserActionRef) { return this.github.clear(action); }
}
