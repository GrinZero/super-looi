import { base64ToBytes, bytesToBase64, type WebSocketAdapter } from "./live-voice-client.js";
import type { LocalControlCenter } from "./local-control-center.js";

export const LOCAL_DUPLEX_URL = "wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue";

/** Presents the existing mobile audio client with the same frame interface, entirely in-process. */
export class LocalVoiceSocket implements WebSocketAdapter {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: (() => void) | null = null;
  private upstream: WebSocketAdapter | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  private frames: Uint8Array[] = [];
  private remainder = new Uint8Array(0);
  private muted = true;
  private seenCalls = new Set<string>();
  private toolQueue = Promise.resolve();
  private generation = 0;
  private revision = 0;
  private memoryGeneration = 0;
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly center: LocalControlCenter, private readonly factory: (url: string, apiKey: string) => WebSocketAdapter) {
    queueMicrotask(() => void this.open());
  }
  private emit(value: Record<string, unknown>) { if (this.readyState === 1) this.onmessage?.({ data: JSON.stringify(value) }); }
  private json(value: unknown) { if (this.upstream?.readyState === 1) this.upstream.send(JSON.stringify(value)); }
  private fail() { if (this.readyState === 3) return; this.onerror?.(new Error("本机语音连接失败，请检查 API Key 与网络")); this.close(); }
  private async open() {
    const generation = this.generation;
    try {
      await this.center.initialize();
      if (generation !== this.generation || this.readyState === 3) return;
      this.revision = this.center.revision;
      this.memoryGeneration = this.center.memories.captureGeneration();
      this.unsubscribe = this.center.subscribe(() => {
        if (this.readyState !== 1) return;
        if (this.memoryGeneration !== this.center.memories.captureGeneration()) {
          this.emit({ type: "agent_status", phase: "done", tool: "forget_memory", summary: "本机记忆已更新，点 LIVE 可继续对话", memories: this.center.memories.list() });
          this.close();
        } else if (this.revision !== this.center.revision) this.close();
      });
      const key = await this.center.voiceKey();
      if (generation !== this.generation || this.readyState === 3) return;
      if (!key) throw new Error();
      const socket = this.factory(LOCAL_DUPLEX_URL, key);
      this.upstream = socket;
      this.handshakeTimer = setTimeout(() => this.fail(), 10_000);
      socket.onopen = () => {
        this.json({ type: "session.create", session: { model: "1.2.6.1",
          instructions: `你是 LOOI，用简短自然的中文回答，不念括号舞台提示。记忆来自本机。用户明确提供的事实用 remember_fact 保存，问旧事用 recall_memory；忘记请求用 forget_memory。家居控制前先查真实 entity_id，多个匹配先澄清。仅 verified 回执可说已确认；simulation 必须说明是演示。电脑任务需要用户切回 Hub 模式，不得声称本机执行了电脑命令。当前家居模式：${this.center.preferences.mode}。`,
          tools: this.center.voiceTools, audio: { input: { format: { type: "pcm", rate: 16000 } }, output: { format: { type: "pcm_s16le", rate: 24000 }, voice: "zh_female_vv_jupiter_bigtts" } } },
          extension: { tts: { extra: { max_length_to_filter_parenthesis: 100 } }, asr: { extra: { end_smooth_window_ms: 2500, enable_custom_vad: true } } } });
      };
      socket.onmessage = (event) => this.handle(event.data);
      socket.onerror = () => this.fail();
      socket.onclose = () => this.close();
    } catch { this.fail(); }
  }
  private handle(raw: unknown) {
    if (this.readyState === 3) return;
    try {
      const event = JSON.parse(String(raw)); const type = String(event.type ?? "");
      if (type === "session.created") {
        if (this.readyState === 1) return;
        if (this.handshakeTimer) clearTimeout(this.handshakeTimer); this.handshakeTimer = null;
        this.readyState = 1; this.onopen?.(); this.pace();
        queueMicrotask(() => this.emit({ type: "session_ready", provider: "doubao" }));
      } else if (type === "response.output_audio.delta") this.emit({ type: "audio_chunk", pcm_base64: String(event.delta ?? ""), sample_rate: 24000 });
      else if (type === "response.output_audio.started") this.emit({ type: "state_change", state: "speaking" });
      else if (type === "response.output_audio.done") this.emit({ type: "state_change", state: "listening" });
      else if (type === "response.output_text.delta" || type === "response.output_text.done") this.emit({ type: "transcript", role: "assistant", text: String(event.text ?? event.delta ?? ""), is_final: type.endsWith("done") });
      else if (type.includes("transcription")) this.emit({ type: "transcript", role: "user", text: String(event.text ?? event.transcript ?? event.delta ?? ""), is_final: type.endsWith("completed") || type.endsWith("done") });
      else if (type.includes("speech_started")) this.emit({ type: "interrupted", reason: "speech_started" });
      else if (type === "response.function_call_arguments.done") {
        for (const item of Array.isArray(event.items) ? event.items : [event]) this.tool(item);
      } else if (type === "error" || type === "session.error") { this.emit({ type: "error", message: "豆包语音返回错误，请检查 Key、权限或网络" }); this.close(); }
    } catch { /* Unsupported frames do not execute tools. */ }
  }
  private tool(item: Record<string, unknown>) {
    const id = String(item.call_id ?? item.id ?? ""); const name = String(item.name ?? "");
    if (!id || this.seenCalls.has(id) || this.seenCalls.size >= 200) return;
    this.seenCalls.add(id);
    const generation = this.generation;
    const memoryGeneration = this.memoryGeneration;
    this.toolQueue = this.toolQueue.then(async () => {
      if (generation !== this.generation || this.readyState !== 1) return;
      let output: unknown;
      try {
        const args = JSON.parse(String(item.arguments ?? "{}"));
        if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error();
        output = await this.center.executeTool(name, args, memoryGeneration, this.revision);
      } catch { output = { error: "操作未获确认，请重新提出请求或检查连接；不能声称已完成。" }; }
      if (generation !== this.generation || this.readyState !== 1) return;
      this.json({ type: "conversation.item.create", items: [{ call_id: id, role: "tool", content: [{ type: "input_text", text: JSON.stringify(output) }] }] });
      this.emit({ type: "agent_status", phase: "tool_end", tool: name, summary: "本机工具已返回结果", memories: this.center.memories.list() });
    }).catch(() => {});
  }
  send(raw: string) {
    if (this.readyState !== 1) return;
    const message = JSON.parse(raw);
    if (message.type === "unmute_commit" || message.type === "mute_commit") {
      this.muted = message.type === "mute_commit";
      this.json({ type: this.muted ? "input_audio_mute.commit" : "input_audio_unmute.commit" });
    } else if (message.type === "text_input") {
      const generation = this.generation;
      this.toolQueue = this.toolQueue.then(async () => {
        if (generation !== this.generation) return;
        const text = await this.center.executeText(String(message.text ?? ""));
        if (generation !== this.generation) return;
        this.emit({ type: "transcript", role: "assistant", text, is_final: true });
        this.json({ type: "speech_text_buffer.commit", text });
      }).catch(() => this.emit({ type: "error", message: "本机文字操作未确认，请重新检查请求" }));
    }
    else if (message.type === "speak_text") this.json({ type: "speech_text_buffer.commit", text: String(message.text ?? "") });
    else if (message.type === "audio_chunk") {
      const bytes = base64ToBytes(String(message.pcm_base64 ?? ""));
      const merged = new Uint8Array(this.remainder.length + bytes.length); merged.set(this.remainder); merged.set(bytes, this.remainder.length);
      let offset = 0; while (offset + 640 <= merged.length) { this.frames.push(merged.slice(offset, offset + 640)); offset += 640; }
      this.remainder = merged.slice(offset); if (this.frames.length > 250) this.frames.splice(0, this.frames.length - 250);
    } else if (message.type === "barge_in") { this.json({ type: "response.cancel" }); this.emit({ type: "interrupted", reason: "user_barge_in" }); }
    else if (message.type === "session_close") this.close();
  }
  private pace() {
    let next = Date.now() + 20;
    const tick = () => {
      if (this.readyState !== 1) return;
      if (!this.muted) this.json({ type: "input_audio_buffer.append", audio: bytesToBase64(this.frames.shift() ?? new Uint8Array(640)) });
      next += 20; if (Date.now() - next > 40) next = Date.now() + 20;
      this.timer = setTimeout(tick, Math.max(1, next - Date.now()));
    };
    this.timer = setTimeout(tick, 20);
  }
  close() {
    if (this.readyState === 3) return;
    if (this.readyState === 1) this.center.memories.invalidateCaptures();
    this.readyState = 3; ++this.generation;
    this.unsubscribe?.(); this.unsubscribe = null;
    if (this.timer) clearTimeout(this.timer); if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.timer = null; this.handshakeTimer = null; this.frames = []; this.remainder = new Uint8Array(0);
    const socket = this.upstream; this.upstream = null;
    if (socket) { socket.onclose = null; socket.onerror = null; socket.onmessage = null; socket.onopen = null; socket.close(); }
    this.onclose?.();
  }
}
