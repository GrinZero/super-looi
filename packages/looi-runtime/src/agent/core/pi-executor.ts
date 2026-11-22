import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentTool, StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import {
  AgentExecutionError,
  type AgentExecutionLane,
  type AgentExecutor,
  type AgentInteractionAnswer,
  type AgentRunOptions,
  type AgentRunResult,
  type AgentStopResult,
  type AgentTask,
} from "../executor.js";
import {
  ApprovalActionReplayGuard,
  createToolApprovalPolicy,
  type ToolApprovalConfig,
  type ToolApprovalRule,
} from "../governance/index.js";
import {
  AgentTaskStore,
  type TaskPersistence,
} from "../memory/index.js";
import { PiTaskRunner, awaitWithin } from "./pi-task-runner.js";
import type { PiSessionConfig } from "./pi-session.js";
import type { LangfuseTracer } from "../../telemetry/langfuse.js";

export interface PiExecutorConfig extends ToolApprovalConfig, PiSessionConfig {
  tracer?: LangfuseTracer;
  taskPersistence?: TaskPersistence;
  stateDirectory?: string;
  workspaceRoot?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  /** App-specific instructions appended to the task session's system prompt. */
  systemPrompt?: string;
  deadlineMs?: number;
  maxSteps?: number;
  maxToolCalls?: number;
  maxConcurrentTasks?: number;
  laneLimits?: Partial<Record<AgentExecutionLane, number>>;
  interactionTimeoutMs?: number;
  stopGraceMs?: number;
  commandTimeoutMs?: number;
  streamFn?: StreamFn;
  modelSpec?: Model<Api>;
  customTools?: AgentTool<any>[];
  additionalTools?: AgentTool<any>[];
  /** Native callers bind approvals to the current foreground UI session. */
  approvalUiSessionId?: string;
  modelsRegistry?: Models;
  providerId?: string;
}

export type PiAgentExecutorConfig = PiExecutorConfig;

const DEFAULT_MAX_CONCURRENT_TASKS = 3;
const DEFAULT_LANE_LIMIT = 1;

/**
 * In-process Agent Executor powered by `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai`.
 * Coordinates task admission, lane-isolated concurrency guards, and disposable `PiTaskRunner` instances.
 */
export class PiAgentExecutor implements AgentExecutor {
  private readonly approvalPolicy: ToolApprovalRule;
  private readonly replayGuard: ApprovalActionReplayGuard;
  private readonly store: AgentTaskStore;
  private readonly sessionsDirectory: string;
  private readonly runners = new Map<string, PiTaskRunner>();
  private readonly runnerLanes = new Map<string, AgentExecutionLane>();
  private readonly root: string;
  private closed = false;
  private closing?: Promise<void>;

  constructor(private readonly config: PiExecutorConfig = {}) {
    this.approvalPolicy = createToolApprovalPolicy(config);
    this.replayGuard = new ApprovalActionReplayGuard(config.approvalUiSessionId);
    this.root = path.resolve(
      config.stateDirectory ?? process.env.DSH_STATE_DIRECTORY ?? "data/dsh",
    );
    this.store = new AgentTaskStore(
      path.join(this.root, "tasks"),
      config.taskPersistence,
    );
    this.sessionsDirectory = path.join(this.root, "sessions");
  }

  getTask(id: string): AgentTask | undefined {
    const task = this.store.get(id);
    return task ? structuredClone(task) : undefined;
  }

  listTasks(): AgentTask[] {
    return structuredClone(this.store.list());
  }

  listTaskSummaries(): Pick<AgentTask, "id" | "prompt" | "state" | "updatedAt">[] {
    return this.store.list().map(({ id, prompt, state, updatedAt }) => ({ id, prompt, state, updatedAt }));
  }

  sendMessage(taskId: string, message: string, behavior: "steer" | "followUp" = "followUp"): Promise<"queued" | "handled"> {
    const runner = this.runners.get(taskId);
    if (!runner) {
      return Promise.reject(
        new AgentExecutionError("Task has no active Pi run", taskId, {
          stage: "agent.message",
          code: "ERR_AGENT_TASK_NOT_ACTIVE",
        }),
      );
    }
    if (!message.trim()) {
      return Promise.reject(
        new AgentExecutionError("message is required", taskId, {
          stage: "agent.message",
          code: "ERR_AGENT_INVALID_MESSAGE",
        }),
      );
    }
    return runner.sendMessage(message, behavior);
  }

  private rejectAdmission(
    message: string,
    code: string,
    taskId?: string,
  ): Promise<never> {
    return Promise.reject(
      new AgentExecutionError(message, taskId, {
        stage: "agent.admission",
        code,
      }),
    );
  }

  run(prompt: string, options: AgentRunOptions = {}): Promise<AgentRunResult> {
    if (this.closed) {
      return this.rejectAdmission("Agent executor is closed", "ERR_AGENT_EXECUTOR_CLOSED");
    }
    if (!prompt.trim()) {
      return this.rejectAdmission("prompt is required", "ERR_AGENT_INVALID_PROMPT");
    }
    if (options.signal?.aborted) {
      return this.rejectAdmission("Task aborted before admission", "ERR_AGENT_CANCELLED");
    }

    const id = options.taskId ?? `task_${randomUUID()}`;
    this.store.assertId(id);
    const previous = this.store.get(id);
    const sessionId = options.sessionId ?? previous?.sessionId;
    if (sessionId) {
      this.store.assertId(sessionId);
      if (previous && previous.sessionId !== sessionId) {
        return this.rejectAdmission(
          "Cannot change a persisted task session",
          "ERR_AGENT_SESSION_CONFLICT",
          id,
        );
      }
    }

    const active = this.runners.get(id);
    if (active) {
      if (previous?.prompt !== prompt) {
        return this.rejectAdmission(
          "Task id already belongs to another prompt",
          "ERR_AGENT_TASK_CONFLICT",
          id,
        );
      }
      return active.promise;
    }
    if (previous && !options.resume) {
      if (previous.prompt !== prompt) {
        return this.rejectAdmission(
          "Task id already belongs to another prompt",
          "ERR_AGENT_TASK_CONFLICT",
          id,
        );
      }
      if (previous.result && previous.state === "succeeded") {
        return Promise.resolve(structuredClone(previous.result));
      }
      return this.rejectAdmission(
        "Task already exists; inspect its outcome or explicitly resume",
        "ERR_AGENT_TASK_CONFLICT",
        id,
      );
    }
    if (options.resume && !previous) {
      return this.rejectAdmission(
        "Task to resume was not found",
        "ERR_AGENT_TASK_NOT_FOUND",
        id,
      );
    }
    if (sessionId) {
      const siblings = this.store
        .list()
        .filter((task) => task.sessionId === sessionId && task.id !== id);
      if (siblings.some((task) => this.runners.has(task.id))) {
        return this.rejectAdmission(
          "Conversation already has an active task",
          "ERR_AGENT_SESSION_BUSY",
          id,
        );
      }
      const requestedWorkspace = path.resolve(
        options.workspaceRoot ??
          previous?.workspaceRoot ??
          this.config.workspaceRoot ??
          process.env.DSH_WORKSPACE_ROOT ??
          "data/agent-workspace",
      );
      if (siblings.some((task) => task.workspaceRoot !== requestedWorkspace)) {
        return this.rejectAdmission(
          "Cannot change a conversation workspace",
          "ERR_AGENT_WORKSPACE_CONFLICT",
          id,
        );
      }
    }

    const lane: AgentExecutionLane = options.lane ?? "foreground";
    const laneLimit = this.config.laneLimits?.[lane] ?? DEFAULT_LANE_LIMIT;
    let activeInLane = 0;
    for (const activeLane of this.runnerLanes.values()) {
      if (activeLane === lane) activeInLane++;
    }
    if (activeInLane >= laneLimit) {
      return this.rejectAdmission(
        `Agent lane "${lane}" is busy`,
        "ERR_AGENT_LANE_BUSY",
        id,
      );
    }

    if (this.runners.size >= (this.config.maxConcurrentTasks ?? DEFAULT_MAX_CONCURRENT_TASKS)) {
      return this.rejectAdmission(
        "Agent worker capacity reached",
        "ERR_AGENT_CAPACITY_REACHED",
        id,
      );
    }

    const workspaceRoot =
      previous?.workspaceRoot ??
      path.resolve(
        this.config.workspaceRoot ??
          process.env.DSH_WORKSPACE_ROOT ??
          "data/agent-workspace",
      );
    if (
      options.workspaceRoot &&
      previous &&
      path.resolve(options.workspaceRoot) !== workspaceRoot
    ) {
      return this.rejectAdmission(
        "Cannot change a persisted task workspace",
        "ERR_AGENT_WORKSPACE_CONFLICT",
        id,
      );
    }

    const task: AgentTask = previous ?? {
      id,
      sessionId: options.sessionId ?? `session_${randomUUID()}`,
      workspaceRoot: path.resolve(options.workspaceRoot ?? workspaceRoot),
      prompt,
      lane,
      state: "queued",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      steps: [],
    };
    this.store.assertId(task.sessionId);
    task.lane = lane;
    task.state = "queued";
    task.runtimeExited = false;
    if (options.resume) task.prompt = prompt;
    delete task.result;
    delete task.error;
    delete task.failure;
    delete task.toolFailures;
    delete task.interaction;
    this.store.save(task);

    const runner = new PiTaskRunner(task, prompt, options, {
      config: this.config,
      approvalPolicy: this.approvalPolicy,
      replayGuard: this.replayGuard,
      sessionsDirectory: this.sessionsDirectory,
      isExecutorClosed: () => this.closed,
      updateTask: (updated) => {
        updated.updatedAt = new Date().toISOString();
        this.store.save(updated);
      },
      onFinished: (taskId) => {
        this.runners.delete(taskId);
        this.runnerLanes.delete(taskId);
      },
    });
    this.runners.set(id, runner);
    this.runnerLanes.set(id, lane);
    return runner.promise;
  }

  respond(
    taskId: string,
    requestId: string,
    answer: AgentInteractionAnswer,
  ): void {
    const runner = this.runners.get(taskId);
    if (!runner) {
      throw new Error("Interaction is no longer pending");
    }
    runner.respond(requestId, answer);
  }

  async cancel(taskId: string): Promise<AgentStopResult> {
    const task = this.store.get(taskId);
    if (!task) throw new Error("Task not found");
    if (["succeeded", "failed", "cancelled"].includes(task.state)) {
      return {
        state: task.state,
        runtimeExited: task.runtimeExited ?? false,
        confirmed: task.state === "cancelled",
      };
    }
    const runner = this.runners.get(taskId);
    if (!runner) {
      return { state: task.state, runtimeExited: false, confirmed: false };
    }
    return runner.cancel();
  }

  close(): Promise<void> {
    return (this.closing ??= (async () => {
      try {
        await this.closeRunners();
      } finally {
        await this.config.tracer?.flush();
      }
    })());
  }

  private async closeRunners(): Promise<void> {
    this.closed = true;
    await Promise.allSettled(
      [...this.runners.keys()].map((id) => this.cancel(id)),
    );
    const settled = await awaitWithin(
      Promise.allSettled(
        [...this.runners.values()].map((runner) => runner.promise),
      ),
      this.config.stopGraceMs ?? 3000,
    );
    if (!settled) {
      throw new AgentExecutionError(
        "Local execution exit is unconfirmed; task remains unknown",
        undefined,
        {
          stage: "agent.shutdown",
          code: "ERR_AGENT_STOP_UNCONFIRMED",
        },
      );
    }
  }
}
