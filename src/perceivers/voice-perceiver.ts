import { BasePerceiver } from "../core/perceiver";
import type { MemoryResult, UserIntent } from "../core/context-service";
import { createObservation } from "../core/observation";
import { classifyCategory, hasVisualReference } from "../memory/metadata";
import { wakewordService } from "../voice/wakeword";
import { kwsAudioFeeder } from "../voice/kws-audio-feeder";
import { speakerIdService } from "../voice/speaker-id";
import { streamingSttService } from "../voice/streaming-stt";
import { punctuationService } from "../voice/punctuation";
import { ttsService } from "../voice/tts";
import { vadService } from "../voice/vad-service";
import { voiceAcceptanceTrace } from "../voice/acceptance-trace";
import { useUserStore } from "../store/user";
import { useConversationStore } from "../store/conversation";
import { llmService, memoryService, observeService, sessionService } from "../server-api/client";
import { getRuntimeProfile } from "../core/runtime-profile";
import { cameraPerceiver } from "./camera-perceiver";

const LISTENING_START_TIMEOUT_MS = 5000;
const MAX_LISTENING_DURATION_MS = 30_000;
const ENDPOINT_WAIT_MS = 2000;
const SPEAKER_SAMPLE_RATE = 16000;
const SPEAKER_SEGMENT_PADDING_SAMPLES = Math.round(SPEAKER_SAMPLE_RATE * 0.25);
const SENTENCE_BREAK_RE = /[。！？!?\n、]/;
const MAX_STREAMING_SENTENCE_LENGTH = 20;

type GenerateResponseResult = {
  response: string;
  evidenceUri?: string;
  audioHandled: boolean;
};

type SampleRange = {
  start: number;
  end: number;
};

class AsyncSentenceQueue implements AsyncIterable<string> {
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

/**
 * VoicePerceiver — orchestrates the voice pipeline:
 * Wakeword → Speaker Verification → STT → Observation
 *
 * Also handles the response side: LLM → TTS
 */
export class VoicePerceiver extends BasePerceiver {
  name = "voice";
  private unsubWakeword: (() => void) | null = null;
  private unsubPreferences: (() => void) | null = null;
  private startListeningPromise: Promise<void> | null = null;
  private isFinishingListening = false;
  private cancelListeningAfterStart = false;
  private allowsWakewordAutostart = true;
  private unsubStreamingSamples: (() => void) | null = null;
  private vadHadSpeech = false;
  private vadAccepting = false;
  private vadQueuedSamples: number[] | null = null;
  private streamingAccepting = false;
  private streamingQueuedSamples: number[] | null = null;
  private speechSamplesBuffer: number[] = [];
  private speechSampleRanges: SampleRange[] = [];
  private finalizedStreamingSegments: string[] = [];
  private currentStreamingText = "";
  private listeningTimeout: ReturnType<typeof setTimeout> | null = null;
  private endpointFinalizeTimeout: ReturnType<typeof setTimeout> | null = null;

  async start(): Promise<void> {
    if (this.isActive) return;

    this.isActive = true;
    this.allowsWakewordAutostart = getRuntimeProfile().allowsWakewordAutostart;

    this.unsubWakeword = wakewordService.onWakeword(() => {
      this.handleWakeword();
    });

    this.unsubPreferences = useUserStore.subscribe((state, previousState) => {
      if (state.preferences.wakeWordEnabled === previousState.preferences.wakeWordEnabled) {
        return;
      }

      this.syncWakewordFeeder();
    });

    if (this.shouldRunWakewordFeeder()) {
      await this.startWakewordFeeder();
    }
  }

  async stop(): Promise<void> {
    this.isActive = false;
    await kwsAudioFeeder.stop();
    await wakewordService.stop();
    if (this.unsubWakeword) {
      this.unsubWakeword();
      this.unsubWakeword = null;
    }
    if (this.unsubPreferences) {
      this.unsubPreferences();
      this.unsubPreferences = null;
    }
    await this.stopListeningStreaming({ resetAsr: true });
  }

  /**
   * Manually trigger the voice pipeline (for button-press mode)
   */
  trigger(): void {
    this.handleWakeword();
  }

  /**
   * Handle wakeword detection
   */
  private async handleWakeword(): Promise<void> {
    const userStore = useUserStore.getState();
    const conversationStore = useConversationStore.getState();

    if (
      conversationStore.isListening ||
      conversationStore.isProcessing ||
      userStore.voiceState !== "sleeping" ||
      this.startListeningPromise ||
      this.isFinishingListening
    ) {
      voiceAcceptanceTrace.mark("ignored", {
        isListening: conversationStore.isListening,
        isProcessing: conversationStore.isProcessing,
        voiceState: userStore.voiceState,
      });
      console.log("[VoicePerceiver] Ignored trigger", {
        isListening: conversationStore.isListening,
        isProcessing: conversationStore.isProcessing,
        voiceState: userStore.voiceState,
        hasStartListeningPromise: Boolean(this.startListeningPromise),
        isFinishingListening: this.isFinishingListening,
      });
      return;
    }

    voiceAcceptanceTrace.start();
    console.log("[VoicePerceiver] Listening started");
    // Step 1: Start listening. Owner verification runs against the same sample buffer
    // before accepting the transcript, so commands still require speaker verification.
    userStore.setVoiceState("listening");
    conversationStore.setListening(true);
    conversationStore.setCurrentTranscript("");
    conversationStore.setStreamingText("");
    conversationStore.setOverlayVisible(true);

    try {
      const session = await sessionService.touch();
      conversationStore.setActiveSession(session.sessionId);
      voiceAcceptanceTrace.mark("session", {
        sessionId: session.sessionId,
        isNew: session.isNew,
      });
      console.log("[VoicePerceiver] Session touched", {
        sessionId: session.sessionId,
        isNew: session.isNew,
      });
    } catch (error) {
      console.warn("[VoicePerceiver] Session touch failed; continuing locally:", error);
    }

    const startListeningPromise = this.startStreamingForListening();
    this.startListeningPromise = startListeningPromise;

    try {
      await startListeningPromise;
    } finally {
      if (this.startListeningPromise === startListeningPromise) {
        this.startListeningPromise = null;
        await this.restartWakewordFeederIfNeeded();
      }
    }
  }

  /**
   * Stop listening and process the speech
   * Called by UI when user releases the button or VAD detects silence
   */
  async finishListening(): Promise<void> {
    let userStore = useUserStore.getState();
    let conversationStore = useConversationStore.getState();

    if (this.isFinishingListening) {
      console.log("[VoicePerceiver] Ignored finish: already finishing");
      return;
    }

    this.isFinishingListening = true;
    const hadListeningRequest =
      conversationStore.isListening ||
      userStore.voiceState === "listening" ||
      Boolean(this.startListeningPromise) ||
      Boolean(this.unsubStreamingSamples);

    console.log("[VoicePerceiver] Finish requested", {
      hadListeningRequest,
      isListening: conversationStore.isListening,
      voiceState: userStore.voiceState,
      streamingActive: Boolean(this.unsubStreamingSamples),
      hasStartListeningPromise: Boolean(this.startListeningPromise),
    });
    voiceAcceptanceTrace.mark("finish-requested", {
      hadListeningRequest,
      streamingActive: Boolean(this.unsubStreamingSamples),
    });

    conversationStore.setListening(false);
    if (hadListeningRequest) {
      userStore.setVoiceState("processing");
      conversationStore.setProcessing(true);
    }

    try {
      if (!this.unsubStreamingSamples && this.startListeningPromise) {
        const listeningStarted = await this.waitForListeningStart(this.startListeningPromise);
        if (!listeningStarted) {
          this.cancelListeningAfterStart = true;
          console.warn("[VoicePerceiver] Listening start timed out; cancelling when ready");
          return;
        }
      }

      userStore = useUserStore.getState();
      conversationStore = useConversationStore.getState();

      if (!this.unsubStreamingSamples && this.speechSamplesBuffer.length === 0) {
        console.log("[VoicePerceiver] Finish stopped: no active streaming listener");
        if (userStore.voiceState === "listening") {
          userStore.setVoiceState("sleeping");
        }
        return;
      }

      userStore.setVoiceState("processing");
      conversationStore.setProcessing(true);

      await this.stopListeningStreaming({ resetAsr: false });
      const rawTranscript = await this.collectFinalStreamingTranscript();
      console.log("[VoicePerceiver] Streaming STT finished", { transcript: rawTranscript });
      voiceAcceptanceTrace.mark("stt", { transcriptLength: rawTranscript.length });
      if (!rawTranscript.trim()) {
        conversationStore.addMessage({
          role: "assistant",
          content: "我没有听清刚才的话，请靠近一点再说一次。",
        });
        userStore.setVoiceState("sleeping");
        conversationStore.setProcessing(false);
        return;
      }

      let transcript = rawTranscript;
      try {
        transcript = await punctuationService.addPunctuation(rawTranscript);
      } catch (error) {
        console.warn("[VoicePerceiver] Punctuation failed; using raw transcript:", error);
      }

      userStore.setVoiceState("verifying");
      const speakerSamples = this.getSpeakerVerificationSamples();
      const isOwner = await speakerIdService.verifySamples(speakerSamples);
      console.log("[VoicePerceiver] Speaker verification finished", {
        isOwner,
        totalSamples: this.speechSamplesBuffer.length,
        speakerSamples: speakerSamples.length,
        speechRanges: this.speechSampleRanges.length,
      });
      voiceAcceptanceTrace.mark("speaker-verified", { isOwner });
      if (!isOwner) {
        conversationStore.addMessage({
          role: "assistant",
          content: "还没有通过声纹验证。请先在设置里录入主人声纹，或重新录一段更清晰的语音。",
        });
        return;
      }

      userStore.setVoiceState("processing");
      conversationStore.setCurrentTranscript(transcript);
      await conversationStore.appendMessage({ role: "user", content: transcript });

      // Step 4: Emit observation
      const category = classifyCategory(transcript);
      const observation = createObservation(transcript, "voice", category);
      this.emit(observation);

      // Step 5: Process with LLM
      console.log("[VoicePerceiver] Classifying intent", { transcript });
      const intent = await llmService.classifyIntent(transcript);
      console.log("[VoicePerceiver] Intent classified", { intent });
      voiceAcceptanceTrace.mark("intent", { intent });
      let response: string;
      let evidenceUri: string | undefined;
      let audioHandled = false;

      if (intent === "store" && hasVisualReference(transcript) && cameraPerceiver.hasFrame) {
        const latestFrame = cameraPerceiver.getLatestFrame();
        if (!latestFrame) {
          throw new Error("Camera frame disappeared before voice+visual processing");
        }

        const jointObservation = createObservation(transcript, "voice+camera", "placement");
        const result = await observeService.voiceVisual(
          transcript,
          latestFrame,
          jointObservation.metadata
        );

        response = result.response;
        evidenceUri = result.evidenceUri;
        console.log("[VoicePerceiver] Voice+visual observation processed", { evidenceUri });
        this.emit({
          ...jointObservation,
          content: result.description,
          evidenceUri: result.evidenceUri,
          metadata: {
            ...jointObservation.metadata,
            evidenceUri: result.evidenceUri,
          },
        });
      } else if (intent === "store") {
        await memoryService.remember(
          [{ role: "user", content: transcript }],
          observation.metadata
        );
        console.log("[VoicePerceiver] Memory stored");
        const result = await this.generateResponseWithOverlay(intent, {
          facts: [],
          transcript,
        });
        response = result.response;
        evidenceUri = result.evidenceUri;
        audioHandled = result.audioHandled;
      } else if (intent === "search") {
        const facts = await memoryService.search(transcript);
        console.log("[VoicePerceiver] Memory searched", { facts: facts.length });
        const result = await this.generateResponseWithOverlay(intent, { facts, transcript });
        response = result.response;
        evidenceUri = facts.find((fact) => fact.metadata?.evidenceUri)?.metadata?.evidenceUri;
        evidenceUri = result.evidenceUri ?? evidenceUri;
        audioHandled = result.audioHandled;
      } else {
        const result = await this.generateResponseWithOverlay(intent, {
          facts: [],
          transcript,
        });
        response = result.response;
        evidenceUri = result.evidenceUri;
        audioHandled = result.audioHandled;
      }

      // Step 6: Add assistant response
      console.log("[VoicePerceiver] Assistant response generated", { response });
      voiceAcceptanceTrace.mark("assistant", {
        responseLength: response.length,
        audioHandled,
        hasEvidence: Boolean(evidenceUri),
      });
      await conversationStore.appendMessage({ role: "assistant", content: response, evidenceUri });
      if (evidenceUri) {
        conversationStore.showImageOverlay(evidenceUri);
      }

      // Step 7: TTS playback
      userStore.setVoiceState("speaking");
      conversationStore.setSpeaking(true);

      if (userStore.preferences.ttsEnabled && !audioHandled) {
        voiceAcceptanceTrace.mark("first-tts", { mode: "fallback" });
        await ttsService.speak({ text: response });
      }
    } catch (error) {
      console.warn("[VoicePerceiver] Processing stopped:", error);
      voiceAcceptanceTrace.mark("error", {
        message: error instanceof Error ? error.message : String(error),
      });
      await conversationStore.appendMessage({
        role: "assistant",
        content: "抱歉，处理时出了点问题，请再试一次。",
      });
    } finally {
      userStore.setVoiceState("sleeping");
      conversationStore.setProcessing(false);
      conversationStore.setSpeaking(false);
      setTimeout(() => {
        useConversationStore.getState().setOverlayVisible(false);
      }, 3000);
      this.isFinishingListening = false;
      await this.restartWakewordFeederIfNeeded();
      voiceAcceptanceTrace.finish({
        voiceState: useUserStore.getState().voiceState,
        isListening: useConversationStore.getState().isListening,
        isProcessing: useConversationStore.getState().isProcessing,
      });
    }
  }

  private async generateResponseWithOverlay(
    intent: UserIntent,
    context: {
      facts: MemoryResult[];
      transcript: string;
    }
  ): Promise<GenerateResponseResult> {
    const sessionId = useConversationStore.getState().activeSessionId;
    useConversationStore.getState().setStreamingText("");
    let streamedEvidenceUri: string | undefined;

    if (llmService.generateResponseStream) {
      let streamedText = "";
      let sentenceBuffer = "";
      const sentenceQueue = new AsyncSentenceQueue();
      const shouldSpeak = useUserStore.getState().preferences.ttsEnabled;
      const ttsPromise = shouldSpeak
        ? ttsService.speakSentences(sentenceQueue, {
            onSentenceStart: () => {
              voiceAcceptanceTrace.mark("first-tts", { mode: "stream" });
              useUserStore.getState().setVoiceState("speaking");
              useConversationStore.getState().setSpeaking(true);
            },
          })
        : Promise.resolve();

      try {
        for await (const event of llmService.generateResponseStream({
          sessionId,
          intent,
          facts: context.facts,
          transcript: context.transcript,
        })) {
          if (event.type === "token") {
            voiceAcceptanceTrace.mark("first-token");
            streamedText += event.text;
            sentenceBuffer += event.text;
            useConversationStore.getState().appendStreamingText(event.text);
            sentenceBuffer = this.flushCompleteSentences(sentenceBuffer, sentenceQueue);
          } else if (event.type === "done") {
            const fullText = event.fullText || streamedText;
            voiceAcceptanceTrace.mark("stream-done", {
              responseLength: fullText.length,
              hasEvidence: Boolean(event.evidenceUri),
            });
            streamedEvidenceUri = event.evidenceUri;
            sentenceQueue.push(sentenceBuffer);
            sentenceBuffer = "";
            sentenceQueue.close();
            await ttsPromise;
            useConversationStore.getState().setStreamingText(fullText);
            if (event.evidenceUri) {
              useConversationStore.getState().showImageOverlay(event.evidenceUri);
            }
            return {
              response: fullText,
              evidenceUri: event.evidenceUri,
              audioHandled: shouldSpeak,
            };
          } else if (event.type === "error") {
            throw new Error(event.message);
          }
        }

        sentenceQueue.push(sentenceBuffer);
        sentenceQueue.close();
        await ttsPromise;
        if (streamedText) {
          return {
            response: streamedText,
            evidenceUri: streamedEvidenceUri,
            audioHandled: shouldSpeak,
          };
        }
      } catch (error) {
        sentenceQueue.close();
        await ttsPromise.catch(() => undefined);
        console.warn("[VoicePerceiver] Streaming response failed; using fallback:", error);
        useConversationStore.getState().setStreamingText("");
      }
    }

    const response = await llmService.generateResponse(intent, context);
    useConversationStore.getState().setStreamingText(response);
    return { response, audioHandled: false };
  }

  private flushCompleteSentences(buffer: string, queue: AsyncSentenceQueue): string {
    let remaining = buffer;
    let splitIndex = this.findSentenceSplitIndex(remaining);

    while (splitIndex >= 0) {
      queue.push(remaining.slice(0, splitIndex + 1));
      remaining = remaining.slice(splitIndex + 1);
      splitIndex = this.findSentenceSplitIndex(remaining);
    }

    return remaining;
  }

  private findSentenceSplitIndex(text: string): number {
    const punctuationIndex = text.search(SENTENCE_BREAK_RE);
    if (punctuationIndex >= 0) {
      return punctuationIndex;
    }
    return text.length >= MAX_STREAMING_SENTENCE_LENGTH ? text.length - 1 : -1;
  }

  private async startStreamingForListening(): Promise<void> {
    const userStore = useUserStore.getState();
    const conversationStore = useConversationStore.getState();

    try {
      await kwsAudioFeeder.stop();
      await this.startListeningStreaming();
      voiceAcceptanceTrace.mark("recording-started");
      voiceAcceptanceTrace.mark("streaming-listening-started");
      if (this.cancelListeningAfterStart) {
        await this.stopListeningStreaming({ resetAsr: true });
        return;
      }
    } catch (error) {
      console.error("[VoicePerceiver] Failed to start streaming listener:", error);
      voiceAcceptanceTrace.mark("error", {
        message: error instanceof Error ? error.message : String(error),
      });
      userStore.setVoiceState("sleeping");
      conversationStore.setListening(false);
      await this.restartWakewordFeederIfNeeded();
      voiceAcceptanceTrace.finish({
        voiceState: useUserStore.getState().voiceState,
        isListening: useConversationStore.getState().isListening,
        isProcessing: useConversationStore.getState().isProcessing,
      });
    } finally {
      this.cancelListeningAfterStart = false;
    }
  }

  private async startListeningStreaming(): Promise<void> {
    await this.stopListeningStreaming({ resetAsr: true });
    this.vadHadSpeech = false;
    this.vadQueuedSamples = null;
    this.streamingQueuedSamples = null;
    this.speechSamplesBuffer = [];
    this.speechSampleRanges = [];
    this.finalizedStreamingSegments = [];
    this.currentStreamingText = "";

    try {
      await vadService.start();
    } catch (error) {
      console.warn("[VoicePerceiver] VAD unavailable; using safety timeout only:", error);
    }

    await streamingSttService.createStream();

    this.unsubStreamingSamples = kwsAudioFeeder.subscribeSamples((samples, sampleRate) => {
      this.speechSamplesBuffer.push(...samples);
      this.enqueueVadSamples(samples, sampleRate);
      this.enqueueStreamingSamples(samples, sampleRate);
    });
    kwsAudioFeeder.setWakewordFeedingEnabled(false);

    try {
      await kwsAudioFeeder.start();
    } catch (error) {
      console.warn("[VoicePerceiver] Failed to start VAD audio feeder:", error);
    }

    this.listeningTimeout = setTimeout(() => {
      console.log("[VoicePerceiver] Listening safety timeout reached");
      voiceAcceptanceTrace.mark("safety-timeout");
      this.finishListening();
    }, MAX_LISTENING_DURATION_MS);
  }

  private async stopListeningStreaming(options: { resetAsr: boolean }): Promise<void> {
    if (this.listeningTimeout) {
      clearTimeout(this.listeningTimeout);
      this.listeningTimeout = null;
    }

    if (this.endpointFinalizeTimeout) {
      clearTimeout(this.endpointFinalizeTimeout);
      this.endpointFinalizeTimeout = null;
    }

    if (this.unsubStreamingSamples) {
      this.unsubStreamingSamples();
      this.unsubStreamingSamples = null;
    }

    this.vadQueuedSamples = null;
    this.streamingQueuedSamples = null;
    await this.waitForSampleDrains();
    this.vadHadSpeech = false;
    kwsAudioFeeder.setWakewordFeedingEnabled(true);

    if (kwsAudioFeeder.isRunning && !this.shouldRunWakewordFeeder()) {
      await kwsAudioFeeder.stop();
    }

    await vadService.reset().catch(() => undefined);
    if (options.resetAsr) {
      await streamingSttService.resetStream().catch(() => undefined);
      this.speechSamplesBuffer = [];
      this.speechSampleRanges = [];
      this.finalizedStreamingSegments = [];
      this.currentStreamingText = "";
    }
  }

  private enqueueVadSamples(samples: number[], sampleRate: number): void {
    this.vadQueuedSamples = this.vadQueuedSamples ? this.vadQueuedSamples.concat(samples) : samples;
    if (!this.vadAccepting) {
      this.drainVadSamples(sampleRate);
    }
  }

  private async drainVadSamples(sampleRate: number): Promise<void> {
    this.vadAccepting = true;

    try {
      while (this.unsubStreamingSamples && this.vadQueuedSamples) {
        const samples = this.vadQueuedSamples;
        this.vadQueuedSamples = null;
        const result = await vadService.acceptSamples(samples, sampleRate);
        const completedSegmentCount = result.segments?.length ?? 0;
        if (completedSegmentCount > 0) {
          this.recordVadSpeechSegments(result.segments ?? [], sampleRate);
          if (!this.vadHadSpeech) {
            voiceAcceptanceTrace.mark("vad-speech", {
              segments: completedSegmentCount,
            });
          }
          this.vadHadSpeech = true;
          console.log("[VoicePerceiver] VAD detected speech end");
          voiceAcceptanceTrace.mark("vad-end");
          this.scheduleEndpointFinalize(0);
          break;
        }
        if (result.isSpeechDetected) {
          if (!this.vadHadSpeech) {
            voiceAcceptanceTrace.mark("vad-speech", {
              segments: completedSegmentCount,
            });
          }
          this.vadHadSpeech = true;
        }
      }
    } catch (error) {
      console.warn("[VoicePerceiver] Failed to process VAD samples:", error);
    } finally {
      this.vadAccepting = false;
      if (this.unsubStreamingSamples && this.vadQueuedSamples) {
        this.drainVadSamples(sampleRate);
      }
    }
  }

  private enqueueStreamingSamples(samples: number[], sampleRate: number): void {
    this.streamingQueuedSamples = this.streamingQueuedSamples
      ? this.streamingQueuedSamples.concat(samples)
      : samples;
    if (!this.streamingAccepting) {
      this.drainStreamingSamples(sampleRate);
    }
  }

  private async drainStreamingSamples(sampleRate: number): Promise<void> {
    this.streamingAccepting = true;

    try {
      while (this.unsubStreamingSamples && this.streamingQueuedSamples) {
        const samples = this.streamingQueuedSamples;
        this.streamingQueuedSamples = null;
        const result = await streamingSttService.acceptSamples(samples, sampleRate);
        if (result.text) {
          this.currentStreamingText = result.text;
          this.updateCurrentTranscript();
          if (this.endpointFinalizeTimeout) {
            this.scheduleEndpointFinalize(ENDPOINT_WAIT_MS);
          }
        }
        if (result.isEndpoint) {
          this.appendFinalStreamingSegment(result.text || this.currentStreamingText);
          this.currentStreamingText = "";
          this.updateCurrentTranscript();
          await streamingSttService.resetStream();
          this.scheduleEndpointFinalize(ENDPOINT_WAIT_MS);
        }
      }
    } catch (error) {
      console.warn("[VoicePerceiver] Failed to process streaming ASR samples:", error);
    } finally {
      this.streamingAccepting = false;
      if (this.unsubStreamingSamples && this.streamingQueuedSamples) {
        this.drainStreamingSamples(sampleRate);
      }
    }
  }

  private appendFinalStreamingSegment(text: string): void {
    const normalized = text.trim();
    if (!normalized) return;
    if (
      this.finalizedStreamingSegments[
        this.finalizedStreamingSegments.length - 1
      ] === normalized
    ) {
      return;
    }
    this.finalizedStreamingSegments.push(normalized);
  }

  private recordVadSpeechSegments(
    segments: Array<{ startTime?: number; endTime?: number }>,
    sampleRate: number
  ): void {
    for (const segment of segments) {
      if (segment.startTime === undefined || segment.endTime === undefined) {
        continue;
      }
      const start = Math.max(0, Math.floor(segment.startTime * sampleRate));
      const end = Math.min(
        this.speechSamplesBuffer.length,
        Math.ceil(segment.endTime * sampleRate)
      );
      if (end <= start) continue;
      const previous = this.speechSampleRanges[this.speechSampleRanges.length - 1];
      if (previous && start <= previous.end + SPEAKER_SEGMENT_PADDING_SAMPLES) {
        previous.end = Math.max(previous.end, end);
      } else {
        this.speechSampleRanges.push({ start, end });
      }
    }
  }

  private getSpeakerVerificationSamples(): number[] {
    if (this.speechSampleRanges.length === 0) {
      return this.trimLowEnergyEdges(this.speechSamplesBuffer);
    }

    const samples: number[] = [];
    for (const range of this.speechSampleRanges) {
      const start = Math.max(0, range.start - SPEAKER_SEGMENT_PADDING_SAMPLES);
      const end = Math.min(
        this.speechSamplesBuffer.length,
        range.end + SPEAKER_SEGMENT_PADDING_SAMPLES
      );
      samples.push(...this.speechSamplesBuffer.slice(start, end));
    }

    return samples.length > 0 ? samples : this.trimLowEnergyEdges(this.speechSamplesBuffer);
  }

  private trimLowEnergyEdges(samples: number[]): number[] {
    if (samples.length === 0) return samples;
    const threshold = 0.01;
    let start = 0;
    let end = samples.length;

    while (start < end && Math.abs(samples[start]) < threshold) {
      start += 1;
    }
    while (end > start && Math.abs(samples[end - 1]) < threshold) {
      end -= 1;
    }

    start = Math.max(0, start - SPEAKER_SEGMENT_PADDING_SAMPLES);
    end = Math.min(samples.length, end + SPEAKER_SEGMENT_PADDING_SAMPLES);
    return samples.slice(start, end);
  }

  private updateCurrentTranscript(): void {
    const transcript = [...this.finalizedStreamingSegments, this.currentStreamingText]
      .filter(Boolean)
      .join("");
    useConversationStore.getState().setCurrentTranscript(transcript);
  }

  private scheduleEndpointFinalize(delayMs: number): void {
    if (this.endpointFinalizeTimeout) {
      clearTimeout(this.endpointFinalizeTimeout);
    }
    this.endpointFinalizeTimeout = setTimeout(() => {
      this.endpointFinalizeTimeout = null;
      this.finishListening();
    }, delayMs);
  }

  private async collectFinalStreamingTranscript(): Promise<string> {
    const finalText = await streamingSttService.finishInput().catch((error) => {
      console.warn("[VoicePerceiver] Failed to finish streaming ASR input:", error);
      return "";
    });
    this.appendFinalStreamingSegment(finalText || this.currentStreamingText);
    this.currentStreamingText = "";
    await streamingSttService.resetStream().catch(() => undefined);
    return this.finalizedStreamingSegments.join("").trim();
  }

  private async waitForSampleDrains(): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (!this.vadAccepting && !this.streamingAccepting) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  private async waitForListeningStart(startListeningPromise: Promise<void>): Promise<boolean> {
    return Promise.race([
      startListeningPromise.then(() => true),
      new Promise<boolean>((resolve) => {
        setTimeout(() => resolve(false), LISTENING_START_TIMEOUT_MS);
      }),
    ]);
  }

  private async startWakewordFeeder(): Promise<void> {
    try {
      await wakewordService.start();
      await kwsAudioFeeder.start();
    } catch (error) {
      console.warn("[VoicePerceiver] Wakeword audio feeder unavailable:", error);
    }
  }

  private async restartWakewordFeederIfNeeded(): Promise<void> {
    if (!this.shouldRunWakewordFeeder()) {
      return;
    }

    await this.startWakewordFeeder();
  }

  private shouldRunWakewordFeeder(): boolean {
    const userStore = useUserStore.getState();
    const conversationStore = useConversationStore.getState();

    return (
      this.isActive &&
      this.allowsWakewordAutostart &&
      userStore.preferences.wakeWordEnabled &&
      userStore.voiceState === "sleeping" &&
      !conversationStore.isListening &&
      !conversationStore.isProcessing &&
      !this.startListeningPromise &&
      !this.isFinishingListening
    );
  }

  private syncWakewordFeeder(): void {
    if (this.shouldRunWakewordFeeder()) {
      this.startWakewordFeeder();
    } else {
      kwsAudioFeeder.stop().catch((error) => {
        console.warn("[VoicePerceiver] Failed to stop wakeword audio feeder:", error);
      });
    }
  }
}

export const voicePerceiver = new VoicePerceiver();
