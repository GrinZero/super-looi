export type AgentTaskState =
  | "queued"
  | "running"
  | "awaiting_approval"
  | "awaiting_input"
  | "cancelling"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "unknown";

export interface AgentStepEvent {
  step: number;
  phase:
    | "thinking"
    | "tool_start"
    | "tool_end"
    | "awaiting_approval"
    | "awaiting_input"
    | "done"
    | "error";
  toolName?: string;
  summary: string;
  taskId?: string;
  sessionId?: string;
  interaction?: AgentInteraction;
}

export interface AgentRunResult {
  taskId: string;
  sessionId: string;
  answer: string;
  steps: AgentStepEvent[];
  toolCallsCount: number;
  durationMs: number;
  finishReason: string;
  runtimeExited: boolean;
  executions?: AgentCommandEvidence[];
  artifacts?: Array<{ path: string; sha256: string; size: number }>;
}

export interface AgentCommandEvidence {
  callId: string;
  command: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  aborted: boolean;
  stdout?: string;
  stderr?: string;
}

export interface AgentInteraction {
  id: string;
  kind: "approval" | "question";
  details: Record<string, unknown>;
  expiresAt: string;
}

export interface AgentTask {
  id: string;
  sessionId: string;
  workspaceRoot: string;
  prompt: string;
  state: AgentTaskState;
  createdAt: string;
  updatedAt: string;
  steps: AgentStepEvent[];
  trace?: { traceId: string; spanId: string };
  interaction?: AgentInteraction;
  result?: AgentRunResult;
  error?: string;
  runtimeExited?: boolean;
  /** Human acknowledgement of an uncertain outcome; execution evidence stays intact. */
  reviewedAt?: string;
}

export function taskNeedsReview(task: Pick<AgentTask, "state" | "reviewedAt">): boolean {
  return task.state === "unknown" && !task.reviewedAt;
}

export interface AgentShellOutput {
  taskId: string;
  callId: string;
  command: string;
  stream: "stdout" | "stderr" | "status";
  chunk: string;
}

export interface AgentRunOptions {
  traceContext?: import("../telemetry/langfuse.js").TraceContext;
  taskId?: string;
  /** Share persisted dialogue history while retaining a distinct task per turn. */
  sessionId?: string;
  workspaceRoot?: string;
  mode?: "voice" | "text";
  /** Approval choice is fixed when this task starts. */
  approvalMode?: "ask" | "local_auto" | "yolo";
  defaultLanguage?: "zh-CN" | "en-US";
  onStep?: (event: AgentStepEvent) => void;
  onShellOutput?: (event: AgentShellOutput) => void;
  signal?: AbortSignal;
  resume?: boolean;
}

export type AgentInteractionAnswer =
  | {
      outcome: "allowed-once" | "rejected" | "cancelled";
      userAction?: UserActionRef;
    }
  | { answers: Array<{ id: string; selected: string[]; custom?: string }> }
  | { cancelled: true };

export interface AgentStopResult {
  state: AgentTaskState;
  runtimeExited: boolean;
  confirmed: boolean;
}

export interface AgentExecutor {
  run(prompt: string, options?: AgentRunOptions): Promise<AgentRunResult>;
  sendMessage(taskId: string, message: string, behavior?: "steer" | "followUp"): Promise<"queued" | "handled">;
  getTask(id: string): AgentTask | undefined;
  listTasks(): AgentTask[];
  respond(
    taskId: string,
    requestId: string,
    answer: AgentInteractionAnswer,
  ): void;
  cancel(taskId: string): Promise<AgentStopResult>;
  close(): Promise<void>;
}

export class AgentExecutionError extends Error {
  constructor(
    message: string,
    public readonly taskId?: string,
  ) {
    super(message);
    this.name = "AgentExecutionError";
  }
}
import type { UserActionRef } from "@super-looi/contracts";
