import fs from "node:fs";
import path from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { contentText, type AssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager, type AgentSession, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
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
import { buildAgentTurnPrompts } from "../prompts/index.js";
import {
  WorkspaceArtifactTracker,
  createWorkspaceCodingTools,
} from "../tools/index.js";
import { createPiSession, type PiSessionConfig } from "./pi-session.js";
import { createPiExtensionUi } from "./pi-extension-ui.js";
import { createOpenAIWebSearch, hasOpenAIWebSearch } from "./openai-web-search.js";
import type { LangfuseTracer, Observation, TraceContext } from "../../telemetry/langfuse.js";

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
    if (timer !== undefined) clearTimeout(timer);
  }
}

export interface PiTaskRunnerConfig extends PiSessionConfig {
  systemPrompt?: string;
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
  sessionsDirectory: string;
  isExecutorClosed: () => boolean;
  updateTask: (task: AgentTask) => void;
  onFinished: (taskId: string) => void;
}

/**
 * Binds one official Pi AgentSession to App task records, shell handles,
 * interaction UI, execution budgets and bounded shutdown.
 */
export class PiTaskRunner {
  readonly promise: Promise<AgentRunResult>;
  private session?: AgentSession;
  private resolveSession!: (session: AgentSession | undefined) => void;
  private readonly sessionReady = new Promise<AgentSession | undefined>((resolve) => { this.resolveSession = resolve; });
  private resolveStartup!: (session: AgentSession | undefined) => void;
  private readonly startupDone = new Promise<AgentSession | undefined>((resolve) => { this.resolveStartup = resolve; });
  private extensionsStarted = false;
  private shutdownPromise?: Promise<void>;
  private shutdownFailure?: string;
  private stopPromise?: Promise<AgentStopResult>;
  private stopped = false;
  private readonly pendingShell = new Set<string>();
  private readonly killShells = new Set<() => void>();
  private readonly interactionGate: InteractionGate;
  private trace?: Observation;
  private generationContext?: TraceContext;

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

  async sendMessage(message: string, behavior: "steer" | "followUp"): Promise<"queued" | "handled"> {
    const session = await this.sessionReady;
    if (!session || this.stopped || !session.isStreaming) {
      throw new AgentExecutionError(this.task.error ?? "Task has no active Pi run", this.task.id);
    }
    return behavior === "steer" ? session.steer(message) : session.followUp(message);
  }

  cancel(): Promise<AgentStopResult> {
    if (this.stopPromise) return this.stopPromise;

    this.stopped = true;
    this.interactionGate.cancelPending();
    for (const kill of this.killShells) kill();
    this.task.state = "cancelling";
    this.host.updateTask(this.task);

    this.stopPromise = (async () => {
      const graceMs = this.host.config.stopGraceMs ?? 3000;
      const agentExited = await awaitWithin(this.stopRuntime(), graceMs);
      const runtimeExited = agentExited && this.pendingShell.size === 0;
      const confirmed = runtimeExited;
      this.task.runtimeExited = runtimeExited;
      this.task.state = confirmed ? "cancelled" : "unknown";
      if (!confirmed) {
        this.task.error ??= this.shutdownFailure ??
          `Pi runtime stop exceeded ${graceMs} ms; startup, extension shutdown or local execution exit is unconfirmed`;
      }
      this.host.updateTask(this.task);
      return { state: this.task.state, runtimeExited, confirmed };
    })();
    return this.stopPromise;
  }

  private async stopRuntime(): Promise<void> {
    const session = await this.startupDone;
    if (!session) return;
    await session.abort();
    this.shutdownPromise ??= (async () => {
      try {
        if (this.extensionsStarted) await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        if (this.shutdownFailure) throw new Error(this.shutdownFailure);
      } finally {
        session.dispose();
      }
      await session.settingsManager.flush();
      const settingsErrors = session.settingsManager.drainErrors();
      if (settingsErrors.length) throw new Error(settingsErrors.map(item => `${item.scope} ${item.path ?? ""}: ${item.error.message}`).join("; "));
    })().catch((error) => {
      this.shutdownFailure = `Pi session shutdown failed: ${error instanceof Error ? error.message : String(error)}`;
      throw error;
    });
    await this.shutdownPromise;
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
    return key ? message.replaceAll(key, "[redacted]") : message;
  }

  private async waitForInteraction(kind: "approval" | "question", details: Record<string, unknown>, signal?: AbortSignal): Promise<AgentInteractionAnswer> {
    const observation = this.host.config.tracer?.start(`agent.${kind}`, "span", this.generationContext ?? this.trace?.context, {
      "langfuse.observation.input": details,
    });
    try {
      const answer = await this.interactionGate.wait(kind, details, signal);
      observation?.end({ "langfuse.observation.output": answer });
      return answer;
    } catch (error) {
      observation?.end({ "langfuse.observation.level": "ERROR", "langfuse.observation.status_message": String(error) });
      throw error;
    }
  }

  private async execute(): Promise<AgentRunResult> {
    const { task, prompt, options, host } = this;
    const { config } = host;
    const start = Date.now();
    const trace = config.tracer?.start(
      "agent.run",
      "agent",
      options.traceContext ?? (options.resume && task.trace ? {
        traceId: task.trace.traceId, parentSpanId: task.trace.spanId,
        traceName: "agent.run", sessionId: task.sessionId,
      } : {
        traceId: "",
        traceName: "agent.run",
        sessionId: task.sessionId,
      }),
      {
        "langfuse.observation.input": prompt,
        "langfuse.observation.metadata.taskId": task.id,
        "langfuse.observation.metadata.mode": options.mode ?? "text",
      },
    );
    this.trace = trace;
    if (trace?.spanId) {
      task.trace = { traceId: trace.context.traceId, spanId: trace.spanId };
      host.updateTask(task);
    }
    const toolTraces = new Map<string, Observation>();
    let tracedAnswer: string | undefined;
    let traceError = false;
    let toolCallsCount = 0;
    let step = 0;
    let lastAssistant: AssistantMessage | undefined;
    let promptHandled = false;
    const commandOutput: string[] = [];
    const extensionErrors: string[] = [];
    const executions: AgentCommandEvidence[] = [];
    const artifacts = new WorkspaceArtifactTracker(task.workspaceRoot, start);
    let timer: ReturnType<typeof setTimeout> | undefined;

    const abort = () => {
      void this.cancel().catch(() => {});
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    timer = setTimeout(() => {
      task.error = "Task deadline exceeded";
      abort();
    }, config.deadlineMs ?? 180_000);

    try {
      if (this.stopped) {
        throw new Error("Task cancelled before runtime startup");
      }
      fs.mkdirSync(task.workspaceRoot, { recursive: true });

      const sessionFile = SessionManager.findById(
        task.workspaceRoot, task.sessionId, host.sessionsDirectory,
      );
      if (options.resume && !sessionFile) {
        throw new Error("Persisted session transcript was not found");
      }
      const manager = sessionFile
        ? SessionManager.open(sessionFile)
        : SessionManager.create(task.workspaceRoot, host.sessionsDirectory, { id: task.sessionId });
      const startTool = (callId: string, toolName: string, args: unknown) => {
        if (this.stopped) return;
        if (trace && config.tracer) {
          toolTraces.set(
            callId,
            config.tracer.start(`agent.tool.${toolName}`, "tool", this.generationContext ?? trace.context, {
              "langfuse.observation.input": args,
              "langfuse.observation.metadata.callId": callId,
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
        if (event.phase === "start") startTool(event.callId, "web_search", { type: "provider_hosted" });
        else {
          endTool(event.callId, "web_search", event.result, event.result?.status === "failed");
        }
      });
      const contribution = config.taskTools?.({ taskId: task.id, workspaceRoot: task.workspaceRoot, approvalMode: options.approvalMode ?? "ask", commandTimeoutMs: config.commandTimeoutMs ?? 300_000 });
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
            this.waitForInteraction(
              "question",
              {
                requestId,
                sessionId: task.sessionId,
                questions,
              },
              signal,
            ),
          additionalTools: [...(config.additionalTools ?? []), ...(contribution?.tools ?? [])],
        });

      const extension: ExtensionFactory = (pi) => {
        pi.on("before_agent_start", (event, ctx) => {
          this.resolveSession(this.session);
          const { systemPrompt } = buildAgentTurnPrompts({
            baseSystemPrompt: event.systemPrompt + (config.systemPrompt ? `\n${config.systemPrompt}` : ""),
            prompt: event.messageType === "user" ? event.prompt : prompt,
            mode: options.mode,
            defaultLanguage: options.defaultLanguage,
            restoredMessages: manager.buildSessionContext().messages,
            webSearchEnabled: ctx.model ? hasOpenAIWebSearch(ctx.model) : false,
          });
          return { systemPrompt };
        });
        pi.on("before_provider_request", (event, ctx) =>
          ctx.model ? webSearch.onPayload(event.payload, ctx.model) : undefined,
        );
        pi.on("provider_stream_event", (event, ctx) => {
          if (ctx.model) return webSearch.onProviderStreamEvent(event.data, ctx.model);
        });
        pi.on("message_end", (event) => {
          if (event.message.role === "assistant") webSearch.decorateMessage(event.message);
        });
        pi.on("tool_call", async (event, ctx) => {
          if (host.isExecutorClosed() || this.stopped) {
            return { block: true, reason: "Task was stopped; no further tool execution is permitted." };
          }
          const details = host.approvalPolicy({
            callId: event.toolCallId,
            toolName: event.toolName,
            arguments: event.input,
            sessionId: task.sessionId,
            workspaceRoot: task.workspaceRoot,
            approvalMode: options.approvalMode ?? "ask",
          });
          if (details) {
            const decision = await this.waitForInteraction("approval", details);
            if (!("outcome" in decision) || decision.outcome !== "allowed-once") {
              return { block: true, reason: "User rejected approval request. Do not retry or use alternative methods; state clearly that the operation was rejected." };
            }
          }
          if (config.customTools && /bash|pwsh|run_code|terminal/.test(event.toolName)) {
            this.pendingShell.add(event.toolCallId);
          }
        });
        pi.on("tool_result", (event) => {
          if (config.customTools) this.pendingShell.delete(event.toolCallId);
          if (["read", "write", "edit"].includes(event.toolName) && !event.isError && typeof event.input.path === "string") {
            artifacts.record(path.resolve(task.workspaceRoot, event.input.path));
          }
        });
        pi.on("context_with_system", (event) => {
          config.tracer?.start("agent.context", "span", trace?.context, {
            "langfuse.observation.input": {
              sessionId: task.sessionId,
              history: event.messages.filter(message => message.role !== "system"),
              systemPrompt: event.messages.find(message => message.role === "system"),
            },
          }).end({ "langfuse.observation.output": { historyMessages: event.messages.filter(message => message.role !== "system").length } });
        });
      };
      const session = await createPiSession({
        config: { ...config, resources: { ...config.resources, additionalSkillPaths: [...(config.resources?.additionalSkillPaths ?? []), ...(contribution?.skillPaths ?? [])] } },
        workspaceRoot: task.workspaceRoot,
        stateDirectory: path.dirname(host.sessionsDirectory),
        sessionManager: manager,
        extension,
        tools,
        tracer: config.tracer,
        getTraceContext: () => trace?.context,
        onGeneration: (context) => { this.generationContext = context; },
      });
      this.session = session;
      if (this.stopped) {
        this.resolveStartup(session);
        throw new Error("Task stopped during Pi session startup");
      }
      this.extensionsStarted = true;
      await session.bindExtensions({
        mode: "rpc",
        uiContext: createPiExtensionUi(session, {
          interact: (kind, details, signal) => this.waitForInteraction(kind, details, signal),
          notify: (message, level) => {
            commandOutput.push(message);
            if (level === "error") extensionErrors.push(message);
            this.emit({ step, phase: "thinking", summary: message });
            config.tracer?.start("agent.extension.notice", "span", trace?.context, {
              "langfuse.observation.output": message,
              "langfuse.observation.level": level === "error" ? "ERROR" : level === "warning" ? "WARNING" : "DEFAULT",
            }).end();
          },
        }),
        onError: (error) => {
          const reason = `Pi extension ${error.extensionPath} (${error.event}): ${error.error}`;
          extensionErrors.push(reason);
          if (error.event === "session_shutdown") this.shutdownFailure = reason;
          this.emit({ step, phase: "error", summary: reason });
          config.tracer?.start("agent.extension.error", "span", trace?.context, {
            "langfuse.observation.level": "ERROR",
            "langfuse.observation.status_message": reason,
          }).end();
        },
      });
      this.resolveStartup(session);

      session.subscribe((event) => {
        if (event.type === "message_end" && event.message.role === "assistant") lastAssistant = event.message;
        if (this.stopped) return;
        if (event.type === "compaction_start" || event.type === "compaction_end" ||
            event.type === "auto_retry_start" || event.type === "auto_retry_end" || event.type === "queue_update") {
          config.tracer?.start(`agent.pi.${event.type}`, "span", trace?.context, {
            "langfuse.observation.output": event,
            ...("errorMessage" in event && event.errorMessage ? {
              "langfuse.observation.status_message": event.errorMessage,
              "langfuse.observation.level": "ERROR",
            } : {}),
          }).end();
          const summary = event.type === "compaction_start" ? "正在整理会话上下文"
            : event.type === "compaction_end" ? event.errorMessage ?? "会话上下文已整理"
            : event.type === "auto_retry_start" ? `模型请求重试 ${event.attempt}/${event.maxAttempts}：${event.errorMessage}`
            : event.type === "auto_retry_end" ? event.finalError ?? "模型请求已恢复"
            : `待处理消息：${event.steering.length + event.followUp.length}`;
          this.emit({ step, phase: "thinking", summary });
        }
        if (event.type === "turn_start") {
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

      if (this.stopped) {
        throw new Error("Task stopped before prompt execution");
      }
      task.state = "running";
      host.updateTask(task);

      await session.prompt(prompt, { preflightResult: disposition => { promptHandled = disposition === "handled"; } });
      await session.waitForIdle();

      if (this.stopped) throw new Error(task.error ?? "Task cancelled");
      if (this.pendingShell.size > 0) {
        throw new Error("Local execution exit is unconfirmed");
      }

      if (promptHandled && extensionErrors.length) throw new Error(extensionErrors.join("\n"));
      const stopReason = lastAssistant?.stopReason ?? (promptHandled ? "stop" : "error");
      const finalResponse = lastAssistant
        ? contentText(lastAssistant.content).trim()
        : promptHandled ? commandOutput.join("\n") || `Pi command completed: ${prompt.split(/\s/, 1)[0]}` : "";
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

      const shutdownGraceMs = config.stopGraceMs ?? 3000;
      if (!await awaitWithin(this.stopRuntime(), shutdownGraceMs)) {
        task.error = this.shutdownFailure ?? `Pi session shutdown exceeded ${shutdownGraceMs} ms`;
        task.state = "unknown";
        task.runtimeExited = false;
        throw new Error(task.error);
      }
      if (this.stopped) throw new Error(task.error ?? "Task cancelled during session shutdown");

      const recordedArtifacts = artifacts.list();
      const output: AgentRunResult = {
        taskId: task.id,
        sessionId: task.sessionId,
        answer: finalResponse,
        steps: [...task.steps],
        toolCallsCount,
        durationMs: Date.now() - start,
        finishReason: promptHandled ? "handled" : "completed",
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
      this.resolveStartup(this.session);
      traceError = true;
      const message = this.sanitize(
        error instanceof Error ? error.message : "Pi agent execution failed",
      );
      if (this.stopPromise) {
        await this.stopPromise;
      } else if (task.state !== "unknown") {
        const graceMs = config.stopGraceMs ?? 3000;
        const exited = await awaitWithin(this.stopRuntime(), graceMs);
        task.runtimeExited = exited && this.pendingShell.size === 0;
        task.state = task.runtimeExited ? "failed" : "unknown";
        if (!exited) task.error ??= `${message}\n${this.shutdownFailure ?? `Pi session shutdown exceeded ${graceMs} ms`}`;
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
      this.resolveSession(undefined);
      this.resolveStartup(this.session);
      for (const span of toolTraces.values()) {
        span.end({ "langfuse.observation.level": "ERROR" });
      }
      trace?.end({
        "langfuse.observation.output": tracedAnswer ?? "",
        "langfuse.observation.metadata.toolCallsCount": toolCallsCount,
        "langfuse.observation.metadata.state": task.state,
        ...(task.error ? { "langfuse.observation.status_message": task.error } : {}),
        ...(traceError ? { "langfuse.observation.level": "ERROR" } : {}),
      });
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      this.session?.dispose();
      this.interactionGate.cancelPending();
      delete task.interaction;
      host.updateTask(task);
      host.onFinished(task.id);
    }
  }
}
