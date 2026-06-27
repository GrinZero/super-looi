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
]);

assertPresent("src/perceivers/voice-perceiver.ts", [
  /speakerIdService\.verifyFile\(audioUri\)/,
  /sttService\.transcribeFile\(audioUri\)/,
  /observeService\.voiceVisual/,
  /evidenceUri = result\.evidenceUri/,
]);

assertPresent("server/tests/observe.test.ts", [
  /infer\?: boolean/,
  /assert\.equal\(stored\[0\]\.options\?\.infer, false\)/,
  /assert\.equal\(stored\[0\]\.metadata\?\.evidenceUri/,
]);

assertPresent("server/tests/anti-regression.test.ts", [
  /\/api\/stt\/transcribe/,
  /assert\.equal\(response\.statusCode, 404\)/,
]);

console.log("Anti-regression checks passed");
