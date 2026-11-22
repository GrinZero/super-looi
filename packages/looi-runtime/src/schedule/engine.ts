import { randomUUID } from "node:crypto";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { int, obj, oneOf, opt, str, union } from "@earendil-works/pi-schema";
import {
  AgentExecutionError,
  type AgentRunOptions,
  type AgentRunResult,
  type AgentStopResult,
  type AgentTask,
  type AgentToolFailureEvidence,
} from "../agent/executor.js";
import type { SqliteRuntimeStore } from "../storage/sqlite.js";
import type { LangfuseTracer } from "../telemetry/langfuse.js";
import { isWithinQuietHours, nextCronOccurrence, parseCron } from "./cron.js";
import {
  ScheduleError,
  type NativePermissionStatusResult,
  type NativeQuietHoursSnapshot,
  type NativeScheduleEvent,
  type NativeSchedulePort,
  type NativeUpcomingAlarm,
  type QuietHoursWindow,
  type ScheduleExecutionPolicy,
  type ScheduleFailure,
  type ScheduleImportance,
  type ScheduleOrigin,
  type ScheduleReportInput,
  type ScheduleRule,
  type ScheduleRuleState,
  type ScheduleRunRecord,
  type ScheduleRunTriggerReason,
  type ScheduleSettings,
  type ScheduleToolFailure,
  type ScheduleTrigger,
} from "./types.js";

const LOOKAHEAD_CAP_MS = 60_000;
const MAX_SYNC_ALARMS = 32;
const ANDROID_SHORT_WINDOW_MS = 30 * 60_000;
const DEFAULT_ONCE_MISFIRE_GRACE_SECONDS = 86_400;
const DEFAULT_RECURRING_MISFIRE_GRACE_SECONDS = 3_600;
const DEFAULT_INFERRED_EXPIRES_MS = 86_400_000;
const DEFAULT_MAX_FOLLOW_UPS = 3;
const DEFAULT_FOLLOW_UP_DELAY_SECONDS = 300;
const DEFAULT_MISFIRE_LAG_THRESHOLD_MS = 5_000;
const DEFAULT_SKIPPED_RECONCILE_BACKOFF_MS = 2_000;
const MAX_SUMMARY_CHARS = 400;

export interface ScheduleEngineExecutor {
  run(prompt: string, options?: AgentRunOptions): Promise<AgentRunResult>;
  cancel(taskId: string): Promise<AgentStopResult>;
  getTask?(id: string): AgentTask | undefined;
}

export interface ScheduleDeliveryContext {
  run: ScheduleRunRecord;
  rule: ScheduleRule;
  isQuietHours: boolean;
  foregroundActive: boolean;
}

export interface ScheduleActivityEvent {
  kind:
    | "rule_created"
    | "rule_updated"
    | "rule_deleted"
    | "run_started"
    | "run_settled"
    | "settings_updated";
  ruleId?: string;
  runId?: string;
}

export interface ScheduleSnapshot {
  rules: ScheduleRule[];
  recentRuns: ScheduleRunRecord[];
  settings: ScheduleSettings;
  isQuietNow: boolean;
  permissionStatus?: NativePermissionStatusResult;
}

export interface CreateScheduleRuleInput {
  title: string;
  prompt: string;
  origin?: ScheduleOrigin;
  dedupeKey?: string;
  trigger: ScheduleTrigger;
  executionPolicy?: ScheduleExecutionPolicy;
  enabled?: boolean;
  sourceSessionId?: string;
  sourceTaskId?: string;
  misfireGraceSeconds?: number;
  maxFollowUps?: number;
  followUpCount?: number;
  rootRuleId?: string;
  expiresAt?: string;
}

export interface UpdateScheduleRuleInput {
  title?: string;
  prompt?: string;
  trigger?: ScheduleTrigger;
  executionPolicy?: ScheduleExecutionPolicy;
  enabled?: boolean;
  dedupeKey?: string | null;
  misfireGraceSeconds?: number;
  maxFollowUps?: number;
  expiresAt?: string | null;
}

export interface ScheduleEngineOptions {
  store: SqliteRuntimeStore;
  getExecutor: () => ScheduleEngineExecutor | undefined;
  nativePort?: NativeSchedulePort;
  tracer?: LangfuseTracer;
  now?: () => Date;
  defaultLanguage?: () => "zh-CN" | "en-US";
  misfireLagThresholdMs?: number;
  skippedReconcileBackoffMs?: number;
  onRuleCreated?: (rule: ScheduleRule, merged: boolean) => void;
  onRunSettled?: (context: ScheduleDeliveryContext) => void | Promise<void>;
  onActivity?: (event: ScheduleActivityEvent) => void;
  scheduledRunExtraTools?: (rule: ScheduleRule, run: ScheduleRunRecord) => AgentTool<any>[];
}

const scheduleReportParams = obj({
  outcome: oneOf(["ok", "pending", "failed"], {
    description: "Final outcome of this scheduled run.",
  }),
  importance: oneOf(["silent", "notify"], {
    description: "Use 'silent' when intermediate pending checks succeed quietly; use 'notify' for finished outcomes, actionable findings, or errors.",
  }),
  summary: str({
    description: "Concise plain-text summary of what was checked and observed.",
  }),
  nextCheckDelaySeconds: opt(
    int({
      minimum: 1,
      description: "Seconds before scheduling the next automatic follow-up check when outcome is 'pending'.",
    }),
  ),
  nextPrompt: opt(
    str({
      description: "Optional updated instruction for the next follow-up check when outcome is 'pending'.",
    }),
  ),
  error: opt(
    obj({
      stage: opt(str({ description: "Failure stage identifier." })),
      code: opt(union([str(), int()], { description: "Underlying error code or HTTP status." })),
      reason: str({ description: "Specific failure explanation." }),
    }),
  ),
});

function truncateSummary(text: string): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length <= MAX_SUMMARY_CHARS) return cleaned;
  return `${cleaned.slice(0, MAX_SUMMARY_CHARS - 1)}…`;
}

function normalizeOptionalTimestamp(
  value: string | undefined,
  stage: string,
): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const ms = Date.parse(trimmed);
  if (!Number.isFinite(ms)) {
    throw new ScheduleError({
      stage,
      code: "ERR_INVALID_TRIGGER",
      reason: `Invalid timestamp "${value}"`,
    });
  }
  return new Date(ms).toISOString();
}

function isExpiredAt(expiresAt: string | undefined, refMs: number): boolean {
  if (!expiresAt) return false;
  const expMs = Date.parse(expiresAt);
  return Number.isFinite(expMs) && expMs <= refMs;
}

function normalizeTrigger(trigger: ScheduleTrigger): ScheduleTrigger {
  if (trigger.kind === "once") {
    const ms = Date.parse(trigger.runAt);
    if (!Number.isFinite(ms)) {
      throw new ScheduleError({
        stage: "schedule.trigger.validate",
        code: "ERR_INVALID_TRIGGER",
        reason: `Invalid once runAt timestamp "${trigger.runAt}"`,
      });
    }
    return { kind: "once", runAt: new Date(ms).toISOString() };
  }
  if (trigger.kind === "interval") {
    if (!Number.isFinite(trigger.everySeconds) || trigger.everySeconds < 60) {
      throw new ScheduleError({
        stage: "schedule.trigger.validate",
        code: "ERR_INVALID_TRIGGER",
        reason: `Interval trigger everySeconds must be >= 60, got ${trigger.everySeconds}`,
      });
    }
    return { kind: "interval", everySeconds: Math.round(trigger.everySeconds) };
  }
  const parsed = parseCron(trigger.expr);
  return { kind: "cron", expr: parsed.expr };
}

function computeInitialNextRunAt(trigger: ScheduleTrigger, now: Date): string {
  if (trigger.kind === "once") return trigger.runAt;
  if (trigger.kind === "interval") {
    return new Date(now.getTime() + trigger.everySeconds * 1000).toISOString();
  }
  return nextCronOccurrence(trigger.expr, now).toISOString();
}

function computeNextRecurringRunAt(trigger: ScheduleTrigger, after: Date): string | null {
  if (trigger.kind === "once") return null;
  if (trigger.kind === "interval") {
    return new Date(after.getTime() + trigger.everySeconds * 1000).toISOString();
  }
  return nextCronOccurrence(trigger.expr, after).toISOString();
}

function defaultGraceSeconds(trigger: ScheduleTrigger): number {
  return trigger.kind === "once"
    ? DEFAULT_ONCE_MISFIRE_GRACE_SECONDS
    : DEFAULT_RECURRING_MISFIRE_GRACE_SECONDS;
}

function buildScheduledSystemSuffix(rule: ScheduleRule): string {
  const lines = [
    "[Scheduled Execution Context]",
    `Rule: ${rule.title} (id=${rule.id}, policy=${rule.executionPolicy}, origin=${rule.origin})`,
    `Follow-up progress: ${rule.chain.followUpCount}/${rule.chain.maxFollowUps}`,
  ];
  if (rule.sourceSessionId) {
    lines.push(
      `Originating conversation sessionId: ${rule.sourceSessionId}. Use the sessions tool (action="read", sessionId="${rule.sourceSessionId}") only if you need prior context.`,
    );
  }
  if (rule.executionPolicy === "check_only") {
    lines.push(
      "Execution policy is check_only: strictly read-only inspection is allowed. Never attempt shell, file writes, or mutating actions; if changes are needed, report outcome='ok' and importance='notify' so the user can decide.",
    );
  }
  lines.push(
    "You MUST conclude by calling the schedule_report tool with { outcome, importance, summary, nextCheckDelaySeconds?, nextPrompt?, error? }. If the monitored remote task is still pending, use outcome='pending', importance='silent', and specify nextCheckDelaySeconds.",
  );
  return lines.join("\n");
}

function toScheduleToolFailures(
  failures: readonly AgentToolFailureEvidence[] | undefined,
): ScheduleToolFailure[] | undefined {
  if (!failures || failures.length === 0) return undefined;
  return failures.map(({ callId, toolName, stage, code, reason }) => ({
    callId,
    toolName,
    stage,
    ...(code !== undefined ? { code } : {}),
    reason,
  }));
}

function extractFailureFromError(error: unknown): ScheduleFailure {
  if (error instanceof AgentExecutionError && error.failure) {
    return {
      stage: error.failure.stage,
      ...(error.failure.code !== undefined ? { code: error.failure.code } : {}),
      reason: error.failure.reason,
    };
  }
  if (error instanceof ScheduleError) {
    return {
      stage: error.stage,
      ...(error.code !== undefined ? { code: error.code } : {}),
      reason: error.reason,
    };
  }
  if (error && typeof error === "object") {
    const objErr = error as {
      stage?: unknown;
      code?: unknown;
      status?: unknown;
      statusCode?: unknown;
      message?: unknown;
    };
    const stage =
      typeof objErr.stage === "string" && objErr.stage ? objErr.stage : "schedule.execute";
    const code =
      typeof objErr.code === "string" || typeof objErr.code === "number"
        ? objErr.code
        : typeof objErr.status === "number"
          ? objErr.status
          : typeof objErr.statusCode === "number"
            ? objErr.statusCode
            : undefined;
    const reason =
      typeof objErr.message === "string" && objErr.message
        ? objErr.message
        : String(error);
    return { stage, ...(code !== undefined ? { code } : {}), reason };
  }
  return {
    stage: "schedule.execute",
    code: "ERR_SCHEDULE_RUN_FAILED",
    reason: String(error),
  };
}

/**
 * Cohesive deep-module facade owning schedule rules, two-phase SQLite atomic claims/settlement,
 * isolated run execution, lookahead timer management, quiet hours, and NativeSchedulePort syncing.
 */
export class ScheduleEngine {
  private readonly now: () => Date;
  private readonly misfireLagThresholdMs: number;
  private readonly skippedReconcileBackoffMs: number;
  private readonly activityListeners = new Set<(event: ScheduleActivityEvent) => void>();
  private nativePort?: NativeSchedulePort;
  private foregroundActive = true;
  private timer?: ReturnType<typeof setTimeout>;
  private skippedBackoffUntilMs = 0;
  private closed = false;
  private reconcilingPromise?: Promise<ScheduleRunRecord[]>;
  private pendingReconcile = false;
  private activeRun?: {
    ruleId: string;
    runId: string;
    taskId: string;
    abortController: AbortController;
    promise: Promise<ScheduleRunRecord>;
  };
  private iosGraceHandle?: string | null;

  constructor(private readonly options: ScheduleEngineOptions) {
    this.now = options.now ?? (() => new Date());
    this.misfireLagThresholdMs =
      options.misfireLagThresholdMs ?? DEFAULT_MISFIRE_LAG_THRESHOLD_MS;
    this.skippedReconcileBackoffMs =
      options.skippedReconcileBackoffMs ?? DEFAULT_SKIPPED_RECONCILE_BACKOFF_MS;
    this.nativePort = options.nativePort;
  }

  private get store(): SqliteRuntimeStore {
    return this.options.store;
  }

  subscribe(listener: (event: ScheduleActivityEvent) => void): () => void {
    this.activityListeners.add(listener);
    return () => {
      this.activityListeners.delete(listener);
    };
  }

  private emitActivity(event: ScheduleActivityEvent): void {
    try {
      this.options.onActivity?.(event);
    } catch {
      // optional callback
    }
    for (const listener of this.activityListeners) {
      try {
        listener(event);
      } catch {
        // isolate subscriber failures
      }
    }
  }

  getSettings(): ScheduleSettings {
    return this.store.getScheduleSettings();
  }

  updateSettings(patch: Partial<ScheduleSettings>): ScheduleSettings {
    const current = this.store.getScheduleSettings();
    const next: ScheduleSettings = {
      autoFollowUpEnabled: patch.autoFollowUpEnabled ?? current.autoFollowUpEnabled,
      maxActiveInferredRules:
        patch.maxActiveInferredRules ?? current.maxActiveInferredRules,
      quietHoursEnabled: patch.quietHoursEnabled ?? current.quietHoursEnabled,
      quietHours:
        patch.quietHours !== undefined
          ? structuredClone(patch.quietHours)
          : current.quietHours,
    };
    const saved = this.store.saveScheduleSettings(next);
    this.emitActivity({ kind: "settings_updated" });
    void this.syncNative();
    return saved;
  }

  addQuietHoursWindow(
    input: Omit<QuietHoursWindow, "id"> & { id?: string },
  ): ScheduleSettings {
    const current = this.getSettings();
    const window: QuietHoursWindow = {
      id: input.id ?? `qh_${randomUUID()}`,
      ...(input.label !== undefined ? { label: input.label } : {}),
      startMinute: input.startMinute,
      endMinute: input.endMinute,
      ...(input.daysOfWeek ? { daysOfWeek: [...input.daysOfWeek] } : {}),
      enabled: input.enabled,
    };
    const existingIdx = current.quietHours.findIndex((item) => item.id === window.id);
    const nextWindows =
      existingIdx >= 0
        ? current.quietHours.map((item, idx) => (idx === existingIdx ? window : item))
        : [...current.quietHours, window];
    return this.updateSettings({ quietHours: nextWindows });
  }

  updateQuietHoursWindow(
    id: string,
    patch: Partial<Omit<QuietHoursWindow, "id">>,
  ): ScheduleSettings {
    const current = this.getSettings();
    const idx = current.quietHours.findIndex((item) => item.id === id);
    if (idx < 0) {
      throw new ScheduleError({
        stage: "schedule.quiet_hours.update",
        code: "ERR_QUIET_HOURS_NOT_FOUND",
        reason: `Quiet hours window "${id}" was not found`,
      });
    }
    const nextWindows = current.quietHours.map((item) =>
      item.id === id
        ? {
            ...item,
            ...patch,
            id,
            ...(patch.daysOfWeek !== undefined ? { daysOfWeek: [...patch.daysOfWeek] } : {}),
          }
        : item,
    );
    return this.updateSettings({ quietHours: nextWindows });
  }

  removeQuietHoursWindow(id: string): ScheduleSettings {
    const current = this.getSettings();
    return this.updateSettings({
      quietHours: current.quietHours.filter((item) => item.id !== id),
    });
  }

  setQuietHoursEnabled(enabled: boolean): ScheduleSettings {
    return this.updateSettings({ quietHoursEnabled: enabled });
  }

  isQuietHoursNow(): boolean {
    return isWithinQuietHours(this.now(), this.getSettings());
  }

  listRules(filter?: { state?: ScheduleRuleState; origin?: ScheduleOrigin }): ScheduleRule[] {
    return this.store.listScheduleRules(filter);
  }

  getRule(id: string): ScheduleRule | undefined {
    return this.store.getScheduleRule(id);
  }

  listRuns(ruleId?: string, limit = 50): ScheduleRunRecord[] {
    return this.store.listScheduleRuns(ruleId, limit);
  }

  getRun(runId: string): ScheduleRunRecord | undefined {
    return this.store.getScheduleRun(runId);
  }

  snapshotSync(): Omit<ScheduleSnapshot, "permissionStatus"> {
    const settings = this.getSettings();
    return {
      rules: this.listRules(),
      recentRuns: this.listRuns(undefined, 50),
      settings,
      isQuietNow: isWithinQuietHours(this.now(), settings),
    };
  }

  async snapshot(): Promise<ScheduleSnapshot> {
    const base = this.snapshotSync();
    let permissionStatus: NativePermissionStatusResult | undefined;
    if (this.nativePort) {
      permissionStatus = await this.nativePort.permissionStatus();
    }
    return {
      ...base,
      ...(permissionStatus ? { permissionStatus } : {}),
    };
  }

  private evictExcessInferredRules(maxActive: number, now: Date): void {
    const nowMs = now.getTime();
    const nowIso = now.toISOString();
    const activeInferred = this.store
      .listScheduleRules({ state: "active", origin: "agent_inferred" })
      .sort((a, b) => {
        const expA = Date.parse(a.expiresAt ?? a.createdAt);
        const expB = Date.parse(b.expiresAt ?? b.createdAt);
        return expA - expB || Date.parse(a.createdAt) - Date.parse(b.createdAt);
      });

    const surviving: ScheduleRule[] = [];
    for (const candidate of activeInferred) {
      if (isExpiredAt(candidate.expiresAt, nowMs)) {
        this.store.updateScheduleRule({
          ...candidate,
          state: "expired",
          nextRunAt: null,
          updatedAt: nowIso,
        });
      } else {
        surviving.push(candidate);
      }
    }

    const limit = Math.max(1, maxActive);
    while (surviving.length >= limit) {
      const oldest = surviving.shift()!;
      this.store.updateScheduleRule({
        ...oldest,
        state: "expired",
        nextRunAt: null,
        updatedAt: nowIso,
      });
    }
  }

  createRule(input: CreateScheduleRuleInput): { rule: ScheduleRule; merged: boolean } {
    const title = input.title.trim();
    const prompt = input.prompt.trim();
    if (!title || !prompt) {
      throw new ScheduleError({
        stage: "schedule.create",
        code: "ERR_INVALID_RULE",
        reason: "Schedule rule title and prompt are required",
      });
    }

    const origin: ScheduleOrigin = input.origin ?? "user";
    // Security invariant: agent_inferred rules are unconditionally locked to check_only.
    const executionPolicy: ScheduleExecutionPolicy =
      origin === "agent_inferred" ? "check_only" : (input.executionPolicy ?? "check_only");
    const settings = this.store.getScheduleSettings();

    if (origin === "agent_inferred" && !settings.autoFollowUpEnabled) {
      throw new ScheduleError({
        stage: "schedule.create",
        code: "ERR_AUTO_FOLLOWUP_DISABLED",
        reason: "Auto follow-up rules are disabled in schedule settings",
      });
    }

    const now = this.now();
    const nowIso = now.toISOString();
    const trigger = normalizeTrigger(input.trigger);
    const enabled = input.enabled ?? true;
    const state: ScheduleRuleState = enabled ? "active" : "paused";
    const nextRunAt = computeInitialNextRunAt(trigger, now);
    const dedupeKey = input.dedupeKey?.trim() || undefined;
    const misfireGraceSeconds = input.misfireGraceSeconds ?? defaultGraceSeconds(trigger);
    const expiresAt =
      normalizeOptionalTimestamp(input.expiresAt, "schedule.create") ??
      (origin === "agent_inferred"
        ? new Date(now.getTime() + DEFAULT_INFERRED_EXPIRES_MS).toISOString()
        : undefined);

    const outcome = this.store.inTransaction(() => {
      if (dedupeKey && state === "active") {
        const existing = this.store.findActiveDedupeRule(
          origin,
          executionPolicy,
          dedupeKey,
        );
        if (existing) {
          const updated: ScheduleRule = {
            ...existing,
            title,
            prompt,
            trigger,
            nextRunAt,
            misfireGraceSeconds,
            ...(expiresAt !== undefined ? { expiresAt } : {}),
            ...(input.sourceSessionId !== undefined
              ? { sourceSessionId: input.sourceSessionId }
              : {}),
            ...(input.sourceTaskId !== undefined ? { sourceTaskId: input.sourceTaskId } : {}),
            updatedAt: nowIso,
          };
          this.store.updateScheduleRule(updated);
          return { rule: updated, merged: true };
        }
      }

      if (origin === "agent_inferred" && state === "active") {
        this.evictExcessInferredRules(settings.maxActiveInferredRules, now);
      }

      const id = `srule_${randomUUID()}`;
      const rule: ScheduleRule = {
        id,
        title,
        prompt,
        origin,
        ...(dedupeKey ? { dedupeKey } : {}),
        trigger,
        executionPolicy,
        enabled,
        state,
        nextRunAt,
        ...(input.sourceSessionId ? { sourceSessionId: input.sourceSessionId } : {}),
        ...(input.sourceTaskId ? { sourceTaskId: input.sourceTaskId } : {}),
        chain: {
          rootRuleId: input.rootRuleId ?? id,
          followUpCount: input.followUpCount ?? 0,
          maxFollowUps: input.maxFollowUps ?? DEFAULT_MAX_FOLLOW_UPS,
        },
        misfireGraceSeconds,
        ...(expiresAt ? { expiresAt } : {}),
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      this.store.insertScheduleRule(rule);
      return { rule, merged: false };
    });

    try {
      this.options.onRuleCreated?.(outcome.rule, outcome.merged);
    } catch {
      // optional callback
    }
    this.emitActivity({
      kind: outcome.merged ? "rule_updated" : "rule_created",
      ruleId: outcome.rule.id,
    });
    this.armNextTimer();
    void this.syncNative();
    return outcome;
  }

  updateRule(id: string, patch: UpdateScheduleRuleInput): ScheduleRule {
    const now = this.now();
    const nowIso = now.toISOString();

    const updated = this.store.inTransaction(() => {
      const current = this.store.getScheduleRule(id);
      if (!current) {
        throw new ScheduleError({
          stage: "schedule.update",
          code: "ERR_SCHEDULE_NOT_FOUND",
          reason: `Schedule rule "${id}" was not found`,
        });
      }
      if (current.state === "running") {
        throw new ScheduleError({
          stage: "schedule.update",
          code: "ERR_SCHEDULE_RULE_RUNNING",
          reason: `Schedule rule "${id}" is currently running and cannot be modified`,
        });
      }

      const trigger = patch.trigger ? normalizeTrigger(patch.trigger) : current.trigger;
      const executionPolicy: ScheduleExecutionPolicy =
        current.origin === "agent_inferred"
          ? "check_only"
          : (patch.executionPolicy ?? current.executionPolicy);
      const enabled = patch.enabled ?? current.enabled;
      const dedupeKey =
        patch.dedupeKey === null
          ? undefined
          : patch.dedupeKey !== undefined
            ? patch.dedupeKey.trim() || undefined
            : current.dedupeKey;
      const expiresAt =
        patch.expiresAt === null
          ? undefined
          : patch.expiresAt !== undefined
            ? normalizeOptionalTimestamp(patch.expiresAt, "schedule.update")
            : current.expiresAt;

      let nextState = current.state;
      let nextRunAt = current.nextRunAt;

      if (patch.trigger || patch.enabled !== undefined) {
        if (!enabled) {
          if (nextState === "active") nextState = "paused";
        } else if (nextState === "paused" || nextState === "active") {
          nextState = "active";
          nextRunAt = computeInitialNextRunAt(trigger, now);
        }
      }

      if (dedupeKey && nextState === "active") {
        const conflict = this.store.findActiveDedupeRule(
          current.origin,
          executionPolicy,
          dedupeKey,
        );
        if (conflict && conflict.id !== current.id) {
          throw new ScheduleError({
            stage: "schedule.update",
            code: "ERR_SCHEDULE_DEDUPE_CONFLICT",
            reason: `Another active rule "${conflict.id}" already owns dedupeKey "${dedupeKey}"`,
          });
        }
      }

      const next: ScheduleRule = {
        ...current,
        title: patch.title !== undefined ? patch.title.trim() || current.title : current.title,
        prompt: patch.prompt !== undefined ? patch.prompt.trim() || current.prompt : current.prompt,
        trigger,
        executionPolicy,
        enabled,
        state: nextState,
        nextRunAt,
        ...(dedupeKey ? { dedupeKey } : {}),
        ...(expiresAt ? { expiresAt } : {}),
        misfireGraceSeconds: patch.misfireGraceSeconds ?? current.misfireGraceSeconds,
        chain: {
          ...current.chain,
          maxFollowUps: patch.maxFollowUps ?? current.chain.maxFollowUps,
        },
        updatedAt: nowIso,
      };
      if (!dedupeKey) delete next.dedupeKey;
      if (!expiresAt) delete next.expiresAt;

      this.store.updateScheduleRule(next);
      return next;
    });

    this.emitActivity({ kind: "rule_updated", ruleId: updated.id });
    this.armNextTimer();
    void this.syncNative();
    return updated;
  }

  setRuleEnabled(id: string, enabled: boolean): ScheduleRule {
    const now = this.now();
    const nowIso = now.toISOString();

    const updated = this.store.inTransaction(() => {
      const current = this.store.getScheduleRule(id);
      if (!current) {
        throw new ScheduleError({
          stage: "schedule.toggle",
          code: "ERR_SCHEDULE_NOT_FOUND",
          reason: `Schedule rule "${id}" was not found`,
        });
      }

      let nextState = current.state;
      let nextRunAt = current.nextRunAt;

      if (!enabled) {
        if (current.state === "active") nextState = "paused";
      } else if (current.state === "paused") {
        if (current.dedupeKey) {
          const conflict = this.store.findActiveDedupeRule(
            current.origin,
            current.executionPolicy,
            current.dedupeKey,
          );
          if (conflict && conflict.id !== current.id) {
            throw new ScheduleError({
              stage: "schedule.toggle",
              code: "ERR_SCHEDULE_DEDUPE_CONFLICT",
              reason: `Another active rule "${conflict.id}" already owns dedupeKey "${current.dedupeKey}"`,
            });
          }
        }
        if (current.trigger.kind === "once") {
          nextRunAt = current.trigger.runAt;
        } else {
          const existingMs = current.nextRunAt ? Date.parse(current.nextRunAt) : NaN;
          nextRunAt =
            Number.isFinite(existingMs) && existingMs > now.getTime()
              ? current.nextRunAt
              : computeInitialNextRunAt(current.trigger, now);
        }
        nextState = "active";
      }

      const next: ScheduleRule = {
        ...current,
        enabled,
        state: nextState,
        nextRunAt,
        updatedAt: nowIso,
      };
      this.store.updateScheduleRule(next);
      return next;
    });

    this.emitActivity({ kind: "rule_updated", ruleId: updated.id });
    this.armNextTimer();
    void this.syncNative();
    return updated;
  }

  async cancelRule(id: string): Promise<ScheduleRule> {
    const nowIso = this.now().toISOString();
    let activeTaskIdToCancel: string | undefined;
    let activeRunPromise: Promise<ScheduleRunRecord> | undefined;

    let updated = this.store.inTransaction(() => {
      const current = this.store.getScheduleRule(id);
      if (!current) {
        throw new ScheduleError({
          stage: "schedule.cancel",
          code: "ERR_SCHEDULE_NOT_FOUND",
          reason: `Schedule rule "${id}" was not found`,
        });
      }
      if (this.activeRun?.ruleId === id) {
        activeTaskIdToCancel = this.activeRun.taskId;
        activeRunPromise = this.activeRun.promise;
        this.activeRun.abortController.abort(
          new ScheduleError({
            stage: "schedule.cancel",
            code: "ERR_AGENT_CANCELLED",
            reason: "Schedule rule cancelled",
          }),
        );
      }
      const next: ScheduleRule = {
        ...current,
        enabled: false,
        state: "cancelled",
        nextRunAt: null,
        updatedAt: nowIso,
      };
      this.store.updateScheduleRule(next);
      return next;
    });

    if (activeTaskIdToCancel) {
      await this.options.getExecutor()?.cancel(activeTaskIdToCancel).catch(() => {});
    }
    if (activeRunPromise) {
      await activeRunPromise.catch(() => {});
      updated = this.store.getScheduleRule(id) ?? updated;
    }
    await this.nativePort?.cancelAlarm(id);
    this.emitActivity({ kind: "rule_updated", ruleId: id });
    this.armNextTimer();
    void this.syncNative();
    return updated;
  }

  async deleteRule(id: string): Promise<boolean> {
    if (this.activeRun?.ruleId === id) {
      const taskId = this.activeRun.taskId;
      this.activeRun.abortController.abort(
        new ScheduleError({
          stage: "schedule.delete",
          code: "ERR_AGENT_CANCELLED",
          reason: "Schedule rule deleted",
        }),
      );
      await this.options.getExecutor()?.cancel(taskId).catch(() => {});
      await this.activeRun?.promise.catch(() => {});
    }
    const deleted = this.store.deleteScheduleRule(id);
    if (deleted) {
      await this.nativePort?.cancelAlarm(id);
      this.emitActivity({ kind: "rule_deleted", ruleId: id });
      this.armNextTimer();
      void this.syncNative();
    }
    return deleted;
  }

  async runNow(id: string): Promise<ScheduleRunRecord> {
    if (this.closed) {
      throw new ScheduleError({
        stage: "schedule.run_now",
        code: "ERR_SCHEDULE_CLOSED",
        reason: "ScheduleEngine is closed",
      });
    }
    const rule = this.store.getScheduleRule(id);
    if (!rule) {
      throw new ScheduleError({
        stage: "schedule.run_now",
        code: "ERR_SCHEDULE_NOT_FOUND",
        reason: `Schedule rule "${id}" was not found`,
      });
    }
    if (rule.state === "running" || rule.activeRunId) {
      throw new ScheduleError({
        stage: "schedule.run_now",
        code: "ERR_SCHEDULE_ALREADY_RUNNING",
        reason: `Schedule rule "${id}" already has an active run`,
      });
    }
    if (this.activeRun) {
      throw new ScheduleError({
        stage: "schedule.run_now",
        code: "ERR_AGENT_LANE_BUSY",
        reason: "Schedule execution lane is currently busy",
      });
    }
    const executor = this.options.getExecutor();
    if (!executor) {
      throw new ScheduleError({
        stage: "schedule.run_now",
        code: "ERR_EXECUTOR_UNAVAILABLE",
        reason: "No agent executor is configured",
      });
    }
    const run = await this.claimAndExecute(rule, "manual_now", executor);
    if (!run) {
      throw new ScheduleError({
        stage: "schedule.run_now",
        code: "ERR_SCHEDULE_CLAIM_FAILED",
        reason: `Schedule rule "${id}" could not be claimed in state "${rule.state}"`,
      });
    }
    this.armNextTimer();
    await this.syncNative();
    return run;
  }

  reconcileDueRules(): Promise<ScheduleRunRecord[]> {
    if (this.closed) return Promise.resolve([]);
    if (this.reconcilingPromise) {
      this.pendingReconcile = true;
      return this.reconcilingPromise;
    }

    let resolveRun!: (runs: ScheduleRunRecord[]) => void;
    let rejectRun!: (err: unknown) => void;
    const promise = new Promise<ScheduleRunRecord[]>((resolve, reject) => {
      resolveRun = resolve;
      rejectRun = reject;
    });
    this.reconcilingPromise = promise;

    void (async () => {
      const settledRuns: ScheduleRunRecord[] = [];
      let hadSkippedRun = false;
      try {
        if (this.timer) {
          clearTimeout(this.timer);
          this.timer = undefined;
        }
        do {
          this.pendingReconcile = false;
          this.processExpiredAndMissedRules();
          const executor = this.options.getExecutor();
          if (!executor) break;

          while (!this.closed && !this.activeRun) {
            const now = this.now();
            const nowIso = now.toISOString();
            const nextDue = this.findNextWithinGraceDueRule(now);
            if (!nextDue) break;

            const lagMs = now.getTime() - Date.parse(nextDue.nextRunAt!);
            const reason: ScheduleRunTriggerReason =
              lagMs > this.misfireLagThresholdMs ? "misfire_catchup" : "scheduled";
            const run = await this.claimAndExecute(nextDue, reason, executor);
            if (!run) {
              // Avoid spinning if claim was skipped due to concurrent mutation or busy lane.
              if (nowIso === this.now().toISOString()) break;
              continue;
            }
            settledRuns.push(run);
            if (run.status === "skipped") {
              hadSkippedRun = true;
              break;
            }
            hadSkippedRun = false;
            this.skippedBackoffUntilMs = 0;
          }
        } while (this.pendingReconcile && !hadSkippedRun && !this.closed);
        this.pendingReconcile = false;

        if (this.reconcilingPromise === promise) {
          this.reconcilingPromise = undefined;
        }
        if (hadSkippedRun) {
          this.skippedBackoffUntilMs =
            this.now().getTime() + this.skippedReconcileBackoffMs;
        }
        this.armNextTimer();
        await this.syncNative();
        resolveRun(settledRuns);
      } catch (error) {
        if (this.reconcilingPromise === promise) {
          this.reconcilingPromise = undefined;
        }
        this.armNextTimer();
        await this.syncNative().catch(() => {});
        rejectRun(error);
      }
    })();

    return promise;
  }

  private processExpiredAndMissedRules(): void {
    const now = this.now();
    const nowMs = now.getTime();
    const nowIso = now.toISOString();

    this.store.inTransaction(() => {
      const activeRules = this.store.listScheduleRules({ state: "active" });
      for (const rule of activeRules) {
        if (isExpiredAt(rule.expiresAt, nowMs)) {
          this.store.updateScheduleRule({
            ...rule,
            state: "expired",
            nextRunAt: null,
            updatedAt: nowIso,
          });
          continue;
        }
        if (!rule.enabled || !rule.nextRunAt) continue;
        const scheduledMs = Date.parse(rule.nextRunAt);
        if (scheduledMs > nowMs) continue;

        const lagMs = nowMs - scheduledMs;
        if (lagMs <= rule.misfireGraceSeconds * 1000) continue;

        const missedRun: ScheduleRunRecord = {
          id: `srun_${randomUUID()}`,
          ruleId: rule.id,
          ruleTitle: rule.title,
          triggerReason: "scheduled",
          scheduledFor: rule.nextRunAt,
          startedAt: nowIso,
          finishedAt: nowIso,
          status: "missed",
          sideEffectDispatched: false,
          error: {
            stage: "schedule.misfire",
            code: "ERR_SCHEDULE_MISSED",
            reason: `Scheduled run at ${rule.nextRunAt} exceeded misfire grace window (${rule.misfireGraceSeconds}s)`,
          },
        };
        this.store.insertScheduleRun(missedRun);

        let nextState: ScheduleRuleState = rule.state;
        let nextRunAt = computeNextRecurringRunAt(rule.trigger, now);
        const expiresAtMs = rule.expiresAt ? Date.parse(rule.expiresAt) : NaN;
        if (
          nextRunAt === null ||
          (Number.isFinite(expiresAtMs) && Date.parse(nextRunAt) > expiresAtMs)
        ) {
          nextState = "expired";
          nextRunAt = null;
        }
        this.store.updateScheduleRule({
          ...rule,
          state: nextState,
          nextRunAt,
          lastRunAt: nowIso,
          lastRunId: missedRun.id,
          updatedAt: nowIso,
        });
      }
    });
  }

  private findNextWithinGraceDueRule(now: Date): ScheduleRule | undefined {
    const nowMs = now.getTime();
    const active = this.store.listScheduleRules({ state: "active" });
    for (const rule of active) {
      if (!rule.enabled || !rule.nextRunAt || rule.activeRunId) continue;
      const scheduledMs = Date.parse(rule.nextRunAt);
      if (scheduledMs <= nowMs && nowMs - scheduledMs <= rule.misfireGraceSeconds * 1000) {
        return rule;
      }
    }
    return undefined;
  }

  private async claimAndExecute(
    rule: ScheduleRule,
    triggerReason: ScheduleRunTriggerReason,
    executor: ScheduleEngineExecutor,
  ): Promise<ScheduleRunRecord | undefined> {
    const now = this.now();
    const nowIso = now.toISOString();
    const runId = `srun_${randomUUID()}`;
    const taskId = `stask_${randomUUID()}`;
    const sessionId = `sched_${randomUUID()}`;

    const initialRun: ScheduleRunRecord = {
      id: runId,
      ruleId: rule.id,
      ruleTitle: rule.title,
      taskId,
      sessionId,
      triggerReason,
      scheduledFor: rule.nextRunAt ?? nowIso,
      startedAt: nowIso,
      status: "running",
      sideEffectDispatched: false,
    };

    const allowedStates: readonly ScheduleRuleState[] =
      triggerReason === "manual_now"
        ? ["active", "paused", "unconfirmed"]
        : ["active"];

    const claimed = this.store.claimScheduleRuleForRun({
      ruleId: rule.id,
      run: initialRun,
      allowedStates,
      maxScheduledFor: triggerReason === "manual_now" ? undefined : nowIso,
      nowIso,
    });
    if (!claimed) return undefined;

    const claimedRule = this.store.getScheduleRule(rule.id) ?? rule;
    const preClaimState = rule.state;
    const abortController = new AbortController();
    this.emitActivity({ kind: "run_started", ruleId: rule.id, runId });

    const runPromise = this.executeAndSettle(
      claimedRule,
      preClaimState,
      initialRun,
      executor,
      abortController.signal,
    );
    this.activeRun = {
      ruleId: rule.id,
      runId,
      taskId,
      abortController,
      promise: runPromise,
    };

    try {
      if (!this.foregroundActive && this.nativePort && !this.iosGraceHandle) {
        this.iosGraceHandle = await Promise.resolve(
          this.nativePort.beginIosBackgroundGrace(`looi.sched.${rule.id}`),
        ).catch(() => null);
      }
      void this.syncNative().catch(() => {});
      return await runPromise;
    } finally {
      if (this.activeRun?.runId === runId) {
        this.activeRun = undefined;
      }
      if (this.iosGraceHandle && this.nativePort) {
        const handle = this.iosGraceHandle;
        this.iosGraceHandle = undefined;
        await Promise.resolve(this.nativePort.endIosBackgroundGrace(handle)).catch(() => {});
      }
    }
  }

  private createScheduleReportTool(
    onReport: (report: ScheduleReportInput) => void,
  ): AgentTool<typeof scheduleReportParams> {
    return {
      name: "schedule_report",
      label: "Schedule Report",
      description:
        "Submit the structured final outcome of a scheduled check or task, including importance and optional follow-up check delay.",
      parameters: scheduleReportParams,
      executionMode: "sequential",
      execute: async (_callId, input) => {
        const report: ScheduleReportInput = {
          outcome: input.outcome,
          importance: input.importance,
          summary: input.summary,
          ...(input.nextCheckDelaySeconds !== undefined
            ? { nextCheckDelaySeconds: input.nextCheckDelaySeconds }
            : {}),
          ...(input.nextPrompt ? { nextPrompt: input.nextPrompt } : {}),
          ...(input.error ? { error: input.error } : {}),
        };
        onReport(report);
        const payload = {
          recorded: true,
          outcome: report.outcome,
          importance: report.importance,
        };
        return {
          content: [{ type: "text", text: JSON.stringify(payload) }],
          details: payload,
        };
      },
    };
  }

  private async executeAndSettle(
    rule: ScheduleRule,
    preClaimState: ScheduleRuleState,
    initialRun: ScheduleRunRecord,
    executor: ScheduleEngineExecutor,
    signal: AbortSignal,
  ): Promise<ScheduleRunRecord> {
    let capturedReport: ScheduleReportInput | undefined;
    let execResult: AgentRunResult | undefined;
    let execError: unknown;

    const reportTool = this.createScheduleReportTool((report) => {
      capturedReport = report;
    });
    const extraTools = [
      reportTool,
      ...(this.options.scheduledRunExtraTools?.(rule, initialRun) ?? []),
    ];

    const trace = this.options.tracer?.start(
      "schedule.run",
      "span",
      {
        traceId: "",
        traceName: "schedule.run",
        sessionId: initialRun.sessionId,
      },
      {
        "langfuse.observation.input": rule.prompt,
        "langfuse.observation.metadata.ruleId": rule.id,
        "langfuse.observation.metadata.runId": initialRun.id,
        "langfuse.observation.metadata.executionPolicy": rule.executionPolicy,
        "langfuse.observation.metadata.triggerReason": initialRun.triggerReason,
      },
    );

    try {
      execResult = await executor.run(rule.prompt, {
        taskId: initialRun.taskId,
        sessionId: initialRun.sessionId,
        lane: "schedule",
        approvalMode: rule.executionPolicy === "check_only" ? "local_auto" : "ask",
        scheduleExecutionPolicy: rule.executionPolicy,
        extraTools,
        systemPromptOverrideSuffix: buildScheduledSystemSuffix(rule),
        defaultLanguage: this.options.defaultLanguage?.(),
        traceContext: trace?.context,
        signal,
        onSideEffectBeforeExecute:
          rule.executionPolicy === "authorized_action"
            ? () => {
                this.store.markRunSideEffectDispatched(initialRun.id);
              }
            : undefined,
        onStep: (event) => {
          if (event.phase === "awaiting_approval" || event.phase === "awaiting_input") {
            this.store.updateScheduleRunStatus(initialRun.id, "awaiting_user");
          } else if (event.phase === "thinking" || event.phase === "tool_start" || event.phase === "tool_end") {
            this.store.updateScheduleRunStatus(initialRun.id, "running");
          }
        },
      });
    } catch (error) {
      execError = error;
    }

    const settledAt = this.now();
    const { settledRun, settledRule } = this.settleRunInTransaction({
      rule,
      preClaimState,
      initialRun,
      settledAt,
      execResult,
      execError,
      capturedReport,
      executor,
    });

    trace?.end({
      "langfuse.observation.output": settledRun.summary ?? "",
      "langfuse.observation.metadata.status": settledRun.status,
      ...(settledRun.importance
        ? { "langfuse.observation.metadata.importance": settledRun.importance }
        : {}),
      ...(settledRun.error
        ? {
            "langfuse.observation.level": "ERROR",
            "langfuse.observation.status_message": settledRun.error.reason,
          }
        : {}),
    });

    this.emitActivity({ kind: "run_settled", ruleId: settledRule.id, runId: settledRun.id });
    if (settledRun.status !== "skipped") {
      try {
        await this.options.onRunSettled?.({
          run: settledRun,
          rule: settledRule,
          isQuietHours: isWithinQuietHours(settledAt, this.getSettings()),
          foregroundActive: this.foregroundActive,
        });
      } catch {
        // do not fail settlement on delivery observer errors
      }
    }

    return settledRun;
  }

  private settleRunInTransaction(input: {
    rule: ScheduleRule;
    preClaimState: ScheduleRuleState;
    initialRun: ScheduleRunRecord;
    settledAt: Date;
    execResult?: AgentRunResult;
    execError?: unknown;
    capturedReport?: ScheduleReportInput;
    executor: ScheduleEngineExecutor;
  }): { settledRun: ScheduleRunRecord; settledRule: ScheduleRule } {
    const settledAtIso = input.settledAt.toISOString();

    return this.store.inTransaction(() => {
      const freshRule = this.store.getScheduleRule(input.rule.id) ?? input.rule;
      const freshRun = this.store.getScheduleRun(input.initialRun.id) ?? input.initialRun;
      const settings = this.store.getScheduleSettings();

      const rawToolFailures =
        input.execResult?.toolFailures ??
        (input.execError instanceof AgentExecutionError
          ? input.execError.toolFailures
          : undefined) ??
        input.executor.getTask?.(input.initialRun.taskId!)?.toolFailures;
      const toolFailures = toScheduleToolFailures(rawToolFailures);

      // Admission lane/capacity rejection before task execution starts preserves pre-claim rule state.
      if (
        input.execError instanceof AgentExecutionError &&
        input.execError.stage === "agent.admission" &&
        (input.execError.code === "ERR_AGENT_LANE_BUSY" ||
          input.execError.code === "ERR_AGENT_CAPACITY_REACHED")
      ) {
        const failure = extractFailureFromError(input.execError);
        const skippedRun: ScheduleRunRecord = {
          ...freshRun,
          finishedAt: settledAtIso,
          status: "skipped",
          error: failure,
          summary: failure.reason,
        };
        const restoredState: ScheduleRuleState =
          freshRule.state === "cancelled"
            ? "cancelled"
            : input.preClaimState === "active" && !freshRule.enabled
              ? "paused"
              : input.preClaimState;
        const restoredRule: ScheduleRule = {
          ...freshRule,
          activeRunId: undefined,
          state: restoredState,
          updatedAt: settledAtIso,
        };
        this.store.updateScheduleRun(skippedRun);
        this.store.updateScheduleRule(restoredRule);
        return { settledRun: skippedRun, settledRule: restoredRule };
      }

      const unrecoveredFailures = (rawToolFailures ?? []).filter((item) => {
        if (item.recovered) return false;
        // If check_only policy blocked an out-of-bounds call and the agent adapted
        // and completed via schedule_report, keep the failure evidence without failing the check.
        if (
          item.code === "ERR_SCHEDULE_CHECK_ONLY_TOOL_DENIED" &&
          input.capturedReport !== undefined
        ) {
          return false;
        }
        return true;
      });

      let status: ScheduleRunRecord["status"];
      let importance: ScheduleImportance;
      let summary: string | undefined;
      let error: ScheduleFailure | undefined;
      let reportSource: ScheduleRunRecord["reportSource"];
      let followUpRuleId: string | undefined;

      if (input.execError !== undefined) {
        // Tier 1: Executor threw an exception.
        const failure = extractFailureFromError(input.execError);
        status =
          failure.code === "ERR_AGENT_STOP_UNCONFIRMED"
            ? "result_unconfirmed"
            : "failed";
        importance = "notify";
        error = failure;
        summary = truncateSummary(failure.reason);
      } else if (unrecoveredFailures.length > 0) {
        // Tier 2: Unrecovered tool failure overrides any optimistic model report/text.
        const lastFailure = unrecoveredFailures[unrecoveredFailures.length - 1]!;
        status = "failed";
        importance = "notify";
        error = {
          stage: lastFailure.stage,
          ...(lastFailure.code !== undefined ? { code: lastFailure.code } : {}),
          reason: lastFailure.reason,
        };
        summary = truncateSummary(lastFailure.reason);
        if (input.capturedReport) reportSource = "schedule_report";
      } else if (input.capturedReport !== undefined) {
        // Tier 3: Structured schedule_report with no unrecovered tool failures.
        const report = input.capturedReport;
        reportSource = "schedule_report";
        summary = truncateSummary(report.summary);

        if (report.outcome === "failed") {
          status = "failed";
          importance = "notify";
          error = {
            stage: report.error?.stage || "schedule.report",
            ...(report.error?.code !== undefined ? { code: report.error.code } : {}),
            reason: report.error?.reason || report.summary,
          };
        } else if (report.outcome === "pending") {
          status = "succeeded";
          const canFollowUp =
            freshRule.chain.followUpCount < freshRule.chain.maxFollowUps &&
            freshRule.enabled &&
            freshRule.state !== "cancelled" &&
            settings.autoFollowUpEnabled;

          if (canFollowUp) {
            const delaySeconds = Math.max(
              1,
              report.nextCheckDelaySeconds ?? DEFAULT_FOLLOW_UP_DELAY_SECONDS,
            );
            followUpRuleId = this.createFollowUpRuleInTx(
              freshRule,
              report.nextPrompt?.trim() || freshRule.prompt,
              new Date(input.settledAt.getTime() + delaySeconds * 1000),
              input.settledAt,
              settings.maxActiveInferredRules,
            );
            importance = report.importance;
          } else {
            // Hard follow-up limit (or disabled auto follow-up) upgrades importance to notify.
            importance = "notify";
          }
        } else {
          status = "succeeded";
          importance = report.importance;
        }
      } else {
        // Tier 4: Missing schedule_report fallback.
        status = "succeeded";
        reportSource = "fallback_answer";
        importance = "notify";
        summary = truncateSummary(input.execResult?.answer ?? "");
      }

      const settledRun: ScheduleRunRecord = {
        ...freshRun,
        finishedAt: settledAtIso,
        status,
        ...(reportSource ? { reportSource } : {}),
        importance,
        ...(summary !== undefined ? { summary } : {}),
        ...(error ? { error } : {}),
        ...(toolFailures ? { toolFailures } : {}),
        ...(followUpRuleId ? { followUpRuleId } : {}),
      };
      this.store.updateScheduleRun(settledRun);

      let nextState: ScheduleRuleState;
      let nextRunAt: string | null;

      if (freshRule.state === "cancelled") {
        nextState = "cancelled";
        nextRunAt = null;
      } else if (
        status === "result_unconfirmed" &&
        (freshRule.trigger.kind === "once" ||
          (freshRule.executionPolicy === "authorized_action" &&
            freshRun.sideEffectDispatched))
      ) {
        nextState = "unconfirmed";
        nextRunAt = null;
      } else if (freshRule.trigger.kind === "once") {
        nextState = freshRule.enabled ? "completed" : "paused";
        nextRunAt = null;
      } else if (!freshRule.enabled) {
        nextState = "paused";
        nextRunAt = computeNextRecurringRunAt(freshRule.trigger, input.settledAt);
      } else {
        nextRunAt = computeNextRecurringRunAt(freshRule.trigger, input.settledAt);
        const expiresAtMs = freshRule.expiresAt ? Date.parse(freshRule.expiresAt) : NaN;
        if (
          nextRunAt &&
          Number.isFinite(expiresAtMs) &&
          Date.parse(nextRunAt) > expiresAtMs
        ) {
          nextState = "expired";
          nextRunAt = null;
        } else {
          nextState = "active";
        }
      }

      const settledRule: ScheduleRule = {
        ...freshRule,
        activeRunId: undefined,
        state: nextState,
        nextRunAt,
        lastRunAt: settledAtIso,
        lastRunId: settledRun.id,
        updatedAt: settledAtIso,
      };
      this.store.updateScheduleRule(settledRule);

      return { settledRun, settledRule };
    });
  }

  private createFollowUpRuleInTx(
    parentRule: ScheduleRule,
    prompt: string,
    runAt: Date,
    now: Date,
    maxActiveInferredRules: number,
  ): string {
    const nowIso = now.toISOString();
    const nextRunAt = runAt.toISOString();
    const trigger: ScheduleTrigger = { kind: "once", runAt: nextRunAt };
    const expiresAt = new Date(
      now.getTime() + DEFAULT_INFERRED_EXPIRES_MS,
    ).toISOString();

    const followUpDedupeKey =
      parentRule.trigger.kind === "once" ? parentRule.dedupeKey : undefined;

    if (followUpDedupeKey) {
      const existing = this.store.findActiveDedupeRule(
        parentRule.origin,
        parentRule.executionPolicy,
        followUpDedupeKey,
      );
      if (existing) {
        const merged: ScheduleRule = {
          ...existing,
          prompt,
          trigger,
          nextRunAt,
          expiresAt,
          chain: {
            rootRuleId: parentRule.chain.rootRuleId,
            followUpCount: Math.max(
              existing.chain.followUpCount,
              parentRule.chain.followUpCount + 1,
            ),
            maxFollowUps: parentRule.chain.maxFollowUps,
          },
          updatedAt: nowIso,
        };
        this.store.updateScheduleRule(merged);
        return merged.id;
      }
    }

    if (parentRule.origin === "agent_inferred") {
      this.evictExcessInferredRules(maxActiveInferredRules, now);
    }

    const childId = `srule_${randomUUID()}`;
    const childRule: ScheduleRule = {
      id: childId,
      title: parentRule.title,
      prompt,
      origin: parentRule.origin,
      ...(followUpDedupeKey ? { dedupeKey: followUpDedupeKey } : {}),
      trigger,
      executionPolicy: parentRule.executionPolicy,
      enabled: true,
      state: "active",
      nextRunAt,
      ...(parentRule.sourceSessionId
        ? { sourceSessionId: parentRule.sourceSessionId }
        : {}),
      ...(parentRule.sourceTaskId ? { sourceTaskId: parentRule.sourceTaskId } : {}),
      chain: {
        rootRuleId: parentRule.chain.rootRuleId,
        followUpCount: parentRule.chain.followUpCount + 1,
        maxFollowUps: parentRule.chain.maxFollowUps,
      },
      misfireGraceSeconds: DEFAULT_ONCE_MISFIRE_GRACE_SECONDS,
      expiresAt,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    this.store.insertScheduleRule(childRule);
    return childRule.id;
  }

  private armNextTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.closed) return;

    const active = this.store.listScheduleRules({ state: "active" });
    const earliest = active.find((rule) => rule.enabled && rule.nextRunAt !== null);
    if (!earliest?.nextRunAt) return;

    const nowMs = this.now().getTime();
    const delayMs = Math.max(
      0,
      Date.parse(earliest.nextRunAt) - nowMs,
      this.skippedBackoffUntilMs - nowMs,
    );
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.reconcileDueRules();
    }, Math.min(delayMs, LOOKAHEAD_CAP_MS));
    this.timer.unref?.();
  }

  async syncNative(): Promise<void> {
    if (!this.nativePort || this.closed) return;
    const settings = this.store.getScheduleSettings();
    const quietSnapshot: NativeQuietHoursSnapshot = {
      quietHoursEnabled: settings.quietHoursEnabled,
      windows: settings.quietHours.map((w) => ({
        id: w.id,
        startMinute: w.startMinute,
        endMinute: w.endMinute,
        ...(w.daysOfWeek ? { daysOfWeek: [...w.daysOfWeek] } : {}),
        enabled: w.enabled,
      })),
    };
    await this.nativePort.syncQuietHours(quietSnapshot);

    const active = this.store
      .listScheduleRules({ state: "active" })
      .filter((rule) => rule.enabled && rule.nextRunAt !== null);
    const alarms: NativeUpcomingAlarm[] = active.slice(0, MAX_SYNC_ALARMS).map((rule) => {
      const triggerAtMs = Date.parse(rule.nextRunAt!);
      return {
        ruleId: rule.id,
        title: rule.title,
        body: truncateSummary(rule.prompt),
        triggerAtMs,
        silent: isWithinQuietHours(new Date(triggerAtMs), settings),
      };
    });
    await this.nativePort.syncUpcomingAlarms(alarms);

    const hasRunningCheck =
      this.activeRun !== undefined ||
      this.store.listScheduleRules({ state: "running" }).length > 0;
    const nextTriggerAtMs =
      alarms.length > 0 ? alarms[0]!.triggerAtMs : null;
    const nowMs = this.now().getTime();
    const withinShortWindow =
      nextTriggerAtMs !== null && nextTriggerAtMs - nowMs <= ANDROID_SHORT_WINDOW_MS;
    await this.nativePort.setAndroidKeepAlive({
      active: hasRunningCheck || withinShortWindow,
      hasRunningCheck,
      nextTriggerAtMs,
    });
  }

  async attachNativePort(port: NativeSchedulePort | null): Promise<void> {
    this.nativePort = port ?? undefined;
    if (this.nativePort && !this.closed) {
      await this.syncNative();
      await this.handleNativeEvents();
    }
  }

  async setForegroundActive(active: boolean): Promise<void> {
    this.foregroundActive = active;
    if (!active) {
      if (this.activeRun && this.nativePort && !this.iosGraceHandle) {
        this.iosGraceHandle = await this.nativePort.beginIosBackgroundGrace(
          `looi.sched.${this.activeRun.ruleId}`,
        );
      }
      await this.syncNative();
      return;
    }

    if (this.iosGraceHandle && this.nativePort) {
      const handle = this.iosGraceHandle;
      this.iosGraceHandle = undefined;
      await Promise.resolve(this.nativePort.endIosBackgroundGrace(handle)).catch(() => {});
    }
    await this.reconcileDueRules();
  }

  async handleNativeEvents(
    providedEvents?: readonly NativeScheduleEvent[],
  ): Promise<{ tappedRule?: ScheduleRule; tappedRun?: ScheduleRunRecord }> {
    const events =
      providedEvents ?? (this.nativePort ? await this.nativePort.drainEvents() : []);
    let tappedRuleId: string | undefined;
    let tappedRunId: string | undefined;
    let shouldReconcile = false;

    for (const event of events) {
      if (event.kind === "notification_tapped") {
        tappedRuleId = event.ruleId;
        tappedRunId = event.runId;
        shouldReconcile = true;
      } else if (event.kind === "alarm_fired") {
        shouldReconcile = true;
      } else if (event.kind === "ios_grace_expiring") {
        if (this.activeRun && !this.foregroundActive) {
          const taskId = this.activeRun.taskId;
          this.activeRun.abortController.abort(
            new ScheduleError({
              stage: "schedule.ios_grace",
              code: "ERR_AGENT_CANCELLED",
              reason: "iOS background grace window expired",
            }),
          );
          await this.options.getExecutor()?.cancel(taskId).catch(() => {});
        }
      } else if (event.kind === "keepalive_timeout") {
        shouldReconcile = true;
      }
    }

    if (shouldReconcile) {
      await this.reconcileDueRules();
    } else if (events.length > 0) {
      await this.syncNative();
    }

    return {
      ...(tappedRuleId ? { tappedRule: this.getRule(tappedRuleId) } : {}),
      ...(tappedRunId ? { tappedRun: this.getRun(tappedRunId) } : {}),
    };
  }

  async cancelActiveRun(): Promise<void> {
    const running = this.activeRun;
    if (!running) return;
    running.abortController.abort(
      new ScheduleError({
        stage: "schedule.cancel",
        code: "ERR_AGENT_CANCELLED",
        reason: "Scheduled run cancelled",
      }),
    );
    await this.options.getExecutor()?.cancel(running.taskId).catch(() => {});
    await running.promise.catch(() => {});
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.cancelActiveRun();
    if (this.iosGraceHandle && this.nativePort) {
      const handle = this.iosGraceHandle;
      this.iosGraceHandle = undefined;
      await Promise.resolve(this.nativePort.endIosBackgroundGrace(handle)).catch(() => {});
    }
    this.activityListeners.clear();
  }
}
