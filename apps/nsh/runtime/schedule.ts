import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { UserActionRef } from "@super-looi/contracts";
import type {
  AgentInteraction,
  AgentRunResult,
  AgentTask,
  PiAgentExecutor,
} from "@super-looi/runtime/agent";
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
  type ScheduleFailure,
  type ScheduleOrigin,
  type ScheduleRule,
  type ScheduleRuleState,
  type ScheduleRunRecord,
  type ScheduleSettings,
  type ScheduleSnapshot,
  type UpdateScheduleRuleInput,
} from "@super-looi/runtime/schedule";
import type { SqliteRuntimeStore } from "@super-looi/runtime/storage";
import type { LangfuseTracer } from "@super-looi/runtime/telemetry";
import type { LlmModelStreamConfig } from "./agent/types.js";
import {
  createScheduleNativePort,
  isNativeScheduleHost,
  type NativeScheduleExactAlarmStatus,
  type NativeScheduleHost,
} from "./schedule-native-adapter.js";
import { createScheduleTools } from "./tools/index.js";
import type { UiActionGuard } from "./vault.js";
import type { VoiceSchedule } from "./voice/tools/schedule.js";

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

export interface ScheduleRuntimeOptions {
  store: SqliteRuntimeStore;
  getExecutor: () => PiAgentExecutor | undefined;
  getModelStreamConfig: () => LlmModelStreamConfig | undefined;
  tracer: LangfuseTracer;
  defaultLanguage: () => "zh-CN" | "en-US";
  assertUiAction: UiActionGuard;
  isClosed: () => boolean;
  redactSecrets: (text: string) => string;
}

/**
 * Mobile host supervisor for scheduled rules, native OS alarm/notification bridges,
 * post-turn automatic follow-up observation, and schedule-lane interaction queues.
 */
export class ScheduleRuntime {
  private readonly engine: ScheduleEngine;
  private readonly postTurnObserver: PostTurnScheduleObserver;
  private readonly activityListeners = new Set<
    (event: ScheduleActivityNotification) => void
  >();
  private readonly interactionListeners = new Set<
    (event: ScheduleInteractionEvent) => void
  >();
  private readonly activeInteractions = new Map<
    string,
    ScheduleInteractionEvent & { type: "requested" }
  >();
  private readonly mutatedTaskIds = new Set<string>();
  private readonly pendingMergedRules = new Set<string>();
  private readonly handledSettledRuns = new Set<string>();
  private attachedPort: NativeSchedulePort | null = null;
  private attachedHost?: NativeScheduleHost;
  private foregroundActive = false;
  private closed = false;

  constructor(private readonly options: ScheduleRuntimeOptions) {
    this.engine = new ScheduleEngine({
      store: options.store,
      getExecutor: options.getExecutor,
      tracer: options.tracer,
      defaultLanguage: options.defaultLanguage,
      onRuleCreated: (rule, merged) => {
        if (merged) {
          this.pendingMergedRules.add(rule.id);
        }
      },
      onRunSettled: async (context) => {
        await this.handleRunSettled(context);
      },
      onActivity: (event) => {
        this.emitActivity(event);
      },
    });
    this.postTurnObserver = new PostTurnScheduleObserver({
      engine: this.engine,
      store: options.store,
      tracer: options.tracer,
      redactSecrets: options.redactSecrets,
      getModelConfig: options.getModelStreamConfig,
    });
  }

  private isClosed(): boolean {
    return this.closed || this.options.isClosed();
  }

  private assertOpenOrUiAction(action?: UserActionRef): void {
    if (action) this.options.assertUiAction(action);
    else if (this.isClosed()) throw new Error("@looi:runtimeRuntimeClosed");
  }

  voiceSchedule(): VoiceSchedule {
    return this.engine;
  }

  createTaskTools(context: {
    taskId: string;
    sessionId?: string;
    checkOnly: boolean;
    isForegroundTask: boolean;
  }): AgentTool<any>[] {
    return createScheduleTools({
      engine: this.engine,
      sourceSessionId: context.sessionId,
      sourceTaskId: context.taskId,
      checkOnly: context.checkOnly,
      onMutated: () => {
        if (context.isForegroundTask) {
          this.mutatedTaskIds.add(context.taskId);
        }
      },
    });
  }

  observeForegroundTurn(input: {
    task: AgentTask;
    result: AgentRunResult;
    userPrompt: string;
  }): void {
    const manageScheduleMutated = this.mutatedTaskIds.has(input.task.id);
    this.postTurnObserver.maybeObserve({
      task: input.task,
      result: input.result,
      userPrompt: input.userPrompt,
      manageScheduleMutated,
    });
  }

  clearMutatedTask(taskId: string): void {
    this.mutatedTaskIds.delete(taskId);
  }

  async cancelActiveRun(): Promise<void> {
    await this.engine.cancelActiveRun();
  }

  async attachNative(
    hostOrPort: NativeScheduleHost | NativeSchedulePort | null,
    options?: { foregroundActive?: boolean },
  ): Promise<void> {
    if (this.isClosed()) return;
    if (hostOrPort === null) {
      this.attachedHost = undefined;
      this.attachedPort = null;
    } else if (isNativeScheduleHost(hostOrPort)) {
      this.attachedHost = hostOrPort;
      this.attachedPort = createScheduleNativePort(hostOrPort);
    } else {
      this.attachedHost = undefined;
      this.attachedPort = hostOrPort;
    }
    await this.engine.attachNativePort(this.attachedPort);
    if (typeof options?.foregroundActive === "boolean") {
      this.foregroundActive = options.foregroundActive;
      this.attachedHost?.setForeground(options.foregroundActive);
      await this.engine.setForegroundActive(options.foregroundActive);
    }
  }

  async setForegroundActive(active: boolean): Promise<void> {
    if (this.isClosed()) return;
    this.foregroundActive = active;
    this.attachedHost?.setForeground(active);
    await this.engine.setForegroundActive(active);
  }

  async handleNativeEvents(
    events?: readonly NativeScheduleEvent[],
  ): Promise<{ tappedRule?: ScheduleRule; tappedRun?: ScheduleRunRecord }> {
    if (this.isClosed()) return {};
    return this.engine.handleNativeEvents(events);
  }

  async reconcileDueRules(): Promise<ScheduleRunRecord[]> {
    if (this.isClosed()) return [];
    return this.engine.reconcileDueRules();
  }

  exactAlarmStatus(): NativeScheduleExactAlarmStatus | null {
    return this.attachedHost?.exactAlarmStatus() ?? null;
  }

  async openExactAlarmSettings(): Promise<boolean> {
    if (this.isClosed()) throw new Error("@looi:runtimeRuntimeClosed");
    if (this.attachedHost) {
      return this.attachedHost.openExactAlarmSettings();
    }
    if (this.attachedPort?.openExactAlarmSettings) {
      await this.attachedPort.openExactAlarmSettings();
      return true;
    }
    return false;
  }

  async requestPermission(
    action?: UserActionRef,
  ): Promise<NativePermissionStatusResult> {
    this.assertOpenOrUiAction(action);
    if (!this.attachedPort) {
      return { notification: "unavailable" };
    }
    const status = await this.attachedPort.requestPermission();
    this.emitActivity({ kind: "settings_updated" });
    return status;
  }

  snapshot(): Promise<ScheduleSnapshot> {
    if (this.isClosed()) throw new Error("@looi:runtimeRuntimeClosed");
    return this.engine.snapshot();
  }

  snapshotSync(): Omit<ScheduleSnapshot, "permissionStatus"> {
    if (this.isClosed()) throw new Error("@looi:runtimeRuntimeClosed");
    return this.engine.snapshotSync();
  }

  subscribeActivity(
    listener: (event: ScheduleActivityNotification) => void,
  ): () => void {
    this.activityListeners.add(listener);
    return () => this.activityListeners.delete(listener);
  }

  subscribeInteractions(
    listener: (event: ScheduleInteractionEvent) => void,
  ): () => void {
    this.interactionListeners.add(listener);
    return () => this.interactionListeners.delete(listener);
  }

  pendingInteractions(): Array<
    ScheduleInteractionEvent & { type: "requested" }
  > {
    return Array.from(this.activeInteractions.values());
  }

  listRules(filter?: {
    state?: ScheduleRuleState;
    origin?: ScheduleOrigin;
  }): ScheduleRule[] {
    if (this.isClosed()) throw new Error("@looi:runtimeRuntimeClosed");
    return this.engine.listRules(filter);
  }

  listRuns(ruleId?: string, limit?: number): ScheduleRunRecord[] {
    if (this.isClosed()) throw new Error("@looi:runtimeRuntimeClosed");
    return this.engine.listRuns(ruleId, limit);
  }

  createRule(
    input: CreateScheduleRuleInput,
    action?: UserActionRef,
  ): { rule: ScheduleRule; merged: boolean } {
    this.assertOpenOrUiAction(action);
    return this.engine.createRule(input);
  }

  updateRule(
    id: string,
    patch: UpdateScheduleRuleInput,
    action?: UserActionRef,
  ): ScheduleRule {
    this.assertOpenOrUiAction(action);
    return this.engine.updateRule(id, patch);
  }

  setRuleEnabled(
    id: string,
    enabled: boolean,
    action?: UserActionRef,
  ): ScheduleRule {
    this.assertOpenOrUiAction(action);
    return this.engine.setRuleEnabled(id, enabled);
  }

  cancelRule(id: string, action?: UserActionRef): Promise<ScheduleRule> {
    this.assertOpenOrUiAction(action);
    return this.engine.cancelRule(id);
  }

  deleteRule(id: string, action?: UserActionRef): Promise<boolean> {
    this.assertOpenOrUiAction(action);
    return this.engine.deleteRule(id);
  }

  runRuleNow(
    id: string,
    action?: UserActionRef,
  ): Promise<ScheduleRunRecord> {
    this.assertOpenOrUiAction(action);
    return this.engine.runNow(id);
  }

  updateSettings(
    patch: Partial<ScheduleSettings>,
    action?: UserActionRef,
  ): ScheduleSettings {
    this.assertOpenOrUiAction(action);
    return this.engine.updateSettings(patch);
  }

  addQuietHoursWindow(
    input: Omit<QuietHoursWindow, "id"> & { id?: string },
    action?: UserActionRef,
  ): ScheduleSettings {
    this.assertOpenOrUiAction(action);
    return this.engine.addQuietHoursWindow(input);
  }

  updateQuietHoursWindow(
    id: string,
    patch: Partial<Omit<QuietHoursWindow, "id">>,
    action?: UserActionRef,
  ): ScheduleSettings {
    this.assertOpenOrUiAction(action);
    return this.engine.updateQuietHoursWindow(id, patch);
  }

  removeQuietHoursWindow(
    id: string,
    action?: UserActionRef,
  ): ScheduleSettings {
    this.assertOpenOrUiAction(action);
    return this.engine.removeQuietHoursWindow(id);
  }

  setQuietHoursEnabled(
    enabled: boolean,
    action?: UserActionRef,
  ): ScheduleSettings {
    this.assertOpenOrUiAction(action);
    return this.engine.setQuietHoursEnabled(enabled);
  }

  isQuietHoursNow(): boolean {
    if (this.isClosed()) return false;
    return this.engine.isQuietHoursNow();
  }

  handlePersistedTask(task: AgentTask): void {
    if (task.lane !== "schedule") return;
    const prev = this.activeInteractions.get(task.id);
    if (task.interaction) {
      if (!prev || prev.interaction.id !== task.interaction.id) {
        const runs = this.engine.listRuns(undefined, 20);
        const matchedRun =
          runs.find((run) => run.taskId === task.id) ??
          runs.find((run) => run.sessionId === task.sessionId);
        const matchedRule = matchedRun
          ? this.engine.getRule(matchedRun.ruleId)
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
        this.activeInteractions.set(task.id, event);
        for (const listener of this.interactionListeners) {
          listener(event);
        }
      }
      return;
    }
    if (prev) {
      this.activeInteractions.delete(task.id);
      const cleared: ScheduleInteractionEvent = {
        type: "cleared",
        taskId: task.id,
        interactionId: prev.interaction.id,
        taskState: task.state,
      };
      for (const listener of this.interactionListeners) {
        listener(cleared);
      }
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    try {
      await this.engine.close().catch(() => {});
    } finally {
      this.attachedPort = null;
      this.attachedHost = undefined;
      this.activityListeners.clear();
      this.interactionListeners.clear();
      this.activeInteractions.clear();
      this.mutatedTaskIds.clear();
      this.pendingMergedRules.clear();
      this.handledSettledRuns.clear();
    }
  }

  private emitActivity(event: ScheduleActivityEvent): void {
    if (event.kind === "run_settled" && event.runId) {
      if (this.handledSettledRuns.has(event.runId)) {
        this.handledSettledRuns.delete(event.runId);
        return;
      }
      const existingRun = this.engine.getRun(event.runId);
      if (
        existingRun &&
        existingRun.status !== "missed" &&
        existingRun.status !== "skipped"
      ) {
        return;
      }
    }
    const rule = event.ruleId ? this.engine.getRule(event.ruleId) : undefined;
    const run = event.runId ? this.engine.getRun(event.runId) : undefined;
    const merged =
      event.kind === "rule_created" && event.ruleId
        ? this.pendingMergedRules.delete(event.ruleId)
        : undefined;
    const notification: ScheduleActivityNotification = {
      ...event,
      ...(rule ? { rule } : {}),
      ...(run ? { run } : {}),
      ...(merged !== undefined ? { merged } : {}),
      isQuietHours: this.engine.isQuietHoursNow(),
      foregroundActive: this.foregroundActive,
      ...(event.kind === "run_settled" ? { notificationPosted: false } : {}),
    };
    for (const listener of this.activityListeners) {
      try {
        listener(notification);
      } catch {
        // Isolate subscriber callback errors from schedule delivery.
      }
    }
  }

  private extractFailure(stage: string, error: unknown): ScheduleFailure {
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
    const rawStage =
      typeof info?.stage === "string" && info.stage ? info.stage : stage;
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
      reason: this.options.redactSecrets(rawReason),
    };
  }

  private async handleRunSettled(
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
        this.attachedPort
      ) {
        try {
          await this.attachedPort.postNotification({
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
          notificationError = this.extractFailure(
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
      for (const listener of this.activityListeners) {
        try {
          listener(notification);
        } catch {
          // Isolate subscriber callback errors from schedule delivery.
        }
      }
    }
  }
}
