import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { DeepSeekHarness, type DeepSeekHarnessOptions, type HarnessNotification, type SdkUserQuestionResult } from "@deepseek-ai/dsh-sdk-client";
import { AgentExecutionError, type AgentExecutor, type AgentTask, type AgentRunOptions, type AgentRunResult, type AgentStepEvent, type AgentInteractionAnswer, type AgentStopResult } from "./executor.js";
import { AgentTaskStore } from "./task-store.js";
import { MemoryToolBridge } from "./memory-bridge.js";
import type { PersonalMemoryStore } from "./personal-memory.js";
import { RECEIPTS_PLUGIN } from "./receipts-plugin.js";

interface RuntimeResult { finalResponse: string; finishReason: string | null }
export interface DshHarness {
  client: { start(): void; onRequest(handler: (method: string, params: Record<string, unknown>) => Promise<unknown>): void };
  start(): Promise<void>;
  session(id?: string): { id: string; run(input: string, options?: { onNotification?: (notification: HarnessNotification) => void }): Promise<RuntimeResult> };
  resumeSession(id: string): Promise<{ id: string; run(input: string, options?: { onNotification?: (notification: HarnessNotification) => void }): Promise<RuntimeResult> }>;
  close(): Promise<void>;
}

export interface DshExecutorConfig {
  memoryStore: PersonalMemoryStore;
  stateDirectory?: string;
  workspaceRoot?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  deadlineMs?: number;
  maxSteps?: number;
  maxToolCalls?: number;
  maxConcurrentTasks?: number;
  interactionTimeoutMs?: number;
  harnessFactory?: (options: DeepSeekHarnessOptions) => DshHarness;
}

interface Worker {
  harness?: DshHarness;
  promise?: Promise<AgentRunResult>;
  stop?: Promise<AgentStopResult>;
  stopped: boolean;
  pendingShell: Set<string>;
  revoke?: () => void;
  pending?: { id: string; settle: (answer: AgentInteractionAnswer) => void };
}

/** Owns runtime lifetimes; the official Harness owns every model/tool turn. */
export class DshAgentExecutor implements AgentExecutor {
  private readonly store: AgentTaskStore;
  private readonly bridge: MemoryToolBridge;
  private readonly workers = new Map<string, Worker>();
  private readonly root: string;
  private closed = false;
  private closing?: Promise<void>;

  constructor(private readonly config: DshExecutorConfig) {
    this.root = path.resolve(config.stateDirectory ?? process.env.DSH_STATE_DIRECTORY ?? "data/dsh");
    this.store = new AgentTaskStore(path.join(this.root, "tasks"));
    this.bridge = new MemoryToolBridge(config.memoryStore);
  }

  getTask(id: string): AgentTask | undefined {
    const task = this.store.get(id);
    return task ? structuredClone(task) : undefined;
  }
  listTasks(): AgentTask[] { return structuredClone(this.store.list()); }

  run(prompt: string, options: AgentRunOptions = {}): Promise<AgentRunResult> {
    if (this.closed) return Promise.reject(new AgentExecutionError("Agent executor is closed"));
    if (!prompt.trim()) return Promise.reject(new AgentExecutionError("prompt is required"));
    if (options.signal?.aborted) return Promise.reject(new AgentExecutionError("Task aborted before admission"));
    const id = options.taskId ?? `task_${randomUUID()}`;
    this.store.assertId(id);
    const previous = this.store.get(id);
    const active = this.workers.get(id);
    if (active) {
      if (previous?.prompt !== prompt) return Promise.reject(new AgentExecutionError("Task id already belongs to another prompt", id));
      return active.promise!;
    }
    if (previous && !options.resume) {
      if (previous.prompt !== prompt) return Promise.reject(new AgentExecutionError("Task id already belongs to another prompt", id));
      if (previous.result && previous.state === "succeeded") return Promise.resolve(structuredClone(previous.result));
      return Promise.reject(new AgentExecutionError("Task already exists; inspect its outcome or explicitly resume", id));
    }
    if (options.resume && !previous) return Promise.reject(new AgentExecutionError("Task to resume was not found", id));
    if (this.workers.size >= (this.config.maxConcurrentTasks ?? 2)) return Promise.reject(new AgentExecutionError("Agent worker capacity reached"));
    const workspaceRoot = previous?.workspaceRoot ?? path.resolve(this.config.workspaceRoot ?? process.env.DSH_WORKSPACE_ROOT ?? "data/agent-workspace");
    if (options.workspaceRoot && previous && path.resolve(options.workspaceRoot) !== workspaceRoot) return Promise.reject(new AgentExecutionError("Cannot change a persisted task workspace", id));
    const task: AgentTask = previous ?? {
      id, sessionId: `session_${randomUUID()}`, workspaceRoot: path.resolve(options.workspaceRoot ?? workspaceRoot), prompt,
      state: "queued", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), steps: [],
    };
    task.state = "queued";
    task.runtimeExited = false;
    if (options.resume) task.prompt = prompt;
    delete task.result; delete task.error; delete task.interaction;
    this.store.save(task);
    const worker: Worker = { stopped: false, pendingShell: new Set() };
    this.workers.set(id, worker);
    // Defer execution until promise is published, so deduplication is synchronous.
    worker.promise = Promise.resolve().then(() => this.execute(task, prompt, options, worker));
    return worker.promise;
  }

  private update(task: AgentTask): void {
    task.updatedAt = new Date().toISOString();
    this.store.save(task);
  }

  private async execute(task: AgentTask, prompt: string, options: AgentRunOptions, worker: Worker): Promise<AgentRunResult> {
    const start = Date.now();
    let toolCallsCount = 0;
    let step = 0;
    const observedFiles = new Set<string>();
    const observedCalls = new Map<string, { name: string; command?: string }>();
    const completedCalls = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const emit = (event: Omit<AgentStepEvent, "taskId" | "sessionId">) => {
      const item = { ...event, taskId: task.id, sessionId: task.sessionId, interaction: task.interaction ? structuredClone(task.interaction) : undefined };
      task.steps.push(item);
      if (task.steps.length > 300) task.steps.shift();
      this.update(task);
      // A disconnected observer must not take down the execution or hide its outcome.
      try { options.onStep?.(item); } catch { /* product transport is optional */ }
    };
    const abort = () => { void this.cancel(task.id).catch(() => {}); };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    try {
      const baseUrl = this.config.baseUrl ?? process.env.LLM_BASE_URL;
      const apiKey = this.config.apiKey ?? process.env.LLM_API_KEY;
      const model = this.config.model ?? process.env.LLM_MODEL;
      if (!baseUrl || !apiKey || !model) throw new Error("DSH requires LLM_BASE_URL, LLM_API_KEY and LLM_MODEL");
      if (worker.stopped) throw new Error("Task cancelled before runtime startup");
      const home = path.join(this.root, "workers", task.id);
      const launch = path.join(home, "launch");
      fs.mkdirSync(launch, { recursive: true, mode: 0o700 });
      fs.mkdirSync(task.workspaceRoot, { recursive: true });
      if (fs.existsSync(path.join(home, ".env")) || fs.existsSync(path.join(launch, ".env"))) throw new Error("DSH launch/home must not contain .env files");
      const capability = await this.bridge.grant();
      worker.revoke = capability.revoke;
      if (worker.stopped) throw new Error("Task cancelled during preparation");
      const patch = path.join(home, "looi.patch.json");
      const receiptPlugin = path.join(home, "receipts.mjs");
      fs.writeFileSync(receiptPlugin, RECEIPTS_PLUGIN, { mode: 0o600 });
      const disabled = ["session-log-deepseek", "session-telemetry-otel", "tool-subagent", "tool-subagent-fork", "tool-subagent-control", "tool-workflow", "workflow-ptc", "tool-jobs", "tool-plugin-manager"];
      fs.writeFileSync(patch, JSON.stringify([
        ...disabled.map(id => ({ id, disabled: true })),
        { id: "agent-loop", config: { agents: [], maxParallelToolCalls: 1 } },
        { id: "sandbox-policy", config: { mode: "workspace-write", workspaceRoot: task.workspaceRoot } },
        { id: "tool-bash", config: { enableRunInBackground: false, promoteOnTimeout: false } },
        { id: "tool-pwsh", config: { enableRunInBackground: false, promoteOnTimeout: false } },
        { id: "system-prompt", config: { personaPrefix: "你是 LOOI 的任务执行助手。使用真实工具完成任务；个人记忆使用 mcp__looi__memory。不要把失败说成已完成。不要启动后台进程或脱离管理的作业。" } },
        { id: "llm-pi-ai", config: { providers: { looi: {
          api: "openai-completions", baseURL: baseUrl, apiKeyEnv: "LOOI_DSH_MODEL_KEY",
          models: [{ id: model, reasoning: false, input: ["text"], contextWindow: 32768, maxTokens: 4096 }],
          timeoutMs: 30000, streamIdleTimeoutMs: 30000, retryPolicy: { mode: "normal", maxRetries: 0 },
        } } } },
        { insert: [{ id: "looi-receipts", name: pathToFileURL(receiptPlugin).href, config: { url: capability.receiptUrl, token: capability.token } }, { id: "looi-memory", name: "@deepseek-ai/dsh-mcp-client", config: {
          serverName: "looi", transport: "streamable-http", url: capability.url,
          headers: { Authorization: `Bearer ${capability.token}` }, failOnStartupError: true, toolCallTimeoutMs: 10000,
        } }] },
      ]), { mode: 0o600 });
      const env: NodeJS.ProcessEnv = {};
      for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "SystemRoot"]) if (process.env[key]) env[key] = process.env[key];
      env.LOOI_DSH_MODEL_KEY = apiKey;
      env.DSH_PERMISSION_MODE = "workspace-write";
      const factory = this.config.harnessFactory ?? (settings => new DeepSeekHarness(settings));
      worker.harness = factory({
        profile: "sdk", dshHome: home, processCwd: launch, cwd: task.workspaceRoot, env, patches: [patch],
        provider: "looi", model, maxTokens: 2048, approvalRequests: true, initializeTimeoutMs: 30000,
        onUserQuestion: async (request, context) => this.waitForInteraction(task, worker, "question", request as unknown as Record<string, unknown>, emit, context.signal) as Promise<SdkUserQuestionResult>,
      });
      worker.harness.client.start();
      worker.harness.client.onRequest(async (method, params) => {
        if (method !== "approval/request") throw new Error("Unsupported runtime request");
        return this.waitForInteraction(task, worker, "approval", { ...params, command: observedCalls.get(String(params.callId))?.command }, emit);
      });
      timer = setTimeout(() => { task.error = "Task deadline exceeded"; abort(); }, this.config.deadlineMs ?? 180000);
      await worker.harness.start();
      if (!this.config.harnessFactory && !capability.ready()) throw new Error("DSH memory tool discovery did not complete");
      if (worker.stopped) throw new Error("Task stopped during runtime startup");
      const session = options.resume ? await worker.harness.resumeSession(task.sessionId) : worker.harness.session(task.sessionId);
      task.state = "running";
      this.update(task);
      const result = await session.run(
        `${options.mode === "voice" ? "最终回答用简短自然的中文，适合语音口播。\n" : ""}${prompt}`,
        { onNotification: notification => {
          if (notification.method !== "session.event" || notification.params.sessionId !== task.sessionId || worker.stopped) return;
          const event = notification.params.event as { type?: string; data?: Record<string, unknown> };
          const data = event.data ?? {};
          if (event.type === "step/start") {
            step++;
            if (step > (this.config.maxSteps ?? 12)) { task.error = "Agent step budget exceeded"; abort(); return; }
            emit({ step, phase: "thinking", summary: "DSH 正在思考…" });
          } else if (event.type === "tool/call") {
            toolCallsCount++;
            if (toolCallsCount > (this.config.maxToolCalls ?? 32)) { task.error = "Agent tool budget exceeded"; abort(); return; }
            const toolName = String(data.name ?? "tool");
            let args: { command?: string } | undefined;
            try { args = typeof data.arguments === "string" ? JSON.parse(data.arguments) : data.arguments as typeof args; }
            catch { /* Invalid model JSON cannot become a command receipt. */ }
            observedCalls.set(String(data.callId), { name: toolName, command: args?.command });
            if (/bash|pwsh|run_code|terminal/.test(toolName)) worker.pendingShell.add(String(data.callId));
            emit({ step, phase: "tool_start", toolName, summary: `DSH · ${toolName}` });
          } else if (event.type === "tool/result") {
            const message = data.message as { toolCallId?: string; isError?: boolean } | undefined;
            worker.pendingShell.delete(String(message?.toolCallId ?? data.callId));
            if (message?.toolCallId && message.isError === false) completedCalls.add(message.toolCallId);
            const meta = data.meta as { path?: string } | undefined;
            if (typeof meta?.path === "string") observedFiles.add(meta.path);
            emit({ step, phase: "tool_end", summary: "工具已返回结果" });
          }
        } },
      );
      if (worker.stopped) throw new Error(task.error ?? "Task cancelled");
      if (result.finishReason !== "completed" || !result.finalResponse.trim()) throw new Error(`DSH did not complete successfully (${result.finishReason ?? "no terminal reason"})`);
      await worker.harness.close();
      if (worker.stopped) throw new Error(task.error ?? "Task cancelled during runtime shutdown");
      const executions = new Map<string, (typeof capability.executions)[number]>();
      for (const receipt of capability.executions) {
        const call = observedCalls.get(receipt.callId);
        if (call?.name !== "bash" || call.command !== receipt.command || !completedCalls.has(receipt.callId)) throw new Error("Command receipt does not match an observed official tool execution");
        const previous = executions.get(receipt.callId);
        if (previous && JSON.stringify(previous) !== JSON.stringify(receipt)) throw new Error("Conflicting command receipts");
        executions.set(receipt.callId, receipt);
      }
      const artifacts: NonNullable<AgentRunResult["artifacts"]> = [];
      const workspace = fs.realpathSync(task.workspaceRoot);
      for (const file of observedFiles) {
        try {
          const real = fs.realpathSync(file);
          const relative = path.relative(workspace, real);
          if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) continue;
          const stat = fs.statSync(real);
          if (!stat.isFile() || stat.size > 8 * 1024 * 1024) continue;
          artifacts.push({ path: relative, sha256: createHash("sha256").update(fs.readFileSync(real)).digest("hex"), size: stat.size });
        } catch { /* Missing/unreadable files are never a verified artifact. */ }
      }
      const output: AgentRunResult = {
        taskId: task.id, sessionId: task.sessionId, answer: result.finalResponse,
        steps: [...task.steps], toolCallsCount, durationMs: Date.now() - start, finishReason: result.finishReason, runtimeExited: true, executions: [...executions.values()], artifacts,
      };
      task.state = "succeeded"; task.result = output; task.runtimeExited = true; this.update(task);
      emit({ step, phase: "done", summary: result.finalResponse.slice(0, 160) });
      output.steps = [...task.steps]; this.update(task);
      return output;
    } catch (error) {
      const message = this.sanitize(error instanceof Error ? error.message : "DSH execution failed");
      if (worker.stop) await worker.stop;
      else {
        try { await worker.harness?.close(); task.runtimeExited = !!worker.harness; task.state = worker.pendingShell.size ? "unknown" : "failed"; }
        catch { task.state = "unknown"; }
      }
      task.error ??= message;
      emit({ step, phase: "error", summary: task.error });
      throw new AgentExecutionError(task.error, task.id);
    } finally {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      worker.revoke?.();
      worker.pending?.settle({ cancelled: true });
      delete task.interaction;
      this.update(task);
      this.workers.delete(task.id);
    }
  }

  private sanitize(message: string): string {
    const key = this.config.apiKey ?? process.env.LLM_API_KEY;
    return (key ? message.replaceAll(key, "[redacted]") : message).slice(0, 500);
  }

  private waitForInteraction(task: AgentTask, worker: Worker, kind: "approval" | "question", details: Record<string, unknown>, emit: (event: Omit<AgentStepEvent, "taskId" | "sessionId">) => void, signal?: AbortSignal): Promise<AgentInteractionAnswer> {
    if (worker.stopped || signal?.aborted) return Promise.resolve(kind === "approval" ? { outcome: "cancelled" } : { cancelled: true });
    if (worker.pending) return Promise.reject(new Error("Concurrent interactive requests are not supported"));
    const id = randomUUID();
    const timeout = this.config.interactionTimeoutMs ?? 120000;
    task.interaction = { id, kind, details, expiresAt: new Date(Date.now() + timeout).toISOString() };
    task.state = kind === "approval" ? "awaiting_approval" : "awaiting_input";
    return new Promise(resolve => {
      const dismiss = () => settle(kind === "approval" ? { outcome: "cancelled" } : { cancelled: true });
      const timer = setTimeout(dismiss, timeout);
      const settle = (answer: AgentInteractionAnswer) => {
        clearTimeout(timer); signal?.removeEventListener("abort", dismiss);
        worker.pending = undefined; delete task.interaction;
        if (!worker.stopped) task.state = "running";
        this.update(task); resolve(answer);
      };
      worker.pending = { id, settle };
      signal?.addEventListener("abort", dismiss, { once: true });
      emit({ step: task.steps.at(-1)?.step ?? 0, phase: kind === "approval" ? "awaiting_approval" : "awaiting_input", summary: kind === "approval" ? "此操作需要确认" : "DSH 正在等待你的回答" });
    });
  }

  respond(taskId: string, requestId: string, answer: AgentInteractionAnswer): void {
    const task = this.store.get(taskId);
    const worker = this.workers.get(taskId);
    if (!task?.interaction || !worker?.pending || worker.pending.id !== requestId || task.interaction.id !== requestId || worker.stopped) throw new Error("Interaction is no longer pending");
    if (Date.parse(task.interaction.expiresAt) <= Date.now()) throw new Error("Interaction has expired");
    if (task.interaction.kind === "approval") {
      if (!("outcome" in answer) || !["allowed-once", "rejected", "cancelled"].includes(answer.outcome)) throw new Error("Invalid approval answer");
    } else if (!("answers" in answer) && !("cancelled" in answer)) throw new Error("Invalid question answer");
    worker.pending.settle(answer);
  }

  async cancel(taskId: string): Promise<AgentStopResult> {
    const task = this.store.get(taskId);
    if (!task) throw new Error("Task not found");
    if (["succeeded", "failed", "cancelled"].includes(task.state)) return { state: task.state, runtimeExited: task.runtimeExited ?? false, confirmed: task.state === "cancelled" };
    const worker = this.workers.get(taskId);
    if (!worker) return { state: task.state, runtimeExited: false, confirmed: false };
    if (worker.stop) return worker.stop;
    worker.stopped = true; worker.revoke?.();
    worker.pending?.settle(task.interaction?.kind === "approval" ? { outcome: "cancelled" } : { cancelled: true });
    task.state = "cancelling"; this.update(task);
    worker.stop = (async () => {
      let runtimeExited = false;
      try { await worker.harness?.close(); runtimeExited = !!worker.harness; } catch { /* retain uncertainty */ }
      const confirmed = (!worker.harness || runtimeExited) && worker.pendingShell.size === 0;
      task.runtimeExited = runtimeExited;
      task.state = confirmed ? "cancelled" : "unknown";
      if (!confirmed) task.error = "Runtime stop requested; external process outcome requires verification";
      this.update(task);
      return { state: task.state, runtimeExited, confirmed };
    })();
    return worker.stop;
  }

  close(): Promise<void> {
    return this.closing ??= this.closeWorkers();
  }

  private async closeWorkers(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.workers.keys()].map(id => this.cancel(id)));
    await Promise.allSettled([...this.workers.values()].map(worker => worker.promise));
    await this.bridge.close();
  }
}
