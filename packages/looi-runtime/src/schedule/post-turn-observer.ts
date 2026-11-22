import {
  contentText,
  normalizeContext,
  type AssistantMessage,
  type Context,
} from "@earendil-works/pi-ai";
import {
  resolvePiModelAndStream,
  type ModelStreamConfig,
} from "../agent/core/model-resolver.js";
import type { AgentRunResult, AgentTask } from "../agent/executor.js";
import type { SqliteRuntimeStore } from "../storage/sqlite.js";
import type { LangfuseTracer } from "../telemetry/langfuse.js";
import type { ScheduleEngine } from "./engine.js";
import {
  ScheduleError,
  type ScheduleFailure,
  type ScheduleRule,
} from "./types.js";

const MAX_CONTEXT_CHARS = 2500;
const DEFAULT_FOLLOWUP_DELAY_SECONDS = 180;
const ASYNC_SIGNAL_TOOLS = new Set(["bash", "codex_exec", "codex_cloud"]);

export interface PostTurnObserveInput {
  task: AgentTask;
  result: AgentRunResult;
  userPrompt: string;
  manageScheduleMutated?: boolean;
}

export interface PostTurnObserveResult {
  observed: boolean;
  skippedReason?:
    | "auto_followup_disabled"
    | "task_not_foreground_succeeded"
    | "schedule_already_managed"
    | "no_async_signal"
    | "model_unconfigured";
  created: boolean;
  merged?: boolean;
  rule?: ScheduleRule;
  error?: ScheduleFailure;
}

export interface PostTurnObserverOptions {
  engine: ScheduleEngine;
  store: SqliteRuntimeStore;
  getModelConfig: () => ModelStreamConfig | undefined;
  tracer?: LangfuseTracer;
  redactSecrets?: (text: string) => string;
  now?: () => Date;
  onError?: (failure: ScheduleFailure) => void;
}

interface ExtractedTarget {
  kind?: "github_pr" | "codex_cloud" | "generic";
  owner?: string;
  repo?: string;
  pullNumber?: number;
  taskId?: string;
  description?: string;
}

interface ExtractorResponse {
  shouldFollowUp: boolean;
  title?: string;
  delaySeconds?: number;
  dedupeKey?: string;
  target?: ExtractedTarget;
  prompt?: string;
}

const EXTRACTOR_SYSTEM_PROMPT = [
  "You inspect a completed foreground agent turn and decide if an asynchronous external task (e.g., GitHub PR CI/review, Codex Cloud run, or remote build/deploy) is still awaiting an outcome and needs silent read-only follow-up.",
  "Return STRICT JSON only (no prose, no markdown fences if avoidable) matching:",
  '{"shouldFollowUp": boolean, "title"?: string, "delaySeconds"?: number, "dedupeKey"?: string, "target"?: {"kind": "github_pr"|"codex_cloud"|"generic", "owner"?: string, "repo"?: string, "pullNumber"?: number, "taskId"?: string, "description"?: string}, "prompt"?: string}',
  "Set shouldFollowUp=false if the work is already completely finished, failed permanently, or purely local with nothing remote pending.",
  "When shouldFollowUp=true, make prompt self-contained with exact PR owner/repo/pullNumber or Codex taskId and tell the check run to use github_pr_status or codex_cloud_status and finish with schedule_report.",
].join("\n");

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1))}…`;
}

export function buildCompactTurnContext(input: PostTurnObserveInput): string {
  const stepTools = input.result.steps
    .filter((s) => s.phase === "tool_start" || s.phase === "tool_end")
    .map((s) => `${s.phase}:${s.toolName ?? ""}`)
    .slice(-12);

  const execSnippets = (input.result.executions ?? [])
    .slice(-3)
    .map((exec) => {
      const out = truncate((exec.stdout ?? "").trim(), 240);
      const err = truncate((exec.stderr ?? "").trim(), 160);
      return `$ ${truncate(exec.command, 160)} (exit=${exec.exitCode})${out ? `\nstdout: ${out}` : ""}${err ? `\nstderr: ${err}` : ""}`;
    })
    .join("\n");

  const parts = [
    `User request: ${truncate(input.userPrompt.trim(), 500)}`,
    `Tool sequence: ${stepTools.join(", ") || "none"}`,
    execSnippets ? `Command evidence:\n${execSnippets}` : "",
    `Final assistant reply: ${truncate(input.result.answer.trim(), 700)}`,
  ].filter(Boolean);

  return truncate(parts.join("\n\n"), MAX_CONTEXT_CHARS);
}

function stripJsonFences(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);
  return fenced ? fenced[1]!.trim() : trimmed;
}

function extractFailureFromAssistant(
  message: AssistantMessage,
  redact: (s: string) => string,
): ScheduleFailure {
  const diagCode = message.diagnostics?.find((d) => d.error?.code !== undefined)?.error?.code;
  const rawReason = message.errorMessage || message.stopReason || "Model failed";
  const httpMatch = rawReason.match(/\b(4\d\d|5\d\d)\b/);
  const code = diagCode ?? (httpMatch?.[1] ? Number(httpMatch[1]) : undefined) ?? "ERR_POST_TURN_MODEL_FAILED";
  return {
    stage: "schedule.post_turn.model",
    code,
    reason: redact(rawReason),
  };
}

function extractFailureFromThrown(
  error: unknown,
  stageFallback: string,
  codeFallback: string,
  redact: (s: string) => string,
): ScheduleFailure {
  if (error instanceof ScheduleError) {
    return {
      stage: error.stage,
      ...(error.code !== undefined ? { code: error.code } : {}),
      reason: redact(error.reason),
    };
  }
  if (error && typeof error === "object") {
    const e = error as {
      stage?: unknown;
      code?: unknown;
      status?: unknown;
      statusCode?: unknown;
      message?: unknown;
    };
    const stage = typeof e.stage === "string" && e.stage ? e.stage : stageFallback;
    const code =
      typeof e.code === "string" || typeof e.code === "number"
        ? e.code
        : typeof e.status === "number"
          ? e.status
          : typeof e.statusCode === "number"
            ? e.statusCode
            : codeFallback;
    const reason =
      typeof e.message === "string" && e.message ? e.message : String(error);
    return { stage, code, reason: redact(reason) };
  }
  return { stage: stageFallback, code: codeFallback, reason: redact(String(error)) };
}

function deriveDedupeAndPrompt(
  parsed: ExtractorResponse,
  task: AgentTask,
): { title: string; dedupeKey: string; prompt: string } {
  const target = parsed.target;
  if (target?.kind === "github_pr" && target.owner && target.repo && target.pullNumber) {
    const dedupeKey =
      parsed.dedupeKey?.trim() ||
      `github_pr:${target.owner}/${target.repo}#${target.pullNumber}`;
    const title =
      parsed.title?.trim() ||
      `Check PR ${target.owner}/${target.repo}#${target.pullNumber}`;
    const prompt =
      parsed.prompt?.trim() ||
      `Check GitHub PR ${target.owner}/${target.repo}#${target.pullNumber} status using github_pr_status(owner="${target.owner}", repo="${target.repo}", pullNumber=${target.pullNumber}), then report via schedule_report.`;
    return { title, dedupeKey, prompt };
  }
  if (target?.kind === "codex_cloud" && target.taskId) {
    const dedupeKey = parsed.dedupeKey?.trim() || `codex_cloud:${target.taskId}`;
    const title = parsed.title?.trim() || `Check Codex Cloud ${target.taskId}`;
    const prompt =
      parsed.prompt?.trim() ||
      `Check Codex Cloud task ${target.taskId} using codex_cloud_status(taskId="${target.taskId}"), then report via schedule_report.`;
    return { title, dedupeKey, prompt };
  }
  return {
    title: parsed.title?.trim() || "Follow up on background task",
    dedupeKey: parsed.dedupeKey?.trim() || `task:${task.id}`,
    prompt:
      parsed.prompt?.trim() ||
      `Check the status of the pending task from session ${task.sessionId}${
        target?.description ? ` (${target.description})` : ""
      } using read-only status tools, then report via schedule_report.`,
  };
}

/**
 * 4-gate post-turn observer that asynchronously inspects completed foreground turns
 * containing external async tool signals and seeds a `check_only` + `agent_inferred` rule.
 */
export class PostTurnScheduleObserver {
  private readonly now: () => Date;

  constructor(private readonly options: PostTurnObserverOptions) {
    this.now = options.now ?? (() => new Date());
  }

  private sanitize(text: string): string {
    let scrubbed = text;
    const config = this.options.getModelConfig();
    const key = (config?.apiKey ?? process.env.LLM_API_KEY)?.trim();
    if (key && key.length >= 4) {
      scrubbed = scrubbed.replaceAll(key, "[redacted]");
    }
    if (this.options.redactSecrets) {
      scrubbed = this.options.redactSecrets(scrubbed);
    }
    scrubbed = scrubbed.replace(/(Bearer\s+)[^\s"']+/gi, "$1[redacted]");
    return scrubbed;
  }

  private recordError(
    span: ReturnType<LangfuseTracer["start"]> | undefined,
    failure: ScheduleFailure,
  ): void {
    span?.end({
      "langfuse.observation.level": "ERROR",
      "langfuse.observation.status_message": failure.reason,
      "langfuse.observation.metadata.stage": failure.stage,
      ...(failure.code !== undefined
        ? { "langfuse.observation.metadata.code": failure.code }
        : {}),
    });
    try {
      this.options.onError?.(failure);
    } catch {
      // keep observer non-fatal
    }
  }

  maybeObserve(input: PostTurnObserveInput): void {
    void this.observe(input).catch(() => {});
  }

  async observe(input: PostTurnObserveInput): Promise<PostTurnObserveResult> {
    const settings = this.options.store.getScheduleSettings();
    // Gate 1: autoFollowUpEnabled
    if (!settings.autoFollowUpEnabled) {
      return { observed: false, skippedReason: "auto_followup_disabled", created: false };
    }

    // Gate 2: foreground user task succeeded
    const isForeground =
      input.task.lane === undefined || input.task.lane === "foreground";
    if (!isForeground || input.task.state !== "succeeded") {
      return {
        observed: false,
        skippedReason: "task_not_foreground_succeeded",
        created: false,
      };
    }

    // Gate 3: current turn did not already manage schedule rules
    const stepsCalledManageSchedule =
      input.manageScheduleMutated === true ||
      (input.manageScheduleMutated !== false &&
        input.result.steps.some((step) => step.toolName === "manage_schedule"));
    if (
      stepsCalledManageSchedule ||
      this.options.store.hasScheduleRuleForSourceTask(input.task.id)
    ) {
      return {
        observed: false,
        skippedReason: "schedule_already_managed",
        created: false,
      };
    }

    // Gate 4: external async action signal present
    const hasAsyncSignal =
      input.result.steps.some(
        (step) => step.toolName !== undefined && ASYNC_SIGNAL_TOOLS.has(step.toolName),
      ) || Boolean(input.result.executions && input.result.executions.length > 0);
    if (!hasAsyncSignal) {
      return { observed: false, skippedReason: "no_async_signal", created: false };
    }

    const modelConfig = this.options.getModelConfig();
    if (!modelConfig) {
      return { observed: false, skippedReason: "model_unconfigured", created: false };
    }

    const span = this.options.tracer?.start(
      "schedule.post_turn_observe",
      "span",
      input.task.trace
        ? {
            traceId: input.task.trace.traceId,
            parentSpanId: input.task.trace.spanId,
            traceName: "schedule.post_turn_observe",
            sessionId: input.task.sessionId,
          }
        : undefined,
      {
        "langfuse.observation.metadata.taskId": input.task.id,
      },
    );

    const compactPrompt = buildCompactTurnContext(input);
    const sanitize = (text: string) => this.sanitize(text);

    let resolved: ReturnType<typeof resolvePiModelAndStream>;
    try {
      resolved = resolvePiModelAndStream(modelConfig);
    } catch (error) {
      const failure = extractFailureFromThrown(
        error,
        "schedule.post_turn.resolve_model",
        "ERR_POST_TURN_MODEL_UNAVAILABLE",
        sanitize,
      );
      this.recordError(span, failure);
      return { observed: true, created: false, error: failure };
    }

    let assistant: AssistantMessage;
    try {
      const context: Context = {
        systemPrompt: EXTRACTOR_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: compactPrompt,
            timestamp: this.now().getTime(),
          },
        ],
      };
      if (resolved.models && !modelConfig.streamFn) {
        assistant = await resolved.models.completeSimple(resolved.model, context, {
          maxTokens: 400,
        });
      } else {
        const stream = await resolved.streamFn(
          resolved.model,
          normalizeContext(context),
          { maxTokens: 400 },
        );
        assistant = await stream.result();
      }
    } catch (error) {
      const failure = extractFailureFromThrown(
        error,
        "schedule.post_turn.model",
        "ERR_POST_TURN_MODEL_FAILED",
        sanitize,
      );
      this.recordError(span, failure);
      return { observed: true, created: false, error: failure };
    }

    if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
      const failure = extractFailureFromAssistant(assistant, sanitize);
      this.recordError(span, failure);
      return { observed: true, created: false, error: failure };
    }

    const rawText = contentText(assistant.content).trim();
    let parsed: ExtractorResponse;
    try {
      parsed = JSON.parse(stripJsonFences(rawText)) as ExtractorResponse;
      if (!parsed || typeof parsed !== "object" || typeof parsed.shouldFollowUp !== "boolean") {
        throw new Error("Expected JSON object with boolean shouldFollowUp");
      }
    } catch (error) {
      const failure: ScheduleFailure = {
        stage: "schedule.post_turn.parse",
        code: "ERR_POST_TURN_INVALID_JSON",
        reason: sanitize(error instanceof Error ? error.message : String(error)),
      };
      this.recordError(span, failure);
      return { observed: true, created: false, error: failure };
    }

    if (!parsed.shouldFollowUp) {
      span?.end({ "langfuse.observation.output": { created: false } });
      return { observed: true, created: false };
    }

    try {
      const { title, dedupeKey, prompt } = deriveDedupeAndPrompt(parsed, input.task);
      const delaySeconds = Math.max(
        1,
        Math.round(parsed.delaySeconds ?? DEFAULT_FOLLOWUP_DELAY_SECONDS),
      );
      const runAt = new Date(this.now().getTime() + delaySeconds * 1000).toISOString();
      const created = this.options.engine.createRule({
        title,
        prompt,
        origin: "agent_inferred",
        executionPolicy: "check_only",
        dedupeKey,
        trigger: { kind: "once", runAt },
        sourceSessionId: input.task.sessionId,
        sourceTaskId: input.task.id,
      });
      span?.end({
        "langfuse.observation.output": {
          created: true,
          ruleId: created.rule.id,
          merged: created.merged,
          dedupeKey: created.rule.dedupeKey,
        },
      });
      return {
        observed: true,
        created: true,
        merged: created.merged,
        rule: created.rule,
      };
    } catch (error) {
      const failure = extractFailureFromThrown(
        error,
        "schedule.post_turn.create_rule",
        "ERR_POST_TURN_CREATE_FAILED",
        sanitize,
      );
      this.recordError(span, failure);
      return { observed: true, created: false, error: failure };
    }
  }
}
