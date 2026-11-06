import {
  createSelfEventWindow,
  type SelfEventWindow,
} from "@super-looi/contracts";

/**
 * Tracks outbound assistant speech playout windows to prevent microphone loopback
 * and acoustic self-excitation.
 */
export class LoopbackSuppressionManager {
  private activeUntilMs = 0;

  public recordOutboundAudio(
    chunkBytes: number,
    sampleRate = 24000,
  ): SelfEventWindow {
    // 2 bytes per 16-bit mono PCM sample
    const durationMs = Math.ceil((chunkBytes / (sampleRate * 2)) * 1000) + 150;
    const now = Date.now();
    this.activeUntilMs = Math.max(this.activeUntilMs, now + durationMs);

    return createSelfEventWindow("tts_playback", durationMs, ["microphone"]);
  }

  public isSuppressed(nowMs: number = Date.now()): boolean {
    return nowMs < this.activeUntilMs;
  }

  public clear(): void {
    this.activeUntilMs = 0;
  }
}
