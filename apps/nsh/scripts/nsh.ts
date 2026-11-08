import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { parseEnv } from "node:util";
import { nativePluginEnvironment } from "./native-plugins.mjs";
import { buildRuntime } from "./build-runtime.js";
import { pickBuildVariables } from "./build-env.mjs";
import { prepareSherpaKws } from "./prepare-sherpa-kws.mjs";

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
if (command !== "--help" && command !== "--version") await buildRuntime({ release: command === "package" || command.startsWith("release-"), debugTelemetry: command === "run" });
const buildVariables = pickBuildVariables(config);
const target = args[args.indexOf("--target") + 1];
if (command === "build" || command === "package" || target === "android" || target === "ios" || target === "ios-simulator" || command.endsWith("-android") || command.endsWith("-ios"))
  await prepareSherpaKws(target === "android" || command.endsWith("-android") ? "android" : target === "ios" || target === "ios-simulator" || command.endsWith("-ios") ? "ios" : "all");
const nativeEnvironment = nativePluginEnvironment(buildVariables, {
  android: command.endsWith("-android") || target === "android",
  iosReleaseSimulator: command === "package" && target === "ios-simulator",
  iosSimulator:
    command.endsWith("-ios") || target === "ios" || target === "ios-simulator",
});
const uiTarget = command.endsWith("-android") ? "android" : "ios";
const standardUiSteps =
  [
    'await app.waitFor("连接", {timeout:15000})',
    'await app.press("compose")',
    'await app.waitFor("发送")',
    'await app.press("compose")',
    'await app.press("connection-settings")',
    'await app.waitFor("OpenAI / ChatGPT")',
    'const hadSubscription = app.texts().includes("已连接订阅账号")',
    'if (hadSubscription) await app.waitFor("gpt-6.1-sol")',
    'if (app.texts().includes("使用 ChatGPT 订阅登录")) { await app.press("oauth-start-btn"); await app.waitFor("系统浏览器登录授权"); }',
    'await app.press("back-to-face")',
    'await app.waitFor("连接")',
    'await app.press("connection-settings")',
    'await app.waitFor("OpenAI / ChatGPT")',
    'await app.press("appearance-cycle")',
    'await app.waitFor("外观: 日间")',
    `await app.screenshot(${JSON.stringify(resolve(repo, `docs/artifacts/nsh-node-compat/${uiTarget}-settings-light.png`))})`,
    'await app.press("back-to-face")',
    'await app.waitFor("连接")',
    `await app.screenshot(${JSON.stringify(resolve(repo, `docs/artifacts/nsh-node-compat/${uiTarget}-face-light.png`))})`,
    'await app.press("connection-settings")',
    'await app.waitFor("OpenAI / ChatGPT")',
    'if (app.texts().includes("使用 ChatGPT 订阅登录")) { await app.press("oauth-start-btn"); await app.waitFor("系统浏览器登录授权"); }',
    'await app.press("back-to-face")',
    'await app.waitFor("连接")',
    'await app.press("connection-settings")',
    'await app.waitFor("OpenAI / ChatGPT")',
    'await app.press("appearance-cycle")',
    'await app.waitFor("外观: 夜间")',
    `await app.screenshot(${JSON.stringify(resolve(repo, `docs/artifacts/nsh-node-compat/${uiTarget}-settings.png`))})`,
    'await app.press("brand-zai")',
    'await app.waitFor("标准 API (国内 BigModel)")',
    `await app.screenshot(${JSON.stringify(resolve(repo, `docs/artifacts/nsh-node-compat/${uiTarget}-settings-zai.png`))})`,
    'await app.press("nav-voice")',
    'await app.waitFor("豆包实时语音凭证")',
    `await app.screenshot(${JSON.stringify(resolve(repo, `docs/artifacts/nsh-node-compat/${uiTarget}-settings-voice.png`))})`,
    'await app.press("nav-home")',
    'await app.waitFor("米家服务区域")',
    `await app.screenshot(${JSON.stringify(resolve(repo, `docs/artifacts/nsh-node-compat/${uiTarget}-settings-home.png`))})`,
    'await app.press("nav-tasks")',
    'await app.waitFor("任务与审计记录")',
    `await app.screenshot(${JSON.stringify(resolve(repo, `docs/artifacts/nsh-node-compat/${uiTarget}-settings-tasks.png`))})`,
    'await app.press("back-to-face")',
    'await app.waitFor("连接")',
    `await app.screenshot(${JSON.stringify(resolve(repo, `docs/artifacts/nsh-node-compat/${uiTarget}-face.png`))})`,
  ].join("\n") + "\n";
const bilingualUiSteps = [
    "await app.waitFor(\"connection-settings\", {timeout:20000})",
    "await app.press(\"connection-settings\")",
    "await app.waitFor(\"language-en\", {timeout:10000})",
    "await app.press(\"language-en\")",
    "await app.waitFor(\"Models\")",
    `await app.screenshot(${JSON.stringify(resolve(repo, "docs/artifacts/multilingual/ios-models-en.png"))})`,
    "await app.press(\"brand-custom\")",
    "await app.waitFor(\"Custom endpoint · Selectable protocol\")",
    `await app.screenshot(${JSON.stringify(resolve(repo, "docs/artifacts/multilingual/ios-custom-en.png"))})`,
    "await app.press(\"nav-voice\")",
    "await app.waitFor(\"Doubao live voice credentials\")",
    `await app.screenshot(${JSON.stringify(resolve(repo, "docs/artifacts/multilingual/ios-voice-en.png"))})`,
    "await app.press(\"nav-home\")",
    "await app.waitFor(\"Connect your Xiaomi Home account\")",
    `await app.screenshot(${JSON.stringify(resolve(repo, "docs/artifacts/multilingual/ios-home-en.png"))})`,
    "await app.press(\"nav-tasks\")",
    "await app.waitFor(\"New chat\")",
    `await app.screenshot(${JSON.stringify(resolve(repo, "docs/artifacts/multilingual/ios-tasks-en.png"))})`,
    "await app.press(\"language-zh\")",
    "await app.waitFor(\"任务与审计记录\")",
    "await app.press(\"language-en\")",
    "await app.press(\"back-to-face\")",
    "await app.waitFor(\"Chat\")",
    `await app.screenshot(${JSON.stringify(resolve(repo, "docs/artifacts/multilingual/ios-face-en.png"))})`,
].join("\n") + "\n";
const uiSteps = command === "ui-bilingual-ios" ? bilingualUiSteps : command.startsWith("ui-miot-") ? [
  'await app.waitFor("陪伴待机", {timeout:15000})',
  'await app.press("connection-settings")',
  'await app.waitFor("OpenAI / ChatGPT")',
  'await app.press("nav-home")',
  'await app.waitFor("米家服务区域")',
  'await app.press("米家服务区域")',
  'await app.press("新加坡")',
  'await app.press("home-miot-login")',
  'await app.waitFor("米家登录已取消", {timeout:120000})',
  'await app.press("back-to-face")',
  'await app.waitFor("陪伴待机")',
].join("\n") + "\n" : standardUiSteps;
const uiTest = resolve(app, ".nsh/NativeUi.test.tsx");
const uiTestName = command.startsWith("ui-miot-") ? "native MIoT region, login and cancellation" : "native pure face, inline ask bar, tasks and home panels";
const uiNetwork = {
  "GET https://api.openai.com/v1/models": {
    body: { models: [
      { slug: "gpt-5.4", display_name: "GPT 5.4", visibility: "list" },
      { slug: "gpt-6.1-sol", display_name: "GPT 6.1 Sol", visibility: "list" },
    ] },
  },
};
if (command.startsWith("ui-"))
  writeFileSync(
    uiTest,
    `import {open,test} from "nsh/test";test(${JSON.stringify(uiTestName)},async()=>{const app=await open("../App.tsx", {network:${JSON.stringify(uiNetwork)}});\n${uiSteps}\n},180000);\n`,
  );
const scripted =
  command.startsWith("login-") ||
  command.startsWith("wake-") ||
  command.startsWith("probe-") ||
  command.startsWith("ui-") ||
  command.startsWith("live-");
if (command === "wake-ios") {
  const bundleId = JSON.parse(readFileSync(resolve(app, "nsh.json"), "utf8")).id;
  const grant = spawnSync("xcrun", ["simctl", "privacy", "booted", "grant", "microphone", bundleId], { stdio: "inherit" });
  if (grant.status !== 0) throw new Error("Cannot grant simulator microphone to wake probe");
}
const result = scripted
  ? spawnSync(
      binary,
      [
        "test",
        resolve(
          app,
          command.startsWith("login-")
            ? "LoginProbe.tsx"
            : command.startsWith("wake-")
            ? "WakeProbe.tsx"
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
          : command.startsWith("wake-")
          ? 'await app.waitFor("Native wake pipeline verified", {timeout:40000})\n'
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
