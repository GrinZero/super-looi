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
