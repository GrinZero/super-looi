import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  LiveVoiceClient,
  buildWavFromPcm16Mono,
  computePcm16Rms,
  floatSamplesToPcm16Base64,
  hubMemoriesToClaims,
  type LiveVoiceAgentStatus,
  type LiveVoicePhase,
  type WebSocketAdapter,
} from "../src/runtime/live-voice-client.js";
import { MemoriesConformalSpaceController } from "../src/ui/memories-space.js";

class MockVoiceSocket implements WebSocketAdapter {
  public readyState = 1;
  public sent: Array<Record<string, unknown>> = [];
  public onopen: (() => void) | null = null;
  public onmessage: ((event: { data: unknown }) => void) | null = null;
  public onerror: ((event: unknown) => void) | null = null;
  public onclose: (() => void) | null = null;

  constructor() {
    queueMicrotask(() => {
      this.onopen?.();
    });
  }

  public send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  public close(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  public emitServerFrame(frame: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

describe("Mobile LiveVoiceClient & audio/memory helpers", () => {
  it("cancels an in-flight handshake and ignores frames from an old connection after restarting", async () => {
    const sockets: MockVoiceSocket[] = []; const transcripts: string[] = [];
    const client = new LiveVoiceClient({ hubOrigin: "http://test", enableNativeMic: false, enableNativePlayback: false,
      wsFactory: () => { const socket = new MockVoiceSocket(); sockets.push(socket); return socket; }, onAssistantTranscript: (text) => transcripts.push(text) });
    const starting = client.start(); await client.stop(); await assert.rejects(starting, /取消/);
    assert.equal(client.getPhase(), "disconnected");
    await client.start();
    sockets[0].emitServerFrame({ type: "transcript", role: "assistant", text: "stale", is_final: true });
    sockets[1].emitServerFrame({ type: "transcript", role: "assistant", text: "current", is_final: true });
    assert.deepEqual(transcripts, ["current"]); await client.stop();
  });

  it("stops suppressing microphone samples immediately after assistant playback is interrupted", async () => {
    const socket = new MockVoiceSocket();
    const client = new LiveVoiceClient({ hubOrigin: "http://test", enableNativeMic: false, wsFactory: () => socket });
    await client.start();
    socket.emitServerFrame({ type: "audio_chunk", pcm_base64: Buffer.alloc(48000).toString("base64"), sample_rate: 24000 });
    socket.emitServerFrame({ type: "state_change", state: "listening" });
    const before = socket.sent.length; client.pushFloat32MicSamples([0.2, -0.2]); assert.equal(socket.sent.length, before);
    socket.emitServerFrame({ type: "interrupted" });
    client.pushFloat32MicSamples([0.2, -0.2]); assert.equal(socket.sent.at(-1)?.type, "audio_chunk"); await client.stop();
  });

  it("encodes valid 44-byte RIFF/WAVE headers for 24kHz mono PCM16", () => {
    const pcm = new Uint8Array([0x00, 0x10, 0x00, 0x20]);
    const wav = buildWavFromPcm16Mono(pcm, 24_000);
    assert.equal(wav.byteLength, 48);
    const view = new DataView(wav.buffer);
    assert.equal(String.fromCharCode(wav[0]!, wav[1]!, wav[2]!, wav[3]!), "RIFF");
    assert.equal(String.fromCharCode(wav[8]!, wav[9]!, wav[10]!, wav[11]!), "WAVE");
    assert.equal(view.getUint32(24, true), 24_000);
    assert.equal(view.getUint32(28, true), 48_000);
    assert.equal(view.getUint32(40, true), 4);
  });

  it("computes normalized RMS from PCM16 and converts Float32 samples to base64", () => {
    const silence = new Uint8Array(320);
    assert.equal(computePcm16Rms(silence), 0);

    const { base64, rms } = floatSamplesToPcm16Base64([0.5, -0.5, 0.5, -0.5]);
    assert.ok(base64.length > 0);
    assert.ok(rms > 0.4);
  });

  it("handles full-duplex voice lifecycle, transcripts, agent status, and barge-in", async () => {
    let socket: MockVoiceSocket | null = null;
    const phases: LiveVoicePhase[] = [];
    const userTranscripts: Array<{ text: string; isFinal: boolean }> = [];
    const assistantTranscripts: Array<{ text: string; isFinal: boolean }> = [];
    const agentStatuses: LiveVoiceAgentStatus[] = [];
    const audioLevels: number[] = [];

    const client = new LiveVoiceClient({
      hubOrigin: "http://127.0.0.1:3000",
      enableNativeMic: false,
      enableNativePlayback: false,
      wsFactory: () => {
        socket = new MockVoiceSocket();
        return socket;
      },
      onPhaseChange: (phase) => phases.push(phase),
      onUserTranscript: (text, isFinal) => userTranscripts.push({ text, isFinal }),
      onAssistantTranscript: (text, isFinal) => assistantTranscripts.push({ text, isFinal }),
      onAgentStatus: (status) => agentStatuses.push(status),
      onAudioLevel: (level) => audioLevels.push(level),
    });

    await client.start();
    assert.equal(client.getPhase(), "listening");
    assert.ok(socket);
    const ws = socket as MockVoiceSocket;
    assert.equal(ws.sent[0]?.type, "unmute_commit");

    // Push Float32 mic samples -> sends 16kHz audio_chunk
    client.pushFloat32MicSamples([0.25, -0.25, 0.3, -0.3]);
    assert.equal(ws.sent[1]?.type, "audio_chunk");
    assert.equal(ws.sent[1]?.sample_rate, 16_000);

    // Server sends user transcript + agent status + assistant transcript + audio chunk
    ws.emitServerFrame({ type: "transcript", role: "user", text: "记住钥匙在抽屉里", is_final: true });
    ws.emitServerFrame({
      type: "agent_status",
      phase: "tool_end",
      tool: "remember_fact",
      summary: "已记住：钥匙在抽屉里",
      memories: [
        {
          id: "mem_1",
          fact: "钥匙在抽屉里",
          subject: "钥匙",
          location: "抽屉里",
          category: "item_location",
          source: "voice",
          updatedAt: new Date().toISOString(),
        },
      ],
    });
    ws.emitServerFrame({ type: "state_change", state: "speaking" });
    ws.emitServerFrame({ type: "transcript", role: "assistant", text: "好嘞，记下了！", is_final: true });
    const { base64 } = floatSamplesToPcm16Base64([0.4, -0.4, 0.4, -0.4]);
    ws.emitServerFrame({ type: "audio_chunk", pcm_base64: base64, sample_rate: 24_000 });

    assert.equal(userTranscripts.length, 1);
    assert.equal(userTranscripts[0]?.text, "记住钥匙在抽屉里");
    assert.equal(agentStatuses.length, 1);
    assert.equal(agentStatuses[0]?.memories?.[0]?.subject, "钥匙");
    assert.equal(assistantTranscripts[0]?.text, "好嘞，记下了！");
    assert.ok(audioLevels.some((level) => level > 0));

    // Convert Hub memories into MemoryClaims and format via MemoriesConformalSpaceController
    const memController = new MemoriesConformalSpaceController();
    const claims = hubMemoriesToClaims(agentStatuses[0]!.memories!);
    assert.equal(claims.length, 1);
    const card = memController.formatClaimCard(claims[0]!);
    assert.equal(card.whereText, "抽屉里");

    // Barge-in interrupts speaking and returns to listening
    client.bargeIn();
    assert.equal(client.getPhase(), "listening");
    assert.equal(ws.sent.at(-1)?.type, "barge_in");

    // Text prompt sends text_input frame
    client.sendTextPrompt("帮我看看当前目录");
    assert.equal(ws.sent.at(-1)?.type, "text_input");
    assert.equal(ws.sent.at(-1)?.text, "帮我看看当前目录");

    await client.stop();
    assert.equal(client.getPhase(), "disconnected");
    assert.ok(phases.includes("connecting"));
    assert.ok(phases.includes("listening"));
    assert.ok(phases.includes("speaking"));
    assert.ok(phases.includes("disconnected"));
  });
});
