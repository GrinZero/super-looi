import { perceiverManager } from "./perceiver-manager";
import { voicePerceiver } from "../perceivers/voice-perceiver";
import { calendarPerceiver } from "../perceivers/calendar-perceiver";
import { cameraPerceiver } from "../perceivers/camera-perceiver";
import { reminderScheduler } from "../reminder/reminder-scheduler";
import { setupNotifications, requestNotificationPermissions } from "../reminder/notification";
import { useUserStore } from "../store/user";

let bootstrapped = false;

/**
 * Initialize all perceivers and wire observation events.
 * Called once at app startup.
 */
export async function bootstrapApp(): Promise<void> {
  if (bootstrapped) return;
  bootstrapped = true;

  // Setup notifications
  setupNotifications();
  await requestNotificationPermissions();

  // Register all perceivers
  perceiverManager.register(voicePerceiver);
  perceiverManager.register(calendarPerceiver);
  perceiverManager.register(cameraPerceiver);

  // Wire observation events
  perceiverManager.onObservation(async (observation) => {
    const { source } = observation.metadata;

    if (source === "calendar") {
      await reminderScheduler.processCalendarObservation(observation);
    }
    // voice and camera observations are handled within their respective perceivers
  });

  // Start perceivers based on user preferences
  const prefs = useUserStore.getState().preferences;

  if (prefs.calendarEnabled) {
    try {
      await perceiverManager.start("calendar");
    } catch (error) {
      console.warn("[Bootstrap] Failed to start calendar perceiver:", error);
    }
  }

  // Voice perceiver is always started (handles KWS/button listening)
  try {
    await perceiverManager.start("voice");
  } catch (error) {
    console.warn("[Bootstrap] Failed to start voice perceiver:", error);
  }

  try {
    await perceiverManager.start("camera");
  } catch (error) {
    console.warn("[Bootstrap] Failed to start camera perceiver:", error);
  }

  console.log("[Bootstrap] App initialized. Active perceivers:", perceiverManager.getRegisteredNames());
}
