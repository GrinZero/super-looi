import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  DoubaoVoiceProvider,
  ModularVoiceProvider,
  stripStageText,
  LoopbackSuppressionManager,
  type WebSocketLike,
  type AsrEngine,
  type LlmBrainEngine,
  type TtsEngine,
} from "../src/voice/provider.js";
import type { VoiceDownMessage } from "@super-looi/contracts";

class MockWebSocket extends EventEmitter implements WebSocketLike {
  public readyState = 1; // OPEN
  public sentFrames: string[] = [];

  send(data: string | Buffer): void {
    this.sentFrames.push(data.toString());
  }

  close(_code?: number, _reason?: string): void {
    this.readyState = 3; // CLOSED
    this.emit("close");
  }

  simulateServerMessage(msg: Record<string, unknown>): void {
    this.emit("message", JSON.stringify(msg));
  }
}

describe("Dual-Track Voice Engines (Phase 1)", () => {
  it("strips bracketed stage text cleanly from spoken utterances", () => {
    assert.equal(
      stripStageText("（开心）好的，已为你开启书房灯【微笑着点头】。"),
      "好的，已为你开启书房灯。"
    );
    assert.equal(stripStageText("[冷淡] 我不知道。"), "我不知道。");
    assert.equal(stripStageText("普通文本无括号"), "普通文本无括号");
  });

  it("Track A (DoubaoVoiceProvider): performs 20ms pacer, mute commit, tool calls, and barge-in", async () => {
    let mockWs: MockWebSocket | null = null;
    const downMessages: VoiceDownMessage[] = [];

    const provider = new DoubaoVoiceProvider({
      apiKey: "test-doubao-key",
      wsFactory: () => {
        mockWs = new MockWebSocket();
        setTimeout(() => mockWs?.emit("open"), 5);
        return mockWs;
      },
    });

    const session = await provider.createSession({
      sessionId: "sess_doubao_1",
      onDownMessage: (msg) => downMessages.push(msg),
      onError: (err) => assert.fail(err.message),
    });

    assert.ok(mockWs);
    // Verify session.create sent
    const sessionCreateFrame = JSON.parse(mockWs!.sentFrames[0]);
    assert.equal(sessionCreateFrame.type, "session.create");
    assert.equal(sessionCreateFrame.session.id, "sess_doubao_1");

    // Server sends session.created
    mockWs!.simulateServerMessage({
      type: "session.created",
      session: { id: "sess_doubao_1" },
    });
    assert.ok(downMessages.some((m) => m.type === "session_ready"));

    // Push 1280 bytes of PCM (2 full 640-byte 20ms frames)
    const pcm = Buffer.alloc(1280, 0x11);
    await session.sendUpMessage({
      type: "audio_chunk",
      pcm_base64: pcm.toString("base64"),
      sample_rate: 16000,
      sequence: 1,
    });

    // Unmute
    await session.sendUpMessage({ type: "unmute_commit" });
    const unmuteFrame = mockWs!.sentFrames.find((f) => f.includes("input_audio_unmute.commit"));
    assert.ok(unmuteFrame, "Should send input_audio_unmute.commit");

    // Server sends tool call
    mockWs!.simulateServerMessage({
      type: "response.function_call_arguments.done",
      call_id: "call_study_light",
      name: "home.set_state",
      arguments: JSON.stringify({ entity_id: "light.study_ceiling", service: "turn_on" }),
    });

    const toolCallMsg = downMessages.find((m) => m.type === "tool_call");
    assert.ok(toolCallMsg && toolCallMsg.type === "tool_call");
    assert.equal(toolCallMsg.name, "home.set_state");

    // User barge-in cancels active output
    await session.sendUpMessage({ type: "barge_in" });
    const cancelFrame = mockWs!.sentFrames.find((f) => f.includes("response.cancel"));
    assert.ok(cancelFrame, "Barge-in should send response.cancel to ByteDance Duplex");
    assert.ok(downMessages.some((m) => m.type === "interrupted"));

    await session.close();
  });

  it("Track B (ModularVoiceProvider): executes ASR -> LLM -> TTS stream and handles barge-in abort", async () => {
    const downMessages: VoiceDownMessage[] = [];

    const mockAsr: AsrEngine = {
      transcribe: async () => "请把书房灯打开",
    };

    const mockLlm: LlmBrainEngine = {
      generate: async function* () {
        yield {
          toolCall: {
            id: "call_mod_1",
            name: "home.set_state",
            args: { entity_id: "light.study_ceiling", service: "turn_on" },
          },
        };
        yield { text: "书房灯已打开" };
      },
    };

    const mockTts: TtsEngine = {
      synthesizeStream: async function* () {
        yield Buffer.alloc(1200, 0x22);
      },
    };

    const provider = new ModularVoiceProvider({
      asr: mockAsr,
      llm: mockLlm,
      tts: mockTts,
    });

    const session = await provider.createSession({
      sessionId: "sess_mod_1",
      onDownMessage: (msg) => downMessages.push(msg),
      onError: (err) => assert.fail(err.message),
    });

    assert.ok(downMessages.some((m) => m.type === "session_ready" && m.provider === "modular"));

    // User speaks audio and commits mute (end of turn)
    await session.sendUpMessage({
      type: "audio_chunk",
      pcm_base64: Buffer.alloc(3200).toString("base64"),
      sample_rate: 16000,
      sequence: 1,
    });
    await session.sendUpMessage({ type: "mute_commit" });

    // Verify user transcript, tool call, assistant transcript, and audio chunks received
    const userTranscript = downMessages.find((m) => m.type === "transcript" && m.role === "user");
    assert.equal(userTranscript?.type === "transcript" ? userTranscript.text : "", "请把书房灯打开");

    const toolCall = downMessages.find((m) => m.type === "tool_call");
    assert.ok(toolCall && toolCall.type === "tool_call");
    assert.equal(toolCall.name, "home.set_state");

    const audioChunk = downMessages.find((m) => m.type === "audio_chunk");
    assert.ok(audioChunk);

    // Test barge-in during generation
    await session.sendUpMessage({ type: "barge_in" });
    assert.ok(downMessages.some((m) => m.type === "interrupted"));

    await session.close();
  });

  it("manages loopback suppression to prevent microphone acoustic self-excitation", () => {
    const loopback = new LoopbackSuppressionManager();
    const t0 = 10_000;

    assert.equal(loopback.isSuppressed(t0), false);

    // Assistant plays 48,000 bytes of PCM24k audio (1000ms duration + 150ms settling = 1150ms)
    const window = loopback.recordOutboundAudio(48_000, 24_000);
    assert.equal(window.cause, "tts_playback");
    assert.deepEqual(window.suppress_sensors, ["microphone"]);

    assert.equal(loopback.isSuppressed(Date.now() + 500), true);

    // Explicit barge-in clears suppression instantly
    loopback.clear();
    assert.equal(loopback.isSuppressed(Date.now()), false);
  });

  it("re-syncs Doubao mute state on session.created even if unmute_commit arrived before session.created", async () => {
    let mockWs: MockWebSocket | null = null;
    const provider = new DoubaoVoiceProvider({
      apiKey: "test-doubao-key",
      wsFactory: () => {
        mockWs = new MockWebSocket();
        setTimeout(() => mockWs?.emit("open"), 5);
        return mockWs;
      },
    });

    const session = await provider.createSession({
      sessionId: "sess_early_unmute",
      onDownMessage: () => {},
      onError: (err) => assert.fail(err.message),
    });

    // Client sends unmute_commit BEFORE ByteDance emits session.created
    await session.sendUpMessage({ type: "unmute_commit" });
    mockWs!.sentFrames.length = 0;

    // Now ByteDance emits session.created -> DoubaoVoiceSession must re-sync input_audio_unmute.commit
    mockWs!.simulateServerMessage({
      type: "session.created",
      session: { id: "remote_sid_123" },
    });

    assert.ok(
      mockWs!.sentFrames.some((f) => f.includes("input_audio_unmute.commit")),
      "Should re-send input_audio_unmute.commit upon session.created"
    );
    await session.close();
  });
});
