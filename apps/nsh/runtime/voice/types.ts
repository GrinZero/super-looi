import type { Vault } from "../application.js";
import type { RealtimeProtocolAdapter } from "./protocol.js";
import type { LangfuseTracer, TraceContext } from "../../../../packages/looi-runtime/src/telemetry/langfuse.js";

export interface VoiceAudioPort {
  requestPermission(): string;
  start(capture: boolean): void;
  stop(): void;
  enqueue(pcm: Uint8Array, rate: number): void;
  clearPlayback(): void;
  setMuted(muted: boolean): void;
  setCaptureMode(mode: string): void;
  playReadyCue(): void;
  drainCapture(): Array<{
    pcm: Uint8Array;
    timestampMs: number;
    sampleRate: number;
  }>;
  status(): {
    state: string;
    permission: string;
    error: string;
    queuedPlaybackMs: number;
    captureMode: string;
    wakeWord: string;
    kwsReady: boolean;
  };
}

export interface VoiceSocket {
  read(): Promise<string | Uint8Array | null>;
  write(value: string): Promise<void>;
  close(): Promise<void>;
  finalizeSession?(reason?: string): void;
  getToolTraceContext?(callId: string): TraceContext | undefined;
}

export interface VoiceState {
  phase:
    | "idle"
    | "standby"
    | "permission"
    | "connecting"
    | "listening"
    | "speaking"
    | "error";
  muted: boolean;
  wakeEnabled: boolean;
  transcript: string;
  error: string;
}

export interface VoiceRuntimeOptions {
  vault: Vault;
  audio: VoiceAudioPort;
  connect: (
    url: string,
    options: { headers: Record<string, string> },
  ) => Promise<VoiceSocket>;
  onState: (state: VoiceState) => void;
  onAudioLevel?: (level: number) => void;
  requestTask: (prompt: string, traceContext?: TraceContext) => Promise<string>;
  cancelTask: () => void;
  protocol?: RealtimeProtocolAdapter;
  tracer?: LangfuseTracer;
}
