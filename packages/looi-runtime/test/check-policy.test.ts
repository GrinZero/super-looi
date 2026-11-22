import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  getCurrentTools,
  resolveTranscript,
} from "@earendil-works/pi-ai";
import { obj, str } from "@earendil-works/pi-schema";
import { PiAgentExecutor } from "../src/agent/pi-executor.js";
import {
  CHECK_ONLY_ALLOWED_TOOLS,
  evaluateScheduledToolPolicy,
} from "../src/schedule/check-policy.js";

test("evaluateScheduledToolPolicy enforces fail-closed check_only allowlist, workspace confinement, and manage_schedule list-only", () => {
  const root = mkdtempSync(join(tmpdir(), "looi-policy-unit-"));
  const workspaceRoot = join(root, "workspace");
  const outsideDir = join(root, "outside");
  mkdirSync(workspaceRoot, { recursive: true });
  mkdirSync(outsideDir, { recursive: true });
  writeFileSync(join(workspaceRoot, "notes.txt"), "inside");
  writeFileSync(join(outsideDir, "secret.txt"), "outside");
  symlinkSync(outsideDir, join(workspaceRoot, "escape-link"));

  try {
    for (const toolName of CHECK_ONLY_ALLOWED_TOOLS) {
      const args: Record<string, unknown> =
        toolName === "manage_schedule"
          ? { action: "list" }
          : ["read", "read_file", "ls", "find", "grep"].includes(toolName)
            ? { path: "notes.txt" }
            : {};
      const decision = evaluateScheduledToolPolicy({
        policy: "check_only",
        toolName,
        arguments: args,
        workspaceRoot,
      });
      assert.deepEqual(decision, { decision: "allow", sideEffect: false }, toolName);
    }

    // Optional path omitted for ls/find/grep is inside workspaceRoot; required for read/read_file.
    for (const toolName of ["ls", "find", "grep"]) {
      assert.equal(
        evaluateScheduledToolPolicy({
          policy: "check_only",
          toolName,
          arguments: { pattern: "foo" },
          workspaceRoot,
        }).decision,
        "allow",
      );
    }
    assert.equal(
      evaluateScheduledToolPolicy({
        policy: "check_only",
        toolName: "read",
        arguments: {},
        workspaceRoot,
      }).decision,
      "deny",
    );

    // Out-of-workspace reads, symlinks, @ prefix, ~ expansion, file:// URLs, and Unicode space variants are denied.
    for (const badPath of [
      "/etc/passwd",
      "../outside/secret.txt",
      "escape-link/secret.txt",
      "@/etc/passwd",
      "~/secret",
      "@~/secret",
      "file:///etc/passwd",
      "file://localhost/etc/passwd",
      "@file:///etc/passwd",
      "~/\u202Fsecret",
    ]) {
      for (const toolName of ["read", "read_file", "ls", "find", "grep"]) {
        const decision = evaluateScheduledToolPolicy({
          policy: "check_only",
          toolName,
          arguments: { path: badPath },
          workspaceRoot,
        });
        assert.equal(decision.decision, "deny", `${toolName}:${badPath}`);
        if (decision.decision === "deny") {
          assert.equal(decision.stage, "schedule.policy");
          assert.equal(decision.code, "ERR_SCHEDULE_CHECK_ONLY_TOOL_DENIED");
        }
      }
    }

    // Non-list manage_schedule and all write/exec tools are denied.
    for (const action of ["create", "update", "cancel", "run_now", undefined]) {
      const decision = evaluateScheduledToolPolicy({
        policy: "check_only",
        toolName: "manage_schedule",
        arguments: action ? { action } : {},
        workspaceRoot,
      });
      assert.equal(decision.decision, "deny");
      if (decision.decision === "deny") {
        assert.equal(decision.code, "ERR_SCHEDULE_CHECK_ONLY_TOOL_DENIED");
      }
    }

    for (const forbidden of [
      "bash",
      "write",
      "write_file",
      "edit",
      "powershell",
      "codemode",
      "tool_search",
      "mcp__github",
      "ask_user_question",
      "codex_exec",
      "codex_cloud",
      "control_home_device",
      "control_looi_body",
      "manage_quiet_hours",
    ]) {
      const decision = evaluateScheduledToolPolicy({
        policy: "check_only",
        toolName: forbidden,
        arguments: {},
        workspaceRoot,
      });
      assert.equal(decision.decision, "deny", forbidden);
      if (decision.decision === "deny") {
        assert.equal(decision.stage, "schedule.policy");
        assert.equal(decision.code, "ERR_SCHEDULE_CHECK_ONLY_TOOL_DENIED");
      }
    }

    // authorized_action permits tools and flags side-effect calls accurately.
    assert.deepEqual(
      evaluateScheduledToolPolicy({
        policy: "authorized_action",
        toolName: "bash",
        arguments: { command: "echo hi" },
        workspaceRoot,
      }),
      { decision: "allow", sideEffect: true },
    );
    assert.deepEqual(
      evaluateScheduledToolPolicy({
        policy: "authorized_action",
        toolName: "github_pr_status",
        arguments: { owner: "a", repo: "b", pullNumber: 1 },
        workspaceRoot,
      }),
      { decision: "allow", sideEffect: false },
    );
    assert.deepEqual(
      evaluateScheduledToolPolicy({
        policy: "authorized_action",
        toolName: "manage_schedule",
        arguments: { action: "list" },
        workspaceRoot,
      }),
      { decision: "allow", sideEffect: false },
    );
    assert.deepEqual(
      evaluateScheduledToolPolicy({
        policy: "authorized_action",
        toolName: "manage_schedule",
        arguments: { action: "create" },
        workspaceRoot,
      }),
      { decision: "allow", sideEffect: true },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("check_only Pi session strips bash/write/edit/codemode/mcp/ask_user_question and blocks out-of-workspace reads without prompting", async () => {
  const root = mkdtempSync(join(tmpdir(), "looi-check-session-"));
  const workspaceRoot = join(root, "workspace");
  mkdirSync(workspaceRoot, { recursive: true });
  writeFileSync(join(workspaceRoot, "allowed.txt"), "safe-content");
  writeFileSync(join(root, "secret.txt"), "secret-outside");

  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);

  const taskToolPolicies: Array<string | undefined> = [];
  const beforeToolPolicies: Array<string | undefined> = [];
  let approvalPrompts = 0;

  const executor = new PiAgentExecutor({
    stateDirectory: join(root, "state"),
    workspaceRoot,
    modelsRegistry: models,
    modelSpec: faux.getModel(),
    streamFn: models.streamSimple.bind(models),
    taskTools: (ctx) => {
      taskToolPolicies.push(ctx.scheduleExecutionPolicy);
      return {
        tools: [
          {
            name: "codex_exec",
            label: "Codex Exec",
            description: "Write capable agent",
            parameters: obj({}),
            execute: async () => ({ content: [{ type: "text", text: "mutated" }], details: {} }),
          },
          {
            name: "codex_cloud_status",
            label: "Codex Cloud Status",
            description: "Read-only cloud status",
            parameters: obj({ taskId: str() }),
            execute: async () => ({ content: [{ type: "text", text: "running" }], details: {} }),
          },
        ],
      };
    },
    beforeToolCall: (ctx) => {
      beforeToolPolicies.push(ctx.scheduleExecutionPolicy);
      return undefined;
    },
    additionalTools: [
      {
        name: "control_home_device",
        label: "Control Home",
        description: "Mutate home appliance",
        parameters: obj({}),
        execute: async () => ({ content: [{ type: "text", text: "toggled" }], details: {} }),
      },
      {
        name: "manage_schedule",
        label: "Manage Schedule",
        description: "Manage schedule rules",
        parameters: obj({ action: str() }),
        execute: async (_id, params) => ({
          content: [{ type: "text", text: `action=${params.action}` }],
          details: {},
        }),
      },
    ],
  });

  try {
    let declaredToolNames: string[] = [];
    faux.setResponses([
      (ctx) => {
        const transcript = resolveTranscript(ctx, undefined);
        declaredToolNames = getCurrentTools(transcript.messages).map((t) => t.name);
        return fauxAssistantMessage(
          fauxToolCall("read", { path: "../secret.txt" }),
          { stopReason: "toolUse" },
        );
      },
      fauxAssistantMessage(
        fauxToolCall("read", { path: "@/etc/passwd" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        fauxToolCall("read", { path: "~/secret" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        fauxToolCall("read", { path: "@~/secret" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        fauxToolCall("read", { path: "file:///etc/passwd" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        fauxToolCall("manage_schedule", { action: "create" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        fauxToolCall("read", { path: "allowed.txt" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("Checked safely"),
    ]);

    const result = await executor.run("Check workspace safely", {
      lane: "schedule",
      sessionId: "sched_isolation_1",
      scheduleExecutionPolicy: "check_only",
      approvalMode: "ask",
      onStep: (event) => {
        if (event.phase === "awaiting_approval" || event.phase === "awaiting_input") {
          approvalPrompts++;
        }
      },
    });

    assert.equal(result.answer, "Checked safely");
    assert.equal(approvalPrompts, 0);
    assert.deepEqual(taskToolPolicies, ["check_only"]);
    assert.deepEqual(beforeToolPolicies, ["check_only"]);

    // Layer 1 check: dangerous/write tools & extensions completely omitted from model tool declarations.
    for (const forbidden of [
      "bash",
      "write",
      "edit",
      "powershell",
      "codemode",
      "tool_search",
      "ask_user_question",
      "codex_exec",
      "control_home_device",
    ]) {
      assert.ok(!declaredToolNames.includes(forbidden), `Forbidden tool ${forbidden} leaked into check_only session`);
    }
    for (const expected of ["read", "sessions", "codex_cloud_status", "manage_schedule"]) {
      assert.ok(declaredToolNames.includes(expected), `Expected tool ${expected} missing from check_only session`);
    }

    // Layer 2 check: all out-of-workspace reads (@, ~, file://, ..) and non-list manage_schedule were blocked with exact code.
    assert.equal(result.toolFailures?.length, 6);
    for (let i = 0; i < 5; i++) {
      assert.equal(result.toolFailures?.[i]?.toolName, "read");
      assert.equal(result.toolFailures?.[i]?.stage, "schedule.policy");
      assert.equal(result.toolFailures?.[i]?.code, "ERR_SCHEDULE_CHECK_ONLY_TOOL_DENIED");
    }
    assert.equal(result.toolFailures?.[5]?.toolName, "manage_schedule");
    assert.equal(result.toolFailures?.[5]?.code, "ERR_SCHEDULE_CHECK_ONLY_TOOL_DENIED");
  } finally {
    await executor.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("authorized_action fires onSideEffectBeforeExecute synchronously only after approval succeeds", async () => {
  const root = mkdtempSync(join(tmpdir(), "looi-auth-action-"));
  const workspaceRoot = join(root, "workspace");
  mkdirSync(workspaceRoot, { recursive: true });

  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);

  const executor = new PiAgentExecutor({
    stateDirectory: join(root, "state"),
    workspaceRoot,
    modelsRegistry: models,
    modelSpec: faux.getModel(),
    streamFn: models.streamSimple.bind(models),
    requireApprovalForAllWrites: true,
  });

  try {
    // Case 1: Rejected approval must NOT fire onSideEffectBeforeExecute.
    let sideEffectCalls = 0;
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("write", { path: "a.txt", content: "hi" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("Rejected cleanly"),
    ]);
    await executor.run("Write a.txt", {
      lane: "schedule",
      sessionId: "sched_auth_reject",
      scheduleExecutionPolicy: "authorized_action",
      approvalMode: "ask",
      onSideEffectBeforeExecute: () => {
        sideEffectCalls++;
      },
      onStep: (event) => {
        if (event.interaction?.kind === "approval") {
          executor.respond(event.taskId!, event.interaction.id, { outcome: "rejected" });
        }
      },
    });
    assert.equal(sideEffectCalls, 0);

    // Case 2: Allowed approval fires onSideEffectBeforeExecute synchronously before write touches disk.
    const eventsOrder: string[] = [];
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("read", { path: "." }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("write", { path: "b.txt", content: "ok" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("Written"),
    ]);
    await executor.run("Write b.txt", {
      lane: "schedule",
      sessionId: "sched_auth_allow",
      scheduleExecutionPolicy: "authorized_action",
      approvalMode: "ask",
      onSideEffectBeforeExecute: () => {
        assert.equal(existsSync(join(workspaceRoot, "b.txt")), false);
        eventsOrder.push("side_effect_recorded");
      },
      onStep: (event) => {
        if (event.interaction?.kind === "approval") {
          eventsOrder.push("approval_requested");
          executor.respond(event.taskId!, event.interaction.id, { outcome: "allowed-once" });
        } else if (event.phase === "tool_end" && event.toolName === "write") {
          eventsOrder.push("write_finished");
        }
      },
    });
    assert.equal(existsSync(join(workspaceRoot, "b.txt")), true);
    assert.deepEqual(eventsOrder, [
      "approval_requested",
      "side_effect_recorded",
      "write_finished",
    ]);
  } finally {
    await executor.close();
    rmSync(root, { recursive: true, force: true });
  }
});
