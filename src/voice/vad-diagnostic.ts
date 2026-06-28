import {
  feedSamplesSequentially,
  loadPcm16WavAssetSamples,
} from "./diagnostic-audio";

const VAD_DIAGNOSTIC_AUDIO = require("@/assets/diagnostics/hey-moge.wav");
const VAD_DIAGNOSTIC_CHUNK_SIZE = 1600;
const VAD_DIAGNOSTIC_TAIL_SILENCE_SAMPLES = 16000;

export type VadDiagnosticSegment = {
  startTime?: number;
  endTime?: number;
};

type VadDiagnosticChunkResult = {
  isSpeechDetected: boolean;
  segments?: VadDiagnosticSegment[];
};

export type VadDiagnosticSmokeResult = {
  hadSpeech: boolean;
  segments: VadDiagnosticSegment[];
};

export type VadDiagnosticSmokeSummary = {
  speechDetected: boolean;
  segmentCount: number;
  firstSegment?: VadDiagnosticSegment;
  samples: number;
  sampleRate: number;
};

export type VadDiagnosticSmokeReport = {
  result: VadDiagnosticSmokeResult;
  summary: VadDiagnosticSmokeSummary;
};

export async function runVadDiagnosticSmoke(): Promise<VadDiagnosticSmokeReport> {
  const [{ vadService }, { samples, sampleRate }] = await Promise.all([
    import("./vad-service"),
    loadPcm16WavAssetSamples(VAD_DIAGNOSTIC_AUDIO),
  ]);
  let runError: unknown;

  try {
    await vadService.start();
    const result = await runVadDiagnosticSamples(samples, (chunk) =>
      vadService.acceptSamples(chunk, sampleRate)
    );

    return {
      result,
      summary: {
        speechDetected: result.hadSpeech,
        segmentCount: result.segments.length,
        firstSegment: result.segments[0],
        samples: samples.length,
        sampleRate,
      },
    };
  } catch (error) {
    runError = error;
    throw error;
  } finally {
    try {
      await vadService.stop();
    } catch (stopError) {
      if (!runError) {
        throw stopError;
      }
    }
  }
}

async function runVadDiagnosticSamples(
  samples: number[],
  acceptSamples: (chunk: number[]) => Promise<VadDiagnosticChunkResult>
): Promise<VadDiagnosticSmokeResult> {
  const paddedSamples = samples.concat(
    new Array(VAD_DIAGNOSTIC_TAIL_SILENCE_SAMPLES).fill(0)
  );
  const segments: VadDiagnosticSegment[] = [];
  let hadSpeech = false;

  await feedSamplesSequentially(
    paddedSamples,
    VAD_DIAGNOSTIC_CHUNK_SIZE,
    async (chunk) => {
      const result = await acceptSamples(chunk);
      hadSpeech ||= result.isSpeechDetected;
      if (result.segments?.length) {
        segments.push(...result.segments);
      }
      return { isSpeechDetected: result.isSpeechDetected, segmentCount: segments.length };
    },
    (result) => result.segmentCount > 0
  );

  if (!hadSpeech && segments.length === 0) {
    throw new Error("VAD did not detect speech in diagnostic audio");
  }

  return { hadSpeech, segments };
}
