import {
  replyTextLanguage,
  type ConversationLanguage,
} from "../../../../packages/looi-runtime/src/agent/conversation-language.js";
import type { TraceContext } from "../../../../packages/looi-runtime/src/telemetry/langfuse.js";
import type {
  VoiceProactiveNotice,
  VoiceTaskBridge,
  VoiceTaskStatusSnapshot,
  VoiceTaskSubmissionResult,
} from "./types.js";

const DEFAULT_FAST_PATH_MS = 2_500;
const MAX_SPOKEN_SUMMARY_CHARS = 180;
const MAX_CONTEXT_RECEIPT_CHARS = 800;

export interface VoiceTaskStepInput {
  step?: number;
  phase?: string;
  summary: string;
  taskId?: string;
  interaction?: {
    id: string;
    kind: "approval" | "question";
    details: Record<string, unknown>;
  };
}

export interface VoiceTaskRunHooks {
  onStep: (event: VoiceTaskStepInput) => void;
}

export interface VoiceTaskCoordinatorOptions {
  fastPathMs?: number;
  defaultLanguage?: () => ConversationLanguage;
  runTask: (
    prompt: string,
    hooks: VoiceTaskRunHooks,
    traceContext?: TraceContext,
  ) => Promise<{ answer: string; taskId?: string }>;
  cancelRunningTask: () => Promise<boolean>;
  onNotice?: (notice: VoiceProactiveNotice) => void;
  onContextNote?: (note: string) => void;
}

interface ManagedTaskRecord {
  localId: string;
  runtimeTaskId?: string;
  prompt: string;
  state: "running" | "waiting_user" | "completed" | "failed" | "cancelled";
  latestSummary: string;
  promoted: boolean;
  announcedInteractions: Set<string>;
  answer?: string;
  error?: string;
}

export function toSpokenPlainText(raw: string, maxChars = MAX_SPOKEN_SUMMARY_CHARS): string {
  const cleaned = raw
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^\s*#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/[*_~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length <= maxChars) return cleaned;
  const slice = cleaned.slice(0, maxChars);
  const boundary = Math.max(
    slice.lastIndexOf("。"),
    slice.lastIndexOf("！"),
    slice.lastIndexOf("？"),
    slice.lastIndexOf(". "),
    slice.lastIndexOf("; "),
    slice.lastIndexOf("；"),
    slice.lastIndexOf("，"),
  );
  return (boundary >= Math.floor(maxChars * 0.45) ? slice.slice(0, boundary + 1) : slice).trim();
}

function formatContextReceipt(record: ManagedTaskRecord, taskId: string): string {
  const detail = (record.answer ?? record.error ?? record.latestSummary).trim().slice(0, MAX_CONTEXT_RECEIPT_CHARS);
  return `[Background Task Receipt (${taskId}, ${record.state})]\nRequest: ${record.prompt.slice(0, 200)}\nOutcome: ${detail}`;
}

/**
 * Coordinates voice-originated Agent tasks independently of individual voice
 * WebSocket lifetimes: short tasks finish inline within `fastPathMs`; longer
 * tasks promote to background execution and push `WHEN_IDLE` spoken notices.
 */
export class VoiceTaskCoordinator implements VoiceTaskBridge {
  private readonly fastPathMs: number;
  private sequence = 0;
  private currentTask?: ManagedTaskRecord;
  private latestTask?: ManagedTaskRecord;

  constructor(private readonly options: VoiceTaskCoordinatorOptions) {
    this.fastPathMs = Math.max(50, options.fastPathMs ?? DEFAULT_FAST_PATH_MS);
  }

  get hasActiveTask(): boolean {
    return Boolean(
      this.currentTask &&
        (this.currentTask.state === "running" || this.currentTask.state === "waiting_user"),
    );
  }

  async submit(
    prompt: string,
    traceContext?: TraceContext,
  ): Promise<VoiceTaskSubmissionResult> {
    const trimmed = prompt.trim();
    if (!trimmed) {
      return { status: "failed", error: "任务描述不能为空。" };
    }
    if (
      this.currentTask &&
      (this.currentTask.state === "running" || this.currentTask.state === "waiting_user")
    ) {
      return {
        status: "busy",
        taskId: this.publicId(this.currentTask),
        latestSummary: this.currentTask.latestSummary,
      };
    }

    const record: ManagedTaskRecord = {
      localId: `vtask_${++this.sequence}`,
      prompt: trimmed,
      state: "running",
      latestSummary: "starting",
      promoted: false,
      announcedInteractions: new Set<string>(),
    };
    this.currentTask = record;
    this.latestTask = record;

    let settleFastWindow: ((result: VoiceTaskSubmissionResult) => void) | undefined;
    let windowTimer: ReturnType<typeof setTimeout> | undefined;

    const closeWindow = (result: VoiceTaskSubmissionResult) => {
      if (!settleFastWindow) return;
      const resolve = settleFastWindow;
      settleFastWindow = undefined;
      if (windowTimer) {
        clearTimeout(windowTimer);
        windowTimer = undefined;
      }
      resolve(result);
    };

    const fastWindowPromise = new Promise<VoiceTaskSubmissionResult>((resolve) => {
      settleFastWindow = resolve;
      windowTimer = setTimeout(() => {
        if (record.state !== "running" && record.state !== "waiting_user") return;
        record.promoted = true;
        closeWindow({
          status: "running_in_background",
          taskId: this.publicId(record),
          latestSummary: record.latestSummary,
        });
      }, this.fastPathMs);
    });

    void this.options
      .runTask(
        trimmed,
        {
          onStep: (event) => {
            if (event.taskId) record.runtimeTaskId = event.taskId;
            if (typeof event.summary === "string" && event.summary.trim()) {
              record.latestSummary = event.summary.trim();
            }
            if (event.interaction && record.state !== "cancelled") {
              record.state = "waiting_user";
              if (!record.announcedInteractions.has(event.interaction.id)) {
                record.announcedInteractions.add(event.interaction.id);
                if (settleFastWindow) {
                  // Yield the synchronous tool call immediately so the voice model
                  // asks the user to confirm on screen without stalling.
                  record.promoted = true;
                  closeWindow({
                    status: "waiting_user_confirmation",
                    taskId: this.publicId(record),
                    interactionKind: event.interaction.kind,
                    latestSummary: record.latestSummary,
                  });
                } else if (record.promoted) {
                  this.emitInteractionNotice(record, event.interaction.id, event.interaction.kind);
                }
              }
            } else if (record.state === "waiting_user") {
              record.state = "running";
            }
          },
        },
        traceContext,
      )
      .then((outcome) => {
        if (outcome.taskId) record.runtimeTaskId = outcome.taskId;
        if (this.currentTask === record) this.currentTask = undefined;
        if (record.state === "cancelled") {
          closeWindow({ status: "failed", taskId: this.publicId(record), error: "任务已取消。" });
          return;
        }
        record.state = "completed";
        record.answer = outcome.answer;
        record.latestSummary = "completed";
        const taskId = this.publicId(record);
        const receipt = formatContextReceipt(record, taskId);
        this.options.onContextNote?.(receipt);

        if (settleFastWindow) {
          closeWindow({
            status: "completed",
            taskId,
            answer: outcome.answer,
          });
        } else if (record.promoted) {
          this.emitCompletionNotice(record, taskId, receipt);
        }
      })
      .catch((error: unknown) => {
        if (this.currentTask === record) this.currentTask = undefined;
        if (record.state === "cancelled") {
          closeWindow({ status: "failed", taskId: this.publicId(record), error: "任务已取消。" });
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        record.state = "failed";
        record.error = message;
        record.latestSummary = message || "failed";
        const taskId = this.publicId(record);
        const receipt = formatContextReceipt(record, taskId);
        this.options.onContextNote?.(receipt);

        if (settleFastWindow) {
          closeWindow({
            status: "failed",
            taskId,
            error: "任务未获确认或未完成，不得声称成功。",
          });
        } else if (record.promoted) {
          this.emitFailureNotice(record, taskId, receipt);
        }
      });

    return fastWindowPromise;
  }

  inspect(taskId?: string): VoiceTaskStatusSnapshot | null {
    const candidate = this.matchTask(taskId);
    if (!candidate) return null;
    return {
      taskId: this.publicId(candidate),
      prompt: candidate.prompt,
      state: candidate.state,
      latestSummary: candidate.latestSummary,
      ...(candidate.answer !== undefined ? { answer: candidate.answer } : {}),
      ...(candidate.error !== undefined ? { error: candidate.error } : {}),
    };
  }

  async cancel(taskId?: string): Promise<{ cancelled: boolean; taskId?: string }> {
    const active = this.currentTask;
    if (!active || (active.state !== "running" && active.state !== "waiting_user")) {
      return { cancelled: false };
    }
    if (
      taskId &&
      taskId.trim() &&
      taskId !== active.localId &&
      taskId !== active.runtimeTaskId
    ) {
      return { cancelled: false, taskId: this.publicId(active) };
    }
    const confirmed = await this.options.cancelRunningTask();
    if (confirmed && this.currentTask === active) {
      active.state = "cancelled";
      active.latestSummary = "cancelled";
      this.currentTask = undefined;
    }
    return { cancelled: confirmed, taskId: this.publicId(active) };
  }

  /** Marks any in-flight task as externally cancelled (e.g. UI Stop button / app backgrounding). */
  markExternallyCancelled(): void {
    if (!this.currentTask) return;
    this.currentTask.state = "cancelled";
    this.currentTask.latestSummary = "cancelled";
    this.currentTask = undefined;
  }

  private matchTask(taskId?: string): ManagedTaskRecord | undefined {
    const target = taskId?.trim();
    if (!target) return this.currentTask ?? this.latestTask;
    for (const entry of [this.currentTask, this.latestTask]) {
      if (entry && (entry.localId === target || entry.runtimeTaskId === target)) {
        return entry;
      }
    }
    return undefined;
  }

  private publicId(record: ManagedTaskRecord): string {
    return record.runtimeTaskId || record.localId;
  }

  private resolveLanguage(sampleText: string): ConversationLanguage {
    const fallback = this.options.defaultLanguage?.() ?? "zh-CN";
    return replyTextLanguage(sampleText, fallback);
  }

  private emitInteractionNotice(
    record: ManagedTaskRecord,
    interactionId: string,
    kind: "approval" | "question",
  ): void {
    const language = this.resolveLanguage(record.prompt);
    const spokenText =
      language === "en-US"
        ? kind === "approval"
          ? "Your background task needs permission on screen before I can continue."
          : "Your background task has a quick question on screen for you."
        : kind === "approval"
          ? "刚才的后台任务需要你在屏幕上点一下授权确认，确认后我继续执行。"
          : "刚才的后台任务在屏幕上有个问题需要你确认一下。";
    const taskId = this.publicId(record);
    this.options.onNotice?.({
      id: `${taskId}:interaction:${interactionId}`,
      spokenText,
      contextNote: formatContextReceipt(record, taskId),
    });
  }

  private emitCompletionNotice(
    record: ManagedTaskRecord,
    taskId: string,
    receipt: string,
  ): void {
    const rawAnswer = record.answer ?? "";
    const language = this.resolveLanguage(rawAnswer || record.prompt);
    const plain = toSpokenPlainText(rawAnswer);
    const spokenText =
      language === "en-US"
        ? plain
          ? `Quick update, your background task is finished: ${plain}`
          : "Quick update, your background task is finished."
        : plain
          ? `跟你说一声，刚才的后台任务已经完成啦：${plain}`
          : "跟你说一声，刚才的后台任务已经完成啦。";
    this.options.onNotice?.({
      id: `${taskId}:completed`,
      spokenText,
      contextNote: receipt,
    });
  }

  private emitFailureNotice(
    record: ManagedTaskRecord,
    taskId: string,
    receipt: string,
  ): void {
    const language = this.resolveLanguage(record.prompt);
    const spokenText =
      language === "en-US"
        ? "Heads up, the background task couldn't be completed. You can check the task panel for details."
        : "跟你说一声，刚才的后台任务没能顺利完成，可以在任务面板查看具体原因。";
    this.options.onNotice?.({
      id: `${taskId}:failed`,
      spokenText,
      contextNote: receipt,
    });
  }
}
