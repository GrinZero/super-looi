import { randomUUID } from "node:crypto";
import type { UserActionRef } from "@super-looi/contracts";
import { assertFreshUiAction } from "../../productivity/authorization.js";
import type {
  AgentInteractionAnswer,
  AgentStepEvent,
  AgentTask,
} from "../executor.js";

const REPLAY_WINDOW_MS = 31_000;
const MAX_CONSUMED_ACTIONS = 512;

/**
 * Enforces UI session binding and single-use replay protection for explicit
 * user approval actions across tasks within the same executor instance.
 */
export class ApprovalActionReplayGuard {
  private readonly consumed = new Map<string, number>();

  constructor(private readonly approvalUiSessionId?: string) {}

  verifyAndConsume(action?: UserActionRef): void {
    if (!this.approvalUiSessionId) return;
    if (!action) throw new Error("A fresh explicit UI action is required");
    const now = Date.now();
    assertFreshUiAction(action, now);
    if (action.ui_session_id !== this.approvalUiSessionId) {
      throw new Error("Approval belongs to a different UI session");
    }
    for (const [id, captured] of this.consumed) {
      if (captured < now - REPLAY_WINDOW_MS) this.consumed.delete(id);
    }
    if (this.consumed.has(action.event_id)) {
      throw new Error("Approval action was already consumed");
    }
    if (this.consumed.size >= MAX_CONSUMED_ACTIONS) {
      throw new Error("Approval action capacity exceeded");
    }
    this.consumed.set(action.event_id, Date.parse(action.captured_at));
  }
}

export interface InteractionGateContext {
  task: AgentTask;
  timeoutMs: number;
  replayGuard: ApprovalActionReplayGuard;
  isStopped: () => boolean;
  onUpdate: () => void;
  emit: (event: Omit<AgentStepEvent, "taskId" | "sessionId">) => void;
}

/**
 * Coordinates a single task's suspended `approval` or `question` interaction:
 * manages expiration timers, abort signals, answer validation, and state restoration.
 */
export class InteractionGate {
  private pending?: {
    id: string;
    settle: (answer: AgentInteractionAnswer) => void;
  };

  constructor(private readonly context: InteractionGateContext) {}

  wait(
    kind: "approval" | "question",
    details: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<AgentInteractionAnswer> {
    const { task, timeoutMs, isStopped, onUpdate, emit } = this.context;
    if (isStopped() || signal?.aborted) {
      return Promise.resolve(
        kind === "approval" ? { outcome: "cancelled" } : { cancelled: true },
      );
    }
    if (this.pending) {
      return Promise.reject(
        new Error("Concurrent interactive requests are not supported"),
      );
    }
    const id = randomUUID();
    task.interaction = {
      id,
      kind,
      details,
      expiresAt: new Date(Date.now() + timeoutMs).toISOString(),
    };
    task.state = kind === "approval" ? "awaiting_approval" : "awaiting_input";
    return new Promise((resolve) => {
      const dismiss = () =>
        settle(
          kind === "approval" ? { outcome: "cancelled" } : { cancelled: true },
        );
      const timer = setTimeout(dismiss, timeoutMs);
      const settle = (answer: AgentInteractionAnswer) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", dismiss);
        this.pending = undefined;
        delete task.interaction;
        if (!isStopped()) task.state = "running";
        onUpdate();
        resolve(answer);
      };
      this.pending = { id, settle };
      signal?.addEventListener("abort", dismiss, { once: true });
      emit({
        step: task.steps.at(-1)?.step ?? 0,
        phase: kind === "approval" ? "awaiting_approval" : "awaiting_input",
        summary:
          kind === "approval"
            ? "@looi:approvalNeeded"
            : "@looi:agentAwaitingAnswer",
      });
    });
  }

  respond(requestId: string, answer: AgentInteractionAnswer): void {
    const { task, replayGuard, isStopped } = this.context;
    if (
      !task.interaction ||
      !this.pending ||
      this.pending.id !== requestId ||
      task.interaction.id !== requestId ||
      isStopped()
    ) {
      throw new Error("Interaction is no longer pending");
    }
    if (
      !Number.isFinite(Date.parse(task.interaction.expiresAt)) ||
      Date.parse(task.interaction.expiresAt) <= Date.now()
    ) {
      throw new Error("Interaction has expired");
    }
    if (task.interaction.kind === "approval") {
      if (
        !("outcome" in answer) ||
        !["allowed-once", "rejected", "cancelled"].includes(answer.outcome)
      ) {
        throw new Error("Invalid approval answer");
      }
      if (answer.outcome === "allowed-once") {
        replayGuard.verifyAndConsume(answer.userAction);
      }
    } else if (!("answers" in answer) && !("cancelled" in answer)) {
      throw new Error("Invalid question answer");
    }
    this.pending.settle(answer);
  }

  cancelPending(): void {
    const { task } = this.context;
    this.pending?.settle(
      task.interaction?.kind === "approval"
        ? { outcome: "cancelled" }
        : { cancelled: true },
    );
  }
}
