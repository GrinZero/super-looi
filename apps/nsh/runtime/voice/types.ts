import type { Vault } from "../application.js";
import type { RealtimeProtocolAdapter } from "./protocol.js";
import type {
  LangfuseTracer,
  TraceContext,
} from "../../../../packages/looi-runtime/src/telemetry/langfuse.js";

export interface VoiceAudioPort {
  requestPermission(): string;
  start(capture: boolean): void;
  stop(): void;
  enqueue(pcm: Uint8Array, rate: number): void;
  clearPlayback(): void;
  setMuted(muted: boolean): void;
  setCaptureMode(mode: string): void;
  playReadyCue(): void;
  playDockCue?(docked: boolean): void;
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

export interface VoiceProactiveNotice {
  id: string;
  spokenText: string;
  contextNote?: string;
}

export type VoiceTaskSubmissionResult =
  | { status: "completed"; taskId: string; answer: string }
  | { status: "running_in_background"; taskId: string; latestSummary: string }
  | {
      status: "waiting_user_confirmation";
      taskId: string;
      interactionKind: "approval" | "question";
      latestSummary: string;
    }
  | { status: "busy"; taskId: string; latestSummary: string }
  | { status: "failed"; taskId?: string; error: string };

export interface VoiceTaskStatusSnapshot {
  taskId: string;
  prompt: string;
  state: "running" | "waiting_user" | "completed" | "failed" | "cancelled";
  latestSummary: string;
  answer?: string;
  error?: string;
}

export interface VoiceTaskBridge {
  submit(
    prompt: string,
    traceContext?: TraceContext,
  ): Promise<VoiceTaskSubmissionResult>;
  inspect(taskId?: string): VoiceTaskStatusSnapshot | null;
  cancel(taskId?: string): Promise<{ cancelled: boolean; taskId?: string }>;
}

export interface VoiceRuntimeOptions {
  vault: Vault;
  defaultLanguage?: () => "zh-CN" | "en-US";
  audio: VoiceAudioPort;
  connect: (
    url: string,
    options: { headers: Record<string, string> },
  ) => Promise<VoiceSocket>;
  onState: (state: VoiceState) => void;
  onAudioLevel?: (level: number) => void;
  /** Legacy synchronous task callback retained for backward compatibility. */
  requestTask?: (prompt: string, traceContext?: TraceContext) => Promise<string>;
  /** Detached task bridge supporting fast-path inline completion & async promotion. */
  taskBridge?: VoiceTaskBridge;
  controlBody?: (
    action: string,
    durationMs?: number,
    options?: {
      headDegrees?: number;
      brightness?: number;
      speed?: number;
      turn?: number;
    },
  ) => Promise<unknown>;
  onSessionEnd?: () => void;
  /** Legacy alias for `onSessionEnd` retained for backward compatibility. */
  cancelTask?: () => void;
  protocol?: RealtimeProtocolAdapter;
  tracer?: LangfuseTracer;
}
