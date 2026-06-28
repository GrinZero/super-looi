import SherpaOnnx from "@siteed/sherpa-onnx.rn";
import {
  DEFAULT_STREAMING_ASR_DECODER,
  DEFAULT_STREAMING_ASR_ENCODER,
  DEFAULT_STREAMING_ASR_TOKENS_FILE,
  checkSherpaModelFiles,
  formatSherpaModelError,
  formatSherpaModelUserMessage,
  resolveSherpaModelDir,
} from "./sherpa-models";
import { getSherpaAsrConfig } from "./sherpa-adapter";

const DEFAULT_SAMPLE_RATE = 16000;

export type StreamingResult = {
  text: string;
  isEndpoint: boolean;
};

export class StreamingSTTService {
  private initialized = false;
  private streamReady = false;
  private initializing: Promise<void> | null = null;

  async init(): Promise<void> {
    if (this.initialized) return;
    if (this.initializing) return this.initializing;

    this.initializing = this.initInternal();
    try {
      await this.initializing;
    } finally {
      this.initializing = null;
    }
  }

  async createStream(): Promise<void> {
    await this.init();
    const result = await SherpaOnnx.ASR.createOnlineStream();
    if (!result.success) {
      throw new Error("Sherpa streaming ASR stream creation failed");
    }
    this.streamReady = true;
  }

  async acceptSamples(
    samples: number[],
    sampleRate = DEFAULT_SAMPLE_RATE
  ): Promise<StreamingResult> {
    if (samples.length === 0) {
      return { text: "", isEndpoint: false };
    }
    if (!this.streamReady) {
      await this.createStream();
    }

    const accepted = await SherpaOnnx.ASR.acceptWaveform(sampleRate, samples);
    if (!accepted.success) {
      throw new Error("Sherpa streaming ASR waveform processing failed");
    }

    const [result, endpoint] = await Promise.all([
      SherpaOnnx.ASR.getResult(),
      SherpaOnnx.ASR.isEndpoint(),
    ]);

    return {
      text: result.text?.trim() || "",
      isEndpoint: endpoint.isEndpoint,
    };
  }

  async isEndpoint(): Promise<boolean> {
    if (!this.streamReady) return false;
    const result = await SherpaOnnx.ASR.isEndpoint();
    return result.isEndpoint;
  }

  async resetStream(): Promise<void> {
    if (!this.streamReady) return;
    const result = await SherpaOnnx.ASR.resetStream();
    if (!result.success) {
      throw new Error("Sherpa streaming ASR stream reset failed");
    }
  }

  async finishInput(): Promise<string> {
    if (!this.streamReady) return "";
    const finished = await SherpaOnnx.ASR.finishInput();
    if (!finished.success) {
      throw new Error(finished.error || "Sherpa streaming ASR finish input failed");
    }
    const result = await SherpaOnnx.ASR.getResult();
    return result.text?.trim() || "";
  }

  async release(): Promise<void> {
    if (!this.initialized && !this.initializing) return;
    await this.initializing?.catch(() => undefined);
    await SherpaOnnx.ASR.release().catch(() => undefined);
    this.initialized = false;
    this.streamReady = false;
  }

  private async initInternal(): Promise<void> {
    const config = getSherpaAsrConfig();
    const modelFiles = config.modelFiles ?? {};
    const check = await checkSherpaModelFiles("streamingAsr", config.modelDir, [
      modelFiles.encoder || DEFAULT_STREAMING_ASR_ENCODER,
      modelFiles.decoder || DEFAULT_STREAMING_ASR_DECODER,
      modelFiles.tokens || DEFAULT_STREAMING_ASR_TOKENS_FILE,
    ]);
    if (!check.ready) {
      console.warn(formatSherpaModelError(check));
      throw new Error(formatSherpaModelUserMessage(check));
    }

    const result = await SherpaOnnx.ASR.initialize({
      ...config,
      modelDir: resolveSherpaModelDir(config.modelDir),
    });
    if (!result.success) {
      throw new Error(result.error || "Sherpa streaming ASR initialization failed");
    }

    this.initialized = true;
  }
}

export const streamingSttService = new StreamingSTTService();
