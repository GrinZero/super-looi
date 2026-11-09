import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { parseEnv } from "node:util";
import { nativePluginEnvironment, patchIosApp } from "./native-plugins.mjs";
import { runIosDevice } from "./ios-device.mjs";
import { buildRuntime } from "./build-runtime.js";
import { pickBuildVariables } from "./build-env.mjs";
import { prepareLinuxShell } from "./prepare-linux-shell.mjs";
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
const option = (name: string) => {
  const index = args.indexOf(name);
  return index < 0
    ? args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1)
    : args[index + 1];
};
// Generated business code must be fresh even for a clean checkout's direct run.
if (command !== "--help" && command !== "--version") await buildRuntime({ release: command === "package" || command.startsWith("release-"), debugTelemetry: command === "run" });
const buildVariables = pickBuildVariables(config);
const target = option("--target");
if (command === "build" || command === "package" || target === "android" || target === "ios" || target === "ios-simulator" || command.endsWith("-android") || command.endsWith("-ios"))
  await prepareSherpaKws(target === "android" || command.endsWith("-android") ? "android" : target === "ios" || target === "ios-simulator" || command.endsWith("-ios") ? "ios" : "all");
const isIos = command.endsWith("-ios") || target === "ios" || target === "ios-simulator";
const isAndroid = command.endsWith("-android") || target === "android";
if (isIos || isAndroid) await prepareLinuxShell(isAndroid ? "android" : "ios", { ...process.env, ...buildVariables });
const nativeEnvironment = nativePluginEnvironment(buildVariables, {
  android: command.endsWith("-android") || target === "android",
  androidDevice: option("--device"),
  iosReleaseSimulator: command === "package" && target === "ios-simulator",
  ios: isIos,
  iosSimulator: isIos && (target === "ios-simulator" || (command !== "package" && !option("--device"))),
  iosDevelopment:
    command !== "package" &&
    (command.endsWith("-ios") || target === "ios" || target === "ios-simulator"),
});
if (isAndroid && option("--device")) {
  const requested = option("--device")!;
  const inventory = spawnSync("adb", ["devices"], {encoding:"utf8"}).stdout;
  const connected = inventory.split("\n").map(line=>line.trim().split(/\s+/)).some(fields=>fields[0]===requested && fields[1]==="device");
  if (!connected) throw new Error(`Android device is not connected: ${requested}`);
  const index = args.indexOf("--device");
  if (index >= 0) args.splice(index,2);
  else args.splice(args.findIndex(arg=>arg.startsWith("--device=")),1);
}
if (isIos && (command === "run" || command.startsWith("probe-") || command.startsWith("linux-"))) {
  const device = option("--device");
  if (!device) throw new Error("Specify --device <iPhone UDID> for physical iOS runs; use package --target ios-simulator for compilation checks");
  const probe = command.startsWith("probe-") ? {success:"Native bridge verified",timeout:60_000}
    : command.startsWith("linux-") ? {success:"Linux Shell verified",timeout:600_000} : undefined;
  const entry = probe ? resolve(app, command.startsWith("linux-") ? "LinuxProbe.tsx" : "CompatProbe.tsx")
    : args.find(arg=>arg.endsWith(".tsx"));
  await runIosDevice({binary,app,entry,device,env:nativeEnvironment,config,probe});
  process.exit(0);
}
const uiTarget = command.endsWith("-android") ? "android" : "ios";
const standardUiSteps =
  [
    'await app.waitFor("connection-settings", {timeout:15000})',
    'await app.press("compose")',
    'await app.waitFor("发送")',
    'await app.press("compose")',
    'await app.press("connection-settings")',
    'await app.waitFor("OpenAI / ChatGPT")',
    'const hadSubscription = app.texts().includes("已连接订阅账号") && !app.texts().some((t) => t.includes("OAuth refresh failed"))',
    'if (hadSubscription) await app.waitFor("gpt-6.1-sol")',
    'if (app.texts().includes("使用 ChatGPT 订阅登录")) { await app.press("oauth-start-btn"); await app.waitFor("系统浏览器登录授权"); }',
    'await app.press("back-to-face")',
    'await app.waitFor("connection-settings")',
    'await app.press("connection-settings")',
    'await app.waitFor("OpenAI / ChatGPT")',
    'await app.press("nav-settings")',
    'await app.waitFor("通用设置")',
    'await app.press("appearance-light")',
    'await app.waitFor("当前生效：浅色")',
    'await app.press("nav-models")',
    'await app.waitFor("OpenAI / ChatGPT")',
    `await app.screenshot(${JSON.stringify(resolve(repo, `docs/artifacts/nsh-node-compat/${uiTarget}-settings-light.png`))})`,
    'await app.press("nav-body")',
    'await app.waitFor("方向轮盘")',
    'await app.press("body-mode-sim")',
    'await app.waitFor("已吸合就绪")',
    `await app.screenshot(${JSON.stringify(resolve(repo, `docs/artifacts/nsh-node-compat/${uiTarget}-settings-body-light.png`))})`,
    'await app.press("back-to-face")',
    'await app.waitFor("connection-settings")',
    `await app.screenshot(${JSON.stringify(resolve(repo, `docs/artifacts/nsh-node-compat/${uiTarget}-face-light.png`))})`,
    'await app.press("connection-settings")',
    'await app.waitFor("OpenAI / ChatGPT")',
    'if (app.texts().includes("使用 ChatGPT 订阅登录")) { await app.press("oauth-start-btn"); await app.waitFor("系统浏览器登录授权"); }',
    'await app.press("back-to-face")',
    'await app.waitFor("connection-settings")',
    'await app.press("connection-settings")',
    'await app.waitFor("OpenAI / ChatGPT")',
    'await app.press("nav-settings")',
    'await app.waitFor("通用设置")',
    'await app.press("appearance-dark")',
    'await app.waitFor("当前生效：深色")',
    'await app.press("nav-models")',
    'await app.waitFor("OpenAI / ChatGPT")',
    `await app.screenshot(${JSON.stringify(resolve(repo, `docs/artifacts/nsh-node-compat/${uiTarget}-settings.png`))})`,
    'await app.press("brand-zai")',
    'await app.waitFor("标准 API (国内 BigModel)")',
    `await app.screenshot(${JSON.stringify(resolve(repo, `docs/artifacts/nsh-node-compat/${uiTarget}-settings-zai.png`))})`,
    'await app.press("nav-voice")',
    'await app.waitFor("豆包实时语音凭证")',
    `await app.screenshot(${JSON.stringify(resolve(repo, `docs/artifacts/nsh-node-compat/${uiTarget}-settings-voice.png`))})`,
    'await app.press("nav-body")',
    'await app.waitFor("方向轮盘")',
    'await app.press("body-mode-sim")',
    'await app.waitFor("已吸合就绪")',
    `await app.screenshot(${JSON.stringify(resolve(repo, `docs/artifacts/nsh-node-compat/${uiTarget}-settings-body.png`))})`,
    'await app.press("nav-home")',
    'await app.waitFor("米家服务区域")',
    `await app.screenshot(${JSON.stringify(resolve(repo, `docs/artifacts/nsh-node-compat/${uiTarget}-settings-home.png`))})`,
    'await app.press("nav-tasks")',
    'await app.waitFor("任务与审计记录")',
    `await app.screenshot(${JSON.stringify(resolve(repo, `docs/artifacts/nsh-node-compat/${uiTarget}-settings-tasks.png`))})`,
    'await app.press("back-to-face")',
    'await app.waitFor("connection-settings")',
    `await app.screenshot(${JSON.stringify(resolve(repo, `docs/artifacts/nsh-node-compat/${uiTarget}-face.png`))})`,
  ].join("\n") + "\n";
const bilingualUiSteps = [
    "await app.waitFor(\"connection-settings\", {timeout:20000})",
    "await app.press(\"connection-settings\")",
    "await app.waitFor(\"nav-settings\", {timeout:10000})",
    "await app.press(\"nav-settings\")",
    "await app.waitFor(\"language-select\", {timeout:10000})",
    "await app.press(\"language-select\")",
    "await app.press(\"English\")",
    "await app.waitFor(\"General settings\")",
    `await app.screenshot(${JSON.stringify(resolve(repo, "docs/artifacts/multilingual/ios-settings-en.png"))})`,
    "await app.press(\"nav-models\")",
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
    "await app.press(\"nav-settings\")",
    "await app.press(\"language-select\")",
    "await app.press(\"简体中文\")",
    "await app.waitFor(\"通用设置\")",
    "await app.press(\"language-select\")",
    "await app.press(\"English\")",
    "await app.waitFor(\"General settings\")",
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
  'await app.press("home-miot-region")',
  'await app.press("新加坡")',
  'await app.press("home-miot-login")',
  'await app.waitFor("米家登录已取消", {timeout:120000})',
  'await app.press("back-to-face")',
  'await app.waitFor("陪伴待机")',
].join("\n") + "\n" : standardUiSteps;
const uiTest = resolve(app, ".nsh/NativeUi.test.tsx");
const uiTestName = command.startsWith("ui-miot-") ? "native MIoT region, login and cancellation" : "native pure face, inline ask bar, tasks and home panels";
const uiNetwork = {
  "POST https://auth.openai.com/api/accounts/oauth/token": {
    body: {
      access_token: "test_access_token",
      refresh_token: "test_refresh_token",
      expires_in: 3600,
      scope: "openid profile email offline_access api.connectors.read api.connectors.invoke",
    },
  },
  "GET https://chatgpt.com/backend-api/codex/models": {
    body: { models: [
      { slug: "gpt-5.4", display_name: "GPT 5.4", visibility: "list" },
      { slug: "gpt-6.1-sol", display_name: "GPT 6.1 Sol", visibility: "list" },
    ] },
  },
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
const nativeProbe = command.startsWith("probe-") || command.startsWith("linux-");
const probeFile = resolve(app, command.startsWith("linux-") ? ".nsh/LinuxProbe.test.tsx" : ".nsh/CompatProbe.test.tsx");
if (nativeProbe) {
  const linux = command.startsWith("linux-");
  const entry = linux ? "LinuxProbe.tsx" : "CompatProbe.tsx";
  const success = linux ? "Linux Shell verified" : "Native bridge verified";
  const timeout = linux ? 600000 : 60000;
  writeFileSync(probeFile, `import {open,test} from "nsh/test";test(${JSON.stringify(success)},async()=>{const app=await open(${JSON.stringify("../" + entry)});await app.waitFor(${JSON.stringify(success)},{timeout:${timeout}});},${timeout+30000});`);
}
const scripted =
  command.startsWith("login-") ||
  command.startsWith("wake-") ||
  command.startsWith("probe-") ||
  command.startsWith("linux-") ||
  command.startsWith("ui-") ||
  command.startsWith("live-");
if (command === "wake-ios") {
  const bundleId = JSON.parse(readFileSync(resolve(app, "nsh.json"), "utf8")).id;
  const grant = spawnSync("xcrun", ["simctl", "privacy", "booted", "grant", "microphone", bundleId], { stdio: "inherit" });
  if (grant.status !== 0) throw new Error("Cannot grant simulator microphone to wake probe");
}
const optionFlags = new Set([
  "--target",
  "--port",
  "--device",
  "--limits",
  "--name",
  "--window-size",
  "--display",
  "--out",
  "-o",
]);
const hasCustomEntry = args.some(
  (arg, idx) =>
    !arg.startsWith("-") && (idx === 0 || !optionFlags.has(args[idx - 1] ?? "")),
);
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
              : probeFile,
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
          : command.startsWith("linux-")
          ? 'await app.waitFor("Linux Shell verified", {timeout:600000})\n'
          : command.startsWith("live-")
          ? 'await app.waitFor("Native live verified", {timeout:90000})\n'
          : command.startsWith("ui-")
            ? uiSteps
            : 'await app.waitFor("Native bridge verified", {timeout:60000})\n',
      },
    )
  : spawnSync(binary, hasCustomEntry ? [command, ...args] : [command, app, ...args], {
      cwd: app,
      env: nativeEnvironment,
      stdio: "inherit",
    });
if (result.error) throw result.error;
if (
  result.status === 0 && command === "package" && target === "ios" &&
  !args.some((arg) => arg === "--sign" || arg.startsWith("--sign="))
) {
  const out = option("--out") ?? option("-o") ?? ".nsh/out";
  const name = option("--name") ??
    JSON.parse(readFileSync(resolve(app, "nsh.json"), "utf8")).name;
  patchIosApp(resolve(app, out, `${name}.app`));
}
process.exitCode = result.status ?? 1;
