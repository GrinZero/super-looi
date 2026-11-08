import assert from "node:assert/strict";
import { test } from "node:test";
import { Buffer } from "node:buffer";
import { createDoubaoDuplexV3Protocol, createOpenAiRealtimeProtocol } from "../src/voice/realtime-protocol.js";

const tool = { type: "function" as const, name: "end_conversation", description: "end", parameters: { type: "object" } };

test("Doubao preserves its native wire format and maps farewell status", () => {
  const protocol = createDoubaoDuplexV3Protocol({ instructions: "hello" });
  assert.equal(protocol.connectTarget("key").headers["X-Api-Key"], "key");
  const handshake = protocol.createHandshakeMessages([tool])[0] as any;
  assert.equal(handshake.type, "session.create");
  assert.equal(handshake.session.audio.input.format.rate, 16000);
  assert.equal(handshake.extension.dialog.extra.enable_user_query_exit, true);
  assert.equal((protocol.encodeToolReply("call", { ok: true })[0] as any).items[0].content[0].text, '{"ok":true}');
  assert.deepEqual(protocol.encodeMute(true), { type: "input_audio_mute.commit" });
  assert.equal(protocol.parseServerEvent({ type: "response.output_audio.done", status_code: "20000002" }).kind, "audio_done");
  assert.equal((protocol.parseServerEvent({ type: "response.output_audio.done", status_code: "20000002" }) as any).userQueryExit, true);
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
  assert.deepEqual(protocol.parseServerEvent({ type: "response.output_audio.delta", response_id: "r", item_id: "i", content_index: 0, delta: "AAAA" }),
    { kind: "audio_delta", responseId: "r", itemId: "i", contentIndex: 0, pcmBase64: "AAAA" });
  assert.deepEqual(protocol.parseServerEvent({ type: "response.output_audio_transcript.done", response_id: "r", transcript: "你好" }),
    { kind: "text_done", responseId: "r", text: "你好" });
  assert.equal(protocol.parseServerEvent({ type: "response.created", response: { id: "r" } }).kind, "response_started");
  assert.equal(protocol.parseServerEvent({ type: "response.done", response: { id: "r", status: "cancelled" } }).kind, "response_cancelled");
  assert.equal((protocol.parseServerEvent({ type: "error", error: { event_id: "cancel-1" } }) as any).clientEventId, "cancel-1");
  const playback = { itemId: "item", contentIndex: 0, playedMs: 120 };
  assert.deepEqual(protocol.encodeInterrupt({ trigger: "server_vad", responseInProgress: true, playback }),
    [{ type: "conversation.item.truncate", item_id: "item", content_index: 0, audio_end_ms: 120 }]);
  assert.deepEqual(protocol.encodeInterrupt({ trigger: "manual", responseInProgress: true, cancelEventId: "cancel-1", playback }),
    [{ type: "conversation.item.truncate", item_id: "item", content_index: 0, audio_end_ms: 120 }, { type: "response.cancel", event_id: "cancel-1" }]);
  assert.equal(protocol.encodeInterrupt({ trigger: "manual", responseInProgress: false, playback }).length, 1);
});
