import { Buffer } from "node:buffer";
import { voicePrompts } from "./prompts.js";
import { sessionCreateMessage, voiceEndpoint } from "./protocol.js";
import type { VoiceRuntimeOptions, VoiceSocket, VoiceState } from "./types.js";

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
    wakeEnabled: false,
    transcript: "",
    error: "",
  };
  private generation = 0;
  private socket?: VoiceSocket;
  private timer?: ReturnType<typeof setTimeout>;
  private deadline?: ReturnType<typeof setTimeout>;
  private standbyTimer?: ReturnType<typeof setTimeout>;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private awaitingTimer?: ReturnType<typeof setTimeout>;
  private farewellTimer?: ReturnType<typeof setTimeout>;
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
  private turnActivity: "waiting_user" | "user_speaking" | "awaiting_reply" = "waiting_user";
  private outputStreamDone = false;
  private closingAfterFarewell = false;
  private farewellStreamDone = false;
  private farewellToolSent = false;
  private farewellOriginResponseId = "";
  private farewellResponseStarted = false;
  private toolRuns = 0;
  constructor(private readonly options: VoiceRuntimeOptions) {
    try {
      const saved = options.vault.get("voice");
      if (saved) {
        const config = JSON.parse(saved);
        this.key = this.validate(config.apiKey);
        this.state.wakeEnabled = config.wakeEnabled === true;
      }
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
    this.options.vault.set("voice", JSON.stringify({ apiKey: next, wakeEnabled: this.state.wakeEnabled }));
    this.key = next;
    if (this.state.wakeEnabled) void this.enterStandby();
  }
  setWakeEnabled(enabled: boolean): void {
    if (this.closed) return;
    if (enabled && !this.key) throw new Error("请先配置豆包语音 API Key");
    this.options.vault.set("voice", JSON.stringify({ apiKey: this.key, wakeEnabled: enabled }));
    this.publish({ wakeEnabled: enabled });
    if (enabled && ["idle", "error", "permission"].includes(this.state.phase))
      void this.enterStandby();
    if (!enabled && this.state.phase === "standby") this.stop();
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
  async enterStandby(): Promise<void> {
    if (this.closed || !this.key || !this.state.wakeEnabled) return;
    if (this.state.phase === "standby") return;
    const permission = this.options.audio.status().permission;
    if (permission !== "granted") {
      const result = ["undetermined", "cancelled"].includes(permission) && this.state.phase !== "permission"
        ? this.options.audio.requestPermission()
        : permission;
      if (result !== "granted") {
        if (result !== "undetermined") {
          this.options.audio.stop();
          this.publish({ phase: "error", error: result === "cancelled"
            ? "麦克风权限请求已取消，请重新开启语音唤醒"
            : "麦克风权限不可用，请在系统设置中开启" });
          return;
        }
        this.publish({ phase: "permission", error: "请允许麦克风权限" });
        if (result === "undetermined") {
          const generation = this.generation;
          this.standbyTimer = setTimeout(() => {
            if (this.current(generation) && this.state.wakeEnabled) void this.enterStandby();
          }, 250);
        }
        return;
      }
    }
    try {
      this.options.audio.setCaptureMode("kws");
      const status = this.options.audio.status();
      if (status.state !== "running" || status.captureMode !== "kws" || !status.kwsReady)
        throw new Error(status.error || "本地语音唤醒引擎未就绪");
      this.publish({ phase: "standby", muted: false, error: "" });
      this.pollStandby(this.generation);
    } catch (error) {
      this.options.audio.stop();
      this.publish({ phase: "error", error: error instanceof Error ? error.message : String(error) });
    }
  }
  private pollStandby(generation: number): void {
    if (!this.current(generation) || this.state.phase !== "standby") return;
    const status = this.options.audio.status();
    if (status.state !== "running" || status.captureMode !== "kws" || !status.kwsReady) {
      this.fail(status.error || "本地语音唤醒引擎未就绪");
      return;
    }
    if (status.wakeWord) {
      void this.start({ fromWakeWord: true });
      return;
    }
    this.standbyTimer = setTimeout(() => this.pollStandby(generation), 60);
  }
  async start(options: { fromWakeWord?: boolean } = {}): Promise<void> {
    if (this.closed) throw new Error("语音已关闭");
    if (!["idle", "standby", "error", "permission"].includes(this.state.phase)) return;
    if (!this.key) throw new Error("请先配置豆包语音 API Key");
    const fromStandby = this.state.phase === "standby";
    if (this.standbyTimer) clearTimeout(this.standbyTimer);
    this.standbyTimer = undefined;
    if (!fromStandby) this.stop();
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
      const socket = await this.options.connect(voiceEndpoint, {
        headers: { "X-Api-Key": this.key },
      });
      if (!this.current(generation)) {
        void socket.close().catch(() => {});
        return;
      }
      this.socket = socket;
      await this.send(sessionCreateMessage, generation);
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
          this.options.audio.setCaptureMode("conversation");
          this.options.audio.playReadyCue();
          this.turnActivity = "waiting_user";
          this.publish({ phase: "listening", muted: false });
          this.startIdleTimer(generation);
          this.tick(generation);
        } else if (event.type === "response.output_audio.started") {
          this.pauseIdleTimer();
          this.outputStreamDone = false;
          if (this.closingAfterFarewell && this.farewellToolSent && (!responseId || responseId !== this.farewellOriginResponseId))
            this.farewellResponseStarted = true;
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
        } else if (event.type === "response.output_audio.done") {
          this.outputStreamDone = true;
          if (this.closingAfterFarewell && this.farewellToolSent && this.farewellResponseStarted)
            this.farewellStreamDone = true;
        }
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
        else if (event.type === "conversation.item.input_audio_transcription.started" || event.type === "conversation.item.input_audio_transcription.delta" || event.type === "input_audio_buffer.speech_started") {
          this.turnActivity = "user_speaking";
          this.pauseIdleTimer();
          if (this.state.phase === "speaking" || this.outputFrames.length || this.responseId)
            this.interrupt();
        } else if (event.type === "input_audio_buffer.committed" || event.type === "conversation.item.input_audio_transcription.completed" || event.type === "input_audio_buffer.speech_stopped") {
          this.turnActivity = "awaiting_reply";
          this.pauseIdleTimer();
          this.startAwaitingTimer(generation);
        } else if (event.type === "conversation.item.input_audio_transcription.failed" || event.type === "response.done") {
          if (this.closingAfterFarewell && event.type === "response.done" && this.farewellToolSent && (this.farewellResponseStarted || (responseId && responseId !== this.farewellOriginResponseId))) this.farewellStreamDone = true;
          else if (this.state.phase !== "speaking" && this.toolRuns === 0) this.resumeWaiting(generation);
        }
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
      const drained = this.outputFrames.length === 0 && this.options.audio.status().queuedPlaybackMs <= 0;
      if (this.closingAfterFarewell && this.farewellStreamDone && drained) {
        this.endSession();
        return;
      }
      if (!this.closingAfterFarewell && this.state.phase === "speaking" && this.outputStreamDone && drained) {
        this.outputStreamDone = false;
        this.responseId = "";
        this.publish({ phase: "listening" });
        this.resumeWaiting(generation);
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
    if (item.name === "end_conversation") {
      this.closingAfterFarewell = true;
      this.farewellStreamDone = false;
      this.farewellToolSent = false;
      this.farewellResponseStarted = false;
      this.farewellOriginResponseId = this.responseId;
      this.outputStreamDone = false;
      this.pauseIdleTimer();
      this.farewellTimer = setTimeout(() => {
        if (this.current(generation)) this.endSession();
      }, 5000);
      void this.send({
        type: "conversation.item.create",
        items: [{ call_id: id, role: "tool", content: [{ type: "input_text", text: JSON.stringify({ status: "ending", instruction: voicePrompts.farewell }) }] }],
      }, generation).then(() => {
        if (this.current(generation)) this.farewellToolSent = true;
      }).catch(() => {
        if (this.current(generation)) this.fail("道别回传失败");
      });
      return;
    }
    this.toolRuns++;
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
        output = { error: voicePrompts.taskFailed };
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
      this.toolRuns--;
      if (this.turnActivity === "awaiting_reply") this.startAwaitingTimer(generation);
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
    if (this.state.wakeEnabled && this.state.phase !== "standby" && this.options.audio.status().state === "running") {
      this.endSession();
      this.publish({ error: message });
      return;
    }
    this.stop();
    this.publish({ phase: "error", error: message });
  }
  private pauseIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.awaitingTimer) clearTimeout(this.awaitingTimer);
    this.idleTimer = this.awaitingTimer = undefined;
  }
  private startIdleTimer(generation: number) {
    this.pauseIdleTimer();
    this.idleTimer = setTimeout(() => {
      if (this.current(generation) && this.turnActivity === "waiting_user" && this.toolRuns === 0)
        this.endSession();
    }, 12000);
  }
  private startAwaitingTimer(generation: number) {
    if (this.awaitingTimer) clearTimeout(this.awaitingTimer);
    this.awaitingTimer = setTimeout(() => {
      if (this.current(generation) && this.turnActivity === "awaiting_reply" && this.toolRuns === 0 && this.state.phase === "listening")
        this.resumeWaiting(generation);
    }, 12000);
  }
  private resumeWaiting(generation: number) {
    this.turnActivity = "waiting_user";
    this.startIdleTimer(generation);
  }
  endSession() {
    const socket = this.socket;
    const pendingWrites = this.writeQueue;
    this.socket = undefined;
    ++this.generation;
    this.clearTimers();
    this.frames = [];
    this.outputFrames = [];
    this.outputBytes = 0;
    this.calls.clear();
    this.toolRuns = 0;
    this.audioWriting = false;
    this.discardOutput = false;
    this.responseId = "";
    this.cancelledResponses.clear();
    this.writes = 0;
    this.writeQueue = Promise.resolve();
    this.closingAfterFarewell = this.farewellStreamDone = this.outputStreamDone = false;
    this.farewellToolSent = this.farewellResponseStarted = false;
    this.farewellOriginResponseId = "";
    this.options.audio.clearPlayback();
    this.options.onAudioLevel?.(0);
    this.options.cancelTask();
    if (socket) {
      void pendingWrites
        .then(() => socket.write(JSON.stringify({ type: "session.close" })))
        .catch(() => {})
        .finally(() => void socket.close().catch(() => {}));
    }
    if (this.state.wakeEnabled && !this.closed) void this.enterStandby();
    else this.stop();
  }
  private clearTimers() {
    for (const timer of [this.timer, this.deadline, this.standbyTimer, this.idleTimer, this.awaitingTimer, this.farewellTimer])
      if (timer) clearTimeout(timer);
    this.timer = this.deadline = this.standbyTimer = this.idleTimer = this.awaitingTimer = this.farewellTimer = undefined;
  }
  stop() {
    ++this.generation;
    this.clearTimers();
    const socket = this.socket;
    this.socket = undefined;
    this.options.audio.stop();
    this.options.onAudioLevel?.(0);
    this.frames = [];
    this.outputFrames = [];
    this.outputBytes = 0;
    this.calls.clear();
    this.toolRuns = 0;
    this.closingAfterFarewell = this.farewellStreamDone = this.outputStreamDone = false;
    this.farewellToolSent = this.farewellResponseStarted = false;
    this.farewellOriginResponseId = "";
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
    this.closed = true;
    this.stop();
  }
}
