import { Buffer } from "node:buffer";
import { VoiceRuntime, type VoiceAudioPort, type VoiceSocket } from "../runtime/voice.js";
import { createOpenAiRealtimeProtocol } from "../../../packages/looi-runtime/src/voice/realtime-protocol.js";
import { createLangfuseTracer } from "../../../packages/looi-runtime/src/telemetry/langfuse.js";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
class Socket implements VoiceSocket {
  writes: any[] = [];
  private reader?: (value: string | null) => void;
  private pending: Array<string | null> = [];
  read(): Promise<string | null> {
    if (this.pending.length) return Promise.resolve(this.pending.shift()!);
    return new Promise((resolve) => { this.reader = resolve; });
  }
  async write(value: string) { this.writes.push(JSON.parse(value)); }
  async close() { this.push(null); }
  push(value: unknown) {
    const raw = value === null ? null : JSON.stringify(value);
    if (this.reader) { const read = this.reader; this.reader = undefined; read(raw); }
    else this.pending.push(raw);
  }
}

export async function verifyOpenAiVoiceRuntime() {
  const slots = new Map<string, string>([["voice", JSON.stringify({ apiKey: "doubao-old", wakeEnabled: false })]]);
  const vault = { get: (key: string) => slots.get(key) ?? "", set: (key: string, value: string) => { slots.set(key, value); }, remove: (key: string) => { slots.delete(key); } };
  let queuedPlaybackMs = 0, playbackClears = 0, starts = 0, mode = "idle";
  const audio: VoiceAudioPort = {
    beginWake: () => 0, startWake: async () => { audio.setCaptureMode("kws"); return true; },
    requestPermission: () => "granted", start: () => { starts++; }, stop: () => { mode = "idle"; },
    enqueue: (pcm) => { queuedPlaybackMs += pcm.length / 48; }, clearPlayback: () => { queuedPlaybackMs = 0; playbackClears++; },
    setMuted: () => {}, setCaptureMode: (next) => { mode = next; }, playReadyCue: () => {}, drainCapture: () => [],
    status: () => ({ state: "running", permission: "granted", error: "", queuedPlaybackMs, captureMode: mode, wakeWord: "", kwsReady: true }),
  };
  const sockets: Socket[] = [], headers: Array<Record<string, string>> = [];
  let audioStarted = 0;
  const voice = new VoiceRuntime({
    vault, audio, protocol: createOpenAiRealtimeProtocol({ model: "gpt-realtime" }),
    connect: async (url, options) => { check(url.endsWith("?model=gpt-realtime"), "OpenAI model missing from URL"); headers.push(options.headers); const socket = new Socket(); sockets.push(socket); return socket; },
    onState: (state) => { if (state.phase === "speaking") audioStarted++; },
    requestTask: async () => "任务完成", cancelTask: () => {},
  });
  check(voice.configuration().hasKey === false && voice.configuration().providerLabel === "OpenAI", "OpenAI reused legacy Doubao key");
  slots.set("model", JSON.stringify({ credentials: { openai: { type: "api_key", key: "model-key" } } }));
  check(voice.refreshCredentials().hasKey, "new model credential did not become available");
  await voice.start();
  const socket = sockets[0];
  check(headers[0].Authorization === "Bearer model-key" && socket.writes[0]?.type === "session.update", "OpenAI handshake used wrong credential or frame");
  socket.push({ type: "session.created" });
  await wait(20);
  check(mode === "idle", "capture started before session.updated");
  socket.push({ type: "session.updated", session: { id: "s" } });
  await wait(25);
  check(mode === "conversation" && voice.snapshot().phase === "listening", "session.updated did not enable capture");
  socket.push({ type: "response.created", response: { id: "r0" } });
  socket.push({ type: "input_audio_buffer.speech_started" });
  socket.push({ type: "response.output_audio.delta", response_id: "r0", item_id: "obsolete", content_index: 0, delta: Buffer.alloc(960).toString("base64") });
  await wait(30);
  check(queuedPlaybackMs === 0 && !socket.writes.some((item) => item.type === "response.cancel"), "server VAD played old response or sent duplicate cancel");
  socket.push({ type: "response.done", response: { id: "r0", status: "cancelled" } });
  socket.push({ type: "response.created", response: { id: "r1" } });
  socket.push({ type: "response.output_audio.delta", response_id: "r1", item_id: "item-1", content_index: 0, delta: Buffer.alloc(960).toString("base64") });
  socket.push({ type: "response.output_audio_transcript.done", response_id: "r1", transcript: "你好" });
  await wait(45);
  check(audioStarted > 0 && voice.snapshot().transcript === "你好" && queuedPlaybackMs === 20, "delta without started did not play or update transcript");
  queuedPlaybackMs = 12;
  voice.interrupt();
  await wait(15);
  const truncate = socket.writes.find((item) => item.type === "conversation.item.truncate");
  check(truncate?.item_id === "item-1" && truncate.audio_end_ms === 8, "truncate did not use heard audio duration");
  const cancel = socket.writes.find((item) => item.type === "response.cancel");
  check(typeof cancel?.event_id === "string" && playbackClears > 0, "manual interrupt missed cancel or local clear");
  socket.push({ type: "error", error: { event_id: cancel.event_id, message: "no active response" } });
  socket.push({ type: "response.done", response: { id: "r1", status: "cancelled" } });
  socket.push({ type: "response.output_audio.delta", response_id: "r2", item_id: "item-2", content_index: 0, delta: Buffer.alloc(960).toString("base64") });
  await wait(45);
  check(voice.snapshot().phase === "speaking", "cancel race blocked next response");
  socket.push({ type: "response.function_call_arguments.done", response_id: "r2", call_id: "task-1", name: "run_agent_task", arguments: '{"prompt":"开灯"}' });
  await wait(35);
  check(socket.writes.some((item) => item.type === "conversation.item.create" && item.item?.type === "function_call_output" && typeof item.item.output === "string"), "OpenAI function output was not serialized");
  check(socket.writes.some((item) => item.type === "response.create"), "OpenAI tool did not continue response");
  voice.stop();
  slots.set("model", JSON.stringify({ credentials: {} }));
  check(!voice.refreshCredentials().hasKey, "removed model key remained available");
  voice.configure("openai-own");
  const saved = JSON.parse(slots.get("voice")!);
  check(saved.apiKey === "doubao-old" && saved.apiKeys.openai === "openai-own" && saved.apiKeys.doubao === "doubao-old", "provider keys overwrote each other");
  voice.setWakeEnabled(true);
  check(JSON.parse(slots.get("voice")!).apiKeys.openai === "openai-own", "wake toggle erased provider key");
  voice.close();
}

export async function verifyVoiceTraceFinalization() {
  for (const action of ["endSession", "close"] as const) {
    const exported: any[] = [];
    const tracer = createLangfuseTracer({ baseUrl: "http://localhost:3000", publicKey: "pk", secretKey: "sk", flushIntervalMs: 60_000,
      fetch: async (_url, options) => { exported.push(JSON.parse(String(options?.body))); return new Response("", { status: 200 }); } });
    let releaseClose!: () => void;
    const raw: VoiceSocket = {
      read: () => new Promise(() => {}), write: async () => {},
      close: () => new Promise<void>((resolve) => { releaseClose = resolve; }),
    };
    const voice = new VoiceRuntime({
      vault: { get: () => JSON.stringify({ apiKey: "doubao-key" }), set: () => {}, remove: () => {} },
      audio: { beginWake: () => 0, startWake: async () => true, requestPermission: () => "granted", start: () => {}, stop: () => {}, enqueue: () => {}, clearPlayback: () => {}, setMuted: () => {},
        setCaptureMode: () => {}, playReadyCue: () => {}, drainCapture: () => [], status: () => ({ state: "running", permission: "granted", error: "", queuedPlaybackMs: 0, captureMode: "conversation", wakeWord: "", kwsReady: true }) },
      connect: async () => raw, onState: () => {}, requestTask: async () => "", cancelTask: () => {}, tracer,
    });
    await voice.start();
    voice[action]();
    await tracer.shutdown();
    const spans = exported.flatMap((batch) => batch.resourceSpans.flatMap((resource: any) => resource.scopeSpans.flatMap((scope: any) => scope.spans)));
    check(spans.some((span: any) => span.name === "voice.session"), `${action} lost the root span before socket.close`);
    releaseClose?.();
  }
}
