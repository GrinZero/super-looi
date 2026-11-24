import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  resolveTranscript,
} from "@earendil-works/pi-ai";
import { obj } from "@earendil-works/pi-schema";
import { PiAgentExecutor } from "../src/agent/core/pi-executor.js";
import {
  ScheduleEngine,
  ScheduleError,
  type NativeSchedulePort,
  type NativeUpcomingAlarm,
} from "../src/schedule/index.js";
import { SqliteRuntimeStore } from "../src/storage/sqlite.js";

function createTestHarness(initialTimeMs = Date.parse("2026-11-22T12:00:00.000Z")) {
  const root = mkdtempSync(join(tmpdir(), "looi-sched-engine-"));
  const dbPath = join(root, "looi.sqlite");
  let currentTimeMs = initialTimeMs;
  const now = () => new Date(currentTimeMs);
  const store = new SqliteRuntimeStore(new DatabaseSync(dbPath), { now });

  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);

  const syncedAlarms: NativeUpcomingAlarm[][] = [];
  const keepAliveCalls: Array<{ active: boolean; hasRunningCheck: boolean; nextTriggerAtMs: number | null }> = [];
  const nativePort: NativeSchedulePort = {
    permissionStatus: () => ({ notification: "granted", exactAlarmAllowed: true }),
    requestPermission: () => ({ notification: "granted", exactAlarmAllowed: true }),
    syncUpcomingAlarms: (alarms) => { syncedAlarms.push([...alarms]); },
    cancelAlarm: () => {},
    syncQuietHours: () => {},
    postNotification: () => {},
    setAndroidKeepAlive: (state) => { keepAliveCalls.push(state); },
    beginIosBackgroundGrace: () => "grace_1",
    endIosBackgroundGrace: () => {},
    drainEvents: () => [],
  };

  let executor: PiAgentExecutor | undefined;
  const setupExecutor = (extra?: Partial<ConstructorParameters<typeof PiAgentExecutor>[0]>) => {
    executor = new PiAgentExecutor({
      stateDirectory: join(root, "state"),
      workspaceRoot: join(root, "workspace"),
      modelsRegistry: models,
      modelSpec: faux.getModel(),
      streamFn: models.streamSimple.bind(models),
      settings: { retry: { enabled: false } },
      ...extra,
    });
    return executor;
  };

  setupExecutor();
  const engine = new ScheduleEngine({
    store,
    getExecutor: () => executor,
    nativePort,
    now,
  });

  return {
    root,
    dbPath,
    store,
    faux,
    models,
    engine,
    nativePort,
    syncedAlarms,
    keepAliveCalls,
    get executor() { return executor!; },
    setExecutor: setupExecutor,
    advanceMs(ms: number) { currentTimeMs += ms; },
    setTime(isoOrMs: string | number) {
      currentTimeMs = typeof isoOrMs === "string" ? Date.parse(isoOrMs) : isoOrMs;
    },
    now,
    async close() {
      await engine.close();
      await executor?.close();
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("scope-isolated dedupe merge, agent_inferred policy lock, autoFollowUpEnabled guard, and maxActiveInferredRules eviction", async () => {
  const h = createTestHarness();
  try {
    // 1. User authorized_action rule vs agent_inferred rule with identical dedupeKey remain completely isolated.
    const userAuth = h.engine.createRule({
      title: "User PR Action",
      prompt: "Merge PR after review",
      origin: "user",
      executionPolicy: "authorized_action",
      dedupeKey: "pr:owner/repo#42",
      trigger: { kind: "once", runAt: "2026-11-22T13:00:00.000Z" },
    });
    assert.equal(userAuth.merged, false);

    // Passing authorized_action with origin=agent_inferred is locked to check_only and does not touch userAuth.
    const inferred1 = h.engine.createRule({
      title: "Inferred PR Check",
      prompt: "Check PR #42 first",
      origin: "agent_inferred",
      executionPolicy: "authorized_action",
      dedupeKey: "pr:owner/repo#42",
      trigger: { kind: "once", runAt: "2026-11-22T12:05:00.000Z" },
    });
    assert.equal(inferred1.merged, false);
    assert.notEqual(inferred1.rule.id, userAuth.rule.id);
    assert.equal(inferred1.rule.executionPolicy, "check_only");
    assert.equal(h.engine.getRule(userAuth.rule.id)?.executionPolicy, "authorized_action");

    // 2. Active agent_inferred rule with same (origin, executionPolicy, dedupeKey) merges cleanly.
    const inferredMerged = h.engine.createRule({
      title: "Inferred PR Check Updated",
      prompt: "Check PR #42 updated",
      origin: "agent_inferred",
      dedupeKey: "pr:owner/repo#42",
      trigger: { kind: "once", runAt: "2026-11-22T12:10:00.000Z" },
    });
    assert.equal(inferredMerged.merged, true);
    assert.equal(inferredMerged.rule.id, inferred1.rule.id);
    assert.equal(inferredMerged.rule.prompt, "Check PR #42 updated");

    // 3. Non-active (completed/paused/running/unconfirmed) parent rule is never merged into.
    h.engine.setRuleEnabled(inferred1.rule.id, false);
    const inferredSeparate = h.engine.createRule({
      title: "New Active Inferred PR Check",
      prompt: "Fresh check",
      origin: "agent_inferred",
      dedupeKey: "pr:owner/repo#42",
      trigger: { kind: "once", runAt: "2026-11-22T12:15:00.000Z" },
    });
    assert.equal(inferredSeparate.merged, false);
    assert.notEqual(inferredSeparate.rule.id, inferred1.rule.id);

    // 4. maxActiveInferredRules eviction removes oldest active inferred rule.
    h.engine.updateSettings({ maxActiveInferredRules: 3 });
    const r2 = h.engine.createRule({
      title: "Inf 2",
      prompt: "Check 2",
      origin: "agent_inferred",
      dedupeKey: "k2",
      trigger: { kind: "once", runAt: "2026-11-22T12:20:00.000Z" },
    }).rule;
    h.advanceMs(1000);
    const r3 = h.engine.createRule({
      title: "Inf 3",
      prompt: "Check 3",
      origin: "agent_inferred",
      dedupeKey: "k3",
      trigger: { kind: "once", runAt: "2026-11-22T12:25:00.000Z" },
    }).rule;
    h.advanceMs(1000);
    const r4 = h.engine.createRule({
      title: "Inf 4",
      prompt: "Check 4",
      origin: "agent_inferred",
      dedupeKey: "k4",
      trigger: { kind: "once", runAt: "2026-11-22T12:30:00.000Z" },
    }).rule;

    assert.equal(h.engine.getRule(inferredSeparate.rule.id)?.state, "expired");
    assert.equal(h.engine.getRule(r2.id)?.state, "active");
    assert.equal(h.engine.getRule(r3.id)?.state, "active");
    assert.equal(h.engine.getRule(r4.id)?.state, "active");

    // 5. autoFollowUpEnabled = false blocks new agent_inferred creation with ERR_AUTO_FOLLOWUP_DISABLED.
    h.engine.updateSettings({ autoFollowUpEnabled: false });
    assert.throws(
      () =>
        h.engine.createRule({
          title: "Blocked",
          prompt: "Blocked",
          origin: "agent_inferred",
          trigger: { kind: "once", runAt: "2026-11-22T12:40:00.000Z" },
        }),
      (err: unknown) =>
        err instanceof ScheduleError && err.code === "ERR_AUTO_FOLLOWUP_DISABLED",
    );
  } finally {
    await h.close();
  }
});

test("4-tier settlement: tool 401 overrides optimistic schedule_report, missing report uses fallback_answer + notify, executor error preserves stage/code", async () => {
  const h = createTestHarness();
  let prStatusCalls = 0;
  h.setExecutor({
    additionalTools: [
      {
        name: "github_pr_status",
        label: "GitHub PR Status",
        description: "Check PR",
        parameters: obj({}),
        execute: async () => {
          prStatusCalls++;
          if (prStatusCalls <= 1) {
            return {
              isError: true,
              content: [{ type: "text", text: "HTTP 401 Unauthorized" }],
              details: {
                failure: {
                  stage: "github.pr_status.pr",
                  code: 401,
                  reason: "Bad credentials from GitHub API",
                },
              },
            };
          }
          return { content: [{ type: "text", text: "PR open" }], details: { open: true } };
        },
      },
    ],
  });

  try {
    // Tier 2: Unrecovered 401 overrides schedule_report({ outcome: "ok", importance: "silent" }).
    const rule401 = h.engine.createRule({
      title: "Check Private PR",
      prompt: "Check PR",
      origin: "agent_inferred",
      dedupeKey: "pr:priv#1",
      sourceSessionId: "fg_session_1",
      trigger: { kind: "once", runAt: "2026-11-22T12:00:00.000Z" },
    }).rule;

    h.faux.setResponses([
      (ctx) => {
        const transcript = resolveTranscript(ctx, undefined);
        // Verify isolated sched_<uuid> session and sourceSessionId prompt context.
        assert.match(JSON.stringify(transcript), /fg_session_1/);
        return fauxAssistantMessage(fauxToolCall("github_pr_status", {}), {
          stopReason: "toolUse",
        });
      },
      fauxAssistantMessage(
        fauxToolCall("schedule_report", {
          outcome: "ok",
          importance: "silent",
          summary: "Everything looks fine",
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("All good!"),
    ]);

    const settledRuns1 = await h.engine.reconcileDueRules();
    assert.equal(settledRuns1.length, 1);
    const run1 = settledRuns1[0]!;
    assert.ok(run1.sessionId?.startsWith("sched_"));
    assert.equal(run1.status, "failed");
    assert.equal(run1.importance, "notify");
    assert.equal(run1.error?.stage, "github.pr_status.pr");
    assert.equal(run1.error?.code, 401);
    assert.equal(run1.toolFailures?.length, 1);
    assert.equal(run1.followUpRuleId, undefined);
    assert.equal(h.engine.getRule(rule401.id)?.state, "completed");

    // Tier 4: Missing schedule_report falls back to fallback_answer + notify.
    const ruleFallback = h.engine.createRule({
      title: "Fallback Test",
      prompt: "Check status without report",
      origin: "user",
      trigger: { kind: "once", runAt: "2026-11-22T12:00:00.000Z" },
    }).rule;

    const longAnswer = "A".repeat(450);
    h.faux.setResponses([fauxAssistantMessage(longAnswer)]);
    const runFallback = await h.engine.runNow(ruleFallback.id);
    assert.equal(runFallback.status, "succeeded");
    assert.equal(runFallback.reportSource, "fallback_answer");
    assert.equal(runFallback.importance, "notify");
    assert.equal(runFallback.summary?.length, 400);

    // Tier 1: Executor exception preserves stage & code.
    const ruleError = h.engine.createRule({
      title: "Model Failure Test",
      prompt: "Trigger 429",
      origin: "user",
      trigger: { kind: "once", runAt: "2026-11-22T12:00:00.000Z" },
    }).rule;
    h.faux.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 Rate limit exceeded" }),
    ]);
    const runErr = await h.engine.runNow(ruleError.id);
    assert.equal(runErr.status, "failed");
    assert.equal(runErr.importance, "notify");
    assert.equal(runErr.error?.stage, "agent.model");
    assert.equal(runErr.error?.code, 429);

    // Tier 2 recovery: tool fails once then succeeds later in the same run -> Tier 3 succeeds.
    prStatusCalls = 0; // next call #1 fails, #2 succeeds
    const ruleRecover = h.engine.createRule({
      title: "Recovered Tool Check",
      prompt: "Retry PR check if needed",
      origin: "user",
      trigger: { kind: "once", runAt: "2026-11-22T12:00:00.000Z" },
    }).rule;
    h.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("github_pr_status", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("github_pr_status", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage(
        fauxToolCall("schedule_report", {
          outcome: "ok",
          importance: "silent",
          summary: "Recovered on retry",
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("Recovered cleanly"),
    ]);
    const runRecovered = await h.engine.runNow(ruleRecover.id);
    assert.equal(runRecovered.status, "succeeded");
    assert.equal(runRecovered.importance, "silent");
    assert.equal(runRecovered.toolFailures?.length, 1);
  } finally {
    await h.close();
  }
});

test("follow-up chaining creates child rules up to maxFollowUps and forces notify at cap", async () => {
  const h = createTestHarness();
  try {
    const rootRule = h.engine.createRule({
      title: "Monitor CI",
      prompt: "Check CI run",
      origin: "agent_inferred",
      dedupeKey: "ci:123",
      maxFollowUps: 2,
      trigger: { kind: "once", runAt: "2026-11-22T12:00:00.000Z" },
    }).rule;

    // Follow-up 0 -> creates child #1 silently
    h.faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("schedule_report", {
          outcome: "pending",
          importance: "silent",
          summary: "CI still building",
          nextCheckDelaySeconds: 120,
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("Pending 1"),
    ]);
    const run0 = (await h.engine.reconcileDueRules())[0]!;
    assert.equal(run0.status, "succeeded");
    assert.equal(run0.importance, "silent");
    assert.ok(run0.followUpRuleId);
    const child1 = h.engine.getRule(run0.followUpRuleId!)!;
    assert.equal(child1.chain.followUpCount, 1);
    assert.equal(child1.chain.rootRuleId, rootRule.id);
    assert.equal(child1.origin, "agent_inferred");
    assert.equal(child1.executionPolicy, "check_only");

    // Advance 120s -> child #1 creates child #2 silently
    h.advanceMs(120_000);
    h.faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("schedule_report", {
          outcome: "pending",
          importance: "silent",
          summary: "CI still queued",
          nextCheckDelaySeconds: 120,
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("Pending 2"),
    ]);
    const run1 = (await h.engine.reconcileDueRules())[0]!;
    assert.equal(run1.importance, "silent");
    assert.ok(run1.followUpRuleId);
    const child2 = h.engine.getRule(run1.followUpRuleId!)!;
    assert.equal(child2.chain.followUpCount, 2);

    // Advance 120s -> child #2 is at maxFollowUps=2 -> stops chaining AND forces importance='notify'
    h.advanceMs(120_000);
    h.faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("schedule_report", {
          outcome: "pending",
          importance: "silent",
          summary: "Still running after max retries",
          nextCheckDelaySeconds: 120,
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("Reached cap"),
    ]);
    const run2 = (await h.engine.reconcileDueRules())[0]!;
    assert.equal(run2.followUpRuleId, undefined);
    assert.equal(run2.importance, "notify");
  } finally {
    await h.close();
  }
});

test("cold-start recovery converts leftover running/awaiting_user runs to result_unconfirmed without auto-rerunning", async () => {
  const root = mkdtempSync(join(tmpdir(), "looi-recover-"));
  const dbPath = join(root, "looi.sqlite");
  let nowMs = Date.parse("2026-11-22T10:00:00.000Z");
  const now = () => new Date(nowMs);

  let store = new SqliteRuntimeStore(new DatabaseSync(dbPath), { now });
  const engine1 = new ScheduleEngine({ store, getExecutor: () => undefined, now });

  const onceRule = engine1.createRule({
    title: "Once Interrupted",
    prompt: "Check once",
    origin: "user",
    trigger: { kind: "once", runAt: "2026-11-22T10:00:00.000Z" },
  }).rule;
  const authRecurring = engine1.createRule({
    title: "Authorized Recurring",
    prompt: "Run side effect daily",
    origin: "user",
    executionPolicy: "authorized_action",
    trigger: { kind: "interval", everySeconds: 300 },
  }).rule;
  const checkRecurring = engine1.createRule({
    title: "Check Only Cron",
    prompt: "Check every hour",
    origin: "user",
    executionPolicy: "check_only",
    trigger: { kind: "cron", expr: "0 * * * *" },
  }).rule;

  assert.equal(
    store.claimScheduleRuleForRun({
      ruleId: onceRule.id,
      run: {
        id: "run_once",
        ruleId: onceRule.id,
        ruleTitle: onceRule.title,
        triggerReason: "scheduled",
        scheduledFor: onceRule.nextRunAt!,
        startedAt: now().toISOString(),
        status: "running",
        sideEffectDispatched: false,
      },
      allowedStates: ["active"],
      nowIso: now().toISOString(),
    }),
    true,
  );
  // Duplicate claim is prevented atomically.
  assert.equal(
    store.claimScheduleRuleForRun({
      ruleId: onceRule.id,
      run: {
        id: "run_once_dup",
        ruleId: onceRule.id,
        ruleTitle: onceRule.title,
        triggerReason: "scheduled",
        scheduledFor: onceRule.nextRunAt!,
        startedAt: now().toISOString(),
        status: "running",
        sideEffectDispatched: false,
      },
      allowedStates: ["active"],
      nowIso: now().toISOString(),
    }),
    false,
  );

  assert.equal(
    store.claimScheduleRuleForRun({
      ruleId: authRecurring.id,
      run: {
        id: "run_auth",
        ruleId: authRecurring.id,
        ruleTitle: authRecurring.title,
        triggerReason: "scheduled",
        scheduledFor: authRecurring.nextRunAt!,
        startedAt: now().toISOString(),
        status: "awaiting_user",
        sideEffectDispatched: false,
      },
      allowedStates: ["active"],
      nowIso: now().toISOString(),
    }),
    true,
  );
  store.markRunSideEffectDispatched("run_auth");

  assert.equal(
    store.claimScheduleRuleForRun({
      ruleId: checkRecurring.id,
      run: {
        id: "run_check",
        ruleId: checkRecurring.id,
        ruleTitle: checkRecurring.title,
        triggerReason: "scheduled",
        scheduledFor: checkRecurring.nextRunAt!,
        startedAt: now().toISOString(),
        status: "running",
        sideEffectDispatched: false,
      },
      allowedStates: ["active"],
      nowIso: now().toISOString(),
    }),
    true,
  );

  await engine1.close();
  store.close();

  // Simulate process restart 2 hours later.
  nowMs = Date.parse("2026-11-22T12:15:00.000Z");
  store = new SqliteRuntimeStore(new DatabaseSync(dbPath), { now });

  try {
    for (const runId of ["run_once", "run_auth", "run_check"]) {
      const recovered = store.getScheduleRun(runId)!;
      assert.equal(recovered.status, "result_unconfirmed");
      assert.deepEqual(recovered.error, {
        stage: "schedule.recover",
        code: "ERR_SCHEDULE_RESULT_UNCONFIRMED",
        reason: "App exited before the scheduled run persisted its outcome",
      });
    }

    const rOnce = store.getScheduleRule(onceRule.id)!;
    assert.equal(rOnce.state, "unconfirmed");
    assert.equal(rOnce.activeRunId, undefined);
    assert.equal(rOnce.nextRunAt, null);

    const rAuth = store.getScheduleRule(authRecurring.id)!;
    assert.equal(rAuth.state, "unconfirmed");
    assert.equal(rAuth.activeRunId, undefined);
    assert.equal(rAuth.nextRunAt, null);

    const rCheck = store.getScheduleRule(checkRecurring.id)!;
    assert.equal(rCheck.state, "active");
    assert.equal(rCheck.activeRunId, undefined);
    assert.ok(rCheck.nextRunAt && Date.parse(rCheck.nextRunAt) > nowMs);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("misfire catchup vs missed grace boundary and native alarm quiet-hours sync", async () => {
  const h = createTestHarness(Date.parse("2026-11-22T14:00:00.000Z"));
  try {
    // Configure quiet hours around local hour 23:00-08:00
    const quietTrigger = new Date(2026, 10, 22, 23, 30, 0, 0);
    const loudTrigger = new Date(2026, 10, 22, 15, 30, 0, 0);
    h.setTime(new Date(2026, 10, 22, 14, 0, 0, 0).getTime());

    h.engine.updateSettings({
      quietHoursEnabled: true,
      quietHours: [
        { id: "night", startMinute: 23 * 60, endMinute: 8 * 60, enabled: true },
      ],
    });

    const catchupRule = h.engine.createRule({
      title: "Catchup Within Grace",
      prompt: "Run catchup",
      origin: "user",
      misfireGraceSeconds: 600,
      trigger: { kind: "once", runAt: new Date(h.now().getTime() + 60_000).toISOString() },
    }).rule;
    const missedRule = h.engine.createRule({
      title: "Missed Beyond Grace",
      prompt: "Should miss",
      origin: "user",
      misfireGraceSeconds: 30,
      trigger: { kind: "once", runAt: new Date(h.now().getTime() + 60_000).toISOString() },
    }).rule;
    h.engine.createRule({
      title: "Quiet Alarm",
      prompt: "Quiet check",
      origin: "user",
      trigger: { kind: "once", runAt: quietTrigger.toISOString() },
    });
    h.engine.createRule({
      title: "Loud Alarm",
      prompt: "Loud check",
      origin: "user",
      trigger: { kind: "once", runAt: loudTrigger.toISOString() },
    });

    await h.engine.syncNative();
    const latestAlarms = h.syncedAlarms.at(-1)!;
    assert.equal(latestAlarms.find((a) => a.title === "Quiet Alarm")?.silent, true);
    assert.equal(latestAlarms.find((a) => a.title === "Loud Alarm")?.silent, false);
    assert.equal(h.keepAliveCalls.at(-1)?.active, true);

    // Advance 3 minutes -> missedRule (grace 30s) is missed; catchupRule (grace 600s, lag 120s) catches up!
    h.advanceMs(180_000);
    h.faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("schedule_report", {
          outcome: "ok",
          importance: "notify",
          summary: "Caught up",
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("Caught up"),
    ]);

    const runs = await h.engine.reconcileDueRules();
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.ruleId, catchupRule.id);
    assert.equal(runs[0]?.triggerReason, "misfire_catchup");

    assert.equal(h.engine.getRule(missedRule.id)?.state, "expired");
    const missedRun = h.engine.listRuns(missedRule.id)[0];
    assert.equal(missedRun?.status, "missed");
    assert.equal(missedRun?.error?.code, "ERR_SCHEDULE_MISSED");
  } finally {
    await h.close();
  }
});

test("admission skip avoids 0ms spin loop, preserves unconfirmed state, setRuleEnabled detects dedupe conflicts, expiresAt normalizes offsets, and cancelRule awaits run settlement", async () => {
  const h = createTestHarness();
  let releaseExternal!: () => void;
  let externalEntered!: () => void;
  const externalStarted = new Promise<void>((r) => { externalEntered = r; });
  const externalGate = new Promise<void>((r) => { releaseExternal = r; });

  h.setExecutor({
    additionalTools: [
      {
        name: "external_hold",
        label: "Hold",
        description: "Hold lane",
        parameters: obj({}),
        execute: async (_id, _args, signal) => {
          externalEntered();
          await new Promise<void>((resolve) => {
            signal?.addEventListener("abort", () => resolve(), { once: true });
            void externalGate.then(() => resolve());
          });
          return { content: [{ type: "text", text: "done" }], details: {} };
        },
      },
    ],
  });

  let externalRun: Promise<unknown> | undefined;
  try {
    // 1. setRuleEnabled dedupe conflict throws structured ScheduleError instead of SQLite error.
    const activeA = h.engine.createRule({
      title: "Active A",
      prompt: "Check A",
      origin: "user",
      dedupeKey: "shared:k",
      trigger: { kind: "once", runAt: "2026-11-22T15:00:00.000Z" },
    }).rule;
    const pausedB = h.engine.createRule({
      title: "Paused B",
      prompt: "Check B",
      origin: "user",
      dedupeKey: "shared:k",
      enabled: false,
      trigger: { kind: "once", runAt: "2026-11-22T15:00:00.000Z" },
    }).rule;
    assert.throws(
      () => h.engine.setRuleEnabled(pausedB.id, true),
      (err: unknown) =>
        err instanceof ScheduleError &&
        err.stage === "schedule.toggle" &&
        err.code === "ERR_SCHEDULE_DEDUPE_CONFLICT",
    );
    await h.engine.deleteRule(activeA.id);
    await h.engine.deleteRule(pausedB.id);

    // 2. expiresAt with non-UTC timezone offset normalizes to UTC ISO and expires accurately.
    const offsetRule = h.engine.createRule({
      title: "Offset Expiry",
      prompt: "Check expiry",
      origin: "user",
      trigger: { kind: "once", runAt: "2026-11-22T12:05:00.000Z" },
      expiresAt: "2026-11-22T20:00:00+08:00", // exact 12:00:00.000Z
    }).rule;
    assert.equal(offsetRule.expiresAt, "2026-11-22T12:00:00.000Z");
    await h.engine.reconcileDueRules();
    assert.equal(h.engine.getRule(offsetRule.id)?.state, "expired");

    // 3. Occupy schedule lane externally -> reconcileDueRules backs off instead of 0ms spin loop,
    // and runNow on an unconfirmed rule preserves "unconfirmed" state on admission rejection.
    h.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("external_hold", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage("External done"),
    ]);
    externalRun = h.executor.run("hold schedule lane", {
      lane: "schedule",
      sessionId: "ext_sched_occupier",
      approvalMode: "yolo",
    });
    await externalStarted;

    const dueRule = h.engine.createRule({
      title: "Due While Busy",
      prompt: "Run when lane free",
      origin: "user",
      trigger: { kind: "once", runAt: "2026-11-22T12:00:00.000Z" },
    }).rule;
    const unconfirmedRule = h.engine.createRule({
      title: "Unconfirmed Target",
      prompt: "Run manually",
      origin: "user",
      trigger: { kind: "once", runAt: "2026-11-22T12:00:00.000Z" },
    }).rule;
    h.store.updateScheduleRule({
      ...unconfirmedRule,
      state: "unconfirmed",
      nextRunAt: null,
    });

    const skippedList = await h.engine.reconcileDueRules();
    assert.equal(skippedList.length, 1);
    assert.equal(skippedList[0]?.status, "skipped");
    assert.equal(h.engine.getRule(dueRule.id)?.state, "active");

    // Wait 50ms -> backoff prevents tight 0ms spinning (still exactly 1 skipped run).
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(h.engine.listRuns(dueRule.id).length, 1);

    const skippedUnconfirmed = await h.engine.runNow(unconfirmedRule.id);
    assert.equal(skippedUnconfirmed.status, "skipped");
    assert.equal(h.engine.getRule(unconfirmedRule.id)?.state, "unconfirmed");

    releaseExternal();
    await externalRun;
    await h.engine.deleteRule(unconfirmedRule.id);

    // 4. syncNative pushes hasRunningCheck=true while active run executes, guarded beginIosBackgroundGrace
    // failure does not leak activeRun, and cancelRule awaits settlement.
    const failingGracePort: NativeSchedulePort = {
      ...h.nativePort,
      beginIosBackgroundGrace: () => Promise.reject(new Error("iOS bg unavailable")),
    };
    await h.engine.attachNativePort(failingGracePort);
    await h.engine.setForegroundActive(false);

    h.keepAliveCalls.length = 0;
    let releaseCheck: (() => void) | undefined;
    let runningPromise: Promise<unknown> | undefined;
    let checkEntered!: () => void;
    const checkStarted = new Promise<void>((r) => { checkEntered = r; });
    const checkGate = new Promise<void>((r) => { releaseCheck = r; });
    try {
      await h.executor.close();
      h.setExecutor({
        additionalTools: [
          {
            name: "github_pr_status",
            label: "Hold PR Status",
            description: "Hold check_only run cleanly",
            parameters: obj({}),
            execute: async (_id, _args, signal) => {
              checkEntered();
              await new Promise<void>((resolve) => {
                signal?.addEventListener("abort", () => resolve(), { once: true });
                void checkGate.then(() => resolve());
              });
              return { content: [{ type: "text", text: "cancelled" }], details: {} };
            },
          },
        ],
      });
      h.faux.setResponses([
        fauxAssistantMessage(fauxToolCall("github_pr_status", {}), { stopReason: "toolUse" }),
        fauxAssistantMessage("done"),
      ]);

      runningPromise = h.engine.runNow(dueRule.id);
      await checkStarted;
      // Allow microtasks for syncNative() invoked right after activeRun assignment.
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.ok(
        h.keepAliveCalls.some((c) => c.hasRunningCheck === true),
        "Expected syncNative to report hasRunningCheck=true during run execution",
      );

      const cancelledRule = await h.engine.cancelRule(dueRule.id);
      assert.equal(cancelledRule.state, "cancelled");
      assert.equal(cancelledRule.activeRunId, undefined);
      await runningPromise;
    } finally {
      releaseCheck?.();
      await runningPromise?.catch(() => {});
    }
  } finally {
    releaseExternal();
    void externalRun?.catch(() => {});
    await h.close();
    await externalRun?.catch(() => {});
  }
});
