import type { PluginAiCapability, PluginFailure } from "../../../runtime/plugins/contracts.js";
import type { WerewolfJudgeVoiceStatus } from "../contracts.js";
import { WerewolfRuleError } from "./engine.js";

export interface JudgeSpeechCoordinatorOptions {
  readonly ai?: PluginAiCapability;
  readonly pluginId: string;
  readonly isPaused: () => boolean;
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly onStatusChange: () => void;
  readonly onSpeechFailure?: (failure: PluginFailure) => void;
}

const DEALING_SEAT_SPEECH_DELAY_MS = 250;

const NON_RETRYABLE_REASONS = new Set([
  "voice_closed",
  "empty_speech",
  "voice_provider_unconfigured",
  "microphone_permission_required",
  "ai_proactive_disabled",
  "ai_capability_unavailable",
  "session_inactive",
  "session_stopped",
  "runtime_closed",
  "queue_overflow",
  "barge_in",
  "preempted",
]);

function isNonRetryableReason(reason: string): boolean {
  return (
    NON_RETRYABLE_REASONS.has(reason) ||
    reason.includes("@looi:configureVoiceKey") ||
    reason.includes("@looi:runtimeAllowMicrophoneAccess") ||
    reason.includes("@looi:runtimeMicrophoneAccessUnavailable") ||
    reason.includes("@looi:runtimeMicrophoneRequestCancelled") ||
    reason.includes("Invalid API key") ||
    reason.includes("401")
  );
}

/**
 * Serializes tabletop referee announcements onto a single voice barrier using
 * muted broadcast isolation, single transient retry, subtitle retention, and replay.
 */
export class JudgeSpeechCoordinator {
  private epoch = 0;
  private dealingSpeech: AbortController | null = null;
  private speakBarrier: Promise<void> = Promise.resolve();
  private speaking = false;
  private mutedByHost = false;
  private lastSpokenText: string | null = null;
  private lastContextNote: string;
  private lastCloseToStandby = false;
  private lastInterruptedReason: string | null = null;
  private degradedToSubtitles = false;

  constructor(private readonly options: JudgeSpeechCoordinatorOptions) {
    this.lastContextNote = `[${options.pluginId}] 法官台词播报`;
  }

  status(): WerewolfJudgeVoiceStatus {
    return {
      speaking: this.speaking,
      mutedByHost: this.mutedByHost,
      lastSpokenText: this.lastSpokenText,
      lastInterruptedReason: this.lastInterruptedReason,
      degradedToSubtitles: this.degradedToSubtitles,
    };
  }

  isMutedByHost(): boolean {
    return this.mutedByHost;
  }

  restoreMutedByHost(muted: boolean): void {
    this.mutedByHost = muted;
  }

  setMutedByHost(muted: boolean): void {
    if (this.mutedByHost === muted) return;
    this.mutedByHost = muted;
    if (muted) {
      this.bumpEpoch();
      this.degradedToSubtitles = false;
      this.lastInterruptedReason = null;
    }
    this.options.onStatusChange();
  }

  cancelDealingSpeech(): void {
    this.dealingSpeech?.abort();
    this.dealingSpeech = null;
  }

  bumpEpoch(): void {
    this.epoch += 1;
    this.cancelDealingSpeech();
    this.speaking = false;
  }

  resetForIdle(): void {
    this.bumpEpoch();
    this.mutedByHost = false;
    this.lastSpokenText = null;
    this.lastInterruptedReason = null;
    this.degradedToSubtitles = false;
    this.lastCloseToStandby = false;
    this.lastContextNote = `[${this.options.pluginId}] 法官台词播报`;
  }

  seedSubtitle(text: string): void {
    const clean = text.trim();
    if (clean) {
      this.lastSpokenText = clean;
    }
  }

  async speakSequential(options: {
    readonly text: string;
    readonly contextNote?: string;
    readonly closeToStandbyOnComplete?: boolean;
    readonly dealing?: "seat" | "phase";
  }): Promise<void> {
    const clean = options.text.trim();
    if (!clean) return;
    if (options.dealing) this.cancelDealingSpeech();

    this.lastSpokenText = clean;
    if (options.contextNote) {
      this.lastContextNote = options.contextNote;
    }
    this.lastCloseToStandby = Boolean(options.closeToStandbyOnComplete);

    if (this.mutedByHost) {
      this.degradedToSubtitles = false;
      this.lastInterruptedReason = null;
      this.options.onStatusChange();
      return;
    }

    if (!this.options.ai) {
      this.degradedToSubtitles = true;
      this.lastInterruptedReason = "ai_capability_unavailable";
      this.options.onStatusChange();
      return;
    }

    const dealingSpeech = options.dealing ? new AbortController() : null;
    if (dealingSpeech) this.dealingSpeech = dealingSpeech;
    const signal = dealingSpeech?.signal;
    const ready = options.dealing === "seat"
      ? this.options.sleep(DEALING_SEAT_SPEECH_DELAY_MS, signal)
      : undefined;
    const myEpoch = this.epoch;
    const stale = () => signal?.aborted || myEpoch !== this.epoch;
    const contextNote = options.contextNote ?? this.lastContextNote;
    const closeToStandbyOnComplete = Boolean(options.closeToStandbyOnComplete);

    const task = this.speakBarrier.then(async () => {
      if (ready) await ready;
      if (stale() || this.mutedByHost || this.options.isPaused()) {
        return;
      }

      this.speaking = true;
      this.lastInterruptedReason = null;
      this.options.onStatusChange();

      try {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          if (stale() || this.mutedByHost || this.options.isPaused()) {
            return;
          }

          let receipt: { readonly completed: boolean; readonly interruptedReason?: string };
          try {
            receipt = await this.options.ai!.speak({
              spokenText: clean,
              contextNote,
              delivery: "when_idle",
              capturePolicy: "muted_broadcast",
              verbatim: true,
              holdAliveMs: 20_000,
              closeToStandbyOnComplete,
              ...(signal ? { signal } : {}),
            });
          } catch (error) {
            if (stale()) return;
            const reason = error instanceof Error && error.message ? error.message : String(error);
            if (attempt === 0 && !isNonRetryableReason(reason)) {
              await this.options.sleep(350, signal);
              continue;
            }
            if (myEpoch === this.epoch) {
              this.degradedToSubtitles = true;
              this.lastInterruptedReason = reason;
              this.options.onSpeechFailure?.({
                stage: "judge_speech",
                code: "ERR_JUDGE_SPEECH_FAILED",
                reason,
              });
            }
            return;
          }

          if (stale()) {
            return;
          }
          if (receipt.completed) {
            this.degradedToSubtitles = false;
            this.lastInterruptedReason = null;
            return;
          }

          const reason = receipt.interruptedReason?.trim() || "speak_interrupted";
          const canRetry =
            attempt === 0 &&
            !isNonRetryableReason(reason) &&
            !this.mutedByHost &&
            !this.options.isPaused();
          if (canRetry) {
            await this.options.sleep(350, signal);
            continue;
          }

          this.degradedToSubtitles = true;
          this.lastInterruptedReason = reason;
          this.options.onSpeechFailure?.({
            stage: "judge_speech",
            code: "ERR_JUDGE_SPEECH_INTERRUPTED",
            reason,
          });
          return;
        }
      } finally {
        if (myEpoch === this.epoch) {
          this.speaking = false;
        }
        this.options.onStatusChange();
      }
    });

    this.speakBarrier = task.catch(() => {}).finally(() => {
      if (dealingSpeech && this.dealingSpeech === dealingSpeech) this.dealingSpeech = null;
    });
    await this.speakBarrier;
  }

  async replayLast(inDealing: boolean): Promise<void> {
    if (!this.lastSpokenText) {
      throw new WerewolfRuleError(
        "replay_last_speech",
        "ERR_NO_JUDGE_SPEECH",
        "当前暂无可重播的法官台词",
      );
    }
    if (this.mutedByHost) {
      throw new WerewolfRuleError(
        "replay_last_speech",
        "ERR_JUDGE_VOICE_MUTED",
        "法官语音当前处于静音状态，请先取消静音或查看屏幕字幕",
      );
    }
    this.bumpEpoch();
    await this.speakSequential({
      text: this.lastSpokenText,
      contextNote: this.lastContextNote,
      closeToStandbyOnComplete: this.lastCloseToStandby,
      dealing: inDealing ? "phase" : undefined,
    });
  }
}
