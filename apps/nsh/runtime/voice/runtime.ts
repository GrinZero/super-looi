import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { createVoiceProtocol, type RealtimeProtocolAdapter } from "./protocol.js";
import { createVoiceTools, type VoiceTools } from "./tools/index.js";
import type { VoiceRuntimeOptions, VoiceSocket, VoiceState } from "./types.js";
import { observeVoiceSocket } from "../../../../packages/looi-runtime/src/telemetry/realtime-observer.js";

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
  private readonly tools: VoiceTools;
  private readonly protocol: RealtimeProtocolAdapter;
  private writes = 0;
  private writeQueue: Promise<void> = Promise.resolve();
  private audioWriting = false;
  private discardOutput = false;
  private responseId = "";
  private cancelledResponses = new Set<string>();
  private frames: Uint8Array[] = [];
  private outputFrames: Array<{ pcm: Uint8Array; itemId?: string; contentIndex?: number }> = [];
  private playback: Array<{ itemId?: string; contentIndex?: number; durationMs: number }> = [];
  private playedByItem = new Map<string, number>();
  private currentAudioItem?: { itemId: string; contentIndex: number };
  private outputBytes = 0;
  private apiKeys: Record<string, string> = {};
  private voiceId = "";
  private responseInProgress = false;
  private cancelEventId = "";
  private exitAfterPlayback = false;
  private audioStartedResponseId = "";
  private closed = false;
  private turnActivity: "waiting_user" | "user_speaking" | "awaiting_reply" = "waiting_user";
  private outputStreamDone = false;
  constructor(private readonly options: VoiceRuntimeOptions) {
    this.protocol = options.protocol ?? createVoiceProtocol({ providerId: process.env.VOICE_PROVIDER, baseUrl: process.env.VOICE_BASE_URL, model: process.env.VOICE_MODEL });
    this.tools = createVoiceTools({
      send: (value, generation) => this.send(value, generation),
      current: (generation) => this.current(generation),
      requestTask: options.requestTask,
      toolTraceContext: (callId) => this.socket?.getToolTraceContext?.(callId),
      beginFarewell: () => {
        this.outputStreamDone = false;
        this.pauseIdleTimer();
      },
      endSession: () => this.endSession(),
      taskFinished: (generation) => {
        if (this.turnActivity === "awaiting_reply") this.startAwaitingTimer(generation);
      },
      fail: (message) => this.fail(message),
    }, this.protocol);
    try {
      const saved = options.vault.get("voice");
      if (saved) {
        const config = JSON.parse(saved);
        if (config.apiKeys && typeof config.apiKeys === "object") this.apiKeys = { ...config.apiKeys };
        if (typeof config.apiKey === "string" && config.apiKey.trim()) this.apiKeys.doubao ??= config.apiKey.trim();
        if (typeof config.voiceId === "string") this.voiceId = config.voiceId.trim();
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
  configuration(): { hasKey: boolean; providerId: string; providerLabel: string; voiceId: string } {
    return { hasKey: Boolean(this.resolveApiKey()), providerId: this.protocol.providerId, providerLabel: this.protocol.providerId === "doubao" ? "豆包" : this.protocol.providerId === "openai" ? "OpenAI" : this.protocol.providerId, voiceId: this.protocol.providerId === "doubao" ? this.voiceId : "" };
  }
  private resolveApiKey(): string {
    const own = this.apiKeys[this.protocol.providerId];
    if (own) return own;
    if (this.protocol.providerId === "doubao") return "";
    try {
      const model = JSON.parse(this.options.vault.get("model") || "{}");
      const credential = model.credentials?.[this.protocol.providerId];
      return credential?.type === "api_key" && typeof credential.key === "string" ? credential.key : "";
    } catch { return ""; }
  }
  private saveVault(): void {
    this.options.vault.set("voice", JSON.stringify({
      ...(this.apiKeys.doubao ? { apiKey: this.apiKeys.doubao } : {}),
      apiKeys: this.apiKeys, wakeEnabled: this.state.wakeEnabled,
      ...(this.voiceId ? { voiceId: this.voiceId } : {}),
    }));
  }
  refreshCredentials(): { hasKey: boolean; providerId: string; providerLabel: string; voiceId: string } {
    const configuration = this.configuration();
    if (!configuration.hasKey && !["idle", "error"].includes(this.state.phase)) this.stop();
    else if (configuration.hasKey && this.state.wakeEnabled && ["idle", "error"].includes(this.state.phase)) void this.enterStandby();
    return configuration;
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
    this.apiKeys[this.protocol.providerId] = next;
    this.options.tracer?.registerSecret(next);
    this.saveVault();
    if (this.state.wakeEnabled) void this.enterStandby();
  }
  configureVoiceId(value: string): void {
    if (this.closed) throw new Error("语音已关闭");
    if (this.protocol.providerId !== "doubao") throw new Error("当前语音服务不支持豆包音色 ID");
    const next = value.trim();
    if (next && !/^[A-Za-z0-9_-]{1,256}$/.test(next)) throw new Error("请输入有效的豆包音色 ID");
    this.voiceId = next;
    this.saveVault();
  }
  setWakeEnabled(enabled: boolean): void {
    if (this.closed) return;
    if (enabled && !this.resolveApiKey()) throw new Error(`请先配置${this.configuration().providerLabel}语音 API Key`);
    this.publish({ wakeEnabled: enabled });
    this.saveVault();
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
    if (this.closed || !this.resolveApiKey() || !this.state.wakeEnabled) return;
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
    const key = this.resolveApiKey();
    if (!key) throw new Error(`请先配置${this.configuration().providerLabel}语音 API Key`);
    const selectedVoiceId = this.voiceId;
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
    const connectStartedAt = Date.now();
    this.options.tracer?.registerSecret(key);
    this.publish({ phase: "connecting", error: "", transcript: "" });
    this.deadline = setTimeout(() => {
      if (this.current(generation)) this.fail("语音连接超时，请重试");
    }, 15000);
    try {
      const target = this.protocol.connectTarget(key);
      const rawSocket = await this.options.connect(target.url, { headers: target.headers });
      if (!this.current(generation)) {
        void rawSocket.close().catch(() => {});
        return;
      }
      const socket = this.options.tracer?.enabled ? observeVoiceSocket(rawSocket, {
        tracer: this.options.tracer, protocol: this.protocol, sessionId: randomUUID(), fromWakeWord: options.fromWakeWord === true, connectStartedAt,
      }) : rawSocket;
      this.socket = socket;
      for (const message of this.protocol.createHandshakeMessages(this.tools.schemas, { voiceId: selectedVoiceId })) await this.send(message, generation);
      void this.read(socket, generation, selectedVoiceId);
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
  private async read(socket: VoiceSocket, generation: number, selectedVoiceId: string) {
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
        const normalized = this.protocol.parseServerEvent(event);
        const responseId = "responseId" in normalized ? normalized.responseId : "";
        const cancelAck = normalized.kind === "response_cancelled";
        if (cancelAck && (this.discardOutput || (responseId && this.cancelledResponses.has(responseId)))) {
          if (this.deadline) clearTimeout(this.deadline);
          this.deadline = undefined;
          this.discardOutput = false;
          this.responseId = "";
          this.responseInProgress = false;
          if (responseId) this.cancelledResponses.delete(responseId);
          continue;
        }
        if (normalized.kind === "response_done") this.responseInProgress = false;
        if (normalized.kind === "response_done" && responseId && this.cancelledResponses.delete(responseId)) continue;
        if (normalized.kind === "error" && normalized.clientEventId && normalized.clientEventId === this.cancelEventId) {
          this.cancelEventId = "";
          this.discardOutput = false;
          continue;
        }
        if (this.discardOutput && String(event.type).startsWith("response.")) continue;
        if (responseId) {
          if (
            this.discardOutput ||
            (responseId && this.cancelledResponses.has(responseId))
          )
            continue;
          this.responseId = responseId;
        }
        if (normalized.kind === "session_ready") {
          if (this.state.phase !== "connecting") continue;
          if (this.deadline) clearTimeout(this.deadline);
          this.deadline = undefined;
          this.options.audio.setCaptureMode("conversation");
          this.options.audio.playReadyCue();
          this.turnActivity = "waiting_user";
          this.publish({ phase: "listening", muted: false });
          this.startIdleTimer(generation);
          this.tick(generation);
        } else if (normalized.kind === "response_started") {
          this.responseInProgress = true;
        } else if (normalized.kind === "audio_started") {
          if (normalized.itemId) this.currentAudioItem = { itemId: normalized.itemId, contentIndex: normalized.contentIndex ?? 0 };
          this.pauseIdleTimer();
          this.outputStreamDone = false;
          this.audioStartedResponseId = responseId;
          this.tools.onAudioStarted(responseId);
          this.publish({ phase: "speaking" });
        } else if (normalized.kind === "audio_delta" && !this.discardOutput) {
          if (normalized.itemId) this.currentAudioItem = { itemId: normalized.itemId, contentIndex: normalized.contentIndex ?? 0 };
          if (this.audioStartedResponseId !== responseId || this.state.phase !== "speaking") {
            this.pauseIdleTimer();
            this.outputStreamDone = false;
            this.audioStartedResponseId = responseId;
            this.tools.onAudioStarted(responseId);
            this.publish({ phase: "speaking" });
          }
          if (
            normalized.pcmBase64.length > 320000 ||
            !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized.pcmBase64)
          )
            throw new Error("Invalid PCM");
          const pcm = Buffer.from(normalized.pcmBase64, "base64");
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
            this.outputFrames.push({ pcm: pcm.subarray(offset, offset + 4800), itemId: normalized.itemId, contentIndex: normalized.contentIndex });
          this.outputBytes += pcm.length;
        } else if (normalized.kind === "audio_done") {
          this.outputStreamDone = true;
          if (normalized.userQueryExit) this.exitAfterPlayback = true;
          this.tools.onAudioDone();
        }
        else if (normalized.kind === "text_delta")
          this.publish({
            transcript: (
              this.state.transcript + normalized.delta
            ).slice(-4096),
          });
        else if (normalized.kind === "text_done")
          this.publish({
            transcript: String(normalized.text ?? this.state.transcript).slice(
              -4096,
            ),
          });
        else if (normalized.kind === "user_speech_started" || normalized.kind === "user_transcription_started") {
          this.turnActivity = "user_speaking";
          this.pauseIdleTimer();
          if (this.state.phase === "speaking" || this.outputFrames.length || this.responseId)
            this.interrupt("server_vad");
        } else if (normalized.kind === "user_speech_stopped") {
          this.turnActivity = "awaiting_reply";
          this.pauseIdleTimer();
          this.startAwaitingTimer(generation);
        } else if (normalized.kind === "user_transcription_failed" || normalized.kind === "response_done") {
          if (normalized.kind === "response_done") this.responseInProgress = false;
          if (normalized.kind === "response_done" && this.tools.onResponseDone(responseId)) continue;
          if (this.state.phase !== "speaking" && !this.tools.busy) this.resumeWaiting(generation);
        }
        else if (normalized.kind === "tool_calls") {
          for (const call of normalized.calls)
            this.tools.handle({ call_id: call.callId, name: call.name, arguments: call.argumentsJson }, generation, this.responseId);
        } else if (normalized.kind === "error") {
          if (this.protocol.providerId === "doubao" && selectedVoiceId && this.state.phase === "connecting" && /speaker|voice[_ -]?(?:id|type)|音色/i.test(normalized.message)) {
            this.fail("豆包音色 ID 无法使用，请检查 ID 与当前项目的音色权限");
            return;
          }
          throw new Error("Provider error");
        }
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
      this.syncPlayback();
      let peakLevel = 0;
      for (let count = 0; count < 5 && this.outputFrames.length; count++) {
        const frame = this.outputFrames[0];
        if (
          this.options.audio.status().queuedPlaybackMs + frame.pcm.length / 48 >
          4500
        )
          break;
        this.outputFrames.shift();
        this.outputBytes -= frame.pcm.length;
        peakLevel = Math.max(peakLevel, pcm16Rms(frame.pcm));
        this.options.audio.enqueue(frame.pcm, 24000);
        this.playback.push({ itemId: frame.itemId, contentIndex: frame.contentIndex, durationMs: frame.pcm.length / 48 });
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
        void this.send(this.protocol.encodeAudioAppend(this.frames.shift() ?? new Uint8Array(640)), generation)
          .catch(() => {
            if (this.current(generation)) this.fail("语音网络发送失败");
          })
          .finally(() => {
            if (this.current(generation)) this.audioWriting = false;
          });
      }
      const drained = this.outputFrames.length === 0 && this.options.audio.status().queuedPlaybackMs <= 0;
      if ((this.tools.closingAfterFarewell && this.tools.farewellComplete && drained) || (this.exitAfterPlayback && drained)) {
        this.endSession();
        return;
      }
      if (!this.tools.closingAfterFarewell && this.state.phase === "speaking" && this.outputStreamDone && drained) {
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
  mute(value: boolean) {
    if (!["listening", "speaking"].includes(this.state.phase)) return;
    this.options.audio.setMuted(value);
    this.frames = [];
    this.publish({ muted: value });
    const generation = this.generation;
    const frame = this.protocol.encodeMute(value);
    if (frame) void this.send(frame, generation).catch(() => {
      if (this.current(generation)) this.fail("语音静音状态同步失败");
    });
  }
  private syncPlayback() {
    let played = Math.max(0, this.playback.reduce((sum, item) => sum + item.durationMs, 0) - this.options.audio.status().queuedPlaybackMs);
    while (played > 0 && this.playback.length) {
      const frame = this.playback[0];
      const amount = Math.min(frame.durationMs, played);
      if (frame.itemId) {
        const key = `${frame.itemId}:${frame.contentIndex ?? 0}`;
        this.playedByItem.set(key, (this.playedByItem.get(key) ?? 0) + amount);
      }
      frame.durationMs -= amount;
      played -= amount;
      if (frame.durationMs <= 0) this.playback.shift();
    }
  }
  interrupt(trigger: "manual" | "server_vad" = "manual") {
    if (!["listening", "speaking"].includes(this.state.phase)) return;
    if (this.discardOutput) return;
    if (
      this.state.phase !== "speaking" &&
      this.options.audio.status().queuedPlaybackMs <= 0 &&
      this.outputBytes === 0 &&
      !this.responseInProgress
    ) {
      this.publish({ transcript: "" });
      return;
    }
    this.syncPlayback();
    const playback = this.currentAudioItem ? { ...this.currentAudioItem, playedMs: this.playedByItem.get(`${this.currentAudioItem.itemId}:${this.currentAudioItem.contentIndex}`) ?? 0 } : undefined;
    const cancelEventId = trigger === "manual" && this.responseInProgress && this.protocol.providerId !== "doubao" ? `cancel_${randomUUID()}` : undefined;
    const frames = this.protocol.encodeInterrupt({ trigger, responseId: this.responseId, responseInProgress: this.responseInProgress, cancelEventId, playback });
    this.discardOutput = this.protocol.providerId === "doubao" || Boolean(cancelEventId);
    this.cancelEventId = cancelEventId ?? "";
    if (this.responseId) this.cancelledResponses.add(this.responseId);
    if (this.cancelledResponses.size > 128) {
      this.fail("请重新开启语音");
      return;
    }
    this.outputFrames = [];
    this.outputBytes = 0;
    this.playback = [];
    this.playedByItem.clear();
    this.currentAudioItem = undefined;
    this.options.audio.clearPlayback();
    this.options.onAudioLevel?.(0);
    this.publish({ phase: "listening", transcript: "" });
    const generation = this.generation;
    // No-ID frames are unsafe until the peer acknowledges cancellation. If
    // this protocol variant lacks an ack, close instead of replaying old speech.
    if (this.discardOutput) this.deadline = setTimeout(() => {
      if (this.current(generation)) this.fail("语音已打断，请再次开启继续");
    }, 4000);
    for (const frame of frames) void this.send(frame, generation).catch(() => {
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
      if (this.current(generation) && this.turnActivity === "waiting_user" && !this.tools.busy)
        this.endSession();
    }, 12000);
  }
  private startAwaitingTimer(generation: number) {
    if (this.awaitingTimer) clearTimeout(this.awaitingTimer);
    this.awaitingTimer = setTimeout(() => {
      if (this.current(generation) && this.turnActivity === "awaiting_reply" && !this.tools.busy && this.state.phase === "listening")
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
    socket?.finalizeSession?.("end_session");
    this.socket = undefined;
    ++this.generation;
    this.clearTimers();
    this.frames = [];
    this.outputFrames = [];
    this.outputBytes = 0;
    this.playback = [];
    this.playedByItem.clear();
    this.currentAudioItem = undefined;
    this.responseInProgress = false;
    this.exitAfterPlayback = false;
    this.tools.reset();
    this.audioWriting = false;
    this.discardOutput = false;
    this.responseId = "";
    this.cancelledResponses.clear();
    this.writes = 0;
    this.writeQueue = Promise.resolve();
    this.outputStreamDone = false;
    this.options.audio.clearPlayback();
    this.options.onAudioLevel?.(0);
    this.options.cancelTask();
    if (socket) {
      const closeMessage = this.protocol.encodeSessionClose();
      void pendingWrites
        .then(() => closeMessage ? socket.write(JSON.stringify(closeMessage)) : undefined)
        .catch(() => {})
        .finally(() => void socket.close().catch(() => {}));
    }
    if (this.state.wakeEnabled && !this.closed) void this.enterStandby();
    else this.stop();
  }
  private clearTimers() {
    for (const timer of [this.timer, this.deadline, this.standbyTimer, this.idleTimer, this.awaitingTimer])
      if (timer) clearTimeout(timer);
    this.timer = this.deadline = this.standbyTimer = this.idleTimer = this.awaitingTimer = undefined;
  }
  stop() {
    ++this.generation;
    this.clearTimers();
    const socket = this.socket;
    socket?.finalizeSession?.("stop");
    this.socket = undefined;
    this.options.audio.stop();
    this.options.onAudioLevel?.(0);
    this.frames = [];
    this.outputFrames = [];
    this.outputBytes = 0;
    this.playback = [];
    this.playedByItem.clear();
    this.currentAudioItem = undefined;
    this.responseInProgress = false;
    this.exitAfterPlayback = false;
    this.tools.reset();
    this.outputStreamDone = false;
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
