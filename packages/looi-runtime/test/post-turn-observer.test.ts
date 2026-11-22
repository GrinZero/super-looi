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
} from "@earendil-works/pi-ai";
import type { AgentRunResult, AgentTask } from "../src/agent/executor.js";
import {
  PostTurnScheduleObserver,
  ScheduleEngine,
  type ScheduleFailure,
} from "../src/schedule/index.js";
import { SqliteRuntimeStore } from "../src/storage/sqlite.js";
import {
  createLangfuseTracer,
  type TraceObservation,
} from "../src/telemetry/langfuse.js";

function makeTaskAndResult(overrides?: {
  task?: Partial<AgentTask>;
  result?: Partial<AgentRunResult>;
}): { task: AgentTask; result: AgentRunResult } {
  const task: AgentTask = {
    id: "task_fg_1",
    sessionId: "session_fg_1",
    workspaceRoot: "/workspace",
    prompt: "Create PR for fix",
    lane: "foreground",
    state: "succeeded",
    createdAt: "2026-11-22T12:00:00.000Z",
    updatedAt: "2026-11-22T12:00:10.000Z",
    steps: [
      { step: 1, phase: "tool_start", toolName: "bash", summary: "Pi · bash" },
      { step: 1, phase: "tool_end", toolName: "bash", summary: "@looi:toolReturned" },
    ],
    ...overrides?.task,
  };
  const result: AgentRunResult = {
    taskId: task.id,
    sessionId: task.sessionId,
    answer: "Opened PR #88 on acme/app. Waiting for CI checks.",
    steps: task.steps,
    toolCallsCount: 1,
    durationMs: 1000,
    finishReason: "completed",
    runtimeExited: true,
    executions: [
      {
        callId: "c1",
        command: "gh pr create --title 'Fix bug'",
        exitCode: 0,
        signal: null,
        timedOut: false,
        aborted: false,
        stdout: "https://github.com/acme/app/pull/88",
      },
    ],
    ...overrides?.result,
  };
  return { task, result };
}

test("PostTurnScheduleObserver enforces 4-gate filter and skips Q&A, failed, schedule-lane, disabled, and already-managed turns", async () => {
  const root = mkdtempSync(join(tmpdir(), "looi-pto-gates-"));
  const store = new SqliteRuntimeStore(new DatabaseSync(join(root, "looi.sqlite")));
  const engine = new ScheduleEngine({ store, getExecutor: () => undefined });
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);

  const observer = new PostTurnScheduleObserver({
    engine,
    store,
    getModelConfig: () => ({
      modelsRegistry: models,
      modelSpec: faux.getModel(),
      streamFn: models.streamSimple.bind(models),
    }),
  });

  try {
    // Gate 4: plain Q&A (no bash/codex_exec/codex_cloud)
    const qa = makeTaskAndResult({
      task: { steps: [{ step: 1, phase: "done", summary: "hi" }] },
      result: {
        steps: [{ step: 1, phase: "done", summary: "hi" }],
        executions: undefined,
      },
    });
    const resQa = await observer.observe({ ...qa, userPrompt: "What is 2+2?" });
    assert.equal(resQa.observed, false);
    assert.equal(resQa.skippedReason, "no_async_signal");
    assert.equal(faux.state.callCount, 0);

    // Gate 2: failed foreground task or non-foreground lane
    const failed = makeTaskAndResult({ task: { state: "failed" } });
    assert.equal(
      (await observer.observe({ ...failed, userPrompt: "Create PR" })).skippedReason,
      "task_not_foreground_succeeded",
    );
    const schedLane = makeTaskAndResult({ task: { lane: "schedule" } });
    assert.equal(
      (await observer.observe({ ...schedLane, userPrompt: "Check PR" })).skippedReason,
      "task_not_foreground_succeeded",
    );

    // Gate 3: manage_schedule already called in turn
    const managed = makeTaskAndResult({
      result: {
        steps: [
          { step: 1, phase: "tool_start", toolName: "bash", summary: "bash" },
          { step: 1, phase: "tool_start", toolName: "manage_schedule", summary: "manage" },
        ],
      },
    });
    assert.equal(
      (await observer.observe({ ...managed, userPrompt: "Create PR" })).skippedReason,
      "schedule_already_managed",
    );

    // Gate 1: autoFollowUpEnabled = false
    engine.updateSettings({ autoFollowUpEnabled: false });
    const normal = makeTaskAndResult();
    assert.equal(
      (await observer.observe({ ...normal, userPrompt: "Create PR" })).skippedReason,
      "auto_followup_disabled",
    );
    assert.equal(faux.state.callCount, 0);
  } finally {
    await engine.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("PostTurnScheduleObserver compresses context <= 2500 chars and seeds structured agent_inferred + check_only rule", async () => {
  const root = mkdtempSync(join(tmpdir(), "looi-pto-create-"));
  const nowMs = Date.parse("2026-11-22T12:00:00.000Z");
  const now = () => new Date(nowMs);
  const store = new SqliteRuntimeStore(new DatabaseSync(join(root, "looi.sqlite")), { now });
  const engine = new ScheduleEngine({ store, getExecutor: () => undefined, now });
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);

  const observer = new PostTurnScheduleObserver({
    engine,
    store,
    now,
    getModelConfig: () => ({
      modelsRegistry: models,
      modelSpec: faux.getModel(),
      streamFn: models.streamSimple.bind(models),
    }),
  });

  try {
    let observedInputLength = 0;
    faux.setResponses([
      (ctx) => {
        const userMessage = ctx.messages.find((m) => m.role === "user");
        const content = typeof userMessage?.content === "string" ? userMessage.content : "";
        observedInputLength = content.length;
        return fauxAssistantMessage(
          JSON.stringify({
            shouldFollowUp: true,
            title: "Check PR acme/app#88 CI",
            delaySeconds: 180,
            target: {
              kind: "github_pr",
              owner: "acme",
              repo: "app",
              pullNumber: 88,
            },
          }),
        );
      },
    ]);

    const hugePrompt = "Create PR ".repeat(500);
    const { task, result } = makeTaskAndResult({
      result: { answer: "Opened PR #88 ".repeat(300) },
    });

    const out = await observer.observe({ task, result, userPrompt: hugePrompt });
    assert.equal(out.observed, true);
    assert.equal(out.created, true);
    assert.ok(observedInputLength > 0 && observedInputLength <= 2500);
    assert.equal(out.rule?.origin, "agent_inferred");
    assert.equal(out.rule?.executionPolicy, "check_only");
    assert.equal(out.rule?.dedupeKey, "github_pr:acme/app#88");
    assert.equal(out.rule?.sourceSessionId, "session_fg_1");
    assert.equal(out.rule?.sourceTaskId, "task_fg_1");
    assert.match(out.rule?.prompt ?? "", /github_pr_status/);
    assert.equal(out.rule?.nextRunAt, "2026-11-22T12:03:00.000Z");

    // Re-running observer for the same taskId hits Gate 3 (source_task_id already in DB)
    const second = await observer.observe({ task, result, userPrompt: hugePrompt });
    assert.equal(second.observed, false);
    assert.equal(second.skippedReason, "schedule_already_managed");
  } finally {
    await engine.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("PostTurnScheduleObserver preserves error stage/code on model or JSON failures and records to tracer without throwing", async () => {
  const root = mkdtempSync(join(tmpdir(), "looi-pto-errors-"));
  const store = new SqliteRuntimeStore(new DatabaseSync(join(root, "looi.sqlite")));
  const engine = new ScheduleEngine({ store, getExecutor: () => undefined });
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);

  const observations: TraceObservation[] = [];
  const tracer = createLangfuseTracer({ onObservation: (node) => observations.push(node) });
  const reportedErrors: ScheduleFailure[] = [];

  const observer = new PostTurnScheduleObserver({
    engine,
    store,
    tracer,
    onError: (f) => reportedErrors.push(f),
    getModelConfig: () => ({
      modelsRegistry: models,
      modelSpec: faux.getModel(),
      streamFn: models.streamSimple.bind(models),
    }),
  });

  try {
    // 1. Model HTTP 401 failure
    faux.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "401 Unauthorized" }),
    ]);
    const { task, result } = makeTaskAndResult();
    const res1 = await observer.observe({ task, result, userPrompt: "Create PR" });
    assert.equal(res1.observed, true);
    assert.equal(res1.created, false);
    assert.equal(res1.error?.stage, "schedule.post_turn.model");
    assert.equal(res1.error?.code, 401);

    // 2. Invalid JSON failure
    faux.setResponses([fauxAssistantMessage("not valid json {{{")]);
    const res2 = await observer.observe({ task, result, userPrompt: "Create PR" });
    assert.equal(res2.observed, true);
    assert.equal(res2.created, false);
    assert.equal(res2.error?.stage, "schedule.post_turn.parse");
    assert.equal(res2.error?.code, "ERR_POST_TURN_INVALID_JSON");

    assert.equal(reportedErrors.length, 2);
    const errorSpans = observations.filter(
      (o) =>
        o.name === "schedule.post_turn_observe" &&
        o.attributes["langfuse.observation.level"] === "ERROR",
    );
    assert.equal(errorSpans.length, 2);
  } finally {
    await engine.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
