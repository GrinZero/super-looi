import { spawn, spawnSync } from "node:child_process";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { loadBuildVariables } from "./build-env.mjs";

const app = resolve(import.meta.dirname, ".."),
  env = { ...process.env, ...loadBuildVariables() };
const sdk =
  env.NSH_REAL_ANDROID_SDK ??
  env.ANDROID_HOME ??
  env.ANDROID_SDK_ROOT ??
  join(homedir(), "Library/Android/sdk");
if (env.JAVA_HOME) env.PATH = join(env.JAVA_HOME, "bin") + ":" + env.PATH;
const adb = join(sdk, "platform-tools/adb");
const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: app, env, encoding: "utf8" });
  if (result.status !== 0)
    throw new Error(
      `${command}: ${result.stderr ?? result.error ?? result.status}`,
    );
  return result.stdout;
};
const serial = run(adb, ["devices"])
  .split("\n")
  .map((line) => line.split("\t"))
  .find(([, state]) => state === "device")?.[0];
if (!serial) throw new Error("Connect an Android device or emulator first");
run(process.execPath, [join(app, "scripts/build-android-ui-probe.mjs")]);
run(adb, [
  "-s",
  serial,
  "install",
  "-r",
  "-t",
  join(app, ".nsh/android-ui-probe/probe-aligned.apk"),
]);
const child = spawn(
  "pnpm",
  ["exec", "tsx", "scripts/nsh.ts", "run", "--target", "android"],
  { cwd: app, env, detached: true, stdio: ["ignore", "pipe", "pipe"] },
);
try {
  await new Promise((done, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Android UI host did not connect")),
      600000,
    );
    const connected = (chunk) => {
      const text = chunk.toString();
      process.stdout.write(text);
      if (text.includes("connected, build")) {
        clearTimeout(timeout);
        done();
      }
    };
    child.stdout.on("data", connected);
    child.stderr.on("data", connected);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Android UI host exited (${code})`));
    });
  });
  const result = run(adb, [
    "-s",
    serial,
    "shell",
    "am",
    "instrument",
    "-w",
    "com.superlooi.nsh.uitest/com.superlooi.nsh.test.UiProbe",
  ]);
  if (
    !result.includes("PASS native Android") ||
    !result.includes("INSTRUMENTATION_CODE: -1")
  )
    throw new Error(result);
  process.stdout.write(result);
} finally {
  // Only this verifier's own process group, never an unrelated dev server.
  try {
    process.kill(-child.pid, "SIGINT");
  } catch {}
}
