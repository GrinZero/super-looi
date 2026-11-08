import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";

const names = [
  "ANDROID_HOME",
  "ANDROID_SDK_ROOT",
  "NSH_REAL_ANDROID_SDK",
  "ANDROID_NDK_HOME",
  "JAVA_HOME",
];
/** Only toolchain variables reach build tools; model/voice keys stay private. */
export function pickBuildVariables(config) {
  return Object.fromEntries(
    names
      .filter((name) => typeof config[name] === "string")
      .map((name) => [name, config[name]]),
  );
}
export function loadBuildVariables() {
  const file = resolve(import.meta.dirname, "../../../.env");
  return pickBuildVariables(
    existsSync(file) ? parseEnv(readFileSync(file, "utf8")) : {},
  );
}
export function loadRuntimeVariables({ release = false, debugTelemetry = false } = {}) {
  const file = resolve(import.meta.dirname, "../../../.env");
  const values = { ...(existsSync(file) ? parseEnv(readFileSync(file, "utf8")) : {}), ...process.env };
  const telemetry = debugTelemetry && values.LOOI_DEBUG_TELEMETRY === "1" && !release;
  return {
    VOICE_PROVIDER: values.VOICE_PROVIDER || "doubao",
    VOICE_BASE_URL: values.VOICE_BASE_URL || "",
    VOICE_MODEL: values.VOICE_MODEL || "",
    LANGFUSE_BASE_URL: telemetry ? values.LANGFUSE_BASE_URL || "" : "",
    LANGFUSE_PUBLIC_KEY: telemetry ? values.LANGFUSE_PUBLIC_KEY || "" : "",
    LANGFUSE_SECRET_KEY: telemetry ? values.LANGFUSE_SECRET_KEY || "" : "",
  };
}
