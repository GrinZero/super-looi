/**
 * Speaker ID / Voice enrollment
 * Phase 1 degraded: Skip verification, always accept
 * Full sherpa-onnx Speaker ID integration planned for Phase 1.5
 */

export class SpeakerIdService {
  private enrolled = false;

  /**
   * Check if the speaker is enrolled
   */
  get isEnrolled(): boolean {
    return this.enrolled;
  }

  /**
   * Enroll speaker (Phase 1: just mark as enrolled)
   * Phase 1.5: Will use 3D-Speaker ERes2Net for voice embedding
   */
  async enroll(): Promise<void> {
    // In Phase 1, skip actual voice enrollment
    this.enrolled = true;
    console.log("[SpeakerID] Enrolled (Phase 1: auto-accept mode)");
  }

  /**
   * Verify speaker identity (Phase 1: always pass)
   * Phase 1.5: Will compute cosine similarity against enrollment embedding
   */
  async verify(_audioUri?: string): Promise<boolean> {
    // In Phase 1, always verify as the owner
    return true;
  }

  /**
   * Get verification threshold
   */
  get threshold(): number {
    return 0.6;
  }
}

export const speakerIdService = new SpeakerIdService();
