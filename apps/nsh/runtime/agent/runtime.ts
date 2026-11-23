import { randomUUID } from "node:crypto";
import type { UserActionRef } from "@super-looi/contracts";
import type {
  AgentInteractionAnswer,
  AgentStepEvent,
  AgentStopResult,
} from "@super-looi/runtime/agent/executor";
import {
  syncLooiModelsRegistry,
  type ActiveLlmSelection,
} from "@super-looi/runtime/agent/llm-providers";
import { PiAgentExecutor } from "@super-looi/runtime/agent/pi-executor";
import type { TraceContext } from "../../../../packages/looi-runtime/src/telemetry/langfuse.js";
import { VoiceConversationWindow } from "../voice/conversation-window.js";
import { TaskHistoryStore } from "./history.js";
import { LlmModelManager } from "./models.js";
import type { AgentRunInputOptions, AgentRuntimeOptions } from "./types.js";

/**
 * First-class mobile background Agent host:
 * owns the `PiAgentExecutor` lifecycle and hot rebuilds, lane-isolated foreground and
 * plugin task dispatch, persisted conversation identity, model/OAuth catalog (`models`),
 * and task history read model (`history`).
 */
export class AgentRuntime {
  readonly models: LlmModelManager;
  readonly history: TaskHistoryStore;
  private readonly voiceConversation = new VoiceConversationWindow();
  private executor?: PiAgentExecutor;
  private conversationId = `session_${randomUUID()}`;
  private conversationPersisted = false;
  private foregroundTaskId?: string;
  private foregroundBusy = false;
  private readonly activePluginTaskIds = new Set<string>();
  private lastDefaultLanguage: "zh-CN" | "en-US" = "zh-CN";
  private closed = false;

  constructor(private readonly options: AgentRuntimeOptions) {
    this.models = new LlmModelManager({
      vault: options.vault,
      assertUiAction: options.assertUiAction,
      isClosed: () => this.isClosed(),
      isForegroundBusy: () => this.foregroundBusy,
      hasExecutor: () => Boolean(this.executor),
      getConversationState: () => ({
        id: this.conversationId,
        persisted: this.conversationPersisted,
      }),
      setConversationState: (state) => {
        this.conversationId = state.id;
        this.conversationPersisted = state.persisted;
      },
      onBeforeExecutorRebuild: () => this.closeExecutorForRebuild(),
      onSelectionCommitted: (selection) => {
        this.setExecutorFromSelection(selection);
      },
    });

    this.history = new TaskHistoryStore({
      database: options.database,
      storage: options.storage,
      getTask: (id) => this.executor?.getTask(id),
      isClosed: () => this.isClosed(),
    });

    const raw = options.vault.get("model");
    if (raw) {
      const stored = JSON.parse(raw);
      const envelope = this.models.store.readEnvelope();
      if (
        typeof stored?.conversationId === "string" &&
        /^[a-zA-Z0-9_-]{1,100}$/.test(stored.conversationId)
      ) {
        this.conversationId = stored.conversationId;
        this.conversationPersisted = true;
      }
      if (
        envelope.active &&
        envelope.credentials[envelope.active.providerId] &&
        (envelope.active.providerId !== "custom" ||
          this.models.isValidCustomEndpoint(envelope.custom))
      ) {
        syncLooiModelsRegistry(this.models.registry, envelope);
        this.executor = this.createExecutor(envelope.active);
        queueMicrotask(() => {
          if (!this.isClosed()) {
            this.options.onExecutorReady?.();
          }
        });
      }
    }
  }

  private isClosed(): boolean {
    return this.closed || Boolean(this.options.isClosed?.());
  }

  currentExecutor(): PiAgentExecutor | undefined {
    return this.executor;
  }

  activeForegroundTaskId(): string | undefined {
    return this.foregroundTaskId;
  }

  activeForegroundTraceContext(traceName: string): TraceContext | undefined {
    const trace = this.foregroundTaskId
      ? this.executor?.getTask(this.foregroundTaskId)?.trace
      : undefined;
    return trace
      ? { traceId: trace.traceId, parentSpanId: trace.spanId, traceName }
      : undefined;
  }

  defaultLanguage(): "zh-CN" | "en-US" {
    return this.lastDefaultLanguage;
  }

  activeConversationId(): string {
    return this.conversationId;
  }

  touchVoiceConversation(): void {
    this.voiceConversation.touch();
  }

  voiceConversationId(): string {
    return this.voiceConversation.current();
  }

  private assertCanChangeConversation(action: UserActionRef): void {
    if (this.isClosed() || this.foregroundBusy || this.models.isBusy) {
      throw new Error("@looi:runtimeStopTheCurrentTaskOrCancelSigninFirst");
    }
    this.options.assertUiAction(action);
  }

  newConversation(action: UserActionRef): void {
    this.assertCanChangeConversation(action);
    this.persistConversationId(`session_${randomUUID()}`);
  }

  adoptConversationSession(
    sessionId: string,
    action: UserActionRef,
  ): { conversationId: string } {
    this.assertCanChangeConversation(action);
    const trimmed = typeof sessionId === "string" ? sessionId.trim() : "";
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(trimmed)) {
      throw new Error("@looi:runtimeInvalidScheduleSession");
    }
    this.persistConversationId(trimmed);
    return { conversationId: this.conversationId };
  }

  private persistConversationId(conversationId: string): void {
    const raw = this.options.vault.get("model");
    if (raw) {
      this.models.store.updateEnvelope((draft) => {
        draft.conversationId = conversationId;
        return draft;
      });
      this.conversationPersisted = true;
    } else {
      this.conversationPersisted = false;
    }
    this.conversationId = conversationId;
  }

  private async evaluatePluginUserTurn(
    text: string,
  ): Promise<{ readonly taskId: string; readonly answer: string } | undefined> {
    const turnGuard = await this.options.evaluateUserTurn?.(text);
    if (!turnGuard) return undefined;
    if (turnGuard.decision === "block") {
      const message =
        turnGuard.spokenReply && turnGuard.spokenReply !== turnGuard.reason
          ? `${turnGuard.spokenReply} (${turnGuard.reason})`
          : turnGuard.reason;
      throw Object.assign(new Error(message), {
        stage:
          turnGuard.stage ??
          `${turnGuard.pluginId ?? "plugin"}:ai.interceptUserTurn`,
        code: turnGuard.code ?? "ERR_PLUGIN_USER_TURN_BLOCKED",
        ...(turnGuard.spokenReply ? { spokenReply: turnGuard.spokenReply } : {}),
        ...(turnGuard.cause !== undefined ? { cause: turnGuard.cause } : {}),
      });
    }
    return {
      taskId: "",
      answer: turnGuard.answer ?? turnGuard.spokenReply ?? "",
    };
  }

  private createExecutor(selection: ActiveLlmSelection): PiAgentExecutor {
    const stateDirectory = this.options.stateDirectory ?? "/home/agent";
    const workspaceRoot = this.options.workspaceRoot ?? "/workspace";
    process.env.PI_CODING_AGENT_DIR = stateDirectory;
    const credential =
      this.models.store.readEnvelope().credentials[selection.providerId];
    if (credential?.type === "api_key" && credential.key) {
      this.options.tracer.registerSecret(credential.key);
    }
    return new PiAgentExecutor({
      tracer: this.options.tracer,
      modelsRegistry: this.models.registry,
      credentialStore: this.models.store,
      providerId: selection.providerId,
      model: selection.modelId,
      stateDirectory,
      workspaceRoot,
      redactSecrets: this.options.redactSecrets,
      taskPersistence: {
        load: this.options.storage.tasks.load,
        save: (task) => {
          this.options.storage.tasks.save(task);
          this.options.onTaskPersisted?.(task);
          this.history.emit(true);
        },
      },
      approvalUiSessionId: this.options.uiSessionId,
      requireApprovalForAllWrites: true,
      maxConcurrentTasks: 3,
      laneLimits: {
        foreground: 1,
        plugin: 1,
        schedule: 1,
      },
      deadlineMs: 600_000,
      ...(this.options.systemPrompt !== undefined
        ? { systemPrompt: this.options.systemPrompt }
        : {}),
      ...(this.options.additionalTools
        ? { additionalTools: this.options.additionalTools }
        : {}),
      ...(this.options.resolveTaskTools
        ? {
            taskTools: (context) =>
              this.options.resolveTaskTools!({
                ...context,
                sessionId:
                  context.sessionId ??
                  this.executor?.getTask(context.taskId)?.sessionId,
                isForegroundTask: context.taskId === this.foregroundTaskId,
              }),
          }
        : {}),
      ...(this.options.beforeToolCall
        ? { beforeToolCall: this.options.beforeToolCall }
        : {}),
      ...(this.options.assembleTurnContext
        ? { assembleTurnContext: this.options.assembleTurnContext }
        : {}),
      ...(this.options.approvalRequiredTools
        ? { approvalRequiredTools: this.options.approvalRequiredTools }
        : {}),
    });
  }

  private async closeExecutorForRebuild(): Promise<void> {
    await this.options.beforeExecutorClose?.().catch(() => {});
    for (const bgTaskId of this.activePluginTaskIds) {
      await this.executor?.cancel(bgTaskId).catch(() => {});
    }
    await this.executor?.close();
    this.executor = undefined;
  }

  private setExecutorFromSelection(selection: ActiveLlmSelection): void {
    this.executor = this.createExecutor(selection);
    if (!this.isClosed()) {
      this.options.onExecutorReady?.();
    }
  }

  async run(
    prompt: string,
    action: UserActionRef,
    onStep: (event: AgentStepEvent) => void,
    options: AgentRunInputOptions = {},
  ): Promise<{ answer: string; taskId: string; runtimeExited: boolean }> {
    if (this.isClosed() || this.foregroundBusy || this.models.isBusy) {
      throw new Error("@looi:runtimeATaskOrSigninIsActiveStopIt");
    }
    this.options.assertUiAction(action);
    const text = prompt.trim();
    if (!text) throw new Error("@looi:runtimeEnterAMessage");

    this.foregroundBusy = true;
    const sessionId =
      options.mode === "voice"
        ? this.voiceConversation.begin()
        : this.conversationId;
    let taskId: string | undefined;
    try {
      const handled = await this.evaluatePluginUserTurn(text);
      if (handled) {
        return { ...handled, runtimeExited: true };
      }
      if (!this.executor) {
        throw new Error("@looi:runtimeConfigureAChatModelInConnectionsFirst");
      }
      if (!this.conversationPersisted && this.options.vault.get("model")) {
        this.models.store.updateEnvelope((draft) => {
          draft.conversationId = this.conversationId;
          return draft;
        });
        this.conversationPersisted = true;
      }
      this.lastDefaultLanguage =
        options.defaultLanguage ?? this.lastDefaultLanguage;
      taskId = `task_${randomUUID()}`;
      this.foregroundTaskId = taskId;
      const result = await this.executor.run(text, {
        taskId,
        lane: "foreground",
        sessionId,
        mode: options.mode,
        approvalMode: options.approvalMode,
        defaultLanguage: options.defaultLanguage,
        traceContext: options.traceContext,
        onStep,
        onShellOutput: options.onShellOutput,
      });
      const completedTask =
        this.executor.getTask(result.taskId) ??
        this.options.storage.task(result.taskId);
      if (completedTask && completedTask.state === "succeeded") {
        this.options.onForegroundTurnSucceeded?.({
          task: completedTask,
          result,
          userPrompt: text,
        });
      }
      return {
        answer: result.answer,
        taskId: result.taskId,
        runtimeExited: result.runtimeExited,
      };
    } finally {
      if (taskId) {
        this.options.onForegroundTurnFinished?.(taskId);
      }
      if (options.mode === "voice") this.voiceConversation.finish();
      this.foregroundBusy = false;
      this.foregroundTaskId = undefined;
    }
  }

  async runPluginBackgroundTask(
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
    if (this.isClosed() || this.models.isOAuthActive) {
      throw Object.assign(
        new Error("@looi:runtimeATaskOrSigninIsActiveStopIt"),
        {
          stage: `plugin:${pluginId}:ai.runBackgroundTask`,
          code: "ERR_PLUGIN_RUNTIME_BUSY",
        },
      );
    }
    if (this.activePluginTaskIds.size >= 1) {
      throw Object.assign(
        new Error("Another plugin background task is already running"),
        {
          stage: `plugin:${pluginId}:ai.runBackgroundTask`,
          code: "ERR_PLUGIN_BACKGROUND_TASK_BUSY",
        },
      );
    }
    const handled = await this.evaluatePluginUserTurn(text);
    if (handled) {
      return handled;
    }
    if (!this.executor) {
      throw Object.assign(
        new Error("@looi:runtimeConfigureAChatModelInConnectionsFirst"),
        {
          stage: `plugin:${pluginId}:ai.runBackgroundTask`,
          code: "ERR_PLUGIN_MODEL_UNCONFIGURED",
        },
      );
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

  respond(
    taskId: string,
    requestId: string,
    answer: AgentInteractionAnswer,
  ): void {
    if (this.isClosed() || !this.executor) {
      throw new Error("@looi:runtimeRuntimeUnavailable");
    }
    this.executor.respond(taskId, requestId, answer);
  }

  sendMessage(
    taskId: string,
    message: string,
    behavior: "steer" | "followUp",
    action: UserActionRef,
  ): Promise<"queued" | "handled"> {
    this.options.assertUiAction(action);
    if (this.isClosed() || !this.executor) {
      throw new Error("@looi:runtimeRuntimeUnavailable");
    }
    if (taskId !== this.foregroundTaskId) {
      throw new Error("Task has no active Pi run");
    }
    return this.executor.sendMessage(taskId, message, behavior);
  }

  async cancelForeground(): Promise<AgentStopResult> {
    this.models.cancelOAuth();
    const taskId = this.foregroundTaskId;
    if (taskId && this.executor) {
      return this.executor.cancel(taskId);
    }
    return { state: "cancelled", runtimeExited: true, confirmed: true };
  }

  async cancelTask(taskId: string): Promise<AgentStopResult> {
    if (this.isClosed() || !this.executor) {
      throw new Error("@looi:runtimeRuntimeUnavailable");
    }
    if (taskId === this.foregroundTaskId) {
      return this.cancelForeground();
    }
    return this.executor.cancel(taskId);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.models.cancelOAuth();
    for (const bgTaskId of this.activePluginTaskIds) {
      void this.executor?.cancel(bgTaskId).catch(() => {});
    }
    try {
      await this.executor?.close();
    } finally {
      this.executor = undefined;
      this.history.clearListeners();
    }
  }
}
