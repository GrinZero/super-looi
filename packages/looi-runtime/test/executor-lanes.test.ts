import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { obj } from "@earendil-works/pi-schema";
import { AgentExecutionError } from "../src/agent/executor.js";
import { PiAgentExecutor } from "../src/agent/core/pi-executor.js";

test("executor supports 3 concurrent lanes (foreground, plugin, schedule) and enforces per-lane limit 1 and capacity limit", async () => {
  const root = mkdtempSync(join(tmpdir(), "looi-lanes-"));
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);

  const gates = new Map<string, { entered: () => void; release: () => void }>();
  const started = new Map<string, Promise<void>>();
  for (const lane of ["foreground", "plugin", "schedule"]) {
    let entered!: () => void;
    let release!: () => void;
    const p = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    started.set(lane, p);
    gates.set(lane, { entered, release });
    // Store release gate in closure via tool call prompt lookup
    void gate;
  }

  let releaseFg!: () => void;
  let releasePlugin!: () => void;
  let releaseSched!: () => void;
  const fgGate = new Promise<void>((r) => { releaseFg = r; });
  const pluginGate = new Promise<void>((r) => { releasePlugin = r; });
  const schedGate = new Promise<void>((r) => { releaseSched = r; });

  const executor = new PiAgentExecutor({
    stateDirectory: join(root, "state"),
    workspaceRoot: join(root, "workspace"),
    modelsRegistry: models,
    modelSpec: faux.getModel(),
    streamFn: models.streamSimple.bind(models),
    maxConcurrentTasks: 3,
    customTools: [
      {
        name: "hold_fg",
        label: "Hold FG",
        description: "Hold foreground lane",
        parameters: obj({}),
        execute: async () => {
          gates.get("foreground")!.entered();
          await fgGate;
          return { content: [{ type: "text", text: "fg done" }], details: {} };
        },
      },
      {
        name: "hold_plugin",
        label: "Hold Plugin",
        description: "Hold plugin lane",
        parameters: obj({}),
        execute: async () => {
          gates.get("plugin")!.entered();
          await pluginGate;
          return { content: [{ type: "text", text: "plugin done" }], details: {} };
        },
      },
      {
        name: "hold_sched",
        label: "Hold Sched",
        description: "Hold schedule lane",
        parameters: obj({}),
        execute: async () => {
          gates.get("schedule")!.entered();
          await schedGate;
          return { content: [{ type: "text", text: "sched done" }], details: {} };
        },
      },
    ],
  });

  try {
    faux.setResponses([
      (ctx) => {
        const text = JSON.stringify(ctx);
        if (text.includes("run-fg")) return fauxAssistantMessage(fauxToolCall("hold_fg", {}), { stopReason: "toolUse" });
        if (text.includes("run-plugin")) return fauxAssistantMessage(fauxToolCall("hold_plugin", {}), { stopReason: "toolUse" });
        return fauxAssistantMessage(fauxToolCall("hold_sched", {}), { stopReason: "toolUse" });
      },
      (ctx) => {
        const text = JSON.stringify(ctx);
        if (text.includes("run-fg")) return fauxAssistantMessage(fauxToolCall("hold_fg", {}), { stopReason: "toolUse" });
        if (text.includes("run-plugin")) return fauxAssistantMessage(fauxToolCall("hold_plugin", {}), { stopReason: "toolUse" });
        return fauxAssistantMessage(fauxToolCall("hold_sched", {}), { stopReason: "toolUse" });
      },
      (ctx) => {
        const text = JSON.stringify(ctx);
        if (text.includes("run-fg")) return fauxAssistantMessage(fauxToolCall("hold_fg", {}), { stopReason: "toolUse" });
        if (text.includes("run-plugin")) return fauxAssistantMessage(fauxToolCall("hold_plugin", {}), { stopReason: "toolUse" });
        return fauxAssistantMessage(fauxToolCall("hold_sched", {}), { stopReason: "toolUse" });
      },
      fauxAssistantMessage("fg complete"),
      fauxAssistantMessage("plugin complete"),
      fauxAssistantMessage("sched complete"),
    ]);

    const pFg = executor.run("run-fg", { lane: "foreground", sessionId: "s_fg" });
    const pPlugin = executor.run("run-plugin", { lane: "plugin", sessionId: "s_plugin" });
    const pSched = executor.run("run-sched", { lane: "schedule", sessionId: "s_sched" });

    await Promise.all([started.get("foreground"), started.get("plugin"), started.get("schedule")]);

    // Second task on occupied lane rejects with ERR_AGENT_LANE_BUSY
    await assert.rejects(
      executor.run("run-fg-2", { lane: "foreground", sessionId: "s_fg2" }),
      (err: unknown) =>
        err instanceof AgentExecutionError &&
        err.stage === "agent.admission" &&
        err.code === "ERR_AGENT_LANE_BUSY",
    );
    await assert.rejects(
      executor.run("run-sched-2", { lane: "schedule", sessionId: "s_sched2" }),
      (err: unknown) =>
        err instanceof AgentExecutionError &&
        err.stage === "agent.admission" &&
        err.code === "ERR_AGENT_LANE_BUSY",
    );

    releaseFg();
    releasePlugin();
    releaseSched();
    const results = await Promise.all([pFg, pPlugin, pSched]);
    assert.equal(results.length, 3);
    assert.equal(executor.getTask(results[0].taskId)?.lane, "foreground");
    assert.equal(executor.getTask(results[1].taskId)?.lane, "plugin");
    assert.equal(executor.getTask(results[2].taskId)?.lane, "schedule");
  } finally {
    releaseFg();
    releasePlugin();
    releaseSched();
    await executor.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("executor rejects with ERR_AGENT_CAPACITY_REACHED when total concurrent limit is full across free lanes", async () => {
  const root = mkdtempSync(join(tmpdir(), "looi-capacity-"));
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);

  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((r) => { entered = r; });
  const gate = new Promise<void>((r) => { release = r; });

  const executor = new PiAgentExecutor({
    stateDirectory: join(root, "state"),
    workspaceRoot: join(root, "workspace"),
    modelsRegistry: models,
    modelSpec: faux.getModel(),
    streamFn: models.streamSimple.bind(models),
    maxConcurrentTasks: 1,
    customTools: [
      {
        name: "hold",
        label: "Hold",
        description: "Hold",
        parameters: obj({}),
        execute: async () => {
          entered();
          await gate;
          return { content: [{ type: "text", text: "ok" }], details: {} };
        },
      },
    ],
  });

  try {
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    const running = executor.run("hold", { lane: "foreground", sessionId: "s1" });
    await started;

    // Different lane ("schedule") is free, but total capacity=1 is full => ERR_AGENT_CAPACITY_REACHED
    await assert.rejects(
      executor.run("second", { lane: "schedule", sessionId: "s2" }),
      (err: unknown) =>
        err instanceof AgentExecutionError &&
        err.stage === "agent.admission" &&
        err.code === "ERR_AGENT_CAPACITY_REACHED",
    );

    release();
    await running;
  } finally {
    release();
    await executor.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("PiTaskRunner records redacted toolFailures and preserves real failure stages/codes instead of rewriting to timeout", async () => {
  const root = mkdtempSync(join(tmpdir(), "looi-failures-"));
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);

  const secretToken = "ghp_super_secret_token_999";
  const executor = new PiAgentExecutor({
    stateDirectory: join(root, "state"),
    workspaceRoot: join(root, "workspace"),
    modelsRegistry: models,
    modelSpec: faux.getModel(),
    streamFn: models.streamSimple.bind(models),
    apiKey: "llm_secret_key_abc",
    redactSecrets: (text) => text.replaceAll(secretToken, "[redacted]"),
    deadlineMs: 5000,
    customTools: [
      {
        name: "github_pr_status",
        label: "GitHub PR Status",
        description: "Query PR status",
        parameters: obj({}),
        execute: async () => ({
          isError: true,
          content: [{ type: "text", text: `401 with token ${secretToken}` }],
          details: {
            failure: {
              stage: "github.pr_status.pr",
              code: 401,
              reason: `Bad credentials for ${secretToken} and Bearer bearer_secret_xyz`,
            },
          },
        }),
      },
    ],
  });

  try {
    // 1. Tool failure capture & redaction
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("github_pr_status", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage("Reported 401"),
    ]);
    const res1 = await executor.run("check pr", { sessionId: "s_tool_fail" });
    assert.equal(res1.toolFailures?.length, 1);
    assert.deepEqual(res1.toolFailures?.[0], {
      callId: res1.toolFailures![0]!.callId,
      toolName: "github_pr_status",
      stage: "github.pr_status.pr",
      code: 401,
      reason: "Bad credentials for [redacted] and Bearer [redacted]",
    });

    // 2. Model HTTP 401 error preserves stage=agent.model & code=401 (NEVER timeout)
    faux.setResponses([
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "401 Incorrect API key provided: llm_secret_key_abc",
      }),
    ]);
    await assert.rejects(
      executor.run("ask model", { taskId: "task_model_401", sessionId: "s_model_401" }),
      (err: unknown) => {
        assert.ok(err instanceof AgentExecutionError);
        assert.equal(err.stage, "agent.model");
        assert.equal(err.code, 401);
        assert.ok(!err.message.includes("llm_secret_key_abc"));
        assert.ok(err.message.includes("[redacted]"));
        return true;
      },
    );
    const failedTask = executor.getTask("task_model_401");
    assert.equal(failedTask?.failure?.stage, "agent.model");
    assert.equal(failedTask?.failure?.code, 401);
  } finally {
    await executor.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("PiTaskRunner emits ERR_AGENT_DEADLINE_EXCEEDED only when deadlineMs timer actually expires", async () => {
  const root = mkdtempSync(join(tmpdir(), "looi-deadline-"));
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);

  const executor = new PiAgentExecutor({
    stateDirectory: join(root, "state"),
    workspaceRoot: join(root, "workspace"),
    modelsRegistry: models,
    modelSpec: faux.getModel(),
    streamFn: models.streamSimple.bind(models),
    deadlineMs: 30,
    stopGraceMs: 200,
    customTools: [
      {
        name: "slow_tool",
        label: "Slow",
        description: "Slow",
        parameters: obj({}),
        execute: async (_id, _args, signal) => {
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, 1000);
            signal?.addEventListener("abort", () => {
              clearTimeout(t);
              resolve();
            }, { once: true });
          });
          return { content: [{ type: "text", text: "aborted" }], details: {} };
        },
      },
    ],
  });

  try {
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("slow_tool", {}), { stopReason: "toolUse" }),
    ]);
    await assert.rejects(
      executor.run("run slow", { taskId: "task_deadline", sessionId: "s_deadline" }),
      (err: unknown) =>
        err instanceof AgentExecutionError &&
        err.stage === "agent.deadline" &&
        err.code === "ERR_AGENT_DEADLINE_EXCEEDED",
    );
  } finally {
    await executor.close();
    rmSync(root, { recursive: true, force: true });
  }
});
