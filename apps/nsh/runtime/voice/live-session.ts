import { randomUUID } from "node:crypto";
import {
  replyTextLanguage,
  type ConversationLanguage,
} from "../../../../packages/looi-runtime/src/agent/conversation-language.js";
import { observeVoiceSocket } from "../../../../packages/looi-runtime/src/telemetry/realtime-observer.js";
import type { LangfuseTracer, TraceContext } from "../../../../packages/looi-runtime/src/telemetry/langfuse.js";
import { VoiceAudioPipeline } from "./audio-pipeline.js";
import { voiceInstructions } from "./prompts.js";
import type { RealtimeProtocolAdapter } from "./protocol.js";
import { createVoiceTools, type VoiceTools } from "./tools/index.js";
import type { VoiceAudioPort, VoiceSocket, VoiceState } from "./types.js";

const CONNECT_DEADLINE_MS = 15_000;
const CANCEL_ACK_DEADLINE_MS = 4_000;
const IDLE_SLEEP_MS = 12_000;
const AWAITING_REPLY_MS = 12_000;
const TICK_INTERVAL_MS = 20;
const MAX_PENDING_WRITES = 8;
const MAX_FRAME_CHARS = 65_536;
const MAX_INBOUND_CHARS = 1_000_000;

export interface LiveVoiceSessionOptions {
  apiKey: string;
  voiceId: string;
  initialLanguage: ConversationLanguage;
  fromWakeWord: boolean;
  protocol: RealtimeProtocolAdapter;
  audio: VoiceAudioPort;
  connect: (url: string, options: { headers: Record<string, string> }) => Promise<VoiceSocket>;
  tracer?: LangfuseTracer;
  requestTask: (prompt: string, traceContext?: TraceContext) => Promise<string>;
  controlBody?: (action: string, durationMs?: number) => Promise<unknown>;
  onStatePatch: (patch: Partial<Pick<VoiceState, "phase" | "muted" | "transcript" | "error">>) => void;
  onAudioLevel?: (level: number) => void;
  onSessionComplete: () => void;
  onSessionError: (errorMessage: string) => void;
}

/**
 * Owns the complete lifecycle of one foreground Realtime WebSocket session.
 * Disposing the instance permanently neutralizes any late network/tool callbacks
 * without leaking mutable state into subsequent sessions.
 */
export class LiveVoiceSession {
  private readonly audioPipeline = new VoiceAudioPipeline();
  private readonly tools: VoiceTools;
  private conversationLanguage: ConversationLanguage;
  private continuingLanguage = false;
  private phase: "connecting" | "listening" | "speaking" = "connecting";
  private muted = false;
  private transcript = "";
  private turnActivity: "waiting_user" | "user_speaking" | "awaiting_reply" = "waiting_user";

  private socket?: VoiceSocket;
  private tickTimer?: ReturnType<typeof setTimeout>;
  private deadlineTimer?: ReturnType<typeof setTimeout>;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private awaitingTimer?: ReturnType<typeof setTimeout>;

  private writes = 0;
  private writeQueue: Promise<void> = Promise.resolve();
  private audioWriting = false;

  private discardOutput = false;
  private responseId = "";
  private cancelledResponses = new Set<string>();
  private responseInProgress = false;
  private cancelEventId = "";
  private exitAfterPlayback = false;
  private audioStartedResponseId = "";
  private outputStreamDone = false;
  private disposed = false;

  constructor(private readonly options: LiveVoiceSessionOptions) {
    this.conversationLanguage = options.initialLanguage;
    this.tools = createVoiceTools(
      {
        send: (value) => this.send(value),
        active: () => !this.disposed,
        requestTask: options.requestTask,
        controlBody: options.controlBody,
        toolTraceContext: (callId) => this.socket?.getToolTraceContext?.(callId),
        beginFarewell: () => {
          this.outputStreamDone = false;
          this.pauseTurnTimers();
        },
        endSession: () => {
          if (!this.disposed) this.options.onSessionComplete();
        },
        taskFinished: () => {
          if (!this.disposed && this.turnActivity === "awaiting_reply") {
            this.startAwaitingTimer();
          }
        },
        fail: (message) => this.fail(message),
      },
      options.protocol,
    );
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  async open(): Promise<void> {
    if (this.disposed) return;
    const connectStartedAt = Date.now();
    this.options.tracer?.registerSecret(this.options.apiKey);
    this.publish({ phase: "connecting", error: "", transcript: "" });
    this.deadlineTimer = setTimeout(() => {
      this.fail("@looi:runtimeVoiceConnectionTimedOutTryAgain");
    }, CONNECT_DEADLINE_MS);

    try {
      const target = this.options.protocol.connectTarget(this.options.apiKey);
      const rawSocket = await this.options.connect(target.url, { headers: target.headers });
      if (this.disposed) {
        void rawSocket.close().catch(() => {});
        return;
      }
      const socket = this.options.tracer?.enabled
        ? observeVoiceSocket(rawSocket, {
            tracer: this.options.tracer,
            protocol: this.options.protocol,
            sessionId: randomUUID(),
            fromWakeWord: this.options.fromWakeWord,
            connectStartedAt,
          })
        : rawSocket;
      this.socket = socket;
      const handshakeMessages = this.options.protocol.createHandshakeMessages(
        this.tools.schemas,
        {
          voiceId: this.options.voiceId,
          instructions: this.renderInstructions(),
        },
      );
      for (const message of handshakeMessages) {
        await this.send(message);
      }
      void this.readLoop(socket);
    } catch {
      this.fail("@looi:runtimeVoiceConnectionFailedCheckTheKeyServiceAccess");
    }
  }

  mute(value: boolean): void {
    if (this.disposed || (this.phase !== "listening" && this.phase !== "speaking")) return;
    this.options.audio.setMuted(value);
    this.audioPipeline.clearCapture();
    this.muted = value;
    this.publish({ muted: value });
    const frame = this.options.protocol.encodeMute(value);
    if (frame) {
      void this.send(frame).catch(() => {
        this.fail("@looi:runtimeCouldNotSyncMicrophoneMuteState");
      });
    }
  }

  interrupt(trigger: "manual" | "server_vad" = "manual"): void {
    if (this.disposed || (this.phase !== "listening" && this.phase !== "speaking")) return;
    void this.options.controlBody?.("stop").catch(() => {});
    if (this.discardOutput) return;

    const queuedMs = this.options.audio.status().queuedPlaybackMs;
    if (
      this.phase !== "speaking" &&
      queuedMs <= 0 &&
      this.audioPipeline.bufferedOutputBytes === 0 &&
      !this.responseInProgress
    ) {
      this.transcript = "";
      this.publish({ transcript: "" });
      return;
    }

    const playback = this.audioPipeline.playedPosition(queuedMs);
    const cancelEventId =
      trigger === "manual" &&
      this.responseInProgress &&
      this.options.protocol.providerId !== "doubao"
        ? `cancel_${randomUUID()}`
        : undefined;
    const frames = this.options.protocol.encodeInterrupt({
      trigger,
      responseId: this.responseId,
      responseInProgress: this.responseInProgress,
      cancelEventId,
      playback,
    });

    this.discardOutput =
      this.options.protocol.providerId === "doubao" || Boolean(cancelEventId);
    this.cancelEventId = cancelEventId ?? "";
    if (this.responseId) this.cancelledResponses.add(this.responseId);
    if (this.cancelledResponses.size > 128) {
      this.fail("@looi:runtimeStartVoiceAgain");
      return;
    }

    this.audioPipeline.clearOutput(this.options.audio);
    this.options.onAudioLevel?.(0);
    this.phase = "listening";
    this.transcript = "";
    this.publish({ phase: "listening", transcript: "" });

    if (this.discardOutput) {
      if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
      this.deadlineTimer = setTimeout(() => {
        this.fail("@looi:runtimeVoiceInterruptedStartItAgainToContinue");
      }, CANCEL_ACK_DEADLINE_MS);
    }

    for (const frame of frames) {
      void this.send(frame).catch(() => {
        this.fail("@looi:runtimeCouldNotSyncVoiceInterruption");
      });
    }
  }

  dispose(mode: "graceful" | "immediate"): void {
    if (this.disposed) return;
    this.disposed = true;

    const socket = this.socket;
    const pendingWrites = this.writeQueue;
    socket?.finalizeSession?.(mode === "graceful" ? "end_session" : "stop");
    this.socket = undefined;

    this.clearTimers();
    this.tools.reset();
    this.audioPipeline.clearCapture();
    this.audioPipeline.clearOutput(this.options.audio);
    this.options.onAudioLevel?.(0);

    if (!socket) return;
    if (mode === "graceful") {
      const closeMessage = this.options.protocol.encodeSessionClose();
      void pendingWrites
        .then(() => (closeMessage ? socket.write(JSON.stringify(closeMessage)) : undefined))
        .catch(() => {})
        .finally(() => void socket.close().catch(() => {}));
    } else {
      void socket.close().catch(() => {});
    }
  }

  private renderInstructions(): string {
    return voiceInstructions(this.conversationLanguage, this.continuingLanguage);
  }

  private publish(patch: Partial<Pick<VoiceState, "phase" | "muted" | "transcript" | "error">>): void {
    if (this.disposed) return;
    this.options.onStatePatch(patch);
  }

  private fail(message: string): void {
    if (this.disposed) return;
    this.options.onSessionError(message);
  }

  private async send(value: unknown): Promise<void> {
    if (this.disposed || !this.socket) {
      throw new Error("@looi:runtimeVoiceConnectionClosed");
    }
    if (this.writes >= MAX_PENDING_WRITES) {
      throw new Error("@looi:runtimeVoiceSendQueueIsFull");
    }
    const socket = this.socket;
    const raw = JSON.stringify(value);
    if (raw.length > MAX_FRAME_CHARS) {
      throw new Error("@looi:runtimeVoiceMessageIsTooLong");
    }
    this.writes++;
    const pending = this.writeQueue.then(async () => {
      if (this.disposed || this.socket !== socket) {
        throw new Error("@looi:runtimeVoiceConnectionClosed");
      }
      await socket.write(raw);
    });
    this.writeQueue = pending.catch(() => {});
    try {
      await pending;
    } finally {
      if (!this.disposed) this.writes--;
    }
  }

  private async readLoop(socket: VoiceSocket): Promise<void> {
    try {
      while (!this.disposed) {
        const raw = await socket.read();
        if (this.disposed) return;
        if (raw === null) {
          this.fail("@looi:runtimeVoiceConnectionEndedStartItAgain");
          return;
        }
        if (typeof raw !== "string" || raw.length > MAX_INBOUND_CHARS) {
          throw new Error("Unsupported voice frame");
        }
        const event = JSON.parse(raw);
        if (!event || typeof event !== "object") {
          throw new Error("Invalid voice frame");
        }
        const normalized = this.options.protocol.parseServerEvent(event);
        const responseId = "responseId" in normalized ? normalized.responseId : "";

        if (
          normalized.kind === "response_cancelled" &&
          (this.discardOutput || (responseId && this.cancelledResponses.has(responseId)))
        ) {
          if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
          this.deadlineTimer = undefined;
          this.discardOutput = false;
          this.responseId = "";
          this.responseInProgress = false;
          if (responseId) this.cancelledResponses.delete(responseId);
          continue;
        }
        if (normalized.kind === "response_done") {
          this.responseInProgress = false;
        }
        if (
          normalized.kind === "response_done" &&
          responseId &&
          this.cancelledResponses.delete(responseId)
        ) {
          continue;
        }
        if (
          normalized.kind === "error" &&
          normalized.clientEventId &&
          normalized.clientEventId === this.cancelEventId
        ) {
          this.cancelEventId = "";
          this.discardOutput = false;
          continue;
        }
        if (this.discardOutput && String(event.type).startsWith("response.")) {
          continue;
        }
        if (responseId) {
          if (this.discardOutput || this.cancelledResponses.has(responseId)) {
            continue;
          }
          this.responseId = responseId;
        }

        if (normalized.kind === "session_ready") {
          if (this.phase !== "connecting") continue;
          if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
          this.deadlineTimer = undefined;
          this.options.audio.setCaptureMode("conversation");
          this.options.audio.playReadyCue();
          this.turnActivity = "waiting_user";
          this.phase = "listening";
          this.muted = false;
          this.publish({ phase: "listening", muted: false });
          this.startIdleTimer();
          this.tick();
        } else if (normalized.kind === "response_started") {
          this.responseInProgress = true;
        } else if (normalized.kind === "audio_started") {
          this.audioPipeline.trackAudioItem(normalized.itemId, normalized.contentIndex);
          this.enterSpeaking(responseId);
        } else if (normalized.kind === "audio_delta" && !this.discardOutput) {
          if (this.audioStartedResponseId !== responseId || this.phase !== "speaking") {
            this.enterSpeaking(responseId);
          }
          const result = this.audioPipeline.appendOutputBase64(
            normalized.pcmBase64,
            normalized.itemId,
            normalized.contentIndex,
          );
          if (result === "overflow") {
            this.interrupt();
            this.publish({
              error: "@looi:runtimePlaybackStoppedBecauseTheReplyWasTooLong",
            });
          }
        } else if (normalized.kind === "audio_done") {
          this.outputStreamDone = true;
          if (normalized.userQueryExit) this.exitAfterPlayback = true;
          this.tools.onAudioDone();
        } else if (normalized.kind === "text_delta") {
          this.transcript = (this.transcript + normalized.delta).slice(-4096);
          this.publish({ transcript: this.transcript });
        } else if (normalized.kind === "text_done") {
          this.transcript = String(normalized.text ?? this.transcript).slice(-4096);
          this.publish({ transcript: this.transcript });
          const language = replyTextLanguage(this.transcript, this.conversationLanguage);
          if (language !== this.conversationLanguage) {
            this.conversationLanguage = language;
            this.continuingLanguage = true;
            await this.send(
              this.options.protocol.encodeInstructionsUpdate(this.renderInstructions()),
            );
          }
        } else if (
          normalized.kind === "user_speech_started" ||
          normalized.kind === "user_transcription_started"
        ) {
          this.turnActivity = "user_speaking";
          this.pauseTurnTimers();
          if (
            this.phase === "speaking" ||
            this.audioPipeline.hasPendingOutputFrames ||
            this.responseId
          ) {
            this.interrupt("server_vad");
          }
        } else if (normalized.kind === "user_speech_stopped") {
          this.turnActivity = "awaiting_reply";
          this.pauseTurnTimers();
          this.startAwaitingTimer();
        } else if (
          normalized.kind === "user_transcription_failed" ||
          normalized.kind === "response_done"
        ) {
          if (normalized.kind === "response_done") this.responseInProgress = false;
          if (normalized.kind === "response_done" && this.tools.onResponseDone(responseId)) {
            continue;
          }
          if (this.phase !== "speaking" && !this.tools.busy) {
            this.resumeWaiting();
          }
        } else if (normalized.kind === "tool_calls") {
          for (const call of normalized.calls) {
            this.tools.handle(
              {
                call_id: call.callId,
                name: call.name,
                arguments: call.argumentsJson,
              },
              this.responseId,
            );
          }
        } else if (normalized.kind === "error") {
          if (
            this.options.protocol.providerId === "doubao" &&
            this.options.voiceId &&
            this.phase === "connecting" &&
            /speaker|voice[_ -]?(?:id|type)|音色/i.test(normalized.message)
          ) {
            this.fail("@looi:runtimeDoubaoSpeakerIdUnavailableCheckTheIdAnd");
            return;
          }
          throw new Error("Provider error");
        }
      }
    } catch {
      this.fail("@looi:runtimeVoiceStoppedCheckTheNetworkOrAudioDevice");
    }
  }

  private enterSpeaking(responseId: string): void {
    this.pauseTurnTimers();
    this.outputStreamDone = false;
    this.audioStartedResponseId = responseId;
    this.tools.onAudioStarted(responseId);
    this.phase = "speaking";
    this.publish({ phase: "speaking" });
  }

  private tick(): void {
    if (this.disposed) return;
    try {
      if (this.options.audio.status().state !== "running") {
        throw new Error("Native audio interrupted");
      }
      const { peakLevel, drained } = this.audioPipeline.step(
        this.options.audio,
        this.muted,
      );
      this.options.onAudioLevel?.(peakLevel);

      if (!this.muted && !this.audioWriting) {
        this.audioWriting = true;
        const captureFrame = this.audioPipeline.shiftCaptureOrSilence();
        void this.send(this.options.protocol.encodeAudioAppend(captureFrame))
          .catch(() => {
            this.fail("@looi:runtimeVoiceNetworkSendFailed");
          })
          .finally(() => {
            if (!this.disposed) this.audioWriting = false;
          });
      }

      if (
        (this.tools.closingAfterFarewell && this.tools.farewellComplete && drained) ||
        (this.exitAfterPlayback && drained)
      ) {
        this.options.onSessionComplete();
        return;
      }

      if (
        !this.tools.closingAfterFarewell &&
        this.phase === "speaking" &&
        this.outputStreamDone &&
        drained
      ) {
        this.outputStreamDone = false;
        this.responseId = "";
        this.phase = "listening";
        this.publish({ phase: "listening" });
        this.resumeWaiting();
      }

      this.tickTimer = setTimeout(() => this.tick(), TICK_INTERVAL_MS);
    } catch {
      this.fail("@looi:runtimeAudioWasInterruptedByTheSystemTapLive");
    }
  }

  private pauseTurnTimers(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.awaitingTimer) clearTimeout(this.awaitingTimer);
    this.idleTimer = undefined;
    this.awaitingTimer = undefined;
  }

  private startIdleTimer(): void {
    this.pauseTurnTimers();
    this.idleTimer = setTimeout(() => {
      if (!this.disposed && this.turnActivity === "waiting_user" && !this.tools.busy) {
        this.options.onSessionComplete();
      }
    }, IDLE_SLEEP_MS);
  }

  private startAwaitingTimer(): void {
    if (this.awaitingTimer) clearTimeout(this.awaitingTimer);
    this.awaitingTimer = setTimeout(() => {
      if (
        !this.disposed &&
        this.turnActivity === "awaiting_reply" &&
        !this.tools.busy &&
        this.phase === "listening"
      ) {
        this.resumeWaiting();
      }
    }, AWAITING_REPLY_MS);
  }

  private resumeWaiting(): void {
    this.turnActivity = "waiting_user";
    this.startIdleTimer();
  }

  private clearTimers(): void {
    for (const timer of [
      this.tickTimer,
      this.deadlineTimer,
      this.idleTimer,
      this.awaitingTimer,
    ]) {
      if (timer) clearTimeout(timer);
    }
    this.tickTimer = undefined;
    this.deadlineTimer = undefined;
    this.idleTimer = undefined;
    this.awaitingTimer = undefined;
  }
}
