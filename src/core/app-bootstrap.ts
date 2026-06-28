import { perceiverManager } from "./perceiver-manager";
import { calendarPerceiver } from "../perceivers/calendar-perceiver";
import { cameraPerceiver } from "../perceivers/camera-perceiver";
import { voiceRuntime } from "../perceivers/voice-runtime";
import { reminderScheduler } from "../reminder/reminder-scheduler";
import { setupNotifications } from "../reminder/notification";
import { useUserStore } from "../store/user";
import {
  getLoadedSttModule,
  getLoadedTtsModule,
} from "../voice/lazy-services";

let bootstrapped = false;
let paused = false;

/**
 * Initialize all perceivers and wire observation events.
 * Called once at app startup.
 */
export async function bootstrapApp(): Promise<void> {
  if (bootstrapped) return;
  bootstrapped = true;

  // Setup notifications
  setupNotifications();

  // Register all perceivers
  perceiverManager.register(voiceRuntime);
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

  await startRuntimePerceivers();

  console.log("[Bootstrap] App initialized. Active perceivers:", perceiverManager.getRegisteredNames());

  runOptInVadSmokeOnBoot();
  runOptInConversationSmokeOnBoot();
}

export async function pauseAppRuntime(): Promise<void> {
  if (!bootstrapped || paused) return;
  paused = true;

  const sttModule = getLoadedSttModule();
  const ttsModule = getLoadedTtsModule();

  await Promise.allSettled([
    perceiverManager.stopAll(),
    sttModule?.then(({ sttService }) => sttService.cancel()),
    ttsModule?.then(({ ttsService }) => ttsService.stop()),
  ].filter(Boolean));
  useUserStore.getState().setVoiceState("sleeping");
  console.log("[Bootstrap] App runtime paused");
}

export async function resumeAppRuntime(): Promise<void> {
  if (!bootstrapped || !paused) return;
  paused = false;
  await startRuntimePerceivers();
  console.log("[Bootstrap] App runtime resumed");
}

async function startRuntimePerceivers(): Promise<void> {
  try {
    await perceiverManager.start("voice");
  } catch (error) {
    console.warn("[Bootstrap] Failed to start voice perceiver:", error);
  }
}

function runOptInVadSmokeOnBoot(): void {
  if (process.env.EXPO_PUBLIC_LOOI_RUN_VAD_SMOKE_ON_BOOT !== "1") return;

  void import("../voice/vad-diagnostic")
    .then(({ runVadDiagnosticSmoke }) => runVadDiagnosticSmoke())
    .then(({ summary }) => {
      const firstSegment = summary.firstSegment
        ? `${summary.firstSegment.startTime?.toFixed(2)}-${summary.firstSegment.endTime?.toFixed(2)}s`
        : "(none)";
      console.log(
        `[Diagnostics] VAD smoke succeeded: speech=${summary.speechDetected ? "yes" : "no"} | ` +
          `segments=${summary.segmentCount} | first=${firstSegment}`
      );
    })
    .catch((error) => {
      console.error("[Diagnostics] VAD smoke failed:", error);
    });
}

function runOptInConversationSmokeOnBoot(): void {
  if (process.env.EXPO_PUBLIC_LOOI_RUN_CONVERSATION_SMOKE_ON_BOOT !== "1") return;

  void import("../voice/conversation-diagnostic")
    .then(async ({ runConversationDiagnosticSmoke }) => {
      const repeat = getConversationSmokeRepeatCount();
      for (let index = 0; index < repeat; index += 1) {
        const summary = await runConversationDiagnosticSmoke();
        console.log(
          `[Diagnostics] Conversation smoke ${index + 1}/${repeat} succeeded: ` +
            `transcript=${JSON.stringify(summary.transcript)} | ` +
            `tokens=${summary.tokenCount} | ` +
            `asrDoneMs=${summary.asrDoneMs} | ` +
            `firstTokenMs=${summary.firstTokenMs ?? "n/a"} | ` +
            `firstTokenAfterAsrMs=${summary.firstTokenAfterAsrMs ?? "n/a"} | ` +
            `firstTtsStartMs=${summary.firstTtsStartMs ?? "n/a"} | ` +
            `firstTtsAfterTokenMs=${summary.firstTtsAfterTokenMs ?? "n/a"} | ` +
            `streamDoneMs=${summary.streamDoneMs ?? "n/a"} | ` +
            `totalMs=${summary.totalMs}`
        );
      }
    })
    .catch((error) => {
      console.error("[Diagnostics] Conversation smoke failed:", error);
    });
}

function getConversationSmokeRepeatCount(): number {
  const raw = process.env.EXPO_PUBLIC_LOOI_CONVERSATION_SMOKE_REPEAT;
  const parsed = raw ? Number.parseInt(raw, 10) : 1;
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(1, Math.min(parsed, 10));
}
