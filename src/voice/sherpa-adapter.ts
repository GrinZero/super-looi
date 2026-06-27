import SherpaOnnx, {
  type AsrModelConfig,
  type KWSModelConfig,
  type SpeakerIdModelConfig,
} from "@siteed/sherpa-onnx.rn";
import {
  checkSherpaModelFiles,
  formatSherpaModelError,
  resolveSherpaModelDir,
} from "./sherpa-models";

const DEFAULT_STT_MODEL_DIR = "sherpa-onnx/asr/sensevoice";
const DEFAULT_STT_MODEL_FILE = "model.int8.onnx";
const DEFAULT_STT_TOKENS_FILE = "tokens.txt";
const DEFAULT_KWS_MODEL_DIR = "sherpa-onnx/kws/looi";
const DEFAULT_SPEAKER_MODEL_DIR = "sherpa-onnx/speaker-id/looi";
const DEFAULT_SPEAKER_MODEL_FILE = "model.onnx";
const DEFAULT_KEYWORDS_FILE = "keywords.txt";
const DEFAULT_SAMPLE_RATE = 16000;
const DEFAULT_KWS_ENCODER_FILE = "encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx";
const DEFAULT_KWS_DECODER_FILE = "decoder-epoch-12-avg-2-chunk-16-left-64.onnx";
const DEFAULT_KWS_JOINER_FILE = "joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx";
const DEFAULT_KWS_TOKENS_FILE = "tokens.txt";
const ASR_REQUIRED_FILES = [DEFAULT_STT_MODEL_FILE, DEFAULT_STT_TOKENS_FILE];
const KWS_REQUIRED_FILES = [
  DEFAULT_KWS_ENCODER_FILE,
  DEFAULT_KWS_DECODER_FILE,
  DEFAULT_KWS_JOINER_FILE,
  DEFAULT_KWS_TOKENS_FILE,
  DEFAULT_KEYWORDS_FILE,
];
const SPEAKER_REQUIRED_FILES = [DEFAULT_SPEAKER_MODEL_FILE];

function env(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

function parseIntEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getAsrRequiredFiles(config: AsrModelConfig): string[] {
  return [
    config.modelFiles?.model || DEFAULT_STT_MODEL_FILE,
    config.modelFiles?.tokens || DEFAULT_STT_TOKENS_FILE,
  ];
}

function getKwsRequiredFiles(config: KWSModelConfig): string[] {
  return [
    config.modelFiles?.encoder || KWS_REQUIRED_FILES[0],
    config.modelFiles?.decoder || KWS_REQUIRED_FILES[1],
    config.modelFiles?.joiner || KWS_REQUIRED_FILES[2],
    config.modelFiles?.tokens || KWS_REQUIRED_FILES[3],
    config.keywordsFile || DEFAULT_KEYWORDS_FILE,
  ];
}

function getSpeakerRequiredFiles(config: SpeakerIdModelConfig): string[] {
  return [config.modelFile || DEFAULT_SPEAKER_MODEL_FILE];
}

function withResolvedModelDir<T extends { modelDir: string }>(config: T): T {
  return {
    ...config,
    modelDir: resolveSherpaModelDir(config.modelDir),
  };
}

export function getSherpaAsrConfig(): AsrModelConfig {
  return {
    modelDir: env("EXPO_PUBLIC_SHERPA_STT_MODEL_DIR", DEFAULT_STT_MODEL_DIR),
    modelType: "sense_voice",
    streaming: false,
    language: env("EXPO_PUBLIC_SHERPA_STT_LANGUAGE", "zh"),
    useItn: true,
    numThreads: parseIntEnv("EXPO_PUBLIC_SHERPA_NUM_THREADS", 2),
    decodingMethod: "greedy_search",
    modelFiles: {
      model: env("EXPO_PUBLIC_SHERPA_STT_MODEL_FILE", DEFAULT_STT_MODEL_FILE),
      tokens: env("EXPO_PUBLIC_SHERPA_STT_TOKENS_FILE", DEFAULT_STT_TOKENS_FILE),
    },
    provider: "cpu",
  };
}

export function getSherpaKwsConfig(): KWSModelConfig {
  return {
    modelDir: env("EXPO_PUBLIC_SHERPA_KWS_MODEL_DIR", DEFAULT_KWS_MODEL_DIR),
    keywordsFile: env("EXPO_PUBLIC_SHERPA_KEYWORDS_FILE", DEFAULT_KEYWORDS_FILE),
    modelType: env("EXPO_PUBLIC_SHERPA_KWS_MODEL_TYPE", "zipformer2"),
    numThreads: parseIntEnv("EXPO_PUBLIC_SHERPA_NUM_THREADS", 2),
    provider: "cpu",
    modelFiles: {
      encoder: env("EXPO_PUBLIC_SHERPA_KWS_ENCODER_FILE", DEFAULT_KWS_ENCODER_FILE),
      decoder: env("EXPO_PUBLIC_SHERPA_KWS_DECODER_FILE", DEFAULT_KWS_DECODER_FILE),
      joiner: env("EXPO_PUBLIC_SHERPA_KWS_JOINER_FILE", DEFAULT_KWS_JOINER_FILE),
      tokens: env("EXPO_PUBLIC_SHERPA_KWS_TOKENS_FILE", DEFAULT_KWS_TOKENS_FILE),
    },
  };
}

export function getSherpaSpeakerConfig(): SpeakerIdModelConfig {
  return {
    modelDir: env("EXPO_PUBLIC_SHERPA_SPEAKER_MODEL_DIR", DEFAULT_SPEAKER_MODEL_DIR),
    modelFile: env("EXPO_PUBLIC_SHERPA_SPEAKER_MODEL_FILE", DEFAULT_SPEAKER_MODEL_FILE),
    sampleRate: DEFAULT_SAMPLE_RATE,
    numThreads: parseIntEnv("EXPO_PUBLIC_SHERPA_NUM_THREADS", 2),
    provider: "cpu",
  };
}

export class SherpaVoiceAdapter {
  private asrReady = false;
  private kwsReady = false;
  private speakerReady = false;

  async initializeAsr(config: AsrModelConfig = getSherpaAsrConfig()): Promise<void> {
    if (this.asrReady) return;
    const nativeConfig = withResolvedModelDir(config);
    await this.assertModelFilesReady("asr", nativeConfig.modelDir, getAsrRequiredFiles(nativeConfig));
    const result = await SherpaOnnx.ASR.initialize(nativeConfig);
    if (!result.success) {
      throw new Error(result.error || "Sherpa ASR initialization failed");
    }
    this.asrReady = true;
  }

  async transcribeFile(fileUri: string): Promise<string> {
    await this.initializeAsr();
    const result = await SherpaOnnx.ASR.recognizeFromFile(fileUri);
    if (!result.success) {
      throw new Error(result.error || "Sherpa ASR recognition failed");
    }
    return result.text?.trim() || "";
  }

  async initializeKws(config: KWSModelConfig = getSherpaKwsConfig()): Promise<void> {
    if (this.kwsReady) return;
    const nativeConfig = withResolvedModelDir(config);
    await this.assertModelFilesReady("kws", nativeConfig.modelDir, getKwsRequiredFiles(nativeConfig));
    const result = await SherpaOnnx.KWS.init(nativeConfig);
    if (!result.success) {
      throw new Error(result.error || "Sherpa KWS initialization failed");
    }
    this.kwsReady = true;
  }

  async acceptKwsSamples(samples: number[], sampleRate = DEFAULT_SAMPLE_RATE) {
    await this.initializeKws();
    return SherpaOnnx.KWS.acceptWaveform(sampleRate, samples);
  }

  async initializeSpeaker(
    config: SpeakerIdModelConfig = getSherpaSpeakerConfig()
  ): Promise<void> {
    if (this.speakerReady) return;
    const nativeConfig = withResolvedModelDir(config);
    await this.assertModelFilesReady(
      "speaker",
      nativeConfig.modelDir,
      getSpeakerRequiredFiles(nativeConfig)
    );
    const result = await SherpaOnnx.SpeakerId.init(nativeConfig);
    if (!result.success) {
      throw new Error(result.error || "Sherpa Speaker ID initialization failed");
    }
    this.speakerReady = true;
  }

  async computeSpeakerEmbedding(samples: number[], sampleRate = DEFAULT_SAMPLE_RATE): Promise<number[]> {
    await this.initializeSpeaker();
    const processResult = await SherpaOnnx.SpeakerId.processSamples(sampleRate, samples);
    if (!processResult.success) {
      throw new Error(processResult.error || "Sherpa speaker sample processing failed");
    }
    const embedding = await SherpaOnnx.SpeakerId.computeEmbedding();
    if (!embedding.success) {
      throw new Error(embedding.error || "Sherpa speaker embedding failed");
    }
    return embedding.embedding;
  }

  async computeSpeakerFileEmbedding(fileUri: string): Promise<number[]> {
    await this.initializeSpeaker();
    const result = await SherpaOnnx.SpeakerId.processFile(fileUri);
    if (!result.success) {
      throw new Error(result.error || "Sherpa speaker file processing failed");
    }
    return result.embedding;
  }

  async registerSpeaker(name: string, embedding: number[]): Promise<void> {
    await this.initializeSpeaker();
    const speakers = await SherpaOnnx.SpeakerId.getSpeakers();
    if (!speakers.success) {
      throw new Error(speakers.error || "Sherpa speaker list failed");
    }
    if (speakers.speakers.includes(name)) {
      const removed = await SherpaOnnx.SpeakerId.removeSpeaker(name);
      if (!removed.success) {
        throw new Error(removed.error || "Sherpa speaker removal failed");
      }
    }
    const result = await SherpaOnnx.SpeakerId.registerSpeaker(name, embedding);
    if (!result.success) {
      throw new Error(result.error || "Sherpa speaker registration failed");
    }
  }

  async hasSpeaker(name: string): Promise<boolean> {
    await this.initializeSpeaker();
    const result = await SherpaOnnx.SpeakerId.getSpeakers();
    if (!result.success) {
      throw new Error(result.error || "Sherpa speaker list failed");
    }
    return result.speakers.includes(name);
  }

  async verifySpeaker(name: string, embedding: number[], threshold: number): Promise<boolean> {
    await this.initializeSpeaker();
    const result = await SherpaOnnx.SpeakerId.verifySpeaker(name, embedding, threshold);
    if (!result.success) {
      throw new Error(result.error || "Sherpa speaker verification failed");
    }
    return result.verified;
  }

  async checkModelReadiness() {
    const asrConfig = getSherpaAsrConfig();
    const kwsConfig = getSherpaKwsConfig();
    const speakerConfig = getSherpaSpeakerConfig();

    return {
      asr: await checkSherpaModelFiles(
        "asr",
        resolveSherpaModelDir(asrConfig.modelDir),
        getAsrRequiredFiles(asrConfig)
      ),
      kws: await checkSherpaModelFiles(
        "kws",
        resolveSherpaModelDir(kwsConfig.modelDir),
        getKwsRequiredFiles(kwsConfig)
      ),
      speaker: await checkSherpaModelFiles(
        "speaker",
        resolveSherpaModelDir(speakerConfig.modelDir),
        getSpeakerRequiredFiles(speakerConfig)
      ),
    };
  }

  private async assertModelFilesReady(
    kind: "asr" | "kws" | "speaker",
    modelDir: string,
    requiredFiles: string[]
  ): Promise<void> {
    const check = await checkSherpaModelFiles(kind, modelDir, requiredFiles);
    if (!check.ready) {
      throw new Error(formatSherpaModelError(check));
    }
  }
}

export const sherpaVoiceAdapter = new SherpaVoiceAdapter();
