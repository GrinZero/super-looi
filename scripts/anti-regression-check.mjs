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
  /addConversationMessage\(\{\s*role: "assistant",\s*content: result\.response,\s*evidenceUri: result\.evidenceUri,/s,
  /remembered=\$\{result\.remembered \? "yes" : "no"\}/,
  /Visual smoke succeeded/,
]);

assertPresent("server/src/routes/observe.ts", [
  /hasUsableVisualDescription/,
  /UNUSABLE_VISION_PATTERNS/,
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
