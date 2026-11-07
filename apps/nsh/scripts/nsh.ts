import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { parseEnv } from "node:util";
import { nativePluginEnvironment } from "./native-plugins.mjs";
import { buildRuntime } from "./build-runtime.js";
import { pickBuildVariables } from "./build-env.mjs";

const app = resolve(import.meta.dirname, "..");
const repo = resolve(app, "../..");
const revision = "e626a8dd8f8d8b277b9507cfd5ac74d0e67020f3";
const config = existsSync(resolve(repo, ".env"))
  ? parseEnv(readFileSync(resolve(repo, ".env"), "utf8"))
  : {};
const valid = (binary: string) => {
  const result = spawnSync(binary, ["--version"], { encoding: "utf8" });
  return (
    result.status === 0 &&
    result.stdout.includes("nsh 0.4.0") &&
    result.stdout.includes(revision.slice(0, 7))
  );
};
let binary = [config.NSH_CLI_PATH, process.env.NSH_CLI_PATH, "nsh"].find(
  (candidate): candidate is string => Boolean(candidate && valid(candidate)),
);
if (!binary) {
  const checkout = resolve(homedir(), ".cache/super-looi/nsh", revision);
  const run = (command: string, args: string[], cwd?: string) => {
    const result = spawnSync(command, args, { cwd, stdio: "inherit" });
    if (result.status !== 0)
      throw new Error(
        `${command} failed while preparing NSH ${revision.slice(0, 7)}`,
      );
  };
  if (!existsSync(resolve(checkout, ".git"))) {
    mkdirSync(dirname(checkout), { recursive: true });
    run("git", [
      "clone",
      "--filter=blob:none",
      "--no-checkout",
      "https://github.com/longbridge/nsh",
      checkout,
    ]);
    run("git", ["checkout", "--detach", revision], checkout);
  }
  const actual = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: checkout,
    encoding: "utf8",
  });
  if (actual.status !== 0 || actual.stdout.trim() !== revision)
    throw new Error("NSH cache revision mismatch");
  binary = resolve(checkout, "target/debug/nsh");
  if (!valid(binary))
    run("cargo", ["build", "--locked", "-p", "nsh-cli"], checkout);
  if (!valid(binary)) throw new Error("NSH CLI version verification failed");
}
const [command = "check", ...args] = process.argv.slice(2);
// Generated business code must be fresh even for a clean checkout's direct run.
if (command !== "--help" && command !== "--version") await buildRuntime();
const buildVariables = pickBuildVariables(config);
const target = args[args.indexOf("--target") + 1];
const nativeEnvironment = nativePluginEnvironment(buildVariables, {
  android: command.endsWith("-android") || target === "android",
  iosReleaseSimulator: command === "package" && target === "ios-simulator",
  iosSimulator:
    command.endsWith("-ios") || target === "ios" || target === "ios-simulator",
});
const uiTarget = command.endsWith("-android") ? "android" : "ios";
const standardUiSteps =
  [
    'await app.waitFor("陪伴待机", {timeout:15000})',
    `await app.screenshot(${JSON.stringify(resolve(repo, `docs/artifacts/nsh-node-compat/${uiTarget}-face.png`))})`,
    'await app.press("compose")',
    'await app.waitFor("发送")',
    'await app.press("compose")',
    'await app.press("connection-settings")',
    'await app.waitFor("连接设置")',
    `await app.screenshot(${JSON.stringify(resolve(repo, `docs/artifacts/nsh-node-compat/${uiTarget}-settings.png`))})`,
    'await app.press("关闭")',
    'await app.waitFor("陪伴待机")',
  ].join("\n") + "\n";
const uiSteps = command.startsWith("ui-miot-") ? [
  'await app.waitFor("陪伴待机", {timeout:15000})',
  'await app.press("connection-settings")',
  'await app.waitFor("连接设置")',
  'await app.press("home-settings")',
  'await app.waitFor("米家账号")',
  'await app.scroll("panel-content", 300)',
  'await app.press("米家服务区域")',
  'await app.press("新加坡")',
  'await app.press("home-miot-login")',
  'await app.waitFor("米家登录已取消", {timeout:120000})',
  'await app.scroll("panel-content", -500)',
  'await app.press("关闭家居")',
  'await app.press("关闭")',
].join("\n") + "\n" : standardUiSteps;
const uiTest = resolve(app, ".nsh/NativeUi.test.tsx");
const uiTestName = command.startsWith("ui-miot-") ? "native MIoT region, login and cancellation" : "native pure face, inline ask bar, tasks and home panels";
if (command.startsWith("ui-"))
  writeFileSync(
    uiTest,
    `import {open,test} from "nsh/test";test(${JSON.stringify(uiTestName)},async()=>{const app=await open("../App.tsx");\n${uiSteps}\n},180000);\n`,
  );
const scripted =
  command.startsWith("login-") ||
  command.startsWith("probe-") ||
  command.startsWith("ui-") ||
  command.startsWith("live-");
const result = scripted
  ? spawnSync(
      binary,
      [
        "test",
        resolve(
          app,
          command.startsWith("login-")
            ? "LoginProbe.tsx"
            : command.startsWith("live-")
            ? ".nsh/LiveProbe.test.tsx"
            : command.startsWith("ui-")
              ? uiTest
              : "CompatProbe.tsx",
        ),
        "--target",
        uiTarget,
        ...args,
      ],
      {
        cwd: app,
        env: nativeEnvironment,
        stdio: ["pipe", "inherit", "inherit"],
        input: command.startsWith("login-")
          ? 'await app.waitFor("Native login window verified", {timeout:20000})\n'
          : command.startsWith("live-")
          ? 'await app.waitFor("Native live verified", {timeout:90000})\n'
          : command.startsWith("ui-")
            ? uiSteps
            : 'await app.waitFor("Native bridge verified", {timeout:20000})\n',
      },
    )
  : spawnSync(binary, [command, app, ...args], {
      cwd: app,
      env: nativeEnvironment,
      stdio: "inherit",
    });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
