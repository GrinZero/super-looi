import { Buffer } from "node:buffer";
import type { VoiceAudioPort } from "./types.js";

export interface AudioItemIdentity {
  itemId: string;
  contentIndex: number;
}

export interface PlayedAudioPosition extends AudioItemIdentity {
  playedMs: number;
}

const CAPTURE_SAMPLE_RATE = 16000;
const CAPTURE_FRAME_BYTES = 640; // 20 ms mono PCM16 @ 16 kHz
const MAX_CAPTURE_FRAMES = 25;   // 500 ms capture ring

const OUTPUT_SAMPLE_RATE = 24000;
const OUTPUT_BYTES_PER_MS = 48;  // 24 samples/ms * 2 bytes
const OUTPUT_CHUNK_BYTES = 4800; // 100 ms mono PCM16 @ 24 kHz
const MAX_OUTPUT_BYTES = 1_440_000; // 30 s upper bound
const MAX_OUTPUT_FRAMES = 300;
const MAX_NATIVE_QUEUE_MS = 4500;
const MAX_ENQUEUE_PER_TICK = 5;

export function pcm16Rms(pcm: Uint8Array): number {
  const samples = Math.floor(pcm.byteLength / 2);
  if (samples <= 0) return 0;
  const view = new DataView(pcm.buffer, pcm.byteOffset, samples * 2);
  let sumSq = 0;
  for (let i = 0; i < samples; i++) {
    const sample = view.getInt16(i * 2, true) / 32768;
    sumSq += sample * sample;
  }
  return Math.min(1, Math.sqrt(sumSq / samples) * 3.2);
}

/**
 * Pure synchronous acoustic buffer and playback truncation ledger for a single
 * live voice session. Owns no timers or network sockets.
 */
export class VoiceAudioPipeline {
  private captureFrames: Uint8Array[] = [];
  private outputFrames: Array<{ pcm: Uint8Array; itemId?: string; contentIndex?: number }> = [];
  private playback: Array<{ itemId?: string; contentIndex?: number; durationMs: number }> = [];
  private playedByItem = new Map<string, number>();
  private currentAudioItem?: AudioItemIdentity;
  private outputBytes = 0;

  get hasPendingOutputFrames(): boolean {
    return this.outputFrames.length > 0;
  }

  get bufferedOutputBytes(): number {
    return this.outputBytes;
  }

  isDrained(audio: VoiceAudioPort): boolean {
    return this.outputFrames.length === 0 && audio.status().queuedPlaybackMs <= 0;
  }

  trackAudioItem(itemId?: string, contentIndex?: number): void {
    if (itemId) {
      this.currentAudioItem = { itemId, contentIndex: contentIndex ?? 0 };
    }
  }

  appendOutputBase64(pcmBase64: string, itemId?: string, contentIndex?: number): "ok" | "overflow" {
    this.trackAudioItem(itemId, contentIndex);
    if (
      pcmBase64.length > 320000 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(pcmBase64)
    ) {
      throw new Error("Invalid PCM");
    }
    const pcm = Buffer.from(pcmBase64, "base64");
    if (pcm.length % 2) throw new Error("Invalid PCM length");
    if (
      this.outputBytes + pcm.length > MAX_OUTPUT_BYTES ||
      this.outputFrames.length + Math.ceil(pcm.length / OUTPUT_CHUNK_BYTES) > MAX_OUTPUT_FRAMES
    ) {
      return "overflow";
    }
    for (let offset = 0; offset < pcm.length; offset += OUTPUT_CHUNK_BYTES) {
      this.outputFrames.push({
        pcm: pcm.subarray(offset, offset + OUTPUT_CHUNK_BYTES),
        itemId,
        contentIndex,
      });
    }
    this.outputBytes += pcm.length;
    return "ok";
  }

  syncPlayback(queuedPlaybackMs: number): void {
    let played = Math.max(
      0,
      this.playback.reduce((sum, item) => sum + item.durationMs, 0) - queuedPlaybackMs,
    );
    while (played > 0 && this.playback.length) {
      const frame = this.playback[0];
      const amount = Math.min(frame.durationMs, played);
      if (frame.itemId) {
        const key = `${frame.itemId}:${frame.contentIndex ?? 0}`;
        this.playedByItem.set(key, (this.playedByItem.get(key) ?? 0) + amount);
      }
      frame.durationMs -= amount;
      played -= amount;
      if (frame.durationMs <= 0) this.playback.shift();
    }
  }

  playedPosition(queuedPlaybackMs: number): PlayedAudioPosition | undefined {
    this.syncPlayback(queuedPlaybackMs);
    if (!this.currentAudioItem) return undefined;
    const key = `${this.currentAudioItem.itemId}:${this.currentAudioItem.contentIndex}`;
    return {
      ...this.currentAudioItem,
      playedMs: this.playedByItem.get(key) ?? 0,
    };
  }

  step(audio: VoiceAudioPort, muted: boolean): { peakLevel: number; drained: boolean } {
    this.syncPlayback(audio.status().queuedPlaybackMs);
    let peakLevel = 0;
    for (let count = 0; count < MAX_ENQUEUE_PER_TICK && this.outputFrames.length; count++) {
      const frame = this.outputFrames[0];
      const durationMs = frame.pcm.length / OUTPUT_BYTES_PER_MS;
      if (audio.status().queuedPlaybackMs + durationMs > MAX_NATIVE_QUEUE_MS) {
        break;
      }
      this.outputFrames.shift();
      this.outputBytes -= frame.pcm.length;
      peakLevel = Math.max(peakLevel, pcm16Rms(frame.pcm));
      audio.enqueue(frame.pcm, OUTPUT_SAMPLE_RATE);
      this.playback.push({
        itemId: frame.itemId,
        contentIndex: frame.contentIndex,
        durationMs,
      });
    }
    for (const packet of audio.drainCapture()) {
      if (packet.sampleRate !== CAPTURE_SAMPLE_RATE || packet.pcm.length !== CAPTURE_FRAME_BYTES) {
        throw new Error("Invalid capture frame");
      }
      if (!muted) {
        peakLevel = Math.max(peakLevel, pcm16Rms(packet.pcm));
      }
      this.captureFrames.push(packet.pcm);
    }
    if (this.captureFrames.length > MAX_CAPTURE_FRAMES) {
      this.captureFrames.splice(0, this.captureFrames.length - MAX_CAPTURE_FRAMES);
    }
    const drained = this.outputFrames.length === 0 && audio.status().queuedPlaybackMs <= 0;
    return { peakLevel, drained };
  }

  shiftCaptureOrSilence(): Uint8Array {
    return this.captureFrames.shift() ?? new Uint8Array(CAPTURE_FRAME_BYTES);
  }

  clearCapture(): void {
    this.captureFrames = [];
  }

  clearOutput(audio: VoiceAudioPort): void {
    this.outputFrames = [];
    this.outputBytes = 0;
    this.playback = [];
    this.playedByItem.clear();
    this.currentAudioItem = undefined;
    audio.clearPlayback();
  }
}
