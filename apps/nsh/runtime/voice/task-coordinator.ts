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
  defaultLanguage?: () => ConversationLanguage;
  /** Optional check for foreground non-voice tasks already occupying the runtime. */
  isExternalBusy?: () => boolean;
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
  announcedInteractions: Set<string>;
  cancelPromise?: Promise<boolean>;
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
  const detail = (record.answer ?? record.error ?? record.latestSummary)
    .trim()
    .slice(0, MAX_CONTEXT_RECEIPT_CHARS);
  return `[Background Task Receipt (${taskId}, ${record.state})]\nRequest: ${record.prompt.slice(0, 200)}\nOutcome: ${detail}`;
}

/**
 * Coordinates voice-originated Agent tasks independently of individual voice
 * WebSocket lifetimes. Submission acknowledges immediately; results and questions
 * return through spoken notices when the conversation is idle.
 */
export class VoiceTaskCoordinator implements VoiceTaskBridge {
  private sequence = 0;
  private currentTask?: ManagedTaskRecord;
  private latestTask?: ManagedTaskRecord;

  constructor(private readonly options: VoiceTaskCoordinatorOptions) {}

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
    if (this.options.isExternalBusy?.()) {
      return {
        status: "busy",
        taskId: "foreground_task",
        latestSummary: "当前已有前台任务正在执行",
      };
    }

    const record: ManagedTaskRecord = {
      localId: `vtask_${++this.sequence}`,
      prompt: trimmed,
      state: "running",
      latestSummary: "starting",
      announcedInteractions: new Set<string>(),
    };
    this.currentTask = record;
    this.latestTask = record;

    // Let the tool receipt leave before task startup touches the model or storage.
    setTimeout(() => void this.run(record, traceContext), 0);
    return {
      status: "running_in_background",
      taskId: record.localId,
      latestSummary: record.latestSummary,
    };
  }

  private async run(record: ManagedTaskRecord, traceContext?: TraceContext): Promise<void> {
    if (this.currentTask !== record) return;
    try {
      const outcome = await this.options.runTask(
        record.prompt,
        {
          onStep: (event) => {
            if (record.state === "cancelled") return;
            if (event.taskId) record.runtimeTaskId = event.taskId;
            if (event.summary.trim()) record.latestSummary = event.summary.trim();
            if (event.interaction) {
              record.state = "waiting_user";
              if (!record.announcedInteractions.has(event.interaction.id)) {
                record.announcedInteractions.add(event.interaction.id);
                this.emitInteractionNotice(record, event.interaction.id, event.interaction.kind);
              }
            } else if (record.state === "waiting_user") {
              record.state = "running";
            }
          },
        },
        traceContext,
      );
      if (outcome.taskId) record.runtimeTaskId = outcome.taskId;
      if (record.cancelPromise) await record.cancelPromise;
      if (record.state === "cancelled") return;
      record.state = "completed";
      record.answer = outcome.answer;
      record.latestSummary = "completed";
      const taskId = this.publicId(record);
      const receipt = formatContextReceipt(record, taskId);
      this.options.onContextNote?.(receipt);
      this.emitCompletionNotice(record, taskId, receipt);
    } catch (error) {
      if (record.cancelPromise) await record.cancelPromise;
      if (record.state === "cancelled") return;
      const message = error instanceof Error ? error.message : String(error);
      record.state = "failed";
      record.error = message;
      record.latestSummary = message || "failed";
      const taskId = this.publicId(record);
      const receipt = formatContextReceipt(record, taskId);
      this.options.onContextNote?.(receipt);
      this.emitFailureNotice(record, taskId, receipt);
    } finally {
      if (this.currentTask === record) this.currentTask = undefined;
    }
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
    if (!active.cancelPromise) {
      active.cancelPromise = this.options
        .cancelRunningTask()
        .catch(() => false)
        .then((confirmed) => {
          active.cancelPromise = undefined;
          if (confirmed) {
            this.applyConfirmedCancel(active);
          }
          return confirmed;
        });
    }
    const confirmed = await active.cancelPromise;
    return { cancelled: confirmed, taskId: this.publicId(active) };
  }

  /** Force-aborts in-memory tracking on store/app teardown (`cleanup()`). */
  markExternallyCancelled(): void {
    if (!this.currentTask) return;
    this.applyConfirmedCancel(this.currentTask);
  }

  private applyConfirmedCancel(record: ManagedTaskRecord): void {
    record.state = "cancelled";
    record.latestSummary = "cancelled";
    if (this.currentTask === record) {
      this.currentTask = undefined;
    }
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
          ? "I need your permission on screen before I can continue."
          : "I have a quick question on screen for you."
        : kind === "approval"
          ? "需要你在屏幕上确认一下，确认后我继续。"
          : "有个问题需要你看一下屏幕。";
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
    const spokenText = plain || (language === "en-US" ? "That's done." : "刚才的事情处理好了。");
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
        ? "I couldn't finish that. You can ask me what happened."
        : "刚才的事情没能做完，你可以问我具体情况。";
    this.options.onNotice?.({
      id: `${taskId}:failed`,
      spokenText,
      contextNote: receipt,
    });
  }
}
