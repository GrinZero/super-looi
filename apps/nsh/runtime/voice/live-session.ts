import { randomUUID } from "node:crypto";
import {
  replyTextLanguage,
  type ConversationLanguage,
} from "@super-looi/runtime/agent/language";
import {
  NOOP_TRACER,
  type LangfuseTracer,
  type TraceContext,
  type VoiceConversationMessage,
} from "@super-looi/runtime/telemetry";
import { VoiceAudioPipeline } from "./audio-pipeline.js";
import { voiceInstructions } from "./prompts.js";
import type {
  RealtimeProtocolAdapter,
  NormalizedRealtimeEvent,
} from "./protocol.js";
import { createVoiceTools } from "./tools/index.js";
import type { VoiceToolHost } from "./tools/types.js";
import {
  RealtimeAgent,
  RealtimeSession,
  type RealtimeItem,
} from "@openai/agents-realtime";
import { NativeRealtimeTransport } from "./sdk-transport.js";
import { describeVoiceFailure, nativeAudioFailure } from "./failure.js";
import type {
  AiTurnDraft,
  PluginVoiceTool,
  ToolCallBailResult,
  UserTurnBailResult,
} from "../plugins/contracts.js";
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
const MAX_NOTICE_QUEUE = 8;

export interface LiveVoiceSessionOptions {
  apiKey: string;
  voiceId: string;
  purpose?: "conversation" | "preview";
  previewText?: string;
  initialLanguage: ConversationLanguage;
  initialContextNote?: string;
  initialPluginContext?: string;
  pluginVoiceTools?: readonly PluginVoiceTool[];
  evaluateVoiceToolCall?: (call: {
    toolName: string;
    arguments: Record<string, unknown>;
  }) => Promise<(Exclude<ToolCallBailResult, undefined> & { readonly pluginId?: string }) | undefined>;
  evaluateVoiceUserTurn?: (
    text: string,
  ) => Promise<(Exclude<UserTurnBailResult, undefined> & { readonly pluginId?: string }) | undefined>;
  assembleVoiceTurn?: (text: string) => Promise<AiTurnDraft>;
  sessionId?: string;
  history?: VoiceConversationMessage[];
  onConversation?: (messages: VoiceConversationMessage[]) => void;
  fromWakeWord: boolean;
  readonly initialMuted?: boolean;
  protocol: RealtimeProtocolAdapter;
  audio: VoiceAudioPort;
  previewInput?: () => Promise<Uint8Array>;
  connect: (
    url: string,
    options: { headers: Record<string, string> },
  ) => Promise<VoiceSocket>;
  tracer?: LangfuseTracer;
  requestTask?: (
    prompt: string,
    traceContext?: TraceContext,
  ) => Promise<string>;
  taskBridge?: VoiceTaskBridge;
  home?: VoiceToolHost["home"];
  schedule?: VoiceToolHost["schedule"];
  isQuietHoursNow?: () => boolean;
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
  stopVoiceMotion?: () => Promise<unknown>;
  redactSecrets?: (text: string) => string;
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
  onSessionError: (errorMessage: string, failure?: ReturnType<typeof describeVoiceFailure>) => void;
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
  private readonly transport: NativeRealtimeTransport;
  private readonly agent: RealtimeAgent;
  private readonly session: RealtimeSession;
  private toolsRunning = 0;
  private readonly noticeQueue: VoiceProactiveNotice[] = [];
  private readonly seenNoticeIds = new Set<string>();
  private readonly toolCallResponseIds = new Set<string>();
  private conversationLanguage: ConversationLanguage;
  private continuingLanguage = false;
  private contextNote: string;
  private pluginContextNote: string;
  private turnWaterfallNote = "";
  private activeSpokenNotice?: VoiceProactiveNotice;
  private noticeResponseRequested = false;
  private readonly resolvedNoticeCallbacks = new WeakSet<VoiceProactiveNotice>();
  private phase: "connecting" | "listening" | "speaking" = "connecting";
  private muted = false;
  private transcript = "";
  private transcriptTurnOpen = false;
  private transcriptResponseId = "";
  private userTranscript = "";
  private readonly purpose: "conversation" | "preview";
  private turnActivity: "waiting_user" | "user_speaking" | "awaiting_reply" =
    "waiting_user";
  private silenceSince = 0;
  private idleHoldUntilMs = 0;
  private currentUtteranceTranscript = "";
  private utteranceSeq = 0;
  private evaluatedUtteranceSeq = -1;
  private lastEvaluatedItemId = "";
  private pendingAutoResponseCancel = false;
  private pendingInstructionSync = false;
  private pendingInstructionSyncStage = "context.update";

  private get socket(): VoiceSocket | undefined {
    return this.transport.socket;
  }
  private get writeQueue(): Promise<void> {
    return this.transport.pendingWrites;
  }
  private tickTimer?: ReturnType<typeof setTimeout>;
  private deadlineTimer?: ReturnType<typeof setTimeout>;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private awaitingTimer?: ReturnType<typeof setTimeout>;

  private audioWriting = false;
  private dispatchingNotice = false;

  private discardOutput = false;
  private lastSettledCancelEventId = "";
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
  private readonly previousHomeChoices: string;
  private connectStartedAt = 0;
  private connectionStage = "websocket.connect";

  constructor(private readonly options: LiveVoiceSessionOptions) {
    this.sessionId = options.sessionId ?? randomUUID();
    const homeChoices = options.home?.references.lastPresented();
    this.previousHomeChoices = homeChoices?.length
      ? `重连前最后一组家居候选数据，按当时的返回顺序排列。用户继续选择时可参考这些引用，后续工具返回的候选优先。\n${JSON.stringify(homeChoices)}`
      : "";
    this.purpose = options.purpose ?? "conversation";
    this.muted = Boolean(options.initialMuted);
    this.conversationLanguage = options.initialLanguage;
    this.contextNote = (options.initialContextNote ?? "").trim();
    this.pluginContextNote = (options.initialPluginContext ?? "").trim();
    this.transport = new NativeRealtimeTransport({
      protocol: options.protocol,
      voiceId: options.voiceId,
      purpose: this.purpose,
      sessionId: this.sessionId,
      fromWakeWord: options.fromWakeWord,
      tracer: options.tracer,
      connect: options.connect,
      stage: (stage) => {
        this.connectionStage = stage;
      },
      onEvent: (event, raw) => this.handleEvent(event, raw),
      onInterrupt: () => this.applyInterrupt(),
      onMute: (value) => this.applyMute(value),
    });
    this.agent = new RealtimeAgent({
      name: "LOOI",
      instructions: this.renderInstructions(),
      tools: this.buildSessionTools(options.pluginVoiceTools),
    });
    this.session = new RealtimeSession(this.agent, {
      transport: this.transport,
      tracingDisabled: true,
    });
    this.session.on("error", ({ error }) => {
      const stage =
        error && typeof error === "object" && "stage" in error
          ? String(error.stage)
          : "sdk.session";
      this.failWithCause(stage, error);
    });
    this.session.on("agent_tool_start", () => {
      this.toolsRunning++;
      this.pauseTurnTimers();
    });
    this.session.on("agent_tool_end", () => {
      if (this.disposed) return;
      this.toolsRunning--;
      if (this.turnActivity !== "user_speaking") {
        this.turnActivity = "awaiting_reply";
        this.silenceSince = Date.now();
        this.startAwaitingTimer();
      }
    });
    this.session.on("history_updated", (history) =>
      this.publishHistory(history),
    );
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  get sessionPurpose(): "conversation" | "preview" {
    return this.purpose;
  }

  get isMuted(): boolean {
    return this.muted;
  }

  private buildSessionTools(pluginTools?: readonly PluginVoiceTool[]) {
    if (this.purpose === "preview") return [];
    return createVoiceTools(
      {
        sessionId: this.sessionId,
        requestTask: this.options.requestTask,
        taskBridge: this.options.taskBridge,
        home: this.options.home,
        schedule: this.options.schedule,
        controlBody: this.options.controlBody,
        pluginTools,
        evaluateToolCall: this.options.evaluateVoiceToolCall,
        redactSecrets: this.options.redactSecrets,
        toolTraceContext: (callId) =>
          this.socket?.getToolTraceContext?.(callId),
      },
      this.options.apiKey,
    );
  }

  private resolveSpokenNotice(
    notice: VoiceProactiveNotice | undefined,
    result: { readonly completed: boolean; readonly interruptedReason?: string },
  ): void {
    if (!notice || !notice.onResult || this.resolvedNoticeCallbacks.has(notice)) return;
    this.resolvedNoticeCallbacks.add(notice);
    try {
      notice.onResult(result);
    } catch {
      // Isolate plugin callback exceptions.
    }
  }

  enqueueNotice(notice: VoiceProactiveNotice): void {
    if (this.disposed || !notice.spokenText.trim()) {
      this.resolveSpokenNotice(notice, {
        completed: false,
        interruptedReason: this.disposed ? "session_disposed" : "empty_speech",
      });
      return;
    }
    if (this.seenNoticeIds.has(notice.id)) {
      this.resolveSpokenNotice(notice, {
        completed: false,
        interruptedReason: "duplicate_notice_id",
      });
      return;
    }
    if (notice.respectQuietHours && this.options.isQuietHoursNow?.()) {
      if (notice.contextNote) {
        this.updateContextNote(notice.contextNote, true);
      }
      if (this.phase !== "speaking" && !this.responseInProgress) {
        this.audioPipeline.clearOutput(this.options.audio);
        this.options.onAudioLevel?.(0);
      }
      this.resolveSpokenNotice(notice, {
        completed: false,
        interruptedReason: "quiet_hours_suppressed",
      });
      return;
    }
    if (this.seenNoticeIds.size >= 128) {
      const oldest = this.seenNoticeIds.values().next().value;
      if (oldest !== undefined) this.seenNoticeIds.delete(oldest);
    }
    this.seenNoticeIds.add(notice.id);
    if (this.noticeQueue.length >= MAX_NOTICE_QUEUE) {
      const evicted = this.noticeQueue.shift();
      this.resolveSpokenNotice(evicted, {
        completed: false,
        interruptedReason: "queue_overflow",
      });
    }
    if (notice.delivery === "interrupt") {
      this.noticeQueue.unshift(notice);
      const wasAwaitingUnstartedResponse =
        this.turnActivity === "awaiting_reply" &&
        !this.responseInProgress &&
        !this.dispatchingNotice;
      if (
        this.phase === "speaking" ||
        this.responseInProgress ||
        this.dispatchingNotice ||
        wasAwaitingUnstartedResponse ||
        this.audioPipeline.bufferedOutputBytes > 0 ||
        this.options.audio.status().queuedPlaybackMs > 0
      ) {
        this.applyInterrupt("manual", { preservePluginServo: true });
      }
      if (wasAwaitingUnstartedResponse) {
        this.pendingAutoResponseCancel = true;
      }
      if (!this.discardOutput && this.turnActivity !== "user_speaking" && this.toolsRunning === 0) {
        this.turnActivity = "waiting_user";
        this.flushNoticeIfIdle();
      }
      return;
    }
    this.noticeQueue.push(notice);
    this.flushNoticeIfIdle();
  }

  cancelNotice(notice: VoiceProactiveNotice): void {
    const result = { completed: false, interruptedReason: "speech_cancelled" } as const;
    const queuedIndex = this.noticeQueue.indexOf(notice);
    if (queuedIndex >= 0) {
      this.noticeQueue.splice(queuedIndex, 1);
      this.resolveSpokenNotice(notice, result);
      return;
    }
    if (this.activeSpokenNotice !== notice) return;

    this.activeSpokenNotice = undefined;
    if (this.noticeResponseRequested) {
      const responsePending = !this.responseInProgress && !this.serverResponseDone;
      this.applyInterrupt("manual", { cancelNotice: true, responsePending });
    }
    this.resolveSpokenNotice(notice, result);
    if (!this.discardOutput && this.turnActivity !== "user_speaking" && this.toolsRunning === 0) {
      this.resumeWaiting();
    }
  }

  takePendingNotices(): VoiceProactiveNotice[] {
    return this.noticeQueue.splice(0);
  }

  private requestInstructionSync(stage: string): void {
    this.agent.instructions = this.renderInstructions();
    if (this.socket && this.phase !== "connecting") {
      this.pendingInstructionSync = false;
      void this.syncInstructions().catch((error) => {
        this.failWithCause(stage, error);
      });
    } else {
      this.pendingInstructionSync = true;
      this.pendingInstructionSyncStage = stage;
    }
  }

  updateContextNote(note: string, syncImmediately = false): void {
    if (this.disposed) return;
    const next = note.trim();
    if (next === this.contextNote) return;
    this.contextNote = next;
    if (syncImmediately) {
      this.requestInstructionSync("context.update");
    }
  }

  updatePluginContext(note: string, syncImmediately = false): void {
    if (this.disposed) return;
    const next = note.trim();
    if (next === this.pluginContextNote) return;
    this.pluginContextNote = next;
    if (syncImmediately) {
      this.requestInstructionSync("context.update");
    }
  }

  updatePluginVoiceTools(pluginTools: readonly PluginVoiceTool[], syncImmediately = true): void {
    if (this.disposed || this.purpose === "preview") return;
    this.agent.tools = this.buildSessionTools(pluginTools);
    if (syncImmediately) {
      this.requestInstructionSync("tools.update");
    }
  }

  async open(): Promise<void> {
    if (this.disposed) return;
    this.connectStartedAt = Date.now();
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
      this.failWithCause(
        this.connectionStage,
        Object.assign(
          new Error("Voice connection was not ready within 15000ms"),
          { code: "ETIMEDOUT" },
        ),
      );
    }, CONNECT_DEADLINE_MS);

    try {
      if (
        this.purpose === "preview" &&
        this.options.protocol.providerId === "moss"
      ) {
        this.connectionStage = "preview.input";
        this.previewPcm = await this.options.previewInput?.();
        if (this.disposed) return;
        if (!this.previewPcm?.length)
          throw new Error("MOSS preview requires its prerecorded 16 kHz input");
      }
      this.pendingInstructionSync = false;
      this.agent.instructions = this.renderInstructions();
      await this.session.connect({ apiKey: this.options.apiKey });
    } catch (error) {
      this.failWithCause(this.connectionStage, error);
    }
  }

  mute(value: boolean): void {
    this.session.mute(value);
  }

  holdIdleFor(durationMs: number): void {
    if (this.disposed || durationMs <= 0) return;
    this.idleHoldUntilMs = Math.max(this.idleHoldUntilMs, Date.now() + durationMs);
    if (this.idleTimer) {
      this.startIdleTimer();
    }
  }

  private applyMute(value: boolean): void {
    if (this.disposed) return;
    this.muted = value;
    if (!value) {
      this.idleHoldUntilMs = 0;
    }
    this.options.audio.setMuted(value);
    if (this.phase !== "listening" && this.phase !== "speaking") {
      return;
    }
    this.audioPipeline.clearCapture();
    this.publish({ muted: value });
    const frame = this.options.protocol.encodeMute(value);
    if (frame) {
      void this.send(frame).catch((error) => {
        this.failWithCause("microphone.mute", error);
      });
    }
  }

  interrupt(trigger: "manual" | "server_vad" = "manual"): void {
    if (trigger === "server_vad") this.applyInterrupt(trigger);
    else this.session.interrupt();
  }

  private applyInterrupt(
    trigger: "manual" | "server_vad" = "manual",
    options?: { preservePluginServo?: boolean; cancelNotice?: boolean; responsePending?: boolean },
  ): void {
    if (
      this.disposed ||
      (this.phase !== "listening" && this.phase !== "speaking")
    )
      return;
    if (this.activeSpokenNotice) {
      const active = this.activeSpokenNotice;
      this.activeSpokenNotice = undefined;
      this.resolveSpokenNotice(active, {
        completed: false,
        interruptedReason: trigger,
      });
    }
    if (!options?.cancelNotice) {
      if ((trigger === "server_vad" || options?.preservePluginServo) && this.options.stopVoiceMotion) {
        void this.options.stopVoiceMotion().catch(() => {});
      } else {
        void this.options.controlBody?.("stop").catch(() => {});
      }
    }
    if (this.discardOutput) return;

    const queuedMs = this.options.audio.status().queuedPlaybackMs;
    const responseInProgress = this.responseInProgress || Boolean(options?.responsePending);
    if (
      this.phase !== "speaking" &&
      queuedMs <= 0 &&
      this.audioPipeline.bufferedOutputBytes === 0 &&
      !responseInProgress
    ) {
      this.transcript = "";
      this.transcriptTurnOpen = false;
      this.transcriptResponseId = "";
      this.publish({ transcript: "" });
      return;
    }

    // On Doubao, once `response.done` has already arrived (`serverResponseDone`),
    // the server has no active response left to cancel; clear local buffered audio only.
    if (
      this.options.protocol.providerId === "doubao" &&
      this.serverResponseDone
    ) {
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
      this.silenceSince = Date.now();
      if (!options?.cancelNotice && this.turnActivity !== "user_speaking") {
        this.resumeWaiting();
      }
      return;
    }

    const playback = this.audioPipeline.playedPosition(queuedMs);
    this.flushStoppedPlayback(this.responseId, this.turnId);
    const cancelEventId =
      trigger === "manual" &&
      responseInProgress &&
      this.options.protocol.providerId !== "doubao" &&
      this.options.protocol.providerId !== "moss"
        ? `cancel_${randomUUID()}`
        : undefined;
    const frames = this.options.protocol.encodeInterrupt({
      trigger,
      responseId: this.responseId,
      responseInProgress,
      cancelEventId,
      playback,
    });

    const waitForMossRun = options?.cancelNotice && this.options.protocol.providerId === "moss" &&
      !this.serverResponseDone && (!this.responseId || !this.turnId);
    this.discardOutput = this.options.protocol.providerId === "doubao" ||
      Boolean(cancelEventId) || Boolean(waitForMossRun);
    this.cancelEventId = cancelEventId ?? "";
    this.markResponseCancelled(this.responseId);

    this.audioPipeline.clearOutput(this.options.audio);
    this.options.onAudioLevel?.(0);
    this.outputStreamDone = false;
    if (this.options.protocol.providerId === "moss") {
      this.responseInProgress = false;
      this.serverResponseDone = false;
      if (!this.discardOutput) {
        this.responseId = "";
        this.turnId = "";
      }
    }
    this.phase = "listening";
    this.transcript = "";
    this.transcriptTurnOpen = false;
    this.transcriptResponseId = "";
    this.publish({ phase: "listening", transcript: "" });

    if (this.discardOutput) {
      if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
      this.deadlineTimer = setTimeout(() => {
        this.failWithCause("response.interrupt", {
          code: "ETIMEDOUT",
          message: waitForMossRun
            ? "No MOSS run and turn identifiers arrived before the interruption deadline"
            : "The voice provider did not acknowledge the interruption before the deadline",
        });
      }, CANCEL_ACK_DEADLINE_MS);
    }

    for (const frame of frames) {
      void this.send(frame).catch((error) => {
        this.failWithCause("response.interrupt", error);
      });
    }
  }

  private markResponseCancelled(responseId: string): void {
    if (!responseId) return;
    this.cancelledResponses.add(responseId);
    this.toolCallResponseIds.delete(responseId);
    const oldest = this.cancelledResponses.values().next().value;
    if (this.cancelledResponses.size > 128 && oldest !== undefined) {
      this.cancelledResponses.delete(oldest);
    }
  }

  private finishResponseCancellation(responseId: string): void {
    this.markResponseCancelled(responseId);
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    this.deadlineTimer = undefined;
    if (this.cancelEventId) this.lastSettledCancelEventId = this.cancelEventId;
    this.cancelEventId = "";
    this.discardOutput = false;
    this.responseInProgress = false;
    this.serverResponseDone = false;
    this.responseId = "";
    this.turnId = "";
    if (this.toolsRunning === 0 && this.turnActivity !== "user_speaking") {
      this.resumeWaiting();
    }
  }

  dispose(mode: "graceful" | "immediate"): void {
    if (this.disposed) return;
    this.disposed = true;

    if (this.activeSpokenNotice) {
      const active = this.activeSpokenNotice;
      this.activeSpokenNotice = undefined;
      this.resolveSpokenNotice(active, {
        completed: false,
        interruptedReason: "session_disposed",
      });
    }
    for (const queued of this.noticeQueue) {
      this.resolveSpokenNotice(queued, {
        completed: false,
        interruptedReason: "session_disposed",
      });
    }

    this.clearTimers();
    this.noticeQueue.length = 0;
    this.seenNoticeIds.clear();
    this.toolCallResponseIds.clear();
    this.toolsRunning = 0;
    this.transport.shutdown(mode);
    this.session.close();
    this.audioPipeline.clearCapture();
    this.audioPipeline.clearOutput(this.options.audio);
    this.options.onAudioLevel?.(0);
  }

  private previewSample(): string {
    return (
      this.options.previewText?.trim() ||
      (this.conversationLanguage === "en-US"
        ? "Hi, I am LOOI. Let's start chatting."
        : "你好，我是 LOOI。我们可以开始聊天了。")
    );
  }

  private renderInstructions(): string {
    if (
      this.purpose === "preview" &&
      this.options.protocol.providerId === "moss"
    ) {
      return `这是音色试听。听到问候后，只朗读下面引号内的完整文本，不增加解释或其他内容：
${JSON.stringify(this.previewSample())}`;
    }
    const base = voiceInstructions(
      this.conversationLanguage,
      this.continuingLanguage,
    );
    const history = this.options.history?.length
      ? `[Previous Voice Conversation]\n以下是重连前可见的语音对话，按发生顺序排列。回答历史追问时同时参考这些对话与任务回执，保留日期、时间和数字原文。\n${JSON.stringify(this.options.history)}`
      : "";
    return [
      base,
      history,
      this.previousHomeChoices,
      this.pluginContextNote,
      this.turnWaterfallNote,
      this.contextNote,
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  private async syncInstructions(): Promise<void> {
    this.agent.instructions = this.renderInstructions();
    await this.session.updateAgent(this.agent);
    await this.writeQueue;
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
      this.toolsRunning === 0 &&
      this.audioPipeline.isDrained(this.options.audio)
    );
  }

  private flushNoticeIfIdle(): boolean {
    while (this.canDispatchNotice() && this.noticeQueue.length > 0) {
      const notice = this.noticeQueue.shift()!;
      if (notice.contextNote) {
        this.contextNote = notice.contextNote.trim();
        this.agent.instructions = this.renderInstructions();
      }
      if (notice.respectQuietHours && this.options.isQuietHoursNow?.()) {
        if (notice.contextNote && this.socket && this.phase !== "connecting") {
          void this.syncInstructions().catch((error) => {
            this.failWithCause("context.update", error);
          });
        }
        this.audioPipeline.clearOutput(this.options.audio);
        this.options.onAudioLevel?.(0);
        this.resolveSpokenNotice(notice, {
          completed: false,
          interruptedReason: "quiet_hours_suppressed",
        });
        continue;
      }
      const frames = this.options.protocol.encodeProactiveSpeech({
        spokenText: notice.spokenText,
        instructions: notice.contextNote ? this.renderInstructions() : undefined,
        verbatim: notice.verbatim,
      });
      if (frames.length === 0) {
        this.resolveSpokenNotice(notice, {
          completed: false,
          interruptedReason: "empty_speech",
        });
        continue;
      }

      this.activeSpokenNotice = notice;
      this.noticeResponseRequested = false;
      this.serverResponseDone = false;
      this.responseId = "";
      this.turnId = "";
      this.dispatchingNotice = true;
      this.pendingAutoResponseCancel = false;
      this.pauseTurnTimers();
      this.turnActivity = "awaiting_reply";
      this.silenceSince = Date.now();
      this.startAwaitingTimer();

      let speechTriggered = false;
      const delivery = notice.traceContext
        ? this.options.tracer?.start(
            "voice.delivery",
            "span",
            notice.traceContext,
            {
              "langfuse.observation.input": {
                noticeId: notice.id,
                spokenText: notice.spokenText,
                contextNote: notice.contextNote,
                frames,
              },
            },
          )
        : undefined;
      if (delivery) this.socket?.setResponseTraceContext?.(delivery.context);
      void (async () => {
        for (const frame of frames) {
          if (
            this.disposed ||
            this.turnActivity !== "awaiting_reply" ||
            this.discardOutput ||
            this.resolvedNoticeCallbacks.has(notice)
          ) {
            if (this.activeSpokenNotice === notice) {
              this.activeSpokenNotice = undefined;
            }
            if (
              !this.disposed &&
              !speechTriggered &&
              !notice.onResult &&
              !this.resolvedNoticeCallbacks.has(notice)
            ) {
              this.noticeQueue.unshift(notice);
            } else {
              this.resolveSpokenNotice(notice, {
                completed: false,
                interruptedReason: this.disposed
                  ? "session_disposed"
                  : "interrupted_during_send",
              });
            }
            delivery?.end({
              "langfuse.observation.output": {
                status: "interrupted",
                speechTriggered,
              },
            });
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
          if (frame === frames.at(-1)) this.noticeResponseRequested = true;
          await this.send(frame);
        }
        delivery?.end({
          "langfuse.observation.output": {
            status: "sent",
            providerId: this.options.protocol.providerId,
          },
        });
      })()
        .catch((error) => {
          if (this.activeSpokenNotice === notice) {
            this.activeSpokenNotice = undefined;
          }
          this.resolveSpokenNotice(notice, {
            completed: false,
            interruptedReason: "send_failed",
          });
          if (delivery) this.socket?.setResponseTraceContext?.();
          delivery?.end({
            "langfuse.observation.level": "ERROR",
            "langfuse.observation.status_message": String(error),
          });
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
    return false;
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
    const stoppedResponseId =
      progress.stopped?.responseId || fallbackResponseId;
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

  private fail(message: string, failure?: ReturnType<typeof describeVoiceFailure>): void {
    if (this.disposed) return;
    this.options.onSessionError(message, failure);
  }

  private failWithCause(stage: string, error: unknown): void {
    if (this.disposed) return;
    const failure = describeVoiceFailure(stage, error, this.options.apiKey);
    if (this.socket) {
      this.socket.finalizeSession?.("error", failure);
    } else {
      const tracer = this.options.tracer ?? NOOP_TRACER;
      const root = tracer.start(
        "voice.session",
        "span",
        {
          traceId: "",
          traceName: "voice.session",
          sessionId: this.sessionId,
        },
        {},
        this.connectStartedAt,
      );
      const attributes = {
        "langfuse.observation.level": "ERROR",
        "langfuse.observation.status_message": failure.message,
        "langfuse.observation.metadata.failureStage": stage,
        "langfuse.observation.metadata.errorCode": failure.code,
        "langfuse.observation.metadata.providerId":
          this.options.protocol.providerId,
        "langfuse.observation.metadata.model": this.options.protocol.model,
      };
      tracer
        .start(
          "realtime.handshake",
          "span",
          root.context,
          {},
          this.connectStartedAt,
        )
        .end(attributes);
      root.end(attributes);
    }
    console.error("Voice session failed", {
      provider: this.options.protocol.providerId,
      ...failure,
    });
    this.fail(
      `@looi:runtimeVoiceStageFailed|${JSON.stringify({
        provider: this.options.protocol.providerId,
        stage,
        detail: failure.message,
      })}`,
      failure,
    );
  }

  private async send(value: unknown): Promise<void> {
    try {
      await this.transport.write(value);
    } catch (error) {
      this.failWithCause(
        this.phase === "connecting" ? "handshake.send" : "websocket.write",
        error,
      );
      throw error;
    }
  }

  private async handleEvent(
    normalized: NormalizedRealtimeEvent,
    event: Record<string, unknown> | Uint8Array,
  ): Promise<boolean> {
    if (
      this.disposed ||
      (this.previewPcm && normalized.kind.startsWith("user_"))
    )
      return false;
    const responseId = "responseId" in normalized ? normalized.responseId : "";
    if (
      responseId && this.cancelledResponses.has(responseId) &&
      (!this.discardOutput || responseId !== this.responseId)
    ) {
      return false;
    }
    if ("turnId" in normalized && normalized.turnId) {
      this.turnId = normalized.turnId;
    }

    if (this.discardOutput && this.options.protocol.providerId === "moss") {
      if (normalized.kind === "audio_stop") {
        this.finishResponseCancellation(responseId);
        return false;
      }
      if (normalized.kind === "audio_started" || normalized.kind === "audio_delta") {
        if (responseId && this.turnId) {
          this.flushStoppedPlayback(responseId, this.turnId);
          this.finishResponseCancellation(responseId);
        }
        return false;
      }
    }

    if (normalized.kind === "response_cancelled") {
      if (this.discardOutput) {
        this.finishResponseCancellation(responseId);
        return false;
      }
      if (this.activeSpokenNotice) {
        const cancelled = this.activeSpokenNotice;
        this.activeSpokenNotice = undefined;
        this.resolveSpokenNotice(cancelled, {
          completed: false,
          interruptedReason: "response_cancelled",
        });
      }
      if (this.purpose === "preview" && !this.discardOutput) {
        this.failWithCause("provider.response_cancelled", {
          message: normalized.reason || "Provider cancelled preview response",
          code: normalized.reason,
          responseId,
          turnId: normalized.turnId ?? this.turnId,
        });
        return false;
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
          this.toolsRunning === 0 &&
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
      if (this.discardOutput) {
        this.finishResponseCancellation(responseId);
        return false;
      }
    }
    if (
      normalized.kind === "error" &&
      normalized.clientEventId &&
      (normalized.code === "response_cancel_not_active" || normalized.message === "no active response")
    ) {
      if (normalized.clientEventId === this.cancelEventId) {
        this.finishResponseCancellation(this.responseId);
        return false;
      }
      if (normalized.clientEventId === this.lastSettledCancelEventId) return false;
    }
    if (
      this.discardOutput &&
      !(event instanceof Uint8Array) &&
      String(event.type ?? event.event ?? "").startsWith("response.")
    ) {
      return false;
    }
    if (responseId) {
      if (this.discardOutput) return false;
      this.responseId = responseId;
    }

    if (normalized.kind === "session_ready") {
      if (this.phase !== "connecting") return false;
      if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
      this.deadlineTimer = undefined;
      const audio = this.options.audio;
      try {
        const status = audio.status();
        if (status.errorCode) throw nativeAudioFailure(status);
        if (this.purpose === "preview") {
          if (status.state !== "running") audio.start(false);
        } else {
          audio.setCaptureMode("conversation");
          audio.setMuted(this.muted);
          audio.playReadyCue();
        }
      } catch (error) {
        const status = audio.status();
        this.failWithCause("audio.start", status.errorCode ? nativeAudioFailure(status) : error);
        return true;
      }
      if (this.purpose === "preview") {
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
        return true;
      }
      this.turnActivity = "waiting_user";
      this.silenceSince = Date.now();
      this.phase = "listening";
      if (this.muted || this.options.protocol.providerId === "moss") {
        const micFrame = this.options.protocol.encodeMute(this.muted);
        if (micFrame) {
          await this.send(micFrame);
        }
      }
      this.publish({
        phase: "listening",
        muted: this.muted,
        purpose: "conversation",
        activeVoiceId: this.options.voiceId,
      });
      if (this.pendingInstructionSync) {
        const syncStage = this.pendingInstructionSyncStage;
        this.pendingInstructionSync = false;
        try {
          await this.syncInstructions();
        } catch (error) {
          this.failWithCause(syncStage, error);
          return true;
        }
        if (this.disposed) return true;
      }
      if (!this.flushNoticeIfIdle()) {
        this.startIdleTimer();
      }
      this.tick();
    } else if (normalized.kind === "response_started") {
      if (
        this.pendingAutoResponseCancel &&
        !this.dispatchingNotice &&
        !this.activeSpokenNotice
      ) {
        this.pendingAutoResponseCancel = false;
        this.responseInProgress = true;
        this.serverResponseDone = false;
        this.responseId = responseId;
        this.applyInterrupt("manual", { preservePluginServo: true });
        return false;
      }
      this.responseInProgress = true;
      this.serverResponseDone = false;
    } else if (normalized.kind === "audio_started") {
      if (
        this.pendingAutoResponseCancel &&
        !this.dispatchingNotice &&
        !this.activeSpokenNotice
      ) {
        this.pendingAutoResponseCancel = false;
        this.responseInProgress = true;
        this.serverResponseDone = false;
        this.responseId = responseId;
        this.applyInterrupt("manual", { preservePluginServo: true });
        return false;
      }
      this.responseInProgress = true;
      this.serverResponseDone = false;
      this.audioPipeline.trackAudioItem(
        normalized.itemId,
        normalized.contentIndex,
      );
      this.enterSpeaking(responseId);
    } else if (normalized.kind === "audio_delta" && !this.discardOutput) {
      if (
        this.pendingAutoResponseCancel &&
        !this.dispatchingNotice &&
        !this.activeSpokenNotice
      ) {
        this.pendingAutoResponseCancel = false;
        this.responseInProgress = true;
        this.serverResponseDone = false;
        this.responseId = responseId;
        this.applyInterrupt("manual", { preservePluginServo: true });
        return false;
      }
      this.responseInProgress = true;
      this.serverResponseDone = false;
      if (
        this.audioStartedResponseId !== responseId ||
        this.phase !== "speaking"
      ) {
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
      if (
        this.phase !== "speaking" &&
        this.audioPipeline.isDrained(this.options.audio)
      ) {
        const doneTurn = this.audioDoneTurn;
        this.audioDoneTurn = undefined;
        if (doneTurn.responseId || doneTurn.turnId) {
          const frame =
            this.options.protocol.encodePlaybackCompleted?.(doneTurn);
          if (frame) {
            await this.send(frame);
          }
        }
      }
    } else if (normalized.kind === "audio_stop") {
      if (this.activeSpokenNotice) {
        const stoppedNotice = this.activeSpokenNotice;
        this.activeSpokenNotice = undefined;
        this.resolveSpokenNotice(stoppedNotice, {
          completed: false,
          interruptedReason: "audio_stop",
        });
      }
      if (this.purpose === "preview") {
        this.failWithCause("provider.audio_stop", {
          message: normalized.reason || "Provider stopped preview audio",
          code: normalized.reason,
          responseId,
          turnId: normalized.turnId ?? this.turnId,
        });
        return false;
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
        (responseId &&
          this.transcriptResponseId &&
          responseId !== this.transcriptResponseId)
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
      const language = replyTextLanguage(
        this.transcript,
        this.conversationLanguage,
      );
      if (language !== this.conversationLanguage) {
        this.conversationLanguage = language;
        this.continuingLanguage = true;
        await this.syncInstructions();
      }
    } else if (
      normalized.kind === "user_speech_started" ||
      normalized.kind === "user_transcription_started"
    ) {
      if (
        normalized.kind === "user_speech_started" ||
        this.turnActivity !== "user_speaking"
      ) {
        ++this.utteranceSeq;
        this.currentUtteranceTranscript = "";
        this.pendingAutoResponseCancel = false;
        if (this.turnWaterfallNote) {
          this.turnWaterfallNote = "";
          void this.syncInstructions().catch((error) => {
            this.failWithCause("context.update", error);
          });
        }
      }
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
      this.currentUtteranceTranscript = normalized.text.trim().slice(-1024);
      this.publish({ userTranscript: this.userTranscript });
    } else if (normalized.kind === "user_speech_stopped") {
      this.options.onConversationActivity?.();
      if (normalized.transcript && normalized.transcript.trim()) {
        this.currentUtteranceTranscript = normalized.transcript.trim().slice(-1024);
        this.userTranscript = this.currentUtteranceTranscript;
        this.publish({ userTranscript: this.userTranscript });
      }
      if (
        this.purpose === "conversation" &&
        normalized.transcriptionFinal === true
      ) {
        const isDuplicateItem = Boolean(
          normalized.itemId && normalized.itemId === this.lastEvaluatedItemId,
        );
        if (!isDuplicateItem) {
          if (normalized.itemId) {
            this.lastEvaluatedItemId = normalized.itemId;
          }
          if (this.evaluatedUtteranceSeq === this.utteranceSeq) {
            ++this.utteranceSeq;
          }
          const utterance = this.currentUtteranceTranscript;
          if (utterance && this.evaluatedUtteranceSeq !== this.utteranceSeq) {
            const seq = this.utteranceSeq;
            this.evaluatedUtteranceSeq = seq;
            if (this.options.evaluateVoiceUserTurn) {
              const guard = await this.options.evaluateVoiceUserTurn(utterance);
              if (this.disposed || seq !== this.utteranceSeq) return false;
              if (guard) {
                if (this.turnWaterfallNote) {
                  this.turnWaterfallNote = "";
                  void this.syncInstructions().catch((error) => {
                    this.failWithCause("context.update", error);
                  });
                }
                const hadActiveResponse =
                  this.responseInProgress ||
                  this.phase === "speaking" ||
                  this.audioPipeline.bufferedOutputBytes > 0 ||
                  this.options.audio.status().queuedPlaybackMs > 0;
                this.silenceSince = Date.now();
                this.turnActivity = "waiting_user";
                this.applyInterrupt("manual", { preservePluginServo: true });
                const spokenReply = guard.spokenReply?.trim();
                if (!hadActiveResponse && !spokenReply) {
                  this.pendingAutoResponseCancel = true;
                }
                if (spokenReply) {
                  this.enqueueNotice({
                    id: `guard_${randomUUID()}`,
                    spokenText: spokenReply,
                    delivery: "interrupt",
                  });
                } else if (!this.discardOutput && this.toolsRunning === 0) {
                  this.resumeWaiting();
                }
                return false;
              }
            }
            if (this.options.assembleVoiceTurn) {
              const draft = await this.options.assembleVoiceTurn(utterance);
              if (this.disposed || seq !== this.utteranceSeq) return false;
              const nextWaterfall = draft.contextBlocks
                .map((block) => block.text.trim())
                .filter(Boolean)
                .join("\n");
              if (nextWaterfall !== this.turnWaterfallNote) {
                this.turnWaterfallNote = nextWaterfall;
                await this.syncInstructions();
                if (this.disposed || seq !== this.utteranceSeq) return false;
              }
            }
          }
        }
      }
      if (this.turnActivity === "user_speaking") {
        this.silenceSince = Date.now();
        this.turnActivity = "awaiting_reply";
        this.pauseTurnTimers();
        this.startAwaitingTimer();
      }
    } else if (normalized.kind === "user_transcription_failed") {
      if (this.turnActivity === "user_speaking") {
        this.silenceSince = Date.now();
      }
      if (
        this.phase !== "speaking" &&
        this.toolsRunning === 0 &&
        !this.dispatchingNotice
      ) {
        this.resumeWaiting();
      }
    } else if (normalized.kind === "response_done") {
      if (this.previewPlaybackReported) {
        await this.writeQueue;
        if (!this.disposed) this.options.onSessionComplete();
        return false;
      }
      const wasToolCallTurn = Boolean(
        responseId && this.toolCallResponseIds.delete(responseId),
      );
      this.responseInProgress = false;
      this.serverResponseDone = true;
      if (this.phase === "speaking") {
        // Guarantees `tick()` drains back to `listening` even if `audio_done` was omitted.
        this.outputStreamDone = true;
      } else {
        if (this.activeSpokenNotice && !this.dispatchingNotice) {
          const completedNotice = this.activeSpokenNotice;
          this.activeSpokenNotice = undefined;
          this.resolveSpokenNotice(completedNotice, { completed: true });
        }
        if (
          this.toolsRunning === 0 &&
          !this.dispatchingNotice &&
          this.turnActivity !== "user_speaking" &&
          !wasToolCallTurn
        ) {
          this.resumeWaiting();
        }
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
    } else if (normalized.kind === "error") {
      return true; // SDK forwards the provider's original failure to the App.
    }
    return true;
  }

  private async sendAudio(frame: Uint8Array): Promise<void> {
    this.session.sendAudio(Uint8Array.from(frame).buffer);
    await this.writeQueue;
  }

  private publishHistory(history: RealtimeItem[]): void {
    if (this.disposed) return;
    const messages: VoiceConversationMessage[] = [];
    let skipPairedVerbatimAssistant = false;
    for (const item of history) {
      if (
        item.type !== "message" ||
        (item.role !== "user" && item.role !== "assistant")
      )
        continue;
      const content = item.content
        .map((part) =>
          "transcript" in part
            ? (part.transcript ?? "")
            : "text" in part
              ? part.text
              : "",
        )
        .join("");
      if (item.role === "user") {
        if (content.startsWith("[Verbatim Announcement]")) {
          skipPairedVerbatimAssistant = true;
          continue;
        }
        skipPairedVerbatimAssistant = false;
      } else if (skipPairedVerbatimAssistant) {
        skipPairedVerbatimAssistant = false;
        continue;
      }
      if (content) messages.push({ role: item.role, content });
    }
    this.options.onConversation?.(messages);
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
        throw nativeAudioFailure(status);
      }
      const { peakLevel, drained, completedChunks } = this.audioPipeline.step(
        this.options.audio,
        this.purpose === "preview" ? true : this.muted,
      );
      this.options.onAudioLevel?.(peakLevel);
      for (const chunk of completedChunks) {
        const frame =
          this.options.protocol.encodePlaybackChunkCompleted?.(chunk);
        if (frame) {
          void this.send(frame).catch((error) =>
            this.failWithCause("playback.chunk.completed", error),
          );
        }
      }

      if (
        ((this.purpose !== "preview" && !this.muted) || this.previewPcm) &&
        !this.audioWriting
      ) {
        this.audioWriting = true;
        const captureFrame = this.previewPcm
          ? this.previewOffset < this.previewPcm.length
            ? this.previewPcm.subarray(
                this.previewOffset,
                (this.previewOffset += 640),
              )
            : new Uint8Array(640)
          : this.audioPipeline.shiftCaptureOrSilence();
        void this.sendAudio(captureFrame)
          .catch((error) => {
            this.failWithCause("audio.append", error);
          })
          .finally(() => {
            if (!this.disposed) this.audioWriting = false;
          });
      }

      if (this.phase === "speaking" && this.outputStreamDone && drained) {
        const doneTurn = this.audioDoneTurn ?? {
          responseId: this.responseId,
          turnId: this.turnId,
        };
        this.audioDoneTurn = undefined;
        if (doneTurn.responseId || doneTurn.turnId) {
          const frame =
            this.options.protocol.encodePlaybackCompleted?.(doneTurn);
          if (frame) {
            void this.send(frame).catch((error) =>
              this.failWithCause("playback.completed", error),
            );
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
        if (this.activeSpokenNotice) {
          const completedNotice = this.activeSpokenNotice;
          this.activeSpokenNotice = undefined;
          this.resolveSpokenNotice(completedNotice, { completed: true });
        }
        if (this.purpose === "preview") {
          void this.writeQueue.then(() => {
            if (!this.disposed) this.options.onSessionComplete();
          });
          return;
        }
        this.phase = "listening";
        this.publish({ phase: "listening" });
        this.silenceSince = Date.now();
        if (this.turnActivity !== "user_speaking" && this.toolsRunning === 0) {
          this.resumeWaiting();
        }
      }

      this.tickTimer = setTimeout(() => this.tick(), TICK_INTERVAL_MS);
    } catch (error) {
      const status = this.options.audio.status();
      const detail = error instanceof Error ? error.message : String(error);
      const cause = status.errorCode && status.error && detail.includes(status.error)
        ? nativeAudioFailure(status)
        : error;
      this.failWithCause("audio.pipeline", cause);
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
        this.toolsRunning === 0 &&
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
        this.toolsRunning === 0 &&
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
    const sinceSilence = IDLE_SLEEP_MS - (Date.now() - this.silenceSince);
    const untilHold = this.idleHoldUntilMs - Date.now();
    return Math.max(0, sinceSilence, untilHold);
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
