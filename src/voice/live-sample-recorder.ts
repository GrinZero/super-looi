import { kwsAudioFeeder } from "./kws-audio-feeder";

const MIN_SPEAKER_SAMPLES = 16000;
const EDGE_PADDING_SAMPLES = 4000;
const ENERGY_THRESHOLD = 0.01;

export class LiveSampleRecorder {
  private unsubscribe: (() => void) | null = null;
  private samples: number[] = [];

  async start(): Promise<void> {
    await this.stop();
    this.samples = [];
    await kwsAudioFeeder.stop();
    kwsAudioFeeder.setWakewordFeedingEnabled(false);
    this.unsubscribe = kwsAudioFeeder.subscribeSamples((samples) => {
      this.samples.push(...samples);
    });
    await kwsAudioFeeder.start();
  }

  async stop(): Promise<number[]> {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    kwsAudioFeeder.setWakewordFeedingEnabled(true);
    await kwsAudioFeeder.stop().catch(() => undefined);
    const recorded = this.trimLowEnergyEdges(this.samples);
    this.samples = [];
    return recorded;
  }

  async cancel(): Promise<void> {
    await this.stop();
  }

  get isRecording(): boolean {
    return Boolean(this.unsubscribe);
  }

  private trimLowEnergyEdges(samples: number[]): number[] {
    if (samples.length <= MIN_SPEAKER_SAMPLES) return samples;

    let start = 0;
    let end = samples.length;
    while (start < end && Math.abs(samples[start]) < ENERGY_THRESHOLD) {
      start += 1;
    }
    while (end > start && Math.abs(samples[end - 1]) < ENERGY_THRESHOLD) {
      end -= 1;
    }

    start = Math.max(0, start - EDGE_PADDING_SAMPLES);
    end = Math.min(samples.length, end + EDGE_PADDING_SAMPLES);
    const trimmed = samples.slice(start, end);
    return trimmed.length >= MIN_SPEAKER_SAMPLES ? trimmed : samples;
  }
}

export const liveSampleRecorder = new LiveSampleRecorder();
