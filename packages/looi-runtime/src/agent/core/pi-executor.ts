import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentTool, StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import {
  AgentExecutionError,
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

/**
 * In-process Agent Executor powered by `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai`.
 * Coordinates task admission, session-level concurrency guards, and disposable `PiTaskRunner` instances.
 */
export class PiAgentExecutor implements AgentExecutor {
  private readonly approvalPolicy: ToolApprovalRule;
  private readonly replayGuard: ApprovalActionReplayGuard;
  private readonly store: AgentTaskStore;
  private readonly sessionsDirectory: string;
  private readonly runners = new Map<string, PiTaskRunner>();
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

  sendMessage(taskId: string, message: string, behavior: "steer" | "followUp" = "followUp"): Promise<"queued" | "handled"> {
    const runner = this.runners.get(taskId);
    if (!runner) return Promise.reject(new AgentExecutionError("Task has no active Pi run", taskId));
    if (!message.trim()) return Promise.reject(new AgentExecutionError("message is required", taskId));
    return runner.sendMessage(message, behavior);
  }

  run(prompt: string, options: AgentRunOptions = {}): Promise<AgentRunResult> {
    if (this.closed)
      return Promise.reject(
        new AgentExecutionError("Agent executor is closed"),
      );
    if (!prompt.trim())
      return Promise.reject(new AgentExecutionError("prompt is required"));
    if (options.signal?.aborted)
      return Promise.reject(
        new AgentExecutionError("Task aborted before admission"),
      );

    const id = options.taskId ?? `task_${randomUUID()}`;
    this.store.assertId(id);
    const previous = this.store.get(id);
    const sessionId = options.sessionId ?? previous?.sessionId;
    if (sessionId) {
      this.store.assertId(sessionId);
      if (previous && previous.sessionId !== sessionId)
        return Promise.reject(
          new AgentExecutionError("Cannot change a persisted task session", id),
        );
    }

    const active = this.runners.get(id);
    if (active) {
      if (previous?.prompt !== prompt)
        return Promise.reject(
          new AgentExecutionError(
            "Task id already belongs to another prompt",
            id,
          ),
        );
      return active.promise;
    }
    if (previous && !options.resume) {
      if (previous.prompt !== prompt)
        return Promise.reject(
          new AgentExecutionError(
            "Task id already belongs to another prompt",
            id,
          ),
        );
      if (previous.result && previous.state === "succeeded")
        return Promise.resolve(structuredClone(previous.result));
      return Promise.reject(
        new AgentExecutionError(
          "Task already exists; inspect its outcome or explicitly resume",
          id,
        ),
      );
    }
    if (options.resume && !previous)
      return Promise.reject(
        new AgentExecutionError("Task to resume was not found", id),
      );
    if (sessionId) {
      const siblings = this.store
        .list()
        .filter((task) => task.sessionId === sessionId && task.id !== id);
      if (siblings.some((task) => this.runners.has(task.id)))
        return Promise.reject(
          new AgentExecutionError(
            "Conversation already has an active task",
            id,
          ),
        );
      const requestedWorkspace = path.resolve(
        options.workspaceRoot ??
          previous?.workspaceRoot ??
          this.config.workspaceRoot ??
          process.env.DSH_WORKSPACE_ROOT ??
          "data/agent-workspace",
      );
      if (siblings.some((task) => task.workspaceRoot !== requestedWorkspace))
        return Promise.reject(
          new AgentExecutionError("Cannot change a conversation workspace", id),
        );
    }
    if (this.runners.size >= (this.config.maxConcurrentTasks ?? 2)) {
      return Promise.reject(
        new AgentExecutionError("Agent worker capacity reached"),
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
      return Promise.reject(
        new AgentExecutionError("Cannot change a persisted task workspace", id),
      );
    }

    const task: AgentTask = previous ?? {
      id,
      sessionId: options.sessionId ?? `session_${randomUUID()}`,
      workspaceRoot: path.resolve(options.workspaceRoot ?? workspaceRoot),
      prompt,
      state: "queued",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      steps: [],
    };
    this.store.assertId(task.sessionId);
    task.state = "queued";
    task.runtimeExited = false;
    if (options.resume) task.prompt = prompt;
    delete task.result;
    delete task.error;
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
      },
    });
    this.runners.set(id, runner);
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
      );
    }
  }
}
