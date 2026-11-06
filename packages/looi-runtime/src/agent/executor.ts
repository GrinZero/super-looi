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
  interaction?: AgentInteraction;
  result?: AgentRunResult;
  error?: string;
  runtimeExited?: boolean;
}

export interface AgentRunOptions {
  taskId?: string;
  workspaceRoot?: string;
  mode?: "voice" | "text";
  onStep?: (event: AgentStepEvent) => void;
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
