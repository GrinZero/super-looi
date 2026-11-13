import { Buffer } from "node:buffer";
import type { VoiceAudioPort } from "./types.js";

export interface AudioItemIdentity {
  itemId: string;
  contentIndex: number;
}

export interface PlayedAudioPosition extends AudioItemIdentity {
  playedMs: number;
}

export interface AudioChunkIdentity {
  responseId?: string;
  turnId?: string;
  chunkId?: string;
}

export interface CompletedAudioChunk {
  responseId: string;
  turnId: string;
  chunkId: string;
}

export interface StoppedAudioProgress {
  responseId: string;
  turnId: string;
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
  private outputFrames: Array<{
    pcm: Uint8Array;
    itemId?: string;
    contentIndex?: number;
    responseId?: string;
    turnId?: string;
    chunkId?: string;
    completesChunks?: CompletedAudioChunk[];
  }> = [];
  private playback: Array<{
    itemId?: string;
    contentIndex?: number;
    responseId?: string;
    turnId?: string;
    chunkId?: string;
    durationMs: number;
    completesChunks?: CompletedAudioChunk[];
  }> = [];
  private playedByItem = new Map<string, number>();
  private playedByChunk = new Map<string, number>();
  private completedChunks: CompletedAudioChunk[] = [];
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

  appendOutputPcm(
    pcm: Uint8Array,
    itemId?: string,
    contentIndex?: number,
    chunk?: AudioChunkIdentity,
  ): "ok" | "overflow" {
    this.trackAudioItem(itemId, contentIndex);
    if (pcm.byteLength % 2) throw new Error("Invalid PCM length");
    if (
      this.outputBytes + pcm.byteLength > MAX_OUTPUT_BYTES ||
      this.outputFrames.length + Math.ceil(pcm.byteLength / OUTPUT_CHUNK_BYTES) > MAX_OUTPUT_FRAMES
    ) {
      return "overflow";
    }
    const completedChunk =
      chunk?.responseId && chunk?.turnId && chunk?.chunkId
        ? {
            responseId: chunk.responseId,
            turnId: chunk.turnId,
            chunkId: chunk.chunkId,
          }
        : undefined;
    if (pcm.byteLength === 0) {
      if (completedChunk) {
        const lastPending =
          this.outputFrames[this.outputFrames.length - 1] ??
          this.playback[this.playback.length - 1];
        if (lastPending) {
          lastPending.completesChunks = [...(lastPending.completesChunks ?? []), completedChunk];
        } else {
          this.completedChunks.push(completedChunk);
        }
      }
      return "ok";
    }
    for (let offset = 0; offset < pcm.byteLength; offset += OUTPUT_CHUNK_BYTES) {
      const nextOffset = offset + OUTPUT_CHUNK_BYTES;
      const isLastSlice = nextOffset >= pcm.byteLength;
      this.outputFrames.push({
        pcm: pcm.subarray(offset, nextOffset),
        itemId,
        contentIndex,
        responseId: chunk?.responseId,
        turnId: chunk?.turnId,
        chunkId: chunk?.chunkId,
        ...(isLastSlice && completedChunk ? { completesChunks: [completedChunk] } : {}),
      });
    }
    this.outputBytes += pcm.byteLength;
    return "ok";
  }

  appendOutputBase64(
    pcmBase64: string,
    itemId?: string,
    contentIndex?: number,
    chunk?: AudioChunkIdentity,
  ): "ok" | "overflow" {
    if (
      pcmBase64.length > 320000 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(pcmBase64)
    ) {
      throw new Error("Invalid PCM");
    }
    const pcm = Buffer.from(pcmBase64, "base64");
    return this.appendOutputPcm(pcm, itemId, contentIndex, chunk);
  }

  syncPlayback(queuedPlaybackMs: number): void {
    let played = Math.max(
      0,
      this.playback.reduce((sum, item) => sum + item.durationMs, 0) - Math.max(0, queuedPlaybackMs),
    );
    while (played > 0 && this.playback.length) {
      const frame = this.playback[0];
      const amount = Math.min(frame.durationMs, played);
      if (frame.itemId) {
        const key = `${frame.itemId}:${frame.contentIndex ?? 0}`;
        this.playedByItem.set(key, (this.playedByItem.get(key) ?? 0) + amount);
      }
      if (frame.responseId && frame.turnId && frame.chunkId) {
        const chunkKey = `${frame.responseId}:${frame.turnId}:${frame.chunkId}`;
        this.playedByChunk.set(chunkKey, (this.playedByChunk.get(chunkKey) ?? 0) + amount);
      }
      frame.durationMs -= amount;
      played -= amount;
      if (frame.durationMs <= 1e-6) {
        this.playback.shift();
        if (frame.completesChunks?.length) {
          this.completedChunks.push(...frame.completesChunks);
        }
      }
    }
  }

  takeCompletedChunks(queuedPlaybackMs?: number): CompletedAudioChunk[] {
    if (queuedPlaybackMs !== undefined) {
      this.syncPlayback(queuedPlaybackMs);
    }
    return this.completedChunks.splice(0);
  }

  stopProgress(queuedPlaybackMs: number): {
    completedChunks: CompletedAudioChunk[];
    stopped?: StoppedAudioProgress;
  } {
    this.syncPlayback(queuedPlaybackMs);
    const completedChunks = this.completedChunks.splice(0);
    const head = this.playback[0] ?? this.outputFrames[0];
    if (!head?.responseId || !head?.turnId) {
      return { completedChunks };
    }
    const playedMs = head.chunkId
      ? Math.max(
          0,
          Math.round(
            this.playedByChunk.get(`${head.responseId}:${head.turnId}:${head.chunkId}`) ?? 0,
          ),
        )
      : 0;
    return {
      completedChunks,
      stopped: {
        responseId: head.responseId,
        turnId: head.turnId,
        playedMs,
      },
    };
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

  step(
    audio: VoiceAudioPort,
    muted: boolean,
  ): { peakLevel: number; drained: boolean; completedChunks: CompletedAudioChunk[] } {
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
        responseId: frame.responseId,
        turnId: frame.turnId,
        chunkId: frame.chunkId,
        durationMs,
        completesChunks: frame.completesChunks,
      });
    }
    this.syncPlayback(audio.status().queuedPlaybackMs);
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
    return {
      peakLevel,
      drained,
      completedChunks: this.completedChunks.splice(0),
    };
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
    this.playedByChunk.clear();
    this.completedChunks = [];
    this.currentAudioItem = undefined;
    audio.clearPlayback();
  }
}
