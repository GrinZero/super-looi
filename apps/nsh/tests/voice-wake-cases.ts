import { VoiceRuntime, type VoiceAudioPort, type VoiceSocket } from "../runtime/voice.js";

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class SocketFixture implements VoiceSocket {
  writes: Array<Record<string, unknown>> = [];
  private values: Array<string | null> = [];
  private reader?: (value: string | null) => void;
  read(): Promise<string | null> {
    if (this.values.length) return Promise.resolve(this.values.shift()!);
    return new Promise((resolve) => { this.reader = resolve; });
  }
  async write(value: string) { this.writes.push(JSON.parse(value)); }
  async close() { this.push(null); }
  push(value: unknown) {
    const raw = value === null ? null : JSON.stringify(value);
    if (this.reader) { const reader = this.reader; this.reader = undefined; reader(raw); }
    else this.values.push(raw);
  }
}

export async function verifyWakeRuntime() {
  const originalTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((handler: Parameters<typeof setTimeout>[0], delay?: number, ...args: unknown[]) =>
    originalTimeout(handler, delay === 12000 ? 180 : delay, ...args)) as typeof setTimeout;
  try {
    let state = "idle", mode = "idle", permission = "granted", ready = true;
    let wakeWord = "", muted = false, playback = 0, starts = 0, stops = 0, cues = 0;
    const audio: VoiceAudioPort = {
      requestPermission: () => permission,
      start: () => { state = "running"; starts++; },
      setCaptureMode: (next) => {
        if (state !== "running") audio.start(true);
        mode = next; muted = false; wakeWord = "";
      },
      playReadyCue: () => { cues++; },
      stop: () => { state = "idle"; mode = "idle"; stops++; },
      enqueue: (pcm) => { playback += pcm.length; },
      clearPlayback: () => { playback = 0; },
      setMuted: (next) => { muted = next; },
      drainCapture: () => [],
      status: () => {
        const detected = wakeWord; wakeWord = "";
        return { state, permission, error: "", queuedPlaybackMs: playback ? 10 : 0, captureMode: mode, wakeWord: detected, kwsReady: ready };
      },
    };
    const saved = new Map([["voice", JSON.stringify({ apiKey: "test-key", wakeEnabled: true })]]);
    const sockets: SocketFixture[] = [];
    const voice = new VoiceRuntime({
      vault: { get: (key) => saved.get(key) ?? "", set: (key, value) => { saved.set(key, value); }, remove: (key) => { saved.delete(key); } },
      audio,
      connect: async () => { const socket = new SocketFixture(); sockets.push(socket); return socket; },
      onState: () => {}, requestTask: async () => "done", cancelTask: () => {},
    });
    await voice.enterStandby();
    check(voice.snapshot().phase === "standby" && starts === 1, "local wake did not start");
    wakeWord = "Hey_LOOI";
    await wait(85);
    const first = sockets[0];
    check(voice.snapshot().phase === "connecting" && first.writes[0]?.type === "session.create", "wake did not initiate Realtime");
    first.push({ type: "session.created" });
    await wait(35);
    check(voice.snapshot().phase === "listening" && starts === 1 && cues === 1, "ready cue restarted microphone or missed listening");
    first.push({ type: "conversation.item.input_audio_transcription.started" });
    await wait(25);
    check(!first.writes.some((item) => item.type === "response.cancel"), "user speech cancelled an idle response");
    await wait(210);
    check(voice.snapshot().phase === "listening", "long user speech was treated as idle");
    first.push({ type: "conversation.item.input_audio_transcription.completed" });
    await wait(35);
    check(voice.snapshot().phase === "listening", "speech completion ended session before reply");
    first.push({ type: "response.output_audio.started", response_id: "r1" });
    first.push({ type: "response.output_audio.delta", response_id: "r1", delta: "AAAAAA==" });
    first.push({ type: "response.output_audio.done", response_id: "r1" });
    await wait(40);
    check(voice.snapshot().phase === "speaking" && playback > 0, "server done skipped playback drain");
    playback = 0;
    await wait(40);
    check(voice.snapshot().phase === "listening", "drained playback did not reopen listening");
    voice.mute(true);
    await wait(210);
    check(voice.snapshot().phase === "standby" && !voice.snapshot().muted && !muted && starts === 1 && stops === 0,
      "auto sleep did not return to unmuted local wake on same stream");
    check(first.writes.some((item) => item.type === "session.close"), "auto sleep did not close session");

    wakeWord = "你好露伊";
    await wait(85);
    const second = sockets[1];
    second.push({ type: "session.created" });
    await wait(35);
    second.push({ type: "response.function_call_arguments.done", response_id: "old", call_id: "end-1", name: "end_conversation", arguments: "{}" });
    await wait(25);
    second.push({ type: "response.done", response_id: "old" });
    await wait(25);
    check(voice.snapshot().phase === "listening", "tool call response was mistaken for farewell");
    second.push({ type: "response.done", response_id: "farewell" });
    await wait(35);
    check(voice.snapshot().phase === "standby", "silent farewell did not end session");

    voice.stop();
    ready = false;
    await voice.enterStandby();
    check(voice.snapshot().phase === "error" && state === "idle" && stops > 0,
      "unavailable KWS was shown as listening");
    voice.close();
  } finally {
    globalThis.setTimeout = originalTimeout;
  }
}
