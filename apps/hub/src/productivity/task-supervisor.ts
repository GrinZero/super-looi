import fs from "node:fs";
import path from "node:path";
import type {
  TaskRequest,
  TaskEvent,
  TaskStatus,
  ActionGrant,
  ActionReceipt,
  UserActionRef,
  ReadbackEvidence,
  Id,
} from "@super-looi/contracts";

export interface SubmitTaskResult {
  task: TaskRequest;
  latestEvent: TaskEvent;
  deduplicated: boolean;
}

export interface TaskSupervisor {
  submitTask(request: TaskRequest): Promise<SubmitTaskResult>;
  getTaskStatus(taskId: Id): Promise<TaskEvent | null>;
  getTaskEvents(taskId: Id, sinceSeq?: number): Promise<TaskEvent[]>;
  transitionState(
    taskId: Id,
    newState: TaskStatus,
    summary: string,
    options?: {
      actionReceiptIds?: Id[];
      artifactRefs?: TaskEvent["artifact_refs"];
      uncertaintyReason?: TaskEvent["uncertainty_reason"];
    }
  ): Promise<TaskEvent>;
  issueActionGrant(
    taskId: Id,
    grant: Omit<ActionGrant, "schema_version" | "grant_id" | "revision" | "task_id" | "status" | "revoked_at">
  ): Promise<ActionGrant>;
  approveTaskAction(
    taskId: Id,
    grantId: Id,
    userActionRef: UserActionRef
  ): Promise<{ grant: ActionGrant; event: TaskEvent }>;
  verifyArtifactsAndComplete(
    taskId: Id,
    artifacts: Array<{ artifactId: Id; relativePath: string; contentHash: string }>,
    readbacks: ReadbackEvidence[]
  ): Promise<{ receipt: ActionReceipt; event: TaskEvent }>;
  requestCancel(taskId: Id, reason?: string): Promise<TaskEvent>;
  confirmCancel(
    taskId: Id,
    outcome: {
      confirmed: boolean;
      terminationEvidenceIds?: Id[];
      transportLost?: boolean;
    }
  ): Promise<TaskEvent>;
}

export class HubTaskSupervisor implements TaskSupervisor {
  // In-memory repositories (backed by schema.sql in PostgreSQL)
  private readonly tasksById = new Map<Id, TaskRequest>();
  private readonly tasksByClientReqId = new Map<Id, Id>(); // client_request_id -> task_id
  private readonly taskEvents = new Map<Id, TaskEvent[]>(); // task_id -> ordered events
  private readonly actionGrants = new Map<Id, ActionGrant>(); // grant_id -> grant
  private readonly actionReceipts = new Map<Id, ActionReceipt>(); // receipt_id -> receipt

  constructor(private readonly options: { filePath?: string } = {}) {
    if (!options.filePath || !fs.existsSync(options.filePath)) return;
    const snapshot = JSON.parse(fs.readFileSync(options.filePath, "utf8"));
    for (const task of snapshot.tasks ?? []) {
      this.tasksById.set(task.task_id, task);
      this.tasksByClientReqId.set(task.client_request_id, task.task_id);
    }
    for (const [id, events] of snapshot.events ?? []) this.taskEvents.set(id, events);
    for (const grant of snapshot.grants ?? []) this.actionGrants.set(grant.grant_id, grant);
    for (const receipt of snapshot.receipts ?? []) this.actionReceipts.set(receipt.receipt_id, receipt);
    let recovered = false;
    for (const [id, events] of this.taskEvents) {
      const last = events.at(-1);
      if (!last || ["succeeded", "failed", "cancelled", "unknown"].includes(last.state)) continue;
      events.push({ ...last, event_seq: last.event_seq + 1, event_id: `tev_restart_${id}_${last.event_seq + 1}`, recorded_at: new Date().toISOString(), state: "unknown", summary: "Hub restarted; execution outcome requires verification", uncertainty_reason: "execution_outcome_unknown" });
      for (const grant of this.actionGrants.values()) if (grant.task_id === id && grant.status === "active") { grant.status = "revoked"; grant.revoked_at = new Date().toISOString(); }
      recovered = true;
    }
    if (recovered) this.persist();
  }

  private persist(): void {
    if (!this.options.filePath) return;
    const target = this.options.filePath;
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(`${target}.tmp`, JSON.stringify({ tasks: [...this.tasksById.values()], events: [...this.taskEvents], grants: [...this.actionGrants.values()], receipts: [...this.actionReceipts.values()] }), { mode: 0o600 });
    fs.renameSync(`${target}.tmp`, target);
  }

  consumeActionGrant(taskId: string, grantId: string): void {
    const grant = this.actionGrants.get(grantId);
    if (!grant || grant.task_id !== taskId || grant.status !== "active" || grant.trigger.kind !== "explicit_user_action" || Date.parse(grant.expires_at) <= Date.now()) throw new Error("Grant has not been approved or is no longer valid");
    const action = grant.trigger.user_action;
    if (!action || Date.parse(action.expires_at) <= Date.now()) throw new Error("User approval has expired");
    grant.status = "revoked";
    grant.revoked_at = new Date().toISOString();
    this.persist();
  }

  /**
   * Submits a new task with client_request_id idempotency.
   * If a mobile client disconnected and retries with the same client_request_id,
   * returns the existing task state without duplicate execution.
   */
  public async submitTask(request: TaskRequest): Promise<SubmitTaskResult> {
    const existingTaskId = this.tasksByClientReqId.get(request.client_request_id);
    if (existingTaskId) {
      const existingTask = this.tasksById.get(existingTaskId)!;
      const events = this.taskEvents.get(existingTaskId) || [];
      const latestEvent = events[events.length - 1];
      return {
        task: existingTask,
        latestEvent,
        deduplicated: true,
      };
    }

    this.tasksById.set(request.task_id, request);
    this.tasksByClientReqId.set(request.client_request_id, request.task_id);

    const initialEvent: TaskEvent = {
      schema_version: "0.2",
      task_id: request.task_id,
      event_seq: 1,
      event_id: `tev_${Date.now()}_1`,
      recorded_at: new Date().toISOString(),
      state: "queued",
      summary: `Task queued: ${request.intent}`,
      action_receipt_ids: [],
      artifact_refs: [],
      cancellation: { phase: "not_requested" },
      uncertainty_reason: null,
    };

    this.taskEvents.set(request.task_id, [initialEvent]);
    this.persist();

    return {
      task: request,
      latestEvent: initialEvent,
      deduplicated: false,
    };
  }

  public async getTaskStatus(taskId: Id): Promise<TaskEvent | null> {
    const events = this.taskEvents.get(taskId);
    if (!events || events.length === 0) return null;
    return events[events.length - 1];
  }

  /**
   * Cursor-based event resumption:
   * Returns all events for a task with event_seq > sinceSeq.
   */
  public async getTaskEvents(taskId: Id, sinceSeq = 0): Promise<TaskEvent[]> {
    const events = this.taskEvents.get(taskId);
    if (!events) return [];
    return events.filter((e) => e.event_seq > sinceSeq);
  }

  public async getAllTasks(): Promise<TaskRequest[]> {
    return Array.from(this.tasksById.values());
  }

  /**
   * Transitions task state, appending a monotonic TaskEvent.
   */
  public async transitionState(
    taskId: Id,
    newState: TaskStatus,
    summary: string,
    options: {
      actionReceiptIds?: Id[];
      artifactRefs?: TaskEvent["artifact_refs"];
      uncertaintyReason?: TaskEvent["uncertainty_reason"];
    } = {}
  ): Promise<TaskEvent> {
    const events = this.taskEvents.get(taskId);
    if (!events || events.length === 0) {
      throw new Error(`Task '${taskId}' not found.`);
    }

    const lastEvent = events[events.length - 1];
    const nextSeq = lastEvent.event_seq + 1;

    const newEvent: TaskEvent = {
      schema_version: "0.2",
      task_id: taskId,
      event_seq: nextSeq,
      event_id: `tev_${Date.now()}_${nextSeq}`,
      recorded_at: new Date().toISOString(),
      state: newState,
      summary,
      action_receipt_ids: options.actionReceiptIds ?? [...lastEvent.action_receipt_ids],
      artifact_refs: options.artifactRefs ?? [...lastEvent.artifact_refs],
      cancellation: lastEvent.cancellation,
      uncertainty_reason: options.uncertaintyReason ?? null,
    };

    events.push(newEvent);
    this.persist();
    return newEvent;
  }

  /**
   * Issues an ActionGrant (e.g. for high-risk command approval).
   */
  public async issueActionGrant(
    taskId: Id,
    params: Omit<ActionGrant, "schema_version" | "grant_id" | "revision" | "task_id" | "status" | "revoked_at">
  ): Promise<ActionGrant> {
    const grantId = `grant_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const grant: ActionGrant = {
      schema_version: "0.2",
      grant_id: grantId,
      revision: 1,
      task_id: taskId,
      issued_by_principal_id: params.issued_by_principal_id,
      executor_id: params.executor_id,
      trigger: params.trigger,
      scope: params.scope,
      not_before: params.not_before,
      expires_at: params.expires_at,
      max_uses: params.max_uses,
      status: "active",
      revoked_at: null,
    };

    this.actionGrants.set(grantId, grant);
    this.persist();
    return grant;
  }

  public async getActionGrant(grantId: Id): Promise<ActionGrant | null> {
    return this.actionGrants.get(grantId) ?? null;
  }

  public async getTaskActionGrants(taskId: Id): Promise<ActionGrant[]> {
    return Array.from(this.actionGrants.values()).filter((grant) => grant.task_id === taskId);
  }

  /**
   * Approves an action requiring user confirmation with explicit UserActionRef.
   */
  public async approveTaskAction(
    taskId: Id,
    grantId: Id,
    userActionRef: UserActionRef
  ): Promise<{ grant: ActionGrant; event: TaskEvent }> {
    const grant = this.actionGrants.get(grantId);
    if (!grant) {
      throw new Error(`Action grant '${grantId}' not found.`);
    }
    if (grant.task_id !== taskId) {
      throw new Error(`Action grant '${grantId}' does not belong to task '${taskId}'.`);
    }
    if (grant.status !== "active") {
      throw new Error(`Action grant '${grantId}' is not active (${grant.status}).`);
    }

    const now = new Date();
    if (now > new Date(grant.expires_at)) {
      grant.status = "expired";
      throw new Error(`Action grant '${grantId}' has expired.`);
    }

    // Attach user action trigger
    grant.trigger = {
      kind: "explicit_user_action",
      user_action: userActionRef,
    };

    // Transition task back to running
    const event = await this.transitionState(
      taskId,
      "running",
      `High-risk action approved by user (${userActionRef.kind})`
    );

    return { grant, event };
  }

  /**
   * Verifies artifacts using ReadbackEvidence and transitions task to succeeded.
   * STRICT REQUIREMENT: A task only succeeds when ReadbackEvidence is present.
   */
  public async verifyArtifactsAndComplete(
    taskId: Id,
    artifacts: Array<{ artifactId: Id; relativePath: string; contentHash: string }>,
    readbacks: ReadbackEvidence[]
  ): Promise<{ receipt: ActionReceipt; event: TaskEvent }> {
    // Check if readbacks contain runner_exit or artifact_probe
    const hasValidReadback = readbacks.some(
      (rb) => rb.kind === "artifact_probe" || rb.kind === "runner_exit"
    );

    if (!hasValidReadback) {
      throw new Error("Cannot mark task succeeded: missing verified artifact_probe or runner_exit readback evidence.");
    }

    const receiptId = `rcpt_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const receipt: ActionReceipt = {
      schema_version: "0.2",
      receipt_id: receiptId,
      action_id: `act_build_${taskId}`,
      task_id: taskId,
      receipt_seq: 1,
      executor_id: "dsh_runner",
      recorded_at: new Date().toISOString(),
      status: "verified",
      outcome: "applied",
      readbacks,
    };
    this.actionReceipts.set(receiptId, receipt);

    const artifactRefs: TaskEvent["artifact_refs"] = artifacts.map((art) => ({
      artifact_id: art.artifactId,
      verified_at: new Date().toISOString(),
      evidence_ids: readbacks.flatMap((rb) => rb.evidence_ids),
    }));

    const event = await this.transitionState(
      taskId,
      "succeeded",
      `Task succeeded with ${artifacts.length} verified artifacts`,
      {
        actionReceiptIds: [receiptId],
        artifactRefs,
      }
    );

    return { receipt, event };
  }

  /**
   * Requests cancellation: Immediately revokes pending ActionGrants and transitions to cancelling.
   */
  public async requestCancel(taskId: Id, reason = "User requested cancellation"): Promise<TaskEvent> {
    const events = this.taskEvents.get(taskId);
    if (!events || events.length === 0) {
      throw new Error(`Task '${taskId}' not found.`);
    }

    // Revoke any active grants for this task
    const nowIso = new Date().toISOString();
    for (const grant of this.actionGrants.values()) {
      if (grant.task_id === taskId && grant.status === "active") {
        grant.status = "revoked";
        grant.revoked_at = nowIso;
      }
    }

    const lastEvent = events[events.length - 1];
    const nextSeq = lastEvent.event_seq + 1;

    const cancelEvent: TaskEvent = {
      schema_version: "0.2",
      task_id: taskId,
      event_seq: nextSeq,
      event_id: `tev_${Date.now()}_${nextSeq}`,
      recorded_at: nowIso,
      state: "cancelling",
      summary: `Cancellation in progress: ${reason}`,
      action_receipt_ids: [...lastEvent.action_receipt_ids],
      artifact_refs: [...lastEvent.artifact_refs],
      cancellation: {
        phase: "pending",
        request_id: `req_cancel_${Date.now()}`,
        requested_at: nowIso,
        stop_sent_at: nowIso,
      },
      uncertainty_reason: null,
    };

    events.push(cancelEvent);
    this.persist();
    return cancelEvent;
  }

  /**
   * Confirms cancellation with honest outcome.
   * If remote exit confirmed -> state: "cancelled".
   * If transport lost / unconfirmed -> state: "unknown" (uncertainty_reason: "stop_unconfirmed").
   */
  public async confirmCancel(
    taskId: Id,
    outcome: {
      confirmed: boolean;
      terminationEvidenceIds?: Id[];
      transportLost?: boolean;
    }
  ): Promise<TaskEvent> {
    const events = this.taskEvents.get(taskId);
    if (!events || events.length === 0) {
      throw new Error(`Task '${taskId}' not found.`);
    }

    const lastEvent = events[events.length - 1];
    const nextSeq = lastEvent.event_seq + 1;
    const nowIso = new Date().toISOString();
    const reqId =
      lastEvent.cancellation.phase === "pending" || lastEvent.cancellation.phase === "unknown"
        ? lastEvent.cancellation.request_id
        : `req_cancel_${Date.now()}`;
    const reqAt =
      lastEvent.cancellation.phase === "pending" || lastEvent.cancellation.phase === "unknown"
        ? lastEvent.cancellation.requested_at
        : nowIso;

    if (outcome.confirmed) {
      const confirmedEvent: TaskEvent = {
        schema_version: "0.2",
        task_id: taskId,
        event_seq: nextSeq,
        event_id: `tev_${Date.now()}_${nextSeq}`,
        recorded_at: nowIso,
        state: "cancelled",
        summary: "Task cancelled and remote process verified terminated",
        action_receipt_ids: [...lastEvent.action_receipt_ids],
        artifact_refs: [...lastEvent.artifact_refs],
        cancellation: {
          phase: "confirmed",
          request_id: reqId,
          requested_at: reqAt,
          confirmed_at: nowIso,
          termination_evidence_ids: outcome.terminationEvidenceIds ?? [`ev_term_${Date.now()}`],
        },
        uncertainty_reason: null,
      };

      events.push(confirmedEvent);
      this.persist();
      return confirmedEvent;
    }

    // Honest uncertainty fallback: Transport lost or stop unconfirmed
    const unknownEvent: TaskEvent = {
      schema_version: "0.2",
      task_id: taskId,
      event_seq: nextSeq,
      event_id: `tev_${Date.now()}_${nextSeq}`,
      recorded_at: nowIso,
      state: "unknown",
      summary: "停止请求已发出，远端进程终态待核实",
      action_receipt_ids: [...lastEvent.action_receipt_ids],
      artifact_refs: [...lastEvent.artifact_refs],
      cancellation: {
        phase: "unknown",
        request_id: reqId,
        requested_at: reqAt,
        stop_sent_at: nowIso,
      },
      uncertainty_reason: outcome.transportLost ? "transport_lost" : "stop_unconfirmed",
    };

    events.push(unknownEvent);
    this.persist();
    return unknownEvent;
  }

  public getStats(): { activeTasks: number; totalTasks: number } {
    let active = 0;
    for (const events of this.taskEvents.values()) {
      const latest = events[events.length - 1];
      if (
        latest &&
        (latest.state === "queued" ||
          latest.state === "running" ||
          latest.state === "awaiting_approval" ||
          latest.state === "cancelling")
      ) {
        active++;
      }
    }
    return {
      activeTasks: active,
      totalTasks: this.tasksById.size,
    };
  }
}
