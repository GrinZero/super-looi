import SherpaOnnx from "@siteed/sherpa-onnx.rn";
import {
  DEFAULT_PUNCT_MODEL_FILE,
  checkSherpaModelFiles,
  formatSherpaModelError,
  formatSherpaModelUserMessage,
  resolveSherpaModelDir,
} from "./sherpa-models";
import { getSherpaPunctuationConfig } from "./sherpa-adapter";

export class PunctuationService {
  private initialized = false;
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

  async addPunctuation(text: string): Promise<string> {
    const normalized = text.trim();
    if (normalized.length < 3) return normalized;

    await this.init();
    const result = await SherpaOnnx.Punctuation.addPunctuation(normalized);
    if (!result.success) {
      throw new Error(result.error || "Sherpa punctuation failed");
    }
    return result.text?.trim() || normalized;
  }

  async release(): Promise<void> {
    if (!this.initialized && !this.initializing) return;
    await this.initializing?.catch(() => undefined);
    await SherpaOnnx.Punctuation.release().catch(() => undefined);
    this.initialized = false;
  }

  private async initInternal(): Promise<void> {
    const config = getSherpaPunctuationConfig();
    const modelFile = config.model || DEFAULT_PUNCT_MODEL_FILE;
    const check = await checkSherpaModelFiles("punctuation", config.modelDir, [modelFile]);
    if (!check.ready) {
      console.warn(formatSherpaModelError(check));
      throw new Error(formatSherpaModelUserMessage(check));
    }

    const result = await SherpaOnnx.Punctuation.init({
      ...config,
      modelDir: resolveSherpaModelDir(config.modelDir),
    });
    if (!result.success) {
      throw new Error(result.error || "Sherpa punctuation initialization failed");
    }

    this.initialized = true;
  }
}

export const punctuationService = new PunctuationService();
