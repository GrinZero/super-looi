import type { RealtimeProtocolAdapter } from "../voice/realtime-protocol.js";
import type { LangfuseTracer, Observation, TraceContext } from "./langfuse.js";

interface Socket {
  read(): Promise<string | Uint8Array | null>;
  write(value: string): Promise<void>;
  close(): Promise<void>;
}
export interface ObservedVoiceSocket extends Socket {
  finalizeSession(reason?: string): void;
  getToolTraceContext(callId: string): TraceContext | undefined;
}
const bytes = (base64: string) => Math.max(0, Math.floor(base64.length * 3 / 4) - (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0));

/** The socket seam folds frame traffic into one observation per user turn/response. */
export function observeVoiceSocket(socket: Socket, options: {
  tracer: LangfuseTracer;
  protocol: RealtimeProtocolAdapter;
  sessionId: string;
  fromWakeWord: boolean;
  connectStartedAt?: number;
}): ObservedVoiceSocket {
  const { tracer, protocol } = options;
  const started = options.connectStartedAt ?? Date.now();
  const root = tracer.start("voice.session", "span", { traceId: "", traceName: "voice.session", sessionId: options.sessionId }, {}, started);
  const handshake = tracer.start("realtime.handshake", "span", root.context, { "langfuse.observation.input": { providerId: protocol.providerId, model: protocol.model } }, started);
  let ready = false, closed = false, turns = 0, tools = 0;
  type Turn = { observation: Observation; frames: number; bytes: number; transcript: string; itemId?: string };
  let turn: Turn | undefined;
  const pendingTurns: Turn[] = [];
  let response: Observation | undefined, responseStarted = 0, firstAudio = 0, responseFrames = 0, responseBytes = 0, responseText = "";
  const transcripts: string[] = [], assistantTranscripts: string[] = [];
  const toolSpans = new Map<string, Observation>();
  const finishTurn = (target: Turn, transcript?: string) => {
    const text = transcript || target.transcript;
    if (text) transcripts.push(text);
    target.observation.end({
      "langfuse.observation.output": text,
      "langfuse.observation.metadata.inputFrames": target.frames,
      "langfuse.observation.metadata.inputBytes": target.bytes,
      "langfuse.observation.metadata.audioDurationMs": target.frames * 20,
    });
    turns++;
  };
  const parkTurn = (itemId?: string) => {
    if (!turn) {
      if (itemId && pendingTurns.length) pendingTurns[pendingTurns.length - 1].itemId ??= itemId;
      return;
    }
    turn.itemId = itemId;
    pendingTurns.push(turn);
    turn = undefined;
    if (pendingTurns.length > 32) finishTurn(pendingTurns.shift()!);
  };
  const finishTranscript = (transcript: string, itemId?: string) => {
    const index = itemId ? pendingTurns.findIndex((item) => item.itemId === itemId) : -1;
    const target = index >= 0 ? pendingTurns.splice(index, 1)[0] : pendingTurns.shift() ?? turn;
    if (target === turn) turn = undefined;
    if (target) finishTurn(target, transcript);
    else if (transcript) transcripts.push(transcript);
  };
  const ensureResponse = () => {
    if (!response) {
      response = tracer.start("realtime.response", "generation", root.context, { "langfuse.observation.model.name": protocol.model });
      responseStarted = Date.now();
      firstAudio = responseFrames = responseBytes = 0;
      responseText = "";
    }
  };
  const finishResponse = (cancelled = false, statusCode?: string) => {
    if (!response) return;
    if (responseText) assistantTranscripts.push(responseText);
    response.end({
      "langfuse.observation.output": responseText,
      ...(firstAudio ? { "langfuse.observation.completion_start_time": firstAudio, "langfuse.observation.metadata.ttfaMs": firstAudio - responseStarted } : {}),
      "langfuse.observation.metadata.outputFrames": responseFrames,
      "langfuse.observation.metadata.outputBytes": responseBytes,
      "langfuse.observation.metadata.audioDurationMs": Math.round(responseBytes / 48),
      "langfuse.observation.metadata.cancelled": cancelled,
      ...(statusCode ? { "langfuse.observation.metadata.statusCode": statusCode } : {}),
    });
    response = undefined;
  };
  const finalizeSession = (reason = "close") => {
    if (closed) return;
    closed = true;
    if (!ready) handshake.end({ "langfuse.observation.metadata.handshakeMs": Date.now() - started });
    if (turn) finishTurn(turn);
    turn = undefined;
    for (const pending of pendingTurns) finishTurn(pending);
    pendingTurns.length = 0;
    finishResponse();
    for (const span of toolSpans.values()) span.end({ "langfuse.observation.output": { status: "interrupted" } });
    toolSpans.clear();
    root.end({
      "langfuse.observation.input": { trigger: options.fromWakeWord ? "wake_word" : "manual", providerId: protocol.providerId, model: protocol.model, userTranscripts: transcripts },
      "langfuse.observation.output": { assistantTranscripts, turnsCount: turns, toolCallsCount: tools, closeReason: reason },
      "langfuse.observation.metadata.providerId": protocol.providerId,
      "langfuse.observation.metadata.model": protocol.model,
      "langfuse.observation.metadata.fromWakeWord": options.fromWakeWord,
    });
  };
  return {
    finalizeSession,
    getToolTraceContext: (callId) => toolSpans.get(callId)?.context,
    async read() {
      const raw = await socket.read();
      if (typeof raw !== "string" || closed || !tracer.enabled) return raw;
      let event: Record<string, unknown>;
      try { event = JSON.parse(raw); } catch { return raw; }
      const normalized = protocol.parseServerEvent(event);
      switch (normalized.kind) {
        case "session_ready":
          if (!ready) { ready = true; handshake.end({ "langfuse.observation.metadata.handshakeMs": Date.now() - started }); }
          break;
        case "user_speech_started":
          if (!turn) turn = { observation: tracer.start("realtime.user_turn", "span", root.context), frames: 0, bytes: 0, transcript: "" };
          break;
        case "user_transcription_started":
          if (!turn && !pendingTurns.length) turn = { observation: tracer.start("realtime.user_turn", "span", root.context), frames: 0, bytes: 0, transcript: "" };
          break;
        case "user_transcription_update": {
          const target = (normalized.itemId && pendingTurns.find((item) => item.itemId === normalized.itemId)) || turn || pendingTurns[pendingTurns.length - 1];
          if (target) target.transcript = normalized.text;
          break;
        }
        case "user_speech_stopped":
          if (normalized.transcriptionFinal || normalized.transcript) finishTranscript(normalized.transcript || "", normalized.itemId);
          else parkTurn(normalized.itemId);
          break;
        case "response_started": parkTurn(); ensureResponse(); break;
        case "audio_delta":
          ensureResponse();
          if (!firstAudio) firstAudio = Date.now();
          responseFrames++;
          responseBytes += bytes(normalized.pcmBase64);
          break;
        case "text_delta": ensureResponse(); responseText += normalized.delta; break;
        case "text_done": ensureResponse(); responseText = normalized.text; break;
        case "tool_calls":
          for (const call of normalized.calls) {
            if (!call.callId || toolSpans.has(call.callId)) continue;
            toolSpans.set(call.callId, tracer.start("realtime.tool_call", "tool", root.context, { "langfuse.observation.input": { name: call.name, arguments: call.argumentsJson } }));
            tools++;
          }
          break;
        case "audio_done": if (normalized.userQueryExit) finishResponse(false, normalized.statusCode); break;
        case "response_cancelled": finishResponse(true); break;
        case "response_done": finishResponse(); break;
      }
      return raw;
    },
    async write(value) {
      if (!closed && tracer.enabled) {
        try {
          const event = JSON.parse(value);
          if (event.type === "input_audio_buffer.append" && typeof event.audio === "string") {
            if (turn) {
              turn.frames++;
              turn.bytes += bytes(event.audio);
            }
          }
          if (event.type === "conversation.item.create") {
            const callId = String(event.item?.call_id || event.items?.[0]?.call_id || "");
            const span = toolSpans.get(callId);
            if (span) { span.end({ "langfuse.observation.output": event.item?.output || event.items?.[0]?.content }); toolSpans.delete(callId); }
          }
        } catch { /* Socket owns malformed frame errors. */ }
      }
      await socket.write(value);
    },
    async close() { finalizeSession(); await socket.close(); },
  };
}
