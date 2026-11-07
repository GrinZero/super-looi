import {
  VoiceRuntime,
  type VoiceAudioPort,
  type VoiceSocket,
} from "../runtime/voice.js";
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 25));
export async function verifyVoiceRuntime() {
  let state = "idle",
    permission = "granted",
    starts = 0,
    stops = 0,
    playback = 0,
    requests = 0,
    taskCalls = 0;
  let captureMode = "idle";
  let maxPlaybackFrame = 0,
    fullQueueChecks = 0;
  const audio: VoiceAudioPort = {
    requestPermission: () => {
      requests++;
      return permission;
    },
    start: () => {
      starts++;
      state = "running";
      captureMode = "conversation";
    },
    setCaptureMode: (mode) => {
      if (state !== "running") audio.start(true);
      captureMode = mode;
    },
    playReadyCue: () => {},
    stop: () => {
      stops++;
      state = "idle";
      captureMode = "idle";
    },
    enqueue: (pcm) => {
      maxPlaybackFrame = Math.max(maxPlaybackFrame, pcm.length);
      playback += pcm.length;
    },
    clearPlayback: () => {
      playback = 0;
    },
    setMuted: () => {},
    drainCapture: () => [],
    status: () => ({
      state,
      permission,
      error: "",
      queuedPlaybackMs: fullQueueChecks-- > 0 ? 5000 : playback > 0 ? 10 : 0,
      captureMode,
      wakeWord: "",
      kwsReady: true,
    }),
  };
  const slots = new Map<string, string>();
  const vault = {
    get: (key: string) => slots.get(key) ?? "",
    set: (key: string, value: string) => {
      slots.set(key, value);
    },
    remove: (key: string) => {
      slots.delete(key);
    },
  };
  const writes: Record<string, any>[] = [];
  let reader: ((value: string | null) => void) | undefined;
  const incoming: string[] = [];
  let socketClosed = false;
  const socket: VoiceSocket = {
    read: () =>
      incoming.length
        ? Promise.resolve(incoming.shift()!)
        : socketClosed
          ? Promise.resolve(null)
          : new Promise((resolve) => {
              reader = resolve;
            }),
    write: async (value) => {
      writes.push(JSON.parse(value));
    },
    close: async () => {
      socketClosed = true;
      reader?.(null);
      reader = undefined;
    },
  };
  const event = (value: unknown) => {
    const raw = JSON.stringify(value);
    if (reader) {
      const resolve = reader;
      reader = undefined;
      resolve(raw);
    } else incoming.push(raw);
  };
  let finishTask!: (value: string) => void;
  const voice = new VoiceRuntime({
    vault,
    audio,
    connect: async (url, options) => {
      check(
        url.startsWith("wss://openspeech.bytedance.com/"),
        "wrong voice endpoint",
      );
      check(
        options.headers["X-Api-Key"] === "TEST_ONLY_VOICE",
        "missing native handshake key",
      );
      return socket;
    },
    onState: () => {},
    requestTask: async () => {
      taskCalls++;
      return new Promise((resolve) => {
        finishTask = resolve;
      });
    },
    cancelTask: () => {},
  });
  let rejected = false;
  try {
    await voice.start();
  } catch {
    rejected = true;
  }
  check(rejected && starts === 0, "missing key opened microphone");
  voice.configure("TEST_ONLY_VOICE");
  check(
    slots.has("voice") &&
      !JSON.stringify(voice.configuration()).includes("TEST_ONLY"),
    "voice credentials escaped public config",
  );
  permission = "denied";
  await voice.start();
  check(
    requests === 1 && starts === 0 && voice.snapshot().phase === "permission",
    "permission denial started audio",
  );
  permission = "granted";
  await voice.start();
  check(
    starts === 0 && writes[0]?.type === "session.create",
    "capture started before provider ready",
  );
  const tools = writes[0]?.session?.tools;
  check(
    Array.isArray(tools) &&
      tools.length === 2 &&
      tools[0]?.name === "run_agent_task" &&
      tools[0]?.parameters?.properties?.prompt?.type === "string" &&
      tools[0]?.parameters?.required?.includes("prompt") &&
      tools[1]?.name === "end_conversation" &&
      tools[1]?.parameters?.additionalProperties === false,
    "voice tool schemas were not sent with the session",
  );
  event({ type: "session.created" });
  await settle();
  check(
    Number(starts) === 1 && voice.snapshot().phase === "listening",
    "session did not start native capture",
  );
  event({ type: "input_audio_buffer.speech_started" });
  await settle();
  check(
    !writes.some((item) => item.type === "response.cancel"),
    "normal user speech cancelled an idle response",
  );
  event({ type: "response.output_audio.delta", delta: "AAAAAA==" });
  await settle();
  check(playback === 4, "audio was not delivered");
  voice.interrupt();
  await settle();
  check(
    Number(playback) === 0 &&
      writes.some((item) => item.type === "response.cancel"),
    "barge-in did not clear and cancel",
  );
  event({ type: "response.output_audio.delta", delta: "AAAAAA==" });
  await settle();
  check(playback === 0, "obsolete speech played after interruption");
  event({ type: "response.output_audio.started" });
  event({ type: "response.output_audio.delta", delta: "AAAAAA==" });
  event({ type: "response.output_text.done", text: "obsolete" });
  await settle();
  check(
    playback === 0 && !voice.snapshot().transcript.includes("obsolete"),
    "obsolete started frame bypassed cancellation",
  );
  event({ type: "response.canceled" });
  await settle();
  fullQueueChecks = 4;
  event({ type: "response.output_audio.delta", delta: "AAAA".repeat(3200) });
  await new Promise((resolve) => setTimeout(resolve, 100));
  check(
    Number(playback) === 9600 && maxPlaybackFrame <= 4800,
    "native playback backpressure was ignored or PCM was not chunked",
  );
  const beforeInterrupts = writes.filter(
    (item) => item.type === "response.cancel",
  ).length;
  fullQueueChecks = 100;
  event({ type: "response.output_audio.started" });
  event({ type: "response.output_audio.delta", delta: "AAAA".repeat(3200) });
  event({ type: "input_audio_buffer.speech_started" });
  await settle();
  check(
    writes.filter((item) => item.type === "response.cancel").length ===
      beforeInterrupts + 1 && Number(playback) === 0,
    "saturated playback blocked incoming ASR interruption",
  );
  fullQueueChecks = 0;
  event({ type: "response.canceled" });
  await settle();
  voice.mute(true);
  await settle();
  check(
    voice.snapshot().muted &&
      writes.some((item) => item.type === "input_audio_mute.commit"),
    "mute not propagated",
  );
  const tool = {
    type: "response.function_call_arguments.done",
    call_id: "voice_task_1",
    name: "run_agent_task",
    arguments: JSON.stringify({ prompt: "打开演示灯" }),
  };
  event(tool);
  event(tool);
  await settle();
  check(taskCalls === 1, "duplicate voice call executed twice");
  voice.stop();
  finishTask("late result");
  await settle();
  check(
    !writes.some((item) => item.type === "conversation.item.create"),
    "closed voice replayed a late task result",
  );
  check(
    socketClosed && state === "idle" && stops > 0,
    "stop retained native session",
  );
  voice.close();

  // Close while connect is still unresolved: a late socket must be disposed.
  let finishConnect!: (socket: VoiceSocket) => void,
    lateClosed = false;
  const late = new VoiceRuntime({
    vault,
    audio,
    connect: () =>
      new Promise((resolve) => {
        finishConnect = resolve;
      }),
    onState: () => {},
    requestTask: async () => "",
    cancelTask: () => {},
  });
  const opening = late.start();
  late.stop();
  finishConnect({
    read: async () => null,
    write: async () => {},
    close: async () => {
      lateClosed = true;
    },
  });
  await opening;
  await settle();
  check(
    lateClosed && late.snapshot().phase === "idle",
    "late handshake revived closed session",
  );
  late.close();

  const corrupt = new VoiceRuntime({
    vault: { ...vault, get: () => "broken" },
    audio,
    connect: async () => socket,
    onState: () => {},
    requestTask: async () => "",
    cancelTask: () => {},
  });
  check(
    !corrupt.configuration().hasKey && corrupt.snapshot().phase === "error",
    "corrupt voice config did not remain repairable",
  );
  corrupt.configure("TEST_ONLY_VOICE");
  corrupt.close();

  for (const operation of ["mute", "interrupt"] as const) {
    let rejectOld!: (error: Error) => void;
    let connections = 0;
    const reconnect = new VoiceRuntime({
      vault,
      audio,
      onState: () => {},
      requestTask: async () => "",
      cancelTask: () => {},
      connect: async () => {
        const first = connections++ === 0;
        let ready = false,
          readDone: ((value: null) => void) | undefined;
        return {
          read: async () => {
            if (!ready) {
              ready = true;
              return JSON.stringify({ type: "session.created" });
            }
            return new Promise<null>((resolve) => {
              readDone = resolve;
            });
          },
          write: async (raw: string) => {
            const type = JSON.parse(raw).type;
            if (
              first &&
              (type === "input_audio_mute.commit" || type === "response.cancel")
            )
              await new Promise<void>((_, reject) => {
                rejectOld = reject;
              });
          },
          close: async () => {
            readDone?.(null);
          },
        };
      },
    });
    await reconnect.start();
    await settle();
    if (operation === "mute") reconnect.mute(true);
    else {
      audio.enqueue(new Uint8Array(4), 24000);
      reconnect.interrupt();
    }
    await settle();
    reconnect.stop();
    await reconnect.start();
    await settle();
    rejectOld(new Error("late old write failure"));
    await settle();
    check(
      reconnect.snapshot().phase === "listening",
      "old control-write rejection stopped a new voice session",
    );
    reconnect.close();
  }
}
