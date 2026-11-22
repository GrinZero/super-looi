import { computed, effect, keyboardFrame, reduceMotion, Scroll, signal, Text, View, windowSize } from "nsh";
import { AlertDialog, Button, Dialog, Input } from "nsh/base";
import {
  isWithinQuietHours,
  parseCron,
  previewCronOccurrences,
  type QuietHoursWindow,
  type ScheduleFailure,
  type ScheduleRule,
  type ScheduleRunRecord,
  type ScheduleTrigger,
} from "../generated/looi-runtime.js";
import { formatDate, t, translateMessage } from "../i18n";
import type { createAppStore, ScheduleRuleFilter } from "../store";
import { ActionButton, IconButton, LoadingIndicator, TextField, ToggleSwitch } from "./Controls";

type TriggerKindOption = "once" | "interval" | "daily" | "cron";

const DAY_KEYS = [
  "daySun",
  "dayMon",
  "dayTue",
  "dayWed",
  "dayThu",
  "dayFri",
  "daySat",
] as const;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function formatMinuteClock(totalMinutes: number): string {
  const clamped = ((Math.trunc(totalMinutes) % 1440) + 1440) % 1440;
  return `${pad2(Math.floor(clamped / 60))}:${pad2(clamped % 60)}`;
}

function parseMinuteClock(raw: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }
  return hour * 60 + minute;
}

function formatLocalDateTime(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function parseLocalDateTimeInput(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(trimmed);
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    const second = match[6] ? Number(match[6]) : 0;
    const date = new Date(year, month - 1, day, hour, minute, second, 0);
    if (
      date.getFullYear() === year &&
      date.getMonth() === month - 1 &&
      date.getDate() === day &&
      date.getHours() === hour &&
      date.getMinutes() === minute
    ) {
      return date.toISOString();
    }
    return null;
  }
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function formatTriggerSummary(trigger: ScheduleTrigger): string {
  if (trigger.kind === "once") {
    return t("scheduleTriggerOnce", { time: formatDate(trigger.runAt) });
  }
  if (trigger.kind === "interval") {
    if (trigger.everySeconds >= 60 && trigger.everySeconds % 60 === 0) {
      return t("scheduleTriggerIntervalMin", { minutes: trigger.everySeconds / 60 });
    }
    return t("scheduleTriggerIntervalSec", { seconds: trigger.everySeconds });
  }
  const dailyMatch = /^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*$/.exec(trigger.expr.trim());
  if (dailyMatch) {
    const min = Number(dailyMatch[1]);
    const hour = Number(dailyMatch[2]);
    if (min >= 0 && min <= 59 && hour >= 0 && hour <= 23) {
      return t("scheduleTriggerDaily", { time: formatMinuteClock(hour * 60 + min) });
    }
  }
  return t("scheduleTriggerCron", { expr: trigger.expr });
}

function formatFailureLine(err: ScheduleFailure): string {
  const codePart = err.code !== undefined ? ` code=${String(err.code)}` : "";
  return `[stage=${err.stage}${codePart}] ${err.reason}`;
}

function extractInlineError(err: unknown): string {
  if (err && typeof err === "object") {
    const info = err as { stage?: unknown; code?: unknown; reason?: unknown; message?: unknown };
    const stage = typeof info.stage === "string" && info.stage ? info.stage : undefined;
    const code =
      typeof info.code === "string" || typeof info.code === "number"
        ? ` code=${String(info.code)}`
        : "";
    const rawReason =
      typeof info.reason === "string" && info.reason
        ? info.reason
        : err instanceof Error
          ? err.message
          : String(err);
    const reason = translateMessage(rawReason);
    if (stage) return `[stage=${stage}${code}] ${reason}`;
    if (code) return `[${code.trim()}] ${reason}`;
    return reason;
  }
  return translateMessage(err instanceof Error ? err.message : String(err));
}

function ruleStatusDotClass(rule: ScheduleRule): string {
  if (rule.state === "running") return "w-2 h-2 rounded-full bg-verified";
  if (rule.state === "active" && rule.enabled) return "w-2 h-2 rounded-full bg-verified";
  if (rule.state === "unconfirmed" || rule.state === "expired") {
    return "w-2 h-2 rounded-full bg-warning";
  }
  return "w-2 h-2 rounded-full bg-subtle-text";
}

function ruleStatusLabel(rule: ScheduleRule): string {
  switch (rule.state) {
    case "running":
      return t("scheduleStateRunning");
    case "active":
      return rule.enabled ? t("scheduleStateActive") : t("scheduleStatePaused");
    case "paused":
      return t("scheduleStatePaused");
    case "completed":
      return t("scheduleStateCompleted");
    case "expired":
      return t("scheduleStateExpired");
    case "cancelled":
      return t("scheduleStateCancelled");
    case "unconfirmed":
      return t("scheduleStateUnconfirmed");
  }
}

function canToggleRuleEnabled(rule: ScheduleRule): boolean {
  return rule.state === "active" || rule.state === "paused";
}

function runStatusDotClass(status: ScheduleRunRecord["status"]): string {
  if (status === "succeeded" || status === "running") return "w-2 h-2 rounded-full bg-verified";
  if (status === "failed") return "w-2 h-2 rounded-full bg-destructive";
  if (status === "result_unconfirmed" || status === "awaiting_user" || status === "missed") {
    return "w-2 h-2 rounded-full bg-warning";
  }
  return "w-2 h-2 rounded-full bg-subtle-text";
}

function runStatusLabel(status: ScheduleRunRecord["status"]): string {
  switch (status) {
    case "running":
      return t("scheduleRunRunning");
    case "succeeded":
      return t("scheduleRunSucceeded");
    case "failed":
      return t("scheduleRunFailed");
    case "awaiting_user":
      return t("scheduleRunAwaitingUser");
    case "result_unconfirmed":
      return t("scheduleRunUnconfirmed");
    case "missed":
      return t("scheduleRunMissed");
    case "skipped":
      return t("scheduleRunSkipped");
  }
}

function runReasonLabel(reason: ScheduleRunRecord["triggerReason"]): string {
  switch (reason) {
    case "scheduled":
      return t("scheduleReasonScheduled");
    case "misfire_catchup":
      return t("scheduleReasonCatchup");
    case "manual_now":
      return t("scheduleReasonManual");
  }
}

function formatQuietRange(win: QuietHoursWindow): string {
  const start = formatMinuteClock(win.startMinute);
  const end = formatMinuteClock(win.endMinute);
  if (win.endMinute < win.startMinute) {
    return t("quietNextDayTime", { start, end });
  }
  return t("quietSameDayTime", { start, end });
}

function formatDaysLabel(days?: number[]): string {
  if (!days || days.length === 0 || days.length >= 7) return t("quietEveryDay");
  const normalized = Array.from(new Set(days.map((d) => (d === 7 ? 0 : d)))).sort((a, b) => a - b);
  if (normalized.length === 7) return t("quietEveryDay");
  if (normalized.length === 5 && [1, 2, 3, 4, 5].every((d, i) => normalized[i] === d)) {
    return t("quietWeekdaysOnly");
  }
  if (normalized.length === 2 && normalized[0] === 0 && normalized[1] === 6) {
    return t("quietWeekendOnly");
  }
  return normalized.map((d) => t(DAY_KEYS[d] ?? "daySun")).join(" / ");
}

function permissionStatusLabel(status: string): string {
  switch (status) {
    case "granted":
      return t("schedulePermGranted");
    case "denied":
      return t("schedulePermDenied");
    case "undetermined":
      return t("schedulePermUndetermined");
    default:
      return t("schedulePermUnavailable");
  }
}

/** 48pt context header strip for the Schedules space in ManagementShell. */
export function SchedulesContextBar(props: {
  store: ReturnType<typeof createAppStore>;
  onNewRule: () => void;
  onAddQuietWindow: () => void;
}) {
  const quietNow = computed(() => {
    const tick = props.store.scheduleClockTick();
    return isWithinQuietHours(new Date(tick), props.store.scheduleSettings());
  });

  return (
    <View class="flex-1 min-w-0 flex-row items-center justify-between gap-2 h-11">
      <View class="flex-row items-center gap-1.5 min-w-0">
        <Button
          testID="schedules-subview-rules"
          selected={props.store.scheduleSubView() === "rules"}
          onPress={() => props.store.setScheduleSubView("rules")}
          class={
            props.store.scheduleSubView() === "rules"
              ? "min-h-11 px-3 rounded-full bg-primary items-center justify-center active:opacity-70 transition-colors duration-150 motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-ring"
              : "min-h-11 px-3 rounded-full bg-muted items-center justify-center hover:bg-secondary active:opacity-70 transition-colors duration-150 motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-ring"
          }
        >
          <Text
            class={
              props.store.scheduleSubView() === "rules"
                ? "text-primary-foreground text-xs font-semibold"
                : "text-muted-foreground text-xs font-medium"
            }
            style={{ fontVariant: ["tabular-nums"] }}
          >
            {t("schedulesTabRules", { count: props.store.scheduleRules().length })}
          </Text>
        </Button>

        <Button
          testID="schedules-subview-quiet"
          selected={props.store.scheduleSubView() === "quiet"}
          onPress={() => props.store.setScheduleSubView("quiet")}
          class={
            props.store.scheduleSubView() === "quiet"
              ? "min-h-11 px-3 rounded-full bg-primary flex-row items-center justify-center gap-1.5 active:opacity-70 transition-colors duration-150 motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-ring"
              : "min-h-11 px-3 rounded-full bg-muted flex-row items-center justify-center gap-1.5 hover:bg-secondary active:opacity-70 transition-colors duration-150 motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-ring"
          }
        >
          <Text
            class={
              props.store.scheduleSubView() === "quiet"
                ? "text-primary-foreground text-xs font-semibold"
                : "text-muted-foreground text-xs font-medium"
            }
          >
            {t("schedulesTabQuiet")}
          </Text>
          <If when={quietNow()}>
            <View testID="quiet-active-header-dot" class="w-2 h-2 rounded-full bg-warning" />
          </If>
        </Button>
      </View>

      <View class="flex-row items-center gap-2 shrink-0">
        <View class="min-h-11 px-3 rounded-full bg-secondary flex-row items-center gap-2">
          <Text class="text-secondary-foreground text-xs font-medium">
            {t("scheduleAutoFollowUp")}
          </Text>
          <ToggleSwitch
            testID="schedule-auto-followup-toggle"
            accessibilityLabel={t("scheduleAutoFollowUp")}
            checked={props.store.scheduleSettings().autoFollowUpEnabled}
            hitSlop={8}
            onChange={(value) => props.store.setAutoFollowUpEnabled(value)}
          />
        </View>

        <If
          when={props.store.scheduleSubView() === "rules"}
          else={
            <ActionButton
              compact
              kind="primary"
              testID="schedule-add-quiet-btn"
              label={t("scheduleAddQuietWindow")}
              onPress={() => props.onAddQuietWindow()}
            />
          }
        >
          <ActionButton
            compact
            kind="primary"
            testID="schedule-new-rule-btn"
            label={t("scheduleNewRule")}
            onPress={() => props.onNewRule()}
          />
        </If>
      </View>
    </View>
  );
}

/** Schedules & Quiet Hours workspace implementing Layer 4 rules, runs, quiet windows, and GitHub PAT settings. */
export function SchedulesSpaceView(props: {
  store: ReturnType<typeof createAppStore>;
  createRuleNonce: () => number;
  addQuietNonce: () => number;
}) {
  const wide = () => windowSize().width >= 600;
  const subView = () => props.store.scheduleSubView();
  const ruleFilter = () => props.store.scheduleRuleFilter();

  const filteredRules = computed(() => {
    const filter = ruleFilter();
    const rules = props.store.scheduleRules();
    if (filter === "all") return rules;
    return rules.filter((rule) => rule.origin === filter);
  });

  const selectedRule = computed(() => {
    const id = props.store.selectedScheduleRuleId();
    if (!id) return undefined;
    return props.store.scheduleRules().find((rule) => rule.id === id);
  });

  const selectedRuns = computed(() => {
    const rule = selectedRule();
    if (!rule) return [];
    return [...props.store.scheduleRuns()]
      .filter((run) => run.ruleId === rule.id)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  });

  const quietNow = computed(() => {
    const tick = props.store.scheduleClockTick();
    const settings = props.store.scheduleSettings();
    return isWithinQuietHours(new Date(tick), settings);
  });

  // --- Rule Dialog state ---
  const ruleDialogOpen = signal(false);
  const editingRuleId = signal<string | null>(null);
  const editingRuleOrigin = signal<"user" | "agent_inferred">("user");
  const dialogTitle = signal("");
  const dialogPrompt = signal("");
  const dialogTriggerKind = signal<TriggerKindOption>("interval");
  const dialogOnceDatetime = signal("");
  const dialogIntervalMin = signal("15");
  const dialogDailyTime = signal("09:00");
  const dialogCronExpr = signal("0 9 * * *");
  const dialogPolicy = signal<"check_only" | "authorized_action">("check_only");
  const dialogRuleError = signal("");

  const openCreateRuleDialog = () => {
    editingRuleId.set(null);
    editingRuleOrigin.set("user");
    dialogTitle.set("");
    dialogPrompt.set("");
    dialogTriggerKind.set("interval");
    dialogOnceDatetime.set(formatLocalDateTime(new Date(Date.now() + 15 * 60_000)));
    dialogIntervalMin.set("15");
    dialogDailyTime.set("09:00");
    dialogCronExpr.set("0 9 * * *");
    dialogPolicy.set("check_only");
    dialogRuleError.set("");
    ruleDialogOpen.set(true);
  };

  const openEditRuleDialog = (rule: ScheduleRule) => {
    editingRuleId.set(rule.id);
    editingRuleOrigin.set(rule.origin);
    dialogTitle.set(rule.title);
    dialogPrompt.set(rule.prompt);
    dialogPolicy.set(rule.executionPolicy);
    dialogRuleError.set("");
    if (rule.trigger.kind === "once") {
      dialogTriggerKind.set("once");
      const parsed = new Date(rule.trigger.runAt);
      dialogOnceDatetime.set(
        Number.isNaN(parsed.getTime())
          ? formatLocalDateTime(new Date(Date.now() + 15 * 60_000))
          : formatLocalDateTime(parsed),
      );
    } else if (rule.trigger.kind === "interval") {
      dialogTriggerKind.set("interval");
      dialogIntervalMin.set(String(Math.max(1, Math.round(rule.trigger.everySeconds / 60))));
    } else {
      const dailyMatch = /^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*$/.exec(
        rule.trigger.expr.trim(),
      );
      if (dailyMatch) {
        dialogTriggerKind.set("daily");
        dialogDailyTime.set(
          formatMinuteClock(Number(dailyMatch[2]) * 60 + Number(dailyMatch[1])),
        );
      } else {
        dialogTriggerKind.set("cron");
        dialogCronExpr.set(rule.trigger.expr);
      }
    }
    ruleDialogOpen.set(true);
  };

  const setQuickDelayMinutes = (minutes: number) => {
    dialogOnceDatetime.set(formatLocalDateTime(new Date(Date.now() + minutes * 60_000)));
    dialogRuleError.set("");
  };

  const cronPreview = computed(() => {
    if (dialogTriggerKind() !== "cron") return null;
    const expr = dialogCronExpr().trim();
    if (!expr) return { dates: [] as string[], error: "" };
    try {
      parseCron(expr);
      const dates = previewCronOccurrences(expr, 3).map((d) =>
        formatLocalDateTime(d),
      );
      return { dates, error: "" };
    } catch (error) {
      return { dates: [] as string[], error: extractInlineError(error) };
    }
  });

  const submitRuleDialog = () => {
    dialogRuleError.set("");
    const title = dialogTitle().trim();
    const prompt = dialogPrompt().trim();
    if (!title || !prompt) {
      dialogRuleError.set(t("scheduleTitlePromptRequired"));
      return;
    }
    let trigger: ScheduleTrigger;
    const kind = dialogTriggerKind();
    if (kind === "once") {
      const iso = parseLocalDateTimeInput(dialogOnceDatetime());
      if (!iso) {
        dialogRuleError.set(t("scheduleInvalidDateTime"));
        return;
      }
      trigger = { kind: "once", runAt: iso };
    } else if (kind === "interval") {
      const mins = Number(dialogIntervalMin().trim());
      if (!Number.isFinite(mins) || mins < 1) {
        dialogRuleError.set(t("scheduleInvalidInterval"));
        return;
      }
      trigger = { kind: "interval", everySeconds: Math.round(mins * 60) };
    } else if (kind === "daily") {
      const totalMins = parseMinuteClock(dialogDailyTime());
      if (totalMins === null) {
        dialogRuleError.set(t("scheduleInvalidTimeHHMM"));
        return;
      }
      const hour = Math.floor(totalMins / 60);
      const min = totalMins % 60;
      trigger = { kind: "cron", expr: `${min} ${hour} * * *` };
    } else {
      const expr = dialogCronExpr().trim();
      try {
        parseCron(expr);
        previewCronOccurrences(expr, 1);
      } catch (error) {
        dialogRuleError.set(extractInlineError(error));
        return;
      }
      trigger = { kind: "cron", expr };
    }

    try {
      const id = editingRuleId();
      if (id) {
        props.store.updateScheduleRule(id, {
          title,
          prompt,
          trigger,
          ...(editingRuleOrigin() === "user"
            ? { executionPolicy: dialogPolicy() }
            : {}),
        });
      } else {
        props.store.createScheduleRule({
          title,
          prompt,
          origin: "user",
          trigger,
          executionPolicy: dialogPolicy(),
          enabled: true,
        });
      }
      ruleDialogOpen.set(false);
    } catch (error) {
      dialogRuleError.set(extractInlineError(error));
    }
  };

  // --- Quiet Window Dialog state ---
  const quietDialogOpen = signal(false);
  const editingQuietId = signal<string | null>(null);
  const quietLabelDraft = signal("");
  const quietStartDraft = signal("23:00");
  const quietEndDraft = signal("08:00");
  const quietDaysDraft = signal<number[]>([]);
  const quietDialogError = signal("");

  const openCreateQuietDialog = () => {
    editingQuietId.set(null);
    quietLabelDraft.set("");
    quietStartDraft.set("23:00");
    quietEndDraft.set("08:00");
    quietDaysDraft.set([]);
    quietDialogError.set("");
    quietDialogOpen.set(true);
  };

  const openEditQuietDialog = (win: QuietHoursWindow) => {
    editingQuietId.set(win.id);
    quietLabelDraft.set(win.label ?? "");
    quietStartDraft.set(formatMinuteClock(win.startMinute));
    quietEndDraft.set(formatMinuteClock(win.endMinute));
    quietDaysDraft.set(win.daysOfWeek ? [...win.daysOfWeek] : []);
    quietDialogError.set("");
    quietDialogOpen.set(true);
  };

  const toggleQuietDay = (day: number) => {
    quietDaysDraft.update((prev) =>
      prev.includes(day)
        ? prev.filter((item) => item !== day)
        : [...prev, day].sort((a, b) => a - b),
    );
  };

  const crossesMidnightPreview = computed(() => {
    const start = parseMinuteClock(quietStartDraft());
    const end = parseMinuteClock(quietEndDraft());
    if (start === null || end === null || end >= start) return null;
    return {
      start: formatMinuteClock(start),
      end: formatMinuteClock(end),
    };
  });

  const submitQuietDialog = () => {
    quietDialogError.set("");
    const startMinute = parseMinuteClock(quietStartDraft());
    const endMinute = parseMinuteClock(quietEndDraft());
    if (startMinute === null || endMinute === null) {
      quietDialogError.set(t("scheduleInvalidTimeHHMM"));
      return;
    }
    if (startMinute === endMinute) {
      quietDialogError.set(t("quietSameMinuteError"));
      return;
    }
    const label = quietLabelDraft().trim();
    const days = quietDaysDraft();
    try {
      const id = editingQuietId();
      if (id) {
        props.store.updateQuietHoursWindow(id, {
          ...(label ? { label } : { label: undefined }),
          startMinute,
          endMinute,
          daysOfWeek: days.length > 0 && days.length < 7 ? days : undefined,
        });
      } else {
        props.store.addQuietHoursWindow({
          ...(label ? { label } : {}),
          startMinute,
          endMinute,
          ...(days.length > 0 && days.length < 7 ? { daysOfWeek: days } : {}),
          enabled: true,
        });
      }
      quietDialogOpen.set(false);
    } catch (error) {
      quietDialogError.set(extractInlineError(error));
    }
  };

  // --- GitHub PAT local draft (never echoes plaintext back after saving) ---
  const patDraft = signal("");
  const patError = signal("");

  // React to header action button triggers from SchedulesContextBar
  let lastCreateRuleNonce = 0;
  effect(() => {
    const next = props.createRuleNonce();
    if (next > lastCreateRuleNonce) {
      lastCreateRuleNonce = next;
      openCreateRuleDialog();
    }
  });

  let lastAddQuietNonce = 0;
  effect(() => {
    const next = props.addQuietNonce();
    if (next > lastAddQuietNonce) {
      lastAddQuietNonce = next;
      openCreateQuietDialog();
    }
  });

  const confirmDeleteRule = async (rule: ScheduleRule) => {
    const result = await AlertDialog.show({
      title: t("scheduleDeleteRuleConfirmTitle", { title: rule.title }),
      description: t("scheduleDeleteRuleConfirmDesc"),
      actions: [
        { id: "cancel", label: t("cancel"), role: "cancel" },
        { id: "confirm", label: t("delete"), role: "destructive" },
      ],
    });
    if (result.action === "confirm") {
      await props.store.deleteScheduleRule(rule.id);
    }
  };

  const renderFilterChip = (filter: ScheduleRuleFilter, label: () => string, testID: string) => {
    const active = () => ruleFilter() === filter;
    return (
      <Button
        testID={testID}
        selected={active()}
        onPress={() => props.store.setScheduleRuleFilter(filter)}
        class={
          active()
            ? "min-h-11 px-3 rounded-full bg-primary items-center justify-center active:opacity-70 transition-colors duration-150 motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-ring"
            : "min-h-11 px-3 rounded-full bg-muted items-center justify-center hover:bg-secondary active:opacity-70 transition-colors duration-150 motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-ring"
        }
      >
        <Text
          class={
            active()
              ? "text-primary-foreground text-xs font-semibold"
              : "text-muted-foreground text-xs font-medium"
          }
        >
          {label()}
        </Text>
      </Button>
    );
  };

  const renderRuleListPane = () => (
    <View
      class={
        wide()
          ? "w-[42%] min-w-0 min-h-0 rounded-2xl bg-card border border-border overflow-hidden"
          : "flex-1 min-h-0 rounded-2xl bg-card border border-border overflow-hidden"
      }
    >
      <View class="px-3 py-2 border-b border-border flex-row items-center gap-1.5 flex-wrap">
        {renderFilterChip("all", () => t("scheduleFilterAll"), "schedule-filter-all")}
        {renderFilterChip("user", () => t("scheduleFilterUser"), "schedule-filter-user")}
        {renderFilterChip(
          "agent_inferred",
          () => t("scheduleFilterInferred"),
          "schedule-filter-inferred",
        )}
      </View>

      <Scroll class="flex-1 min-h-0" contentClass="p-2.5 gap-2">
        <If
          when={filteredRules().length > 0}
          else={
            <View testID="schedule-empty-state" class="p-4 gap-3 items-start">
              <Text class="text-foreground text-sm font-semibold">
                {t("scheduleEmptyTitle")}
              </Text>
              <Text class="text-muted-foreground text-xs">
                {ruleFilter() === "all"
                  ? t("scheduleEmptyDesc")
                  : t("scheduleFilteredEmptyDesc")}
              </Text>
              <ActionButton
                compact
                kind="primary"
                testID="schedule-empty-cta"
                label={
                  ruleFilter() === "all"
                    ? t("scheduleNewRule")
                    : t("scheduleShowAllRules")
                }
                onPress={() => {
                  if (ruleFilter() === "all") openCreateRuleDialog();
                  else props.store.setScheduleRuleFilter("all");
                }}
              />
            </View>
          }
        >
          <Each of={filteredRules()} key={(rule) => rule.id}>
            {(rule) => {
              const isSelected = () => props.store.selectedScheduleRuleId() === rule().id;
              return (
                <View
                  testID={`schedule-rule-row-${rule().id}`}
                  class={
                    isSelected()
                      ? "rounded-xl border border-primary bg-muted flex-row items-center transition-colors duration-150 motion-reduce:transition-none"
                      : "rounded-xl border border-border bg-background flex-row items-center transition-colors duration-150 motion-reduce:transition-none"
                  }
                >
                  <Button
                    testID={`schedule-rule-select-${rule().id}`}
                    selected={isSelected()}
                    accessibilityLabel={rule().title}
                    onPress={() => props.store.selectScheduleRule(rule().id)}
                    class="flex-1 min-w-0 min-h-11 px-3 py-2.5 items-start gap-1"
                  >
                    <View class="w-full flex-row items-center gap-2">
                      <Text
                        class="flex-1 min-w-0 text-foreground text-sm font-semibold"
                        style={{ numberOfLines: 1 }}
                      >
                        {rule().title}
                      </Text>
                      <View class="rounded-full bg-secondary px-2 py-0.5 shrink-0">
                        <Text class="text-secondary-foreground text-xs font-medium">
                          {rule().origin === "agent_inferred"
                            ? t("scheduleOriginInferred")
                            : t("scheduleOriginUser")}
                        </Text>
                      </View>
                    </View>
                    <Text
                      class="text-muted-foreground text-xs"
                      style={{ fontVariant: ["tabular-nums"], numberOfLines: 1 }}
                    >
                      {formatTriggerSummary(rule().trigger)}
                    </Text>
                    <View class="w-full flex-row items-center justify-between gap-2 pt-0.5">
                      <View class="flex-row items-center gap-1.5 shrink-0">
                        <View class={ruleStatusDotClass(rule())} />
                        <Text class="text-muted-foreground text-xs font-medium">
                          {ruleStatusLabel(rule())}
                        </Text>
                      </View>
                      <Text
                        class="text-subtle-text text-xs"
                        style={{ fontVariant: ["tabular-nums"], numberOfLines: 1 }}
                      >
                        {rule().nextRunAt
                          ? t("scheduleNextRunPrefix", {
                              time: formatDate(rule().nextRunAt!),
                            })
                          : t("scheduleNoNextRun")}
                      </Text>
                    </View>
                  </Button>

                  <View class="pr-3 justify-center shrink-0">
                    <ToggleSwitch
                      testID={`schedule-rule-toggle-${rule().id}`}
                      accessibilityLabel={rule().title}
                      checked={rule().enabled}
                      disabled={!canToggleRuleEnabled(rule())}
                      hitSlop={10}
                      onChange={(checked) =>
                        props.store.setScheduleRuleEnabled(rule().id, checked)
                      }
                    />
                  </View>
                </View>
              );
            }}
          </Each>
        </If>
      </Scroll>
    </View>
  );

  const renderRuleDetailPane = () => (
    <View class="flex-1 min-w-0 min-h-0 rounded-2xl bg-card border border-border overflow-hidden">
      <Scroll class="flex-1 min-h-0" contentClass="p-4 gap-3.5">
        <If
          when={Boolean(selectedRule())}
          else={
            <View class="py-12 items-center justify-center px-6">
              <Text class="text-muted-foreground text-sm text-center">
                {t("scheduleSelectRuleHint")}
              </Text>
            </View>
          }
        >
          <View class="gap-3.5">
            <If when={!wide()}>
              <View class="flex-row items-center">
                <ActionButton
                  compact
                  testID="schedule-back-to-list-btn"
                  label={t("back")}
                  onPress={() => props.store.selectScheduleRule(null)}
                />
              </View>
            </If>

            <View class="flex-row items-start justify-between gap-3">
              <View class="flex-1 min-w-0 gap-1.5">
                <Text class="text-foreground text-base font-bold">
                  {selectedRule()?.title ?? ""}
                </Text>
                <View class="flex-row flex-wrap items-center gap-1.5">
                  <View class="flex-row items-center gap-1.5 rounded-full bg-secondary px-2.5 py-0.5">
                    <If
                      when={Boolean(
                        selectedRule() &&
                          (props.store.scheduleRunningRuleId() === selectedRule()!.id ||
                            selectedRule()!.state === "running"),
                      )}
                      else={
                        <View class="flex-row items-center gap-1.5">
                          <View
                            class={
                              selectedRule()
                                ? ruleStatusDotClass(selectedRule()!)
                                : "w-2 h-2 rounded-full bg-subtle-text"
                            }
                          />
                          <Text class="text-secondary-foreground text-xs font-medium">
                            {selectedRule() ? ruleStatusLabel(selectedRule()!) : ""}
                          </Text>
                        </View>
                      }
                    >
                      <LoadingIndicator
                        inline
                        testID="schedule-running-indicator"
                        label={t("scheduleStateRunning")}
                      />
                    </If>
                  </View>
                  <View class="rounded-full bg-muted px-2.5 py-0.5">
                    <Text class="text-muted-foreground text-xs">
                      {selectedRule()?.origin === "agent_inferred"
                        ? t("scheduleOriginInferred")
                        : t("scheduleOriginUser")}
                    </Text>
                  </View>
                  <View class="rounded-full bg-muted px-2.5 py-0.5">
                    <Text class="text-muted-foreground text-xs">
                      {selectedRule()?.executionPolicy === "authorized_action"
                        ? t("schedulePolicyAuthorizedAction")
                        : t("schedulePolicyCheckOnly")}
                    </Text>
                  </View>
                </View>
              </View>

              <View class="flex-row items-center gap-2 shrink-0">
                <IconButton
                  testID="schedule-run-now-btn"
                  icon={
                    selectedRule() &&
                    (props.store.scheduleRunningRuleId() === selectedRule()!.id ||
                      selectedRule()!.state === "running")
                      ? "refresh"
                      : "play"
                  }
                  label={
                    selectedRule() &&
                    (props.store.scheduleRunningRuleId() === selectedRule()!.id ||
                      selectedRule()!.state === "running")
                      ? t("scheduleRunningNow")
                      : t("scheduleRunNow")
                  }
                  busy={Boolean(
                    selectedRule() &&
                      (props.store.scheduleRunningRuleId() === selectedRule()!.id ||
                        selectedRule()!.state === "running"),
                  )}
                  kind="outline"
                  onPress={() => {
                    const rule = selectedRule();
                    if (rule) void props.store.runScheduleRuleNow(rule.id);
                  }}
                />
                <ActionButton
                  compact
                  testID="schedule-edit-rule-btn"
                  label={t("editEllipsis")}
                  onPress={() => {
                    const rule = selectedRule();
                    if (rule) openEditRuleDialog(rule);
                  }}
                />
                <ActionButton
                  compact
                  kind="danger"
                  testID="schedule-delete-rule-btn"
                  label={t("delete")}
                  onPress={() => {
                    const rule = selectedRule();
                    if (rule) void confirmDeleteRule(rule);
                  }}
                />
              </View>
            </View>

            <If when={selectedRule()?.state === "unconfirmed"}>
              <View
                testID="schedule-unconfirmed-banner"
                class="rounded-xl bg-warning/15 border border-warning/40 p-3"
              >
                <Text class="text-warning text-xs font-medium">
                  {t("scheduleUnconfirmedBanner")}
                </Text>
              </View>
            </If>

            <View class="rounded-xl bg-background border border-border p-3 gap-2">
              <Text class="text-muted-foreground text-xs font-medium">
                {t("schedulePromptSection")}
              </Text>
              <View selectable={true}>
                <Text class="text-foreground text-sm">
                  {selectedRule()?.prompt ?? ""}
                </Text>
              </View>
              <View class="pt-1 border-t border-border gap-1">
                <Text
                  class="text-muted-foreground text-xs"
                  style={{ fontVariant: ["tabular-nums"] }}
                >
                  {selectedRule()
                    ? `${t("scheduleTriggerLabel")}: ${formatTriggerSummary(selectedRule()!.trigger)}`
                    : ""}
                </Text>
                <Text
                  class="text-muted-foreground text-xs"
                  style={{ fontVariant: ["tabular-nums"] }}
                >
                  {`${t("scheduleNextRunLabel")}: ${
                    selectedRule()?.nextRunAt
                      ? formatDate(selectedRule()!.nextRunAt!)
                      : t("scheduleNoNextRun")
                  }`}
                </Text>
                <If when={Boolean(selectedRule()?.lastRunAt)}>
                  <Text
                    class="text-muted-foreground text-xs"
                    style={{ fontVariant: ["tabular-nums"] }}
                  >
                    {`${t("scheduleLastRunLabel")}: ${
                      selectedRule()?.lastRunAt ? formatDate(selectedRule()!.lastRunAt!) : ""
                    }`}
                  </Text>
                </If>
                <If
                  when={Boolean(
                    selectedRule() &&
                      (selectedRule()!.origin === "agent_inferred" ||
                        selectedRule()!.chain.followUpCount > 0),
                  )}
                >
                  <Text
                    class="text-muted-foreground text-xs"
                    style={{ fontVariant: ["tabular-nums"] }}
                  >
                    {t("scheduleFollowUpProgress", {
                      count: selectedRule()?.chain.followUpCount ?? 0,
                      max: selectedRule()?.chain.maxFollowUps ?? 0,
                    })}
                  </Text>
                </If>
                <If when={Boolean(selectedRule()?.dedupeKey)}>
                  <Text class="text-subtle-text text-xs">
                    {`${t("scheduleDedupeKeyLabel")}: ${selectedRule()?.dedupeKey ?? ""}`}
                  </Text>
                </If>
              </View>
            </View>

            <View class="gap-2">
              <Text class="text-foreground text-xs font-semibold">
                {t("scheduleHistorySection")}
              </Text>
              <If
                when={selectedRuns().length > 0}
                else={
                  <View class="rounded-xl bg-background border border-border p-3">
                    <Text class="text-muted-foreground text-xs">
                      {t("scheduleNoRunsYet")}
                    </Text>
                  </View>
                }
              >
                <Each of={selectedRuns()} key={(run) => run.id}>
                  {(run) => (
                    <View
                      testID={`schedule-run-item-${run().id}`}
                      class="rounded-xl bg-background border border-border p-3 gap-2"
                    >
                      <View class="flex-row items-center justify-between gap-2">
                        <View class="flex-row items-center gap-1.5 flex-wrap">
                          <View class={runStatusDotClass(run().status)} />
                          <Text class="text-foreground text-xs font-semibold">
                            {runStatusLabel(run().status)}
                          </Text>
                          <View class="rounded-full bg-secondary px-2 py-0.5">
                            <Text class="text-secondary-foreground text-xs">
                              {runReasonLabel(run().triggerReason)}
                            </Text>
                          </View>
                          <If when={Boolean(run().importance)}>
                            <View class="rounded-full bg-muted px-2 py-0.5">
                              <Text class="text-muted-foreground text-xs">
                                {run().importance === "notify"
                                  ? t("scheduleImportanceNotify")
                                  : t("scheduleImportanceSilent")}
                              </Text>
                            </View>
                          </If>
                        </View>
                        <Text
                          class="text-subtle-text text-xs"
                          style={{ fontVariant: ["tabular-nums"] }}
                        >
                          {formatDate(run().startedAt)}
                        </Text>
                      </View>

                      <If when={Boolean(run().summary)}>
                        <View selectable={true}>
                          <Text class="text-foreground text-xs">
                            {run().summary!}
                          </Text>
                        </View>
                      </If>

                      <If when={Boolean(run().error)}>
                        <View class="rounded-lg bg-destructive/10 border border-destructive/30 p-2">
                          <Text class="text-destructive text-xs">
                            {formatFailureLine(run().error!)}
                          </Text>
                        </View>
                      </If>

                      <If when={Boolean(run().toolFailures?.length)}>
                        <View class="rounded-lg bg-destructive/10 border border-destructive/30 p-2 gap-1">
                          <Text class="text-destructive text-xs font-semibold">
                            {t("scheduleToolFailures")}
                          </Text>
                          <Each of={run().toolFailures ?? []} key={(tf) => tf.callId}>
                            {(tf) => (
                              <Text class="text-destructive text-xs">
                                {`${tf().toolName}: ${formatFailureLine(tf())}`}
                              </Text>
                            )}
                          </Each>
                        </View>
                      </If>

                      <If when={Boolean(run().taskId || run().sessionId)}>
                        <View class="flex-row flex-wrap items-center gap-2 pt-0.5">
                          <If when={Boolean(run().taskId)}>
                            <ActionButton
                              compact
                              testID={`schedule-run-view-task-${run().id}`}
                              label={t("scheduleViewTask")}
                              onPress={() =>
                                props.store.inspectScheduleTask(run().taskId!)
                              }
                            />
                          </If>
                          <If when={Boolean(run().sessionId)}>
                            <ActionButton
                              compact
                              kind="primary"
                              testID={`schedule-run-continue-session-${run().id}`}
                              label={t("scheduleContinueSession")}
                              onPress={() => {
                                props.store.continueScheduledSession(run().sessionId!);
                              }}
                            />
                          </If>
                        </View>
                      </If>
                    </View>
                  )}
                </Each>
              </If>
            </View>
          </View>
        </If>
      </Scroll>
    </View>
  );

  const renderQuietHoursSubview = () => (
    <View
      class={
        wide()
          ? "flex-1 min-h-0 flex-row gap-3"
          : "flex-1 min-h-0 gap-3"
      }
    >
      <Scroll
        class={wide() ? "w-[46%] min-w-0 min-h-0" : "flex-1 min-h-0"}
        contentClass="gap-3 pb-4"
      >
        {/* Quiet hours master + live status */}
        <View class="rounded-2xl bg-card border border-border p-4 gap-3">
          <View class="flex-row items-center justify-between gap-3">
            <Text class="flex-1 text-foreground text-sm font-semibold">
              {t("quietHoursMasterLabel")}
            </Text>
            <ToggleSwitch
              testID="quiet-master-toggle"
              accessibilityLabel={t("quietHoursMasterLabel")}
              checked={props.store.scheduleSettings().quietHoursEnabled}
              hitSlop={10}
              onChange={(checked) => props.store.setQuietHoursEnabled(checked)}
            />
          </View>

          <View
            testID="quiet-live-status"
            class={
              quietNow()
                ? "rounded-xl bg-warning/15 border border-warning/40 p-3 flex-row items-center gap-2"
                : "rounded-xl bg-muted border border-border p-3 flex-row items-center gap-2"
            }
          >
            <View
              class={
                quietNow()
                  ? "w-2 h-2 rounded-full bg-warning shrink-0"
                  : "w-2 h-2 rounded-full bg-subtle-text shrink-0"
              }
            />
            <Text
              class={
                quietNow()
                  ? "flex-1 text-warning text-xs font-medium"
                  : "flex-1 text-muted-foreground text-xs"
              }
            >
              {quietNow() ? t("quietHoursActiveNow") : t("quietHoursInactiveNow")}
            </Text>
          </View>

          <View class="gap-1 pt-1 border-t border-border">
            <Text class="text-muted-foreground text-xs font-medium">
              {t("quietHoursVoiceHintsTitle")}
            </Text>
            <Text class="text-subtle-text text-xs">
              {t("quietHoursVoiceHintsBody")}
            </Text>
          </View>
        </View>

        {/* System notification permission & exact alarm degraded status */}
        <View class="rounded-2xl bg-card border border-border p-4 gap-2.5">
          <View class="flex-row items-center justify-between gap-2">
            <View class="flex-1 min-w-0 gap-0.5">
              <Text class="text-foreground text-sm font-semibold">
                {t("scheduleNotificationPermission")}
              </Text>
              <Text class="text-muted-foreground text-xs">
                {permissionStatusLabel(props.store.schedulePermission().notification)}
              </Text>
            </View>
            <If when={props.store.schedulePermission().notification !== "granted"}>
              <ActionButton
                compact
                testID="schedule-request-permission-btn"
                label={t("scheduleRequestPermission")}
                onPress={() => {
                  void props.store.requestSchedulePermission();
                }}
              />
            </If>
          </View>

          <If when={Boolean(props.store.scheduleExactAlarm()?.degraded)}>
            <View
              testID="schedule-exact-alarm-degraded"
              class="rounded-xl bg-warning/15 border border-warning/40 p-3 gap-2"
            >
              <Text class="text-warning text-xs font-semibold">
                {t("scheduleExactAlarmDegradedTitle")}
              </Text>
              <Text class="text-warning text-xs">
                {t("scheduleExactAlarmDegradedDesc", {
                  reason: props.store.scheduleExactAlarm()?.reason ?? "",
                })}
              </Text>
              <If when={Boolean(props.store.scheduleExactAlarm()?.canOpenSettings)}>
                <View class="flex-row">
                  <ActionButton
                    compact
                    testID="schedule-open-exact-alarm-settings"
                    label={t("scheduleOpenSystemSettings")}
                    onPress={() => {
                      void props.store.openScheduleExactAlarmSettings();
                    }}
                  />
                </View>
              </If>
            </View>
          </If>
        </View>

        {/* Lightweight GitHub Read-Only PAT Card */}
        <View
          testID="github-pat-card"
          class="rounded-2xl bg-card border border-border p-4 gap-3"
        >
          <View class="flex-row items-center justify-between gap-2">
            <Text class="text-foreground text-sm font-semibold">
              {t("githubPatTitle")}
            </Text>
            <View
              testID="github-pat-status-badge"
              class={
                props.store.githubCredential().configured
                  ? "rounded-full bg-verified/15 px-2.5 py-0.5"
                  : "rounded-full bg-muted px-2.5 py-0.5"
              }
            >
              <Text
                class={
                  props.store.githubCredential().configured
                    ? "text-verified text-xs font-medium"
                    : "text-muted-foreground text-xs"
                }
              >
                {props.store.githubCredential().configured
                  ? t("githubPatConfigured", {
                      hint: props.store.githubCredential().tokenHint ?? "••••",
                    })
                  : t("githubPatUnconfigured")}
              </Text>
            </View>
          </View>

          <Text class="text-subtle-text text-xs">{t("githubPatScopeHint")}</Text>

          <TextField
            compact
            testID="github-pat-input"
            label={t("githubPatTitle")}
            placeholder={t("githubPatPlaceholder")}
            masked
            value={patDraft()}
            onChange={(value) => {
              patDraft.set(value);
              if (patError()) patError.set("");
            }}
          />

          <If when={Boolean(patError())}>
            <Text testID="github-pat-error" class="text-destructive text-xs">
              {patError()}
            </Text>
          </If>

          <View class="flex-row flex-wrap items-center gap-2">
            <ActionButton
              compact
              kind="primary"
              testID="github-pat-save-btn"
              label={t("githubPatSave")}
              disabled={!patDraft().trim() || props.store.githubBusy()}
              onPress={() => {
                patError.set("");
                const token = patDraft().trim();
                try {
                  props.store.saveGitHubToken(token);
                  patDraft.set("");
                } catch (error) {
                  patError.set(extractInlineError(error));
                }
              }}
            />
            <ActionButton
              compact
              testID="github-pat-verify-btn"
              label={
                props.store.githubBusy()
                  ? t("githubPatVerifying")
                  : t("githubPatVerify")
              }
              disabled={!props.store.githubCredential().configured || props.store.githubBusy()}
              onPress={() => {
                patError.set("");
                void props.store.verifyGitHubToken();
              }}
            />
            <ActionButton
              compact
              kind="danger"
              testID="github-pat-clear-btn"
              label={t("githubPatClear")}
              disabled={!props.store.githubCredential().configured || props.store.githubBusy()}
              onPress={() => {
                patDraft.set("");
                patError.set("");
                props.store.clearGitHubToken();
              }}
            />
          </View>

          <If when={props.store.githubBusy()}>
            <LoadingIndicator
              inline
              testID="github-pat-verifying-indicator"
              label={t("githubPatVerifying")}
            />
          </If>

          <If when={Boolean(props.store.githubVerifyResult())}>
            <If
              when={Boolean(props.store.githubVerifyResult()?.valid)}
              else={
                <View
                  testID="github-pat-verify-error"
                  class="rounded-xl bg-destructive/10 border border-destructive/30 p-2.5"
                >
                  <Text class="text-destructive text-xs">
                    {props.store.githubVerifyResult()?.failure
                      ? formatFailureLine(props.store.githubVerifyResult()!.failure!)
                      : t("scheduleStateUnconfirmed")}
                  </Text>
                </View>
              }
            >
              <View
                testID="github-pat-verify-ok"
                class="rounded-xl bg-verified/15 border border-verified/30 p-2.5"
              >
                <Text
                  class="text-verified text-xs font-medium"
                  style={{ fontVariant: ["tabular-nums"] }}
                >
                  {t("githubPatVerifyOk", {
                    remaining: props.store.githubVerifyResult()?.rateLimit?.remaining ?? "?",
                    limit: props.store.githubVerifyResult()?.rateLimit?.limit ?? "?",
                  })}
                </Text>
              </View>
            </If>
          </If>
        </View>
      </Scroll>

      {/* Right column: multi-window quiet hours cards */}
      <View class="flex-1 min-w-0 min-h-0 rounded-2xl bg-card border border-border overflow-hidden">
        <Scroll class="flex-1 min-h-0" contentClass="p-4 gap-3">
          <View class="flex-row items-center justify-between gap-2">
            <Text class="text-foreground text-sm font-semibold">
              {t("quietWindowsHeader")}
            </Text>
            <Text
              class="text-muted-foreground text-xs"
              style={{ fontVariant: ["tabular-nums"] }}
            >
              {String(props.store.scheduleSettings().quietHours.length)}
            </Text>
          </View>

          <If
            when={props.store.scheduleSettings().quietHours.length > 0}
            else={
              <View
                testID="quiet-windows-empty"
                class="rounded-xl bg-background border border-border p-4 gap-3 items-start"
              >
                <Text class="text-muted-foreground text-xs">
                  {t("quietWindowsEmpty")}
                </Text>
                <ActionButton
                  compact
                  testID="quiet-empty-add-btn"
                  label={t("scheduleAddQuietWindow")}
                  onPress={() => openCreateQuietDialog()}
                />
              </View>
            }
          >
            <Each
              of={props.store.scheduleSettings().quietHours}
              key={(win) => win.id}
            >
              {(win) => (
                <View
                  testID={`quiet-window-card-${win().id}`}
                  class="rounded-xl bg-background border border-border p-3 gap-2"
                >
                  <View class="flex-row items-center justify-between gap-2">
                    <View class="flex-1 min-w-0 gap-0.5">
                      <Text class="text-foreground text-sm font-semibold">
                        {win().label || formatQuietRange(win())}
                      </Text>
                      <Text
                        class="text-muted-foreground text-xs"
                        style={{ fontVariant: ["tabular-nums"] }}
                      >
                        {`${formatQuietRange(win())} · ${formatDaysLabel(win().daysOfWeek)}`}
                      </Text>
                    </View>
                    <ToggleSwitch
                      testID={`quiet-window-toggle-${win().id}`}
                      accessibilityLabel={win().label || formatQuietRange(win())}
                      checked={win().enabled}
                      hitSlop={10}
                      onChange={(checked) =>
                        props.store.updateQuietHoursWindow(win().id, {
                          enabled: checked,
                        })
                      }
                    />
                  </View>
                  <View class="flex-row items-center justify-end gap-2">
                    <ActionButton
                      compact
                      testID={`quiet-window-edit-${win().id}`}
                      label={t("editEllipsis")}
                      onPress={() => openEditQuietDialog(win())}
                    />
                    <ActionButton
                      compact
                      kind="danger"
                      testID={`quiet-window-delete-${win().id}`}
                      label={t("delete")}
                      onPress={() => props.store.removeQuietHoursWindow(win().id)}
                    />
                  </View>
                </View>
              )}
            </Each>
          </If>
        </Scroll>
      </View>
    </View>
  );

  return (
    <View class="flex-1 min-h-0">
      <If when={subView() === "rules"} else={renderQuietHoursSubview()}>
        <If
          when={wide()}
          else={
            <If when={Boolean(selectedRule())} else={renderRuleListPane()}>
              {renderRuleDetailPane()}
            </If>
          }
        >
          <View class="flex-1 min-h-0 flex-row gap-3">
            {renderRuleListPane()}
            {renderRuleDetailPane()}
          </View>
        </If>
      </If>

      {/* Create / Edit Schedule Rule Dialog */}
      <Dialog
        open={ruleDialogOpen()}
        animation={reduceMotion() ? "none" : "fade"}
        presentation="fullScreen"
        onOpenChange={(event) => {
          if (!event.open) ruleDialogOpen.set(false);
        }}
        class="m-auto rounded-3xl border border-border bg-popover p-5"
        backdropClass="bg-backdrop"
        style={{
          width: Math.min(580, windowSize().width - 32),
          height: Math.max(
            140,
            Math.min(350, windowSize().height - keyboardFrame().height - 24),
          ),
          marginBottom: keyboardFrame().height,
        }}
      >
        <View class="flex-1 min-h-0 gap-3">
          <View class="flex-row items-center justify-between gap-2">
            <Text class="text-foreground text-base font-bold" role="header">
              {editingRuleId()
                ? t("scheduleEditRuleTitle")
                : t("scheduleCreateRuleTitle")}
            </Text>
          </View>

          <Scroll class="flex-1 min-h-0" contentClass="gap-3 pr-1">
            <TextField
              compact
              testID="rule-dialog-title-input"
              label={t("scheduleRuleTitleLabel")}
              placeholder={t("scheduleRuleTitlePlaceholder")}
              value={dialogTitle()}
              onChange={(value) => dialogTitle.set(value)}
            />

            <View class="gap-1.5">
              <Text class="text-muted-foreground text-xs font-medium">
                {t("scheduleRulePromptLabel")}
              </Text>
              <Input
                testID="rule-dialog-prompt-input"
                accessibilityLabel={t("scheduleRulePromptLabel")}
                value={dialogPrompt()}
                onChange={(e) => dialogPrompt.set(e.value)}
                placeholder={t("scheduleRulePromptPlaceholder")}
                multiline
                maxLength={8192}
                class="min-h-16 py-2 rounded-xl border border-input bg-background px-3.5 text-foreground text-sm focus:border-ring focus-visible:ring-2 focus-visible:ring-ring"
              />
            </View>

            <View class="gap-1.5">
              <Text class="text-muted-foreground text-xs font-medium">
                {t("scheduleTriggerKindLabel")}
              </Text>
              <View class="flex-row flex-wrap gap-1.5">
                {(
                  [
                    ["once", "scheduleKindOnce"],
                    ["interval", "scheduleKindInterval"],
                    ["daily", "scheduleKindDaily"],
                    ["cron", "scheduleKindCron"],
                  ] as const
                ).map(([kind, labelKey]) => {
                  const selected = () => dialogTriggerKind() === kind;
                  return (
                    <Button
                      testID={`rule-dialog-kind-${kind}`}
                      selected={selected()}
                      onPress={() => {
                        dialogTriggerKind.set(kind);
                        dialogRuleError.set("");
                      }}
                      class={
                        selected()
                          ? "min-h-11 px-3 rounded-full bg-primary items-center justify-center active:opacity-70 transition-colors duration-150 motion-reduce:transition-none"
                          : "min-h-11 px-3 rounded-full bg-muted items-center justify-center hover:bg-secondary active:opacity-70 transition-colors duration-150 motion-reduce:transition-none"
                      }
                    >
                      <Text
                        class={
                          selected()
                            ? "text-primary-foreground text-xs font-semibold"
                            : "text-muted-foreground text-xs font-medium"
                        }
                      >
                        {t(labelKey)}
                      </Text>
                    </Button>
                  );
                })}
              </View>
            </View>

            <If when={dialogTriggerKind() === "once"}>
              <View class="gap-2">
                <Text class="text-muted-foreground text-xs font-medium">
                  {t("scheduleOnceQuickLabel")}
                </Text>
                <View class="flex-row flex-wrap gap-1.5">
                  {(
                    [
                      [5, "scheduleDelay5m"],
                      [15, "scheduleDelay15m"],
                      [30, "scheduleDelay30m"],
                      [60, "scheduleDelay1h"],
                    ] as const
                  ).map(([mins, key]) => (
                    <Button
                      testID={`rule-dialog-delay-${mins}m`}
                      onPress={() => setQuickDelayMinutes(mins)}
                      class="min-h-11 px-3 rounded-full bg-secondary items-center justify-center"
                    >
                      <Text class="text-secondary-foreground text-xs font-medium">
                        {t(key)}
                      </Text>
                    </Button>
                  ))}
                </View>
                <TextField
                  compact
                  testID="rule-dialog-once-input"
                  label={t("scheduleOnceDatetimeLabel")}
                  placeholder="2026-11-23 18:00"
                  value={dialogOnceDatetime()}
                  onChange={(value) => dialogOnceDatetime.set(value)}
                />
              </View>
            </If>

            <If when={dialogTriggerKind() === "interval"}>
              <TextField
                compact
                testID="rule-dialog-interval-input"
                label={t("scheduleIntervalMinutesLabel")}
                placeholder="15"
                value={dialogIntervalMin()}
                onChange={(value) => dialogIntervalMin.set(value)}
              />
            </If>

            <If when={dialogTriggerKind() === "daily"}>
              <TextField
                compact
                testID="rule-dialog-daily-input"
                label={t("scheduleDailyTimeLabel")}
                placeholder="09:00"
                value={dialogDailyTime()}
                onChange={(value) => dialogDailyTime.set(value)}
              />
            </If>

            <If when={dialogTriggerKind() === "cron"}>
              <View class="gap-2">
                <TextField
                  compact
                  testID="rule-dialog-cron-input"
                  label={t("scheduleCronExprLabel")}
                  placeholder="0 9 29 2 *"
                  value={dialogCronExpr()}
                  onChange={(value) => dialogCronExpr.set(value)}
                />
                <View
                  testID="rule-dialog-cron-preview"
                  class="rounded-xl bg-background border border-border p-2.5 gap-1"
                >
                  <Text class="text-muted-foreground text-xs font-medium">
                    {t("scheduleCronPreviewTitle")}
                  </Text>
                  <If
                    when={!cronPreview()?.error}
                    else={
                      <Text testID="rule-dialog-cron-error" class="text-destructive text-xs">
                        {cronPreview()?.error ?? ""}
                      </Text>
                    }
                  >
                    <Each
                      of={cronPreview()?.dates ?? []}
                      key={(item) => item}
                    >
                      {(item) => (
                        <Text
                          class="text-foreground text-xs"
                          style={{ fontVariant: ["tabular-nums"] }}
                        >
                          {item()}
                        </Text>
                      )}
                    </Each>
                  </If>
                </View>
              </View>
            </If>

            <View class="gap-1.5">
              <Text class="text-muted-foreground text-xs font-medium">
                {t("scheduleExecutionPolicyLabel")}
              </Text>
              <If
                when={!(editingRuleId() && editingRuleOrigin() === "agent_inferred")}
                else={
                  <Text class="text-muted-foreground text-xs">
                    {t("schedulePolicyLockedNote")}
                  </Text>
                }
              >
                <View class="gap-1.5">
                  <View class="flex-row flex-wrap gap-1.5">
                    <Button
                      testID="rule-dialog-policy-check_only"
                      selected={dialogPolicy() === "check_only"}
                      onPress={() => dialogPolicy.set("check_only")}
                      class={
                        dialogPolicy() === "check_only"
                          ? "min-h-11 px-3 rounded-full bg-primary items-center justify-center active:opacity-70 transition-colors duration-150 motion-reduce:transition-none"
                          : "min-h-11 px-3 rounded-full bg-muted items-center justify-center hover:bg-secondary active:opacity-70 transition-colors duration-150 motion-reduce:transition-none"
                      }
                    >
                      <Text
                        class={
                          dialogPolicy() === "check_only"
                            ? "text-primary-foreground text-xs font-semibold"
                            : "text-muted-foreground text-xs font-medium"
                        }
                      >
                        {t("schedulePolicyCheckOnly")}
                      </Text>
                    </Button>
                    <Button
                      testID="rule-dialog-policy-authorized_action"
                      selected={dialogPolicy() === "authorized_action"}
                      onPress={() => dialogPolicy.set("authorized_action")}
                      class={
                        dialogPolicy() === "authorized_action"
                          ? "min-h-11 px-3 rounded-full bg-primary items-center justify-center active:opacity-70 transition-colors duration-150 motion-reduce:transition-none"
                          : "min-h-11 px-3 rounded-full bg-muted items-center justify-center hover:bg-secondary active:opacity-70 transition-colors duration-150 motion-reduce:transition-none"
                      }
                    >
                      <Text
                        class={
                          dialogPolicy() === "authorized_action"
                            ? "text-primary-foreground text-xs font-semibold"
                            : "text-muted-foreground text-xs font-medium"
                        }
                      >
                        {t("schedulePolicyAuthorizedAction")}
                      </Text>
                    </Button>
                  </View>
                  <Text class="text-subtle-text text-xs">
                    {dialogPolicy() === "authorized_action"
                      ? t("schedulePolicyAuthorizedDesc")
                      : t("schedulePolicyCheckOnlyDesc")}
                  </Text>
                </View>
              </If>
            </View>

            <If when={Boolean(dialogRuleError())}>
              <View class="rounded-xl bg-destructive/10 border border-destructive/30 p-2.5">
                <Text testID="rule-dialog-error" class="text-destructive text-xs">
                  {dialogRuleError()}
                </Text>
              </View>
            </If>
          </Scroll>

          <View class="flex-row justify-end gap-2 pt-1 border-t border-border">
            <ActionButton
              compact
              testID="rule-dialog-cancel-btn"
              label={t("cancel")}
              onPress={() => ruleDialogOpen.set(false)}
            />
            <ActionButton
              compact
              kind="primary"
              testID="rule-dialog-save-btn"
              label={
                editingRuleId()
                  ? t("scheduleSaveRule")
                  : t("scheduleCreateRuleBtn")
              }
              onPress={() => submitRuleDialog()}
            />
          </View>
        </View>
      </Dialog>

      {/* Add / Edit Quiet Hours Window Dialog */}
      <Dialog
        open={quietDialogOpen()}
        animation={reduceMotion() ? "none" : "fade"}
        presentation="fullScreen"
        onOpenChange={(event) => {
          if (!event.open) quietDialogOpen.set(false);
        }}
        class="m-auto rounded-3xl border border-border bg-popover p-5"
        backdropClass="bg-backdrop"
        style={{
          width: Math.min(520, windowSize().width - 32),
          height: Math.max(
            140,
            Math.min(340, windowSize().height - keyboardFrame().height - 24),
          ),
          marginBottom: keyboardFrame().height,
        }}
      >
        <View class="flex-1 min-h-0 gap-3">
          <Text class="text-foreground text-base font-bold" role="header">
            {editingQuietId()
              ? t("quietEditDialogTitle")
              : t("quietAddDialogTitle")}
          </Text>

          <Scroll class="flex-1 min-h-0" contentClass="gap-3 pr-1">
            <TextField
              compact
              testID="quiet-dialog-label-input"
              label={t("quietLabelField")}
              placeholder={t("quietLabelPlaceholder")}
              value={quietLabelDraft()}
              onChange={(value) => quietLabelDraft.set(value)}
            />

            <View class="flex-row gap-3">
              <View class="flex-1 min-w-0">
                <TextField
                  compact
                  testID="quiet-dialog-start-input"
                  label={t("quietStartField")}
                  placeholder="23:00"
                  value={quietStartDraft()}
                  onChange={(value) => quietStartDraft.set(value)}
                />
              </View>
              <View class="flex-1 min-w-0">
                <TextField
                  compact
                  testID="quiet-dialog-end-input"
                  label={t("quietEndField")}
                  placeholder="08:00"
                  value={quietEndDraft()}
                  onChange={(value) => quietEndDraft.set(value)}
                />
              </View>
            </View>

            <If when={Boolean(crossesMidnightPreview())}>
              <Text testID="quiet-dialog-midnight-hint" class="text-warning text-xs">
                {t("quietMidnightHint", {
                  start: crossesMidnightPreview()?.start ?? "",
                  end: crossesMidnightPreview()?.end ?? "",
                })}
              </Text>
            </If>

            <View class="gap-1.5">
              <Text class="text-muted-foreground text-xs font-medium">
                {t("quietDaysField")}
              </Text>
              <View class="flex-row flex-wrap gap-1.5">
                {DAY_KEYS.map((key, dayIndex) => {
                  const selected = () => quietDaysDraft().includes(dayIndex);
                  return (
                    <Button
                      testID={`quiet-dialog-day-${dayIndex}`}
                      selected={selected()}
                      onPress={() => toggleQuietDay(dayIndex)}
                      class={
                        selected()
                          ? "min-h-11 min-w-11 px-2.5 rounded-full bg-primary items-center justify-center active:opacity-70 transition-colors duration-150 motion-reduce:transition-none"
                          : "min-h-11 min-w-11 px-2.5 rounded-full bg-muted items-center justify-center hover:bg-secondary active:opacity-70 transition-colors duration-150 motion-reduce:transition-none"
                      }
                    >
                      <Text
                        class={
                          selected()
                            ? "text-primary-foreground text-xs font-semibold"
                            : "text-muted-foreground text-xs font-medium"
                        }
                      >
                        {t(key)}
                      </Text>
                    </Button>
                  );
                })}
              </View>
            </View>

            <If when={Boolean(quietDialogError())}>
              <View class="rounded-xl bg-destructive/10 border border-destructive/30 p-2.5">
                <Text testID="quiet-dialog-error" class="text-destructive text-xs">
                  {quietDialogError()}
                </Text>
              </View>
            </If>
          </Scroll>

          <View class="flex-row justify-end gap-2 pt-1 border-t border-border">
            <ActionButton
              compact
              testID="quiet-dialog-cancel-btn"
              label={t("cancel")}
              onPress={() => quietDialogOpen.set(false)}
            />
            <ActionButton
              compact
              kind="primary"
              testID="quiet-dialog-save-btn"
              label={t("quietSaveWindow")}
              onPress={() => submitQuietDialog()}
            />
          </View>
        </View>
      </Dialog>
    </View>
  );
}
