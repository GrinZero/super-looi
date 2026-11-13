import assert from "node:assert/strict";
import { test } from "node:test";
import { Buffer } from "node:buffer";
import {
  createDoubaoDuplexV3Protocol,
  createMossLiveProtocol,
  createOpenAiRealtimeProtocol,
  resolveRealtimeProtocol,
} from "../src/voice/realtime-protocol.js";

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
  assert.deepEqual(protocol.parseServerEvent({ type: "conversation.item.input_audio_transcription.completed", item_id: "speech-1", text: "说一句话给我听听。" }),
    { kind: "user_speech_stopped", transcript: "说一句话给我听听。", itemId: "speech-1", transcriptionFinal: true });
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

test("MOSS-Live official handshake, negotiated PCM, playback receipts and tool continuation", () => {
  const protocol = resolveRealtimeProtocol({ providerId: "moss", instructions: "hello moss" });
  assert.equal(protocol.connectTarget("moss-key").url, "wss://api.mosi.cn/v1/realtime?model=moss-live-1.0");
  assert.equal(protocol.connectTarget("moss-key").headers.Authorization, "Bearer moss-key");
  assert.deepEqual(protocol.createHandshakeMessages([tool], {
    voiceId: "6cc93520-3207-4f7a-bca9-2d560b9c306b", instructions: "custom instructions",
  }), [{ action: "attach_session", session_id: null }]);
  const attached = protocol.parseServerEvent({ action: "session_attached", data: { session_id: "sess-1" } });
  assert.equal(attached.kind, "session_attached");
  if (attached.kind === "session_attached") {
    assert.equal(attached.sessionId, "sess-1");
    assert.deepEqual(attached.followUpMessages[0], { action: "media.configure", output_audio: { format: "pcm16", sample_rate: 24000 } });
    assert.deepEqual(attached.followUpMessages[1], { action: "change_voice", voice_name: "6cc93520-3207-4f7a-bca9-2d560b9c306b" });
    const update = attached.followUpMessages[2].session as Record<string, unknown>;
    assert.equal(update.instructions, "custom instructions");
    assert.deepEqual(update.tools, [tool]);
  }
  for (let i = 0; i < 2; i++) {
    assert.equal(protocol.parseServerEvent({ action: "session.updated", data: { error: "" } }).kind, "session_ready");
  }
  protocol.parseServerEvent({ action: "media.configured", data: { output_audio: { sample_rate: 48000 }, error: "" } });
  assert.equal(protocol.parseServerEvent({ action: "response.audio.context", data: {
    run_id: "run-1", turn_id: "turn-1", chunk_id: "chunk-1",
  } }).kind, "ignored");
  for (let i = 0; i < 2; i++) {
    const delta = protocol.parseServerEvent(new Uint8Array(1920));
    assert.equal(delta.kind, "audio_delta");
    if (delta.kind === "audio_delta") {
      assert.equal(delta.pcmBytes?.byteLength, 960);
      assert.equal(delta.responseId, "run-1");
      assert.equal(delta.turnId, "turn-1");
      assert.equal(delta.chunkId, "chunk-1");
    }
  }
  protocol.parseServerEvent({ action: "media.configured", data: { output_audio: { sample_rate: 24000 }, error: "" } });
  protocol.parseServerEvent({ action: "response.audio.context", data: {
    run_id: "run-1", turn_id: "turn-1", chunk_id: "chunk-2", duration_ms: 20,
  } });
  const delta = protocol.parseServerEvent(new Uint8Array(960));
  assert.equal(delta.kind, "audio_delta");
  if (delta.kind === "audio_delta") assert.equal(delta.pcmBytes?.byteLength, 960);
  assert.deepEqual(protocol.parseServerEvent({ action: "output.transcript.updated", data: {
    run_id: "run-1", turn_id: "turn-1", text: "你好，我是暖暖",
  } }), { kind: "text_delta", responseId: "run-1", turnId: "turn-1", delta: "你好，我是暖暖", snapshot: true });
  assert.deepEqual(protocol.encodePlaybackChunkCompleted?.({ responseId: "run-1", turnId: "turn-1", chunkId: "chunk-1" }), {
    action: "playback.chunk.completed", run_id: "run-1", turn_id: "turn-1", chunk_id: "chunk-1",
  });
  assert.deepEqual(protocol.encodePlaybackCompleted?.({ responseId: "run-1", turnId: "turn-1" }), {
    action: "playback.completed", run_id: "run-1", turn_id: "turn-1",
  });
  assert.deepEqual(protocol.encodePlaybackStopped?.({ responseId: "run-1", turnId: "turn-1", playedMs: 140 }), {
    action: "playback.stopped", run_id: "run-1", turn_id: "turn-1", played_audio_ms: 140,
  });
  assert.deepEqual(protocol.encodePreviewSpeech?.("试听文本"), [{ action: "mic_state", enabled: true }]);
  const toolDone = protocol.parseServerEvent({ action: "response.done", data: { response: {
    id: "run-1", output: [{ type: "function_call", call_id: "call-1", name: "run_agent_task", arguments: '{"prompt":"开灯"}' }],
  } } });
  assert.equal(toolDone.kind, "tool_calls");
  assert.deepEqual(protocol.encodeToolReply("call-1", { ok: true }), [{ action: "conversation.item.create", item: {
    type: "function_call_output", call_id: "call-1", output: '{"ok":true}',
  } }]);
  assert.deepEqual(protocol.parseServerEvent({ action: "conversation.item.created", data: { item: {
    id: "item-1", type: "function_call_output", call_id: "call-1",
  } } }), { kind: "tool_output_confirmed", callId: "call-1", itemId: "item-1",
    followUpMessages: [{ action: "response.create", response: { call_ids: ["call-1"] } }],
  });
  assert.deepEqual(protocol.encodeProactiveSpeech({ spokenText: "任务已完成", instructions: "updated instructions" }), [
    { action: "session.update", session: { instructions: "updated instructions" } },
    { action: "session.commentary.append", content: "任务已完成", status: "completed" },
  ]);
});
