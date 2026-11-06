import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Id, ActionReceipt, TaskRequest, ReadbackEvidence } from "@super-looi/contracts";
import type { HubTaskSupervisor } from "./task-supervisor.js";
import type { AgentExecutor } from "../agent/executor.js";

export interface CommandExecutionResult {
  executionStatus: "completed" | "awaiting_approval" | "rejected" | "failed";
  receipt?: ActionReceipt;
  grantId?: Id;
  output?: string;
  rejectionReason?: string;
}

const HIGH_RISK = [/rm\s+-rf/i, /git\s+push\s+.*--force/i, /\bdd\b/i, /\bmkfs\b/i, /\bsudo\b/i, />\s*\/dev\//i];

/** Product adapter; actual execution belongs to the official Harness. */
export class DshWorkspaceRunner {
  private readonly workspaces = new Map<Id, string>();
  private readonly grants = new Map<string, { taskId: string; command: string; workspaceId: string }>();
  constructor(private readonly supervisor: HubTaskSupervisor, private readonly executor?: AgentExecutor) {}
  registerWorkspace(id: Id, rootPath: string): void { this.workspaces.set(id, path.resolve(rootPath)); }
  getWorkspace(id: Id): string | undefined { return this.workspaces.get(id); }

  async continueApprovedCommand(taskId: string, grantId: string): Promise<CommandExecutionResult> {
    const pending = this.grants.get(grantId);
    if (!pending || pending.taskId !== taskId) throw new Error("No pending command for this grant");
    return this.executeCommand({ ...pending, approvedGrantId: grantId });
  }

  async resumeTask(task: TaskRequest, prompt: string): Promise<CommandExecutionResult> {
    const runtime = this.executor?.getTask(task.task_id);
    if (!runtime) throw new Error("Persisted DSH session not found");
    return this.execute(task.task_id, runtime.workspaceRoot, prompt, undefined, true);
  }

  async executeCommand(params: { taskId: Id; workspaceId: Id; command: string; approvedGrantId?: Id }): Promise<CommandExecutionResult> {
    const root = this.workspaces.get(params.workspaceId);
    if (!root) return this.reject(params.taskId, "unregistered_workspace");
    if (params.command.includes("../") || params.command.includes("..\\")) return this.reject(params.taskId, "path_traversal_forbidden");
    if (HIGH_RISK.some(pattern => pattern.test(params.command))) {
      if (!params.approvedGrantId) {
        const grant = await this.supervisor.issueActionGrant(params.taskId, {
          issued_by_principal_id: "system_policy_gate", executor_id: "dsh_runner",
          trigger: { kind: "authorized_rule", rule_id: "rule_high_risk_gate", rule_revision: 1, trigger_event_id: `evt_${randomUUID()}` },
          scope: { household_id: "household_default", subject_id: null, project_id: params.workspaceId, audience: "project", acl_policy_id: "policy_project_default", acl_policy_revision: 1 },
          not_before: new Date().toISOString(), expires_at: new Date(Date.now() + 600000).toISOString(), max_uses: 1,
        });
        this.grants.set(grant.grant_id, { taskId: params.taskId, command: params.command, workspaceId: params.workspaceId });
        await this.supervisor.transitionState(params.taskId, "awaiting_approval", "Command requires explicit user approval");
        return { executionStatus: "awaiting_approval", grantId: grant.grant_id };
      }
      const scope = this.grants.get(params.approvedGrantId);
      if (!scope || scope.taskId !== params.taskId || scope.command !== params.command || scope.workspaceId !== params.workspaceId) return this.reject(params.taskId, "grant_scope_mismatch");
      try { this.supervisor.consumeActionGrant(params.taskId, params.approvedGrantId); }
      catch { return this.reject(params.taskId, "grant_not_approved_or_expired"); }
      this.grants.delete(params.approvedGrantId);
    }
    return this.execute(params.taskId, root, `请使用官方 shell 工具执行以下用户指定命令，检查真实结果并报告失败；不要改写命令或启动后台作业：\n${params.command}`, params.command);
  }

  async executeTask(task: TaskRequest): Promise<CommandExecutionResult> {
    const root = task.workspace_id ? this.workspaces.get(task.workspace_id) : undefined;
    if (!root) return this.reject(task.task_id, "unregistered_workspace");
    return this.execute(task.task_id, root, task.intent);
  }

  private async execute(taskId: string, root: string, prompt: string, requiredCommand?: string, resume = false): Promise<CommandExecutionResult> {
    if (!this.executor) return { executionStatus: "failed", rejectionReason: "Official DSH executor is not configured" };
    try {
      await this.supervisor.transitionState(taskId, "running", "Official DSH worker starting");
      const result = await this.executor.run(prompt, { taskId, workspaceRoot: root, mode: "text", resume, onStep: step => {
        const state = step.phase === "awaiting_approval" || step.phase === "awaiting_input" ? "awaiting_approval" : "running";
        if (step.phase !== "done" && step.phase !== "error") void this.supervisor.transitionState(taskId, state, step.summary);
      } });
      const executions = (result.executions ?? []).filter(item => !requiredCommand || item.command === requiredCommand);
      if (requiredCommand && !executions.some(item => item.exitCode === 0 && !item.timedOut && !item.aborted && !item.signal)) throw new Error("Command did not produce a matching successful exit receipt");
      if (executions.some(item => item.exitCode !== 0 || item.timedOut || item.aborted || item.signal)) throw new Error("Command execution failed; see actual exit receipt");
      if (!executions.length && !result.artifacts?.length) throw new Error("No command exit or artifact readback was verified");
      const readbacks: ReadbackEvidence[] = executions.map(item => ({
        kind: "runner_exit", evidence_ids: [`ev_dsh_${result.sessionId}_${item.callId}`], observed_at: new Date().toISOString(), received_at: new Date().toISOString(),
        state_version: "official-tool-canonical-result", value: { exit_code: item.exitCode, timed_out: item.timedOut, aborted: item.aborted, session_id: result.sessionId },
      }));
      if (result.artifacts?.length) readbacks.push({ kind: "artifact_probe", evidence_ids: [`ev_files_${result.sessionId}`], observed_at: new Date().toISOString(), received_at: new Date().toISOString(), state_version: "sha256", value: { files: result.artifacts } });
      const { receipt } = await this.supervisor.verifyArtifactsAndComplete(taskId, (result.artifacts ?? []).map(item => ({ artifactId: `artifact_${item.sha256}`, relativePath: item.path, contentHash: item.sha256 })), readbacks);
      return { executionStatus: "completed", receipt, output: result.answer };
    } catch (error) {
      const task = this.executor.getTask(taskId);
      if (task?.state === "cancelled" || task?.state === "unknown") {
        const state = await this.supervisor.getTaskStatus(taskId);
        if (state?.state !== "cancelled" && state?.state !== "unknown") {
          await this.supervisor.requestCancel(taskId);
          await this.supervisor.confirmCancel(taskId, { confirmed: task.state === "cancelled", terminationEvidenceIds: task.state === "cancelled" ? [`ev_dsh_closed_${taskId}`] : undefined });
        }
      } else await this.supervisor.transitionState(taskId, "failed", (error as Error).message);
      return { executionStatus: "failed", rejectionReason: (error as Error).message };
    }
  }

  private reject(taskId: string, reason: string): CommandExecutionResult {
    return { executionStatus: "rejected", rejectionReason: reason, receipt: {
      schema_version: "0.2", receipt_id: `rcpt_${randomUUID()}`, action_id: `act_${taskId}`, task_id: taskId, receipt_seq: 1,
      executor_id: "dsh_runner", recorded_at: new Date().toISOString(), status: "rejected", reason_code: reason, readbacks: [],
    } };
  }

  async cancelTaskExecution(taskId: Id, reason = "User requested cancellation"): Promise<ActionReceipt> {
    const current = await this.supervisor.getTaskStatus(taskId);
    if (!current) throw new Error("Task not found");
    if (["succeeded", "failed", "cancelled"].includes(current.state)) throw new Error("Task has already ended");
    await this.supervisor.requestCancel(taskId, reason);
    const runtimeTask = this.executor?.getTask(taskId);
    const stopped = runtimeTask ? await this.executor!.cancel(taskId) : { confirmed: current.state === "queued", runtimeExited: false };
    const confirmed = stopped.confirmed;
    const ids = confirmed ? [`ev_stop_${randomUUID()}`] : [];
    await this.supervisor.confirmCancel(taskId, { confirmed, terminationEvidenceIds: ids });
    return {
      schema_version: "0.2", receipt_id: `rcpt_cancel_${randomUUID()}`, action_id: `cancel_${taskId}`, task_id: taskId, receipt_seq: 1,
      executor_id: "dsh_runner", recorded_at: new Date().toISOString(), status: confirmed ? "verified" : "unknown", outcome: confirmed ? "applied" : undefined,
      reason_code: confirmed ? undefined : "stop_unconfirmed", readbacks: confirmed ? [{
        kind: "runner_exit", evidence_ids: ids, observed_at: new Date().toISOString(), received_at: new Date().toISOString(),
        state_version: stopped.runtimeExited ? "runtime-closed" : "not-started", value: { runtime_exited: stopped.runtimeExited, execution_never_started: !stopped.runtimeExited },
      }] : [],
    };
  }
}
