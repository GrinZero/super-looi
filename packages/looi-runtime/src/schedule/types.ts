export interface ScheduleFailure {
  stage: string;
  code?: string | number;
  reason: string;
}

export interface ScheduleToolFailure {
  callId: string;
  toolName: string;
  stage: string;
  code?: string | number;
  reason: string;
}

/** Structured schedule error retaining failure stage, code, and reason. */
export class ScheduleError extends Error implements ScheduleFailure {
  readonly stage: string;
  readonly code?: string | number;
  readonly reason: string;
  override readonly cause?: unknown;

  constructor(failure: ScheduleFailure & { cause?: unknown }) {
    super(failure.reason);
    this.name = "ScheduleError";
    this.stage = failure.stage;
    this.code = failure.code;
    this.reason = failure.reason;
    if (failure.cause !== undefined) {
      this.cause = failure.cause;
    }
  }
}

export type ScheduleTrigger =
  | { kind: "once"; runAt: string }
  | { kind: "interval"; everySeconds: number }
  | { kind: "cron"; expr: string };

export type ScheduleOrigin = "user" | "agent_inferred";
export type ScheduleExecutionPolicy = "check_only" | "authorized_action";

export type ScheduleRuleState =
  | "active"
  | "running"
  | "paused"
  | "completed"
  | "expired"
  | "cancelled"
  | "unconfirmed";

export type ScheduleRunTriggerReason =
  | "scheduled"
  | "misfire_catchup"
  | "manual_now";

export type ScheduleRunStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "awaiting_user"
  | "result_unconfirmed"
  | "missed"
  | "skipped";

export type ScheduleReportSource = "schedule_report" | "fallback_answer";
export type ScheduleImportance = "silent" | "notify";
export type ScheduleReportOutcome = "ok" | "pending" | "failed";

export interface ScheduleChain {
  rootRuleId: string;
  followUpCount: number;
  maxFollowUps: number;
}

export interface ScheduleRule {
  id: string;
  title: string;
  prompt: string;
  origin: ScheduleOrigin;
  dedupeKey?: string;
  trigger: ScheduleTrigger;
  executionPolicy: ScheduleExecutionPolicy;
  enabled: boolean;
  state: ScheduleRuleState;
  activeRunId?: string;
  nextRunAt: string | null;
  lastRunAt?: string;
  lastRunId?: string;
  sourceSessionId?: string;
  sourceTaskId?: string;
  chain: ScheduleChain;
  misfireGraceSeconds: number;
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduleRunRecord {
  id: string;
  ruleId: string;
  ruleTitle: string;
  taskId?: string;
  sessionId?: string;
  triggerReason: ScheduleRunTriggerReason;
  scheduledFor: string;
  startedAt: string;
  finishedAt?: string;
  status: ScheduleRunStatus;
  sideEffectDispatched: boolean;
  reportSource?: ScheduleReportSource;
  importance?: ScheduleImportance;
  summary?: string;
  error?: ScheduleFailure;
  toolFailures?: ScheduleToolFailure[];
  followUpRuleId?: string;
}

export interface QuietHoursWindow {
  id: string;
  label?: string;
  /** Minute of day in [0, 1439]. */
  startMinute: number;
  /** Minute of day in [0, 1439]. When startMinute > endMinute, window spans midnight. */
  endMinute: number;
  /** Weekdays 0 (Sun) .. 6 (Sat). Empty or omitted applies every day. */
  daysOfWeek?: number[];
  enabled: boolean;
}

export interface ScheduleSettings {
  autoFollowUpEnabled: boolean;
  maxActiveInferredRules: number;
  quietHoursEnabled: boolean;
  quietHours: QuietHoursWindow[];
}

export const DEFAULT_SCHEDULE_SETTINGS: ScheduleSettings = {
  autoFollowUpEnabled: true,
  maxActiveInferredRules: 8,
  quietHoursEnabled: false,
  quietHours: [],
};

export type NativeNotificationPermissionStatus =
  | "granted"
  | "denied"
  | "undetermined"
  | "unavailable";

export interface NativePermissionStatusResult {
  notification: NativeNotificationPermissionStatus;
  exactAlarmAllowed?: boolean;
  exactAlarmDegraded?: boolean;
}

export interface NativeUpcomingAlarm {
  ruleId: string;
  title: string;
  body: string;
  triggerAtMs: number;
  silent: boolean;
}

export interface NativeQuietHoursWindowSnapshot {
  id: string;
  startMinute: number;
  endMinute: number;
  daysOfWeek?: number[];
  enabled: boolean;
}

export interface NativeQuietHoursSnapshot {
  quietHoursEnabled: boolean;
  windows: NativeQuietHoursWindowSnapshot[];
}

export interface NativeScheduleNotification {
  id: string;
  ruleId: string;
  runId?: string;
  sessionId?: string;
  title: string;
  body: string;
  silent: boolean;
}

export type NativeScheduleEvent =
  | {
      kind: "notification_tapped";
      ruleId: string;
      runId?: string;
      sessionId?: string;
      timestampMs?: number;
    }
  | {
      kind: "alarm_fired";
      ruleId: string;
      timestampMs?: number;
    }
  | {
      kind: "ios_grace_expiring";
      handle?: string;
      timestampMs?: number;
    }
  | {
      kind: "keepalive_timeout";
      timestampMs?: number;
    }
  | {
      kind: "permission_changed";
      status?: NativePermissionStatusResult;
      timestampMs?: number;
    };

export interface NativeSchedulePort {
  permissionStatus(): Promise<NativePermissionStatusResult> | NativePermissionStatusResult;
  requestPermission(): Promise<NativePermissionStatusResult> | NativePermissionStatusResult;
  syncUpcomingAlarms(alarms: readonly NativeUpcomingAlarm[]): Promise<void> | void;
  cancelAlarm(ruleId: string): Promise<void> | void;
  syncQuietHours(snapshot: NativeQuietHoursSnapshot): Promise<void> | void;
  postNotification(notification: NativeScheduleNotification): Promise<void> | void;
  setAndroidKeepAlive(input: {
    active: boolean;
    hasRunningCheck: boolean;
    nextTriggerAtMs: number | null;
  }): Promise<void> | void;
  beginIosBackgroundGrace(label: string): Promise<string | null> | string | null;
  endIosBackgroundGrace(handle: string): Promise<void> | void;
  drainEvents(): Promise<NativeScheduleEvent[]> | NativeScheduleEvent[];
  openExactAlarmSettings?(): Promise<void> | void;
}

export interface ScheduleReportInput {
  outcome: ScheduleReportOutcome;
  importance: ScheduleImportance;
  summary: string;
  nextCheckDelaySeconds?: number;
  nextPrompt?: string;
  error?: {
    stage?: string;
    code?: string | number;
    reason: string;
  };
}
