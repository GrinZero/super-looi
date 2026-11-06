import WebSocket from "ws";
import { config } from "../config.js";
import type {
  DuplexRawEvent,
  VoiceEvent,
  VoiceProvider,
  VoiceSession,
  VoiceSessionSpec,
} from "./types.js";

// 豆包端到端全双工 Duplex provider。
// 协议纪律（live-demo 探针实测，保持原样）：
//  - 上行 PCM16k mono，严格 20ms/640B 实时节奏 → 自校正节拍器统一调速
//  - 关麦必须 input_audio_mute.commit，否则超时无响应
//  - 优雅关闭：session.close 收到回复再断连
//  - session.id 可续接历史

const FRAME_MS = 20;
const FRAME_BYTES = 640; // PCM16k mono 20ms
const OUTPUT_SAMPLE_RATE = 24_000;
const OPEN_TIMEOUT_MS = 10_000;
const MAX_AUDIO_QUEUE_FRAMES = 100; // 积压 >2s 丢旧帧保实时性

type Logger = (msg: string, data?: unknown) => void;

/** 极小 async 队列：push 事件、迭代消费、close 终止。 */
class EventQueue implements AsyncIterable<VoiceEvent> {
  private queue: VoiceEvent[] = [];
  private waiter: ((value: IteratorResult<VoiceEvent>) => void) | null = null;
  private done = false;

  push(event: VoiceEvent): void {
    if (this.done) return;
    if (event.type === "closed" || event.type === "error") this.done = true;
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve({ value: event, done: false });
      return;
    }
    this.queue.push(event);
  }

  [Symbol.asyncIterator](): AsyncIterator<VoiceEvent> {
    return {
      next: () => {
        const event = this.queue.shift();
        if (event) return Promise.resolve({ value: event, done: false });
        if (this.done) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise<IteratorResult<VoiceEvent>>((resolve) => {
          this.waiter = resolve;
        });
      },
    };
  }
}

function toToolCalls(evt: DuplexRawEvent, responseId: string): VoiceEvent[] {
  const items = Array.isArray(evt.items) ? (evt.items as Record<string, unknown>[]) : [];
  const events: VoiceEvent[] = [];
  for (const item of items) {
    const name = String(item.name ?? "");
    const callId = String(item.call_id ?? item.id ?? "");
    if (!name || !callId) continue;
    events.push({
      type: "tool_call",
      responseId,
      callId,
      name,
      argumentsJson: String(item.arguments ?? "{}"),
    });
  }
  return events;
}

/** 把豆包原始 JSON 事件归一成 VoiceEvent；无对应语义的返回空数组。 */
export function mapDuplexEvent(evt: DuplexRawEvent): VoiceEvent[] {
  const t = String(evt.type ?? "");
  const responseId = String(evt.response_id ?? "");

  if (t === "session.created" || t === "session.updated") {
    const session = evt.session as Record<string, unknown> | undefined;
    const sessionId = String(session?.id ?? evt.session_id ?? "");
    return sessionId
      ? [{ type: "session.ready", sessionId, resumed: t === "session.updated" }]
      : [];
  }

  // 用户语音转写流（服务端 VAD 产出）
  if (t.includes("transcription")) {
    const text = String(evt.text ?? evt.transcript ?? evt.delta ?? "");
    if (t.endsWith("started")) {
      const events: VoiceEvent[] = [{ type: "asr.started" }];
      if (text.trim()) events.push({ type: "asr.partial", text });
      return events;
    }
    if (t.endsWith("completed") || t.endsWith("done")) {
      return [{ type: "asr.final", text }];
    }
    return text.trim() ? [{ type: "asr.partial", text }] : [];
  }

  switch (t) {
    case "response.output_audio.started":
      return [
        { type: "audio.started", responseId, sampleRate: OUTPUT_SAMPLE_RATE },
      ];
    case "response.output_audio.delta": {
      const pcm = Buffer.from(String(evt.delta ?? ""), "base64");
      return pcm.length ? [{ type: "audio.delta", responseId, pcm }] : [];
    }
    case "response.output_audio.done":
      return [{ type: "audio.done", responseId }];
    case "response.output_text.delta": {
      const delta = String(evt.delta ?? "");
      return delta ? [{ type: "text.delta", responseId, delta }] : [];
    }
    case "response.output_text.done":
      return [
        { type: "text.done", responseId, text: String(evt.text ?? "") },
      ];
    case "response.function_call_arguments.done":
      return toToolCalls(evt, responseId);
    case "response.done":
      return [{ type: "response.done", responseId }];
    case "error":
    case "session.error":
      return [
        {
          type: "error",
          code: String(evt.code ?? "duplex"),
          message: JSON.stringify(evt).slice(0, 500),
        },
      ];
    default:
      // 服务端 VAD 检出用户开口 → 打断信号（播放中的输出应被清掉）
      if (t.includes("speech_started") || t.includes("input_audio_buffer.speech")) {
        return [{ type: "interrupted" }];
      }
      return [];
  }
}

class DoubaoDuplexSession implements VoiceSession {
  private ws?: WebSocket;
  private audioQueue: Buffer[] = [];
  private paceTimer?: NodeJS.Timeout;
  private nextTick = 0;
  private muted: boolean;
  private serverMuted: boolean | undefined;
  private closedByUs = false;
  private queue = new EventQueue();
  private log: Logger;

  id = "";

  constructor(
    private spec: VoiceSessionSpec,
    logger?: Logger,
  ) {
    this.log = logger ?? (() => {});
    // 默认关麦，等 VoiceSession 消费者显式 unmute——与 live-demo 一致
    this.muted = true;
  }

  get events(): AsyncIterable<VoiceEvent> {
    return this.queue;
  }

  async open(): Promise<void> {
    if (!config.doubao.apiKey) {
      throw new Error("DOUBAO_API_KEY is required for the doubao voice provider");
    }
    this.closedByUs = false;
    this.serverMuted = undefined;
    this.ws = new WebSocket(config.doubao.duplexUrl, {
      headers: { "X-Api-Key": config.doubao.apiKey },
      maxPayload: 64 * 1024 * 1024,
    });
    this.ws.binaryType = "nodebuffer";
    this.ws.on("message", (raw: Buffer | string) => this.onMessage(raw));
    this.ws.on("close", (code, reason) => {
      this.stopPacer();
      this.log("duplex closed", { code, byUs: this.closedByUs, reason: reason.toString().slice(0, 200) });
      this.queue.push({ type: "closed", code, reason: reason.toString() });
    });
    this.ws.on("error", (e) => this.log("duplex ws error", { message: e.message }));

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("duplex open timeout")), OPEN_TIMEOUT_MS);
      this.ws!.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      this.ws!.once("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });

    const session: Record<string, unknown> = {
      model: config.doubao.model,
      instructions: this.spec.instructions,
      audio: {
        input: { format: { type: "pcm", rate: 16000 } },
        output: {
          format: { type: "pcm_s16le", rate: OUTPUT_SAMPLE_RATE },
          voice: this.spec.voice ?? config.doubao.voice,
        },
      },
    };
    if (this.spec.tools?.length) session.tools = this.spec.tools;
    if (this.spec.resumeSessionId) session.id = this.spec.resumeSessionId;

    this.send({
      type: "session.create",
      session,
      extension: {
        tts: { extra: { max_length_to_filter_parenthesis: 100 } },
        ...(config.doubao.vadSmoothMs
          ? {
              asr: {
                extra: {
                  end_smooth_window_ms: config.doubao.vadSmoothMs,
                  enable_custom_vad: true,
                },
              },
            }
          : {}),
      },
    });
    this.startPacer();
    this.log("duplex session.create sent", {
      model: config.doubao.model,
      voice: this.spec.voice ?? config.doubao.voice,
      resume: this.spec.resumeSessionId,
    });
  }

  private onMessage(raw: Buffer | string): void {
    let evt: DuplexRawEvent;
    try {
      evt = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
    } catch {
      this.log("duplex non-json frame", { bytes: raw.length });
      return;
    }
    const t = String(evt.type ?? "");
    if (t === "session.created" || t === "session.updated") {
      const session = evt.session as Record<string, unknown> | undefined;
      const sid = String(session?.id ?? evt.session_id ?? "");
      if (sid) this.id = sid;
      this.commitMute(this.muted);
    }
    if (t !== "response.output_audio.delta") {
      this.log(`duplex ← ${t}`, stripDelta(evt));
    }
    for (const event of mapDuplexEvent(evt)) this.queue.push(event);
  }

  pushAudio(pcm: Buffer): void {
    for (let i = 0; i + FRAME_BYTES <= pcm.length; i += FRAME_BYTES) {
      this.audioQueue.push(pcm.subarray(i, i + FRAME_BYTES));
    }
    const tail = pcm.length % FRAME_BYTES;
    if (tail) {
      this.audioQueue.push(
        Buffer.concat([pcm.subarray(pcm.length - tail), Buffer.alloc(FRAME_BYTES - tail)]),
      );
    }
    if (this.audioQueue.length > MAX_AUDIO_QUEUE_FRAMES) {
      this.audioQueue.splice(0, this.audioQueue.length - MAX_AUDIO_QUEUE_FRAMES);
    }
  }

  private startPacer(): void {
    this.nextTick = Date.now() + FRAME_MS;
    const tick = () => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      if (!this.muted) {
        const frame = this.audioQueue.shift() ?? Buffer.alloc(FRAME_BYTES);
        this.send({ type: "input_audio_buffer.append", audio: frame.toString("base64") });
      }
      this.nextTick += FRAME_MS;
      const delay = Math.max(1, this.nextTick - Date.now());
      if (delay > FRAME_MS * 2) this.nextTick = Date.now() + FRAME_MS;
      this.paceTimer = setTimeout(tick, delay);
    };
    this.paceTimer = setTimeout(tick, FRAME_MS);
  }

  private stopPacer(): void {
    if (this.paceTimer) clearTimeout(this.paceTimer);
  }

  private commitMute(muted: boolean): void {
    if (muted === this.serverMuted) return;
    this.serverMuted = muted;
    this.send({ type: muted ? "input_audio_mute.commit" : "input_audio_unmute.commit" });
  }

  setMuted(muted: boolean): void {
    if (muted === this.muted) return;
    this.muted = muted;
    this.commitMute(muted);
    if (!muted) this.audioQueue.length = 0;
    this.log(muted ? "duplex mic muted" : "duplex mic open");
  }

  speakText(text: string): void {
    const clean = stripStageText(text);
    if (!clean) return;
    this.send({ type: "speech_text_buffer.commit", text: clean });
  }

  injectUserText(text: string): void {
    this.injectItems([
      { type: "message", role: "user", content: [{ type: "input_text", text }] },
    ]);
  }

  injectItems(items: unknown[]): void {
    this.send({ type: "conversation.item.create", items });
  }

  returnToolResults(calls: { callId: string; result: unknown }[]): void {
    this.injectItems(
      calls.map((c) => ({
        call_id: c.callId,
        role: "tool",
        content: [{ type: "input_text", text: JSON.stringify(c.result) }],
      })),
    );
  }

  interrupt(): void {
    this.send({ type: "response.cancel" });
  }

  private send(obj: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  async close(): Promise<void> {
    this.closedByUs = true;
    this.stopPacer();
    try {
      if (this.ws?.readyState === WebSocket.OPEN) {
        const ws = this.ws;
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            ws.off("message", onMessage);
            ws.off("close", done);
            resolve();
          };
          const onMessage = (raw: WebSocket.RawData) => {
            try {
              if (JSON.parse(raw.toString()).type === "session.closed") done();
            } catch {
              /* ignore non-JSON frames */
            }
          };
          const timer = setTimeout(done, 800);
          ws.on("message", onMessage);
          ws.once("close", done);
          this.send({ type: "session.close" });
        });
      }
      this.ws?.close();
    } catch {
      /* noop */
    }
  }
}

/** 口播文本剥离括号/书名号舞台提示，避免被念出来。 */
export function stripStageText(text: string): string {
  return text
    .replace(/[（(【\[][^）)\]\n]*[）)\]]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function stripDelta(evt: DuplexRawEvent): Record<string, unknown> {
  return Object.fromEntries(Object.entries(evt).filter(([k]) => k !== "delta"));
}

export class DoubaoDuplexProvider implements VoiceProvider {
  readonly name = "doubao";

  constructor(private logger?: Logger) {}

  async open(spec: VoiceSessionSpec): Promise<VoiceSession> {
    const session = new DoubaoDuplexSession(spec, this.logger);
    await session.open();
    return session;
  }
}
