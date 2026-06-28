import { BasePerceiver } from "../core/perceiver";
import type { MemoryResult, UserIntent } from "../core/context-service";
import { createObservation } from "../core/observation";
import { classifyCategory, hasVisualReference } from "../memory/metadata";
import { wakewordService } from "../voice/wakeword";
import { kwsAudioFeeder } from "../voice/kws-audio-feeder";
import { speakerIdService } from "../voice/speaker-id";
import { sttService } from "../voice/stt";
import { ttsService } from "../voice/tts";
import { vadService } from "../voice/vad-service";
import { voiceAcceptanceTrace } from "../voice/acceptance-trace";
import { useUserStore } from "../store/user";
import { useConversationStore } from "../store/conversation";
import { llmService, memoryService, observeService, sessionService } from "../server-api/client";
import { getRuntimeProfile } from "../core/runtime-profile";
import { cameraPerceiver } from "./camera-perceiver";

const RECORDING_START_TIMEOUT_MS = 5000;
const MAX_LISTENING_DURATION_MS = 15_000;
const SENTENCE_BREAK_RE = /[。！？!?\n、]/;
const MAX_STREAMING_SENTENCE_LENGTH = 20;

type GenerateResponseResult = {
  response: string;
  evidenceUri?: string;
  audioHandled: boolean;
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
  private startRecordingPromise: Promise<void> | null = null;
  private isFinishingListening = false;
  private cancelRecordingAfterStart = false;
  private allowsWakewordAutostart = true;
  private unsubVadSamples: (() => void) | null = null;
  private vadHadSpeech = false;
  private vadAccepting = false;
  private vadQueuedSamples: number[] | null = null;
  private listeningTimeout: ReturnType<typeof setTimeout> | null = null;

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
    await this.stopListeningVad();
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
      this.startRecordingPromise ||
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
        hasStartRecordingPromise: Boolean(this.startRecordingPromise),
        isFinishingListening: this.isFinishingListening,
      });
      return;
    }

    voiceAcceptanceTrace.start();
    console.log("[VoicePerceiver] Listening started");
    // Step 1: Start listening. Owner verification runs against this same audio file
    // before transcription, so accepted commands still require speaker verification.
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

    const startRecordingPromise = this.startRecordingForListening();
    this.startRecordingPromise = startRecordingPromise;

    try {
      await startRecordingPromise;
    } finally {
      if (this.startRecordingPromise === startRecordingPromise) {
        this.startRecordingPromise = null;
        if (!sttService.recording_active) {
          await this.restartWakewordFeederIfNeeded();
        }
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
      Boolean(this.startRecordingPromise) ||
      sttService.recording_active;

    console.log("[VoicePerceiver] Finish requested", {
      hadListeningRequest,
      isListening: conversationStore.isListening,
      voiceState: userStore.voiceState,
      recordingActive: sttService.recording_active,
      hasStartRecordingPromise: Boolean(this.startRecordingPromise),
    });
    voiceAcceptanceTrace.mark("finish-requested", {
      hadListeningRequest,
      recordingActive: sttService.recording_active,
    });

    conversationStore.setListening(false);
    if (hadListeningRequest) {
      userStore.setVoiceState("processing");
      conversationStore.setProcessing(true);
    }

    try {
      if (!sttService.recording_active && this.startRecordingPromise) {
        const recordingStarted = await this.waitForRecordingStart(this.startRecordingPromise);
        if (!recordingStarted) {
          this.cancelRecordingAfterStart = true;
          console.warn("[VoicePerceiver] Recording start timed out; cancelling when ready");
          return;
        }
      }

      userStore = useUserStore.getState();
      conversationStore = useConversationStore.getState();

      if (!sttService.recording_active) {
        console.log("[VoicePerceiver] Finish stopped: no active recording");
        if (userStore.voiceState === "listening") {
          userStore.setVoiceState("sleeping");
        }
        return;
      }

      userStore.setVoiceState("processing");
      conversationStore.setProcessing(true);

      await this.stopListeningVad();

      // Step 2: Stop recording and verify owner before accepting the command.
      const audioUri = await sttService.stopRecording();
      console.log("[VoicePerceiver] Recording stopped", { audioUri });
      voiceAcceptanceTrace.mark("recording-stopped");

      userStore.setVoiceState("verifying");
      const isOwner = await speakerIdService.verifyFile(audioUri);
      console.log("[VoicePerceiver] Speaker verification finished", { isOwner });
      voiceAcceptanceTrace.mark("speaker-verified", { isOwner });
      if (!isOwner) {
        conversationStore.addMessage({
          role: "assistant",
          content: "还没有通过声纹验证。请先在设置里录入主人声纹，或重新录一段更清晰的语音。",
        });
        return;
      }

      // Step 3: Transcribe the same verified audio.
      userStore.setVoiceState("processing");
      const transcript = await sttService.transcribeFile(audioUri);
      console.log("[VoicePerceiver] STT finished", { transcript });
      voiceAcceptanceTrace.mark("stt", { transcriptLength: transcript.length });
      if (!transcript.trim()) {
        conversationStore.addMessage({
          role: "assistant",
          content: "我没有听清刚才的话，请靠近一点再说一次。",
        });
        userStore.setVoiceState("sleeping");
        conversationStore.setProcessing(false);
        return;
      }

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
      if (error instanceof Error && error.message === "No active recording") {
        return;
      }

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
      await sttService.resumeWakewordFeederIfPaused();
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

  private async startRecordingForListening(): Promise<void> {
    const userStore = useUserStore.getState();
    const conversationStore = useConversationStore.getState();

    try {
      await kwsAudioFeeder.stop();
      await sttService.startRecording();
      voiceAcceptanceTrace.mark("recording-started");
      if (this.cancelRecordingAfterStart) {
        await sttService.cancel();
        return;
      }
      await this.startListeningVad();
    } catch (error) {
      console.error("[VoicePerceiver] Failed to start recording:", error);
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
      this.cancelRecordingAfterStart = false;
    }
  }

  private async startListeningVad(): Promise<void> {
    await this.stopListeningVad();
    this.vadHadSpeech = false;
    this.vadQueuedSamples = null;

    try {
      await vadService.start();
    } catch (error) {
      console.warn("[VoicePerceiver] VAD unavailable; using safety timeout only:", error);
    }

    this.unsubVadSamples = kwsAudioFeeder.subscribeSamples((samples, sampleRate) => {
      this.enqueueVadSamples(samples, sampleRate);
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

  private async stopListeningVad(): Promise<void> {
    if (this.listeningTimeout) {
      clearTimeout(this.listeningTimeout);
      this.listeningTimeout = null;
    }

    if (this.unsubVadSamples) {
      this.unsubVadSamples();
      this.unsubVadSamples = null;
    }

    this.vadQueuedSamples = null;
    this.vadHadSpeech = false;
    kwsAudioFeeder.setWakewordFeedingEnabled(true);

    if (kwsAudioFeeder.isRunning && !this.shouldRunWakewordFeeder()) {
      await kwsAudioFeeder.stop();
    }

    await vadService.reset().catch(() => undefined);
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
      while (this.unsubVadSamples && this.vadQueuedSamples) {
        const samples = this.vadQueuedSamples;
        this.vadQueuedSamples = null;
        const result = await vadService.acceptSamples(samples, sampleRate);
        if (result.isSpeechDetected || (result.segments?.length ?? 0) > 0) {
          if (!this.vadHadSpeech) {
            voiceAcceptanceTrace.mark("vad-speech", {
              segments: result.segments?.length ?? 0,
            });
          }
          this.vadHadSpeech = true;
        } else if (this.vadHadSpeech && sttService.recording_active) {
          console.log("[VoicePerceiver] VAD detected speech end");
          voiceAcceptanceTrace.mark("vad-end");
          this.finishListening();
          break;
        }
      }
    } catch (error) {
      console.warn("[VoicePerceiver] Failed to process VAD samples:", error);
    } finally {
      this.vadAccepting = false;
      if (this.unsubVadSamples && this.vadQueuedSamples) {
        this.drainVadSamples(sampleRate);
      }
    }
  }

  private async waitForRecordingStart(startRecordingPromise: Promise<void>): Promise<boolean> {
    return Promise.race([
      startRecordingPromise.then(() => true),
      new Promise<boolean>((resolve) => {
        setTimeout(() => resolve(false), RECORDING_START_TIMEOUT_MS);
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
      !this.startRecordingPromise &&
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
