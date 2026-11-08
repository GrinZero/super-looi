import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  Agent,
  type AgentMessage,
  type AgentTool,
  type BeforeToolCallResult,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import {
  contentText,
  createModels,
  createProvider,
  type Api,
  type Model,
  type Models,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { arr, obj, opt, str } from "@earendil-works/pi-schema";
import {
  AgentExecutionError,
  type AgentCommandEvidence,
  type AgentExecutor,
  type AgentInteractionAnswer,
  type AgentRunOptions,
  type AgentRunResult,
  type AgentStepEvent,
  type AgentStopResult,
  type AgentTask,
} from "./executor.js";
import { AgentTaskStore, type TaskPersistence } from "./task-store.js";
import type { PersonalMemoryStore } from "./personal-memory.js";
import { assertFreshUiAction } from "../productivity/authorization.js";
import type { LangfuseTracer, Observation } from "../telemetry/langfuse.js";
import { wrapStreamFnWithLangfuse } from "../telemetry/llm-observer.js";

const HIGH_RISK_COMMAND = [
  /rm\s+-rf/i,
  /git\s+push\s+.*--force/i,
  /\bdd\b/i,
  /\bmkfs\b/i,
  /\bsudo\b/i,
  />\s*\/dev\//i,
];

const SAFE_SYSTEM_PREFIXES = [
  "/bin/",
  "/usr/bin/",
  "/usr/local/bin/",
  "/opt/homebrew/bin/",
  "/dev/null",
];
const MAX_OUTPUT_CHARS = 16000;
const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;

async function awaitWithin(
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

export interface PiExecutorConfig {
  tracer?: LangfuseTracer;
  taskPersistence?: TaskPersistence;
  memoryStore?: PersonalMemoryStore;
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
  stopGraceMs?: number;
  streamFn?: StreamFn;
  modelSpec?: Model<Api>;
  customTools?: AgentTool<any>[];
  additionalTools?: AgentTool<any>[];
  approvalRequiredTools?: readonly string[];
  requireApprovalForAllWrites?: boolean;
  /** Native callers bind approvals to the current foreground UI session. */
  approvalUiSessionId?: string;
  modelsRegistry?: Models;
  providerId?: string;
}

export type PiAgentExecutorConfig = PiExecutorConfig;

interface Worker {
  agent?: Agent;
  promise?: Promise<AgentRunResult>;
  stop?: Promise<AgentStopResult>;
  stopped: boolean;
  pendingShell: Set<string>;
  killShells: Set<() => void>;
  pending?: { id: string; settle: (answer: AgentInteractionAnswer) => void };
}

function resolveRealAncestor(targetPath: string): string {
  const resolved = path.resolve(targetPath);
  let current = resolved;
  const suffix: string[] = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    suffix.unshift(path.basename(current));
    current = parent;
  }
  try {
    const realBase = fs.realpathSync(current);
    return suffix.length > 0 ? path.join(realBase, ...suffix) : realBase;
  } catch {
    return resolved;
  }
}

function resolveWorkspacePath(
  workspaceRoot: string,
  targetPath: string,
): { resolved: string; relative: string; inside: boolean } {
  const root = path.resolve(workspaceRoot);
  const resolved = path.resolve(root, targetPath);
  const lexicalRel = path.relative(root, resolved);
  const lexicalInside =
    lexicalRel === "" ||
    (!lexicalRel.startsWith("..") && !path.isAbsolute(lexicalRel));
  if (!lexicalInside) {
    return { resolved, relative: lexicalRel || ".", inside: false };
  }
  const realRoot = resolveRealAncestor(root);
  const realTarget = resolveRealAncestor(resolved);
  const realRel = path.relative(realRoot, realTarget);
  const inside =
    realRel === "" || (!realRel.startsWith("..") && !path.isAbsolute(realRel));
  return { resolved, relative: lexicalRel || ".", inside };
}

function commandTouchesOutsideWorkspace(
  command: string,
  workspaceRoot: string,
): boolean {
  if (/(?:^|[\/\\]|[\s"'=><;|&(`])\.\.(?:[\/\\]|$|[\s"'`;&|>)])/.test(command))
    return true;
  if (/(?:^|[\s"'=><;|&(`])~(?:\/|$|\s)/.test(command)) return true;
  if (/\$HOME\b|\$\{HOME\}/.test(command)) return true;
  const matches =
    command.match(/(?:^|[\s"'=><;|&(`:])(\/[^\s"';|&><)`]+)/g) ?? [];
  for (const raw of matches) {
    const token = raw.replace(/^[\s"'=><;|&(`:]+/, "");
    if (
      SAFE_SYSTEM_PREFIXES.some(
        (prefix) =>
          token === prefix.replace(/\/$/, "") || token.startsWith(prefix),
      )
    )
      continue;
    if (!resolveWorkspacePath(workspaceRoot, token).inside) return true;
  }
  return false;
}

function requiresCommandApproval(
  command: string,
  workspaceRoot: string,
): boolean {
  return (
    HIGH_RISK_COMMAND.some((pattern) => pattern.test(command)) ||
    commandTouchesOutsideWorkspace(command, workspaceRoot)
  );
}

/**
 * In-process Agent Executor powered by `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai`.
 * Zero child-process cold start, native AbortSignal propagation, and direct in-process tools.
 */
export class PiAgentExecutor implements AgentExecutor {
  private readonly store: AgentTaskStore;
  private readonly sessionsDir: string;
  private readonly workers = new Map<string, Worker>();
  private readonly root: string;
  private closed = false;
  private closing?: Promise<void>;
  private readonly consumedApprovalActions = new Map<string, number>();

  constructor(private readonly config: PiExecutorConfig = {}) {
    this.root = path.resolve(
      config.stateDirectory ?? process.env.DSH_STATE_DIRECTORY ?? "data/dsh",
    );
    this.store = new AgentTaskStore(
      path.join(this.root, "tasks"),
      config.taskPersistence,
    );
    this.sessionsDir = path.join(this.root, "sessions");
    fs.mkdirSync(this.sessionsDir, { recursive: true, mode: 0o700 });
  }

  getTask(id: string): AgentTask | undefined {
    const task = this.store.get(id);
    return task ? structuredClone(task) : undefined;
  }

  listTasks(): AgentTask[] {
    return structuredClone(this.store.list());
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

    const active = this.workers.get(id);
    if (active) {
      if (previous?.prompt !== prompt)
        return Promise.reject(
          new AgentExecutionError(
            "Task id already belongs to another prompt",
            id,
          ),
        );
      return active.promise!;
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
      if (siblings.some((task) => this.workers.has(task.id)))
        return Promise.reject(
          new AgentExecutionError(
            "Conversation already has an active task",
            id,
          ),
        );
      if (siblings.some((task) => task.state === "unknown"))
        return Promise.reject(
          new AgentExecutionError(
            "Conversation has an unverified task outcome",
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
    if (this.workers.size >= (this.config.maxConcurrentTasks ?? 2)) {
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

    const worker: Worker = {
      stopped: false,
      pendingShell: new Set(),
      killShells: new Set(),
    };
    this.workers.set(id, worker);
    worker.promise = Promise.resolve().then(() =>
      this.execute(task, prompt, options, worker),
    );
    return worker.promise;
  }

  private update(task: AgentTask): void {
    task.updatedAt = new Date().toISOString();
    this.store.save(task);
  }

  private loadSessionMessages(sessionId: string): AgentMessage[] | undefined {
    this.store.assertId(sessionId);
    const file = path.join(this.sessionsDir, `${sessionId}.json`);
    if (!fs.existsSync(file)) return undefined;
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (!Array.isArray(parsed))
      throw new Error("Invalid persisted session transcript");
    return parsed as AgentMessage[];
  }

  private saveSessionMessages(
    sessionId: string,
    messages: AgentMessage[],
  ): void {
    this.store.assertId(sessionId);
    const file = path.join(this.sessionsDir, `${sessionId}.json`);
    const temp = `${file}.${randomUUID()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(messages), { mode: 0o600 });
    fs.renameSync(temp, file);
  }

  private createModelAndStream(): { model: Model<Api>; streamFn: StreamFn } {
    if (this.config.streamFn && this.config.modelSpec) {
      return { model: this.config.modelSpec, streamFn: this.config.streamFn };
    }
    if (this.config.streamFn) {
      const fallbackModel: Model<"openai-completions"> = {
        id: this.config.model ?? "pi-custom-model",
        name: this.config.model ?? "pi-custom-model",
        api: "openai-completions",
        provider: "looi",
        baseUrl: this.config.baseUrl ?? "https://example.invalid/v1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32768,
        maxTokens: 4096,
      };
      return { model: fallbackModel, streamFn: this.config.streamFn };
    }

    if (this.config.modelsRegistry && this.config.providerId) {
      const modelId = this.config.model;
      if (!modelId) {
        throw new Error(
          "PiAgentExecutor requires a model when using modelsRegistry",
        );
      }
      const found = this.config.modelsRegistry.getModel(
        this.config.providerId,
        modelId,
      );
      if (!found) {
        throw new Error(
          `Model ${modelId} not found in provider ${this.config.providerId}`,
        );
      }
      return {
        model: found,
        streamFn: this.config.modelsRegistry.streamSimple.bind(
          this.config.modelsRegistry,
        ),
      };
    }

    const baseUrl = this.config.baseUrl ?? process.env.LLM_BASE_URL;
    const apiKey = this.config.apiKey ?? process.env.LLM_API_KEY;
    const modelId = this.config.model ?? process.env.LLM_MODEL;
    if (!baseUrl || !apiKey || !modelId) {
      throw new Error(
        "PiAgentExecutor requires LLM_BASE_URL, LLM_API_KEY and LLM_MODEL",
      );
    }

    const modelSpec: Model<"openai-completions"> = {
      id: modelId,
      name: modelId,
      api: "openai-completions",
      provider: "looi",
      baseUrl,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32768,
      maxTokens: 4096,
      compat: {
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        supportsStore: false,
        maxTokensField: "max_tokens",
      },
    };

    const models = createModels();
    const provider = createProvider({
      id: "looi",
      name: "LOOI OpenAI Gateway",
      baseUrl,
      auth: {
        apiKey: {
          name: "LOOI API Key",
          resolve: async () => ({ auth: { apiKey } }),
        },
      },
      models: [modelSpec],
      api: openAICompletionsApi(),
    });
    models.setProvider(provider);

    return {
      model: modelSpec,
      streamFn: models.streamSimple.bind(models),
    };
  }

  private buildTools(
    task: AgentTask,
    worker: Worker,
    taskStartMs: number,
    executions: AgentCommandEvidence[],
    artifactsMap: Map<string, { path: string; sha256: string; size: number }>,
    emit: (event: Omit<AgentStepEvent, "taskId" | "sessionId">) => void,
  ): AgentTool<any>[] {
    if (this.config.customTools) return this.config.customTools;

    const recordArtifact = (absPath: string, onlyIfRecent = false) => {
      const { inside, relative } = resolveWorkspacePath(
        task.workspaceRoot,
        absPath,
      );
      if (!inside || !fs.existsSync(absPath)) return;
      const stat = fs.statSync(absPath);
      if (!stat.isFile() || stat.size > MAX_ARTIFACT_BYTES) return;
      if (onlyIfRecent && stat.mtimeMs < taskStartMs - 50) return;
      const buf = fs.readFileSync(absPath);
      artifactsMap.set(relative, {
        path: relative,
        sha256: createHash("sha256").update(buf).digest("hex"),
        size: buf.byteLength,
      });
    };

    const readParams = obj({
      path: str({ description: "File path relative to workspace root" }),
    });

    const executeRead = async (
      _toolCallId: string,
      params: { path: string },
    ) => {
      const { resolved } = resolveWorkspacePath(
        task.workspaceRoot,
        params.path,
      );
      if (!fs.existsSync(resolved))
        throw new Error(`File not found: ${params.path}`);
      const content = fs.readFileSync(resolved, "utf8");
      recordArtifact(resolved);
      return {
        content: [{ type: "text" as const, text: content }],
        details: { path: params.path, size: content.length },
      };
    };

    const readFileTool: AgentTool<typeof readParams> = {
      name: "read_file",
      label: "Read File",
      description: "Read UTF-8 text content of a file in the workspace.",
      parameters: readParams,
      execute: executeRead,
    };

    const readAliasTool: AgentTool<typeof readParams> = {
      name: "read",
      label: "Read File",
      description:
        "Alias of read_file: read UTF-8 text content of a file in the workspace.",
      parameters: readParams,
      execute: executeRead,
    };

    const writeParams = obj({
      path: str({ description: "File path relative to workspace root" }),
      content: str({ description: "Full UTF-8 text content to write" }),
    });

    const executeWrite = async (
      _toolCallId: string,
      params: { path: string; content: string },
    ) => {
      const { resolved } = resolveWorkspacePath(
        task.workspaceRoot,
        params.path,
      );
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, params.content, "utf8");
      recordArtifact(resolved);
      return {
        content: [
          {
            type: "text" as const,
            text: `Wrote ${Buffer.byteLength(params.content)} bytes to ${params.path}`,
          },
        ],
        details: { path: params.path },
      };
    };

    const writeFileTool: AgentTool<typeof writeParams> = {
      name: "write_file",
      label: "Write File",
      description: "Create or overwrite a UTF-8 file in the workspace.",
      parameters: writeParams,
      executionMode: "sequential",
      execute: executeWrite,
    };

    const bashParams = obj({
      command: str({ description: "Shell command to execute in workspace" }),
    });

    const bashTool: AgentTool<typeof bashParams> = {
      name: "bash",
      label: "Run Shell Command",
      description: "Execute a foreground shell command in the workspace.",
      parameters: bashParams,
      executionMode: "sequential",
      execute: async (toolCallId, params, signal) => {
        worker.pendingShell.add(toolCallId);
        return new Promise((resolve, reject) => {
          const child = spawn("/bin/sh", ["-c", params.command], {
            cwd: task.workspaceRoot,
            detached: process.platform !== "win32",
            stdio: ["ignore", "pipe", "pipe"],
          });
          let stdout = "";
          let stderr = "";
          let aborted = false;

          const killChild = () => {
            aborted = true;
            if (child.pid && process.platform !== "win32") {
              try {
                process.kill(-child.pid, "SIGKILL");
              } catch {
                // fallback to direct child kill
              }
            }
            try {
              child.kill("SIGKILL");
            } catch {
              // ignore kill errors
            }
            child.stdout?.destroy();
            child.stderr?.destroy();
          };

          worker.killShells.add(killChild);
          if (signal?.aborted || worker.stopped) killChild();
          signal?.addEventListener("abort", killChild, { once: true });

          child.stdout?.on("data", (chunk: Buffer) => {
            if (stdout.length < MAX_OUTPUT_CHARS) {
              stdout += chunk
                .toString("utf8")
                .slice(0, MAX_OUTPUT_CHARS - stdout.length);
            }
          });
          child.stderr?.on("data", (chunk: Buffer) => {
            if (stderr.length < MAX_OUTPUT_CHARS) {
              stderr += chunk
                .toString("utf8")
                .slice(0, MAX_OUTPUT_CHARS - stderr.length);
            }
          });

          child.once("error", (err) => {
            signal?.removeEventListener("abort", killChild);
            worker.killShells.delete(killChild);
            worker.pendingShell.delete(toolCallId);
            reject(err);
          });

          child.once("close", (code, sig) => {
            signal?.removeEventListener("abort", killChild);
            worker.killShells.delete(killChild);
            worker.pendingShell.delete(toolCallId);

            executions.push({
              callId: toolCallId,
              command: params.command,
              exitCode: code,
              signal: sig,
              timedOut: false,
              aborted,
            });

            try {
              for (const entry of fs.readdirSync(task.workspaceRoot)) {
                recordArtifact(path.join(task.workspaceRoot, entry), true);
              }
            } catch {
              // ignore workspace scan errors
            }

            if (aborted) {
              reject(new Error("Command aborted"));
              return;
            }

            const payload = JSON.stringify({
              exitCode: code ?? 0,
              signal: sig,
              stdout: stdout.trim(),
              stderr: stderr.trim(),
            });

            resolve({
              content: [{ type: "text" as const, text: payload }],
              details: { exitCode: code, signal: sig, stdout, stderr },
              isError: code !== 0,
            });
          });
        });
      },
    };

    const askUserParams = obj({
      questions: arr(
        obj({
          id: str({ description: "Unique question identifier" }),
          question: str({ description: "Question text for the user" }),
          options: opt(
            arr(
              obj({ label: str({ description: "Selectable option label" }) }),
            ),
          ),
        }),
      ),
    });

    const askUserQuestionTool: AgentTool<typeof askUserParams> = {
      name: "ask_user_question",
      label: "Ask User Question",
      description:
        "Ask the user one or more structured questions and wait for their answer.",
      parameters: askUserParams,
      executionMode: "sequential",
      execute: async (toolCallId, params, signal) => {
        const answer = await this.waitForInteraction(
          task,
          worker,
          "question",
          {
            requestId: toolCallId,
            sessionId: task.sessionId,
            questions: params.questions,
          },
          emit,
          signal,
        );
        if ("cancelled" in answer && answer.cancelled) {
          throw new Error("User question was cancelled");
        }
        return {
          content: [{ type: "text" as const, text: JSON.stringify(answer) }],
          details: answer,
        };
      },
    };

    return [
      readFileTool,
      readAliasTool,
      writeFileTool,
      bashTool,
      askUserQuestionTool,
      ...(this.config.additionalTools ?? []),
    ];
  }

  private async execute(
    task: AgentTask,
    prompt: string,
    options: AgentRunOptions,
    worker: Worker,
  ): Promise<AgentRunResult> {
    const start = Date.now();
    const trace = this.config.tracer?.start("agent.run", "agent", options.traceContext ?? { traceId: "", traceName: "agent.run", sessionId: task.sessionId }, {
      "langfuse.observation.input": prompt,
      "langfuse.observation.metadata.taskId": task.id,
      "langfuse.observation.metadata.mode": options.mode ?? "text",
    });
    const toolTraces = new Map<string, Observation>();
    let tracedAnswer: string | undefined;
    let traceError = false;
    let toolCallsCount = 0;
    let step = 0;
    const executions: AgentCommandEvidence[] = [];
    const artifactsMap = new Map<
      string,
      { path: string; sha256: string; size: number }
    >();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const emit = (event: Omit<AgentStepEvent, "taskId" | "sessionId">) => {
      const item: AgentStepEvent = {
        ...event,
        taskId: task.id,
        sessionId: task.sessionId,
        interaction: task.interaction
          ? structuredClone(task.interaction)
          : undefined,
      };
      task.steps.push(item);
      if (task.steps.length > 300) task.steps.shift();
      this.update(task);
      try {
        options.onStep?.(item);
      } catch {
        // optional observer
      }
    };

    const abort = () => {
      void this.cancel(task.id).catch(() => {});
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();

    try {
      if (worker.stopped)
        throw new Error("Task cancelled before runtime startup");
      fs.mkdirSync(task.workspaceRoot, { recursive: true });

      const restoredMessages =
        options.resume || options.sessionId
          ? this.loadSessionMessages(task.sessionId)
          : undefined;
      if (options.resume && !restoredMessages) {
        throw new Error("Persisted session transcript was not found");
      }

      const { model, streamFn } = this.createModelAndStream();
      const tools = this.buildTools(
        task,
        worker,
        start,
        executions,
        artifactsMap,
        emit,
      );

      const agent = new Agent({
        initialState: {
          systemPrompt:
            "你是 LOOI 的任务执行助手。使用真实工具完成任务；不要把失败说成已完成。不要启动后台进程或脱离管理的作业。",
          model,
          tools,
          ...(restoredMessages ? { messages: restoredMessages } : {}),
        },
        sessionId: task.sessionId,
        toolExecution: "sequential",
        streamFn: this.config.tracer?.enabled ? wrapStreamFnWithLangfuse(streamFn, { tracer: this.config.tracer, getTraceContext: () => trace?.context }) : streamFn,
        beforeToolCall: async (
          { toolCall, args },
          signal,
        ): Promise<BeforeToolCallResult | undefined> => {
          if (this.closed || worker.stopped || signal?.aborted)
            return {
              block: true,
              reason:
                "Task was stopped; no further tool execution is permitted.",
            };
          const parsedArgs = (args ?? {}) as Record<string, unknown>;
          let needsApproval =
            this.config.approvalRequiredTools?.includes(toolCall.name) ?? false;
          let details: Record<string, unknown> = {
            callId: toolCall.id,
            toolName: toolCall.name,
            sessionId: task.sessionId,
            ...(needsApproval ? { arguments: parsedArgs } : {}),
          };

          if (toolCall.name === "bash") {
            const command = String(parsedArgs.command ?? "");
            // A shell can write via redirects, substitutions or command flags.
            // Strict mobile mode approves every shell invocation, not a regex
            // approximation of which commands might have side effects.
            if (
              this.config.requireApprovalForAllWrites ||
              requiresCommandApproval(command, task.workspaceRoot)
            ) {
              needsApproval = true;
              details = { ...details, operation: "bash", command };
            }
          } else if (
            toolCall.name === "write_file" ||
            toolCall.name === "write"
          ) {
            const targetPath = String(parsedArgs.path ?? "");
            const { inside, resolved } = resolveWorkspacePath(
              task.workspaceRoot,
              targetPath,
            );
            if (!inside || this.config.requireApprovalForAllWrites) {
              needsApproval = true;
              details = {
                ...details,
                operation: "write",
                path: targetPath,
                content: String(parsedArgs.content ?? ""),
                willOverwrite: fs.existsSync(resolved),
              };
            }
          } else if (
            toolCall.name === "read_file" ||
            toolCall.name === "read"
          ) {
            const targetPath = String(parsedArgs.path ?? "");
            const { inside } = resolveWorkspacePath(
              task.workspaceRoot,
              targetPath,
            );
            if (!inside) {
              needsApproval = true;
              details = { ...details, operation: "read", path: targetPath };
            }
          }

          if (needsApproval) {
            const decision = await this.waitForInteraction(
              task,
              worker,
              "approval",
              details,
              emit,
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
            this.config.customTools &&
            /bash|pwsh|run_code|terminal/.test(toolCall.name)
          ) {
            worker.pendingShell.add(toolCall.id);
          }
          return undefined;
        },
        afterToolCall: async ({ toolCall }) => {
          if (this.config.customTools) {
            worker.pendingShell.delete(toolCall.id);
          }
          return undefined;
        },
      });

      worker.agent = agent;

      agent.subscribe((event) => {
        if (worker.stopped) return;
        if (event.type === "turn_start") {
          step++;
          if (step > (this.config.maxSteps ?? 12)) {
            task.error = "Agent step budget exceeded";
            abort();
            return;
          }
          emit({ step, phase: "thinking", summary: "Pi Agent 正在思考…" });
        } else if (event.type === "tool_execution_start") {
          if (trace && this.config.tracer) toolTraces.set(event.toolCallId, this.config.tracer.start(`agent.tool.${event.toolName}`, "tool", trace.context, { "langfuse.observation.input": event.args }));
          toolCallsCount++;
          if (toolCallsCount > (this.config.maxToolCalls ?? 32)) {
            task.error = "Agent tool budget exceeded";
            abort();
            return;
          }
          emit({
            step,
            phase: "tool_start",
            toolName: event.toolName,
            summary: `Pi · ${event.toolName}`,
          });
        } else if (event.type === "tool_execution_end") {
          toolTraces.get(event.toolCallId)?.end({ "langfuse.observation.output": event.result, ...(event.isError ? { "langfuse.observation.level": "ERROR" } : {}), ...(event.durationMs !== undefined ? { "langfuse.observation.metadata.durationMs": event.durationMs } : {}) });
          toolTraces.delete(event.toolCallId);
          emit({
            step,
            phase: "tool_end",
            toolName: event.toolName,
            summary: "工具已返回结果",
          });
        }
      });

      timer = setTimeout(() => {
        task.error = "Task deadline exceeded";
        abort();
      }, this.config.deadlineMs ?? 180000);

      if (worker.stopped)
        throw new Error("Task stopped before prompt execution");
      task.state = "running";
      this.update(task);

      const userPrompt = `${options.mode === "voice" ? "最终回答用简短自然的中文，适合语音口播。\n" : ""}${prompt}`;
      await agent.prompt(userPrompt);

      if (worker.stopped) throw new Error(task.error ?? "Task cancelled");

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

      this.saveSessionMessages(task.sessionId, agent.state.messages);

      const artifacts = [...artifactsMap.values()];
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
        ...(artifacts.length > 0 ? { artifacts } : {}),
      };

      task.state = "succeeded";
      task.result = output;
      task.runtimeExited = true;
      this.update(task);
      emit({ step, phase: "done", summary: finalResponse.slice(0, 160) });
      output.steps = [...task.steps];
      this.update(task);
      return output;
    } catch (error) {
      traceError = true;
      const message = this.sanitize(
        error instanceof Error ? error.message : "Pi agent execution failed",
      );
      if (worker.stop) {
        await worker.stop;
      } else {
        task.runtimeExited = true;
        task.state = worker.pendingShell.size > 0 ? "unknown" : "failed";
      }
      task.error ??= message;
      emit({ step, phase: "error", summary: task.error });
      throw new AgentExecutionError(task.error, task.id);
    } finally {
      for (const span of toolTraces.values()) span.end({ "langfuse.observation.level": "ERROR" });
      trace?.end({ "langfuse.observation.output": tracedAnswer ?? "", "langfuse.observation.metadata.toolCallsCount": toolCallsCount, ...(traceError ? { "langfuse.observation.level": "ERROR" } : {}) });
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      worker.pending?.settle(
        task.interaction?.kind === "approval"
          ? { outcome: "cancelled" }
          : { cancelled: true },
      );
      delete task.interaction;
      this.update(task);
      this.workers.delete(task.id);
    }
  }

  private sanitize(message: string): string {
    const key = (this.config.apiKey ?? process.env.LLM_API_KEY)?.trim();
    return (key ? message.replaceAll(key, "[redacted]") : message).slice(
      0,
      500,
    );
  }

  private waitForInteraction(
    task: AgentTask,
    worker: Worker,
    kind: "approval" | "question",
    details: Record<string, unknown>,
    emit: (event: Omit<AgentStepEvent, "taskId" | "sessionId">) => void,
    signal?: AbortSignal,
  ): Promise<AgentInteractionAnswer> {
    if (worker.stopped || signal?.aborted) {
      return Promise.resolve(
        kind === "approval" ? { outcome: "cancelled" } : { cancelled: true },
      );
    }
    if (worker.pending) {
      return Promise.reject(
        new Error("Concurrent interactive requests are not supported"),
      );
    }
    const id = randomUUID();
    const timeout = this.config.interactionTimeoutMs ?? 120000;
    task.interaction = {
      id,
      kind,
      details,
      expiresAt: new Date(Date.now() + timeout).toISOString(),
    };
    task.state = kind === "approval" ? "awaiting_approval" : "awaiting_input";
    return new Promise((resolve) => {
      const dismiss = () =>
        settle(
          kind === "approval" ? { outcome: "cancelled" } : { cancelled: true },
        );
      const timer = setTimeout(dismiss, timeout);
      const settle = (answer: AgentInteractionAnswer) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", dismiss);
        worker.pending = undefined;
        delete task.interaction;
        if (!worker.stopped) task.state = "running";
        this.update(task);
        resolve(answer);
      };
      worker.pending = { id, settle };
      signal?.addEventListener("abort", dismiss, { once: true });
      emit({
        step: task.steps.at(-1)?.step ?? 0,
        phase: kind === "approval" ? "awaiting_approval" : "awaiting_input",
        summary:
          kind === "approval" ? "此操作需要确认" : "Agent 正在等待你的回答",
      });
    });
  }

  respond(
    taskId: string,
    requestId: string,
    answer: AgentInteractionAnswer,
  ): void {
    const task = this.store.get(taskId);
    const worker = this.workers.get(taskId);
    if (
      !task?.interaction ||
      !worker?.pending ||
      worker.pending.id !== requestId ||
      task.interaction.id !== requestId ||
      worker.stopped
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
      if (
        answer.outcome === "allowed-once" &&
        this.config.approvalUiSessionId
      ) {
        const action = answer.userAction;
        if (!action) throw new Error("A fresh explicit UI action is required");
        const now = Date.now();
        assertFreshUiAction(action, now);
        if (action.ui_session_id !== this.config.approvalUiSessionId)
          throw new Error("Approval belongs to a different UI session");
        for (const [id, captured] of this.consumedApprovalActions)
          if (captured < now - 31_000) this.consumedApprovalActions.delete(id);
        if (this.consumedApprovalActions.has(action.event_id))
          throw new Error("Approval action was already consumed");
        if (this.consumedApprovalActions.size >= 512)
          throw new Error("Approval action capacity exceeded");
        this.consumedApprovalActions.set(
          action.event_id,
          Date.parse(action.captured_at),
        );
      }
    } else if (!("answers" in answer) && !("cancelled" in answer)) {
      throw new Error("Invalid question answer");
    }
    worker.pending.settle(answer);
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
    const worker = this.workers.get(taskId);
    if (!worker)
      return { state: task.state, runtimeExited: false, confirmed: false };
    if (worker.stop) return worker.stop;

    worker.stopped = true;
    worker.pending?.settle(
      task.interaction?.kind === "approval"
        ? { outcome: "cancelled" }
        : { cancelled: true },
    );
    for (const kill of worker.killShells) kill();
    worker.agent?.abort();
    task.state = "cancelling";
    this.update(task);

    worker.stop = (async () => {
      const graceMs = this.config.stopGraceMs ?? 200;
      const runtimeExited = worker.agent
        ? await awaitWithin(worker.agent.waitForIdle(), graceMs)
        : true;
      const confirmed = runtimeExited && worker.pendingShell.size === 0;
      task.runtimeExited = runtimeExited;
      task.state = confirmed ? "cancelled" : "unknown";
      if (!confirmed) {
        task.error =
          "Runtime stop requested; local execution exit or external effect requires verification";
      }
      this.update(task);
      return { state: task.state, runtimeExited, confirmed };
    })();
    return worker.stop;
  }

  close(): Promise<void> {
    return (this.closing ??= (async () => {
      try { await this.closeWorkers(); }
      finally { await this.config.tracer?.flush(); }
    })());
  }

  private async closeWorkers(): Promise<void> {
    this.closed = true;
    await Promise.allSettled(
      [...this.workers.keys()].map((id) => this.cancel(id)),
    );
    const settled = await awaitWithin(
      Promise.allSettled(
        [...this.workers.values()].map((worker) => worker.promise),
      ),
      this.config.stopGraceMs ?? 200,
    );
    if (!settled)
      throw new AgentExecutionError(
        "Local execution exit is unconfirmed; task remains unknown",
      );
  }
}
