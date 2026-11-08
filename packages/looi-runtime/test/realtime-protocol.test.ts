import assert from "node:assert/strict";
import { test } from "node:test";
import { Buffer } from "node:buffer";
import { createDoubaoDuplexV3Protocol, createOpenAiRealtimeProtocol } from "../src/voice/realtime-protocol.js";

const tool = { type: "function" as const, name: "run_agent_task", description: "task", parameters: { type: "object" } };

test("Doubao preserves its native wire format without model-controlled conversation exit", () => {
  const protocol = createDoubaoDuplexV3Protocol({ instructions: "hello" });
  assert.equal(protocol.connectTarget("key").headers["X-Api-Key"], "key");
  const handshake = protocol.createHandshakeMessages([tool])[0] as any;
  assert.equal(handshake.type, "session.create");
  assert.equal(handshake.session.audio.input.format.rate, 16000);
  assert.equal(handshake.session.audio.output.voice, "zh_female_vv_jupiter_bigtts");
  assert.equal((protocol.createHandshakeMessages([tool], { voiceId: "S_LooiWarm" })[0] as any).session.audio.output.voice, "S_LooiWarm");
  assert.equal(handshake.extension.dialog, undefined);
  assert.equal((protocol.encodeToolReply("call", { ok: true })[0] as any).items[0].content[0].text, '{"ok":true}');
  assert.deepEqual(
    protocol.encodeProactiveSpeech({ spokenText: "书房台灯已打开。", instructions: "hello\n[回执] 台灯已开" }),
    [
      { type: "session.update", session: { instructions: "hello\n[回执] 台灯已开" } },
      { type: "speech_text_buffer.commit", text: "书房台灯已打开。" },
    ],
  );
  assert.deepEqual(protocol.encodeMute(true), { type: "input_audio_mute.commit" });
  assert.equal(protocol.parseServerEvent({ type: "response.output_audio.done", status_code: "20000002" }).kind, "audio_done");
  assert.equal((protocol.parseServerEvent({ type: "response.output_audio.done", status_code: "20000002" }) as any).userQueryExit, undefined);
  assert.deepEqual(protocol.parseServerEvent({ type: "conversation.item.input_audio_transcription.delta", delta: "开灯" }),
    { kind: "user_transcription_update", text: "开灯", itemId: undefined });
  assert.equal(protocol.parseServerEvent({ type: "conversation.item.input_audio_transcription.started" }).kind, "user_transcription_started");
  assert.deepEqual(protocol.parseServerEvent({ type: "conversation.item.input_audio_transcription.completed" }),
    { kind: "user_speech_stopped", transcript: undefined, itemId: undefined, transcriptionFinal: true });
});

test("OpenAI GA handshake, resampling, normalized events and interruption", () => {
  const protocol = createOpenAiRealtimeProtocol({ model: "gpt-realtime", instructions: "hello" });
  assert.equal(protocol.connectTarget("key").url, "wss://api.openai.com/v1/realtime?model=gpt-realtime");
  assert.equal(protocol.connectTarget("key").headers.Authorization, "Bearer key");
  const handshake = protocol.createHandshakeMessages([tool])[0] as any;
  assert.equal(handshake.type, "session.update");
  assert.equal(handshake.session.type, "realtime");
  assert.deepEqual(handshake.session.output_modalities, ["audio"]);
  assert.equal(handshake.session.audio.input.format.rate, 24000);
  assert.equal(handshake.session.audio.output.format.rate, 24000);
  assert.equal("model" in handshake.session, false);
  assert.equal(protocol.parseServerEvent({ type: "session.created" }).kind, "ignored");
  assert.equal(protocol.parseServerEvent({ type: "session.updated" }).kind, "session_ready");
  const pcm = new Uint8Array(640);
  assert.equal(Buffer.from((protocol.encodeAudioAppend(pcm) as any).audio, "base64").length, 960);
  assert.deepEqual(protocol.encodeToolReply("call", { ok: true }), [
    { type: "conversation.item.create", item: { type: "function_call_output", call_id: "call", output: '{"ok":true}' } },
    { type: "response.create" },
  ]);
  const proactive = protocol.encodeProactiveSpeech({ spokenText: "Task complete.", instructions: "updated" });
  assert.equal(proactive.length, 3);
  assert.deepEqual(proactive[0], { type: "session.update", session: { type: "realtime", instructions: "updated" } });
  assert.equal((proactive[1] as any).type, "conversation.item.create");
  assert.deepEqual(proactive[2], { type: "response.create" });
  assert.deepEqual(protocol.parseServerEvent({ type: "response.output_audio.delta", response_id: "r", item_id: "i", content_index: 0, delta: "AAAA" }),
    { kind: "audio_delta", responseId: "r", itemId: "i", contentIndex: 0, pcmBase64: "AAAA" });
  assert.deepEqual(protocol.parseServerEvent({ type: "response.output_audio_transcript.done", response_id: "r", transcript: "你好" }),
    { kind: "text_done", responseId: "r", text: "你好" });
  assert.equal(protocol.parseServerEvent({ type: "response.created", response: { id: "r" } }).kind, "response_started");
  assert.equal(protocol.parseServerEvent({ type: "response.done", response: { id: "r", status: "cancelled" } }).kind, "response_cancelled");
  assert.deepEqual(
    protocol.parseServerEvent({
      type: "response.done",
      response: { id: "r", status: "failed", status_details: { error: { code: "rate_limit", message: "quota exceeded" } } },
    }),
    { kind: "error", message: "quota exceeded", code: "rate_limit", clientEventId: "" },
  );
  assert.equal((protocol.parseServerEvent({ type: "error", error: { event_id: "cancel-1" } }) as any).clientEventId, "cancel-1");
  const playback = { itemId: "item", contentIndex: 0, playedMs: 120 };
  assert.deepEqual(protocol.encodeInterrupt({ trigger: "server_vad", responseInProgress: true, playback }),
    [{ type: "conversation.item.truncate", item_id: "item", content_index: 0, audio_end_ms: 120 }]);
  assert.deepEqual(protocol.encodeInterrupt({ trigger: "manual", responseInProgress: true, cancelEventId: "cancel-1", playback }),
    [{ type: "conversation.item.truncate", item_id: "item", content_index: 0, audio_end_ms: 120 }, { type: "response.cancel", event_id: "cancel-1" }]);
  assert.equal(protocol.encodeInterrupt({ trigger: "manual", responseInProgress: false, playback }).length, 1);
});
