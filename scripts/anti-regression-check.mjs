import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

function read(path) {
  return readFileSync(join(root, path), "utf8");
}

function assertAbsent(path, patterns) {
  const content = read(path);
  for (const pattern of patterns) {
    assert.doesNotMatch(content, pattern, `${path} must not match ${pattern}`);
  }
}

function assertPresent(path, patterns) {
  const content = read(path);
  for (const pattern of patterns) {
    assert.match(content, pattern, `${path} must match ${pattern}`);
  }
}

assert.equal(
  existsSync(join(root, "server/src/routes/stt.ts")),
  false,
  "server STT fallback route must stay deleted"
);

assertAbsent("server/src/index.ts", [
  /routes\/stt/,
  /sttRoutes/,
  /\/api\/stt/,
]);

assertAbsent("src/voice/stt.ts", [
  /\/api\/stt/,
  /audio\/transcriptions/,
  /Whisper/i,
  /gpt-4o-transcribe/,
]);

assertPresent("src/voice/stt.ts", [
  /sherpaVoiceAdapter\.transcribeFile/,
  /kwsAudioFeeder\.stop\(\)/,
  /kwsAudioFeeder\.start\(\)/,
  /resumeWakewordFeederIfPaused/,
  /Paused KWS feeder for recording/,
  /Resumed KWS feeder after recording/,
]);

assertPresent("src/perceivers/voice-perceiver.ts", [
  /speakerIdService\.verifyFile\(audioUri\)/,
  /sttService\.transcribeFile\(audioUri\)/,
  /sttService\.resumeWakewordFeederIfPaused\(\)/,
  /observeService\.voiceVisual/,
  /evidenceUri = result\.evidenceUri/,
]);

assertPresent("src/voice/speaker-id.ts", [
  /restoreOwnerEmbedding\(\)/,
  /Restored owner embedding from SecureStore/,
  /SecureStore\.setItemAsync/,
  /SecureStore\.getItemAsync/,
]);

assertPresent("src/voice/sherpa-adapter.ts", [
  /SpeakerId\.getSpeakers\(\)/,
  /SpeakerId\.removeSpeaker\(name\)/,
  /SpeakerId\.registerSpeaker\(name, embedding\)/,
]);

assertAbsent("app/(tabs)/settings.tsx", [
  /Phase 1\.5/,
  /唤醒词（Phase 1\.5）/,
]);

assertPresent("app/(tabs)/settings.tsx", [
  /cameraPerceiver\.getLatestFrame\(\)/,
  /observeService\.voiceVisual/,
  /reminderScheduler\.processCalendarObservation/,
  /calendarPerceiver\.checkNow\(\)/,
  /Real calendar smoke succeeded/,
  /Calendar\.createEventAsync/,
  /Calendar smoke succeeded/,
  /speakerIdService\.refreshEnrollmentStatus\(\)/,
  /Speaker verify succeeded/,
  /验证已注册声纹/,
  /addConversationMessage\(\{\s*role: "assistant",\s*content: result\.response,\s*evidenceUri: result\.evidenceUri,/s,
  /remembered=\$\{result\.remembered \? "yes" : "no"\}/,
  /Visual smoke succeeded/,
]);

assertPresent("src/perceivers/calendar-perceiver.ts", [
  /async checkNow\(\): Promise<number>/,
  /let emitted = 0/,
  /return emitted/,
]);

assertPresent("src/reminder/reminder-scheduler.ts", [
  /export interface ReminderResult/,
  /notificationId = await sendImmediateNotification/,
  /Calendar reminder sent/,
  /return \{ response, notificationId, spoke, ttsError \}/,
]);

assertPresent("src/voice/tts.ts", [
  /BINARY_STRING_CHUNK_SIZE/,
  /bytes\.subarray/,
  /TTS_PLAYBACK_MAX_TIMEOUT_MS/,
  /Playback timeout/,
  /resolveOnce/,
]);

assertPresent("server/src/routes/observe.ts", [
  /hasUsableVisualDescription/,
  /UNUSABLE_VISION_PATTERNS/,
  /extractExplicitPlacement/,
  /placementFact/,
  /if \(usableVisualDescription\) \{\s*await dependencies\.addMemory/s,
  /remembered: usableVisualDescription/,
]);

assertPresent("server/tests/observe.test.ts", [
  /infer\?: boolean/,
  /assert\.equal\(stored\[0\]\.options\?\.infer, false\)/,
  /assert\.equal\(stored\[0\]\.metadata\?\.evidenceUri/,
  /does not store unusable visual descriptions/,
  /assert\.equal\(stored\.length, 0\)/,
]);

assertPresent("server/src/routes/llm.ts", [
  /if \(intent === "search"\) \{\s*return \{ response: buildGroundedSearchResponse\(facts\) \};\s*\}/s,
  /export function buildGroundedSearchResponse/,
]);

assertPresent("src/perceivers/voice-perceiver.ts", [
  /evidenceUri = facts\.find\(\(fact\) => fact\.metadata\?\.evidenceUri\)\?\.metadata\?\.evidenceUri/,
]);

assertPresent("server/tests/anti-regression.test.ts", [
  /\/api\/stt\/transcribe/,
  /assert\.equal\(response\.statusCode, 404\)/,
]);

assertPresent("server/src/routes/memory.ts", [
  /buildOwnerMemoryFilters/,
  /user_id: USER_ID/,
  /memoryFilters\.category = filters\.category/,
]);

assertPresent("server/tests/memory.test.ts", [
  /buildOwnerMemoryFilters/,
  /user_id: "owner-1"/,
  /category: "placement"/,
]);

assertPresent("src/ui/ChatBubble.tsx", [
  /message\.evidenceUri/,
  /<Image source=\{\{ uri: message\.evidenceUri \}\}/,
]);

assertPresent("src/ui/MemoryCard.tsx", [
  /memory\.metadata\?\.evidenceUri/,
  /<Image source=\{\{ uri: memory\.metadata\.evidenceUri \}\}/,
]);

console.log("Anti-regression checks passed");
