import { expect, open, test } from "nsh/test";
import {
  clearInteractionByKeyInQueue,
  clearInteractionsBySourceInQueue,
  clearInteractionsForTaskInQueue,
  enqueuePendingInteraction,
  orderPendingInteractions,
  type PendingInteractionItem,
} from "./store";

test("pendingInteractions pure queue preserves concurrent task interactions and foreground priority", async () => {
  let queue: PendingInteractionItem[] = [];
  queue = enqueuePendingInteraction(queue, {
    id: "req-sched-1",
    taskId: "task-sched-1",
    kind: "approval",
    details: { toolName: "home_control" },
    expiresAt: "2026-11-24T00:00:00.000Z",
    source: "schedule",
    ruleId: "rule-1",
    ruleTitle: "PR 检查",
    arrivedAt: 100,
  });
  queue = enqueuePendingInteraction(queue, {
    id: "req-fg-1",
    taskId: "task-fg-1",
    kind: "question",
    details: { questions: [{ id: "q1", question: "Continue?" }] },
    expiresAt: "2026-11-24T00:00:00.000Z",
    source: "foreground",
    arrivedAt: 200,
  });

  // Foreground is prioritized ahead of schedule even though schedule arrived earlier.
  expect(queue.length).toBe(2);
  expect(queue[0]?.taskId).toBe("task-fg-1");
  expect(queue[1]?.taskId).toBe("task-sched-1");

  // Answering or cancelling only foreground source must NOT wipe schedule interaction.
  const onlyScheduleLeft = clearInteractionsBySourceInQueue(queue, "foreground");
  expect(onlyScheduleLeft.length).toBe(1);
  expect(onlyScheduleLeft[0]?.taskId).toBe("task-sched-1");

  // Clearing only schedule task must NOT wipe foreground task.
  const onlyForegroundLeft = clearInteractionsForTaskInQueue(queue, "task-sched-1");
  expect(onlyForegroundLeft.length).toBe(1);
  expect(onlyForegroundLeft[0]?.taskId).toBe("task-fg-1");

  // Clearing a specific (taskId, interactionId) keeps other interactions intact.
  const withoutSchedKey = clearInteractionByKeyInQueue(
    orderPendingInteractions(queue),
    "task-sched-1",
    "req-sched-1",
  );
  expect(withoutSchedKey.map((item) => item.taskId)).toEqual(["task-fg-1"]);
});

test("App shell landscape exposes 8th Schedules nav item and leap-year Cron preview", async () => {
  const app = await open("./App.tsx", {
    width: 844,
    height: 390,
    locale: "zh-CN",
    colorScheme: "light",
  });

  await app.waitFor("connection-settings");
  await app.press("connection-settings");
  await app.waitFor("nav-schedules");
  await app.press("nav-schedules");

  await app.waitFor("schedules-subview-rules");
  await app.waitFor("schedules-subview-quiet");
  await app.waitFor("schedule-auto-followup-toggle");
  await app.waitFor("schedule-new-rule-btn");

  await app.press("schedule-new-rule-btn");
  await app.waitFor("rule-dialog-kind-cron");
  await app.press("rule-dialog-kind-cron");
  await app.clear("rule-dialog-cron-input");
  await app.type("rule-dialog-cron-input", "0 9 29 2 *");
  await app.waitUntil(() =>
    app.shows("id:rule-dialog-cron-preview >> text:2028-02-29 09:00"),
  );
  await app.press("rule-dialog-cancel-btn");
});

test("Schedules rules master-detail: filter, toggle, unconfirmed banner, CRUD, AlertDialog delete, view task, continue session", async () => {
  const app = await open("./SchedulesSpaceProbe.tsx", {
    width: 844,
    height: 390,
    locale: "zh-CN",
    colorScheme: "light",
    reducedMotion: false,
    host: {
      params: {
        initialSpace: "schedules",
        initialSubView: "rules",
        nowIso: "2026-11-23T14:00:00",
      },
    },
  });

  await app.waitFor("nav-schedules");
  await app.waitFor("nav-schedules-warning-dot");
  // Daytime nowIso (14:00:00) outside 23:00-08:00 must keep header dot hidden regardless of wall clock
  expect(app.shows("quiet-active-header-dot")).toBe(false);

  // Switch briefly to Quiet subview to verify daytime status text without wall-clock interference, then back to Rules
  await app.press("schedules-subview-quiet");
  await app.waitFor("quiet-live-status");
  expect(
    app.shows(
      "id:quiet-live-status >> text:当前为常规时段（重要定时结果将按配置提醒）",
    ),
  ).toBe(true);
  await app.press("schedules-subview-rules");

  // Reverse-chronological runs + structured error & toolFailures on failed run
  await app.waitFor("schedule-run-item-run-ci-newer");
  await app.waitFor("schedule-run-item-run-ci-older");
  expect(app.texts()).toContain("[stage=github.api code=403] Resource not accessible by integration");
  expect(app.texts()).toContain(
    "github_pr_status: [stage=github.api.checks code=403] Missing Checks: Read permission",
  );

  // Source filter pills
  await app.press("schedule-filter-inferred");
  expect(app.shows("schedule-rule-row-rule-inferred-followup")).toBe(true);
  expect(app.shows("schedule-rule-row-rule-user-ci")).toBe(false);
  await app.press("schedule-filter-user");
  expect(app.shows("schedule-rule-row-rule-user-ci")).toBe(true);
  expect(app.shows("schedule-rule-row-rule-inferred-followup")).toBe(false);
  await app.press("schedule-filter-all");
  expect(app.shows("schedule-rule-row-rule-unconfirmed-action")).toBe(true);

  // Select unconfirmed rule -> warning banner visible & trailing Switch disabled
  await app.press("schedule-rule-select-rule-unconfirmed-action");
  await app.waitFor("schedule-unconfirmed-banner");
  expect(
    app.shows(
      "id:schedule-unconfirmed-banner >> text:上次进程退出前已发出外部动作或中断，结果未确认，请核对后手动操作",
    ),
  ).toBe(true);
  await expect(app.press("schedule-rule-toggle-rule-unconfirmed-action")).rejects.toMatchObject({
    code: "ERR_NSH_TEST_DISABLED",
  });

  // Switch back to user CI rule, toggle paused/active & trigger manual Run now
  await app.press("schedule-rule-select-rule-user-ci");
  await app.press("schedule-rule-toggle-rule-user-ci");
  await app.waitUntil(() => app.shows("id:schedule-rule-row-rule-user-ci >> text:已暂停"));
  await app.press("schedule-rule-toggle-rule-user-ci");
  await app.waitUntil(() => app.shows("id:schedule-rule-row-rule-user-ci >> text:已启用"));

  await app.press("schedule-run-now-btn");
  await app.waitUntil(() =>
    app.texts().some((item) => item.includes("手动检查完成 (检查 PR CI)")),
  );

  // Create rule with leap-year Cron (0 9 29 2 * -> 2028-02-29 09:00) + verify impossible date error
  await app.press("schedule-new-rule-btn");
  await app.waitFor("rule-dialog-title-input");
  await app.type("rule-dialog-title-input", "闰年巡检");
  await app.type("rule-dialog-prompt-input", "检查闰年定时任务窗口");
  await app.press("rule-dialog-kind-cron");

  await app.clear("rule-dialog-cron-input");
  await app.type("rule-dialog-cron-input", "0 9 30 2 *");
  await app.waitFor("rule-dialog-cron-error");

  await app.clear("rule-dialog-cron-input");
  await app.type("rule-dialog-cron-input", "0 9 29 2 *");
  await app.waitUntil(() =>
    app.shows("id:rule-dialog-cron-preview >> text:2028-02-29 09:00"),
  );
  await app.press("rule-dialog-save-btn");

  await app.waitUntil(() => app.texts().includes("闰年巡检"));

  // Edit rule
  await app.press("schedule-edit-rule-btn");
  await app.waitFor("rule-dialog-title-input");
  await app.clear("rule-dialog-title-input");
  await app.type("rule-dialog-title-input", "闰年巡检 v2");
  await app.press("rule-dialog-save-btn");
  await app.waitUntil(() => app.texts().includes("闰年巡检 v2"));

  // Delete rule: cancel first, confirm second via native AlertDialog
  app.onDialog((dialog) => {
    expect(dialog.title).toContain("闰年巡检 v2");
    return "取消";
  });
  await app.press("schedule-delete-rule-btn");
  await app.waitUntil(() => app.dialogs().length === 1);
  expect(app.texts()).toContain("闰年巡检 v2");

  app.onDialog(() => "删除");
  await app.press("schedule-delete-rule-btn");
  await app.waitUntil(() => app.dialogs().length === 2);
  await app.waitUntil(() => !app.texts().includes("闰年巡检 v2"));

  // View Task navigates to tasks space and selects task-sched-101
  await app.press("schedule-rule-select-rule-user-ci");
  await app.waitFor("schedule-run-view-task-run-ci-newer");
  await app.press("schedule-run-view-task-run-ci-newer");
  await app.waitUntil(() =>
    app.texts().some((item) => item.includes("CI 全部通过：build / unit / ios-check 已绿")),
  );

  // Return to Schedules & Continue Session opens face compose bar
  await app.press("nav-schedules");
  await app.waitFor("schedule-run-continue-session-run-ci-newer");
  await app.press("schedule-run-continue-session-run-ci-newer");
  await app.waitFor("probe-face-surface");
  expect(app.shows("id:probe-face-surface >> text:sess-sched-ci-101")).toBe(true);
  expect(app.shows("id:probe-face-surface >> text:compose:open")).toBe(true);
});

test("Quiet hours multi-window cross-midnight, exact alarm degraded, and GitHub PAT save/verify/clear", async () => {
  const app = await open("./SchedulesSpaceProbe.tsx", {
    width: 844,
    height: 390,
    locale: "zh-CN",
    colorScheme: "light",
    host: {
      params: {
        initialSpace: "schedules",
        initialSubView: "quiet",
        exactAlarmDegraded: true,
        nowIso: "2026-11-23T23:30:00",
      },
    },
  });

  await app.waitFor("quiet-live-status");
  await app.waitFor("quiet-active-header-dot");
  expect(
    app.shows(
      "id:quiet-live-status >> text:当前处于勿扰时段（定时检查照常运行，语音与通知保持静音）",
    ),
  ).toBe(true);
  expect(app.shows("id:quiet-window-card-w1 >> text:23:00 – 次日 08:00 · 每天")).toBe(true);

  // Toggle master switch off -> status updates immediately -> toggle back on
  await app.press("quiet-master-toggle");
  await app.waitUntil(() =>
    app.shows(
      "id:quiet-live-status >> text:当前为常规时段（重要定时结果将按配置提醒）",
    ),
  );
  await app.press("quiet-master-toggle");
  await app.waitUntil(() =>
    app.shows(
      "id:quiet-live-status >> text:当前处于勿扰时段（定时检查照常运行，语音与通知保持静音）",
    ),
  );

  // Add second quiet window
  await app.press("schedule-add-quiet-btn");
  await app.waitFor("quiet-dialog-label-input");
  await app.type("quiet-dialog-label-input", "午休静音");
  await app.clear("quiet-dialog-start-input");
  await app.type("quiet-dialog-start-input", "12:30");
  await app.clear("quiet-dialog-end-input");
  await app.type("quiet-dialog-end-input", "14:00");
  await app.press("quiet-dialog-day-1");
  await app.press("quiet-dialog-save-btn");

  await app.waitUntil(() => app.texts().includes("午休静音"));
  expect(app.shows("quiet-window-card-w1")).toBe(true);

  // Exact alarm degraded warning & settings action
  await app.waitFor("schedule-exact-alarm-degraded");
  await app.press("schedule-open-exact-alarm-settings");
  await app.waitUntil(() => app.shows("id:probe-opened-exact-count >> text:opened:1"));

  // Invalid PAT containing whitespace surfaces translated runtime error (never raw @looi: key)
  await app.type("github-pat-input", "bad token");
  await app.press("github-pat-save-btn");
  await app.waitFor("github-pat-error");
  expect(app.shows("github-pat-error")).toBe(true);
  expect(app.texts()).toContain("请填写有效的 GitHub 只读访问令牌");
  expect(app.texts().some((line) => line.includes("@looi:"))).toBe(false);
  await app.clear("github-pat-input");

  // GitHub PAT save (clears plaintext input!), verify OK, and clear
  await app.type("github-pat-input", "github_pat_test_secret_7890");
  await app.press("github-pat-save-btn");
  await app.waitUntil(() => app.value("github-pat-input") === "");
  expect(
    app.shows("id:github-pat-status-badge >> text:已配置 · 令牌 ••••••••7890"),
  ).toBe(true);

  await app.press("github-pat-verify-btn");
  await app.waitFor("github-pat-verify-ok");
  expect(app.shows("id:github-pat-verify-ok >> text:校验通过 · 配额剩余 4991 / 5000")).toBe(
    true,
  );

  await app.press("github-pat-clear-btn");
  await app.waitUntil(() => app.shows("id:github-pat-status-badge >> text:未配置"));

  // GitHub verify error preserves stage/code/reason
  const failApp = await open("./SchedulesSpaceProbe.tsx", {
    width: 844,
    height: 390,
    locale: "zh-CN",
    colorScheme: "dark",
    reducedMotion: true,
    host: {
      params: {
        initialSpace: "schedules",
        initialSubView: "quiet",
        verifyFailMode: true,
      },
    },
  });
  await failApp.waitFor("github-pat-input");
  await failApp.type("github-pat-input", "github_pat_bad_0001");
  await failApp.press("github-pat-save-btn");
  await failApp.press("github-pat-verify-btn");
  await failApp.waitFor("github-pat-verify-error");
  expect(
    failApp.shows(
      "id:github-pat-verify-error >> text:[stage=github.verify code=401] Bad credentials",
    ),
  ).toBe(true);
});

test("Multi-task pendingInteractions UI queue isolation, dark mode, reducedMotion, and English i18n", async () => {
  const app = await open("./SchedulesSpaceProbe.tsx", {
    width: 844,
    height: 390,
    locale: "zh-CN",
    colorScheme: "dark",
    reducedMotion: true,
    host: {
      params: {
        initialSpace: "schedules",
        initialSubView: "rules",
      },
    },
  });

  await app.waitFor("probe-seed-queue-btn");
  await app.press("probe-seed-queue-btn");

  // Foreground task appears first with queue badge 1 / 2
  await app.waitFor("interaction-queue-badge");
  expect(app.shows("id:interaction-queue-badge >> text:1 / 2")).toBe(true);
  expect(app.shows("id:interaction-attribution >> text:前台对话")).toBe(true);

  // Answering foreground approval advances cleanly to schedule interaction (never drops it!)
  await app.press("probe-interaction-allow");
  await app.waitUntil(() =>
    app.shows("id:interaction-attribution >> text:定时任务 · 自动部署确认"),
  );
  expect(app.shows("interaction-queue-badge")).toBe(false);

  // Stopping schedule interaction clears only schedule task
  await app.press("probe-interaction-decline");
  await app.waitUntil(() => !app.shows("interaction-attribution"));
  expect(app.shows("id:probe-responded-count >> text:responded:2")).toBe(true);
  app.dispose();

  // English dark mode + reducedMotion smoke check
  const enApp = await open("./SchedulesSpaceProbe.tsx", {
    width: 844,
    height: 390,
    locale: "en-US",
    colorScheme: "dark",
    reducedMotion: true,
    host: {
      params: {
        initialSpace: "schedules",
        initialSubView: "quiet",
      },
    },
  });
  await enApp.waitFor("nav-schedules");
  expect(enApp.texts()).toContain("Schedules");
  expect(enApp.texts()).toContain("Rules · 3");
  expect(enApp.texts()).toContain("Quiet hours");
  expect(enApp.texts()).toContain("GitHub read-only PAT");
  enApp.dispose();
});
