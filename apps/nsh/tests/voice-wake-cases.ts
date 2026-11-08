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
  const originalNow = Date.now;
  const clockStart = originalNow();
  Date.now = () => clockStart + Math.floor((originalNow() - clockStart) * (12000 / 180));
  globalThis.setTimeout = ((handler: Parameters<typeof setTimeout>[0], delay?: number, ...args: unknown[]) =>
    originalTimeout(handler, delay && delay >= 6000 && delay <= 12000 ? Math.round(delay * 180 / 12000) : delay, ...args)) as typeof setTimeout;
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
    const saved = new Map([["voice", JSON.stringify({ apiKey: "test-key" })]]);
    const sockets: SocketFixture[] = [];
    const voice = new VoiceRuntime({
      vault: { get: (key) => saved.get(key) ?? "", set: (key, value) => { saved.set(key, value); }, remove: (key) => { saved.delete(key); } },
      audio,
      connect: async () => { const socket = new SocketFixture(); sockets.push(socket); return socket; },
      onState: () => {}, requestTask: async () => "done", cancelTask: () => {},
    });
    check(voice.snapshot().wakeEnabled === true, "saved config without wakeEnabled did not default to true");
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
    check(!JSON.stringify(second.writes[0]).includes("end_conversation"),
      "model still received a conversation-ending tool");
    second.push({ type: "response.output_audio.started", response_id: "r2" });
    second.push({ type: "response.output_audio.delta", response_id: "r2", delta: "AAAAAA==" });
    second.push({ type: "response.output_audio.done", response_id: "r2", status_code: "20000002" });
    await wait(40);
    playback = 0;
    await wait(40);
    check(voice.snapshot().phase === "listening", "provider exit hint ended conversation after playback");
    await wait(210);
    check(voice.snapshot().phase === "standby", "second conversation did not end after 12 seconds of silence");

    wakeWord = "Hey_LOOI";
    await wait(85);
    const third = sockets[2];
    third.push({ type: "session.created" });
    await wait(35);
    third.push({ type: "conversation.item.input_audio_transcription.started" });
    third.push({ type: "input_audio_buffer.committed" });
    await wait(50);
    third.push({ type: "conversation.item.input_audio_transcription.completed" });
    await wait(155);
    check(voice.snapshot().phase === "standby", "late transcription completion restarted the silence window");

    voice.stop();
    ready = false;
    await voice.enterStandby();
    check(voice.snapshot().phase === "error" && voice.snapshot().error === "" && state === "idle" && stops > 0,
      "unavailable KWS was shown as listening or leaked model error");
    voice.close();

    let completeAppend!: () => void;
    let appendEntered = false, closeWritten = false;
    const socket = new SocketFixture();
    const ordering = new VoiceRuntime({
      vault: { get: () => JSON.stringify({ apiKey: "test-key", wakeEnabled: false }), set: () => {}, remove: () => {} },
      audio,
      connect: async () => ({
        read: () => socket.read(),
        write: async (raw) => {
          const message = JSON.parse(raw);
          if (message.type === "input_audio_buffer.append") {
            appendEntered = true;
            await new Promise<void>((resolve) => { completeAppend = resolve; });
          }
          if (message.type === "session.close") closeWritten = true;
        },
        close: () => socket.close(),
      }),
      onState: () => {}, requestTask: async () => "", cancelTask: () => {},
    });
    await ordering.start();
    socket.push({ type: "session.created" });
    await wait(35);
    check(appendEntered, "capture write did not begin");
    ordering.endSession();
    check(!closeWritten, "session.close overtook an active PCM write");
    completeAppend();
    await wait(25);
    check(closeWritten, "session.close was not sent after PCM write");
    ordering.close();

    permission = "undetermined";
    let permissionRequests = 0;
    const permissionVoice = new VoiceRuntime({
      vault: { get: () => JSON.stringify({ apiKey: "test-key", wakeEnabled: true }), set: () => {}, remove: () => {} },
      audio: { ...audio, requestPermission: () => { permissionRequests++; return permission; } },
      connect: async () => new SocketFixture(),
      onState: () => {}, requestTask: async () => "", cancelTask: () => {},
    });
    await permissionVoice.enterStandby();
    check(permissionVoice.snapshot().phase === "permission" && permissionRequests === 1,
      "first microphone request did not wait for the platform callback");
    permission = "denied";
    await wait(280);
    check(permissionVoice.snapshot().phase === "error" && permissionRequests === 1,
      "denied microphone permission retried the system request");
    permissionVoice.close();

    permission = "undetermined";
    const cancelledVoice = new VoiceRuntime({
      vault: { get: () => JSON.stringify({ apiKey: "test-key", wakeEnabled: true }), set: () => {}, remove: () => {} },
      audio: { ...audio, requestPermission: () => { permissionRequests++; return permission; } },
      connect: async () => new SocketFixture(),
      onState: () => {}, requestTask: async () => "", cancelTask: () => {},
    });
    await cancelledVoice.enterStandby();
    cancelledVoice.setWakeEnabled(false);
    check(cancelledVoice.snapshot().phase === "idle" && !cancelledVoice.snapshot().wakeEnabled,
      "disabling wake during permission polling did not reset state");
    cancelledVoice.setWakeEnabled(true, { autoStandby: false });
    check(cancelledVoice.snapshot().phase === "idle" && cancelledVoice.snapshot().wakeEnabled,
      "deferred wake enable started audio prematurely");
    await cancelledVoice.enterStandby();
    permission = "cancelled";
    await wait(280);
    check(cancelledVoice.snapshot().phase === "error" && permissionRequests === 3,
      "cancelled microphone request stayed in permission polling");
    cancelledVoice.close();
  } finally {
    Date.now = originalNow;
    globalThis.setTimeout = originalTimeout;
  }
}
