import { describeVoiceFailure } from "./failure.js";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { RuntimeEventEmitter } from "@openai/agents-core/_shims";
import type {
  RealtimeItem,
  RealtimeTransportLayer,
  RealtimeTransportEventTypes,
} from "@openai/agents-realtime";
import { observeVoiceSocket } from "../../../../packages/looi-runtime/src/telemetry/realtime-observer.js";
import {
  NOOP_TRACER,
  type LangfuseTracer,
} from "../../../../packages/looi-runtime/src/telemetry/langfuse.js";
import type {
  NormalizedRealtimeEvent,
  RealtimeProtocolAdapter,
} from "./protocol.js";
import type { VoiceSocket } from "./types.js";

interface NativeTransportOptions {
  protocol: RealtimeProtocolAdapter;
  voiceId: string;
  purpose: "conversation" | "preview";
  sessionId: string;
  fromWakeWord: boolean;
  tracer?: LangfuseTracer;
  connect(
    url: string,
    options: { headers: Record<string, string> },
  ): Promise<VoiceSocket>;
  stage(stage: string): void;
  /** Native playback and App activity retain metadata absent from SDK audio events. */
  onEvent(
    event: NormalizedRealtimeEvent,
    raw: Record<string, unknown> | Uint8Array,
  ): Promise<boolean>;
  onInterrupt(): void;
  onMute(muted: boolean): void;
}

/** App-owned socket/media transport; SDK owns history and function execution. */
export class NativeRealtimeTransport
  extends RuntimeEventEmitter<RealtimeTransportEventTypes>
  implements RealtimeTransportLayer
{
  status: RealtimeTransportLayer["status"] = "disconnected";
  muted = false;
  socket?: VoiceSocket;
  private closed = false;
  private writes = 0;
  private writeQueue: Promise<void> = Promise.resolve();
  private assistantText = new Map<string, string>();
  private userItemId = "";
  private userSpeechOpen = false;
  private awaitingTranscripts: string[] = [];
  private responseId = "";
  private submittedCalls = new Set<string>();
  private waitingToolResponses = new Map<string, string>();
  private outstandingCalls = new Map<string, Set<string>>();
  private continuationCalls = new Map<string, Set<string>>();
  private activeResponse = "";
  private openToolBatches = new Set<string>();
  private createPending = false;
  private toolItems = new Map<
    string,
    Extract<RealtimeItem, { type: "function_call" }>
  >();
  private userAliases = new Map<string, string>();
  private secret = "";
  private writeFailure?: unknown;
  private closeMode: "graceful" | "immediate" = "immediate";

  constructor(private readonly options: NativeTransportOptions) {
    super();
  }
  get pendingWrites(): Promise<void> {
    return this.writeQueue;
  }
  getDefaultAudioFormat() {
    return "pcm16" as const;
  }

  async connect(
    options: Parameters<RealtimeTransportLayer["connect"]>[0],
  ): Promise<void> {
    if (this.closed) return;
    this.status = "connecting";
    this.emit("connection_change", "connecting");
    const started = Date.now();
    this.options.stage("connection.target");
    const apiKey =
      typeof options.apiKey === "function"
        ? await options.apiKey()
        : options.apiKey;
    this.secret = apiKey;
    const target = this.options.protocol.connectTarget(apiKey);
    this.options.stage("websocket.connect");
    const raw = await this.options.connect(target.url, {
      headers: target.headers,
    });
    if (this.closed) {
      await raw.close();
      return;
    }
    this.socket = observeVoiceSocket(raw, {
      tracer: this.options.tracer ?? NOOP_TRACER,
      protocol: this.options.protocol,
      sessionId: this.options.sessionId,
      fromWakeWord: this.options.fromWakeWord,
      connectStartedAt: started,
    });
    this.options.stage("handshake.create");
    const config = options.initialSessionConfig;
    const tools = (config?.tools ?? [])
      .filter((tool) => tool.type === "function")
      .map(({ type, name, description, parameters }) => ({
        type,
        name,
        description,
        parameters,
      }));
    const messages = this.options.protocol.createHandshakeMessages(tools, {
      voiceId: this.options.voiceId,
      instructions: config?.instructions ?? "",
      purpose: this.options.purpose,
    });
    for (const message of messages) {
      this.options.stage("handshake.send");
      await this.write(message);
    }
    this.options.stage("session.ready");
    void this.readLoop();
  }

  async write(value: unknown): Promise<void> {
    const socket = this.socket;
    if (this.closed || !socket)
      throw new Error("@looi:runtimeVoiceConnectionClosed");
    if (this.writes >= 8) throw new Error("@looi:runtimeVoiceSendQueueIsFull");
    const raw = value instanceof Uint8Array ? value : JSON.stringify(value);
    if ((typeof raw === "string" ? raw.length : raw.byteLength) > 65_536)
      throw new Error("@looi:runtimeVoiceMessageIsTooLong");
    this.writes++;
    const pending = this.writeQueue.then(async () => {
      if (this.closed && this.closeMode === "immediate")
        throw new Error("@looi:runtimeVoiceConnectionClosed");
      await socket.write(raw);
    });
    this.writeQueue = pending.catch((error) => {
      this.writeFailure ??= error;
    });
    try {
      await pending;
    } finally {
      this.writes--;
    }
  }

  private sendFrames(frames: unknown[], stage: string): Promise<boolean> {
    // Enqueue the entire operation before returning to SDK; graceful close must
    // wait for both a function output and its follow-up request.
    return Promise.all(frames.map((frame) => this.write(frame)))
      .then(() => true)
      .catch((error) => {
        this.report(stage, error);
        return false;
      });
  }
  private report(stage: string, error: unknown): void {
    if (!this.closed)
      this.emit("error", {
        type: "error",
        error: Object.assign(
          new Error(
            error && typeof error === "object" && "message" in error
              ? String(error.message)
              : String(error),
            {
              cause: error,
            },
          ),
          { stage },
        ),
      });
  }
  sendEvent(event: Parameters<RealtimeTransportLayer["sendEvent"]>[0]): void {
    this.sendFrames([event], "websocket.write");
  }
  requestResponse(): void {
    this.sendFrames([{ type: "response.create" }], "response.create");
  }
  sendMessage(
    message: Parameters<RealtimeTransportLayer["sendMessage"]>[0],
  ): void {
    if (typeof message !== "string")
      throw new Error("Voice proactive messages require text");
    this.sendFrames(
      this.options.protocol.encodeProactiveSpeech({ spokenText: message }),
      "notice.send",
    );
  }
  addImage(): void {
    throw new Error("Voice image input is not connected");
  }
  sendAudio(audio: ArrayBuffer): void {
    this.sendFrames(
      [this.options.protocol.encodeAudioAppend(new Uint8Array(audio))],
      "audio.append",
    );
  }
  updateSessionConfig(
    config: Parameters<RealtimeTransportLayer["updateSessionConfig"]>[0],
  ): void {
    if (config.instructions !== undefined)
      this.sendFrames(
        [this.options.protocol.encodeInstructionsUpdate(config.instructions)],
        "context.update",
      );
  }
  mute(muted: boolean): void {
    this.muted = muted;
    this.options.onMute(muted);
  }
  interrupt(): void {
    this.options.onInterrupt();
    this.emit("audio_interrupted");
  }
  sendFunctionCallOutput(
    call: Parameters<RealtimeTransportLayer["sendFunctionCallOutput"]>[0],
    output: string,
    startResponse: boolean,
  ): void {
    // SDK can replay a cached result. Do not make a provider resume the same call twice.
    if (this.submittedCalls.has(call.callId)) return;
    this.submittedCalls.add(call.callId);
    if (startResponse && this.options.protocol.providerId === "moss")
      this.waitingToolResponses.set(call.callId, call.responseId);
    const frames = this.options.protocol.encodeToolReply(call.callId, output);
    void this.sendFrames(
      frames.filter((frame) => frame.type !== "response.create"),
      "tool.output",
    ).then((sent) => {
      if (!sent || this.closed) return;
      if (this.options.protocol.providerId !== "moss" || !startResponse) {
        this.completeToolCall(call.responseId, call.callId, startResponse);
      }
      const item = this.toolItems.get(call.callId);
      if (item)
        this.emit("item_update", { ...item, status: "completed", output });
    });
  }
  resetHistory(_old: RealtimeItem[], _next: RealtimeItem[]): void {
    throw new Error(
      "Voice history is restored through the conversation instructions at connection start",
    );
  }
  sendMcpResponse(): void {
    throw new Error("Voice MCP approval is not connected");
  }
  close(): void {
    this.shutdown("immediate");
  }
  shutdown(mode: "graceful" | "immediate"): void {
    if (this.closed) return;
    const socket = this.socket;
    const pending = this.writeQueue;
    const hasPendingWrites = this.writes > 0;
    this.closeMode = mode;
    this.closed = true;
    this.status = "disconnected";
    this.emit("connection_change", "disconnected");
    this.socket = undefined;
    if (!socket) return;
    const finish = async () => {
      let stage = "websocket.write";
      try {
        if (mode === "graceful") {
          if (hasPendingWrites) await pending;
          if (this.writeFailure !== undefined) throw this.writeFailure;
          stage = "session.close";
          const frame = this.options.protocol.encodeSessionClose();
          if (frame) await socket.write(JSON.stringify(frame));
        }
        socket.finalizeSession?.(mode === "graceful" ? "end_session" : "stop");
      } catch (error) {
        socket.finalizeSession?.(
          "error",
          describeVoiceFailure(stage, error, this.secret),
        );
      } finally {
        try {
          await socket.close();
        } catch (error) {
          socket.finalizeSession?.(
            "error",
            describeVoiceFailure("websocket.close", error, this.secret),
          );
        }
      }
    };
    void finish();
  }

  private async readLoop(): Promise<void> {
    const socket = this.socket!;
    let stage = "websocket.read";
    try {
      while (!this.closed) {
        stage = "websocket.read";
        const raw = await socket.read();
        if (this.closed) return;
        if (raw === null)
          throw Object.assign(
            new Error(
              socket.closeReason ||
                "WebSocket closed before the voice session ended",
            ),
            { code: `WS_${socket.closeCode ?? 1006}` },
          );
        stage = "protocol.decode";
        if ((typeof raw === "string" ? raw.length : raw.byteLength) > 1_000_000)
          throw new Error("Unsupported voice frame");
        const event: Record<string, unknown> | Uint8Array =
          typeof raw === "string" ? JSON.parse(raw) : raw;
        const normalized = this.options.protocol.parseServerEvent(event);
        stage = "protocol.handle";
        if (
          normalized.kind === "session_attached" ||
          normalized.kind === "tool_output_confirmed"
        ) {
          if (normalized.kind === "session_attached") {
            for (const frame of normalized.followUpMessages)
              await this.write(frame);
          } else {
            const responseId = this.waitingToolResponses.get(normalized.callId);
            if (responseId) {
              this.waitingToolResponses.delete(normalized.callId);
              this.completeToolCall(responseId, normalized.callId, true);
            }
          }
          continue;
        }
        if (
          normalized.kind === "tool_calls" &&
          this.options.protocol.providerId === "moss" &&
          !(event instanceof Uint8Array)
        ) {
          const action = event.action ?? event.type;
          if (action === "response.function_call_arguments.done")
            this.openToolBatches.add(normalized.responseId);
          if (action === "response.done") {
            this.openToolBatches.delete(normalized.responseId);
            if (this.activeResponse === normalized.responseId) this.activeResponse = "";
          }
        }
        if (
          (normalized.kind === "response_done" ||
            normalized.kind === "response_cancelled") &&
          (!this.activeResponse ||
            this.activeResponse === normalized.responseId)
        ) {
          this.activeResponse = "";
          this.createPending = false;
        }
        if (normalized.kind === "response_cancelled") {
          this.finishAssistant(
            normalized.responseId || this.responseId,
            normalized.text,
            "incomplete",
          );
        }
        const accepted = await this.options.onEvent(normalized, event);
        if (this.closed) return;
        if (accepted) this.publishEvent(normalized);
        this.flushContinuation();
      }
    } catch (error) {
      this.report(stage, error);
    }
  }

  private publishEvent(event: NormalizedRealtimeEvent): void {
    if ("responseId" in event && event.responseId)
      this.responseId = event.responseId;
    if (event.kind === "error") {
      this.report("provider.error", event);
    } else if (event.kind === "session_ready") {
      this.status = "connected";
      this.emit("connection_change", "connected");
    } else if (event.kind === "response_started") {
      this.responseId = event.responseId;
      this.activeResponse = event.responseId;
      this.createPending = false;
      this.emit("turn_started", {
        type: "response_started",
        providerData: { response: { id: event.responseId } },
      });
    } else if (
      event.kind === "audio_started" &&
      this.options.protocol.providerId === "moss"
    ) {
      this.activeResponse = event.responseId;
      this.createPending = false;
    } else if (event.kind === "tool_calls") {
      const responseId = event.responseId || this.responseId;
      for (const call of event.calls) {
        const item = {
          itemId: call.callId,
          type: "function_call" as const,
          status: "in_progress" as const,
          name: call.name,
          arguments: call.argumentsJson,
          output: null,
        };
        if (!this.toolItems.has(call.callId)) {
          const groupId = responseId || `tool_${call.callId}`;
          const outstanding =
            this.outstandingCalls.get(groupId) ?? new Set<string>();
          outstanding.add(call.callId);
          this.outstandingCalls.set(groupId, outstanding);
          this.toolItems.set(call.callId, item);
          this.emit("item_update", item);
        }
        this.emit("function_call", {
          type: "function_call",
          responseId: responseId || `tool_${call.callId}`,
          callId: call.callId,
          name: call.name,
          arguments: call.argumentsJson,
        });
      }
    } else if (event.kind === "response_done") {
      this.finishAssistant(
        event.responseId || this.responseId,
        undefined,
        "completed",
      );
      const usage = event.usage;
      this.emit("turn_done", {
        type: "response_done",
        response: {
          id: event.responseId || this.responseId,
          output: [],
          rawUsage: usage,
          usage: {
            inputTokens: usage?.input_tokens ?? 0,
            outputTokens: usage?.output_tokens ?? 0,
            totalTokens: usage?.total_tokens ?? 0,
          },
        },
      });
    } else if (event.kind === "audio_delta") {
      const pcm = event.pcmBytes ?? Buffer.from(event.pcmBase64, "base64");
      this.emit("audio", {
        type: "audio",
        responseId: event.responseId,
        data: Uint8Array.from(pcm).buffer,
      });
    } else if (event.kind === "audio_done") {
      this.emit("audio_done");
    } else if (
      event.kind === "audio_stop" ||
      event.kind === "response_cancelled"
    ) {
      this.emit("audio_interrupted");
    } else if (
      event.kind === "user_speech_started" ||
      event.kind === "user_transcription_started"
    ) {
      if (!this.userSpeechOpen) {
        this.userItemId = `user_${randomUUID()}`;
        this.userSpeechOpen = true;
        this.emit("item_update", {
          itemId: this.userItemId,
          type: "message",
          role: "user",
          status: "in_progress",
          content: [{ type: "input_audio", transcript: null }],
        });
      }
    } else if (
      event.kind === "user_transcription_update" ||
      event.kind === "user_speech_stopped"
    ) {
      const knownId = event.itemId
        ? this.userAliases.get(event.itemId)
        : undefined;
      const final =
        event.kind === "user_speech_stopped" && Boolean(event.transcript);
      const itemId =
        knownId ||
        (final ? this.awaitingTranscripts[0] : undefined) ||
        this.userItemId ||
        `user_${randomUUID()}`;
      if (event.itemId) this.userAliases.set(event.itemId, itemId);
      if (event.kind === "user_speech_stopped" && !final) {
        this.userSpeechOpen = false;
        if (!this.awaitingTranscripts.includes(itemId))
          this.awaitingTranscripts.push(itemId);
        return;
      }
      const text =
        event.kind === "user_transcription_update"
          ? event.text
          : event.transcript!;
      if (final) {
        this.awaitingTranscripts = this.awaitingTranscripts.filter(
          (id) => id !== itemId,
        );
        if (itemId === this.userItemId) {
          this.userSpeechOpen = false;
        }
      }
      this.emit("item_update", {
        itemId,
        type: "message",
        role: "user",
        status: final ? "completed" : "in_progress",
        content: [{ type: "input_audio", transcript: text }],
      });
    } else if (event.kind === "text_delta" || event.kind === "text_done") {
      const id = event.responseId || this.responseId;
      const text =
        event.kind === "text_done"
          ? event.text
          : event.snapshot
            ? event.delta
            : (this.assistantText.get(id) ?? "") + event.delta;
      this.assistantText.set(id, text);
      this.emit("item_update", {
        itemId: `assistant_${id}`,
        type: "message",
        role: "assistant",
        status: event.kind === "text_done" ? "completed" : "in_progress",
        content: [{ type: "output_audio", transcript: text }],
      });
    }
  }
  private completeToolCall(
    responseId: string,
    callId: string,
    continueResponse: boolean,
  ): void {
    const outstanding = this.outstandingCalls.get(responseId);
    outstanding?.delete(callId);
    if (outstanding?.size === 0) this.outstandingCalls.delete(responseId);
    if (continueResponse && this.options.protocol.providerId !== "doubao") {
      const calls = this.continuationCalls.get(responseId) ?? new Set<string>();
      calls.add(callId);
      this.continuationCalls.set(responseId, calls);
    }
    this.flushContinuation();
  }

  private flushContinuation(): void {
    if (this.closed || this.activeResponse || this.createPending) return;
    for (const [responseId, callIds] of this.continuationCalls) {
      if (
        this.openToolBatches.has(responseId) ||
        this.outstandingCalls.has(responseId)
      )
        continue;
      this.continuationCalls.delete(responseId);
      this.createPending = true;
      const frame =
        this.options.protocol.providerId === "moss"
          ? { action: "response.create", response: { call_ids: [...callIds] } }
          : { type: "response.create" };
      void this.sendFrames([frame], "tool.continue");
      break;
    }
  }

  private finishAssistant(
    responseId: string,
    text: string | undefined,
    status: "completed" | "incomplete",
  ): void {
    const transcript = text ?? this.assistantText.get(responseId);
    if (transcript === undefined) return;
    this.assistantText.set(responseId, transcript);
    this.emit("item_update", {
      itemId: `assistant_${responseId}`,
      type: "message",
      role: "assistant",
      status,
      content: [{ type: "output_audio", transcript }],
    });
  }
}
