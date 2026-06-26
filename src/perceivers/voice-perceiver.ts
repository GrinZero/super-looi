import { BasePerceiver } from "../core/perceiver";
import { createObservation } from "../core/observation";
import { classifyCategory, hasVisualReference } from "../memory/metadata";
import { wakewordService } from "../voice/wakeword";
import { speakerIdService } from "../voice/speaker-id";
import { sttService } from "../voice/stt";
import { ttsService } from "../voice/tts";
import { useUserStore } from "../store/user";
import { useConversationStore } from "../store/conversation";
import { llmService, memoryService } from "../server-api/client";

/**
 * VoicePerceiver — orchestrates the voice pipeline:
 * Wakeword → Speaker Verification → STT → Observation
 *
 * Also handles the response side: LLM → TTS
 */
export class VoicePerceiver extends BasePerceiver {
  name = "voice";
  private unsubWakeword: (() => void) | null = null;

  async start(): Promise<void> {
    this.isActive = true;
    await wakewordService.start();

    this.unsubWakeword = wakewordService.onWakeword(() => {
      this.handleWakeword();
    });
  }

  async stop(): Promise<void> {
    this.isActive = false;
    await wakewordService.stop();
    if (this.unsubWakeword) {
      this.unsubWakeword();
      this.unsubWakeword = null;
    }
  }

  /**
   * Manually trigger the voice pipeline (for button-press mode)
   */
  trigger(): void {
    wakewordService.trigger();
  }

  /**
   * Handle wakeword detection
   */
  private async handleWakeword(): Promise<void> {
    const userStore = useUserStore.getState();
    const conversationStore = useConversationStore.getState();

    // Step 1: Verify speaker (Phase 1: always passes)
    userStore.setVoiceState("verifying");
    const isOwner = await speakerIdService.verify();
    if (!isOwner) {
      userStore.setVoiceState("sleeping");
      return;
    }

    // Step 2: Start listening
    userStore.setVoiceState("listening");
    conversationStore.setListening(true);

    try {
      await sttService.startRecording();
    } catch (error) {
      console.error("[VoicePerceiver] Failed to start recording:", error);
      userStore.setVoiceState("sleeping");
      conversationStore.setListening(false);
      return;
    }
  }

  /**
   * Stop listening and process the speech
   * Called by UI when user releases the button or VAD detects silence
   */
  async finishListening(): Promise<void> {
    const userStore = useUserStore.getState();
    const conversationStore = useConversationStore.getState();

    conversationStore.setListening(false);
    userStore.setVoiceState("processing");
    conversationStore.setProcessing(true);

    try {
      // Step 3: Transcribe
      const transcript = await sttService.stopAndTranscribe();
      if (!transcript.trim()) {
        userStore.setVoiceState("sleeping");
        conversationStore.setProcessing(false);
        return;
      }

      conversationStore.setCurrentTranscript(transcript);
      conversationStore.addMessage({ role: "user", content: transcript });

      // Step 4: Emit observation
      const category = classifyCategory(transcript);
      const observation = createObservation(transcript, "voice", category);
      this.emit(observation);

      // Step 5: Process with LLM
      const intent = await llmService.classifyIntent(transcript);
      let response: string;

      if (intent === "store") {
        await memoryService.remember(
          [{ role: "user", content: transcript }],
          observation.metadata
        );
        response = await llmService.generateResponse(intent, {
          facts: [],
          transcript,
        });
      } else if (intent === "search") {
        const facts = await memoryService.search(transcript);
        response = await llmService.generateResponse(intent, { facts, transcript });
      } else {
        response = await llmService.generateResponse(intent, {
          facts: [],
          transcript,
        });
      }

      // Step 6: Add assistant response
      conversationStore.addMessage({ role: "assistant", content: response });

      // Step 7: TTS playback
      userStore.setVoiceState("speaking");
      conversationStore.setSpeaking(true);

      if (userStore.preferences.ttsEnabled) {
        await ttsService.speak({ text: response });
      }
    } catch (error) {
      console.error("[VoicePerceiver] Processing error:", error);
      conversationStore.addMessage({
        role: "assistant",
        content: "抱歉，处理时出了点问题，请再试一次。",
      });
    } finally {
      userStore.setVoiceState("sleeping");
      conversationStore.setProcessing(false);
      conversationStore.setSpeaking(false);
    }
  }
}

export const voicePerceiver = new VoicePerceiver();
