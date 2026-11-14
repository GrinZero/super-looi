import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { VoiceCredentialStore } from "../runtime/voice/credentials.js";
import { LiveVoiceSession } from "../runtime/voice/live-session.js";
import type { VoiceAudioPort, VoiceSocket } from "../runtime/voice/types.js";
import { createMossLiveProtocol, createOpenAiRealtimeProtocol } from "../../../packages/looi-runtime/src/voice/realtime-protocol.js";
import { createLangfuseTracer, type TraceObservation } from "../../../packages/looi-runtime/src/telemetry/langfuse.js";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const apiKey = "test-voice-secret";

function setup(
  t: TestContext,
  connect: () => Promise<VoiceSocket>,
  preview = false,
  previewInput = async () => new Uint8Array(640),
  protocol = preview ? createMossLiveProtocol() : createOpenAiRealtimeProtocol(),
) {
  const observations: TraceObservation[] = [];
  const errors: string[] = [];
  const logs: unknown[][] = [];
  const patches: Array<Record<string, unknown>> = [];
  t.mock.method(console, "error", (...args: unknown[]) => { logs.push(args); });
  const audio: VoiceAudioPort = {
    requestPermission: () => "granted", start: () => {}, beginWake: () => 0,
    startWake: async () => true, stop: () => {}, enqueue: () => {},
    clearPlayback: () => {}, setMuted: () => {}, setCaptureMode: () => {},
    playReadyCue: () => {}, drainCapture: () => [],
    status: () => ({ state: "running", permission: "granted", error: "",
      queuedPlaybackMs: 0, captureMode: "conversation", wakeWord: "", kwsReady: true }),
  };
  const session = new LiveVoiceSession({
    apiKey, voiceId: "draft-voice", previewText: "你好，试听必须完整读到最后。", initialLanguage: "zh-CN", fromWakeWord: false,
    sessionId: "failure-test-session", protocol,
    ...(preview ? { purpose: "preview" as const } : {}),
    audio, connect, previewInput,
    tracer: createLangfuseTracer({ onObservation: (record) => observations.push(record) }),
    onStatePatch: patch => { patches.push(patch); }, onSessionComplete: () => session.dispose("immediate"),
    onSessionError: (message) => { errors.push(message); session.dispose("immediate"); },
  });
  t.after(() => session.dispose("immediate"));
  const failure = () => JSON.parse(errors[0].slice(errors[0].indexOf("|") + 1));
  const ended = (name: string) => observations.filter((item) => item.name === name && item.endedAt);
  return { session, errors, failure, ended, logs, audio, patches };
}

test("MOSS speech activity keeps playing until the explicit server interruption", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const incoming: Array<string | Uint8Array> = [];
  const writes: Record<string, unknown>[] = [];
  let reader: ((raw: string | Uint8Array | null) => void) | undefined;
  const emit = (event: unknown) => {
    const raw = event instanceof Uint8Array ? event : JSON.stringify(event);
    if (reader) { const resolve = reader; reader = undefined; resolve(raw); }
    else incoming.push(raw);
  };
  const h = setup(t, async () => socket({
    read: () => incoming.length ? Promise.resolve(incoming.shift()!) : new Promise(resolve => { reader = resolve; }),
    write: async raw => { if (typeof raw === "string") writes.push(JSON.parse(raw)); },
  }), false, undefined, createMossLiveProtocol());
  let queued = 0, cleared = 0, enqueued = 0;
  t.mock.method(h.audio, "enqueue", (pcm: Uint8Array) => { enqueued += pcm.length; queued += pcm.length / 48; });
  t.mock.method(h.audio, "clearPlayback", () => { cleared++; queued = 0; });
  t.mock.method(h.audio, "status", () => ({ state: "running", permission: "granted", error: "",
    queuedPlaybackMs: queued, captureMode: "conversation", wakeWord: "", kwsReady: true }));
  const audioChunk = (run = "r") => {
    emit({ action: "response.audio.context", data: { run_id: run, turn_id: "t", chunk_id: String(enqueued), duration_ms: 100 } });
    emit(new Uint8Array(4800));
  };
  await h.session.open();
  emit({ action: "session_attached", data: { session_id: "conversation" } });
  emit({ action: "session.updated", data: { error: "" } });
  emit({ action: "response.audio.started", data: { run_id: "r", turn_id: "t" } });
  audioChunk(); await flush(); t.mock.timers.tick(20); await flush();
  assert.equal(enqueued, 4800);
  emit({ action: "input.speech.started" });
  emit({ action: "input.speech.stopped" });
  audioChunk(); await flush(); t.mock.timers.tick(20); await flush();
  assert.equal(cleared, 0, "speech activity prematurely cleared model playback");
  assert.equal(enqueued, 9600, "later PCM from the same run was discarded");
  assert.equal(h.patches.filter(patch => patch.phase).at(-1)?.phase, "speaking");
  emit({ action: "response.audio.stop", data: { run_id: "r", turn_id: "t", reason: "user_interrupt" } });
  emit({ action: "response.interrupted", data: { run_id: "r", turn_id: "t", reason: "user_interrupt" } });
  await flush();
  assert.equal(cleared, 1);
  assert.ok(writes.some(frame => frame.action === "playback.stopped" && frame.run_id === "r"));
  assert.deepEqual(h.ended("realtime.interruption").map(record => ({
    reason: record.attributes["langfuse.observation.metadata.reason"],
    run: record.attributes["langfuse.observation.metadata.responseId"],
  })), [{ reason: "user_interrupt", run: "r" }, { reason: "user_interrupt", run: "r" }]);
  emit({ action: "response.audio.started", data: { run_id: "next", turn_id: "t" } });
  audioChunk("next"); await flush(); t.mock.timers.tick(20); await flush();
  assert.equal(enqueued, 14400, "conversation did not recover after the real interruption");
  assert.deepEqual(h.errors, []);
});

test("MOSS preview uses a real voice turn, acknowledges all PCM and waits for the provider terminal event", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const writes: Array<string | Uint8Array> = [];
  const incoming: Array<string | Uint8Array> = [];
  let reader: ((raw: string | Uint8Array | null) => void) | undefined;
  const emit = (event: unknown) => {
    const raw = event instanceof Uint8Array ? event : JSON.stringify(event);
    if (reader) { const resolve = reader; reader = undefined; resolve(raw); }
    else incoming.push(raw);
  };
  const h = setup(t, async () => socket({
    read: () => incoming.length ? Promise.resolve(incoming.shift()!) : new Promise(resolve => { reader = resolve; }),
    write: async raw => { writes.push(raw); },
  }), true, async () => new Uint8Array(640).fill(42));
  let enqueued = 0, hold = true;
  t.mock.method(h.audio, "enqueue", (pcm: Uint8Array, rate: number) => {
    assert.equal(rate, 24000); enqueued += pcm.length;
  });
  t.mock.method(h.audio, "status", () => ({ state: "running", permission: "undetermined", error: "",
    queuedPlaybackMs: hold ? 1 : 0, captureMode: "idle", wakeWord: "", kwsReady: false }));
  await h.session.open();
  emit({ action: "session_attached", data: { session_id: "preview" } });
  emit({ action: "session.updated", data: { error: "" } });
  emit({ action: "input.speech.started" });
  emit({ action: "input.transcript.done", data: { text: "你好，请说一句问候语。", turn: "1" } });
  emit({ action: "response.audio.started", data: { run_id: "r", turn_id: "t" } });
  for (let i = 1; i <= 3; i++) {
    emit({ action: "response.audio.context", data: { run_id: "r", turn_id: "t", chunk_id: String(i), duration_ms: 1000 } });
    emit(new Uint8Array(48000));
  }
  emit({ action: "response.audio.done", data: { run_id: "r", turn_id: "t" } });
  await flush();
  for (let i = 0; i < 8; i++) { t.mock.timers.tick(20); await flush(); }
  const frames = () => writes.filter((raw): raw is string => typeof raw === "string").map(raw => JSON.parse(raw));
  assert.ok(frames().some(frame => frame.action === "mic_state" && frame.enabled));
  assert.ok(!frames().some(frame => frame.action === "session.commentary.append"));
  assert.ok(writes.some(raw => raw instanceof Uint8Array && raw[0] === 42));
  assert.equal(enqueued, 144000, "preview was truncated at two seconds");
  assert.equal(h.session.isDisposed, false);
  hold = false; t.mock.timers.tick(20); await flush();
  assert.equal(frames().filter(frame => frame.action === "playback.chunk.completed").length, 3);
  assert.equal(frames().filter(frame => frame.action === "playback.completed").length, 1);
  assert.equal(h.session.isDisposed, false, "preview closed before response.ended");
  emit({ action: "output.transcript.done", data: { text: "你好，试听必须完整读到最后。", run_id: "r", turn_id: "t" } });
  emit({ action: "response.ended", data: { status: "completed", run_id: "r", turn_id: "t" } });
  await flush();
  assert.equal(h.session.isDisposed, true);
  assert.deepEqual(h.errors, []);
});

test("stopping before the preview input loads discards its late result", async (t) => {
  let deliver!: (pcm: Uint8Array) => void;
  let connections = 0;
  const h = setup(t, async () => { connections++; return socket(); }, true,
    () => new Promise<Uint8Array>(resolve => { deliver = resolve; }));
  const opening = h.session.open();
  h.session.dispose("immediate");
  deliver(new Uint8Array(640));
  await opening;
  assert.equal(connections, 0);
  assert.deepEqual(h.errors, []);
});

test("MOSS default preset is used in the actual session voice request", () => {
  const credentials = new VoiceCredentialStore({ get: () => "", set: () => {}, remove: () => {} });
  const selected = credentials.configuration("moss").voiceId;
  assert.equal(selected, "6c3152b1-1d4f-4e49-ade3-09f447712fec");
  const protocol = createMossLiveProtocol();
  protocol.createHandshakeMessages([], { voiceId: selected, purpose: "preview" });
  const attached = protocol.parseServerEvent({ action: "session_attached", data: { session_id: "s" } });
  assert.equal(attached.kind, "session_attached");
  if (attached.kind === "session_attached") {
    assert.ok(attached.followUpMessages.some((frame) => frame.action === "change_voice" && frame.voice_name === selected));
  }
});

function socket(overrides: Partial<VoiceSocket> = {}): VoiceSocket {
  return { read: () => new Promise(() => {}), write: async () => {}, close: async () => {}, ...overrides };
}

test("connect rejection retains nested codes and reason in UI, logs and session trace", async (t) => {
  const cause = Object.assign(new Error(`HTTP 403: access denied for ${apiKey}`), { code: 403 });
  const error = Object.assign(new Error("WebSocket handshake rejected", { cause }), { code: "ERR_NETWORK" });
  const h = setup(t, async () => { throw error; });
  await h.session.open();
  assert.equal(h.failure().stage, "websocket.connect");
  assert.match(h.failure().detail, /ERR_NETWORK.*handshake rejected.*403.*access denied/);
  const root = h.ended("voice.session");
  assert.equal(root.length, 1);
  assert.equal(root[0].attributes["session.id"], "failure-test-session");
  assert.equal(root[0].attributes["langfuse.observation.level"], "ERROR");
  assert.equal(root[0].attributes["langfuse.observation.metadata.errorCode"], "ERR_NETWORK");
  assert.equal(h.ended("realtime.handshake")[0].attributes["langfuse.observation.metadata.failureStage"], "websocket.connect");
  assert.ok(!JSON.stringify([h.errors, h.logs, root]).includes(apiKey));
  assert.match(h.failure().detail, /\[redacted\]/);
});

test("first handshake write rejection is recorded as a send failure", async (t) => {
  const h = setup(t, async () => socket({ write: async () => {
    throw Object.assign(new Error("Broken pipe"), { code: "EPIPE" });
  } }));
  await h.session.open();
  assert.equal(h.failure().stage, "handshake.send");
  assert.match(h.failure().detail, /EPIPE.*Broken pipe/);
  assert.equal(h.errors.length, 1);
  assert.equal(h.ended("voice.session")[0].attributes["langfuse.observation.level"], "ERROR");
  assert.equal(h.ended("realtime.handshake")[0].attributes["langfuse.observation.metadata.errorCode"], "EPIPE");
});

test("socket read failure keeps the transport error instead of reporting a timeout", async (t) => {
  const h = setup(t, async () => socket({ read: async () => {
    throw Object.assign(new Error("Connection reset by peer"), { code: "ECONNRESET" });
  } }));
  await h.session.open();
  await flush();
  assert.equal(h.failure().stage, "websocket.read");
  assert.match(h.failure().detail, /ECONNRESET.*Connection reset by peer/);
  assert.doesNotMatch(h.failure().detail, /timeout|timed out/i);
});

test("provider rejection preserves its code and actual message", async (t) => {
  const messages = [JSON.stringify({ type: "error", error: {
    code: "invalid_api_key", message: "The API key has been revoked",
  } })];
  const h = setup(t, async () => socket({ read: () => messages.length
    ? Promise.resolve(messages.shift()!) : new Promise(() => {}) }));
  await h.session.open();
  await flush();
  assert.equal(h.failure().stage, "provider.error");
  assert.match(h.failure().detail, /invalid_api_key.*has been revoked/);
  assert.equal(h.ended("voice.session")[0].attributes["langfuse.observation.metadata.errorCode"], "invalid_api_key");
});

test("invalid inbound JSON is identified as protocol decoding failure", async (t) => {
  const h = setup(t, async () => socket({ read: async () => "{invalid-json" }));
  await h.session.open();
  await flush();
  assert.equal(h.failure().stage, "protocol.decode");
  assert.ok(h.failure().detail.length > 0);
});

test("the built-in socket's close code and reason survive the observer", async (t) => {
  const h = setup(t, async () => socket({
    closeCode: 4001, closeReason: "Voice model access revoked", read: async () => null,
  }));
  await h.session.open();
  await flush();
  assert.equal(h.failure().stage, "websocket.read");
  assert.match(h.failure().detail, /WS_4001.*Voice model access revoked/);
  assert.equal(h.ended("voice.session")[0].attributes["langfuse.observation.metadata.errorCode"], "WS_4001");
});

test("a read failure during a response marks the generation as failed", async (t) => {
  const messages = [
    JSON.stringify({ type: "session.updated", session: { id: "s" } }),
    JSON.stringify({ type: "response.created", response: { id: "r" } }),
  ];
  const h = setup(t, async () => socket({ read: async () => {
    if (messages.length) return messages.shift()!;
    throw Object.assign(new Error("Peer reset during speech"), { code: "ECONNRESET" });
  } }));
  await h.session.open();
  await flush();
  const response = h.ended("realtime.response")[0];
  assert.equal(response.attributes["langfuse.observation.level"], "ERROR");
  assert.equal(response.attributes["langfuse.observation.metadata.statusCode"], "ECONNRESET");
  assert.equal(response.attributes["langfuse.observation.metadata.failureStage"], "websocket.read");
  assert.match(String(response.attributes["langfuse.observation.status_message"]), /Peer reset during speech/);
});

test("stopping during connect ignores its late rejection", async (t) => {
  let reject!: (error: Error) => void;
  const h = setup(t, () => new Promise((_resolve, fail) => { reject = fail; }));
  const opened = h.session.open();
  await flush(); // SDK prepares its agent before opening the transport.
  h.session.dispose("immediate");
  reject(Object.assign(new Error("Connect cancelled"), { code: "ECANCELED" }));
  await opened;
  assert.equal(h.errors.length, 0);
  assert.equal(h.logs.length, 0);
  assert.equal(h.ended("voice.session").length, 0);
});

test("only the elapsed connection deadline reports ETIMEDOUT and closes a late socket", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let resolve!: (value: VoiceSocket) => void;
  let closed = false;
  const h = setup(t, () => new Promise((done) => { resolve = done; }));
  const opened = h.session.open();
  await flush();
  t.mock.timers.tick(15_000);
  assert.equal(h.failure().stage, "websocket.connect");
  assert.match(h.failure().detail, /ETIMEDOUT/);
  resolve(socket({ close: async () => { closed = true; } }));
  await opened;
  assert.equal(closed, true);
  assert.equal(h.errors.length, 1);
});
