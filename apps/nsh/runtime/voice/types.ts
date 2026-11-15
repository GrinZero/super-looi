import type { Vault } from "../application.js";
import type {
  AiTurnDraft,
  PluginVoiceTool,
  ToolCallBailResult,
  UserTurnBailResult,
} from "../plugins/contracts.js";
import type { RealtimeProtocolAdapter } from "./protocol.js";
import type { VoiceSessionFailure } from "../../../../packages/looi-runtime/src/telemetry/realtime-observer.js";
import type {
  LangfuseTracer,
  TraceContext,
} from "../../../../packages/looi-runtime/src/telemetry/langfuse.js";

export interface VoiceAudioPort {
  requestPermission(): string;
  start(capture: boolean): void;
  beginWake(): number;
  startWake(ticket: number): Promise<boolean>;
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
  readonly closeCode?: number | null;
  readonly closeReason?: string | null;
  read(): Promise<string | Uint8Array | null>;
  write(value: string | Uint8Array): Promise<void>;
  close(): Promise<void>;
  finalizeSession?(reason?: string, failure?: VoiceSessionFailure): void;
  getToolTraceContext?(callId: string): TraceContext | undefined;
  setResponseTraceContext?(context?: TraceContext): void;
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
  userTranscript?: string;
  purpose?: "conversation" | "preview";
  activeVoiceId?: string;
  error: string;
}

export interface VoiceProactiveNotice {
  id: string;
  taskId?: string;
  traceContext?: TraceContext;
  spokenText: string;
  contextNote?: string;
  delivery?: "when_idle" | "interrupt";
  readonly verbatim?: boolean;
  onResult?: (result: { readonly completed: boolean; readonly interruptedReason?: string }) => void;
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
  sendMessage?(message: string, behavior: "steer" | "followUp", taskId?: string): Promise<{ status: "queued" | "handled"; taskId: string }>;
}

export interface VoiceRuntimeOptions {
  vault: Vault;
  /** Shared logical conversation used by the backend task runtime. */
  conversationId?: () => string;
  defaultLanguage?: () => "zh-CN" | "en-US";
  audio: VoiceAudioPort;
  /** Prerecorded 16 kHz mono PCM input for a real MOSS preview turn; never microphone capture. */
  previewInput?: () => Promise<Uint8Array>;
  connect: (
    url: string,
    options: { headers: Record<string, string> },
  ) => Promise<VoiceSocket>;
  onState: (state: VoiceState) => void;
  onAudioLevel?: (level: number) => void;
  /** Keeps backend conversation context warm when a user finishes speaking. */
  onConversationActivity?: () => void;
  /** Legacy synchronous task callback retained for backward compatibility. */
  requestTask?: (prompt: string, traceContext?: TraceContext) => Promise<string>;
  /** Detached task bridge acknowledging submissions before execution finishes. */
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
  stopVoiceMotion?: () => Promise<unknown>;
  redactSecrets?: (text: string) => string;
  onSessionEnd?: () => void;
  /** Legacy alias for `onSessionEnd` retained for backward compatibility. */
  cancelTask?: () => void;
  protocol?: RealtimeProtocolAdapter;
  tracer?: LangfuseTracer;
  initialPluginContext?: () => string;
  pluginVoiceTools?: () => readonly PluginVoiceTool[];
  evaluateVoiceToolCall?: (call: {
    toolName: string;
    arguments: Record<string, unknown>;
  }) => Promise<(Exclude<ToolCallBailResult, undefined> & { readonly pluginId?: string }) | undefined>;
  evaluateVoiceUserTurn?: (
    text: string,
  ) => Promise<(Exclude<UserTurnBailResult, undefined> & { readonly pluginId?: string }) | undefined>;
  assembleVoiceTurn?: (text: string) => Promise<AiTurnDraft>;
}
