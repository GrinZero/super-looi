import { NativeModule, requireNativeModule, type EventSubscription } from "expo-modules-core";

// Types
export interface KeywordDetectedEvent {
  keyword: string;
  timestamp: number;
}

export interface SpeakerVerifyResult {
  passed: boolean;
  score: number;
}

// Native module interface
type ExpoSherpaKwsEvents = {
  onKeywordDetected: (event: KeywordDetectedEvent) => void;
};

interface KeywordEmitter {
  addListener<EventName extends keyof ExpoSherpaKwsEvents>(
    eventName: EventName,
    listener: ExpoSherpaKwsEvents[EventName]
  ): EventSubscription;
}

interface ExpoSherpaKwsNativeModule extends NativeModule, KeywordEmitter {
  startKWS(modelDir: string, keywordsFile: string): Promise<void>;
  stopKWS(): Promise<void>;
  enrollSpeaker(audioSamples: number[]): Promise<boolean>;
  verifySpeaker(audioSamples: number[]): Promise<SpeakerVerifyResult>;
  getEnrollmentStatus(): Promise<boolean>;
}

// Get native module (will throw if not linked)
let nativeModule: ExpoSherpaKwsNativeModule | null = null;
try {
  nativeModule = requireNativeModule<ExpoSherpaKwsNativeModule>("ExpoSherpaKws");
} catch {
  console.warn("[expo-sherpa-kws] Native module not available. KWS/SpeakerID will be simulated.");
}

/**
 * Start keyword spotting (always-on listening for wake word)
 */
export async function startKeywordListening(modelDir: string, keywordsFile: string): Promise<void> {
  if (!nativeModule) {
    console.warn("[KWS] Native module not available, using simulated mode");
    return;
  }
  return nativeModule.startKWS(modelDir, keywordsFile);
}

/**
 * Stop keyword spotting
 */
export async function stopKeywordListening(): Promise<void> {
  if (!nativeModule) return;
  return nativeModule.stopKWS();
}

/**
 * Subscribe to keyword detection events
 */
export function onKeywordDetected(callback: (event: KeywordDetectedEvent) => void): () => void {
  if (!nativeModule) {
    return () => {};
  }
  const subscription = nativeModule.addListener("onKeywordDetected", callback);
  return () => subscription.remove();
}

/**
 * Enroll speaker voice (call with 3 recordings of wake word)
 */
export async function enrollSpeaker(audioSamples: number[]): Promise<boolean> {
  if (!nativeModule) {
    console.warn("[SpeakerID] Native module not available");
    return true;
  }
  return nativeModule.enrollSpeaker(audioSamples);
}

/**
 * Verify speaker identity
 */
export async function verifySpeaker(audioSamples: number[]): Promise<SpeakerVerifyResult> {
  if (!nativeModule) {
    return { passed: true, score: 1.0 };
  }
  return nativeModule.verifySpeaker(audioSamples);
}

/**
 * Check if speaker is enrolled
 */
export async function getEnrollmentStatus(): Promise<boolean> {
  if (!nativeModule) return false;
  return nativeModule.getEnrollmentStatus();
}
