import type { AgentTool } from "@earendil-works/pi-agent-core";
import { arr, bool, int, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import {
  ScheduleError,
  type CreateScheduleRuleInput,
  type QuietHoursWindow,
  type ScheduleEngine,
  type ScheduleExecutionPolicy,
  type ScheduleFailure,
  type ScheduleOrigin,
  type ScheduleRuleState,
  type ScheduleTrigger,
  type UpdateScheduleRuleInput,
} from "@super-looi/runtime/schedule";

export type ScheduleToolEngine = Pick<
  ScheduleEngine,
  | "createRule"
  | "listRules"
  | "updateRule"
  | "cancelRule"
  | "runNow"
  | "getSettings"
  | "addQuietHoursWindow"
  | "updateQuietHoursWindow"
  | "removeQuietHoursWindow"
  | "setQuietHoursEnabled"
  | "isQuietHoursNow"
>;

export interface ScheduleExecutionContext {
  sourceSessionId?: string;
  sourceTaskId?: string;
  checkOnly?: boolean;
  now?: () => Date;
  onMutated?: () => void;
}

export interface ScheduleToolsHost extends ScheduleExecutionContext {
  engine: ScheduleToolEngine;
}

const VALID_SCHEDULE_ACTIONS = new Set([
  "create",
  "list",
  "update",
  "cancel",
  "run_now",
]);
const VALID_QUIET_ACTIONS = new Set([
  "list",
  "add",
  "update",
  "remove",
  "set_enabled",
]);
const VALID_RULE_STATES = new Set<ScheduleRuleState>([
  "active",
  "running",
  "paused",
  "completed",
  "expired",
  "cancelled",
  "unconfirmed",
]);

function strOpt(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function parseOptionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const num = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isFinite(num) ? num : NaN;
}

function parseOptionalBool(value: unknown): boolean | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const lower = value.trim().toLowerCase();
    if (lower === "true" || lower === "1" || lower === "yes") return true;
    if (lower === "false" || lower === "0" || lower === "no") return false;
  }
  throw new ScheduleError({
    stage: "schedule.validate",
    code: "ERR_INVALID_ARGUMENT",
    reason: `Invalid boolean value: ${String(value)}`,
  });
}

function parseMinuteOfDay(
  minuteRaw: unknown,
  timeRaw: unknown,
  fieldLabel: string,
): number | undefined {
  const num = parseOptionalNumber(minuteRaw);
  if (num !== undefined) {
    if (!Number.isInteger(num) || num < 0 || num > 1439) {
      throw new ScheduleError({
        stage: "schedule.quiet_hours.validate",
        code: "ERR_INVALID_ARGUMENT",
        reason: `${fieldLabel}Minute must be an integer in [0, 1439], got ${String(minuteRaw)}`,
      });
    }
    return num;
  }
  const timeStr = strOpt(timeRaw);
  if (timeStr !== undefined) {
    const match = timeStr.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
    if (!match) {
      throw new ScheduleError({
        stage: "schedule.quiet_hours.validate",
        code: "ERR_INVALID_ARGUMENT",
        reason: `${fieldLabel}Time must use 24-hour HH:MM format (e.g. "23:00"), got "${timeStr}"`,
      });
    }
    return Number(match[1]) * 60 + Number(match[2]);
  }
  return undefined;
}

function parseDaysOfWeek(raw: unknown): number[] | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const entries = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? raw
          .split(/[,\s]+/)
          .map((item) => item.trim())
          .filter(Boolean)
      : null;
  if (!entries) {
    throw new ScheduleError({
      stage: "schedule.quiet_hours.validate",
      code: "ERR_INVALID_ARGUMENT",
      reason: "daysOfWeek must be an array or comma-separated list of weekday numbers 0..6",
    });
  }
  if (entries.length === 0) return [];
  const seen = new Set<number>();
  const normalized: number[] = [];
  for (const item of entries) {
    const num = Number(item);
    if (!Number.isInteger(num) || num < 0 || num > 7) {
      throw new ScheduleError({
        stage: "schedule.quiet_hours.validate",
        code: "ERR_INVALID_ARGUMENT",
        reason: `Weekday "${String(item)}" must be an integer in 0..7`,
      });
    }
    const day = num === 7 ? 0 : num;
    if (!seen.has(day)) {
      seen.add(day);
      normalized.push(day);
    }
  }
  return normalized;
}

function parseTriggerFromArgs(
  args: Record<string, unknown>,
  now: () => Date,
  required: boolean,
): ScheduleTrigger | undefined {
  const rawTrigger =
    args.trigger && typeof args.trigger === "object"
      ? (args.trigger as Record<string, unknown>)
      : undefined;

  const explicitKind = strOpt(
    rawTrigger?.kind ?? args.triggerKind ?? args.trigger_kind,
  );
  const delaySeconds = parseOptionalNumber(
    rawTrigger?.delaySeconds ?? args.delaySeconds ?? args.delay_seconds,
  );
  const runAt = strOpt(rawTrigger?.runAt ?? args.runAt ?? args.run_at);
  const everySeconds = parseOptionalNumber(
    rawTrigger?.everySeconds ?? args.everySeconds ?? args.every_seconds,
  );
  const cronExpr = strOpt(
    rawTrigger?.expr ??
      rawTrigger?.cronExpr ??
      args.cronExpr ??
      args.cron_expr,
  );

  let kind = explicitKind;
  if (!kind) {
    const inferred: string[] = [];
    if (delaySeconds !== undefined || runAt !== undefined) inferred.push("once");
    if (everySeconds !== undefined) inferred.push("interval");
    if (cronExpr !== undefined) inferred.push("cron");
    if (inferred.length === 1) {
      kind = inferred[0];
    } else if (inferred.length > 1) {
      throw new ScheduleError({
        stage: "schedule.trigger.validate",
        code: "ERR_INVALID_TRIGGER",
        reason: "Ambiguous trigger fields; specify triggerKind explicitly",
      });
    }
  }

  if (!kind) {
    if (!required) return undefined;
    throw new ScheduleError({
      stage: "schedule.trigger.validate",
      code: "ERR_INVALID_TRIGGER",
      reason:
        "Trigger is required: supply triggerKind ('once' | 'interval' | 'cron') with delaySeconds/runAt, everySeconds, or cronExpr",
    });
  }

  if (kind === "once") {
    if (delaySeconds !== undefined) {
      if (!Number.isFinite(delaySeconds) || delaySeconds < 1) {
        throw new ScheduleError({
          stage: "schedule.trigger.validate",
          code: "ERR_INVALID_TRIGGER",
          reason: `delaySeconds must be >= 1, got ${String(args.delaySeconds ?? args.delay_seconds)}`,
        });
      }
      return {
        kind: "once",
        runAt: new Date(now().getTime() + Math.round(delaySeconds) * 1000).toISOString(),
      };
    }
    if (!runAt) {
      throw new ScheduleError({
        stage: "schedule.trigger.validate",
        code: "ERR_INVALID_TRIGGER",
        reason: "Once trigger requires delaySeconds or runAt",
      });
    }
    return { kind: "once", runAt };
  }

  if (kind === "interval") {
    if (everySeconds === undefined || !Number.isFinite(everySeconds)) {
      throw new ScheduleError({
        stage: "schedule.trigger.validate",
        code: "ERR_INVALID_TRIGGER",
        reason: "Interval trigger requires numeric everySeconds (>= 60)",
      });
    }
    return { kind: "interval", everySeconds };
  }

  if (kind === "cron") {
    if (!cronExpr) {
      throw new ScheduleError({
        stage: "schedule.trigger.validate",
        code: "ERR_INVALID_TRIGGER",
        reason: "Cron trigger requires cronExpr",
      });
    }
    return { kind: "cron", expr: cronExpr };
  }

  throw new ScheduleError({
    stage: "schedule.trigger.validate",
    code: "ERR_INVALID_TRIGGER",
    reason: `Unsupported triggerKind "${kind}"`,
  });
}

/** Shared validation & execution for Pi and Voice `manage_schedule` tools. */
export async function executeManageSchedule(
  engine: ScheduleToolEngine,
  rawArgs: Record<string, unknown>,
  context: ScheduleExecutionContext = {},
): Promise<Record<string, unknown>> {
  const action = strOpt(rawArgs.action) ?? "";
  if (!VALID_SCHEDULE_ACTIONS.has(action)) {
    throw new ScheduleError({
      stage: "schedule.validate",
      code: "ERR_INVALID_ARGUMENT",
      reason: `Unsupported manage_schedule action "${action}"`,
    });
  }

  if (context.checkOnly && action !== "list") {
    throw new ScheduleError({
      stage: "schedule.policy",
      code: "ERR_SCHEDULE_CHECK_ONLY_TOOL_DENIED",
      reason: `manage_schedule action "${action}" is denied under check_only schedule policy; only "list" is permitted`,
    });
  }

  const now = context.now ?? (() => new Date());

  if (action === "list") {
    const stateRaw = strOpt(rawArgs.state);
    if (stateRaw && !VALID_RULE_STATES.has(stateRaw as ScheduleRuleState)) {
      throw new ScheduleError({
        stage: "schedule.list",
        code: "ERR_INVALID_ARGUMENT",
        reason: `Unsupported rule state filter "${stateRaw}"`,
      });
    }
    const originRaw = strOpt(rawArgs.origin);
    if (originRaw && originRaw !== "user" && originRaw !== "agent_inferred") {
      throw new ScheduleError({
        stage: "schedule.list",
        code: "ERR_INVALID_ARGUMENT",
        reason: `Unsupported origin filter "${originRaw}"`,
      });
    }
    const rules = engine.listRules({
      ...(stateRaw ? { state: stateRaw as ScheduleRuleState } : {}),
      ...(originRaw ? { origin: originRaw as ScheduleOrigin } : {}),
    });
    return { count: rules.length, rules };
  }

  if (action === "create") {
    const title = strOpt(rawArgs.title) ?? "";
    const prompt = strOpt(rawArgs.prompt) ?? "";
    if (!title || !prompt) {
      throw new ScheduleError({
        stage: "schedule.create",
        code: "ERR_INVALID_RULE",
        reason: "Both title and prompt are required to create a schedule rule",
      });
    }
    const originRaw = strOpt(rawArgs.origin);
    const origin: ScheduleOrigin =
      originRaw === "agent_inferred" ? "agent_inferred" : "user";
    const policyRaw = strOpt(rawArgs.executionPolicy ?? rawArgs.execution_policy);
    if (policyRaw && policyRaw !== "check_only" && policyRaw !== "authorized_action") {
      throw new ScheduleError({
        stage: "schedule.create",
        code: "ERR_INVALID_ARGUMENT",
        reason: `Unsupported executionPolicy "${policyRaw}"`,
      });
    }
    const executionPolicy: ScheduleExecutionPolicy =
      policyRaw === "authorized_action" ? "authorized_action" : "check_only";
    const trigger = parseTriggerFromArgs(rawArgs, now, true)!;
    const dedupeKey = strOpt(rawArgs.dedupeKey ?? rawArgs.dedupe_key);
    const enabled = parseOptionalBool(rawArgs.enabled);
    const misfireGraceSeconds = parseOptionalNumber(
      rawArgs.misfireGraceSeconds ?? rawArgs.misfire_grace_seconds,
    );
    const maxFollowUps = parseOptionalNumber(
      rawArgs.maxFollowUps ?? rawArgs.max_follow_ups,
    );
    const expiresAt = strOpt(rawArgs.expiresAt ?? rawArgs.expires_at);

    const input: CreateScheduleRuleInput = {
      title,
      prompt,
      origin,
      executionPolicy,
      trigger,
      ...(dedupeKey ? { dedupeKey } : {}),
      ...(enabled !== undefined ? { enabled } : {}),
      ...(misfireGraceSeconds !== undefined && Number.isFinite(misfireGraceSeconds)
        ? { misfireGraceSeconds: Math.round(misfireGraceSeconds) }
        : {}),
      ...(maxFollowUps !== undefined && Number.isFinite(maxFollowUps)
        ? { maxFollowUps: Math.round(maxFollowUps) }
        : {}),
      ...(expiresAt ? { expiresAt } : {}),
      ...(context.sourceSessionId ? { sourceSessionId: context.sourceSessionId } : {}),
      ...(context.sourceTaskId ? { sourceTaskId: context.sourceTaskId } : {}),
    };
    const { rule, merged } = engine.createRule(input);
    context.onMutated?.();
    return { created: true, merged, rule };
  }

  const ruleId = strOpt(rawArgs.ruleId ?? rawArgs.rule_id);
  if (!ruleId) {
    throw new ScheduleError({
      stage: `schedule.${action}`,
      code: "ERR_INVALID_ARGUMENT",
      reason: `ruleId is required for action "${action}"`,
    });
  }

  if (action === "update") {
    const patch: UpdateScheduleRuleInput = {};
    const title = strOpt(rawArgs.title);
    const prompt = strOpt(rawArgs.prompt);
    const trigger = parseTriggerFromArgs(rawArgs, now, false);
    const policyRaw = strOpt(rawArgs.executionPolicy ?? rawArgs.execution_policy);
    const enabled = parseOptionalBool(rawArgs.enabled);
    const dedupeKeyRaw = rawArgs.dedupeKey ?? rawArgs.dedupe_key;
    const expiresAtRaw = rawArgs.expiresAt ?? rawArgs.expires_at;
    const misfireGraceSeconds = parseOptionalNumber(
      rawArgs.misfireGraceSeconds ?? rawArgs.misfire_grace_seconds,
    );
    const maxFollowUps = parseOptionalNumber(
      rawArgs.maxFollowUps ?? rawArgs.max_follow_ups,
    );

    if (title !== undefined) patch.title = title;
    if (prompt !== undefined) patch.prompt = prompt;
    if (trigger !== undefined) patch.trigger = trigger;
    if (policyRaw !== undefined) {
      if (policyRaw !== "check_only" && policyRaw !== "authorized_action") {
        throw new ScheduleError({
          stage: "schedule.update",
          code: "ERR_INVALID_ARGUMENT",
          reason: `Unsupported executionPolicy "${policyRaw}"`,
        });
      }
      patch.executionPolicy = policyRaw;
    }
    if (enabled !== undefined) patch.enabled = enabled;
    if (dedupeKeyRaw === null) patch.dedupeKey = null;
    else if (typeof dedupeKeyRaw === "string") {
      patch.dedupeKey = dedupeKeyRaw.trim() || null;
    }
    if (expiresAtRaw === null) patch.expiresAt = null;
    else if (typeof expiresAtRaw === "string") {
      patch.expiresAt = expiresAtRaw.trim() || null;
    }
    if (misfireGraceSeconds !== undefined && Number.isFinite(misfireGraceSeconds)) {
      patch.misfireGraceSeconds = Math.round(misfireGraceSeconds);
    }
    if (maxFollowUps !== undefined && Number.isFinite(maxFollowUps)) {
      patch.maxFollowUps = Math.round(maxFollowUps);
    }

    const rule = engine.updateRule(ruleId, patch);
    context.onMutated?.();
    return { updated: true, rule };
  }

  if (action === "cancel") {
    const rule = await engine.cancelRule(ruleId);
    context.onMutated?.();
    return { cancelled: true, rule };
  }

  const run = await engine.runNow(ruleId);
  return { run };
}

/** Shared validation & execution for Pi and Voice `manage_quiet_hours` tools. */
export function executeManageQuietHours(
  engine: ScheduleToolEngine,
  rawArgs: Record<string, unknown>,
): Record<string, unknown> {
  const action = strOpt(rawArgs.action) ?? "";
  if (!VALID_QUIET_ACTIONS.has(action)) {
    throw new ScheduleError({
      stage: "schedule.quiet_hours.validate",
      code: "ERR_INVALID_ARGUMENT",
      reason: `Unsupported manage_quiet_hours action "${action}"`,
    });
  }

  if (action === "list") {
    return {
      settings: engine.getSettings(),
      isQuietNow: engine.isQuietHoursNow(),
    };
  }

  if (action === "set_enabled") {
    const enabled = parseOptionalBool(rawArgs.enabled);
    if (enabled === undefined) {
      throw new ScheduleError({
        stage: "schedule.quiet_hours.set_enabled",
        code: "ERR_INVALID_ARGUMENT",
        reason: "enabled (true/false) is required for set_enabled",
      });
    }
    const settings = engine.setQuietHoursEnabled(enabled);
    return { settings, isQuietNow: engine.isQuietHoursNow() };
  }

  if (action === "add") {
    const startMinute = parseMinuteOfDay(
      rawArgs.startMinute ?? rawArgs.start_minute,
      rawArgs.startTime ?? rawArgs.start_time,
      "start",
    );
    const endMinute = parseMinuteOfDay(
      rawArgs.endMinute ?? rawArgs.end_minute,
      rawArgs.endTime ?? rawArgs.end_time,
      "end",
    );
    if (startMinute === undefined || endMinute === undefined) {
      throw new ScheduleError({
        stage: "schedule.quiet_hours.validate",
        code: "ERR_INVALID_ARGUMENT",
        reason: "Both startTime/startMinute and endTime/endMinute are required",
      });
    }
    if (startMinute === endMinute) {
      throw new ScheduleError({
        stage: "schedule.quiet_hours.validate",
        code: "ERR_INVALID_ARGUMENT",
        reason: "Start and end times cannot be identical",
      });
    }
    const windowId = strOpt(rawArgs.windowId ?? rawArgs.window_id ?? rawArgs.id);
    const label = strOpt(rawArgs.label);
    const daysOfWeek = parseDaysOfWeek(rawArgs.daysOfWeek ?? rawArgs.days_of_week);
    const enabled = parseOptionalBool(rawArgs.enabled) ?? true;
    const enableGlobal = parseOptionalBool(
      rawArgs.enableQuietHours ?? rawArgs.enable_quiet_hours,
    );

    let settings = engine.addQuietHoursWindow({
      ...(windowId ? { id: windowId } : {}),
      ...(label ? { label } : {}),
      startMinute,
      endMinute,
      ...(daysOfWeek && daysOfWeek.length > 0 ? { daysOfWeek } : {}),
      enabled,
    });
    if (enabled && !settings.quietHoursEnabled && enableGlobal !== false) {
      settings = engine.setQuietHoursEnabled(true);
    }
    return { settings, isQuietNow: engine.isQuietHoursNow() };
  }

  const windowId = strOpt(rawArgs.windowId ?? rawArgs.window_id ?? rawArgs.id);
  if (!windowId) {
    throw new ScheduleError({
      stage: `schedule.quiet_hours.${action}`,
      code: "ERR_INVALID_ARGUMENT",
      reason: `windowId is required for action "${action}"`,
    });
  }

  if (action === "remove") {
    const settings = engine.removeQuietHoursWindow(windowId);
    return { settings, isQuietNow: engine.isQuietHoursNow() };
  }

  const startMinute = parseMinuteOfDay(
    rawArgs.startMinute ?? rawArgs.start_minute,
    rawArgs.startTime ?? rawArgs.start_time,
    "start",
  );
  const endMinute = parseMinuteOfDay(
    rawArgs.endMinute ?? rawArgs.end_minute,
    rawArgs.endTime ?? rawArgs.end_time,
    "end",
  );
  const label = strOpt(rawArgs.label);
  const daysOfWeek = parseDaysOfWeek(rawArgs.daysOfWeek ?? rawArgs.days_of_week);
  const enabled = parseOptionalBool(rawArgs.enabled);

  const patch: Partial<Omit<QuietHoursWindow, "id">> = {
    ...(label !== undefined ? { label } : {}),
    ...(startMinute !== undefined ? { startMinute } : {}),
    ...(endMinute !== undefined ? { endMinute } : {}),
    ...(daysOfWeek !== undefined ? { daysOfWeek } : {}),
    ...(enabled !== undefined ? { enabled } : {}),
  };
  const settings = engine.updateQuietHoursWindow(windowId, patch);
  return { settings, isQuietNow: engine.isQuietHoursNow() };
}

function toToolFailure(error: unknown, fallbackStage: string): ScheduleFailure {
  if (error instanceof ScheduleError) {
    return {
      stage: error.stage,
      ...(error.code !== undefined ? { code: error.code } : {}),
      reason: error.reason,
    };
  }
  if (error && typeof error === "object") {
    const objErr = error as { stage?: unknown; code?: unknown; message?: unknown };
    return {
      stage: typeof objErr.stage === "string" && objErr.stage ? objErr.stage : fallbackStage,
      ...(typeof objErr.code === "string" || typeof objErr.code === "number"
        ? { code: objErr.code }
        : {}),
      reason: typeof objErr.message === "string" ? objErr.message : String(error),
    };
  }
  return { stage: fallbackStage, code: "ERR_SCHEDULE_TOOL_FAILED", reason: String(error) };
}

function piSuccess(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    details: value,
  };
}

function piFailure(error: unknown, fallbackStage: string) {
  const failure = toToolFailure(error, fallbackStage);
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ failure }) }],
    details: { failure },
    isError: true,
  };
}

const manageScheduleParams = obj({
  action: oneOf(["create", "list", "update", "cancel", "run_now"]),
  ruleId: opt(str({ description: "Rule ID required for update, cancel, or run_now." })),
  title: opt(str({ description: "Short rule title (required for create)." })),
  prompt: opt(str({ description: "Self-contained prompt to execute when triggered (required for create)." })),
  origin: opt(oneOf(["user", "agent_inferred"], { description: "Use 'agent_inferred' for silent background follow-up checks, or 'user' for explicit user requests." })),
  executionPolicy: opt(oneOf(["check_only", "authorized_action"], { description: "'check_only' for strictly read-only checks; 'authorized_action' only for explicit user-authorized tasks." })),
  dedupeKey: opt(str({ description: "Optional deduplication key scoped to (origin, executionPolicy, dedupeKey)." })),
  triggerKind: opt(oneOf(["once", "interval", "cron"], { description: "Trigger kind for create or update." })),
  delaySeconds: opt(int({ minimum: 1, description: "Relative delay in seconds from now for triggerKind='once'." })),
  runAt: opt(str({ description: "ISO-8601 timestamp for triggerKind='once' when delaySeconds is omitted." })),
  everySeconds: opt(int({ minimum: 60, description: "Repeat interval in seconds (>= 60) for triggerKind='interval'." })),
  cronExpr: opt(str({ description: "Standard 5-field cron expression (minute hour dom month dow) for triggerKind='cron'." })),
  enabled: opt(bool({ description: "Enable or pause the rule." })),
  misfireGraceSeconds: opt(int({ minimum: 1, description: "Catch-up grace window in seconds." })),
  maxFollowUps: opt(int({ minimum: 0, description: "Maximum chained follow-up attempts." })),
  expiresAt: opt(str({ description: "Optional ISO-8601 expiration timestamp." })),
  state: opt(oneOf(["active", "running", "paused", "completed", "expired", "cancelled", "unconfirmed"], { description: "Optional state filter for action='list'." })),
});

const manageQuietHoursParams = obj({
  action: oneOf(["list", "add", "update", "remove", "set_enabled"]),
  windowId: opt(str({ description: "Quiet hours window ID required for update or remove." })),
  label: opt(str({ description: "Optional window label (e.g. '夜间勿扰')." })),
  startTime: opt(str({ description: "24-hour local HH:MM start time (e.g. '23:00')." })),
  endTime: opt(str({ description: "24-hour local HH:MM end time (e.g. '08:00'). Values earlier than startTime span midnight." })),
  startMinute: opt(int({ minimum: 0, maximum: 1439, description: "Minute of day [0..1439] alternative to startTime." })),
  endMinute: opt(int({ minimum: 0, maximum: 1439, description: "Minute of day [0..1439] alternative to endTime." })),
  daysOfWeek: opt(arr(int({ minimum: 0, maximum: 7 }), { description: "Optional weekday filter 0(Sun)..6(Sat)." })),
  enabled: opt(bool({ description: "Window enabled flag (for add/update) or global quietHoursEnabled toggle (for set_enabled)." })),
});

/** Creates `manage_schedule` and `manage_quiet_hours` Pi Agent tools bound to task provenance. */
export function createScheduleTools(host: ScheduleToolsHost): AgentTool<any>[] {
  return [
    {
      name: "manage_schedule",
      label: "管理定时规则",
      description:
        "Create, list, update, cancel, or run scheduled follow-up checks and recurring tasks. For silent follow-ups after submitting a PR or Codex Cloud task, use action='create', origin='agent_inferred', executionPolicy='check_only', a unique dedupeKey, and a self-contained prompt specifying repo/PR or taskId.",
      parameters: manageScheduleParams,
      executionMode: "sequential",
      execute: async (_callId, params) => {
        try {
          return piSuccess(
            await executeManageSchedule(
              host.engine,
              params as unknown as Record<string, unknown>,
              {
                sourceSessionId: host.sourceSessionId,
                sourceTaskId: host.sourceTaskId,
                checkOnly: host.checkOnly,
                now: host.now,
                onMutated: host.onMutated,
              },
            ),
          );
        } catch (error) {
          return piFailure(error, "schedule.manage");
        }
      },
    },
    ...(host.checkOnly
      ? []
      : [
          {
            name: "manage_quiet_hours",
            label: "管理勿扰时段",
            description:
              "List, add, update, remove, or globally toggle quiet-hours windows (supporting cross-midnight local ranges like 23:00 to 08:00).",
            parameters: manageQuietHoursParams,
            executionMode: "sequential" as const,
            execute: async (_callId: string, params: Record<string, unknown>) => {
              try {
                return piSuccess(executeManageQuietHours(host.engine, params));
              } catch (error) {
                return piFailure(error, "schedule.quiet_hours");
              }
            },
          },
        ]),
  ];
}
