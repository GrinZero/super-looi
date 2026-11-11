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
  setResponseTraceContext(context?: TraceContext): void;
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
  type Turn = { observation: Observation; order: number; frames: number; bytes: number; transcript: string; itemId?: string };
  let turn: Turn | undefined;
  const pendingTurns: Turn[] = [];
  let response: Observation | undefined, responseStarted = 0, responseOrder = 0, responseTurnOrder = 0, firstAudio = 0, responseFrames = 0, responseBytes = 0, responseText = "";
  let nextResponseContext: TraceContext | undefined;
  let sessionError: string | undefined;
  let cancelRequest: { eventId?: string; observation: Observation } | undefined;
  const transcripts: string[] = [], assistantTranscripts: string[] = [];
  const conversation: Array<{ role: "user" | "assistant"; content: string; order: number }> = [];
  let eventOrder = 0;
  let latestTurnOrder = 0;
  const completedTurns = new Set<number>();
  const pendingResponses: Array<{ turnOrder: number; end: () => void }> = [];
  const flushResponses = () => {
    for (let index = 0; index < pendingResponses.length;) {
      if (pendingResponses[index].turnOrder && !completedTurns.has(pendingResponses[index].turnOrder)) { index++; continue; }
      pendingResponses.splice(index, 1)[0].end();
    }
  };
  const toolSpans = new Map<string, Observation>();
  const finishTurn = (target: Turn, transcript?: string) => {
    const text = transcript || target.transcript;
    if (text) {
      transcripts.push(text);
      conversation.push({ role: "user", content: text, order: target.order });
    }
    target.observation.end({
      "langfuse.observation.output": text,
      "langfuse.observation.metadata.inputFrames": target.frames,
      "langfuse.observation.metadata.inputBytes": target.bytes,
      "langfuse.observation.metadata.audioDurationMs": target.frames * 20,
    });
    completedTurns.add(target.order);
    flushResponses();
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
    else if (transcript) {
      transcripts.push(transcript);
      const order = latestTurnOrder && !completedTurns.has(latestTurnOrder) ? latestTurnOrder : ++eventOrder;
      conversation.push({ role: "user", content: transcript, order });
      completedTurns.add(order);
      flushResponses();
    }
  };
  const ensureResponse = () => {
    if (!response) {
      response = tracer.start("realtime.response", "generation", nextResponseContext ?? root.context, {
        "langfuse.observation.model.name": protocol.model,
        "langfuse.observation.metadata.voiceSessionTraceId": root.context.traceId,
        "langfuse.observation.metadata.inputKind": "observed_transcripts",
      });
      nextResponseContext = undefined;
      responseStarted = Date.now();
      responseOrder = ++eventOrder;
      responseTurnOrder = latestTurnOrder;
      firstAudio = responseFrames = responseBytes = 0;
      responseText = "";
    }
  };
  const finishResponse = (cancelled = false, statusCode?: string, error?: string) => {
    if (!response) return;
    const observation = response, order = responseOrder, turnOrder = responseTurnOrder;
    const output = responseText;
    const finishedAt = Date.now(), completedAt = firstAudio, startedAt = responseStarted, frames = responseFrames, outputBytes = responseBytes;
    if (responseText) {
      assistantTranscripts.push(responseText);
      conversation.push({ role: "assistant", content: responseText, order: responseOrder });
    }
    pendingResponses.push({ turnOrder, end: () => {
      const input = conversation.filter((message) => message.order < order).sort((left, right) => left.order - right.order)
        .map(({ role, content }) => ({ role, content }));
      observation.end({
        "langfuse.observation.input": input,
        "langfuse.observation.output": output ? [{ role: "assistant", content: output }] : [],
        ...(completedAt ? { "langfuse.observation.completion_start_time": completedAt, "langfuse.observation.metadata.ttfaMs": completedAt - startedAt } : {}),
        "langfuse.observation.metadata.outputFrames": frames,
        "langfuse.observation.metadata.outputBytes": outputBytes,
        "langfuse.observation.metadata.audioDurationMs": Math.round(outputBytes / 48),
        "langfuse.observation.metadata.cancelled": cancelled,
        ...(error ? { "langfuse.observation.level": "ERROR", "langfuse.observation.status_message": error } : {}),
        ...(statusCode ? { "langfuse.observation.metadata.statusCode": statusCode } : {}),
      }, finishedAt);
    } });
    flushResponses();
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
    cancelRequest?.observation.end({ "langfuse.observation.output": { status: "interrupted" } });
    cancelRequest = undefined;
    for (const pending of pendingResponses) pending.end();
    pendingResponses.length = 0;
    for (const span of toolSpans.values()) span.end({ "langfuse.observation.output": { status: "interrupted" } });
    toolSpans.clear();
    conversation.sort((left, right) => left.order - right.order);
    const messages = conversation.map(({ role, content }) => ({ role, content }));
    const lastIsAssistant = messages.at(-1)?.role === "assistant";
    root.end({
      ...(sessionError ? { "langfuse.observation.level": "ERROR", "langfuse.observation.status_message": sessionError } : {}),
      "langfuse.observation.input": lastIsAssistant ? messages.slice(0, -1) : messages,
      "langfuse.observation.output": lastIsAssistant ? [messages[messages.length - 1]] : [],
      "langfuse.observation.metadata.userTranscripts": transcripts,
      "langfuse.observation.metadata.inputKind": "observed_transcripts",
      "langfuse.observation.metadata.assistantTranscripts": assistantTranscripts,
      "langfuse.observation.metadata.turnsCount": turns,
      "langfuse.observation.metadata.toolCallsCount": tools,
      "langfuse.observation.metadata.closeReason": reason,
      "langfuse.observation.metadata.providerId": protocol.providerId,
      "langfuse.observation.metadata.model": protocol.model,
      "langfuse.observation.metadata.fromWakeWord": options.fromWakeWord,
    });
  };
  return {
    finalizeSession,
    getToolTraceContext: (callId) => toolSpans.get(callId)?.context,
    setResponseTraceContext: (context) => { nextResponseContext = context; },
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
          if (!turn) {
            turn = { observation: tracer.start("realtime.user_turn", "span", root.context), order: ++eventOrder, frames: 0, bytes: 0, transcript: "" };
            latestTurnOrder = turn.order;
          }
          break;
        case "user_transcription_started":
          if (!turn && !pendingTurns.length) {
            turn = { observation: tracer.start("realtime.user_turn", "span", root.context), order: ++eventOrder, frames: 0, bytes: 0, transcript: "" };
            latestTurnOrder = turn.order;
          }
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
        case "user_transcription_failed": finishTranscript("", normalized.itemId); break;
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
            toolSpans.set(call.callId, tracer.start("realtime.tool_call", "tool", response?.context ?? root.context, { "langfuse.observation.input": { name: call.name, arguments: call.argumentsJson }, "langfuse.observation.metadata.callId": call.callId }));
            tools++;
          }
          break;
        case "response_cancelled":
          finishResponse(true);
          cancelRequest?.observation.end({ "langfuse.observation.output": event });
          cancelRequest = undefined;
          nextResponseContext = undefined;
          break;
        case "response_done": finishResponse(); break;
        case "error":
          // LiveVoiceSession treats a matching cancel error as its cancellation receipt.
          if (normalized.clientEventId && normalized.clientEventId === cancelRequest?.eventId) {
            cancelRequest.observation.end({ "langfuse.observation.output": event });
            cancelRequest = undefined;
            finishResponse(true);
            nextResponseContext = undefined;
            break;
          }
          sessionError = normalized.message;
          if (nextResponseContext) ensureResponse();
          if (response) finishResponse(false, normalized.code, normalized.message);
          else tracer.start("realtime.error", "span", root.context, { "langfuse.observation.input": event }).end({
            "langfuse.observation.level": "ERROR", "langfuse.observation.status_message": normalized.message,
          });
          if (!ready) handshake.end({ "langfuse.observation.level": "ERROR", "langfuse.observation.status_message": normalized.message });
          nextResponseContext = undefined;
          break;
      }
      return raw;
    },
    async write(value) {
      if (!closed && tracer.enabled) {
        try {
          const event = JSON.parse(value);
          if (event.type === "response.cancel") {
            cancelRequest?.observation.end({ "langfuse.observation.output": { status: "superseded" } });
            cancelRequest = { eventId: event.event_id, observation: tracer.start("realtime.cancel", "span", response?.context ?? root.context, { "langfuse.observation.input": event }) };
          }
          if (event.type === "session.update") {
            tracer.start("realtime.context", "span", root.context, { "langfuse.observation.input": event }).end();
          }
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
