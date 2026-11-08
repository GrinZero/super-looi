import { Buffer } from "node:buffer";

export type RealtimeProviderId = "doubao" | "openai" | (string & {});
export type VoiceToolSchema = { type: "function"; name: string; description: string; parameters: Record<string, unknown> };
export type RealtimeInterruptContext = {
  trigger: "manual" | "server_vad";
  responseId?: string;
  responseInProgress: boolean;
  cancelEventId?: string;
  playback?: { itemId: string; contentIndex: number; playedMs: number };
};
export type NormalizedRealtimeEvent =
  | { kind: "session_ready"; sessionId?: string }
  | { kind: "user_speech_started" }
  | { kind: "user_transcription_started" }
  | { kind: "user_transcription_update"; text: string; itemId?: string }
  | { kind: "user_speech_stopped"; transcript?: string; itemId?: string; transcriptionFinal?: boolean }
  | { kind: "user_transcription_failed"; message?: string; itemId?: string }
  | { kind: "response_started"; responseId: string }
  | { kind: "audio_started"; responseId: string; itemId?: string; contentIndex?: number }
  | { kind: "audio_delta"; responseId: string; pcmBase64: string; itemId?: string; contentIndex?: number }
  | { kind: "audio_done"; responseId: string; itemId?: string; contentIndex?: number; statusCode?: string }
  | { kind: "text_delta"; responseId: string; delta: string }
  | { kind: "text_done"; responseId: string; text: string }
  | { kind: "tool_calls"; responseId: string; calls: Array<{ callId: string; name: string; argumentsJson: string }> }
  | { kind: "response_cancelled"; responseId: string }
  | { kind: "response_done"; responseId: string; usage?: Record<string, number> }
  | { kind: "error"; message: string; code?: string; clientEventId?: string }
  | { kind: "ignored"; rawType: string };

export type RealtimeProactiveSpeech = {
  spokenText: string;
  instructions?: string;
};

export interface RealtimeProtocolAdapter {
  readonly providerId: RealtimeProviderId;
  readonly model: string;
  readonly inputSampleRate: 16000 | 24000;
  readonly outputSampleRate: 24000;
  connectTarget(apiKey: string): { url: string; headers: Record<string, string> };
  createHandshakeMessages(tools: VoiceToolSchema[], options?: { voiceId?: string; instructions?: string }): Record<string, unknown>[];
  encodeInstructionsUpdate(instructions: string): Record<string, unknown>;
  encodeProactiveSpeech(speech: RealtimeProactiveSpeech): Record<string, unknown>[];
  encodeAudioAppend(pcm16k: Uint8Array): Record<string, unknown>;
  encodeMute(muted: boolean): Record<string, unknown> | null;
  encodeToolReply(callId: string, output: unknown): Record<string, unknown>[];
  encodeInterrupt(context: RealtimeInterruptContext): Record<string, unknown>[];
  encodeSessionClose(): Record<string, unknown> | null;
  parseServerEvent(event: Record<string, unknown>): NormalizedRealtimeEvent;
}

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? value as Record<string, unknown> : {};
const string = (value: unknown): string => typeof value === "string" ? value : "";
const reply = (output: unknown): string => typeof output === "string" ? output : JSON.stringify(output);
const responseId = (event: Record<string, unknown>): string =>
  string(event.response_id) || string(object(event.response).id);
const audioIdentity = (event: Record<string, unknown>) => ({
  ...(string(event.item_id) ? { itemId: string(event.item_id) } : {}),
  ...(typeof event.content_index === "number" ? { contentIndex: event.content_index } : {}),
});

/** Every emitted frame is independent; no adapter state is shared between sessions. */
export function createDoubaoDuplexV3Protocol(options: { instructions?: string; model?: string; baseUrl?: string } = {}): RealtimeProtocolAdapter {
  const model = options.model || "1.2.6.1";
  return {
    providerId: "doubao", model, inputSampleRate: 16000, outputSampleRate: 24000,
    connectTarget: (apiKey) => ({
      url: options.baseUrl || "wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue",
      headers: { "X-Api-Key": apiKey },
    }),
    createHandshakeMessages: (tools, sessionOptions) => [{
      type: "session.create",
      session: {
        model, instructions: sessionOptions?.instructions ?? options.instructions ?? "", tools,
        audio: {
          input: { format: { type: "pcm", rate: 16000 } },
          output: { format: { type: "pcm_s16le", rate: 24000 }, voice: sessionOptions?.voiceId || "zh_female_vv_jupiter_bigtts" },
        },
      },
      extension: {
        tts: { extra: { max_length_to_filter_parenthesis: 100 } },
        asr: { extra: { end_smooth_window_ms: 2500, enable_custom_vad: true } },
      },
    }],
    encodeInstructionsUpdate: (instructions) => ({ type: "session.update", session: { instructions } }),
    encodeProactiveSpeech: ({ spokenText, instructions }) => {
      const frames: Record<string, unknown>[] = [];
      if (instructions !== undefined) {
        frames.push({ type: "session.update", session: { instructions } });
      }
      const clean = spokenText.trim();
      if (clean) {
        frames.push({ type: "speech_text_buffer.commit", text: clean });
      }
      return frames;
    },
    encodeAudioAppend: (pcm) => ({ type: "input_audio_buffer.append", audio: Buffer.from(pcm).toString("base64") }),
    encodeMute: (muted) => ({ type: muted ? "input_audio_mute.commit" : "input_audio_unmute.commit" }),
    encodeToolReply: (callId, output) => [{ type: "conversation.item.create", items: [{ call_id: callId, role: "tool", content: [{ type: "input_text", text: reply(output) }] }] }],
    encodeInterrupt: () => [{ type: "response.cancel" }],
    encodeSessionClose: () => ({ type: "session.close" }),
    parseServerEvent(event) {
      const type = string(event.type), id = responseId(event);
      switch (type) {
        case "session.created": return { kind: "session_ready", sessionId: string(object(event.session).id) || undefined };
        case "response.created": return { kind: "response_started", responseId: id };
        case "response.output_audio.started": return { kind: "audio_started", responseId: id };
        case "response.output_audio.delta": return { kind: "audio_delta", responseId: id, pcmBase64: string(event.delta) };
        case "response.output_audio.done": return { kind: "audio_done", responseId: id, statusCode: String(event.status_code ?? "") };
        case "response.output_text.delta": return { kind: "text_delta", responseId: id, delta: string(event.delta) };
        case "response.output_text.done": return { kind: "text_done", responseId: id, text: string(event.text) };
        case "input_audio_buffer.speech_started": return { kind: "user_speech_started" };
        case "conversation.item.input_audio_transcription.started": return { kind: "user_transcription_started" };
        case "conversation.item.input_audio_transcription.delta": return { kind: "user_transcription_update", text: string(event.delta), itemId: string(event.item_id) || undefined };
        case "input_audio_buffer.committed":
        case "input_audio_buffer.speech_stopped": return { kind: "user_speech_stopped", itemId: string(event.item_id) || undefined };
        case "conversation.item.input_audio_transcription.completed": return { kind: "user_speech_stopped", transcript: string(event.transcript) || undefined, itemId: string(event.item_id) || undefined, transcriptionFinal: true };
        case "conversation.item.input_audio_transcription.failed": return { kind: "user_transcription_failed", itemId: string(event.item_id) || undefined };
        case "response.function_call_arguments.done": {
          const items = Array.isArray(event.items) ? event.items.slice(0, 8) : [event];
          return { kind: "tool_calls", responseId: id, calls: items.map((item) => object(item)).map((item) => ({ callId: string(item.call_id), name: string(item.name), argumentsJson: string(item.arguments) })) };
        }
        case "response.canceled":
        case "response.cancelled": return { kind: "response_cancelled", responseId: id };
        case "response.done": return object(event.response).status === "cancelled" ? { kind: "response_cancelled", responseId: id } : { kind: "response_done", responseId: id };
        case "error":
        case "session.error": return { kind: "error", message: string(object(event.error).message) || "Provider error" };
        default: return { kind: "ignored", rawType: type };
      }
    },
  };
}

/** Linear interpolation preserves 20 ms frame duration (320 samples -> 480). */
export function resamplePcm16To24k(pcm: Uint8Array): Uint8Array {
  const count = Math.floor(pcm.byteLength / 2), targetCount = Math.floor(count * 3 / 2);
  const source = new DataView(pcm.buffer, pcm.byteOffset, count * 2);
  const result = new Uint8Array(targetCount * 2), output = new DataView(result.buffer);
  for (let i = 0; i < targetCount; i++) {
    const position = i * 2 / 3, left = Math.floor(position), right = Math.min(count - 1, left + 1);
    const sample = source.getInt16(left * 2, true) * (1 - (position - left)) + source.getInt16(right * 2, true) * (position - left);
    output.setInt16(i * 2, Math.round(sample), true);
  }
  return result;
}

export function createOpenAiRealtimeProtocol(options: { instructions?: string; model?: string; baseUrl?: string; providerId?: RealtimeProviderId } = {}): RealtimeProtocolAdapter {
  const model = options.model || "gpt-realtime";
  return {
    providerId: options.providerId || "openai", model, inputSampleRate: 24000, outputSampleRate: 24000,
    connectTarget: (apiKey) => ({
      url: `${options.baseUrl || "wss://api.openai.com/v1/realtime"}${(options.baseUrl || "").includes("?") ? "&" : "?"}model=${encodeURIComponent(model)}`,
      headers: { Authorization: `Bearer ${apiKey}` },
    }),
    createHandshakeMessages: (tools, sessionOptions) => [{
      type: "session.update", session: {
        type: "realtime", output_modalities: ["audio"], instructions: sessionOptions?.instructions ?? options.instructions ?? "",
        tools, audio: {
          input: { format: { type: "audio/pcm", rate: 24000 }, transcription: { model: "gpt-4o-mini-transcribe" }, turn_detection: { type: "server_vad" } },
          output: { format: { type: "audio/pcm", rate: 24000 }, voice: "marin" },
        },
      },
    }],
    encodeInstructionsUpdate: (instructions) => ({ type: "session.update", session: { type: "realtime", instructions } }),
    encodeProactiveSpeech: ({ spokenText, instructions }) => {
      const frames: Record<string, unknown>[] = [];
      if (instructions !== undefined) {
        frames.push({ type: "session.update", session: { type: "realtime", instructions } });
      }
      const clean = spokenText.trim();
      if (clean) {
        frames.push(
          {
            type: "conversation.item.create",
            item: {
              type: "message",
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: `[Background Task Update] Deliver this update naturally and concisely to the user in the current conversation language: ${clean}`,
                },
              ],
            },
          },
          { type: "response.create" },
        );
      }
      return frames;
    },
    encodeAudioAppend: (pcm) => ({ type: "input_audio_buffer.append", audio: Buffer.from(resamplePcm16To24k(pcm)).toString("base64") }),
    encodeMute: (muted) => muted ? { type: "input_audio_buffer.clear" } : null,
    encodeToolReply: (callId, output) => [
      { type: "conversation.item.create", item: { type: "function_call_output", call_id: callId, output: reply(output) } },
      { type: "response.create" },
    ],
    encodeInterrupt(context) {
      const frames: Record<string, unknown>[] = [];
      if (context.playback) frames.push({ type: "conversation.item.truncate", item_id: context.playback.itemId, content_index: context.playback.contentIndex, audio_end_ms: Math.max(0, Math.floor(context.playback.playedMs)) });
      if (context.trigger === "manual" && context.responseInProgress) frames.push({ type: "response.cancel", ...(context.cancelEventId ? { event_id: context.cancelEventId } : {}) });
      return frames;
    },
    encodeSessionClose: () => null,
    parseServerEvent(event) {
      const type = string(event.type), id = responseId(event), identity = audioIdentity(event);
      switch (type) {
        case "session.updated": return { kind: "session_ready", sessionId: string(object(event.session).id) || undefined };
        case "response.created": return { kind: "response_started", responseId: id };
        case "response.content_part.added": return object(event.part).type === "audio" ? { kind: "audio_started", responseId: id, ...identity } : { kind: "ignored", rawType: type };
        case "response.output_audio.delta":
        case "response.audio.delta": return { kind: "audio_delta", responseId: id, pcmBase64: string(event.delta), ...identity };
        case "response.output_audio.done":
        case "response.audio.done": return { kind: "audio_done", responseId: id, ...identity };
        case "response.output_audio_transcript.delta":
        case "response.audio_transcript.delta":
        case "response.output_text.delta": return { kind: "text_delta", responseId: id, delta: string(event.delta) };
        case "response.output_audio_transcript.done":
        case "response.audio_transcript.done":
        case "response.output_text.done": return { kind: "text_done", responseId: id, text: string(event.transcript) || string(event.text) };
        case "input_audio_buffer.speech_started": return { kind: "user_speech_started" };
        case "input_audio_buffer.speech_stopped":
        case "input_audio_buffer.committed": return { kind: "user_speech_stopped", itemId: string(event.item_id) || undefined };
        case "conversation.item.input_audio_transcription.completed": return { kind: "user_speech_stopped", transcript: string(event.transcript) || undefined, itemId: string(event.item_id) || undefined, transcriptionFinal: true };
        case "conversation.item.input_audio_transcription.failed": return { kind: "user_transcription_failed", message: string(object(event.error).message), itemId: string(event.item_id) || undefined };
        case "response.function_call_arguments.done": return { kind: "tool_calls", responseId: id, calls: [{ callId: string(event.call_id), name: string(event.name), argumentsJson: string(event.arguments) }] };
        case "response.done": {
          const response = object(event.response);
          if (response.status === "cancelled") return { kind: "response_cancelled", responseId: id };
          const usage = object(response.usage);
          return { kind: "response_done", responseId: id, usage: Object.fromEntries(Object.entries(usage).filter(([, value]) => typeof value === "number")) as Record<string, number> };
        }
        case "error": return { kind: "error", message: string(object(event.error).message) || "Provider error", code: string(object(event.error).code), clientEventId: string(object(event.error).event_id) };
        default: return { kind: "ignored", rawType: type };
      }
    },
  };
}

export function resolveRealtimeProtocol(config: { providerId?: RealtimeProviderId; instructions?: string; model?: string; baseUrl?: string } = {}): RealtimeProtocolAdapter {
  return config.providerId && config.providerId !== "doubao"
    ? createOpenAiRealtimeProtocol({ ...config, providerId: config.providerId })
    : createDoubaoDuplexV3Protocol(config);
}
