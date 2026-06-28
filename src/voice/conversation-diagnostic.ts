import type { UserIntent } from "../core/context-service";
import { llmService, sessionService } from "../server-api/client";
import { useConversationStore } from "../store/conversation";
import { useUserStore } from "../store/user";
import { loadPcm16WavAssetSamples } from "./diagnostic-audio";
import { sttService } from "./stt";
import { ttsService } from "./tts";

const CONVERSATION_DIAGNOSTIC_AUDIO = require("@/assets/diagnostics/hey-moge.wav");

export type ConversationDiagnosticSmokeSummary = {
  transcript: string;
  sessionId?: string;
  asrDoneMs: number;
  firstTokenMs?: number;
  firstTokenAfterAsrMs?: number;
  firstTtsStartMs?: number;
  firstTtsAfterTokenMs?: number;
  streamDoneMs?: number;
  totalMs: number;
  tokenCount: number;
  response: string;
};

export async function runConversationDiagnosticSmoke(): Promise<ConversationDiagnosticSmokeSummary> {
  const startedAt = Date.now();
  const previousTtsEnabled = useUserStore.getState().preferences.ttsEnabled;
  useUserStore.getState().updatePreferences({ ttsEnabled: true });

  let sessionId: string | undefined;
  let asrDoneMs = 0;
  let firstTokenMs: number | undefined;
  let firstTtsStartMs: number | undefined;
  let streamDoneMs: number | undefined;
  let tokenCount = 0;
  let response = "";

  try {
    const transcript = await transcribeDiagnosticAudio();
    asrDoneMs = Date.now() - startedAt;
    if (!transcript.trim()) {
      throw new Error("Conversation diagnostic ASR returned an empty transcript");
    }

    const session = await sessionService.touch();
    sessionId = session.sessionId;
    useConversationStore.getState().setActiveSession(session.sessionId);
    useConversationStore.getState().setCurrentTranscript(transcript);
    await useConversationStore.getState().appendMessage({ role: "user", content: transcript });

    const intent = await llmService.classifyIntent(transcript);
    const sentenceQueue = new DiagnosticSentenceQueue();
    let sentenceBuffer = "";
    const ttsPromise = ttsService.speakSentences(sentenceQueue, {
      onSentenceStart: () => {
        firstTtsStartMs ??= Date.now() - startedAt;
        useUserStore.getState().setVoiceState("speaking");
        useConversationStore.getState().setSpeaking(true);
      },
    });

    if (llmService.generateResponseStream) {
      try {
        for await (const event of llmService.generateResponseStream({
          sessionId,
          transcript,
          intent,
          facts: [],
        })) {
          if (event.type === "token") {
            firstTokenMs ??= Date.now() - startedAt;
            tokenCount += 1;
            response += event.text;
            sentenceBuffer += event.text;
            useConversationStore.getState().appendStreamingText(event.text);
            sentenceBuffer = flushCompleteDiagnosticSentences(sentenceBuffer, sentenceQueue);
          } else if (event.type === "done") {
            streamDoneMs = Date.now() - startedAt;
            response = event.fullText || response;
            sentenceQueue.push(sentenceBuffer);
            sentenceBuffer = "";
            sentenceQueue.close();
            await ttsPromise;
            await useConversationStore.getState().appendMessage({
              role: "assistant",
              content: response,
              evidenceUri: event.evidenceUri,
            });
            if (event.evidenceUri) {
              useConversationStore.getState().showImageOverlay(event.evidenceUri);
            }
            return buildSummary({
              transcript,
              sessionId,
              asrDoneMs,
              firstTokenMs,
              firstTtsStartMs,
              streamDoneMs,
              startedAt,
              tokenCount,
              response,
            });
          } else if (event.type === "error") {
            throw new Error(event.message);
          }
        }
      } finally {
        sentenceQueue.push(sentenceBuffer);
        sentenceQueue.close();
        await ttsPromise.catch(() => undefined);
      }
    } else {
      response = await llmService.generateResponse(intent, { facts: [], transcript });
      await ttsService.speak({ text: response });
      await useConversationStore.getState().appendMessage({ role: "assistant", content: response });
    }

    return buildSummary({
      transcript,
      sessionId,
      asrDoneMs,
      firstTokenMs,
      firstTtsStartMs,
      streamDoneMs,
      startedAt,
      tokenCount,
      response,
    });
  } finally {
    useUserStore.getState().updatePreferences({ ttsEnabled: previousTtsEnabled });
    useUserStore.getState().setVoiceState("sleeping");
    useConversationStore.getState().setProcessing(false);
    useConversationStore.getState().setSpeaking(false);
    await ttsService.stop().catch(() => undefined);
  }
}

function buildSummary(input: {
  transcript: string;
  sessionId?: string;
  asrDoneMs: number;
  firstTokenMs?: number;
  firstTtsStartMs?: number;
  streamDoneMs?: number;
  startedAt: number;
  tokenCount: number;
  response: string;
}): ConversationDiagnosticSmokeSummary {
  return {
    transcript: input.transcript,
    sessionId: input.sessionId,
    asrDoneMs: input.asrDoneMs,
    firstTokenMs: input.firstTokenMs,
    firstTokenAfterAsrMs:
      input.firstTokenMs === undefined ? undefined : input.firstTokenMs - input.asrDoneMs,
    firstTtsStartMs: input.firstTtsStartMs,
    firstTtsAfterTokenMs:
      input.firstTtsStartMs === undefined || input.firstTokenMs === undefined
        ? undefined
        : input.firstTtsStartMs - input.firstTokenMs,
    streamDoneMs: input.streamDoneMs,
    totalMs: Date.now() - input.startedAt,
    tokenCount: input.tokenCount,
    response: input.response,
  };
}

async function transcribeDiagnosticAudio(): Promise<string> {
  const { samples, sampleRate } = await loadPcm16WavAssetSamples(CONVERSATION_DIAGNOSTIC_AUDIO);
  if (sampleRate !== 16000 || samples.length === 0) {
    throw new Error(`Unexpected diagnostic WAV shape: sampleRate=${sampleRate}, samples=${samples.length}`);
  }

  const asset = await import("expo-asset").then(({ Asset }) =>
    Asset.fromModule(CONVERSATION_DIAGNOSTIC_AUDIO)
  );
  await asset.downloadAsync();
  const audioUri = asset.localUri || asset.uri;
  if (!audioUri) {
    throw new Error("Conversation diagnostic audio asset is unavailable");
  }
  return sttService.transcribeFile(audioUri);
}

class DiagnosticSentenceQueue implements AsyncIterable<string> {
  private queue: string[] = [];
  private resolvers: Array<(value: IteratorResult<string>) => void> = [];
  private closed = false;

  push(sentence: string): void {
    const text = sentence.trim();
    if (!text || this.closed) return;
    const resolver = this.resolvers.shift();
    if (resolver) {
      resolver({ value: text, done: false });
    } else {
      this.queue.push(text);
    }
  }

  close(): void {
    this.closed = true;
    while (this.resolvers.length > 0) {
      this.resolvers.shift()?.({ value: undefined, done: true });
    }
  }

  async next(): Promise<IteratorResult<string>> {
    const sentence = this.queue.shift();
    if (sentence) {
      return { value: sentence, done: false };
    }
    if (this.closed) {
      return { value: undefined, done: true };
    }
    return new Promise((resolve) => {
      this.resolvers.push(resolve);
    });
  }

  [Symbol.asyncIterator](): AsyncIterator<string> {
    return this;
  }
}

const SENTENCE_BREAK_RE = /[。！？!?，,\n、]/;
const MAX_STREAMING_SENTENCE_LENGTH = 20;

function flushCompleteDiagnosticSentences(buffer: string, queue: DiagnosticSentenceQueue): string {
  let remaining = buffer;
  let splitIndex = findDiagnosticSentenceSplitIndex(remaining);
  while (splitIndex >= 0) {
    queue.push(remaining.slice(0, splitIndex + 1));
    remaining = remaining.slice(splitIndex + 1);
    splitIndex = findDiagnosticSentenceSplitIndex(remaining);
  }
  return remaining;
}

function findDiagnosticSentenceSplitIndex(text: string): number {
  const punctuationIndex = text.search(SENTENCE_BREAK_RE);
  if (punctuationIndex >= 0) {
    return punctuationIndex;
  }
  return text.length >= MAX_STREAMING_SENTENCE_LENGTH ? text.length - 1 : -1;
}
