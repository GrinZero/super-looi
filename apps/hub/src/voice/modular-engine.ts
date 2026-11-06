import type { AgentStepEvent } from "../agent/executor.js";
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

export interface AsrEngine {
  transcribe(audioPcm: Buffer): Promise<string>;
}

export interface LlmBrainEngine {
  generate(
    prompt: string,
    options?: { systemPrompt?: string; onStep?: (step: AgentStepEvent) => void }
  ): AsyncIterable<{
    text?: string;
    toolCall?: { id: string; name: string; args: JsonObject };
  }>;
}

export interface TtsEngine {
  synthesizeStream(text: string): AsyncIterable<Buffer>;
}

export class DefaultAsrEngine implements AsrEngine {
  async transcribe(audioPcm: Buffer): Promise<string> {
    if (audioPcm.length === 0) return "";
    return "打开书房灯并查看桌面";
  }
}

export class DefaultLlmBrainEngine implements LlmBrainEngine {
  async *generate(
    prompt: string,
    _options?: { systemPrompt?: string; onStep?: (step: AgentStepEvent) => void }
  ): AsyncIterable<{ text?: string; toolCall?: { id: string; name: string; args: JsonObject } }> {
    if (prompt.includes("灯")) {
      yield {
        toolCall: {
          id: `call_${Date.now()}`,
          name: "home.set_state",
          args: { entity_id: "light.study_ceiling", service: "turn_on" },
        },
      };
      yield { text: "好的，已为你开启书房灯。" };
    } else {
      yield { text: `我听到了：${prompt}。` };
    }
  }
}

export class DefaultTtsEngine implements TtsEngine {
  async *synthesizeStream(_text: string): AsyncIterable<Buffer> {
    // Generate 2 chunks of simulated 24kHz PCM silence/tone (24000 * 2 bytes/sec = 48000 B/s)
    // 200ms = 9600 bytes
    const chunk = Buffer.alloc(4800, 0x10);
    yield chunk;
    yield chunk;
  }
}

export interface ModularEngineOptions {
  asr?: AsrEngine;
  llm?: LlmBrainEngine;
  tts?: TtsEngine;
}

export class ModularVoiceSession implements VoiceSessionHandle {
  public sessionId: string;
  private pcmBuffer: Buffer[] = [];
  private isProcessing = false;
  private currentAbortController: AbortController | null = null;
  private isClosed = false;

  constructor(
    id: string,
    private readonly options: VoiceSessionOptions,
    private readonly asr: AsrEngine,
    private readonly llm: LlmBrainEngine,
    private readonly tts: TtsEngine
  ) {
    this.sessionId = id;
    this.options.onDownMessage({
      type: "session_ready",
      session_id: id,
      provider: "modular",
    });
  }

  public async sendUpMessage(msg: VoiceUpMessage): Promise<void> {
    if (this.isClosed) return;

    switch (msg.type) {
      case "audio_chunk": {
        const chunk = Buffer.from(msg.pcm_base64, "base64");
        this.pcmBuffer.push(chunk);
        break;
      }
      case "unmute_commit": {
        this.options.onDownMessage({ type: "state_change", state: "listening" });
        break;
      }
      case "mute_commit": {
        await this.processTurn();
        break;
      }
      case "text_input": {
        await this.processPrompt(msg.text);
        break;
      }
      case "speak_text": {
        await this.streamTts(msg.text);
        break;
      }
      case "tool_result": {
        await this.processPrompt(`工具执行结果: ${JSON.stringify(msg.output)}`);
        break;
      }
      case "barge_in": {
        this.abortInFlight();
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
    this.isClosed = true;
    this.abortInFlight();
    this.pcmBuffer = [];
    this.options.onDownMessage({ type: "state_change", state: "idle" });
  }

  private abortInFlight(): void {
    if (this.currentAbortController) {
      this.currentAbortController.abort();
      this.currentAbortController = null;
    }
    this.isProcessing = false;
  }

  private async processTurn(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;
    this.currentAbortController = new AbortController();

    try {
      this.options.onDownMessage({ type: "state_change", state: "thinking" });

      const fullPcm = Buffer.concat(this.pcmBuffer);
      this.pcmBuffer = [];

      const transcript = await this.asr.transcribe(fullPcm);
      if (!transcript.trim()) {
        this.options.onDownMessage({ type: "state_change", state: "idle" });
        return;
      }

      this.options.onDownMessage({
        type: "transcript",
        text: transcript,
        is_final: true,
        role: "user",
      });

      await this.runLlmAndTts(transcript);
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        this.options.onDownMessage({
          type: "error",
          code: "modular_pipeline_error",
          message: (err as Error).message,
        });
      }
    } finally {
      this.isProcessing = false;
      this.currentAbortController = null;
    }
  }

  private async processPrompt(prompt: string): Promise<void> {
    this.abortInFlight();
    this.isProcessing = true;
    this.currentAbortController = new AbortController();

    try {
      this.options.onDownMessage({ type: "state_change", state: "thinking" });
      await this.runLlmAndTts(prompt);
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        this.options.onDownMessage({
          type: "error",
          code: "modular_llm_error",
          message: (err as Error).message,
        });
      }
    } finally {
      this.isProcessing = false;
      this.currentAbortController = null;
    }
  }

  private async runLlmAndTts(prompt: string): Promise<void> {
    const stream = this.llm.generate(prompt, { onStep: step => this.options.onDownMessage({
      type: "agent_status", phase: step.phase, tool: step.toolName ?? "agent", summary: step.summary,
      task_id: step.taskId, session_id: step.sessionId, interaction: step.interaction as unknown as JsonObject | undefined,
    }) });
    for await (const chunk of stream) {
      if (this.currentAbortController?.signal.aborted) {
        throw new Error("AbortError");
      }

      if (chunk.toolCall) {
        this.options.onDownMessage({
          type: "tool_call",
          call_id: chunk.toolCall.id,
          name: chunk.toolCall.name,
          arguments: chunk.toolCall.args,
        });
      }

      if (chunk.text) {
        this.options.onDownMessage({
          type: "transcript",
          text: chunk.text,
          is_final: true,
          role: "assistant",
        });
        await this.streamTts(chunk.text);
      }
    }

    if (!this.currentAbortController?.signal.aborted) {
      this.options.onDownMessage({ type: "state_change", state: "idle" });
    }
  }

  private async streamTts(text: string): Promise<void> {
    this.options.onDownMessage({ type: "state_change", state: "speaking" });

    let seq = 0;
    const ttsStream = this.tts.synthesizeStream(text);
    for await (const pcm of ttsStream) {
      if (this.currentAbortController?.signal.aborted) {
        throw new Error("AbortError");
      }

      this.options.onDownMessage({
        type: "audio_chunk",
        pcm_base64: pcm.toString("base64"),
        sample_rate: 24000,
        sequence: seq++,
      });
    }
  }
}

export class ModularVoiceProvider implements VoiceProvider {
  readonly kind: VoiceProviderKind = "modular";
  readonly name = "Modular Pipeline (ASR + LLM + TTS)";

  private readonly asr: AsrEngine;
  private readonly llm: LlmBrainEngine;
  private readonly tts: TtsEngine;

  constructor(options: ModularEngineOptions = {}) {
    this.asr = options.asr ?? new DefaultAsrEngine();
    this.llm = options.llm ?? new DefaultLlmBrainEngine();
    this.tts = options.tts ?? new DefaultTtsEngine();
  }

  async createSession(options: VoiceSessionOptions): Promise<VoiceSessionHandle> {
    return new ModularVoiceSession(options.sessionId, options, this.asr, this.llm, this.tts);
  }
}
