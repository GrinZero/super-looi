import { perceiverManager } from "./perceiver-manager";
import { calendarPerceiver } from "../perceivers/calendar-perceiver";
import { cameraPerceiver } from "../perceivers/camera-perceiver";
import { voiceRuntime } from "../perceivers/voice-runtime";
import { reminderScheduler } from "../reminder/reminder-scheduler";
import { setupNotifications } from "../reminder/notification";
import { useUserStore } from "../store/user";
import { getConfiguredServerUrl } from "../server-api/client";
import { registerAndPollDeviceTools } from "../device-tools/registry";
import {
  getLoadedSttModule,
  getLoadedTtsModule,
} from "../voice/lazy-services";

let bootstrapped = false;
let paused = false;
let ownerEnrollmentPromise: Promise<void> | null = null;

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

  registerAndPollDeviceTools(getConfiguredServerUrl()).catch((error) => {
    console.warn("[Bootstrap] Failed to register device tools:", error);
  });

  console.log("[Bootstrap] App initialized. Active perceivers:", perceiverManager.getRegisteredNames());

  runOptInVadSmokeOnBoot();
  runOptInConversationSmokeOnBoot();
  runOptInOwnerEnrollmentOnBoot();
  runOptInLiveVoiceAcceptanceOnBoot();
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

  registerAndPollDeviceTools(getConfiguredServerUrl()).catch((error) => {
    console.warn("[Bootstrap] Failed to register device tools:", error);
  });
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

function runOptInLiveVoiceAcceptanceOnBoot(): void {
  if (process.env.EXPO_PUBLIC_LOOI_RUN_LIVE_VOICE_ACCEPTANCE_ON_BOOT !== "1") return;

  void runLiveVoiceAcceptanceSequence().catch((error) => {
    console.error("[Diagnostics] Live voice acceptance failed:", error);
  });
}

function runOptInOwnerEnrollmentOnBoot(): void {
  if (process.env.EXPO_PUBLIC_LOOI_ENROLL_OWNER_ON_BOOT !== "1") return;

  ownerEnrollmentPromise = runOwnerEnrollmentSequence().catch((error) => {
    console.error("[Diagnostics] Owner enrollment failed:", error);
  });
}

async function runOwnerEnrollmentSequence(): Promise<void> {
  const delayMs = getOwnerEnrollmentStartDelayMs();
  const durationMs = getOwnerEnrollmentDurationMs();
  if (delayMs > 0) {
    await sleep(delayMs);
  }

  const { sttService } = await import("../voice/stt");
  const { speakerIdService } = await import("../voice/speaker-id");

  console.log(
    `[Diagnostics] Owner enrollment: speak after this log; recording ${durationMs}ms for owner voice.`
  );
  useUserStore.getState().setVoiceState("listening");
  await sttService.startRecording();

  try {
    await sleep(durationMs);
    useUserStore.getState().setVoiceState("verifying");
    const audioUri = await sttService.stopRecording();
    await speakerIdService.enrollFromFile(audioUri);
    useUserStore.getState().setVoiceEnrolled(true);
    console.log(`[Diagnostics] Owner enrollment succeeded: audioUri=${audioUri}`);
  } finally {
    await sttService.resumeWakewordFeederIfPaused();
    useUserStore.getState().setVoiceState("sleeping");
  }
}

async function runLiveVoiceAcceptanceSequence(): Promise<void> {
  await ownerEnrollmentPromise;
  const repeat = getLiveVoiceAcceptanceRepeatCount();
  const delayMs = getLiveVoiceAcceptanceStartDelayMs();

  for (let index = 0; index < repeat; index += 1) {
    await waitForVoiceIdle();
    if (delayMs > 0) {
      await sleep(delayMs);
    }

    console.log(
      `[Diagnostics] Live voice acceptance ${index + 1}/${repeat}: ` +
        "speak after this log; VAD should finish the recording automatically."
    );
    await voiceRuntime.trigger();
    await waitForVoiceIdle();
  }
}

function getLiveVoiceAcceptanceRepeatCount(): number {
  const raw = process.env.EXPO_PUBLIC_LOOI_LIVE_VOICE_ACCEPTANCE_REPEAT;
  const parsed = raw ? Number.parseInt(raw, 10) : 1;
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(1, Math.min(parsed, 5));
}

function getLiveVoiceAcceptanceStartDelayMs(): number {
  const raw = process.env.EXPO_PUBLIC_LOOI_LIVE_VOICE_ACCEPTANCE_START_DELAY_MS;
  const parsed = raw ? Number.parseInt(raw, 10) : 5000;
  if (!Number.isFinite(parsed)) return 5000;
  return Math.max(0, Math.min(parsed, 30_000));
}

function getOwnerEnrollmentStartDelayMs(): number {
  const raw = process.env.EXPO_PUBLIC_LOOI_OWNER_ENROLLMENT_START_DELAY_MS;
  const parsed = raw ? Number.parseInt(raw, 10) : 5000;
  if (!Number.isFinite(parsed)) return 5000;
  return Math.max(0, Math.min(parsed, 30_000));
}

function getOwnerEnrollmentDurationMs(): number {
  const raw = process.env.EXPO_PUBLIC_LOOI_OWNER_ENROLLMENT_DURATION_MS;
  const parsed = raw ? Number.parseInt(raw, 10) : 3000;
  if (!Number.isFinite(parsed)) return 3000;
  return Math.max(1000, Math.min(parsed, 10_000));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForVoiceIdle(timeoutMs = 45_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const userState = useUserStore.getState();
    if (userState.voiceState === "sleeping") {
      return;
    }
    await sleep(500);
  }
  throw new Error("Live voice acceptance timed out waiting for the voice pipeline to return idle");
}
