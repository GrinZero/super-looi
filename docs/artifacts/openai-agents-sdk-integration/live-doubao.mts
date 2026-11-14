import { createRequire } from "node:module";
import { LiveVoiceSession } from "../../../apps/nsh/runtime/voice/live-session.js";
import { createDoubaoDuplexV3Protocol } from "../../../apps/nsh/runtime/voice/protocol.js";
import { createLangfuseTracer } from "../../../packages/looi-runtime/src/telemetry/langfuse.js";
import type { VoiceSocket } from "../../../apps/nsh/runtime/voice/types.js";

// Manual cloud-stream check. The App session/SDK/codec are real; the audio port
// counts PCM and drains with wall time. It does not exercise a device speaker.
const require = createRequire(
  new URL("../../../apps/nsh/package.json", import.meta.url),
);
const { default: WebSocket } = await import(
  require.resolve("ws", { paths: [require.resolve("@openai/agents-realtime")] })
);
const apiKey = process.env.DOUBAO_API_KEY;
if (!apiKey) throw new Error("DOUBAO_API_KEY is required");
let queueMs = 0,
  lastTime = Date.now(),
  pcmBytes = 0,
  frames = 0;
const status = () => {
  const now = Date.now();
  queueMs = Math.max(0, queueMs - (now - lastTime));
  lastTime = now;
  return {
    state: "running",
    permission: "granted",
    error: "",
    queuedPlaybackMs: queueMs,
    captureMode: "preview",
    wakeWord: "",
    kwsReady: false,
  };
};
const records: Array<{ name: string; attributes: Record<string, unknown> }> =
  [];
let complete!: () => void, fail!: (error: Error) => void;
const done = new Promise<void>((resolve, reject) => {
  complete = resolve;
  fail = reject;
});
let phase = "connecting",
  transcript = "";
const session = new LiveVoiceSession({
  apiKey,
  protocol: createDoubaoDuplexV3Protocol(),
  voiceId: "zh_female_vv_jupiter_bigtts",
  purpose: "preview",
  initialLanguage: "zh-CN",
  fromWakeWord: false,
  previewText:
    "你好，我是 LOOI。现在使用 OpenAI Agents SDK 管理实时会话。我们会完整播放这句话，直到最后一个字，再结束试听。",
  tracer: createLangfuseTracer({
    onObservation: (record) => {
      if (record.endedAt)
        records.push({ name: record.name, attributes: record.attributes });
    },
  }),
  audio: {
    requestPermission: () => "granted",
    start: () => {},
    beginWake: () => 0,
    startWake: async () => false,
    stop: () => {},
    enqueue: (pcm) => {
      status();
      pcmBytes += pcm.length;
      frames++;
      queueMs += pcm.length / 48;
    },
    clearPlayback: () => {
      queueMs = 0;
    },
    setMuted: () => {},
    setCaptureMode: () => {},
    playReadyCue: () => {},
    drainCapture: () => [],
    status,
  },
  connect: async (url, { headers }) => {
    const socket = new WebSocket(url, { headers });
    const incoming: Array<string | Uint8Array | null> = [];
    let reader: ((value: string | Uint8Array | null) => void) | undefined;
    let readError: Error | undefined;
    let closeCode: number | undefined, closeReason: string | undefined;
    const push = (value: string | Uint8Array | null) => {
      if (reader) {
        const resolve = reader;
        reader = undefined;
        resolve(value);
      } else incoming.push(value);
    };
    socket.on("message", (data: Buffer, binary: boolean) =>
      push(binary ? Uint8Array.from(data) : data.toString()),
    );
    socket.on("close", (code: number, reason: Buffer) => {
      closeCode = code;
      closeReason = reason.toString();
      push(null);
    });
    socket.on("error", (error: Error) => {
      readError = error;
      push(null);
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    const port: VoiceSocket = {
      get closeCode() {
        return closeCode;
      },
      get closeReason() {
        return closeReason;
      },
      read: async () => {
        const value = incoming.length
          ? incoming.shift()!
          : await new Promise<string | Uint8Array | null>((resolve) => {
              reader = resolve;
            });
        if (value === null && readError) throw readError;
        return value;
      },
      write: (value) =>
        new Promise<void>((resolve, reject) =>
          socket.send(value, (error?: Error) =>
            error ? reject(error) : resolve(),
          ),
        ),
      close: async () => {
        socket.close();
      },
    };
    return port;
  },
  onStatePatch: (patch) => {
    if (patch.phase) phase = patch.phase;
    if (patch.transcript) transcript = patch.transcript;
  },
  onSessionComplete: complete,
  onSessionError: (message) => fail(new Error(message)),
});
const timeout = setTimeout(
  () =>
    fail(
      Object.assign(new Error("Live preview exceeded 45000 ms"), {
        code: "ETIMEDOUT",
      }),
    ),
  45_000,
);
try {
  await session.open();
  await done;
  session.dispose("graceful");
  await new Promise((resolve) => setTimeout(resolve, 20));
  console.log(
    JSON.stringify(
      {
        provider: "doubao",
        sdk: "0.22.0",
        playback: "simulated-port",
        pcmBytes,
        durationMs: pcmBytes / 48,
        frames,
        phase,
        transcript,
        responses: records
          .filter((record) => record.name === "realtime.response")
          .map((record) => record.attributes["langfuse.observation.output"]),
      },
      null,
      2,
    ),
  );
} finally {
  clearTimeout(timeout);
  session.dispose("immediate");
}
