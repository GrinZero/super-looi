import WebSocket from "ws";
import { HOME_VOICE_TOOLS } from "../home/voice-tools.js";
import type {
  VoiceProviderKind,
  VoiceUpMessage,
  VoiceDownMessage,
  JsonObject,
} from "@super-looi/contracts";
import type {
  VoiceProvider,
  VoiceSessionOptions,
  VoiceSessionHandle,
} from "./provider.js";

export const FRAME_MS = 20;
export const FRAME_BYTES = 640; // PCM16k mono 20ms (16000 * 2 / 50 = 640 bytes)
export const OUTPUT_SAMPLE_RATE = 24_000;
export const MAX_AUDIO_QUEUE_FRAMES = 250;

export interface WebSocketLike {
  readyState: number;
  send(data: string | Buffer): void;
  close(code?: number, reason?: string): void;
  on(event: string, listener: (...args: any[]) => void): this;
  once(event: string, listener: (...args: any[]) => void): this;
  off?(event: string, listener: (...args: any[]) => void): this;
}

export type WebSocketFactory = (url: string, headers: Record<string, string>) => WebSocketLike;

export interface DoubaoToolDefinition {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export const DEFAULT_LOOI_VOICE_TOOLS: DoubaoToolDefinition[] = [
  ...HOME_VOICE_TOOLS,
  {
    type: "function",
    name: "remember_fact",
    description:
      "当用户提到任何物品位置、个人偏好、待办或要记住的事情时调用。自动保存到持久记忆，无需用户手动确认。",
    parameters: {
      type: "object",
      properties: {
        fact: { type: "string", description: "完整的事实描述，如 '备用钥匙放在玄关抽屉里'" },
        subject: { type: "string", description: "物品或主题名称，如 '备用钥匙'" },
        location: { type: "string", description: "位置描述，如 '玄关抽屉'" },
      },
      required: ["fact"],
    },
  },
  {
    type: "function",
    name: "recall_memory",
    description: "当用户询问某样东西在哪、或者询问之前记过的事项时调用。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "要检索的物品名称或关键词" },
      },
      required: ["query"],
    },
  },
  {
    type: "function",
    name: "run_agent_task",
    description:
      "当用户要求检查代码、查看目录文件、运行终端命令 (git/pnpm/ls等)、读写文件或执行复杂任务时调用。",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "用户的具体任务指令" },
      },
      required: ["task"],
    },
  },
];

export const DEFAULT_LOOI_INSTRUCTIONS = `你是 LOOI，一个住在用户桌面上的具身个人伙伴（Personal Agent）。你的屏幕就是你的脸。

行为准则：
- 说话简短自然，通常一到两句完整的话，像熟悉的朋友一样直接交流，绝不念出括号里的舞台提示或格式标记。
- 零心智负担：用户随口提到物品放哪了、个人习惯或待办时，主动调用 remember_fact 记下来；用户问东西在哪时，参考下方记忆或调用 recall_memory。
- 家居查询和控制先用 list_home_devices 读取真实设备；匹配不唯一先澄清。控制使用 control_home_device，仅 verified 回执可说完成，禁止猜测实体 ID、读数或执行结果。
- 当用户让你看项目状态、查文件、跑命令或处理电脑任务时，先简短答应一声（如“好，我帮你看一下”），同时调用 run_agent_task。`;

export interface DoubaoEngineConfig {
  apiKey?: string;
  duplexUrl?: string;
  model?: string;
  voice?: string;
  vadSmoothMs?: number;
  instructions?: string;
  buildInstructions?: () => string;
  tools?: DoubaoToolDefinition[];
  wsFactory?: WebSocketFactory;
}

/**
 * Strips bracketed stage directions (e.g. (开心), [微笑], 【点头】) from spoken text.
 */
export function stripStageText(text: string): string {
  return text
    .replace(/[（(【\[][^）)\]】\n]*[）)\]】]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export class DoubaoVoiceSession implements VoiceSessionHandle {
  public sessionId: string;
  private ws: WebSocketLike | null = null;
  private audioQueue: Buffer[] = [];
  private paceTimer: NodeJS.Timeout | null = null;
  private nextTick = 0;
  private muted = true;
  private serverMuted: boolean | undefined = undefined;
  private closedByUs = false;
  private isConnected = false;

  constructor(
    public readonly id: string,
    private readonly options: VoiceSessionOptions,
    private readonly config: DoubaoEngineConfig
  ) {
    this.sessionId = id;
  }

  public async open(): Promise<void> {
    const apiKey = this.config.apiKey || process.env.DOUBAO_API_KEY || "mock-api-key";
    const duplexUrl =
      this.config.duplexUrl ||
      process.env.DUPLEX_URL ||
      process.env.DOUBAO_DUPLEX_URL ||
      "wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue";
    const model = this.config.model || process.env.DUPLEX_MODEL || "1.2.6.1";
    const voice = this.config.voice || process.env.LOOI_VOICE || "zh_female_vv_jupiter_bigtts";
    const vadSmoothMs = Math.max(0, Number(this.config.vadSmoothMs ?? process.env.VAD_SMOOTH_MS ?? 2500));
    const instructions =
      this.config.buildInstructions?.() || this.config.instructions || DEFAULT_LOOI_INSTRUCTIONS;
    const tools = this.config.tools ?? DEFAULT_LOOI_VOICE_TOOLS;

    const factory: WebSocketFactory =
      this.config.wsFactory ||
      ((url, headers) => {
        const socket = new WebSocket(url, {
          headers,
          maxPayload: 64 * 1024 * 1024,
        });
        socket.binaryType = "nodebuffer";
        return socket as unknown as WebSocketLike;
      });

    const maxAttempts = this.config.wsFactory ? 1 : 3;
    let lastErr: Error | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      this.ws = factory(duplexUrl, {
        "X-Api-Key": apiKey,
      });
      try {
        await new Promise<void>((resolve, reject) => {
          const openTimer = setTimeout(() => {
            try { this.ws?.close(); } catch {}
            this.ws = null;
            reject(new Error("Doubao Duplex connection timeout"));
          }, 10_000);

          this.ws!.once("open", () => {
            clearTimeout(openTimer);
            this.isConnected = true;
            resolve();
          });

          this.ws!.once("error", (err: Error) => {
            clearTimeout(openTimer);
            try { this.ws?.close(); } catch {}
            this.ws = null;
            reject(err);
          });
        });
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err as Error;
        if (attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, 250 * attempt));
        }
      }
    }
    if (lastErr || !this.ws) {
      throw lastErr ?? new Error("Failed to open Doubao Duplex WebSocket");
    }

    this.ws.on("message", (raw: unknown) => {
      this.handleServerMessage(raw);
    });

    this.ws.on("close", () => {
      this.stopPacer();
      this.isConnected = false;
      this.options.onDownMessage({
        type: "state_change",
        state: "idle",
      });
    });

    // Send initial session.create payload per ByteDance OpenSpeech V3 realtime dialogue protocol
    this.sendJson({
      type: "session.create",
      session: {
        id: this.sessionId,
        model,
        instructions,
        tools,
        audio: {
          input: { format: { type: "pcm", rate: 16000 } },
          output: {
            format: { type: "pcm_s16le", rate: OUTPUT_SAMPLE_RATE },
            voice,
          },
        },
      },
      extension: {
        tts: { extra: { max_length_to_filter_parenthesis: 100 } },
        ...(vadSmoothMs > 0
          ? {
              asr: {
                extra: {
                  end_smooth_window_ms: vadSmoothMs,
                  enable_custom_vad: true,
                },
              },
            }
          : {}),
      },
    });

    this.startPacer();
    // Default initial mute commit
    this.commitMute(true);
  }

  public async sendUpMessage(msg: VoiceUpMessage): Promise<void> {
    switch (msg.type) {
      case "audio_chunk": {
        const pcm = Buffer.from(msg.pcm_base64, "base64");
        this.pushAudio(pcm);
        break;
      }
      case "mute_commit": {
        this.setMuted(true);
        break;
      }
      case "unmute_commit": {
        this.setMuted(false);
        break;
      }
      case "speak_text": {
        const clean = stripStageText(msg.text);
        if (clean) {
          this.options.onDownMessage({
            type: "transcript",
            text: clean,
            is_final: true,
            role: "assistant",
          });
          this.sendJson({
            type: "speech_text_buffer.commit",
            text: clean,
          });
        }
        break;
      }
      case "text_input": {
        this.sendJson({
          type: "conversation.item.create",
          items: [
            { type: "message", role: "user", content: [{ type: "input_text", text: msg.text }] },
          ],
        });
        break;
      }
      case "tool_result": {
        this.sendJson({
          type: "conversation.item.create",
          items: [
            {
              call_id: msg.call_id,
              role: "tool",
              content: [{ type: "input_text", text: JSON.stringify(msg.output) }],
            },
          ],
        });
        break;
      }
      case "barge_in": {
        // Send ByteDance cancel signal to stop current playback and generation immediately
        this.sendJson({ type: "response.cancel" });
        this.options.onDownMessage({ type: "interrupted", reason: "user_barge_in" });
        this.options.onDownMessage({ type: "state_change", state: "listening" });
        break;
      }
      case "session_close": {
        await this.close();
        break;
      }
    }
  }

  public async close(): Promise<void> {
    if (this.closedByUs) return;
    this.closedByUs = true;
    this.stopPacer();

    if (this.ws && this.isConnected) {
      this.sendJson({ type: "session.close" });
      this.ws.close();
    }
    this.ws = null;
    this.isConnected = false;
  }

  private pushAudio(pcm: Buffer): void {
    for (let i = 0; i + FRAME_BYTES <= pcm.length; i += FRAME_BYTES) {
      this.audioQueue.push(pcm.subarray(i, i + FRAME_BYTES));
    }
    const tail = pcm.length % FRAME_BYTES;
    if (tail) {
      this.audioQueue.push(
        Buffer.concat([pcm.subarray(pcm.length - tail), Buffer.alloc(FRAME_BYTES - tail)])
      );
    }
    if (this.audioQueue.length > MAX_AUDIO_QUEUE_FRAMES) {
      this.audioQueue.splice(0, this.audioQueue.length - MAX_AUDIO_QUEUE_FRAMES);
    }
  }

  private startPacer(): void {
    this.nextTick = Date.now() + FRAME_MS;
    const tick = () => {
      if (!this.ws || !this.isConnected) return;
      if (!this.muted) {
        const frame = this.audioQueue.shift() ?? Buffer.alloc(FRAME_BYTES);
        this.sendJson({
          type: "input_audio_buffer.append",
          audio: frame.toString("base64"),
        });
      }
      this.nextTick += FRAME_MS;
      const delay = Math.max(1, this.nextTick - Date.now());
      if (delay > FRAME_MS * 2) this.nextTick = Date.now() + FRAME_MS;
      this.paceTimer = setTimeout(tick, delay);
    };
    this.paceTimer = setTimeout(tick, FRAME_MS);
  }

  private stopPacer(): void {
    if (this.paceTimer) {
      clearTimeout(this.paceTimer);
      this.paceTimer = null;
    }
  }

  private setMuted(muted: boolean): void {
    if (this.muted === muted) return;
    this.muted = muted;
    this.commitMute(muted);
    if (!muted) {
      this.audioQueue = [];
      this.options.onDownMessage({ type: "state_change", state: "listening" });
    } else {
      this.options.onDownMessage({ type: "state_change", state: "thinking" });
    }
  }

  private commitMute(muted: boolean): void {
    if (this.serverMuted === muted) return;
    this.serverMuted = muted;
    this.sendJson({
      type: muted ? "input_audio_mute.commit" : "input_audio_unmute.commit",
    });
  }

  private sendJson(obj: unknown): void {
    if (this.ws) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  private handleServerMessage(raw: unknown): void {
    try {
      const data = typeof raw === "string" ? raw : String(raw);
      const evt = JSON.parse(data);
      const type = String(evt.type ?? "");

      if (type === "session.created" || type === "session.updated") {
        const sid = String(evt.session?.id ?? evt.session_id ?? this.sessionId);
        this.sessionId = sid;
        // Re-sync current mute state after server confirms session creation
        this.serverMuted = undefined;
        this.commitMute(this.muted);
        this.options.onDownMessage({
          type: "session_ready",
          session_id: sid,
          provider: "doubao",
        });
      } else if (type === "response.output_audio.delta") {
        const b64 = String(evt.delta ?? "");
        if (b64) {
          this.options.onDownMessage({
            type: "audio_chunk",
            pcm_base64: b64,
            sample_rate: OUTPUT_SAMPLE_RATE,
            sequence: Number(evt.sequence ?? 0),
          });
        }
      } else if (type === "response.output_audio.started") {
        this.options.onDownMessage({ type: "state_change", state: "speaking" });
      } else if (type === "response.output_audio.done") {
        this.options.onDownMessage({
          type: "state_change",
          state: this.muted ? "idle" : "listening",
        });
      } else if (type === "response.output_text.delta" || type === "response.output_text.done") {
        const text = String(evt.text ?? evt.delta ?? "");
        if (text) {
          this.options.onDownMessage({
            type: "transcript",
            text,
            is_final: type === "response.output_text.done",
            role: "assistant",
          });
        }
      } else if (type.includes("transcription")) {
        const text = String(evt.text ?? evt.transcript ?? evt.delta ?? "");
        if (text.trim()) {
          this.options.onDownMessage({
            type: "transcript",
            text,
            is_final: type.endsWith("completed") || type.endsWith("done"),
            role: "user",
          });
        }
      } else if (type === "response.function_call_arguments.done") {
        const items = Array.isArray(evt.items) ? evt.items : [evt];
        for (const item of items) {
          const callId = String(item.call_id ?? item.id ?? "");
          const name = String(item.name ?? "");
          let args: JsonObject = {};
          try {
            args = JSON.parse(String(item.arguments ?? "{}"));
          } catch {
            args = {};
          }
          if (callId && name) {
            this.options.onDownMessage({
              type: "tool_call",
              call_id: callId,
              name,
              arguments: args,
            });
          }
        }
      } else if (type.includes("speech_started") || type.includes("input_audio_buffer.speech")) {
        this.options.onDownMessage({ type: "interrupted", reason: "speech_started" });
        this.options.onDownMessage({ type: "state_change", state: "listening" });
      } else if (type === "error" || type === "session.error") {
        this.options.onDownMessage({
          type: "error",
          code: String(evt.code ?? "duplex_error"),
          message: String(evt.message ?? JSON.stringify(evt)),
        });
      }
    } catch {
      // non-JSON frame
    }
  }
}

export class DoubaoVoiceProvider implements VoiceProvider {
  readonly kind: VoiceProviderKind = "doubao";
  readonly name = "ByteDance OpenSpeech Duplex";

  constructor(private readonly config: DoubaoEngineConfig = {}) {}

  async createSession(options: VoiceSessionOptions): Promise<VoiceSessionHandle> {
    const session = new DoubaoVoiceSession(options.sessionId, options, this.config);
    await session.open();
    return session;
  }
}
