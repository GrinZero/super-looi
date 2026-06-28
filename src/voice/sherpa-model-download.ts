import SherpaOnnx from "@siteed/sherpa-onnx.rn";
import * as FileSystem from "expo-file-system/legacy";
import {
  checkAllSherpaModelReadiness,
  DEFAULT_PUNCT_MODEL_DIR,
  DEFAULT_PUNCT_MODEL_FILE,
  DEFAULT_STREAMING_ASR_DECODER,
  DEFAULT_STREAMING_ASR_ENCODER,
  DEFAULT_STREAMING_ASR_MODEL_DIR,
  DEFAULT_STREAMING_ASR_TOKENS_FILE,
  DEFAULT_VAD_MODEL_DIR,
  DEFAULT_VAD_MODEL_FILE,
  resolveSherpaModelDir,
  type SherpaModelCheck,
} from "./sherpa-models";
import { installBundledSherpaModels } from "./sherpa-bundled-models";

type DownloadStage =
  | "checking"
  | "streaming-asr-archive"
  | "streaming-asr-extract"
  | "streaming-asr-copy"
  | "kws-archive"
  | "kws-extract"
  | "kws-copy"
  | "speaker"
  | "vad"
  | "punctuation-archive"
  | "punctuation-extract"
  | "punctuation-copy"
  | "verifying";

export type SherpaModelDownloadProgress = {
  stage: DownloadStage;
  label: string;
  progress: number;
};

type ProgressCallback = (progress: SherpaModelDownloadProgress) => void;

const KWS_MODEL_DIR = "sherpa-onnx/kws/looi";
const SPEAKER_MODEL_DIR = "sherpa-onnx/speaker-id/looi";
const KWS_TMP_DIR = `${FileSystem.cacheDirectory ?? FileSystem.documentDirectory ?? ""}sherpa-onnx-download/`;
const KWS_ARCHIVE_PATH = `${KWS_TMP_DIR}sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01-mobile.tar.bz2`;
const KWS_EXTRACT_ROOT = `${KWS_TMP_DIR}extract/`;
const KWS_EXTRACTED_DIR = `${KWS_EXTRACT_ROOT}sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01-mobile/`;
const STREAMING_ASR_ARCHIVE_PATH = `${KWS_TMP_DIR}sherpa-onnx-streaming-paraformer-bilingual-zh-en.tar.bz2`;
const STREAMING_ASR_EXTRACT_ROOT = `${KWS_TMP_DIR}streaming-asr/`;
const STREAMING_ASR_EXTRACTED_DIR = `${STREAMING_ASR_EXTRACT_ROOT}sherpa-onnx-streaming-paraformer-bilingual-zh-en/`;
const PUNCT_ARCHIVE_PATH = `${KWS_TMP_DIR}sherpa-onnx-punct-ct-transformer-zh-en-vocab272727-2024-04-12-int8.tar.bz2`;
const PUNCT_EXTRACT_ROOT = `${KWS_TMP_DIR}punctuation/`;
const PUNCT_EXTRACTED_DIR = `${PUNCT_EXTRACT_ROOT}sherpa-onnx-punct-ct-transformer-zh-en-vocab272727-2024-04-12-int8/`;
const KWS_ARCHIVE_URL =
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01-mobile.tar.bz2";
const STREAMING_ASR_ARCHIVE_URL =
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-paraformer-bilingual-zh-en.tar.bz2";
const PUNCT_ARCHIVE_URL =
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/punctuation-models/sherpa-onnx-punct-ct-transformer-zh-en-vocab272727-2024-04-12-int8.tar.bz2";
const SPEAKER_MODEL_URL =
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx";
const VAD_MODEL_URL =
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx";
const KWS_KEYWORDS = "h ēi m ó g ē @HEY_MOGE\n";

const KWS_FILES = [
  "encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx",
  "decoder-epoch-12-avg-2-chunk-16-left-64.onnx",
  "joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx",
  "tokens.txt",
] as const;

const STREAMING_ASR_FILES = [
  DEFAULT_STREAMING_ASR_ENCODER,
  DEFAULT_STREAMING_ASR_DECODER,
  DEFAULT_STREAMING_ASR_TOKENS_FILE,
] as const;

const PUNCT_FILES = [DEFAULT_PUNCT_MODEL_FILE] as const;

function emit(
  onProgress: ProgressCallback | undefined,
  stage: DownloadStage,
  label: string,
  progress: number
) {
  onProgress?.({
    stage,
    label,
    progress: Math.max(0, Math.min(1, progress)),
  });
}

async function ensureDir(uri: string): Promise<void> {
  const info = await FileSystem.getInfoAsync(uri);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(uri, { intermediates: true });
  }
}

async function fileReady(uri: string): Promise<boolean> {
  const info = await FileSystem.getInfoAsync(uri);
  return Boolean(info.exists && (info.size ?? 0) > 0);
}

async function downloadFile(
  url: string,
  destination: string,
  onProgress: ProgressCallback | undefined,
  stage: DownloadStage,
  label: string,
  baseProgress: number,
  progressSpan: number
): Promise<void> {
  if (await fileReady(destination)) {
    emit(onProgress, stage, label, baseProgress + progressSpan);
    return;
  }

  await ensureDir(destination.slice(0, destination.lastIndexOf("/") + 1));
  const download = FileSystem.createDownloadResumable(
    url,
    destination,
    {},
    ({ totalBytesWritten, totalBytesExpectedToWrite }) => {
      if (!totalBytesExpectedToWrite) return;
      emit(
        onProgress,
        stage,
        label,
        baseProgress + (totalBytesWritten / totalBytesExpectedToWrite) * progressSpan
      );
    }
  );
  const result = await download.downloadAsync();
  if (!result?.uri || !(await fileReady(result.uri))) {
    throw new Error(`${label} 下载失败`);
  }
  emit(onProgress, stage, label, baseProgress + progressSpan);
}

async function copyFileIfNeeded(source: string, destination: string): Promise<void> {
  if (await fileReady(destination)) return;
  if (!(await fileReady(source))) {
    throw new Error(`KWS 解压后缺少文件：${source}`);
  }
  await ensureDir(destination.slice(0, destination.lastIndexOf("/") + 1));
  await FileSystem.copyAsync({ from: source, to: destination });
}

async function extractArchive(
  archivePath: string,
  extractRoot: string,
  stage: Extract<DownloadStage, `${string}-extract`>,
  label: string,
  onProgress?: ProgressCallback
): Promise<void> {
  await FileSystem.deleteAsync(extractRoot, { idempotent: true });
  await ensureDir(extractRoot);
  emit(onProgress, stage, label, 0);
  const extraction = await SherpaOnnx.Archive.extractTarBz2(archivePath, extractRoot);
  if (!extraction.success) {
    throw new Error(extraction.message || `${label}失败`);
  }
  emit(onProgress, stage, label, 1);
}

async function downloadStreamingAsr(
  missing: SherpaModelCheck,
  onProgress?: ProgressCallback
): Promise<void> {
  if (missing.ready) return;
  const modelDir = missing.absoluteModelDir || resolveSherpaModelDir(DEFAULT_STREAMING_ASR_MODEL_DIR);
  await ensureDir(modelDir);

  await ensureDir(KWS_TMP_DIR);
  await downloadFile(
    STREAMING_ASR_ARCHIVE_URL,
    STREAMING_ASR_ARCHIVE_PATH,
    onProgress,
    "streaming-asr-archive",
    "下载流式语音识别模型包",
    0,
    1
  );
  await extractArchive(
    STREAMING_ASR_ARCHIVE_PATH,
    STREAMING_ASR_EXTRACT_ROOT,
    "streaming-asr-extract",
    "解压流式语音识别模型包",
    onProgress
  );

  for (let index = 0; index < STREAMING_ASR_FILES.length; index += 1) {
    const filename = STREAMING_ASR_FILES[index];
    if (missing.missingFiles.includes(filename)) {
      await copyFileIfNeeded(`${STREAMING_ASR_EXTRACTED_DIR}${filename}`, `${modelDir}${filename}`);
    }
    emit(
      onProgress,
      "streaming-asr-copy",
      "安装流式语音识别模型",
      (index + 1) / STREAMING_ASR_FILES.length
    );
  }
}

async function downloadKws(
  missing: SherpaModelCheck,
  onProgress?: ProgressCallback
): Promise<void> {
  if (missing.ready) return;
  const modelDir = missing.absoluteModelDir || resolveSherpaModelDir(KWS_MODEL_DIR);
  await ensureDir(modelDir);

  const missingModelFiles = missing.missingFiles.filter((file) => file !== "keywords.txt");
  if (missingModelFiles.length > 0) {
    await ensureDir(KWS_TMP_DIR);
    await downloadFile(
      KWS_ARCHIVE_URL,
      KWS_ARCHIVE_PATH,
      onProgress,
      "kws-archive",
      "下载唤醒词模型包",
      0,
      1
    );
    await extractArchive(KWS_ARCHIVE_PATH, KWS_EXTRACT_ROOT, "kws-extract", "解压唤醒词模型包", onProgress);

    for (let index = 0; index < KWS_FILES.length; index += 1) {
      const filename = KWS_FILES[index];
      await copyFileIfNeeded(`${KWS_EXTRACTED_DIR}${filename}`, `${modelDir}${filename}`);
      emit(onProgress, "kws-copy", "安装唤醒词模型", (index + 1) / KWS_FILES.length);
    }
  }

  if (missing.missingFiles.includes("keywords.txt")) {
    await FileSystem.writeAsStringAsync(`${modelDir}keywords.txt`, KWS_KEYWORDS);
  }
}

async function downloadSpeaker(
  missing: SherpaModelCheck,
  onProgress?: ProgressCallback
): Promise<void> {
  if (missing.ready) return;
  const modelDir = missing.absoluteModelDir || resolveSherpaModelDir(SPEAKER_MODEL_DIR);
  await ensureDir(modelDir);
  await downloadFile(
    SPEAKER_MODEL_URL,
    `${modelDir}model.onnx`,
    onProgress,
    "speaker",
    "下载声纹模型",
    0,
    1
  );
}

async function downloadVad(
  missing: SherpaModelCheck,
  onProgress?: ProgressCallback
): Promise<void> {
  if (missing.ready) return;
  const modelDir = missing.absoluteModelDir || resolveSherpaModelDir(DEFAULT_VAD_MODEL_DIR);
  await ensureDir(modelDir);
  await downloadFile(
    VAD_MODEL_URL,
    `${modelDir}${DEFAULT_VAD_MODEL_FILE}`,
    onProgress,
    "vad",
    "下载 VAD 模型",
    0,
    1
  );
}

async function downloadPunctuation(
  missing: SherpaModelCheck,
  onProgress?: ProgressCallback
): Promise<void> {
  if (missing.ready) return;
  const modelDir = missing.absoluteModelDir || resolveSherpaModelDir(DEFAULT_PUNCT_MODEL_DIR);
  await ensureDir(modelDir);

  await ensureDir(KWS_TMP_DIR);
  await downloadFile(
    PUNCT_ARCHIVE_URL,
    PUNCT_ARCHIVE_PATH,
    onProgress,
    "punctuation-archive",
    "下载标点恢复模型包",
    0,
    1
  );
  await extractArchive(
    PUNCT_ARCHIVE_PATH,
    PUNCT_EXTRACT_ROOT,
    "punctuation-extract",
    "解压标点恢复模型包",
    onProgress
  );

  for (let index = 0; index < PUNCT_FILES.length; index += 1) {
    const filename = PUNCT_FILES[index];
    if (missing.missingFiles.includes(filename)) {
      await copyFileIfNeeded(`${PUNCT_EXTRACTED_DIR}${filename}`, `${modelDir}${filename}`);
    }
    emit(
      onProgress,
      "punctuation-copy",
      "安装标点恢复模型",
      (index + 1) / PUNCT_FILES.length
    );
  }
}

export async function downloadMissingSherpaModels(onProgress?: ProgressCallback) {
  emit(onProgress, "checking", "检查缺失模型", 0);
  await installBundledSherpaModels();
  const before = await checkAllSherpaModelReadiness();
  emit(onProgress, "checking", "检查缺失模型", 1);

  await downloadStreamingAsr(before.streamingAsr, onProgress);
  await downloadKws(before.kws, onProgress);
  await downloadSpeaker(before.speaker, onProgress);
  await downloadVad(before.vad, onProgress);
  await downloadPunctuation(before.punctuation, onProgress);

  emit(onProgress, "verifying", "校验模型文件", 0);
  const after = await checkAllSherpaModelReadiness();
  emit(onProgress, "verifying", "校验模型文件", 1);

  const stillMissing = [
    after.streamingAsr,
    after.punctuation,
    after.kws,
    after.speaker,
    after.vad,
  ].filter((item) => !item.ready);
  if (stillMissing.length > 0) {
    throw new Error(
      stillMissing
        .map((item) => `${item.kind}: ${item.missingFiles.join(", ")}`)
        .join("; ")
    );
  }

  await FileSystem.deleteAsync(KWS_TMP_DIR, { idempotent: true }).catch(() => undefined);
  return after;
}
