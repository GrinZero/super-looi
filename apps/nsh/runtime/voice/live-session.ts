import { randomUUID } from "node:crypto";
import {
  replyTextLanguage,
  type ConversationLanguage,
} from "../../../../packages/looi-runtime/src/agent/conversation-language.js";
import { observeVoiceSocket } from "../../../../packages/looi-runtime/src/telemetry/realtime-observer.js";
import type {
  LangfuseTracer,
  TraceContext,
} from "../../../../packages/looi-runtime/src/telemetry/langfuse.js";
import { VoiceAudioPipeline } from "./audio-pipeline.js";
import { voiceInstructions } from "./prompts.js";
import type { RealtimeProtocolAdapter } from "./protocol.js";
import { createVoiceTools, type VoiceTools } from "./tools/index.js";
import type {
  VoiceAudioPort,
  VoiceProactiveNotice,
  VoiceSocket,
  VoiceState,
  VoiceTaskBridge,
} from "./types.js";

const CONNECT_DEADLINE_MS = 15_000;
const CANCEL_ACK_DEADLINE_MS = 4_000;
const IDLE_SLEEP_MS = 12_000;
const TICK_INTERVAL_MS = 20;
const MAX_PENDING_WRITES = 8;
const MAX_NOTICE_QUEUE = 8;
const MAX_FRAME_CHARS = 65_536;
const MAX_INBOUND_CHARS = 1_000_000;

export interface LiveVoiceSessionOptions {
  apiKey: string;
  voiceId: string;
  initialLanguage: ConversationLanguage;
  initialContextNote?: string;
  fromWakeWord: boolean;
  protocol: RealtimeProtocolAdapter;
  audio: VoiceAudioPort;
  connect: (url: string, options: { headers: Record<string, string> }) => Promise<VoiceSocket>;
  tracer?: LangfuseTracer;
  requestTask?: (prompt: string, traceContext?: TraceContext) => Promise<string>;
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
  onStatePatch: (
    patch: Partial<Pick<VoiceState, "phase" | "muted" | "transcript" | "error">>,
  ) => void;
  onAudioLevel?: (level: number) => void;
  onSessionComplete: () => void;
  onSessionError: (errorMessage: string) => void;
}

/**
 * Owns the complete lifecycle of one foreground Realtime WebSocket session,
 * including turn gating and `WHEN_IDLE` proactive background-task announcements.
 */
export class LiveVoiceSession {
  private readonly audioPipeline = new VoiceAudioPipeline();
  private readonly tools: VoiceTools;
  private readonly noticeQueue: VoiceProactiveNotice[] = [];
  private readonly seenNoticeIds = new Set<string>();
  private readonly toolCallResponseIds = new Set<string>();
  private conversationLanguage: ConversationLanguage;
  private continuingLanguage = false;
  private contextNote: string;
  private phase: "connecting" | "listening" | "speaking" = "connecting";
  private muted = false;
  private transcript = "";
  private transcriptTurnOpen = false;
  private transcriptResponseId = "";
  private turnActivity: "waiting_user" | "user_speaking" | "awaiting_reply" = "waiting_user";
  private silenceSince = 0;

  private socket?: VoiceSocket;
  private tickTimer?: ReturnType<typeof setTimeout>;
  private deadlineTimer?: ReturnType<typeof setTimeout>;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private awaitingTimer?: ReturnType<typeof setTimeout>;

  private writes = 0;
  private writeQueue: Promise<void> = Promise.resolve();
  private audioWriting = false;
  private dispatchingNotice = false;

  private discardOutput = false;
  private responseId = "";
  private cancelledResponses = new Set<string>();
  private responseInProgress = false;
  private serverResponseDone = false;
  private cancelEventId = "";
  private audioStartedResponseId = "";
  private outputStreamDone = false;
  private disposed = false;

  constructor(private readonly options: LiveVoiceSessionOptions) {
    this.conversationLanguage = options.initialLanguage;
    this.contextNote = (options.initialContextNote ?? "").trim();
    this.tools = createVoiceTools(
      {
        send: (value) => this.send(value),
        active: () => !this.disposed,
        requestTask: options.requestTask,
        taskBridge: options.taskBridge,
        controlBody: options.controlBody,
        toolTraceContext: (callId) => this.socket?.getToolTraceContext?.(callId),
        taskFinished: () => {
          if (this.disposed) return;
          if (this.turnActivity !== "user_speaking") {
            this.turnActivity = "awaiting_reply";
            this.silenceSince = Date.now();
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

  enqueueNotice(notice: VoiceProactiveNotice): void {
    if (this.disposed || !notice.spokenText.trim()) return;
    if (this.seenNoticeIds.has(notice.id)) return;
    if (this.seenNoticeIds.size >= 128) {
      const oldest = this.seenNoticeIds.values().next().value;
      if (oldest !== undefined) this.seenNoticeIds.delete(oldest);
    }
    this.seenNoticeIds.add(notice.id);
    if (this.noticeQueue.length >= MAX_NOTICE_QUEUE) {
      this.noticeQueue.shift();
    }
    this.noticeQueue.push(notice);
    this.flushNoticeIfIdle();
  }

  updateContextNote(note: string, syncImmediately = false): void {
    if (this.disposed) return;
    const next = note.trim();
    if (next === this.contextNote) return;
    this.contextNote = next;
    if (syncImmediately && this.socket && this.phase !== "connecting") {
      void this.send(
        this.options.protocol.encodeInstructionsUpdate(this.renderInstructions()),
      ).catch(() => {
        this.fail("@looi:runtimeVoiceNetworkSendFailed");
      });
    }
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
      this.transcriptTurnOpen = false;
      this.transcriptResponseId = "";
      this.publish({ transcript: "" });
      return;
    }

    // On Doubao, once `response.done` has already arrived (`serverResponseDone`),
    // the server has no active response left to cancel; clear local buffered audio only.
    if (this.options.protocol.providerId === "doubao" && this.serverResponseDone) {
      this.audioPipeline.clearOutput(this.options.audio);
      this.options.onAudioLevel?.(0);
      this.outputStreamDone = false;
      this.serverResponseDone = false;
      this.responseInProgress = false;
      this.responseId = "";
      this.phase = "listening";
      this.transcript = "";
      this.transcriptTurnOpen = false;
      this.transcriptResponseId = "";
      this.publish({ phase: "listening", transcript: "" });
      if (this.turnActivity !== "user_speaking") {
        this.silenceSince = Date.now();
        this.resumeWaiting();
      }
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
    this.outputStreamDone = false;
    this.phase = "listening";
    this.transcript = "";
    this.transcriptTurnOpen = false;
    this.transcriptResponseId = "";
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
    this.noticeQueue.length = 0;
    this.seenNoticeIds.clear();
    this.toolCallResponseIds.clear();
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
    const base = voiceInstructions(this.conversationLanguage, this.continuingLanguage);
    return this.contextNote ? `${base}\n\n${this.contextNote}` : base;
  }

  private canDispatchNotice(): boolean {
    return (
      !this.disposed &&
      Boolean(this.socket) &&
      !this.dispatchingNotice &&
      this.phase === "listening" &&
      this.turnActivity === "waiting_user" &&
      !this.responseInProgress &&
      !this.discardOutput &&
      !this.tools.busy &&
      this.audioPipeline.isDrained(this.options.audio)
    );
  }

  private flushNoticeIfIdle(): boolean {
    if (!this.canDispatchNotice() || this.noticeQueue.length === 0) {
      return false;
    }
    const notice = this.noticeQueue.shift()!;
    if (notice.contextNote) {
      this.contextNote = notice.contextNote.trim();
    }
    const frames = this.options.protocol.encodeProactiveSpeech({
      spokenText: notice.spokenText,
      instructions: notice.contextNote ? this.renderInstructions() : undefined,
    });
    if (frames.length === 0) return false;

    this.dispatchingNotice = true;
    this.pauseTurnTimers();
    this.turnActivity = "awaiting_reply";
    this.silenceSince = Date.now();
    this.startAwaitingTimer();

    let speechTriggered = false;
    void (async () => {
      for (const frame of frames) {
        if (
          this.disposed ||
          this.turnActivity !== "awaiting_reply" ||
          this.discardOutput
        ) {
          if (!this.disposed && !speechTriggered) {
            this.noticeQueue.unshift(notice);
          }
          return;
        }
        const frameType = (frame as { type?: unknown }).type;
        if (
          frameType === "speech_text_buffer.commit" ||
          frameType === "conversation.item.create"
        ) {
          speechTriggered = true;
          if (this.options.protocol.providerId === "doubao") {
            this.transcript = notice.spokenText.slice(-4096);
            this.transcriptTurnOpen = false;
            this.transcriptResponseId = "";
            this.publish({ transcript: this.transcript });
          }
        }
        await this.send(frame);
      }
    })()
      .catch(() => {
        this.fail("@looi:runtimeVoiceNetworkSendFailed");
      })
      .finally(() => {
        if (!this.disposed) {
          this.dispatchingNotice = false;
          if (this.turnActivity === "waiting_user") {
            this.flushNoticeIfIdle();
          }
        }
      });
    return true;
  }

  private publish(
    patch: Partial<Pick<VoiceState, "phase" | "muted" | "transcript" | "error">>,
  ): void {
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

        if (normalized.kind === "response_cancelled") {
          this.responseInProgress = false;
          this.serverResponseDone = false;
          if (responseId) this.toolCallResponseIds.delete(responseId);
          if (this.phase === "speaking") this.outputStreamDone = true;
          if (this.discardOutput || (responseId && this.cancelledResponses.has(responseId))) {
            if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
            this.deadlineTimer = undefined;
            this.discardOutput = false;
            this.responseId = "";
            if (responseId) this.cancelledResponses.delete(responseId);
            continue;
          }
        }
        if (normalized.kind === "response_done") {
          this.responseInProgress = false;
        }
        if (
          normalized.kind === "response_done" &&
          responseId &&
          this.cancelledResponses.delete(responseId)
        ) {
          this.toolCallResponseIds.delete(responseId);
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
          this.silenceSince = Date.now();
          this.phase = "listening";
          this.muted = false;
          this.publish({ phase: "listening", muted: false });
          if (!this.flushNoticeIfIdle()) {
            this.startIdleTimer();
          }
          this.tick();
        } else if (normalized.kind === "response_started") {
          this.responseInProgress = true;
          this.serverResponseDone = false;
        } else if (normalized.kind === "audio_started") {
          this.responseInProgress = true;
          this.serverResponseDone = false;
          this.audioPipeline.trackAudioItem(normalized.itemId, normalized.contentIndex);
          this.enterSpeaking(responseId);
        } else if (normalized.kind === "audio_delta" && !this.discardOutput) {
          this.responseInProgress = true;
          this.serverResponseDone = false;
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
        } else if (normalized.kind === "text_delta") {
          if (
            !this.transcriptTurnOpen ||
            (responseId && this.transcriptResponseId && responseId !== this.transcriptResponseId)
          ) {
            this.transcript = "";
            this.transcriptTurnOpen = true;
            this.transcriptResponseId = responseId;
          }
          this.transcript = (this.transcript + normalized.delta).slice(-4096);
          this.publish({ transcript: this.transcript });
        } else if (normalized.kind === "text_done") {
          this.transcript = String(normalized.text ?? this.transcript).slice(-4096);
          this.transcriptTurnOpen = false;
          this.transcriptResponseId = responseId;
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
          if (this.turnActivity === "user_speaking") this.silenceSince = Date.now();
          this.turnActivity = "awaiting_reply";
          this.pauseTurnTimers();
          this.startAwaitingTimer();
        } else if (normalized.kind === "user_transcription_failed") {
          if (this.turnActivity === "user_speaking") {
            this.silenceSince = Date.now();
          }
          if (this.phase !== "speaking" && !this.tools.busy && !this.dispatchingNotice) {
            this.resumeWaiting();
          }
        } else if (normalized.kind === "response_done") {
          const wasToolCallTurn = Boolean(
            responseId && this.toolCallResponseIds.delete(responseId),
          );
          this.responseInProgress = false;
          this.serverResponseDone = true;
          if (this.phase === "speaking") {
            // Guarantees `tick()` drains back to `listening` even if `audio_done` was omitted.
            this.outputStreamDone = true;
          } else if (
            !this.tools.busy &&
            !this.dispatchingNotice &&
            this.turnActivity !== "user_speaking" &&
            !wasToolCallTurn
          ) {
            this.resumeWaiting();
          }
        } else if (normalized.kind === "tool_calls") {
          if (responseId) {
            if (this.toolCallResponseIds.size >= 128) {
              const oldest = this.toolCallResponseIds.values().next().value;
              if (oldest !== undefined) this.toolCallResponseIds.delete(oldest);
            }
            this.toolCallResponseIds.add(responseId);
          }
          if (this.turnActivity === "waiting_user") {
            this.turnActivity = "awaiting_reply";
          }
          this.pauseTurnTimers();
          for (const call of normalized.calls) {
            this.tools.handle({
              call_id: call.callId,
              name: call.name,
              arguments: call.argumentsJson,
            });
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
        this.phase === "speaking" &&
        this.outputStreamDone &&
        drained
      ) {
        this.outputStreamDone = false;
        this.serverResponseDone = false;
        this.responseInProgress = false;
        this.responseId = "";
        this.phase = "listening";
        this.publish({ phase: "listening" });
        this.silenceSince = Date.now();
        if (this.turnActivity !== "user_speaking" && !this.tools.busy) {
          this.resumeWaiting();
        }
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
      if (
        !this.disposed &&
        this.turnActivity === "waiting_user" &&
        !this.tools.busy &&
        this.noticeQueue.length === 0
      ) {
        this.options.onSessionComplete();
      }
    }, this.remainingSilenceMs());
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
        if (this.noticeQueue.length > 0) {
          this.silenceSince = Date.now();
          this.resumeWaiting();
          return;
        }
        this.options.onSessionComplete();
      }
    }, this.remainingSilenceMs());
  }

  private remainingSilenceMs(): number {
    return Math.max(0, IDLE_SLEEP_MS - (Date.now() - this.silenceSince));
  }

  private resumeWaiting(): void {
    this.turnActivity = "waiting_user";
    if (this.flushNoticeIfIdle()) return;
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
