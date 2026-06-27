import {
  enrollSpeaker,
  getEnrollmentStatus,
  verifySpeaker,
} from "expo-sherpa-kws";

export class SpeakerIdService {
  private enrolled = false;
  private readonly verificationThreshold = 0.6;

  async refreshEnrollmentStatus(): Promise<boolean> {
    this.enrolled = await getEnrollmentStatus();
    return this.enrolled;
  }

  get isEnrolled(): boolean {
    return this.enrolled;
  }

  async enroll(audioSamples: number[] = []): Promise<void> {
    if (audioSamples.length === 0) {
      throw new Error("Speaker enrollment requires audio samples");
    }

    this.enrolled = await enrollSpeaker(audioSamples);
  }

  async verifySamples(audioSamples: number[]): Promise<boolean> {
    if (!this.enrolled) {
      await this.refreshEnrollmentStatus();
    }
    if (!this.enrolled || audioSamples.length === 0) {
      return false;
    }

    const result = await verifySpeaker(audioSamples);
    return result.passed && result.score >= this.verificationThreshold;
  }

  async verify(): Promise<boolean> {
    return this.verifySamples([]);
  }

  get threshold(): number {
    return this.verificationThreshold;
  }
}

export const speakerIdService = new SpeakerIdService();
