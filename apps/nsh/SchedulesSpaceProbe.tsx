import { computed, host, locale, mount, signal, Text, View } from "nsh";
import { ActionButton, Panel, TextField } from "./ui/Controls";
import { ManagementShell } from "./ui/ManagementShell";
import { RetainedPage } from "./ui/RetainedPage";
import { bindLocale, formatDate, resolveLocale, t } from "./i18n";
import {
  isWithinQuietHours,
  parseCron,
  previewCronOccurrences,
  type BodyStatusSnapshot,
  type CreateScheduleRuleInput,
  type GitHubCredentialStatus,
  type GitHubTokenVerificationResult,
  type HomeConfiguration,
  type HomeConnection,
  type NativePermissionStatusResult,
  type NativeScheduleExactAlarmStatus,
  type NativeTask,
  type NativeTaskPage,
  type QuietHoursWindow,
  type ScheduleRule,
  type ScheduleRunRecord,
  type ScheduleSettings,
  type UpdateScheduleRuleInput,
} from "./generated/looi-runtime.js";
import {
  clearInteractionByKeyInQueue,
  clearInteractionsBySourceInQueue,
  clearInteractionsForTaskInQueue,
  enqueuePendingInteraction,
  INITIAL_LLM_SNAPSHOT,
  type AppSpace,
  type PendingInteractionItem,
  type ScheduleRuleFilter,
  type ScheduleSubView,
} from "./store";

export interface SchedulesProbeProps {
  initialSpace?: AppSpace;
  initialSubView?: ScheduleSubView;
  exactAlarmDegraded?: boolean;
  verifyFailMode?: boolean;
  nowIso?: string;
}

function SchedulesSpaceProbe() {
  const launchParams = (host.params ?? {}) as SchedulesProbeProps;
  const effectiveLocale = () => resolveLocale("system", locale());
  bindLocale(effectiveLocale);
  const baseNowMs = launchParams.nowIso
    ? new Date(launchParams.nowIso).getTime()
    : Date.now();
  const activeSpace = signal<AppSpace>(launchParams.initialSpace ?? "schedules");
  const scheduleSubView = signal<ScheduleSubView>(
    launchParams.initialSubView ?? "rules",
  );
  const scheduleRuleFilter = signal<ScheduleRuleFilter>("all");
  const scheduleClockTick = signal(baseNowMs);
  const composeOpen = signal(false);
  const adoptedSessionId = signal("");
  const toast = signal("");
  const openedExactSettingsCount = signal(0);
  const cancelledTaskIds = signal<string[]>([]);
  const respondedCalls = signal<Array<{ taskId: string; id: string; answer: unknown }>>([]);
  const questionAnswers = signal<Record<string, string>>({});

  const initialRules: ScheduleRule[] = [
    {
      id: "rule-user-ci",
      title: "检查 PR CI",
      prompt: "检查 GrinZero/super-looi#42 CI 与 review 状态",
      origin: "user",
      trigger: { kind: "interval", everySeconds: 900 },
      executionPolicy: "check_only",
      enabled: true,
      state: "active",
      nextRunAt: new Date(baseNowMs + 15 * 60_000).toISOString(),
      lastRunAt: new Date(baseNowMs - 10 * 60_000).toISOString(),
      lastRunId: "run-ci-newer",
      chain: { rootRuleId: "rule-user-ci", followUpCount: 0, maxFollowUps: 3 },
      misfireGraceSeconds: 300,
      createdAt: new Date(baseNowMs - 86_400_000).toISOString(),
      updatedAt: new Date(baseNowMs - 600_000).toISOString(),
    },
    {
      id: "rule-inferred-followup",
      title: "自动跟进 PR 检查",
      prompt: "继续关注 PR #42 等待 checks 完成",
      origin: "agent_inferred",
      dedupeKey: "github_pr:GrinZero/super-looi#42",
      trigger: { kind: "once", runAt: new Date(baseNowMs + 600_000).toISOString() },
      executionPolicy: "check_only",
      enabled: true,
      state: "active",
      nextRunAt: new Date(baseNowMs + 600_000).toISOString(),
      chain: { rootRuleId: "rule-user-ci", followUpCount: 1, maxFollowUps: 3 },
      misfireGraceSeconds: 300,
      createdAt: new Date(baseNowMs - 300_000).toISOString(),
      updatedAt: new Date(baseNowMs - 300_000).toISOString(),
    },
    {
      id: "rule-unconfirmed-action",
      title: "夜间部署确认",
      prompt: "触发预发布构建并在结束后汇报",
      origin: "user",
      trigger: { kind: "cron", expr: "0 9 * * *" },
      executionPolicy: "authorized_action",
      enabled: false,
      state: "unconfirmed",
      nextRunAt: null,
      lastRunAt: new Date(baseNowMs - 3_600_000).toISOString(),
      lastRunId: "run-unconfirmed-1",
      chain: { rootRuleId: "rule-unconfirmed-action", followUpCount: 0, maxFollowUps: 3 },
      misfireGraceSeconds: 300,
      createdAt: new Date(baseNowMs - 172_800_000).toISOString(),
      updatedAt: new Date(baseNowMs - 3_600_000).toISOString(),
    },
  ];

  const initialRuns: ScheduleRunRecord[] = [
    {
      id: "run-ci-newer",
      ruleId: "rule-user-ci",
      ruleTitle: "检查 PR CI",
      taskId: "task-sched-101",
      sessionId: "sess-sched-ci-101",
      triggerReason: "scheduled",
      scheduledFor: new Date(baseNowMs - 600_000).toISOString(),
      startedAt: new Date(baseNowMs - 600_000).toISOString(),
      finishedAt: new Date(baseNowMs - 590_000).toISOString(),
      status: "succeeded",
      sideEffectDispatched: false,
      reportSource: "schedule_report",
      importance: "notify",
      summary: "CI 全部通过：build / unit / ios-check 已绿",
    },
    {
      id: "run-ci-older",
      ruleId: "rule-user-ci",
      ruleTitle: "检查 PR CI",
      taskId: "task-sched-100",
      triggerReason: "manual_now",
      scheduledFor: new Date(baseNowMs - 7_200_000).toISOString(),
      startedAt: new Date(baseNowMs - 7_200_000).toISOString(),
      finishedAt: new Date(baseNowMs - 7_190_000).toISOString(),
      status: "failed",
      sideEffectDispatched: false,
      importance: "notify",
      error: {
        stage: "github.api",
        code: 403,
        reason: "Resource not accessible by integration",
      },
      toolFailures: [
        {
          callId: "call-gh-1",
          toolName: "github_pr_status",
          stage: "github.api.checks",
          code: 403,
          reason: "Missing Checks: Read permission",
        },
      ],
    },
    {
      id: "run-unconfirmed-1",
      ruleId: "rule-unconfirmed-action",
      ruleTitle: "夜间部署确认",
      taskId: "task-sched-200",
      triggerReason: "scheduled",
      scheduledFor: new Date(baseNowMs - 3_600_000).toISOString(),
      startedAt: new Date(baseNowMs - 3_600_000).toISOString(),
      finishedAt: new Date(baseNowMs - 3_580_000).toISOString(),
      status: "result_unconfirmed",
      sideEffectDispatched: true,
      importance: "notify",
      summary: "进程在外部部署请求后退出，状态未确认",
    },
  ];

  const scheduleRules = signal<ScheduleRule[]>(initialRules);
  const scheduleRuns = signal<ScheduleRunRecord[]>(initialRuns);
  const selectedScheduleRuleId = signal<string | null>("rule-user-ci");
  const scheduleRunningRuleId = signal<string | null>(null);
  const scheduleSettings = signal<ScheduleSettings>({
    autoFollowUpEnabled: true,
    maxActiveInferredRules: 5,
    quietHoursEnabled: true,
    quietHours: [
      {
        id: "w1",
        label: "夜间睡眠勿扰",
        startMinute: 23 * 60,
        endMinute: 8 * 60,
        enabled: true,
      },
    ],
  });
  const schedulePermission = signal<NativePermissionStatusResult>({
    notification: "undetermined",
    exactAlarmAllowed: !launchParams.exactAlarmDegraded,
    exactAlarmDegraded: Boolean(launchParams.exactAlarmDegraded),
  });
  const scheduleExactAlarm = signal<NativeScheduleExactAlarmStatus | null>(
    launchParams.exactAlarmDegraded
      ? {
          mode: "inexact",
          degraded: true,
          canOpenSettings: true,
          reason: "SCHEDULE_EXACT_ALARM denied",
        }
      : {
          mode: "exact",
          degraded: false,
          canOpenSettings: true,
          reason: "granted",
        },
  );

  const scheduleQuietNow = computed(() =>
    isWithinQuietHours(new Date(scheduleClockTick()), scheduleSettings()),
  );

  let savedToken = "";
  const githubCredential = signal<GitHubCredentialStatus>({ configured: false });
  const githubVerifyResult = signal<GitHubTokenVerificationResult | null>(null);
  const githubBusy = signal(false);

  const pendingInteractions = signal<PendingInteractionItem[]>([]);
  const interaction = computed(() => pendingInteractions()[0]);

  const tasksMap: Record<string, NativeTask> = {
    "task-sched-101": {
      id: "task-sched-101",
      prompt: "检查 GrinZero/super-looi#42 CI 与 review 状态",
      state: "completed",
      lane: "schedule",
      sessionId: "sess-sched-ci-101",
      createdAt: new Date(baseNowMs - 600_000).toISOString(),
      updatedAt: new Date(baseNowMs - 590_000).toISOString(),
      homeActions: [],
      steps: [],
      result: { answer: "CI 全部通过：build / unit / ios-check 已绿" },
    },
    "task-sched-100": {
      id: "task-sched-100",
      prompt: "检查 GrinZero/super-looi#42 CI 与 review 状态",
      state: "failed",
      lane: "schedule",
      sessionId: "sess-sched-ci-100",
      createdAt: new Date(baseNowMs - 7_200_000).toISOString(),
      updatedAt: new Date(baseNowMs - 7_190_000).toISOString(),
      error: "[stage=github.api code=403] Resource not accessible by integration",
      homeActions: [],
      steps: [],
    },
  };
  const tasks = signal<NativeTaskPage>({
    total: 2,
    offset: 0,
    items: Object.values(tasksMap).map((item) => ({
      id: item.id,
      prompt: item.prompt,
      state: item.state,
      updatedAt: item.updatedAt,
      lane: item.lane,
    })),
  });
  const task = signal<NativeTask | undefined>(undefined);

  let seq = 10;
  const computeNextRunAt = (trigger: CreateScheduleRuleInput["trigger"]): string => {
    if (trigger.kind === "once") return trigger.runAt;
    if (trigger.kind === "interval") {
      return new Date(scheduleClockTick() + trigger.everySeconds * 1000).toISOString();
    }
    parseCron(trigger.expr);
    const next = previewCronOccurrences(trigger.expr, 1, new Date(scheduleClockTick()))[0];
    return (next ?? new Date(scheduleClockTick() + 60_000)).toISOString();
  };

  const probeStore = {
    effectiveLocale,
    languagePreference: () => "system" as const,
    setLanguagePreference: async () => {},
    activeSpace: () => activeSpace(),
    openSpace: (space: AppSpace) => {
      activeSpace.set(space);
    },
    backToFace: () => {
      activeSpace.set("face");
    },
    goBack: () => {
      if (activeSpace() !== "schedules") {
        activeSpace.set("schedules");
        return true;
      }
      return false;
    },
    ready: () => true,
    busy: () => false,
    toast: () => toast(),
    llm: () => INITIAL_LLM_SNAPSHOT,
    homeConfiguration: (): HomeConfiguration => ({
      mode: "disabled",
      haUrl: "",
      region: "cn",
      hasToken: false,
      hasMiotAccount: false,
    }),
    homeConnection: (): HomeConnection => ({
      mode: "disabled",
      simulation: false,
      configured: false,
      healthy: false,
      connectionId: null,
      lastVerifiedAt: null,
      error: null,
      entityCount: 0,
    }),
    bodyStatus: (): BodyStatusSnapshot => ({
      mode: "disabled",
      simulation: false,
      permission: "unavailable",
      supervisorState: "disconnected",
      connected: false,
      isDocked: false,
      lightOn: false,
      lightBrightness: 0,
      powerStatus: null,
      powerReading: false,
      motion: { speed: 0, turn: 0 },
      headPose: "center",
      headDegrees: 55,
      deviceId: null,
      deviceName: "LOOI",
      autoConnect: false,
      scanning: false,
      scanCompleted: false,
      connecting: false,
      candidates: [],
      lastVerifiedAt: null,
      error: null,
    }),
    inspectedPluginId: () => null,
    tasks: () => tasks(),
    task: () => task(),
    shellOutput: () => undefined,
    refreshTasks: () => {},
    inspectTask: (id: string) => {
      task.set(tasksMap[id]);
    },
    closeTask: () => {
      task.set(undefined);
    },
    pendingInteractions: () => pendingInteractions(),
    interaction: () => interaction(),
    interactionQueueCount: () => pendingInteractions().length,
    pendingScheduleInteractionCount: () =>
      pendingInteractions().filter((item) => item.source === "schedule").length,
    scheduleRules: () => scheduleRules(),
    scheduleRuns: () => scheduleRuns(),
    scheduleSettings: () => scheduleSettings(),
    scheduleQuietNow: () => scheduleQuietNow(),
    schedulePermission: () => schedulePermission(),
    scheduleExactAlarm: () => scheduleExactAlarm(),
    scheduleSubView: () => scheduleSubView(),
    scheduleRuleFilter: () => scheduleRuleFilter(),
    selectedScheduleRuleId: () => selectedScheduleRuleId(),
    scheduleRunningRuleId: () => scheduleRunningRuleId(),
    scheduleClockTick: () => scheduleClockTick(),
    composeRequestNonce: () => 0,
    githubCredential: () => githubCredential(),
    githubVerifyResult: () => githubVerifyResult(),
    githubBusy: () => githubBusy(),
    setScheduleSubView: (view: ScheduleSubView) => scheduleSubView.set(view),
    setScheduleRuleFilter: (filter: ScheduleRuleFilter) => scheduleRuleFilter.set(filter),
    selectScheduleRule: (id: string | null) => selectedScheduleRuleId.set(id),
    refreshSchedules: async () => {},
    createScheduleRule: (input: CreateScheduleRuleInput) => {
      const id = `rule-custom-${++seq}`;
      const nextRunAt = computeNextRunAt(input.trigger);
      const created: ScheduleRule = {
        id,
        title: input.title,
        prompt: input.prompt,
        origin: input.origin ?? "user",
        dedupeKey: input.dedupeKey,
        trigger: input.trigger,
        executionPolicy: input.executionPolicy ?? "check_only",
        enabled: input.enabled ?? true,
        state: input.enabled === false ? "paused" : "active",
        nextRunAt,
        chain: { rootRuleId: id, followUpCount: 0, maxFollowUps: 3 },
        misfireGraceSeconds: 300,
        createdAt: new Date(scheduleClockTick()).toISOString(),
        updatedAt: new Date(scheduleClockTick()).toISOString(),
      };
      scheduleRules.update((prev) => [created, ...prev]);
      selectedScheduleRuleId.set(id);
      return { rule: created, merged: false };
    },
    updateScheduleRule: (id: string, patch: UpdateScheduleRuleInput) => {
      let updatedRule: ScheduleRule | undefined;
      scheduleRules.update((prev) =>
        prev.map((rule) => {
          if (rule.id !== id) return rule;
          const nextTrigger = patch.trigger ?? rule.trigger;
          updatedRule = {
            ...rule,
            ...(patch.title !== undefined ? { title: patch.title } : {}),
            ...(patch.prompt !== undefined ? { prompt: patch.prompt } : {}),
            ...(patch.trigger !== undefined
              ? { trigger: nextTrigger, nextRunAt: computeNextRunAt(nextTrigger) }
              : {}),
            ...(patch.executionPolicy !== undefined
              ? { executionPolicy: patch.executionPolicy }
              : {}),
            updatedAt: new Date(scheduleClockTick()).toISOString(),
          };
          return updatedRule;
        }),
      );
      if (!updatedRule) throw new Error("rule not found");
      return updatedRule;
    },
    setScheduleRuleEnabled: (id: string, enabled: boolean) => {
      scheduleRules.update((prev) =>
        prev.map((rule) =>
          rule.id === id
            ? { ...rule, enabled, state: enabled ? "active" : "paused" }
            : rule,
        ),
      );
    },
    cancelScheduleRule: async (id: string) => {
      scheduleRules.update((prev) =>
        prev.map((rule) =>
          rule.id === id
            ? { ...rule, enabled: false, state: "cancelled", nextRunAt: null }
            : rule,
        ),
      );
    },
    deleteScheduleRule: async (id: string) => {
      scheduleRules.update((prev) => prev.filter((rule) => rule.id !== id));
      if (selectedScheduleRuleId() === id) {
        selectedScheduleRuleId.set(scheduleRules()[0]?.id ?? null);
      }
    },
    runScheduleRuleNow: async (id: string) => {
      scheduleRunningRuleId.set(id);
      const target = scheduleRules().find((item) => item.id === id);
      const runId = `run-manual-${++seq}`;
      const record: ScheduleRunRecord = {
        id: runId,
        ruleId: id,
        ruleTitle: target?.title ?? "",
        taskId: `task-manual-${seq}`,
        sessionId: `sess-manual-${seq}`,
        triggerReason: "manual_now",
        scheduledFor: new Date(scheduleClockTick()).toISOString(),
        startedAt: new Date(scheduleClockTick()).toISOString(),
        finishedAt: new Date(scheduleClockTick() + 1000).toISOString(),
        status: "succeeded",
        sideEffectDispatched: false,
        importance: "notify",
        summary: `手动检查完成 (${target?.title ?? id})`,
      };
      scheduleRuns.update((prev) => [record, ...prev]);
      scheduleRules.update((prev) =>
        prev.map((rule) =>
          rule.id === id ? { ...rule, lastRunAt: record.finishedAt, lastRunId: runId } : rule,
        ),
      );
      scheduleRunningRuleId.set(null);
    },
    requestSchedulePermission: async () => {
      schedulePermission.update((prev) => ({ ...prev, notification: "granted" }));
    },
    openScheduleExactAlarmSettings: async () => {
      openedExactSettingsCount.update((c) => c + 1);
      return true;
    },
    setAutoFollowUpEnabled: (enabled: boolean) => {
      scheduleSettings.update((prev) => ({ ...prev, autoFollowUpEnabled: enabled }));
    },
    setQuietHoursEnabled: (enabled: boolean) => {
      scheduleSettings.update((prev) => ({ ...prev, quietHoursEnabled: enabled }));
    },
    addQuietHoursWindow: (input: Omit<QuietHoursWindow, "id"> & { id?: string }) => {
      const id = input.id ?? `w-${++seq}`;
      scheduleSettings.update((prev) => ({
        ...prev,
        quietHours: [...prev.quietHours, { ...input, id }],
      }));
      return scheduleSettings();
    },
    updateQuietHoursWindow: (id: string, patch: Partial<Omit<QuietHoursWindow, "id">>) => {
      scheduleSettings.update((prev) => ({
        ...prev,
        quietHours: prev.quietHours.map((w) => (w.id === id ? { ...w, ...patch } : w)),
      }));
      return scheduleSettings();
    },
    removeQuietHoursWindow: (id: string) => {
      scheduleSettings.update((prev) => ({
        ...prev,
        quietHours: prev.quietHours.filter((w) => w.id !== id),
      }));
    },
    saveGitHubToken: (token: string) => {
      const trimmed = typeof token === "string" ? token.trim() : "";
      if (!trimmed || trimmed.length > 8192 || /[\r\n\s]/.test(trimmed)) {
        throw new Error("@looi:runtimeEnterAValidGithubToken");
      }
      savedToken = trimmed;
      const hint = trimmed.length >= 4 ? `••••••••${trimmed.slice(-4)}` : "••••";
      const next = { configured: true, tokenHint: hint };
      githubCredential.set(next);
      githubVerifyResult.set(null);
      toast.set(t("githubPatSavedToast"));
      return next;
    },
    verifyGitHubToken: async () => {
      githubBusy.set(true);
      const res: GitHubTokenVerificationResult = launchParams.verifyFailMode
        ? {
            valid: false,
            configured: Boolean(savedToken),
            tokenHint: savedToken
              ? savedToken.length >= 4
                ? `••••••••${savedToken.slice(-4)}`
                : "••••"
              : undefined,
            failure: { stage: "github.verify", code: 401, reason: "Bad credentials" },
          }
        : {
            valid: true,
            configured: Boolean(savedToken),
            tokenHint: savedToken
              ? savedToken.length >= 4
                ? `••••••••${savedToken.slice(-4)}`
                : "••••"
              : undefined,
            rateLimit: { limit: 5000, remaining: 4991, resetAt: formatDate(baseNowMs + 3600_000) },
          };
      githubVerifyResult.set(res);
      githubBusy.set(false);
      return res;
    },
    clearGitHubToken: () => {
      savedToken = "";
      githubCredential.set({ configured: false });
      githubVerifyResult.set(null);
      toast.set(t("githubPatClearedToast"));
    },
    inspectScheduleTask: (taskId: string) => {
      activeSpace.set("tasks");
      task.set(tasksMap[taskId]);
    },
    continueScheduledSession: (sessionId: string) => {
      adoptedSessionId.set(sessionId);
      activeSpace.set("face");
      composeOpen.set(true);
      return true;
    },
    approve: (allowed: boolean, target = interaction()) => {
      if (!target) return;
      respondedCalls.update((prev) => [
        ...prev,
        { taskId: target.taskId, id: target.id, answer: { outcome: allowed ? "allowed-once" : "rejected" } },
      ]);
      pendingInteractions.update((items) =>
        clearInteractionByKeyInQueue(items, target.taskId, target.id),
      );
    },
    answer: (answers: Array<{ id: string; selected: string[]; custom?: string }>, target = interaction()) => {
      if (!target) return;
      respondedCalls.update((prev) => [
        ...prev,
        { taskId: target.taskId, id: target.id, answer: { answers } },
      ]);
      pendingInteractions.update((items) =>
        clearInteractionByKeyInQueue(items, target.taskId, target.id),
      );
    },
    cancelInteractionTask: async (target = interaction()) => {
      if (!target) return;
      cancelledTaskIds.update((prev) => [...prev, target.taskId]);
      if (target.source === "foreground") {
        pendingInteractions.update((items) =>
          clearInteractionsBySourceInQueue(items, "foreground"),
        );
      } else {
        pendingInteractions.update((items) =>
          clearInteractionsForTaskInQueue(items, target.taskId),
        );
      }
    },
  };

  const seedConcurrentQueue = () => {
    // Enqueue schedule interaction FIRST, then foreground interaction AFTER,
    // verifying foreground takes top slot while queue holds both (1 / 2).
    pendingInteractions.update((items) =>
      enqueuePendingInteraction(items, {
        id: "int-sched-1",
        taskId: "task-sched-live",
        kind: "approval",
        source: "schedule",
        ruleId: "rule-user-ci",
        ruleTitle: "自动部署确认",
        details: { toolName: "home_control", command: "restart build agent" },
        expiresAt: new Date(scheduleClockTick() + 120_000).toISOString(),
        arrivedAt: scheduleClockTick() + 10,
      }),
    );
    pendingInteractions.update((items) =>
      enqueuePendingInteraction(items, {
        id: "int-fg-1",
        taskId: "task-fg-live",
        kind: "approval",
        source: "foreground",
        details: { toolName: "bash", command: "git status" },
        expiresAt: new Date(scheduleClockTick() + 120_000).toISOString(),
        arrivedAt: scheduleClockTick() + 20,
      }),
    );
  };

  const questions = () => {
    const value = interaction()?.details.questions;
    return Array.isArray(value)
      ? value.filter(
          (item): item is { id: string; question: string } =>
            Boolean(item && typeof item.id === "string" && typeof item.question === "string"),
        )
      : [];
  };

  return (
    <View class="flex-1 bg-background">
      <RetainedPage active={activeSpace() === "face"}>
        <View testID="probe-face-surface" class="flex-1 p-4 gap-3 bg-stage-bg">
          <Text testID="probe-adopted-session" class="text-foreground text-sm">
            {adoptedSessionId()}
          </Text>
          <Text testID="probe-compose-open" class="text-foreground text-sm">
            {composeOpen() ? "compose:open" : "compose:closed"}
          </Text>
          <ActionButton
            compact
            testID="probe-return-schedules"
            label={t("schedules")}
            onPress={() => activeSpace.set("schedules")}
          />
        </View>
      </RetainedPage>

      <RetainedPage active={activeSpace() !== "face"}>
        <View class="flex-1 min-h-0">
          <ManagementShell
            store={probeStore as unknown as ReturnType<typeof import("./store").createAppStore>}
            onNewConversation={() => {}}
          />
          <View class="px-3 py-1 bg-card border-t border-border flex-row items-center gap-2">
            <ActionButton
              compact
              testID="probe-seed-queue-btn"
              label="Seed Queue"
              onPress={() => seedConcurrentQueue()}
            />
            <View testID="probe-opened-exact-count">
              <Text class="text-xs text-muted-foreground">
                {`opened:${openedExactSettingsCount()}`}
              </Text>
            </View>
            <View testID="probe-cancelled-tasks">
              <Text class="text-xs text-muted-foreground">
                {cancelledTaskIds().join(",")}
              </Text>
            </View>
            <View testID="probe-responded-count">
              <Text class="text-xs text-muted-foreground">
                {`responded:${respondedCalls().length}`}
              </Text>
            </View>
          </View>
        </View>
      </RetainedPage>

      <Panel
        open={Boolean(interaction())}
        title={
          interaction()?.kind === "approval"
            ? t("allowThisAction")
            : t("looiNeedsYourAnswer")
        }
        dismissible={false}
        onClose={() => {
          void probeStore.cancelInteractionTask(interaction());
        }}
      >
        <If
          when={
            interaction()?.source === "schedule" ||
            pendingInteractions().length > 1
          }
        >
          <View class="flex-row items-center justify-between gap-2 pb-1">
            <View
              testID="interaction-attribution"
              class={
                interaction()?.source === "schedule"
                  ? "rounded-full px-2.5 py-1 bg-warning/15"
                  : "rounded-full px-2.5 py-1 bg-secondary"
              }
            >
              <Text
                class={
                  interaction()?.source === "schedule"
                    ? "text-xs font-medium text-warning"
                    : "text-xs font-medium text-secondary-foreground"
                }
              >
                {interaction()?.source === "schedule"
                  ? t("scheduleInteractionAttribution", {
                      title: interaction()?.ruleTitle ?? t("scheduleUntitledRule"),
                    })
                  : t("foregroundTaskLabel")}
              </Text>
            </View>
            <If when={pendingInteractions().length > 1}>
              <View
                testID="interaction-queue-badge"
                class="rounded-full bg-muted px-2.5 py-1"
              >
                <Text
                  class="text-xs font-medium text-muted-foreground"
                  style={{ fontVariant: ["tabular-nums"] }}
                >
                  {`1 / ${pendingInteractions().length}`}
                </Text>
              </View>
            </If>
          </View>
        </If>

        <Text class="text-foreground text-base">
          {String(
            interaction()?.details.command ??
              interaction()?.details.toolName ??
              t("localAction"),
          )}
        </Text>

        <If when={questions().length > 0}>
          <TextField
            label={questions()[0]?.question ?? ""}
            value={questionAnswers()[questions()[0]?.id ?? ""] ?? ""}
            onChange={(value) => {
              const id = questions()[0]?.id;
              if (id) questionAnswers.update((prev) => ({ ...prev, [id]: value }));
            }}
          />
        </If>

        <View class="flex-row justify-end gap-3 pt-2">
          <ActionButton
            testID="probe-interaction-decline"
            label={
              interaction()?.kind === "approval" ? t("decline") : t("stopTask")
            }
            onPress={() => {
              const current = interaction();
              if (!current) return;
              if (current.kind === "approval") probeStore.approve(false, current);
              else void probeStore.cancelInteractionTask(current);
            }}
          />
          <ActionButton
            testID="probe-interaction-allow"
            kind="primary"
            label={
              interaction()?.kind === "approval" ? t("allowOnce") : t("submitAnswer")
            }
            onPress={() => {
              const current = interaction();
              if (!current) return;
              if (current.kind === "approval") probeStore.approve(true, current);
              else probeStore.answer([], current);
            }}
          />
        </View>
      </Panel>
    </View>
  );
}

mount(SchedulesSpaceProbe);
