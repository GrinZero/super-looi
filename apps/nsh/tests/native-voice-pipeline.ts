import {
  VoiceRuntime,
  type VoiceAudioPort,
  type VoiceSocket,
} from "../runtime/voice.js";
import type { MobileRuntime } from "../runtime/application.js";

/** Live network acceptance with prerecorded synthetic speech, never a mic. */
export async function verifyVoicePipeline(options: {
  runtime: MobileRuntime;
  audio: VoiceAudioPort;
  connect: (
    url: string,
    options: { headers: Record<string, string> },
  ) => Promise<VoiceSocket>;
  pcm: Uint8Array;
  voiceKey: string;
}) {
  let position = 0,
    calls = 0,
    outputBytes = 0,
    afterTaskBytes = 0,
    taskDone = false;
  let transcript = "",
    failure = "",
    asr = false,
    taskFailure = "";
  const action = () => {
    const now = Date.now();
    return {
      event_id: `voice_fixture_${now}`,
      ui_session_id: options.runtime.uiSessionId,
      kind: "tap" as const,
      captured_at: new Date(now).toISOString(),
      expires_at: new Date(now + 10000).toISOString(),
    };
  };
  const note = `软件验收码${Date.now()}是纸鸢`;
  await options.runtime.run(`请记住并在后续对话中直接回答：${note}（无需调用工具，直接回复“已记住”）`, action(), () => {});
  const audio: VoiceAudioPort = {
    beginWake: () => 0, startWake: async () => { audio.setCaptureMode("kws"); return true; },
    requestPermission: () => "granted", // Synthetic-input adapter; no OS permission request.
    status: () => ({ ...options.audio.status(), permission: "granted", captureMode: "conversation", wakeWord: "", kwsReady: false }),
    start: () => options.audio.start(false),
    setCaptureMode: () => options.audio.start(false),
    playReadyCue: () => {},
    stop: () => options.audio.stop(),
    enqueue: (pcm, rate) => {
      outputBytes += pcm.length;
      if (taskDone) afterTaskBytes += pcm.length;
      options.audio.enqueue(pcm, rate);
    },
    clearPlayback: () => options.audio.clearPlayback(),
    setMuted: (value) => options.audio.setMuted(value),
    drainCapture: () => {
      if (position >= options.pcm.length) return [];
      const pcm = new Uint8Array(640);
      pcm.set(options.pcm.subarray(position, position + 640));
      const timestampMs = position / 32;
      position += 640;
      return [{ pcm, timestampMs, sampleRate: 16000 }];
    },
  };
  const voice = new VoiceRuntime({
    audio,
    vault: {
      get: (key) =>
        key === "voice" ? JSON.stringify({ apiKey: options.voiceKey }) : "",
      set: () => {},
      remove: () => {},
    },
    connect: async (url, settings) => {
      const socket = await options.connect(url, settings);
      return {
        write: (value) => socket.write(value),
        close: () => socket.close(),
        read: async () => {
          const raw = await socket.read();
          if (typeof raw === "string") {
            const event = JSON.parse(raw);
            if (
              String(event.type).includes("transcription") &&
              /completed|done/.test(event.type)
            )
              asr = true;
          }
          return raw;
        },
      };
    },
    onState: (state) => {
      transcript = state.transcript;
      if (state.phase === "error") failure = state.error;
    },
    requestTask: async (prompt) => {
      try {
        calls++;
        if (calls !== 1 || !/记忆|回忆|验收码/.test(prompt))
          throw new Error("Unexpected voice task");
        const result = await options.runtime.run(
          prompt,
          action(),
          (event) => {
            // A live test may only read the test note; never authorize model writes.
            if (event.interaction?.kind === "approval" && event.taskId)
              options.runtime.respond(event.taskId, event.interaction.id, {
                outcome: "rejected",
              });
          },
          { agentOnly: true },
        );
        if (
          !result.runtimeExited ||
          !result.taskId ||
          !result.answer.includes("纸鸢")
        )
          throw new Error("Voice task did not read saved evidence");
        taskDone = true;
        return result.answer;
      } catch (error) {
        taskFailure = error instanceof Error ? error.message : "task failed";
        throw error;
      }
    },
    cancelTask: () => {
      void options.runtime.cancel();
    },
  });
  try {
    await voice.start();
    const deadline = Date.now() + 90000;
    while (
      Date.now() < deadline &&
      !failure &&
      !(taskDone && afterTaskBytes > 0 && transcript.includes("纸鸢"))
    )
      await new Promise((resolve) => setTimeout(resolve, 100));
    if (
      failure ||
      !asr ||
      !taskDone ||
      !afterTaskBytes ||
      !transcript.includes("纸鸢")
    )
      throw new Error(
        `Voice pipeline incomplete: asr=${asr},calls=${calls},task=${taskDone},pcm=${outputBytes},reply=${afterTaskBytes},phase=${voice.snapshot().phase},taskFailure=${taskFailure},failure=${failure}`,
      );
    return {
      asr,
      calls,
      taskDone,
      outputBytes,
      afterTaskBytes,
      syntheticInputBytes: options.pcm.length,
    };
  } finally {
    voice.close();
    await options.runtime.cancel();
    options.runtime.newConversation(action());
  }
}
