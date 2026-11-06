import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DshAgentExecutor, type DshHarness } from "../src/agent/dsh-executor.js";
import { PersonalMemoryStore } from "../src/agent/personal-memory.js";
import type { DeepSeekHarnessOptions, HarnessNotification } from "@deepseek-ai/dsh-sdk-client";
import { DshWorkspaceRunner } from "../src/productivity/dsh-runner.js";
import { HubTaskSupervisor } from "../src/productivity/task-supervisor.js";
import type { AgentExecutor } from "../src/agent/executor.js";
import { buildApp } from "../src/app.js";

async function waitFor(predicate: () => boolean): Promise<void> {
  const end = Date.now() + 2000;
  while (!predicate()) { if (Date.now() > end) throw new Error("Timed out waiting for condition"); await new Promise(resolve => setTimeout(resolve, 5)); }
}

type RuntimeRun = (settings: DeepSeekHarnessOptions, notify: (type: string, data?: Record<string, unknown>) => void, getRequest: () => ((method: string, params: Record<string, unknown>) => Promise<unknown>)) => Promise<{ finalResponse: string; finishReason: string | null }>;
function fixture(run: RuntimeRun, closeWait?: Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "looi-dsh-test-"));
  let starts = 0; let closes = 0; let resumes = 0; let settings!: DeepSeekHarnessOptions;
  let rejectRun: ((error: Error) => void) | undefined;
  const agent = new DshAgentExecutor({
    memoryStore: new PersonalMemoryStore({ persistToDisk: false, seedDefaultsIfEmpty: false }),
    stateDirectory: path.join(root, "state"), workspaceRoot: path.join(root, "workspace"),
    baseUrl: "https://example.invalid/v1", apiKey: "fixture-secret", model: "fixture-model", interactionTimeoutMs: 1000,
    harnessFactory: options => {
      settings = options;
      let handler!: (method: string, params: Record<string, unknown>) => Promise<unknown>;
      const session = (id = "fixture-session") => ({ id, run: async (_prompt: string, opts?: { onNotification?: (notification: HarnessNotification) => void }) => {
        return Promise.race([
          run(options, (type, data = {}) => opts?.onNotification?.({ method: "session.event", params: { sessionId: id, event: { type, data } } }), () => handler),
          new Promise<never>((_resolve, reject) => { rejectRun = reject; }),
        ]);
      } });
      return { client: { start: () => {}, onRequest: h => { handler = h; } },
        start: async () => { starts++; }, session,
        resumeSession: async id => { resumes++; return session(id); },
        close: async () => { closes++; await closeWait; rejectRun?.(new Error("Runtime closed")); },
      } satisfies DshHarness;
    },
  });
  return { agent, root, stats: () => ({ starts, closes, resumes, settings }), cleanup: async () => { await agent.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

describe("Official DSH product executor", () => {
  it("uses isolated launch env, persistent identity, idempotent results and explicit restoration", async () => {
    const f = fixture(async (_settings, emit) => { emit("step/start"); emit("tool/call", { name: "read", callId: "c1" }); emit("tool/result", { callId: "c1" }); return { finalResponse: "真实结果", finishReason: "completed" }; });
    try {
      const first = await f.agent.run("读文件", { taskId: "stable_task" });
      const duplicate = await f.agent.run("读文件", { taskId: "stable_task" });
      assert.equal(first.sessionId, duplicate.sessionId);
      assert.equal(f.stats().starts, 1);
      assert.equal(first.toolCallsCount, 1);
      assert.equal(first.runtimeExited, true);
      const config = f.stats().settings;
      assert.notEqual(config.processCwd, config.cwd);
      assert.equal(config.env?.LOOI_DSH_MODEL_KEY, "fixture-secret");
      assert.equal(config.env?.LLM_API_KEY, undefined);
      assert.ok(!fs.readFileSync(config.patches![0], "utf8").includes("fixture-secret"));
      await f.agent.run("继续检查", { taskId: "stable_task", resume: true });
      assert.equal(f.stats().resumes, 1);
      assert.equal(f.agent.getTask("stable_task")?.sessionId, first.sessionId);
      await assert.rejects(f.agent.run("different", { taskId: "stable_task" }), /another prompt/);
      assert.ok(fs.existsSync(path.join(f.root, "state/tasks/stable_task.json")));
    } finally { await f.cleanup(); }
  });

  it("launches a pure minimal DSH patch without memory/receipt plugins and parses raw JSON tool arguments", async () => {
    const f = fixture(async (settings, emit) => {
      const patch = JSON.parse(fs.readFileSync(settings.patches![0], "utf8"));
      const pluginIds = patch.flatMap((row: { insert?: Array<{ id: string }> }) => row.insert ?? []).map((row: { id: string }) => row.id);
      assert.deepEqual(pluginIds, []);
      emit("tool/call", { name: "bash", callId: "canonical-call", arguments: JSON.stringify({ command: "printf proof" }) });
      emit("tool/result", { message: { toolCallId: "canonical-call", isError: false } });
      return { finalResponse: "done", finishReason: "completed" };
    });
    try {
      const result = await f.agent.run("minimal check");
      assert.equal(result.answer, "done");
      assert.equal(result.toolCallsCount, 1);
      assert.ok(result.steps.some((step) => step.phase === "tool_start" && step.toolName === "bash"));
      assert.ok(result.steps.some((step) => step.phase === "tool_end"));
      assert.ok(result.steps.some((step) => step.phase === "done"));
    } finally {
      await f.cleanup();
    }
  });

  it("never returns a fake successful answer on a model error or missing final response", async () => {
    const f = fixture(async () => ({ finalResponse: "looked successful", finishReason: "error" }));
    try {
      await assert.rejects(f.agent.run("run", { taskId: "error_task" }), /did not complete/);
      assert.equal(f.agent.getTask("error_task")?.state, "failed");
      assert.equal(f.agent.getTask("error_task")?.result, undefined);
    } finally { await f.cleanup(); }
  });

  it("blocks pending approvals until an explicit matching response; rejects stale replies", async () => {
    const f = fixture(async (_settings, _emit, handler) => {
      assert.deepEqual(await handler()("approval/request", { operation: "write", sessionId: "test" }), { outcome: "rejected" });
      return { finalResponse: "已拒绝操作", finishReason: "completed" };
    });
    try {
      const running = f.agent.run("write", { taskId: "approval_task" });
      await waitFor(() => !!f.agent.getTask("approval_task")?.interaction);
      const pending = f.agent.getTask("approval_task")!.interaction!;
      assert.equal(f.agent.getTask("approval_task")?.state, "awaiting_approval");
      assert.throws(() => f.agent.respond("approval_task", "wrong-id", { outcome: "allowed-once" }));
      f.agent.respond("approval_task", pending.id, { outcome: "rejected" });
      await running;
      assert.throws(() => f.agent.respond("approval_task", pending.id, { outcome: "allowed-once" }));
    } finally { await f.cleanup(); }
  });

  it("routes native user questions independently from approvals", async () => {
    const f = fixture(async settings => {
      const answer = await settings.onUserQuestion!({ requestId: "q1", sessionId: "fixture", questions: [{ id: "color", question: "颜色？", options: [{ label: "蓝" }] }] }, { signal: new AbortController().signal });
      assert.deepEqual(answer, { answers: [{ id: "color", selected: ["蓝"] }] });
      return { finalResponse: "蓝色", finishReason: "completed" };
    });
    try {
      const running = f.agent.run("ask", { taskId: "question_task" });
      await waitFor(() => !!f.agent.getTask("question_task")?.interaction);
      const pending = f.agent.getTask("question_task")!.interaction!;
      f.agent.respond("question_task", pending.id, { answers: [{ id: "color", selected: ["蓝"] }] });
      await running;
    } finally { await f.cleanup(); }
  });

  it("cancels an owned runtime but preserves unknown when shell completion was not observed", async () => {
    const f = fixture(async (_settings, emit) => { emit("tool/call", { name: "bash", callId: "long-shell" }); return new Promise(() => {}); });
    try {
      const running = f.agent.run("long command", { taskId: "cancel_shell" });
      const settled = assert.rejects(running);
      await waitFor(() => f.agent.getTask("cancel_shell")?.steps.some(step => step.toolName === "bash") ?? false);
      const stop = await f.agent.cancel("cancel_shell");
      assert.equal(stop.runtimeExited, true);
      assert.equal(stop.confirmed, false);
      assert.equal(stop.state, "unknown");
      await settled;
    } finally { await f.cleanup(); }
  });

  it("does not emit success when cancellation wins during runtime close", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const f = fixture(async () => ({ finalResponse: "done", finishReason: "completed" }), gate);
    try {
      const run = f.agent.run("finish then close", { taskId: "close_race" });
      const settled = assert.rejects(run);
      await waitFor(() => f.stats().closes > 0);
      const cancel = f.agent.cancel("close_race");
      release();
      assert.equal((await cancel).confirmed, true);
      await settled;
      assert.equal(f.agent.getTask("close_race")?.state, "cancelled");
      assert.ok(!f.agent.getTask("close_race")?.steps.some(step => step.phase === "done"));
    } finally { release(); await f.cleanup(); }
  });

  it("observes an abort between admission and deferred startup", async () => {
    const f = fixture(async () => ({ finalResponse: "must not run", finishReason: "completed" }));
    try {
      const controller = new AbortController();
      const run = f.agent.run("cancel now", { taskId: "early_abort", signal: controller.signal });
      controller.abort();
      await assert.rejects(run);
      assert.equal(f.stats().starts, 0);
      assert.equal(f.agent.getTask("early_abort")?.state, "cancelled");
    } finally { await f.cleanup(); }
  });

  it("serves asynchronous tasks, deduplicates submissions and exposes durable failures", async () => {
    const f = fixture(async () => ({ finalResponse: "done", finishReason: "completed" }));
    const app = buildApp({ agentExecutor: f.agent });
    try {
      const first = await app.inject({ method: "POST", url: "/api/agent/tasks", payload: { taskId: "http_task", prompt: "check" } });
      assert.equal(first.statusCode, 202);
      await waitFor(() => f.agent.getTask("http_task")?.state === "succeeded");
      const duplicate = await app.inject({ method: "POST", url: "/api/agent/tasks", payload: { taskId: "http_task", prompt: "check" } });
      assert.equal(duplicate.statusCode, 202);
      assert.equal(f.stats().starts, 1);
      const conflict = await app.inject({ method: "POST", url: "/api/agent/tasks", payload: { taskId: "http_task", prompt: "different" } });
      assert.equal(conflict.statusCode, 409);
      const fetched = await app.inject("/api/agent/tasks/http_task");
      assert.equal(fetched.json().task.state, "succeeded");
    } finally { await app.close(); await f.cleanup(); }
  });
  it("does not verify a command from completed prose or a nonzero exit receipt", async () => {
    for (const exitCode of [undefined, 7, 0]) {
      const supervisor = new HubTaskSupervisor();
      const executor: AgentExecutor = {
        run: async () => ({ taskId: "proof_task", sessionId: "proof_session", answer: "Model turn completed", steps: [], toolCallsCount: exitCode === undefined ? 0 : 1, durationMs: 1, finishReason: "completed", runtimeExited: true, executions: exitCode === undefined ? [] : [{ callId: "c1", command: "test-command", exitCode, signal: null, timedOut: false, aborted: false }] }),
        getTask: () => undefined, listTasks: () => [], respond: () => {}, cancel: async () => ({ confirmed: false, runtimeExited: false, state: "unknown" }), close: async () => {},
      };
      const runner = new DshWorkspaceRunner(supervisor, executor);
      runner.registerWorkspace("test", os.tmpdir());
      await supervisor.submitTask({ schema_version: "0.2", task_id: "proof_task", client_request_id: "proof_request", requested_by_principal_id: "owner", intent: "test command", scope: { household_id: "default", subject_id: null, project_id: "test", audience: "project", acl_policy_id: "test", acl_policy_revision: 1 }, workspace_id: "test", executor_id: "dsh_runner", context_pack_id: "none", requested_at: new Date().toISOString(), deadline_at: new Date(Date.now() + 10000).toISOString() });
      const result = await runner.executeCommand({ taskId: "proof_task", workspaceId: "test", command: "test-command" });
      assert.equal(result.executionStatus, exitCode === 0 ? "completed" : "failed");
      assert.equal((await supervisor.getTaskStatus("proof_task"))?.state, exitCode === 0 ? "succeeded" : "failed");
    }
  });

  it("recovers orphaned productivity tasks as unknown and revokes old grants", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "looi-task-restart-"));
    const filePath = path.join(root, "tasks.json");
    try {
      const supervisor = new HubTaskSupervisor({ filePath });
      await supervisor.submitTask({ schema_version: "0.2", task_id: "restart_task", client_request_id: "restart_request", requested_by_principal_id: "owner", intent: "long work", scope: { household_id: "default", subject_id: null, project_id: "test", audience: "project", acl_policy_id: "test", acl_policy_revision: 1 }, workspace_id: "test", executor_id: "dsh_runner", context_pack_id: "none", requested_at: new Date().toISOString(), deadline_at: new Date(Date.now() + 10000).toISOString() });
      await supervisor.transitionState("restart_task", "running", "in progress");
      const grant = await supervisor.issueActionGrant("restart_task", { issued_by_principal_id: "policy", executor_id: "dsh_runner", trigger: { kind: "authorized_rule", rule_id: "test", rule_revision: 1, trigger_event_id: "test" }, scope: (await supervisor.getAllTasks())[0].scope, not_before: new Date().toISOString(), expires_at: new Date(Date.now() + 10000).toISOString(), max_uses: 1 });
      const restored = new HubTaskSupervisor({ filePath });
      assert.equal((await restored.getTaskStatus("restart_task"))?.state, "unknown");
      assert.equal((await restored.getActionGrant(grant.grant_id))?.status, "revoked");
      assert.equal((await restored.getTaskEvents("restart_task")).length, 3);
      const duplicate = await restored.submitTask((await restored.getAllTasks())[0]);
      assert.equal(duplicate.deduplicated, true);
      assert.equal(duplicate.latestEvent.state, "unknown");
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

});
