import * as FileSystem from "expo-file-system/legacy";

export type SherpaModelKind =
  | "asr"
  | "streamingAsr"
  | "punctuation"
  | "kws"
  | "speaker"
  | "vad";

export interface SherpaModelCheck {
  kind: SherpaModelKind;
  modelDir: string;
  absoluteModelDir: string;
  missingFiles: string[];
  ready: boolean;
}

const SHERPA_DOCUMENT_ROOT = `${FileSystem.documentDirectory ?? ""}sherpa-onnx/`;
export const DEFAULT_STREAMING_ASR_MODEL_DIR = "sherpa-onnx/asr/streaming-paraformer";
export const DEFAULT_STREAMING_ASR_ENCODER = "encoder.int8.onnx";
export const DEFAULT_STREAMING_ASR_DECODER = "decoder.int8.onnx";
export const DEFAULT_STREAMING_ASR_TOKENS_FILE = "tokens.txt";
export const DEFAULT_PUNCT_MODEL_DIR = "sherpa-onnx/punctuation";
export const DEFAULT_PUNCT_MODEL_FILE = "model.int8.onnx";
const DEFAULT_KWS_MODEL_DIR = "sherpa-onnx/kws/looi";
const DEFAULT_SPEAKER_MODEL_DIR = "sherpa-onnx/speaker-id/looi";
const DEFAULT_SPEAKER_MODEL_FILE = "model.onnx";
export const DEFAULT_VAD_MODEL_DIR = "sherpa-onnx/vad";
export const DEFAULT_VAD_MODEL_FILE = "silero_vad.onnx";
const DEFAULT_KEYWORDS_FILE = "keywords.txt";
const DEFAULT_KWS_ENCODER_FILE = "encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx";
const DEFAULT_KWS_DECODER_FILE = "decoder-epoch-12-avg-2-chunk-16-left-64.onnx";
const DEFAULT_KWS_JOINER_FILE = "joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx";
const DEFAULT_KWS_TOKENS_FILE = "tokens.txt";
const SHERPA_MODEL_DOWNLOAD_HINT =
  "请在设置页的“语音模型 / KWS”中下载模型，下载完成后重新开始语音服务。";

function env(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

export function resolveSherpaModelDir(modelDir: string): string {
  if (modelDir.startsWith("file://") || modelDir.startsWith("/")) {
    return modelDir.endsWith("/") ? modelDir : `${modelDir}/`;
  }

  const normalized = modelDir.replace(/^sherpa-onnx\//, "");
  return `${SHERPA_DOCUMENT_ROOT}${normalized.replace(/\/$/, "")}/`;
}

export async function checkSherpaModelFiles(
  kind: SherpaModelKind,
  modelDir: string,
  requiredFiles: string[]
): Promise<SherpaModelCheck> {
  const absoluteModelDir = resolveSherpaModelDir(modelDir);
  const missingFiles: string[] = [];

  for (const filename of requiredFiles) {
    const info = await FileSystem.getInfoAsync(`${absoluteModelDir}${filename}`);
    if (!info.exists || (info.size ?? 0) === 0) {
      missingFiles.push(filename);
    }
  }

  return {
    kind,
    modelDir,
    absoluteModelDir,
    missingFiles,
    ready: missingFiles.length === 0,
  };
}

export function formatSherpaModelError(check: SherpaModelCheck): string {
  return [
    `Sherpa ${check.kind} model files are missing in ${check.absoluteModelDir}`,
    `Missing: ${check.missingFiles.join(", ")}`,
    SHERPA_MODEL_DOWNLOAD_HINT,
  ].join(". ");
}

export function formatSherpaModelUserMessage(check: SherpaModelCheck): string {
  const labelByKind: Record<SherpaModelKind, string> = {
    asr: "语音识别",
    streamingAsr: "流式语音识别",
    punctuation: "标点恢复",
    kws: "唤醒词",
    speaker: "声纹",
    vad: "语音端点检测",
  };
  return `${labelByKind[check.kind]}模型缺失，请先在设置页下载语音模型。缺失：${check.missingFiles.join(", ")}`;
}

export async function checkAllSherpaModelReadiness(): Promise<{
  asr: SherpaModelCheck;
  streamingAsr: SherpaModelCheck;
  punctuation: SherpaModelCheck;
  kws: SherpaModelCheck;
  speaker: SherpaModelCheck;
  vad: SherpaModelCheck;
}> {
  const { installBundledSherpaModels } = await import("./sherpa-bundled-models");
  await installBundledSherpaModels().catch((error) => {
    console.warn("[SherpaModels] Failed to install bundled model assets:", error);
  });

  const streamingAsrModelDir = env(
    "EXPO_PUBLIC_SHERPA_STREAMING_ASR_MODEL_DIR",
    DEFAULT_STREAMING_ASR_MODEL_DIR
  );
  const punctuationModelDir = env("EXPO_PUBLIC_SHERPA_PUNCT_MODEL_DIR", DEFAULT_PUNCT_MODEL_DIR);
  const kwsModelDir = env("EXPO_PUBLIC_SHERPA_KWS_MODEL_DIR", DEFAULT_KWS_MODEL_DIR);
  const speakerModelDir = env("EXPO_PUBLIC_SHERPA_SPEAKER_MODEL_DIR", DEFAULT_SPEAKER_MODEL_DIR);
  const vadModelDir = env("EXPO_PUBLIC_SHERPA_VAD_MODEL_DIR", DEFAULT_VAD_MODEL_DIR);

  const streamingAsr = await checkSherpaModelFiles("streamingAsr", streamingAsrModelDir, [
    env("EXPO_PUBLIC_SHERPA_STREAMING_ASR_ENCODER", DEFAULT_STREAMING_ASR_ENCODER),
    env("EXPO_PUBLIC_SHERPA_STREAMING_ASR_DECODER", DEFAULT_STREAMING_ASR_DECODER),
    env("EXPO_PUBLIC_SHERPA_STREAMING_ASR_TOKENS_FILE", DEFAULT_STREAMING_ASR_TOKENS_FILE),
  ]);

  return {
    asr: streamingAsr,
    streamingAsr,
    punctuation: await checkSherpaModelFiles("punctuation", punctuationModelDir, [
      env("EXPO_PUBLIC_SHERPA_PUNCT_MODEL_FILE", DEFAULT_PUNCT_MODEL_FILE),
    ]),
    kws: await checkSherpaModelFiles("kws", kwsModelDir, [
      env("EXPO_PUBLIC_SHERPA_KWS_ENCODER_FILE", DEFAULT_KWS_ENCODER_FILE),
      env("EXPO_PUBLIC_SHERPA_KWS_DECODER_FILE", DEFAULT_KWS_DECODER_FILE),
      env("EXPO_PUBLIC_SHERPA_KWS_JOINER_FILE", DEFAULT_KWS_JOINER_FILE),
      env("EXPO_PUBLIC_SHERPA_KWS_TOKENS_FILE", DEFAULT_KWS_TOKENS_FILE),
      env("EXPO_PUBLIC_SHERPA_KEYWORDS_FILE", DEFAULT_KEYWORDS_FILE),
    ]),
    speaker: await checkSherpaModelFiles("speaker", speakerModelDir, [
      env("EXPO_PUBLIC_SHERPA_SPEAKER_MODEL_FILE", DEFAULT_SPEAKER_MODEL_FILE),
    ]),
    vad: await checkSherpaModelFiles("vad", vadModelDir, [
      env("EXPO_PUBLIC_SHERPA_VAD_MODEL_FILE", DEFAULT_VAD_MODEL_FILE),
    ]),
  };
}
