import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { HubTaskSupervisor } from "../src/productivity/task-supervisor.js";
import { DshWorkspaceRunner } from "../src/productivity/dsh-runner.js";
import type { AgentExecutor } from "../src/agent/executor.js";
import {
  type TaskRequest,
  type ReadbackEvidence,
  type UserActionRef,
  type AclScope,
} from "@super-looi/contracts";

const defaultScope: AclScope = {
  household_id: "household_default",
  subject_id: null,
  project_id: "proj_island",
  audience: "project",
  acl_policy_id: "policy_project_default",
  acl_policy_revision: 1,
};

describe("Productivity Supervisor and DSH Runner (Phase 3)", () => {
  it("enforces client_request_id idempotency and deduplicates retried task submissions", async () => {
    const supervisor = new HubTaskSupervisor();

    const request: TaskRequest = {
      schema_version: "0.2",
      task_id: "task_build_game_1",
      client_request_id: "client_req_uuid_001",
      requested_by_principal_id: "user_dev",
      intent: "Build Godot Island Game Web export",
      scope: defaultScope,
      workspace_id: "ws_godot_island",
      executor_id: "dsh_runner",
      context_pack_id: "pack_init_1",
      requested_at: new Date().toISOString(),
      deadline_at: new Date(Date.now() + 3600000).toISOString(),
    };

    // First submission: brand new task
    const r1 = await supervisor.submitTask(request);
    assert.equal(r1.deduplicated, false);
    assert.equal(r1.task.task_id, "task_build_game_1");
    assert.equal(r1.latestEvent.state, "queued");
    assert.equal(r1.latestEvent.event_seq, 1);

    // Mobile client disconnects and retries with same client_request_id
    const r2 = await supervisor.submitTask({
      ...request,
      task_id: "task_build_game_DIFFERENT_ID_SHOULD_BE_IGNORED",
    });
    assert.equal(r2.deduplicated, true);
    assert.equal(r2.task.task_id, "task_build_game_1"); // Returns existing task ID!
    assert.equal(r2.latestEvent.event_seq, 1);

    const stats = supervisor.getStats();
    assert.equal(stats.totalTasks, 1);
  });

  it("supports cursor-based event resumption for reconnecting clients", async () => {
    const supervisor = new HubTaskSupervisor();

    const request: TaskRequest = {
      schema_version: "0.2",
      task_id: "task_seq_demo",
      client_request_id: "client_req_seq_1",
      requested_by_principal_id: "user_dev",
      intent: "Compile shaders",
      scope: defaultScope,
      workspace_id: "ws_shaders",
      executor_id: "dsh_runner",
      context_pack_id: "pack_shaders",
      requested_at: new Date().toISOString(),
      deadline_at: new Date(Date.now() + 3600000).toISOString(),
    };

    await supervisor.submitTask(request); // seq 1: queued
    await supervisor.transitionState("task_seq_demo", "running", "Compiling shader pass 1"); // seq 2
    await supervisor.transitionState("task_seq_demo", "awaiting_approval", "Shader cache clean needs approval"); // seq 3
    await supervisor.transitionState("task_seq_demo", "running", "Resumed after approval"); // seq 4

    // Client reconnects having seen seq 2: queries events since seq 2
    const resumeEvents = await supervisor.getTaskEvents("task_seq_demo", 2);
    assert.equal(resumeEvents.length, 2);
    assert.equal(resumeEvents[0].event_seq, 3);
    assert.equal(resumeEvents[0].state, "awaiting_approval");
    assert.equal(resumeEvents[1].event_seq, 4);
    assert.equal(resumeEvents[1].state, "running");

    // Querying since 0 returns all 4 events
    const allEvents = await supervisor.getTaskEvents("task_seq_demo", 0);
    assert.equal(allEvents.length, 4);
  });

  it("DshWorkspaceRunner: blocks unregistered workspaces and path traversal attempts", async () => {
    const supervisor = new HubTaskSupervisor();
    const runner = new DshWorkspaceRunner(supervisor);

    runner.registerWorkspace("ws_allowed", "/Users/dev/projects/game");

    // 1. Unregistered workspace
    const res1 = await runner.executeCommand({
      taskId: "t_test_1",
      workspaceId: "ws_unregistered",
      command: "ls -la",
    });
    assert.equal(res1.executionStatus, "rejected");
    assert.equal(res1.receipt?.reason_code, "unregistered_workspace");

    // 2. Path traversal attack
    const res2 = await runner.executeCommand({
      taskId: "t_test_2",
      workspaceId: "ws_allowed",
      command: "cat ../../../etc/passwd",
    });
    assert.equal(res2.executionStatus, "rejected");
    assert.equal(res2.receipt?.reason_code, "path_traversal_forbidden");
  });

  it("DshWorkspaceRunner: intercepts high-risk commands and resumes only with valid UserActionRef approval", async () => {
    const supervisor = new HubTaskSupervisor();
    const executor: AgentExecutor = {
      run: async (_prompt, options) => ({ taskId: options!.taskId!, sessionId: "test-session", answer: "fixture completed", steps: [], toolCallsCount: 1, durationMs: 1, finishReason: "completed", runtimeExited: true, executions: [{ callId: "fixture", command: "rm -rf dist/ && git clean -fd", exitCode: 0, signal: null, timedOut: false, aborted: false }] }),
      getTask: () => undefined, listTasks: () => [], respond: () => {}, cancel: async () => ({ state: "cancelled", confirmed: true, runtimeExited: true }), close: async () => {},
    };
    const runner = new DshWorkspaceRunner(supervisor, executor);

    runner.registerWorkspace("ws_repo", "/Users/dev/projects/repo");

    await supervisor.submitTask({
      schema_version: "0.2",
      task_id: "task_risk_test",
      client_request_id: "req_risk_1",
      requested_by_principal_id: "user_dev",
      intent: "Force clean build directory",
      scope: defaultScope,
      workspace_id: "ws_repo",
      executor_id: "dsh_runner",
      context_pack_id: "pack_1",
      requested_at: new Date().toISOString(),
      deadline_at: new Date(Date.now() + 3600000).toISOString(),
    });

    // Attempt high-risk command: rm -rf dist/
    const res = await runner.executeCommand({
      taskId: "task_risk_test",
      workspaceId: "ws_repo",
      command: "rm -rf dist/ && git clean -fd",
    });

    assert.equal(res.executionStatus, "awaiting_approval");
    assert.ok(res.grantId);

    const taskStatus = await supervisor.getTaskStatus("task_risk_test");
    assert.equal(taskStatus?.state, "awaiting_approval");

    // User approves in mobile UI via explicit tap action
    const userAction: UserActionRef = {
      event_id: "evt_tap_confirm_99",
      ui_session_id: "sess_mobile_ui",
      kind: "tap",
      captured_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 300000).toISOString(),
    };

    const approvalResult = await supervisor.approveTaskAction(
      "task_risk_test",
      res.grantId,
      userAction
    );
    assert.equal(approvalResult.event.state, "running");

    // Re-execute command with approved grant ID -> completes successfully!
    const resApproved = await runner.executeCommand({
      taskId: "task_risk_test",
      workspaceId: "ws_repo",
      command: "rm -rf dist/ && git clean -fd",
      approvedGrantId: res.grantId,
    });
    assert.equal(resApproved.executionStatus, "completed");
    assert.equal(resApproved.receipt?.status, "verified");
  });

  it("requires ReadbackEvidence to transition task to succeeded", async () => {
    const supervisor = new HubTaskSupervisor();

    await supervisor.submitTask({
      schema_version: "0.2",
      task_id: "task_verify_artifact",
      client_request_id: "req_art_1",
      requested_by_principal_id: "user_dev",
      intent: "Export HTML5 build",
      scope: defaultScope,
      workspace_id: "ws_repo",
      executor_id: "dsh_runner",
      context_pack_id: "pack_1",
      requested_at: new Date().toISOString(),
      deadline_at: new Date(Date.now() + 3600000).toISOString(),
    });

    // Fails without readback evidence
    await assert.rejects(
      async () => {
        await supervisor.verifyArtifactsAndComplete(
          "task_verify_artifact",
          [{ artifactId: "art_html5_zip", relativePath: "dist/game.zip", contentHash: "sha256_zip" }],
          [] // Empty readbacks
        );
      },
      /missing verified artifact_probe or runner_exit/
    );

    // Succeeds when valid readback evidence is provided
    const readbacks: ReadbackEvidence[] = [
      {
        kind: "artifact_probe",
        evidence_ids: ["ev_probe_zip_100"],
        observed_at: new Date().toISOString(),
        received_at: new Date().toISOString(),
        state_version: "file_exists",
        value: { size_bytes: 4096123, mime_type: "application/zip" },
      },
    ];

    const completeResult = await supervisor.verifyArtifactsAndComplete(
      "task_verify_artifact",
      [{ artifactId: "art_html5_zip", relativePath: "dist/game.zip", contentHash: "sha256_zip" }],
      readbacks
    );

    assert.equal(completeResult.event.state, "succeeded");
    assert.equal(completeResult.receipt.status, "verified");
    assert.equal(completeResult.event.artifact_refs.length, 1);
  });

  it("Honest Cancellation: transitions to confirmed cancelled when exit is verified, and to unknown when transport is lost", async () => {
    const supervisor = new HubTaskSupervisor();
    const runner = new DshWorkspaceRunner(supervisor);
    runner.registerWorkspace("ws_repo", "/Users/dev/projects/repo");

    // Case 1: Normal clean cancellation
    await supervisor.submitTask({
      schema_version: "0.2",
      task_id: "task_cancel_clean",
      client_request_id: "req_cancel_clean",
      requested_by_principal_id: "user_dev",
      intent: "Long running test suite",
      scope: defaultScope,
      workspace_id: "ws_repo",
      executor_id: "dsh_runner",
      context_pack_id: "pack_1",
      requested_at: new Date().toISOString(),
      deadline_at: new Date(Date.now() + 3600000).toISOString(),
    });

    const receipt1 = await runner.cancelTaskExecution("task_cancel_clean", "User stopped manually");
    assert.equal(receipt1.status, "verified");

    const event1 = await supervisor.getTaskStatus("task_cancel_clean");
    assert.equal(event1?.state, "cancelled");
    assert.equal(event1?.cancellation.phase, "confirmed");

    // Case 2: Transport lost / SSH disconnected during cancellation
    await supervisor.submitTask({
      schema_version: "0.2",
      task_id: "task_cancel_lost",
      client_request_id: "req_cancel_lost",
      requested_by_principal_id: "user_dev",
      intent: "Remote GPU model training",
      scope: defaultScope,
      workspace_id: "ws_repo",
      executor_id: "dsh_runner",
      context_pack_id: "pack_2",
      requested_at: new Date().toISOString(),
      deadline_at: new Date(Date.now() + 3600000).toISOString(),
    });

    await supervisor.transitionState("task_cancel_lost", "running", "Remote job has no owned runtime handle");

    const receipt2 = await runner.cancelTaskExecution("task_cancel_lost", "User emergency cancel");
    assert.equal(receipt2.status, "unknown");

    const event2 = await supervisor.getTaskStatus("task_cancel_lost");
    assert.equal(event2?.state, "unknown");
    assert.equal(event2?.cancellation.phase, "unknown");
    assert.equal(event2?.uncertainty_reason, "stop_unconfirmed");
    assert.equal(event2?.summary, "停止请求已发出，远端进程终态待核实");
  });
});
