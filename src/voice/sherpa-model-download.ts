import SherpaOnnx from "@siteed/sherpa-onnx.rn";
import * as FileSystem from "expo-file-system/legacy";
import {
  checkAllSherpaModelReadiness,
  DEFAULT_VAD_MODEL_DIR,
  DEFAULT_VAD_MODEL_FILE,
  resolveSherpaModelDir,
  type SherpaModelCheck,
} from "./sherpa-models";

type DownloadStage =
  | "checking"
  | "asr"
  | "kws-archive"
  | "kws-extract"
  | "kws-copy"
  | "speaker"
  | "vad"
  | "verifying";

export type SherpaModelDownloadProgress = {
  stage: DownloadStage;
  label: string;
  progress: number;
};

type ProgressCallback = (progress: SherpaModelDownloadProgress) => void;

const ASR_MODEL_DIR = "sherpa-onnx/asr/sensevoice";
const KWS_MODEL_DIR = "sherpa-onnx/kws/looi";
const SPEAKER_MODEL_DIR = "sherpa-onnx/speaker-id/looi";
const KWS_TMP_DIR = `${FileSystem.cacheDirectory ?? FileSystem.documentDirectory ?? ""}sherpa-onnx-download/`;
const KWS_ARCHIVE_PATH = `${KWS_TMP_DIR}sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01-mobile.tar.bz2`;
const KWS_EXTRACT_ROOT = `${KWS_TMP_DIR}extract/`;
const KWS_EXTRACTED_DIR = `${KWS_EXTRACT_ROOT}sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01-mobile/`;
const KWS_ARCHIVE_URL =
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01-mobile.tar.bz2";
const SPEAKER_MODEL_URL =
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx";
const VAD_MODEL_URL =
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx";
const SENSEVOICE_BASE_URL =
  "https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main";
const KWS_KEYWORDS = "h ēi m ó g ē @HEY_MOGE\n";

const KWS_FILES = [
  "encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx",
  "decoder-epoch-12-avg-2-chunk-16-left-64.onnx",
  "joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx",
  "tokens.txt",
] as const;

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

async function downloadAsr(
  missing: SherpaModelCheck,
  onProgress?: ProgressCallback
): Promise<void> {
  if (missing.ready) return;
  const modelDir = missing.absoluteModelDir || resolveSherpaModelDir(ASR_MODEL_DIR);
  await ensureDir(modelDir);
  const missingSet = new Set(missing.missingFiles);

  if (missingSet.has("model.int8.onnx")) {
    await downloadFile(
      `${SENSEVOICE_BASE_URL}/model.int8.onnx?download=true`,
      `${modelDir}model.int8.onnx`,
      onProgress,
      "asr",
      "下载 SenseVoice 模型",
      0,
      0.92
    );
  }
  if (missingSet.has("tokens.txt")) {
    await downloadFile(
      `${SENSEVOICE_BASE_URL}/tokens.txt?download=true`,
      `${modelDir}tokens.txt`,
      onProgress,
      "asr",
      "下载 SenseVoice tokens",
      0.92,
      0.08
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
    await FileSystem.deleteAsync(KWS_EXTRACT_ROOT, { idempotent: true });
    await ensureDir(KWS_EXTRACT_ROOT);
    await downloadFile(
      KWS_ARCHIVE_URL,
      KWS_ARCHIVE_PATH,
      onProgress,
      "kws-archive",
      "下载唤醒词模型包",
      0,
      1
    );

    emit(onProgress, "kws-extract", "解压唤醒词模型包", 0);
    const extraction = await SherpaOnnx.Archive.extractTarBz2(KWS_ARCHIVE_PATH, KWS_EXTRACT_ROOT);
    if (!extraction.success) {
      throw new Error(extraction.message || "KWS 模型解压失败");
    }
    emit(onProgress, "kws-extract", "解压唤醒词模型包", 1);

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

export async function downloadMissingSherpaModels(onProgress?: ProgressCallback) {
  emit(onProgress, "checking", "检查缺失模型", 0);
  const before = await checkAllSherpaModelReadiness();
  emit(onProgress, "checking", "检查缺失模型", 1);

  await downloadAsr(before.asr, onProgress);
  await downloadKws(before.kws, onProgress);
  await downloadSpeaker(before.speaker, onProgress);
  await downloadVad(before.vad, onProgress);

  emit(onProgress, "verifying", "校验模型文件", 0);
  const after = await checkAllSherpaModelReadiness();
  emit(onProgress, "verifying", "校验模型文件", 1);

  const stillMissing = [after.asr, after.kws, after.speaker, after.vad].filter((item) => !item.ready);
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
