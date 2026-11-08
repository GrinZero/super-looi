import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type AssistantMessage,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { PiAgentExecutor, type PiExecutorConfig } from "../src/agent/pi-executor.js";
import { DshWorkspaceRunner } from "../src/productivity/dsh-runner.js";
import { HubTaskSupervisor } from "../src/productivity/task-supervisor.js";
import type { AgentExecutor } from "../src/agent/executor.js";
import { buildApp } from "../src/app.js";

async function waitFor(predicate: () => boolean): Promise<void> {
  const end = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function createPiFixture(
  responses: AssistantMessage[] | ((ctx: TranscriptContext, callIndex: number) => AssistantMessage),
  extraConfig: Partial<PiExecutorConfig> = {}
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "looi-pi-test-"));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { recursive: true });

  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const modelSpec = faux.getModel();

  let streamCalls = 0;
  const observedContexts: TranscriptContext[] = [];

  if (Array.isArray(responses)) {
    faux.setResponses(responses);
  }

  const agent = new PiAgentExecutor({
    stateDirectory: path.join(root, "state"),
    workspaceRoot: workspace,
    interactionTimeoutMs: 1000,
    stopGraceMs: 30,
    modelSpec,
    streamFn: (model, context, options) => {
      const idx = streamCalls++;
      observedContexts.push(structuredClone(context));
      if (typeof responses === "function") {
        faux.setResponses([responses(context, idx)]);
      }
      return models.streamSimple(model, context, options);
    },
    ...extraConfig,
  });

  return {
    agent,
    root,
    workspace,
    faux,
    stats: () => ({ streamCalls, observedContexts }),
    cleanup: async () => {
      await agent.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

describe("Pi-Agent in-process executor (PiAgentExecutor)", () => {
  it("uses persistent identity, idempotent results and explicit session restoration", async () => {
    const f = createPiFixture((_ctx, callIndex) => {
      if (callIndex === 0) {
        return fauxAssistantMessage([fauxToolCall("read_file", { path: "hello.txt" })], { stopReason: "toolUse" });
      }
      if (callIndex === 1) {
        return fauxAssistantMessage([fauxText("真实结果")]);
      }
      return fauxAssistantMessage([fauxText("已恢复会话结果")]);
    });

    try {
      fs.writeFileSync(path.join(f.workspace, "hello.txt"), "hello world", "utf8");
      const first = await f.agent.run("读文件", { taskId: "stable_task" });
      const duplicate = await f.agent.run("读文件", { taskId: "stable_task" });
      assert.equal(first.sessionId, duplicate.sessionId);
      assert.equal(f.stats().streamCalls, 2);
      assert.equal(first.toolCallsCount, 1);
      assert.equal(first.runtimeExited, true);

      const second = await f.agent.run("继续检查", { taskId: "stable_task", resume: true });
      assert.equal(second.answer, "已恢复会话结果");
      assert.equal(f.stats().streamCalls, 3);
      assert.equal(f.agent.getTask("stable_task")?.sessionId, first.sessionId);
      // Verify restored transcript passed to LLM contains prior assistant message
      const thirdCallMessages = f.stats().observedContexts[2].messages;
      assert.ok(thirdCallMessages.some((m) => m.role === "assistant"));

      await assert.rejects(f.agent.run("different", { taskId: "stable_task" }), /another prompt/);
      assert.ok(fs.existsSync(path.join(f.root, "state/tasks/stable_task.json")));
      assert.ok(fs.existsSync(path.join(f.root, `state/sessions/${first.sessionId}.json`)));
    } finally {
      await f.cleanup();
    }
  });

  it("executes real in-process bash and file tools and records command exit receipts & artifacts", async () => {
    const f = createPiFixture([
      fauxAssistantMessage([fauxToolCall("bash", { command: "printf proof > proof.txt" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("done")]),
    ]);
    try {
      const result = await f.agent.run("minimal check");
      assert.equal(result.answer, "done");
      assert.equal(result.toolCallsCount, 1);
      assert.equal(result.executions?.length, 1);
      assert.equal(result.executions?.[0].exitCode, 0);
      assert.equal(result.executions?.[0].command, "printf proof > proof.txt");
      assert.ok(result.artifacts?.some((a) => a.path === "proof.txt"));
      assert.ok(result.steps.some((step) => step.phase === "tool_start" && step.toolName === "bash"));
      assert.ok(result.steps.some((step) => step.phase === "tool_end"));
      assert.ok(result.steps.some((step) => step.phase === "done"));
    } finally {
      await f.cleanup();
    }
  });

  it("never returns a fake successful answer on a model error or missing final response", async () => {
    const f = createPiFixture([
      fauxAssistantMessage([fauxText("looked successful")], {
        stopReason: "error",
        errorMessage: "upstream failure",
      }),
    ]);
    try {
      await assert.rejects(f.agent.run("run", { taskId: "error_task" }), /did not complete/);
      assert.equal(f.agent.getTask("error_task")?.state, "failed");
      assert.equal(f.agent.getTask("error_task")?.result, undefined);
    } finally {
      await f.cleanup();
    }
  });

  it("blocks pending approvals via beforeToolCall until an explicit matching response; rejects stale replies", async () => {
    const outsideFile = path.join(os.tmpdir(), `looi-outside-${Date.now()}.txt`);
    const f = createPiFixture([
      fauxAssistantMessage([fauxToolCall("write_file", { path: outsideFile, content: "blocked" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage([fauxText("已拒绝操作")]),
    ]);
    try {
      const running = f.agent.run("write", { taskId: "approval_task" });
      await waitFor(() => !!f.agent.getTask("approval_task")?.interaction);
      const pending = f.agent.getTask("approval_task")!.interaction!;
      assert.equal(f.agent.getTask("approval_task")?.state, "awaiting_approval");
      assert.throws(() => f.agent.respond("approval_task", "wrong-id", { outcome: "allowed-once" }));
      f.agent.respond("approval_task", pending.id, { outcome: "rejected" });
      const res = await running;
      assert.equal(res.answer, "已拒绝操作");
      assert.ok(!fs.existsSync(outsideFile));
      assert.throws(() => f.agent.respond("approval_task", pending.id, { outcome: "allowed-once" }));
    } finally {
      await f.cleanup();
    }
  });

  it("routes ask_user_question tool independently from approvals", async () => {
    const f = createPiFixture([
      fauxAssistantMessage(
        [
          fauxToolCall("ask_user_question", {
            questions: [{ id: "color", question: "颜色？", options: [{ label: "蓝" }] }],
          }),
        ],
        { stopReason: "toolUse" }
      ),
      fauxAssistantMessage([fauxText("蓝色")]),
    ]);
    try {
      const running = f.agent.run("ask", { taskId: "question_task" });
      await waitFor(() => !!f.agent.getTask("question_task")?.interaction);
      const pending = f.agent.getTask("question_task")!.interaction!;
      assert.equal(f.agent.getTask("question_task")?.state, "awaiting_input");
      f.agent.respond("question_task", pending.id, { answers: [{ id: "color", selected: ["蓝"] }] });
      const res = await running;
      assert.equal(res.answer, "蓝色");
    } finally {
      await f.cleanup();
    }
  });

  it("cancels a running local shell command and kills the child process cleanly", async () => {
    const f = createPiFixture([
      fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 20" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("never reached")]),
    ]);
    try {
      const running = f.agent.run("long command", { taskId: "cancel_shell" });
      const settled = assert.rejects(running);
      await waitFor(() => f.agent.getTask("cancel_shell")?.steps.some((step) => step.toolName === "bash") ?? false);
      const stop = await f.agent.cancel("cancel_shell");
      assert.equal(stop.runtimeExited, true);
      assert.equal(stop.confirmed, true);
      assert.equal(stop.state, "cancelled");
      await settled;
    } finally {
      await f.cleanup();
    }
  });

  it("preserves unknown state when a custom shell tool does not exit on abort", async () => {
    let release!: () => void;
    const hang = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = createPiFixture(
      [fauxAssistantMessage([fauxToolCall("bash", { command: "remote-hang" })], { stopReason: "toolUse" })],
      {
        stopGraceMs: 20,
        customTools: [
          {
            name: "bash",
            label: "Unstoppable Remote Shell",
            description: "Simulates a remote shell whose exit cannot be confirmed",
            parameters: { type: "object", properties: { command: { type: "string" } } },
            execute: async () => {
              await hang;
              return { content: [{ type: "text", text: "done" }], details: {} };
            },
          },
        ],
      }
    );
    try {
      const running = f.agent.run("remote command", { taskId: "unconfirmed_shell" });
      const settled = assert.rejects(running);
      await waitFor(() => f.agent.getTask("unconfirmed_shell")?.steps.some((step) => step.toolName === "bash") ?? false);
      const stop = await f.agent.cancel("unconfirmed_shell");
      assert.equal(stop.runtimeExited, true);
      assert.equal(stop.confirmed, false);
      assert.equal(stop.state, "unknown");
      release();
      await settled;
    } finally {
      release();
      await f.cleanup();
    }
  });

  it("observes an abort between admission and deferred startup", async () => {
    const f = createPiFixture([fauxAssistantMessage([fauxText("must not run")])]);
    try {
      const controller = new AbortController();
      const run = f.agent.run("cancel now", { taskId: "early_abort", signal: controller.signal });
      controller.abort();
      await assert.rejects(run);
      assert.equal(f.stats().streamCalls, 0);
      assert.equal(f.agent.getTask("early_abort")?.state, "cancelled");
    } finally {
      await f.cleanup();
    }
  });

  it("serves asynchronous tasks, deduplicates submissions and exposes durable failures", async () => {
    const f = createPiFixture([fauxAssistantMessage([fauxText("done")])]);
    const app = buildApp({ agentExecutor: f.agent });
    try {
      const first = await app.inject({
        method: "POST",
        url: "/api/agent/tasks",
        payload: { taskId: "http_task", prompt: "check" },
      });
      assert.equal(first.statusCode, 202);
      await waitFor(() => f.agent.getTask("http_task")?.state === "succeeded");
      const duplicate = await app.inject({
        method: "POST",
        url: "/api/agent/tasks",
        payload: { taskId: "http_task", prompt: "check" },
      });
      assert.equal(duplicate.statusCode, 202);
      assert.equal(f.stats().streamCalls, 1);
      const conflict = await app.inject({
        method: "POST",
        url: "/api/agent/tasks",
        payload: { taskId: "http_task", prompt: "different" },
      });
      assert.equal(conflict.statusCode, 409);
      const fetched = await app.inject("/api/agent/tasks/http_task");
      assert.equal(fetched.json().task.state, "succeeded");
    } finally {
      await app.close();
      await f.cleanup();
    }
  });

  it("does not verify a command from completed prose or a nonzero exit receipt", async () => {
    for (const exitCode of [undefined, 7, 0]) {
      const supervisor = new HubTaskSupervisor();
      const executor: AgentExecutor = {
        run: async () => ({
          taskId: "proof_task",
          sessionId: "proof_session",
          answer: "Model turn completed",
          steps: [],
          toolCallsCount: exitCode === undefined ? 0 : 1,
          durationMs: 1,
          finishReason: "completed",
          runtimeExited: true,
          executions:
            exitCode === undefined
              ? []
              : [
                  {
                    callId: "c1",
                    command: "test-command",
                    exitCode,
                    signal: null,
                    timedOut: false,
                    aborted: false,
                  },
                ],
        }),
        getTask: () => undefined,
        listTasks: () => [],
        respond: () => {},
        cancel: async () => ({ confirmed: false, runtimeExited: false, state: "unknown" }),
        close: async () => {},
      };
      const runner = new DshWorkspaceRunner(supervisor, executor);
      runner.registerWorkspace("test", os.tmpdir());
      await supervisor.submitTask({
        schema_version: "0.2",
        task_id: "proof_task",
        client_request_id: "proof_request",
        requested_by_principal_id: "owner",
        intent: "test command",
        scope: {
          household_id: "default",
          subject_id: null,
          project_id: "test",
          audience: "project",
          acl_policy_id: "test",
          acl_policy_revision: 1,
        },
        workspace_id: "test",
        executor_id: "dsh_runner",
        context_pack_id: "none",
        requested_at: new Date().toISOString(),
        deadline_at: new Date(Date.now() + 10000).toISOString(),
      });
      const result = await runner.executeCommand({
        taskId: "proof_task",
        workspaceId: "test",
        command: "test-command",
      });
      assert.equal(result.executionStatus, exitCode === 0 ? "completed" : "failed");
      assert.equal((await supervisor.getTaskStatus("proof_task"))?.state, exitCode === 0 ? "succeeded" : "failed");
    }
  });

  it("recovers orphaned productivity tasks as unknown and revokes old grants", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "looi-task-restart-"));
    const filePath = path.join(root, "tasks.json");
    try {
      const supervisor = new HubTaskSupervisor({ filePath });
      await supervisor.submitTask({
        schema_version: "0.2",
        task_id: "restart_task",
        client_request_id: "restart_request",
        requested_by_principal_id: "owner",
        intent: "long work",
        scope: {
          household_id: "default",
          subject_id: null,
          project_id: "test",
          audience: "project",
          acl_policy_id: "test",
          acl_policy_revision: 1,
        },
        workspace_id: "test",
        executor_id: "dsh_runner",
        context_pack_id: "none",
        requested_at: new Date().toISOString(),
        deadline_at: new Date(Date.now() + 10000).toISOString(),
      });
      await supervisor.transitionState("restart_task", "running", "in progress");
      const grant = await supervisor.issueActionGrant("restart_task", {
        issued_by_principal_id: "policy",
        executor_id: "dsh_runner",
        trigger: {
          kind: "authorized_rule",
          rule_id: "test",
          rule_revision: 1,
          trigger_event_id: "test",
        },
        scope: (await supervisor.getAllTasks())[0].scope,
        not_before: new Date().toISOString(),
        expires_at: new Date(Date.now() + 10000).toISOString(),
        max_uses: 1,
      });
      const restored = new HubTaskSupervisor({ filePath });
      assert.equal((await restored.getTaskStatus("restart_task"))?.state, "unknown");
      assert.equal((await restored.getActionGrant(grant.grant_id))?.status, "revoked");
      assert.equal((await restored.getTaskEvents("restart_task")).length, 3);
      const duplicate = await restored.submitTask((await restored.getAllTasks())[0]);
      assert.equal(duplicate.deduplicated, true);
      assert.equal(duplicate.latestEvent.state, "unknown");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
