import { Observation } from "../core/observation";
import { llmService, memoryService } from "../server-api/client";
import { ttsService } from "../voice/tts";
import { sendImmediateNotification } from "./notification";
import { useConversationStore } from "../store/conversation";
import { useUserStore } from "../store/user";

/**
 * ReminderScheduler — handles calendar observations and triggers reminders
 */
export class ReminderScheduler {
  /**
   * Process a calendar observation and decide whether to remind
   */
  async processCalendarObservation(observation: Observation): Promise<void> {
    const conversationStore = useConversationStore.getState();
    const userStore = useUserStore.getState();

    try {
      // Search for related memories
      const relatedFacts = await memoryService.search(observation.content);

      // Generate reminder response
      const response = await llmService.generateResponse("remind", {
        facts: relatedFacts,
        transcript: observation.content,
      });

      // Add to conversation
      conversationStore.addMessage({ role: "assistant", content: response });

      // Send notification
      await sendImmediateNotification("LOOI 提醒", response);

      // TTS if enabled
      if (userStore.preferences.ttsEnabled) {
        userStore.setVoiceState("speaking");
        await ttsService.speak({ text: response });
        userStore.setVoiceState("sleeping");
      }
    } catch (error) {
      console.error("[ReminderScheduler] Error processing calendar:", error);
    }
  }
}

export const reminderScheduler = new ReminderScheduler();
