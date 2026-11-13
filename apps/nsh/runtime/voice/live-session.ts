import { randomUUID } from "node:crypto";
import {
  replyTextLanguage,
  type ConversationLanguage,
} from "../../../../packages/looi-runtime/src/agent/conversation-language.js";
import {
  observeVoiceSocket,
  type VoiceConversationMessage,
} from "../../../../packages/looi-runtime/src/telemetry/realtime-observer.js";
import {
  NOOP_TRACER,
  type LangfuseTracer,
  type TraceContext,
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
  purpose?: "conversation" | "preview";
  previewText?: string;
  initialLanguage: ConversationLanguage;
  initialContextNote?: string;
  sessionId?: string;
  history?: VoiceConversationMessage[];
  onConversation?: (messages: VoiceConversationMessage[]) => void;
  fromWakeWord: boolean;
  protocol: RealtimeProtocolAdapter;
  audio: VoiceAudioPort;
  previewInput?: () => Promise<Uint8Array>;
  connect: (url: string, options: { headers: Record<string, string> }) => Promise<VoiceSocket>;
  tracer?: LangfuseTracer;
  requestTask?: (prompt: string, traceContext?: TraceContext) => Promise<string>;
  taskBridge?: VoiceTaskBridge;
  onConversationActivity?: () => void;
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
    patch: Partial<
      Pick<
        VoiceState,
        | "phase"
        | "muted"
        | "transcript"
        | "userTranscript"
        | "purpose"
        | "activeVoiceId"
        | "error"
      >
    >,
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
  private previewPcm?: Uint8Array;
  private previewOffset = 0;
  private previewPlaybackReported = false;
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
  private userTranscript = "";
  private readonly purpose: "conversation" | "preview";
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
  private turnId = "";
  private audioDoneTurn?: { responseId: string; turnId: string };
  private cancelledResponses = new Set<string>();
  private responseInProgress = false;
  private serverResponseDone = false;
  private cancelEventId = "";
  private audioStartedResponseId = "";
  private outputStreamDone = false;
  private disposed = false;
  private readonly sessionId: string;
  private connectStartedAt = 0;
  private connectionStage = "websocket.connect";

  constructor(private readonly options: LiveVoiceSessionOptions) {
    this.sessionId = options.sessionId ?? randomUUID();
    this.purpose = options.purpose ?? "conversation";
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

  get sessionPurpose(): "conversation" | "preview" {
    return this.purpose;
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

  takePendingNotices(): VoiceProactiveNotice[] {
    return this.noticeQueue.splice(0);
  }

  updateContextNote(note: string, syncImmediately = false): void {
    if (this.disposed) return;
    const next = note.trim();
    if (next === this.contextNote) return;
    this.contextNote = next;
    if (syncImmediately && this.socket && this.phase !== "connecting") {
      void this.send(
        this.options.protocol.encodeInstructionsUpdate(this.renderInstructions()),
      ).catch((error) => {
        this.failWithCause("context.update", error);
      });
    }
  }

  async open(): Promise<void> {
    if (this.disposed) return;
    const connectStartedAt = this.connectStartedAt = Date.now();
    this.options.tracer?.registerSecret(this.options.apiKey);
    this.publish({
      phase: "connecting",
      error: "",
      transcript: "",
      ...(this.purpose === "conversation" ? { userTranscript: "" } : {}),
      purpose: this.purpose,
      activeVoiceId: this.options.voiceId,
    });
    this.deadlineTimer = setTimeout(() => {
      this.failWithCause(this.connectionStage, Object.assign(
        new Error("Voice connection was not ready within 15000ms"),
        { code: "ETIMEDOUT" },
      ));
    }, CONNECT_DEADLINE_MS);

    try {
      if (this.purpose === "preview" && this.options.protocol.providerId === "moss") {
        this.connectionStage = "preview.input";
        this.previewPcm = await this.options.previewInput?.();
        if (this.disposed) return;
        if (!this.previewPcm?.length) throw new Error("MOSS preview requires its prerecorded 16 kHz input");
      }
      this.connectionStage = "connection.target";
      const target = this.options.protocol.connectTarget(this.options.apiKey);
      this.connectionStage = "websocket.connect";
      const rawSocket = await this.options.connect(target.url, { headers: target.headers });
      if (this.disposed) {
        void rawSocket.close().catch(() => {});
        return;
      }
      const socket = observeVoiceSocket(rawSocket, {
        tracer: this.options.tracer ?? NOOP_TRACER,
        protocol: this.options.protocol,
        sessionId: this.sessionId,
        fromWakeWord: this.options.fromWakeWord,
        connectStartedAt,
        onConversation: this.options.onConversation,
      });
      this.socket = socket;
      this.connectionStage = "handshake.create";
      const handshakeMessages = this.options.protocol.createHandshakeMessages(
        this.purpose === "preview" ? [] : this.tools.schemas,
        {
          voiceId: this.options.voiceId,
          instructions: this.renderInstructions(),
          purpose: this.purpose,
        },
      );
      for (const message of handshakeMessages) {
        this.connectionStage = "handshake.send";
        await this.send(message);
      }
      this.connectionStage = "session.ready";
      void this.readLoop(socket);
    } catch (error) {
      this.failWithCause(this.connectionStage, error);
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
      void this.send(frame).catch((error) => {
        this.failWithCause("microphone.mute", error);
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
    this.flushStoppedPlayback(this.responseId, this.turnId);
    const cancelEventId =
      trigger === "manual" &&
      this.responseInProgress &&
      this.options.protocol.providerId !== "doubao" &&
      this.options.protocol.providerId !== "moss"
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
    if (this.options.protocol.providerId === "moss") {
      this.responseInProgress = false;
      this.serverResponseDone = false;
      this.responseId = "";
      this.turnId = "";
    }
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
      void this.send(frame).catch((error) => {
        this.failWithCause("response.interrupt", error);
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

  private previewSample(): string {
    return this.options.previewText?.trim() || (this.conversationLanguage === "en-US"
      ? "Hi, I am LOOI. Let's start chatting." : "你好，我是 LOOI。我们可以开始聊天了。");
  }

  private renderInstructions(): string {
    if (this.purpose === "preview" && this.options.protocol.providerId === "moss") {
      return `这是音色试听。听到问候后，只朗读下面引号内的完整文本，不增加解释或其他内容：
${JSON.stringify(this.previewSample())}`;
    }
    const base = voiceInstructions(this.conversationLanguage, this.continuingLanguage);
    const history = this.options.history?.length
      ? `[Previous Voice Conversation]\n以下是重连前可见的语音对话，按发生顺序排列。回答历史追问时同时参考这些对话与任务回执，保留日期、时间和数字原文。\n${JSON.stringify(this.options.history)}`
      : "";
    return [base, history, this.contextNote].filter(Boolean).join("\n\n");
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
    const delivery = notice.traceContext ? this.options.tracer?.start("voice.delivery", "span", notice.traceContext, {
      "langfuse.observation.input": { noticeId: notice.id, spokenText: notice.spokenText, contextNote: notice.contextNote, frames },
    }) : undefined;
    if (delivery) this.socket?.setResponseTraceContext?.(delivery.context);
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
          delivery?.end({ "langfuse.observation.output": { status: "interrupted", speechTriggered } });
          if (delivery) this.socket?.setResponseTraceContext?.();
          return;
        }
        const frameType = (frame as { type?: unknown }).type;
        const frameAction = (frame as { action?: unknown }).action;
        if (
          frameType === "speech_text_buffer.commit" ||
          frameType === "conversation.item.create" ||
          frameAction === "session.commentary.append"
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
      delivery?.end({ "langfuse.observation.output": { status: "sent", providerId: this.options.protocol.providerId } });
    })()
      .catch((error) => {
        if (delivery) this.socket?.setResponseTraceContext?.();
        delivery?.end({ "langfuse.observation.level": "ERROR", "langfuse.observation.status_message": String(error) });
        this.failWithCause("notice.send", error);
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

  private flushStoppedPlayback(
    fallbackResponseId = this.responseId,
    fallbackTurnId = this.turnId,
  ): void {
    const queuedMs = this.options.audio.status().queuedPlaybackMs;
    const progress = this.audioPipeline.stopProgress(queuedMs);
    for (const chunk of progress.completedChunks) {
      const frame = this.options.protocol.encodePlaybackChunkCompleted?.(chunk);
      if (frame) {
        void this.send(frame).catch(() => {});
      }
    }
    const stoppedResponseId = progress.stopped?.responseId || fallbackResponseId;
    const stoppedTurnId = progress.stopped?.turnId || fallbackTurnId;
    const playedMs = progress.stopped?.playedMs ?? 0;
    if (stoppedResponseId || stoppedTurnId) {
      const frame = this.options.protocol.encodePlaybackStopped?.({
        responseId: stoppedResponseId,
        turnId: stoppedTurnId,
        playedMs,
      });
      if (frame) {
        void this.send(frame).catch(() => {});
      }
    }
    this.audioDoneTurn = undefined;
  }

  private publish(
    patch: Partial<
      Pick<
        VoiceState,
        | "phase"
        | "muted"
        | "transcript"
        | "userTranscript"
        | "purpose"
        | "activeVoiceId"
        | "error"
      >
    >,
  ): void {
    if (this.disposed) return;
    this.options.onStatePatch(patch);
  }

  private fail(message: string): void {
    if (this.disposed) return;
    this.options.onSessionError(message);
  }

  private failWithCause(stage: string, error: unknown): void {
    if (this.disposed) return;
    const details: string[] = [];
    let code: string | undefined;
    const seen = new Set<unknown>();
    for (let cause = error; cause !== undefined && !seen.has(cause);) {
      seen.add(cause);
      if (cause && typeof cause === "object") {
        const info = cause as Record<string, unknown>;
        const fields = ["code", "errno", "domain", "status", "statusCode", "responseId", "turnId"]
          .filter((key) => info[key] !== undefined)
          .map((key) => `${key}=${String(info[key])}`);
        if (!code && info.code !== undefined) code = String(info.code);
        const reason = typeof info.message === "string" ? info.message : JSON.stringify(cause);
        details.push([fields.join(" "), reason].filter(Boolean).join(": "));
        cause = info.cause;
      } else {
        details.push(String(cause));
        break;
      }
    }
    const redact = (value: string) => value.replaceAll(this.options.apiKey, "[redacted]");
    const failure = {
      stage,
      ...(code ? { code: redact(code) } : {}),
      message: redact(details.length ? details.join("; caused by: ") : String(error)),
    };
    if (this.socket) {
      this.socket.finalizeSession?.("error", failure);
    } else {
      const tracer = this.options.tracer ?? NOOP_TRACER;
      const root = tracer.start("voice.session", "span", {
        traceId: "", traceName: "voice.session", sessionId: this.sessionId,
      }, {}, this.connectStartedAt);
      const attributes = {
        "langfuse.observation.level": "ERROR",
        "langfuse.observation.status_message": failure.message,
        "langfuse.observation.metadata.failureStage": stage,
        "langfuse.observation.metadata.errorCode": failure.code,
        "langfuse.observation.metadata.providerId": this.options.protocol.providerId,
        "langfuse.observation.metadata.model": this.options.protocol.model,
      };
      tracer.start("realtime.handshake", "span", root.context, {}, this.connectStartedAt).end(attributes);
      root.end(attributes);
    }
    console.error("Voice session failed", { provider: this.options.protocol.providerId, ...failure });
    this.fail(`@looi:runtimeVoiceStageFailed|${JSON.stringify({
      provider: this.options.protocol.providerId,
      stage,
      detail: failure.message,
    })}`);
  }

  private async send(value: unknown): Promise<void> {
    if (this.disposed || !this.socket) {
      throw new Error("@looi:runtimeVoiceConnectionClosed");
    }
    if (this.writes >= MAX_PENDING_WRITES) {
      throw new Error("@looi:runtimeVoiceSendQueueIsFull");
    }
    const socket = this.socket;
    const raw: string | Uint8Array =
      value instanceof Uint8Array ? value : JSON.stringify(value);
    const frameLength =
      typeof raw === "string" ? raw.length : raw.byteLength;
    if (frameLength > MAX_FRAME_CHARS) {
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
    } catch (error) {
      this.failWithCause(this.phase === "connecting" ? "handshake.send" : "websocket.write", error);
      throw error;
    } finally {
      if (!this.disposed) this.writes--;
    }
  }

  private async readLoop(socket: VoiceSocket): Promise<void> {
    let stage = "websocket.read";
    try {
      while (!this.disposed) {
        stage = "websocket.read";
        const raw = await socket.read();
        if (this.disposed) return;
        if (raw === null) {
          this.failWithCause(stage, Object.assign(
            new Error(socket.closeReason || "WebSocket closed before the voice session ended"),
            { code: `WS_${socket.closeCode ?? 1006}` },
          ));
          return;
        }
        let event: Record<string, unknown> | Uint8Array;
        stage = "protocol.decode";
        if (raw instanceof Uint8Array) {
          if (raw.byteLength > MAX_INBOUND_CHARS) {
            throw new Error("Unsupported voice frame");
          }
          event = raw;
        } else if (typeof raw === "string") {
          if (raw.length > MAX_INBOUND_CHARS) {
            throw new Error("Unsupported voice frame");
          }
          const parsed = JSON.parse(raw);
          if (!parsed || typeof parsed !== "object") {
            throw new Error("Invalid voice frame");
          }
          event = parsed as Record<string, unknown>;
        } else {
          throw new Error("Unsupported voice frame");
        }
        const normalized = this.options.protocol.parseServerEvent(event);
        stage = "protocol.handle";
        if (this.previewPcm && normalized.kind.startsWith("user_")) continue;
        const responseId = "responseId" in normalized ? normalized.responseId : "";
        if ("turnId" in normalized && normalized.turnId) {
          this.turnId = normalized.turnId;
        }

        if (normalized.kind === "session_attached") {
          for (const frame of normalized.followUpMessages) {
            await this.send(frame);
          }
          continue;
        }

        if (normalized.kind === "response_cancelled") {
          if (this.purpose === "preview" && !this.discardOutput) {
            this.failWithCause("provider.response_cancelled", {
              message: normalized.reason || "Provider cancelled preview response",
              code: normalized.reason,
              responseId,
              turnId: normalized.turnId ?? this.turnId,
            });
            return;
          }
          this.responseInProgress = false;
          this.serverResponseDone = false;
          if (responseId) this.toolCallResponseIds.delete(responseId);
          if (normalized.text) {
            this.transcript = normalized.text.slice(-4096);
            this.transcriptTurnOpen = false;
            this.transcriptResponseId = responseId;
            this.publish({ transcript: this.transcript });
          }
          if (this.discardOutput || (responseId && this.cancelledResponses.has(responseId))) {
            if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
            this.deadlineTimer = undefined;
            this.discardOutput = false;
            this.responseId = "";
            this.turnId = "";
            if (responseId) this.cancelledResponses.delete(responseId);
            continue;
          }
          if (this.options.protocol.encodePlaybackStopped) {
            if (
              this.phase === "speaking" ||
              this.audioPipeline.bufferedOutputBytes > 0 ||
              this.options.audio.status().queuedPlaybackMs > 0
            ) {
              this.flushStoppedPlayback(
                responseId || this.responseId,
                normalized.turnId || this.turnId,
              );
              this.audioPipeline.clearOutput(this.options.audio);
              this.options.onAudioLevel?.(0);
              this.outputStreamDone = false;
              this.phase = "listening";
              this.publish({ phase: "listening" });
            }
            this.responseId = "";
            this.turnId = "";
            if (
              !this.tools.busy &&
              !this.dispatchingNotice &&
              this.turnActivity !== "user_speaking"
            ) {
              this.resumeWaiting();
            }
          } else if (this.phase === "speaking") {
            this.outputStreamDone = true;
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
        if (
          this.discardOutput &&
          !(event instanceof Uint8Array) &&
          String(event.type ?? event.event ?? "").startsWith("response.")
        ) {
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
          if (this.purpose === "preview") {
            if (this.options.audio.status().state !== "running") {
              this.options.audio.start(false);
            }
            const sample = this.previewSample();
            const previewFrames = this.options.protocol.encodePreviewSpeech
              ? this.options.protocol.encodePreviewSpeech(sample)
              : this.options.protocol.encodeProactiveSpeech({ spokenText: sample });
            this.phase = "speaking";
            this.muted = true;
            this.responseInProgress = true;
            this.serverResponseDone = false;
            this.outputStreamDone = false;
            this.transcript = sample;
            this.publish({
              phase: "speaking",
              muted: false,
              transcript: sample,
              purpose: "preview",
              activeVoiceId: this.options.voiceId,
            });
            for (const frame of previewFrames) {
              await this.send(frame);
            }
            this.tick();
            continue;
          }
          this.options.audio.setCaptureMode("conversation");
          this.options.audio.playReadyCue();
          this.turnActivity = "waiting_user";
          this.silenceSince = Date.now();
          this.phase = "listening";
          this.muted = false;
          if (this.options.protocol.providerId === "moss") {
            const micFrame = this.options.protocol.encodeMute(this.muted);
            if (micFrame) {
              await this.send(micFrame);
            }
          }
          this.publish({
            phase: "listening",
            muted: false,
            purpose: "conversation",
            activeVoiceId: this.options.voiceId,
          });
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
          const activeTurnId = normalized.turnId ?? this.turnId;
          const result = normalized.pcmBytes
            ? this.audioPipeline.appendOutputPcm(
                normalized.pcmBytes,
                normalized.itemId,
                normalized.contentIndex,
                {
                  responseId,
                  turnId: activeTurnId,
                  chunkId: normalized.chunkId,
                },
              )
            : this.audioPipeline.appendOutputBase64(
                normalized.pcmBase64,
                normalized.itemId,
                normalized.contentIndex,
                {
                  responseId,
                  turnId: activeTurnId,
                  chunkId: normalized.chunkId,
                },
              );
          if (result === "overflow") {
            this.interrupt();
            this.publish({
              error: "@looi:runtimePlaybackStoppedBecauseTheReplyWasTooLong",
            });
          }
        } else if (normalized.kind === "audio_done") {
          this.outputStreamDone = true;
          this.audioDoneTurn = {
            responseId: responseId || this.responseId,
            turnId: normalized.turnId || this.turnId,
          };
          if (this.phase !== "speaking" && this.audioPipeline.isDrained(this.options.audio)) {
            const doneTurn = this.audioDoneTurn;
            this.audioDoneTurn = undefined;
            if (doneTurn.responseId || doneTurn.turnId) {
              const frame = this.options.protocol.encodePlaybackCompleted?.(doneTurn);
              if (frame) {
                await this.send(frame);
              }
            }
          }
        } else if (normalized.kind === "audio_stop") {
          if (this.purpose === "preview") {
            this.failWithCause("provider.audio_stop", {
              message: normalized.reason || "Provider stopped preview audio",
              code: normalized.reason,
              responseId,
              turnId: normalized.turnId ?? this.turnId,
            });
            return;
          }
          this.flushStoppedPlayback(
            responseId || this.responseId,
            normalized.turnId || this.turnId,
          );
          this.audioPipeline.clearOutput(this.options.audio);
          this.options.onAudioLevel?.(0);
          this.outputStreamDone = false;
          this.responseInProgress = false;
          this.serverResponseDone = false;
          if (this.phase === "speaking") {
            this.phase = "listening";
            this.publish({ phase: "listening" });
          }
        } else if (normalized.kind === "text_delta") {
          if (
            !this.transcriptTurnOpen ||
            (responseId && this.transcriptResponseId && responseId !== this.transcriptResponseId)
          ) {
            this.transcript = "";
            this.transcriptTurnOpen = true;
            this.transcriptResponseId = responseId;
          }
          this.transcript = normalized.snapshot
            ? normalized.delta.slice(-4096)
            : (this.transcript + normalized.delta).slice(-4096);
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
          // MOSS is full duplex; only its explicit interruption events stop playback.
          if (
            this.options.protocol.providerId !== "moss" &&
            (this.phase === "speaking" ||
              this.audioPipeline.hasPendingOutputFrames ||
              this.responseId)
          ) {
            this.interrupt("server_vad");
          }
        } else if (normalized.kind === "user_transcription_update") {
          this.userTranscript = normalized.text.slice(-1024);
          this.publish({ userTranscript: this.userTranscript });
        } else if (normalized.kind === "user_speech_stopped") {
          this.options.onConversationActivity?.();
          if (normalized.transcript && normalized.transcript.trim()) {
            this.userTranscript = normalized.transcript.trim().slice(-1024);
            this.publish({ userTranscript: this.userTranscript });
          }
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
          if (this.previewPlaybackReported) {
            await this.writeQueue;
            if (!this.disposed) this.options.onSessionComplete();
            return;
          }
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
        } else if (normalized.kind === "tool_output_confirmed") {
          for (const frame of normalized.followUpMessages) {
            await this.send(frame);
          }
        } else if (normalized.kind === "error") {
          this.failWithCause("provider.error", normalized);
          return;
        }
      }
    } catch (error) {
      this.failWithCause(stage, error);
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
      const status = this.options.audio.status();
      if (status.state !== "running") {
        throw new Error(status.error || `Native audio state: ${status.state}`);
      }
      const { peakLevel, drained, completedChunks } = this.audioPipeline.step(
        this.options.audio,
        this.purpose === "preview" ? true : this.muted,
      );
      this.options.onAudioLevel?.(peakLevel);
      for (const chunk of completedChunks) {
        const frame = this.options.protocol.encodePlaybackChunkCompleted?.(chunk);
        if (frame) {
          void this.send(frame).catch((error) => this.failWithCause("playback.chunk.completed", error));
        }
      }

      if (((this.purpose !== "preview" && !this.muted) || this.previewPcm) && !this.audioWriting) {
        this.audioWriting = true;
        const captureFrame = this.previewPcm
          ? this.previewOffset < this.previewPcm.length
            ? this.previewPcm.subarray(this.previewOffset, this.previewOffset += 640)
            : new Uint8Array(640)
          : this.audioPipeline.shiftCaptureOrSilence();
        void this.send(this.options.protocol.encodeAudioAppend(captureFrame))
          .catch((error) => {
            this.failWithCause("audio.append", error);
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
        const doneTurn = this.audioDoneTurn ?? {
          responseId: this.responseId,
          turnId: this.turnId,
        };
        this.audioDoneTurn = undefined;
        if (doneTurn.responseId || doneTurn.turnId) {
          const frame = this.options.protocol.encodePlaybackCompleted?.(doneTurn);
          if (frame) {
            void this.send(frame).catch((error) => this.failWithCause("playback.completed", error));
          }
        }
        if (this.previewPcm && !this.serverResponseDone) {
          this.previewPlaybackReported = true;
          this.outputStreamDone = false;
          this.tickTimer = setTimeout(() => this.tick(), TICK_INTERVAL_MS);
          return;
        }
        this.outputStreamDone = false;
        this.serverResponseDone = false;
        this.responseInProgress = false;
        this.responseId = "";
        this.turnId = "";
        if (this.purpose === "preview") {
          void this.writeQueue.then(() => {
            if (!this.disposed) this.options.onSessionComplete();
          });
          return;
        }
        this.phase = "listening";
        this.publish({ phase: "listening" });
        this.silenceSince = Date.now();
        if (this.turnActivity !== "user_speaking" && !this.tools.busy) {
          this.resumeWaiting();
        }
      }

      this.tickTimer = setTimeout(() => this.tick(), TICK_INTERVAL_MS);
    } catch (error) {
      this.failWithCause("audio.pipeline", error);
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
