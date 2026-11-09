import fs from "node:fs";
import {
  Agent,
  type AgentMessage,
  type AgentTool,
  type BeforeToolCallResult,
} from "@earendil-works/pi-agent-core";
import { contentText } from "@earendil-works/pi-ai";
import {
  AgentExecutionError,
  type AgentCommandEvidence,
  type AgentInteractionAnswer,
  type AgentRunOptions,
  type AgentRunResult,
  type AgentStepEvent,
  type AgentStopResult,
  type AgentTask,
} from "../executor.js";
import {
  InteractionGate,
  type ApprovalActionReplayGuard,
  type ToolApprovalRule,
} from "../governance/index.js";
import type { SessionTranscriptStore } from "../memory/index.js";
import { buildAgentTurnPrompts } from "../prompts/index.js";
import {
  WorkspaceArtifactTracker,
  createWorkspaceCodingTools,
} from "../tools/index.js";
import {
  resolvePiModelAndStream,
  type ModelStreamConfig,
} from "./model-resolver.js";
import { createOpenAIWebSearch, hasOpenAIWebSearch } from "./openai-web-search.js";
import type { LangfuseTracer, Observation } from "../../telemetry/langfuse.js";
import { wrapStreamFnWithLangfuse } from "../../telemetry/llm-observer.js";

export async function awaitWithin(
  promise: Promise<unknown>,
  milliseconds: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => false,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface PiTaskRunnerConfig extends ModelStreamConfig {
  tracer?: LangfuseTracer;
  deadlineMs?: number;
  maxSteps?: number;
  maxToolCalls?: number;
  interactionTimeoutMs?: number;
  stopGraceMs?: number;
  commandTimeoutMs?: number;
  customTools?: AgentTool<any>[];
  additionalTools?: AgentTool<any>[];
}

export interface PiTaskRunnerHost {
  config: PiTaskRunnerConfig;
  approvalPolicy: ToolApprovalRule;
  replayGuard: ApprovalActionReplayGuard;
  sessions: SessionTranscriptStore;
  isExecutorClosed: () => boolean;
  updateTask: (task: AgentTask) => void;
  onFinished: (taskId: string) => void;
}

/**
 * Disposable single-task execution unit (Disposable Task Object pattern).
 * Owns one `Agent` instance, its shell process handles, interaction gate,
 * step/tool budgets, Langfuse spans, and bounded stop grace period.
 */
export class PiTaskRunner {
  readonly promise: Promise<AgentRunResult>;
  private agent?: Agent;
  private stopPromise?: Promise<AgentStopResult>;
  private stopped = false;
  private readonly pendingShell = new Set<string>();
  private readonly killShells = new Set<() => void>();
  private readonly interactionGate: InteractionGate;

  constructor(
    private readonly task: AgentTask,
    private readonly prompt: string,
    private readonly options: AgentRunOptions,
    private readonly host: PiTaskRunnerHost,
  ) {
    this.interactionGate = new InteractionGate({
      task: this.task,
      timeoutMs: this.host.config.interactionTimeoutMs ?? 120_000,
      replayGuard: this.host.replayGuard,
      isStopped: () => this.stopped,
      onUpdate: () => this.host.updateTask(this.task),
      emit: (event) => this.emit(event),
    });
    this.promise = Promise.resolve().then(() => this.execute());
  }

  respond(requestId: string, answer: AgentInteractionAnswer): void {
    this.interactionGate.respond(requestId, answer);
  }

  cancel(): Promise<AgentStopResult> {
    if (this.stopPromise) return this.stopPromise;

    this.stopped = true;
    this.interactionGate.cancelPending();
    for (const kill of this.killShells) kill();
    this.agent?.abort();
    this.task.state = "cancelling";
    this.host.updateTask(this.task);

    this.stopPromise = (async () => {
      const graceMs = this.host.config.stopGraceMs ?? 3000;
      const agentExited = this.agent
        ? await awaitWithin(this.agent.waitForIdle(), graceMs)
        : true;
      const runtimeExited = agentExited && this.pendingShell.size === 0;
      const confirmed = runtimeExited;
      this.task.runtimeExited = runtimeExited;
      this.task.state = confirmed ? "cancelled" : "unknown";
      if (!confirmed) {
        this.task.error =
          "Runtime stop requested; local execution exit or external effect requires verification";
      }
      this.host.updateTask(this.task);
      return { state: this.task.state, runtimeExited, confirmed };
    })();
    return this.stopPromise;
  }

  private emit(event: Omit<AgentStepEvent, "taskId" | "sessionId">): void {
    const item: AgentStepEvent = {
      ...event,
      taskId: this.task.id,
      sessionId: this.task.sessionId,
      interaction: this.task.interaction
        ? structuredClone(this.task.interaction)
        : undefined,
    };
    this.task.steps.push(item);
    if (this.task.steps.length > 300) this.task.steps.shift();
    this.host.updateTask(this.task);
    try {
      this.options.onStep?.(item);
    } catch {
      // optional observer
    }
  }

  private sanitize(message: string): string {
    const key = (
      this.host.config.apiKey ?? process.env.LLM_API_KEY
    )?.trim();
    return (key ? message.replaceAll(key, "[redacted]") : message).slice(
      0,
      500,
    );
  }

  private async execute(): Promise<AgentRunResult> {
    const { task, prompt, options, host } = this;
    const { config } = host;
    const start = Date.now();
    const trace = config.tracer?.start(
      "agent.run",
      "agent",
      options.traceContext ?? {
        traceId: "",
        traceName: "agent.run",
        sessionId: task.sessionId,
      },
      {
        "langfuse.observation.input": prompt,
        "langfuse.observation.metadata.taskId": task.id,
        "langfuse.observation.metadata.mode": options.mode ?? "text",
      },
    );
    const toolTraces = new Map<string, Observation>();
    let tracedAnswer: string | undefined;
    let traceError = false;
    let toolCallsCount = 0;
    let step = 0;
    const executions: AgentCommandEvidence[] = [];
    const artifacts = new WorkspaceArtifactTracker(task.workspaceRoot, start);
    let timer: ReturnType<typeof setTimeout> | undefined;

    const abort = () => {
      void this.cancel().catch(() => {});
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();

    try {
      if (this.stopped) {
        throw new Error("Task cancelled before runtime startup");
      }
      fs.mkdirSync(task.workspaceRoot, { recursive: true });

      const restoredMessages =
        options.resume || options.sessionId
          ? host.sessions.load(task.sessionId)
          : undefined;
      if (options.resume && !restoredMessages) {
        throw new Error("Persisted session transcript was not found");
      }

      const { model, streamFn } = resolvePiModelAndStream(config);
      const startTool = (callId: string, toolName: string, args: unknown) => {
        if (this.stopped) return;
        if (trace && config.tracer) {
          toolTraces.set(
            callId,
            config.tracer.start(`agent.tool.${toolName}`, "tool", trace.context, {
              "langfuse.observation.input": args,
            }),
          );
        }
        toolCallsCount++;
        if (toolCallsCount > (config.maxToolCalls ?? 32)) {
          task.error = "Agent tool budget exceeded";
          abort();
          return;
        }
        this.emit({
          step, phase: "tool_start", toolName, summary: `Pi · ${toolName}`,
        });
      };
      const endTool = (
        callId: string,
        toolName: string,
        result: unknown,
        isError?: boolean,
        durationMs?: number,
      ) => {
        toolTraces.get(callId)?.end({
          "langfuse.observation.output": result,
          ...(isError ? { "langfuse.observation.level": "ERROR" } : {}),
          ...(durationMs !== undefined
            ? { "langfuse.observation.metadata.durationMs": durationMs }
            : {}),
        });
        toolTraces.delete(callId);
        if (!this.stopped) {
          this.emit({
            step, phase: "tool_end", toolName, summary: "@looi:toolReturned",
          });
        }
      };
      const webSearch = createOpenAIWebSearch((event) => {
        if (event.phase === "start") startTool(event.callId, "web_search", {});
        else {
          endTool(event.callId, "web_search", event.result, event.result?.status === "failed");
        }
      });
      const tools =
        config.customTools ??
        createWorkspaceCodingTools({
          taskId: task.id,
          sessionId: task.sessionId,
          workspaceRoot: task.workspaceRoot,
          commandTimeoutMs: config.commandTimeoutMs ?? 300_000,
          artifacts,
          executions,
          pendingShell: this.pendingShell,
          killShells: this.killShells,
          isStopped: () => this.stopped,
          onShellOutput: options.onShellOutput,
          askUserQuestion: (requestId, questions, signal) =>
            this.interactionGate.wait(
              "question",
              {
                requestId,
                sessionId: task.sessionId,
                questions,
              },
              signal,
            ),
          additionalTools: config.additionalTools,
        });

      const { systemPrompt, userPrompt } = buildAgentTurnPrompts({
        prompt,
        mode: options.mode,
        defaultLanguage: options.defaultLanguage,
        restoredMessages,
        webSearchEnabled: hasOpenAIWebSearch(model),
      });

      const agent = new Agent({
        initialState: {
          systemPrompt,
          model,
          tools,
          // Session history contains its old system message; use this run’s language policy.
          ...(restoredMessages
            ? {
                messages: restoredMessages.filter(
                  (message) => message.role !== "system",
                ),
              }
            : {}),
        },
        sessionId: task.sessionId,
        onPayload: webSearch.onPayload,
        onProviderStreamEvent: webSearch.onProviderStreamEvent,
        toolExecution: "sequential",
        streamFn: config.tracer?.enabled
          ? wrapStreamFnWithLangfuse(streamFn, {
              tracer: config.tracer,
              getTraceContext: () => trace?.context,
            })
          : streamFn,
        beforeToolCall: async (
          { toolCall, args },
          signal,
        ): Promise<BeforeToolCallResult | undefined> => {
          if (host.isExecutorClosed() || this.stopped || signal?.aborted) {
            return {
              block: true,
              reason:
                "Task was stopped; no further tool execution is permitted.",
            };
          }
          const details = host.approvalPolicy({
            callId: toolCall.id,
            toolName: toolCall.name,
            arguments: (args ?? {}) as Record<string, unknown>,
            sessionId: task.sessionId,
            workspaceRoot: task.workspaceRoot,
            approvalMode: options.approvalMode ?? "ask",
          });
          if (details) {
            const decision = await this.interactionGate.wait(
              "approval",
              details,
              signal,
            );
            if (
              !("outcome" in decision) ||
              decision.outcome !== "allowed-once"
            ) {
              return {
                block: true,
                reason:
                  "User rejected approval request. Do not retry or use alternative methods; state clearly that the operation was rejected.",
              };
            }
          }
          if (
            config.customTools &&
            /bash|pwsh|run_code|terminal/.test(toolCall.name)
          ) {
            this.pendingShell.add(toolCall.id);
          }
          return undefined;
        },
        afterToolCall: async ({ toolCall }) => {
          if (config.customTools) {
            this.pendingShell.delete(toolCall.id);
          }
          return undefined;
        },
      });

      this.agent = agent;

      agent.subscribe((event) => {
        if (this.stopped) return;
        if (event.type === "message_end" && event.message.role === "assistant") {
          webSearch.decorateMessage(event.message);
        } else if (event.type === "turn_start") {
          step++;
          if (step > (config.maxSteps ?? 12)) {
            task.error = "Agent step budget exceeded";
            abort();
            return;
          }
          this.emit({
            step,
            phase: "thinking",
            summary: "@looi:runtimeAgentIsThinking",
          });
        } else if (event.type === "tool_execution_start") {
          startTool(event.toolCallId, event.toolName, event.args);
        } else if (event.type === "tool_execution_end") {
          endTool(event.toolCallId, event.toolName, event.result, event.isError, event.durationMs);
        }
      });

      timer = setTimeout(() => {
        task.error = "Task deadline exceeded";
        abort();
      }, config.deadlineMs ?? 180_000);

      if (this.stopped) {
        throw new Error("Task stopped before prompt execution");
      }
      task.state = "running";
      host.updateTask(task);

      await agent.prompt(userPrompt);

      if (this.stopped) throw new Error(task.error ?? "Task cancelled");
      if (this.pendingShell.size > 0) {
        throw new Error("Local execution exit is unconfirmed");
      }

      const assistantMessages = agent.state.messages.filter(
        (msg): msg is Extract<AgentMessage, { role: "assistant" }> =>
          msg.role === "assistant",
      );
      const lastAssistant = assistantMessages.at(-1);
      const stopReason = lastAssistant?.stopReason ?? "error";
      const finalResponse = lastAssistant
        ? contentText(lastAssistant.content).trim()
        : "";
      tracedAnswer = finalResponse;

      if (
        stopReason === "error" ||
        stopReason === "aborted" ||
        !finalResponse
      ) {
        const reason =
          lastAssistant?.errorMessage || stopReason || "no terminal response";
        throw new Error(`Pi agent did not complete successfully (${reason})`);
      }

      host.sessions.save(task.sessionId, agent.state.messages);

      const recordedArtifacts = artifacts.list();
      const output: AgentRunResult = {
        taskId: task.id,
        sessionId: task.sessionId,
        answer: finalResponse,
        steps: [...task.steps],
        toolCallsCount,
        durationMs: Date.now() - start,
        finishReason: "completed",
        runtimeExited: true,
        ...(executions.length > 0 ? { executions } : {}),
        ...(recordedArtifacts.length > 0 ? { artifacts: recordedArtifacts } : {}),
      };

      task.state = "succeeded";
      task.result = output;
      task.runtimeExited = true;
      host.updateTask(task);
      this.emit({ step, phase: "done", summary: finalResponse.slice(0, 160) });
      output.steps = [...task.steps];
      host.updateTask(task);
      return output;
    } catch (error) {
      traceError = true;
      const message = this.sanitize(
        error instanceof Error ? error.message : "Pi agent execution failed",
      );
      if (this.stopPromise) {
        await this.stopPromise;
      } else {
        task.runtimeExited = this.pendingShell.size === 0;
        task.state = task.runtimeExited ? "failed" : "unknown";
      }
      task.error ??= message;
      task.result = {
        taskId: task.id,
        sessionId: task.sessionId,
        answer: "",
        steps: [...task.steps],
        toolCallsCount,
        durationMs: Date.now() - start,
        finishReason: task.state === "cancelled" ? "cancelled" : "failed",
        runtimeExited: task.runtimeExited ?? false,
        executions: [...executions],
        artifacts: artifacts.list(),
      };
      this.emit({ step, phase: "error", summary: task.error });
      throw new AgentExecutionError(task.error, task.id);
    } finally {
      for (const span of toolTraces.values()) {
        span.end({ "langfuse.observation.level": "ERROR" });
      }
      trace?.end({
        "langfuse.observation.output": tracedAnswer ?? "",
        "langfuse.observation.metadata.toolCallsCount": toolCallsCount,
        ...(traceError ? { "langfuse.observation.level": "ERROR" } : {}),
      });
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      this.interactionGate.cancelPending();
      delete task.interaction;
      host.updateTask(task);
      host.onFinished(task.id);
    }
  }
}
