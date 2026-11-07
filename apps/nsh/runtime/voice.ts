import { Buffer } from "node:buffer";
import type { Vault } from "./application.js";

export interface VoiceAudioPort {
  requestPermission(): string;
  start(capture: boolean): void;
  stop(): void;
  enqueue(pcm: Uint8Array, rate: number): void;
  clearPlayback(): void;
  setMuted(muted: boolean): void;
  drainCapture(): Array<{
    pcm: Uint8Array;
    timestampMs: number;
    sampleRate: number;
  }>;
  status(): {
    state: string;
    permission: string;
    error: string;
    queuedPlaybackMs: number;
  };
}
export interface VoiceSocket {
  read(): Promise<string | Uint8Array | null>;
  write(value: string): Promise<void>;
  close(): Promise<void>;
}
export interface VoiceState {
  phase:
    | "idle"
    | "permission"
    | "connecting"
    | "listening"
    | "speaking"
    | "error";
  muted: boolean;
  transcript: string;
  error: string;
}
const endpoint =
  "wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue";

function pcm16Rms(pcm: Uint8Array): number {
  const samples = Math.floor(pcm.byteLength / 2);
  if (samples <= 0) return 0;
  const view = new DataView(pcm.buffer, pcm.byteOffset, samples * 2);
  let sumSq = 0;
  for (let i = 0; i < samples; i++) {
    const sample = view.getInt16(i * 2, true) / 32768;
    sumSq += sample * sample;
  }
  return Math.min(1, Math.sqrt(sumSq / samples) * 3.2);
}

/** One explicit foreground voice session. No reconnect or tool replay. Audio
 * queues and call identities are bounded; native lifecycle stops independently. */
export class VoiceRuntime {
  private state: VoiceState = {
    phase: "idle",
    muted: false,
    transcript: "",
    error: "",
  };
  private generation = 0;
  private socket?: VoiceSocket;
  private timer?: ReturnType<typeof setTimeout>;
  private deadline?: ReturnType<typeof setTimeout>;
  private calls = new Set<string>();
  private writes = 0;
  private writeQueue: Promise<void> = Promise.resolve();
  private audioWriting = false;
  private discardOutput = false;
  private responseId = "";
  private cancelledResponses = new Set<string>();
  private frames: Uint8Array[] = [];
  private outputFrames: Uint8Array[] = [];
  private outputBytes = 0;
  private key = "";
  private closed = false;
  constructor(
    private readonly options: {
      vault: Vault;
      audio: VoiceAudioPort;
      connect: (
        url: string,
        options: { headers: Record<string, string> },
      ) => Promise<VoiceSocket>;
      onState: (state: VoiceState) => void;
      onAudioLevel?: (level: number) => void;
      requestTask: (prompt: string) => Promise<string>;
      cancelTask: () => void;
    },
  ) {
    try {
      const saved = options.vault.get("voice");
      if (saved) this.key = this.validate(JSON.parse(saved).apiKey);
    } catch {
      this.state = {
        ...this.state,
        phase: "error",
        error: "语音凭据不可用，请重新配置",
      };
    }
  }
  configuration() {
    return { hasKey: Boolean(this.key) };
  }
  private validate(value: unknown): string {
    if (
      typeof value !== "string" ||
      !value.trim() ||
      value.length > 8192 ||
      /[\r\n]/.test(value)
    )
      throw new Error("请填写有效的语音 API Key");
    return value.trim();
  }
  configure(value: string): void {
    if (this.closed) throw new Error("语音已关闭");
    const next = this.validate(value);
    this.stop();
    this.options.vault.set("voice", JSON.stringify({ apiKey: next }));
    this.key = next;
  }
  snapshot(): VoiceState {
    return { ...this.state };
  }
  private publish(patch: Partial<VoiceState>) {
    this.state = { ...this.state, ...patch };
    this.options.onState(this.snapshot());
  }
  private current(generation: number) {
    return !this.closed && generation === this.generation;
  }
  async start(): Promise<void> {
    if (this.closed) throw new Error("语音已关闭");
    if (!["idle", "error", "permission"].includes(this.state.phase)) return;
    if (!this.key) throw new Error("请先配置豆包语音 API Key");
    this.stop();
    if (this.options.audio.status().permission !== "granted") {
      const permission = this.options.audio.requestPermission();
      if (permission !== "granted") {
        this.publish({
          phase: "permission",
          error: "请允许麦克风权限，然后再次点 LIVE；拒绝后可到系统设置开启。",
        });
        return;
      }
    }
    const generation = this.generation;
    this.publish({ phase: "connecting", error: "", transcript: "" });
    this.deadline = setTimeout(() => {
      if (this.current(generation)) this.fail("语音连接超时，请重试");
    }, 15000);
    try {
      const socket = await this.options.connect(endpoint, {
        headers: { "X-Api-Key": this.key },
      });
      if (!this.current(generation)) {
        void socket.close().catch(() => {});
        return;
      }
      this.socket = socket;
      await this.send(
        {
          type: "session.create",
          session: {
            model: "1.2.6.1",
            instructions:
              "你是 LOOI，用简短自然的中文回答，不念括号舞台提示。需要执行本机任务时使用 run_agent_task，由本机 Agent 执行；没有实际工具回执不得声称成功。不自动重试未知结果。",
            tools: [
              {
                type: "function",
                name: "run_agent_task",
                description:
                  "提交本机任务由 Agent 执行（写入或命令需用户在手机单次审批）；只根据返回结果回答。",
                parameters: {
                  type: "object",
                  properties: { prompt: { type: "string" } },
                  required: ["prompt"],
                  additionalProperties: false,
                },
              },
            ],
            audio: {
              input: { format: { type: "pcm", rate: 16000 } },
              output: {
                format: { type: "pcm_s16le", rate: 24000 },
                voice: "zh_female_vv_jupiter_bigtts",
              },
            },
          },
          extension: {
            tts: { extra: { max_length_to_filter_parenthesis: 100 } },
            asr: {
              extra: { end_smooth_window_ms: 2500, enable_custom_vad: true },
            },
          },
        },
        generation,
      );
      void this.read(socket, generation);
    } catch {
      if (this.current(generation))
        this.fail("语音连接失败，请检查 Key、服务权限或网络");
    }
  }
  private async send(
    value: unknown,
    generation = this.generation,
  ): Promise<void> {
    if (!this.current(generation) || !this.socket)
      throw new Error("语音连接已关闭");
    if (this.writes >= 8) throw new Error("语音发送积压");
    const socket = this.socket,
      raw = JSON.stringify(value);
    if (raw.length > 65536) throw new Error("语音消息过长");
    this.writes++;
    const pending = this.writeQueue.then(async () => {
      if (!this.current(generation) || this.socket !== socket)
        throw new Error("语音连接已关闭");
      await socket.write(raw);
    });
    this.writeQueue = pending.catch(() => {});
    try {
      await pending;
    } finally {
      if (this.current(generation)) this.writes--;
    }
  }
  private async read(socket: VoiceSocket, generation: number) {
    try {
      while (this.current(generation)) {
        const raw = await socket.read();
        if (!this.current(generation)) return;
        if (raw === null) {
          this.fail("语音连接已结束，请重新开启");
          return;
        }
        if (typeof raw !== "string" || raw.length > 1_000_000)
          throw new Error("Unsupported voice frame");
        const event = JSON.parse(raw);
        if (!event || typeof event !== "object")
          throw new Error("Invalid voice frame");
        const responseId = String(
          event.response_id ?? event.response?.id ?? "",
        );
        const cancelAck =
          event.type === "response.canceled" ||
          event.type === "response.cancelled" ||
          (event.type === "response.done" &&
            event.response?.status === "cancelled");
        if (this.discardOutput && cancelAck) {
          if (this.deadline) clearTimeout(this.deadline);
          this.deadline = undefined;
          this.discardOutput = false;
          this.responseId = "";
          continue;
        }
        if (String(event.type).startsWith("response.")) {
          if (
            this.discardOutput ||
            (responseId && this.cancelledResponses.has(responseId))
          )
            continue;
          if (responseId) this.responseId = responseId;
        }
        if (event.type === "session.created") {
          if (this.state.phase !== "connecting") continue;
          if (this.deadline) clearTimeout(this.deadline);
          this.deadline = undefined;
          this.options.audio.start(true);
          this.publish({ phase: "listening" });
          this.tick(generation);
        } else if (event.type === "response.output_audio.started") {
          this.publish({ phase: "speaking" });
        } else if (
          event.type === "response.output_audio.delta" &&
          !this.discardOutput
        ) {
          if (
            typeof event.delta !== "string" ||
            event.delta.length > 320000 ||
            !/^[A-Za-z0-9+/]*={0,2}$/.test(event.delta)
          )
            throw new Error("Invalid PCM");
          const pcm = Buffer.from(event.delta, "base64");
          if (pcm.length % 2) throw new Error("Invalid PCM length");
          // Keep control events responsive even while native playback is full.
          // At most 30 seconds of mono PCM waits here, plus the native 4.5s.
          if (
            this.outputBytes + pcm.length > 1_440_000 ||
            this.outputFrames.length + Math.ceil(pcm.length / 4800) > 300
          ) {
            this.interrupt();
            this.publish({
              error: "回复较长，已停止朗读；可以缩短问题后重新提问。",
            });
            continue;
          }
          for (let offset = 0; offset < pcm.length; offset += 4800)
            this.outputFrames.push(pcm.subarray(offset, offset + 4800));
          this.outputBytes += pcm.length;
        } else if (event.type === "response.output_audio.done")
          this.publish({ phase: "listening" });
        else if (event.type === "response.output_text.delta")
          this.publish({
            transcript: (
              this.state.transcript + String(event.delta ?? "")
            ).slice(-4096),
          });
        else if (event.type === "response.output_text.done")
          this.publish({
            transcript: String(event.text ?? this.state.transcript).slice(
              -4096,
            ),
          });
        else if (String(event.type).includes("speech_started"))
          this.interrupt();
        else if (event.type === "response.function_call_arguments.done") {
          for (const item of Array.isArray(event.items)
            ? event.items.slice(0, 8)
            : [event])
            this.tool(item, generation);
        } else if (event.type === "error" || event.type === "session.error")
          throw new Error("Provider error");
      }
    } catch {
      if (this.current(generation))
        this.fail("语音已停止，请检查网络或音频设备后重试");
    }
  }
  private tick(generation: number) {
    if (!this.current(generation)) return;
    try {
      if (this.options.audio.status().state !== "running")
        throw new Error("Native audio interrupted");
      let peakLevel = 0;
      for (let count = 0; count < 5 && this.outputFrames.length; count++) {
        const frame = this.outputFrames[0];
        if (
          this.options.audio.status().queuedPlaybackMs + frame.length / 48 >
          4500
        )
          break;
        this.outputFrames.shift();
        this.outputBytes -= frame.length;
        peakLevel = Math.max(peakLevel, pcm16Rms(frame));
        this.options.audio.enqueue(frame, 24000);
      }
      for (const packet of this.options.audio.drainCapture()) {
        if (packet.sampleRate !== 16000 || packet.pcm.length !== 640)
          throw new Error("Invalid capture frame");
        if (!this.state.muted)
          peakLevel = Math.max(peakLevel, pcm16Rms(packet.pcm));
        this.frames.push(packet.pcm);
      }
      this.options.onAudioLevel?.(peakLevel);
      if (this.frames.length > 25)
        this.frames.splice(0, this.frames.length - 25);
      if (!this.state.muted && !this.audioWriting) {
        this.audioWriting = true;
        void this.send(
          {
            type: "input_audio_buffer.append",
            audio: Buffer.from(
              this.frames.shift() ?? new Uint8Array(640),
            ).toString("base64"),
          },
          generation,
        )
          .catch(() => {
            if (this.current(generation)) this.fail("语音网络发送失败");
          })
          .finally(() => {
            if (this.current(generation)) this.audioWriting = false;
          });
      }
      this.timer = setTimeout(() => this.tick(generation), 20);
    } catch {
      this.fail("音频被系统中断，请再次点 LIVE 开启");
    }
  }
  private tool(item: Record<string, unknown>, generation: number) {
    const id = typeof item.call_id === "string" ? item.call_id : "";
    if (!id || id.length > 256 || this.calls.has(id)) return;
    if (this.calls.size >= 128) {
      this.fail("本次语音任务较多，请重新开启");
      return;
    }
    this.calls.add(id);
    void (async () => {
      let output: unknown;
      try {
        if (
          item.name !== "run_agent_task" ||
          typeof item.arguments !== "string" ||
          item.arguments.length > 8192
        )
          throw new Error();
        const args = JSON.parse(item.arguments);
        if (
          typeof args.prompt !== "string" ||
          !args.prompt.trim() ||
          args.prompt.length > 4000
        )
          throw new Error();
        output = { answer: await this.options.requestTask(args.prompt) };
      } catch {
        output = { error: "任务未获确认或未完成，不得声称成功。" };
      }
      if (!this.current(generation)) return;
      await this.send(
        {
          type: "conversation.item.create",
          items: [
            {
              call_id: id,
              role: "tool",
              content: [{ type: "input_text", text: JSON.stringify(output) }],
            },
          ],
        },
        generation,
      );
    })().catch(() => {
      if (this.current(generation)) this.fail("语音任务回传失败");
    });
  }
  mute(value: boolean) {
    if (!["listening", "speaking"].includes(this.state.phase)) return;
    this.options.audio.setMuted(value);
    this.frames = [];
    this.publish({ muted: value });
    const generation = this.generation;
    void this.send(
      { type: value ? "input_audio_mute.commit" : "input_audio_unmute.commit" },
      generation,
    ).catch(() => {
      if (this.current(generation)) this.fail("语音静音状态同步失败");
    });
  }
  interrupt() {
    if (!["listening", "speaking"].includes(this.state.phase)) return;
    if (this.discardOutput) return;
    if (
      this.state.phase !== "speaking" &&
      this.options.audio.status().queuedPlaybackMs <= 0 &&
      this.outputBytes === 0
    ) {
      this.publish({ transcript: "" });
      return;
    }
    this.discardOutput = true;
    if (this.responseId) this.cancelledResponses.add(this.responseId);
    if (this.cancelledResponses.size > 128) {
      this.fail("请重新开启语音");
      return;
    }
    this.outputFrames = [];
    this.outputBytes = 0;
    this.options.audio.clearPlayback();
    this.options.onAudioLevel?.(0);
    this.publish({ phase: "listening", transcript: "" });
    const generation = this.generation;
    // No-ID frames are unsafe until the peer acknowledges cancellation. If
    // this protocol variant lacks an ack, close instead of replaying old speech.
    this.deadline = setTimeout(() => {
      if (this.current(generation)) this.fail("语音已打断，请再次开启继续");
    }, 4000);
    void this.send({ type: "response.cancel" }, generation).catch(() => {
      if (this.current(generation)) this.fail("语音中断同步失败");
    });
  }
  private fail(message: string) {
    this.stop();
    this.publish({ phase: "error", error: message });
  }
  stop() {
    ++this.generation;
    if (this.timer) clearTimeout(this.timer);
    if (this.deadline) clearTimeout(this.deadline);
    this.timer = this.deadline = undefined;
    const socket = this.socket;
    this.socket = undefined;
    this.options.audio.stop();
    this.options.onAudioLevel?.(0);
    this.frames = [];
    this.outputFrames = [];
    this.outputBytes = 0;
    this.calls.clear();
    this.audioWriting = false;
    this.discardOutput = false;
    this.responseId = "";
    this.cancelledResponses.clear();
    this.writes = 0;
    this.writeQueue = Promise.resolve();
    this.options.cancelTask();
    if (socket) void socket.close().catch(() => {});
    this.publish({ phase: "idle", muted: false, error: "" });
  }
  close() {
    this.stop();
    this.closed = true;
  }
}
