import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
  mkdtempSync,
  rmSync,
  lstatSync,
  readlinkSync,
  unlinkSync,
} from "node:fs";
import { dirname, resolve, join, delimiter } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { cache as sherpaCache } from "./prepare-sherpa-kws.mjs";

const app = resolve(import.meta.dirname, ".."),
  bin = join(app, "scripts/native-bin");
const config = JSON.parse(
  readFileSync(join(app, "native/plugins.json"), "utf8"),
);
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.status !== 0)
    throw new Error(
      `${command} native plugin failed: ${result.stderr ?? result.error ?? result.status}`,
    );
  return result.stdout;
}
/** App-local SDK overlay registers a pre-sign plugin without editing NSH,
 * the installed SDK, or Expo prebuild outputs. */
export function nativePluginEnvironment(buildVariables = {}, targets = {}) {
  const env = { ...process.env, ...buildVariables, LOOI_SHERPA_CACHE_DIR: sherpaCache };
  if (env.JAVA_HOME)
    env.PATH = join(env.JAVA_HOME, "bin") + delimiter + env.PATH;
  if (targets.iosSimulator) {
    env.PATH = bin + delimiter + env.PATH;
    if (targets.iosDevelopment) {
      // NSH rewrites the development host plist on every run, but signs it
      // only when its binary changed. Force signing so the plist is patched.
      for (const path of [
        ".nsh/ios/NshDev.app/_CodeSignature",
        ".nsh/test/ios/ios/NshDev.app/_CodeSignature",
      ])
        rmSync(join(app, path), { recursive: true, force: true });
    }
    const applicationIdentifier = targets.iosReleaseSimulator
      ? config.iosSimulator.releaseApplicationIdentifier
      : config.iosSimulator.applicationIdentifier;
    if (!applicationIdentifier)
      throw new Error("Missing simulator application identity");
    const content = `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>application-identifier</key><string>${applicationIdentifier}</string><key>keychain-access-groups</key><array><string>${applicationIdentifier}</string></array></dict></plist>`;
    const digest = createHash("sha256")
      .update(content)
      .digest("hex")
      .slice(0, 16);
    const entitlements = join(
      app,
      `.nsh/native-simulator-${digest}.entitlements`,
    );
    mkdirSync(dirname(entitlements), { recursive: true });
    if (!existsSync(entitlements)) writeFileSync(entitlements, content);
    // Match Xcode's Simulated.xcent section. A device entitlement signature
    // on an ad-hoc simulator host prevents launch on current simulators.
    env.CARGO_TARGET_AARCH64_APPLE_IOS_SIM_RUSTFLAGS = [
      env.CARGO_TARGET_AARCH64_APPLE_IOS_SIM_RUSTFLAGS,
      `-Clink-arg=-Wl,-sectcreate,__TEXT,__entitlements,${entitlements}`,
    ]
      .filter(Boolean)
      .join(" ");
  }
  if (!targets.android) return env;
  const sdk =
    env.NSH_REAL_ANDROID_SDK ??
    env.ANDROID_HOME ??
    env.ANDROID_SDK_ROOT ??
    join(homedir(), "Library/Android/sdk");
  if (!existsSync(join(sdk, "build-tools")))
    throw new Error("Android SDK build-tools directory is missing");
  const overlay = join(app, ".nsh/native-sdk");
  mkdirSync(overlay, { recursive: true });
  const link = (source, target) => {
    try {
      if (!lstatSync(target).isSymbolicLink())
        throw new Error("SDK overlay path is not a symlink");
      if (readlinkSync(target) === source) return;
      unlinkSync(target);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    symlinkSync(source, target);
  };
  for (const name of [
    "platform-tools",
    "platforms",
    "ndk",
    "cmake",
    "cmdline-tools",
    "licenses",
    "emulator",
  ])
    if (existsSync(join(sdk, name))) link(join(sdk, name), join(overlay, name));
  mkdirSync(join(overlay, "build-tools"), { recursive: true });
  const versions = readdirSync(join(sdk, "build-tools")).filter((version) =>
    existsSync(join(sdk, "build-tools", version, "apksigner")),
  );
  if (!versions.length)
    throw new Error("Android SDK has no complete build-tools installation");
  for (const old of readdirSync(join(overlay, "build-tools"), {
    withFileTypes: true,
  }).filter((entry) => !versions.includes(entry.name)))
    rmSync(join(overlay, "build-tools", old.name), {
      recursive: true,
      force: true,
    });
  for (const version of versions) {
    const tools = join(overlay, "build-tools", version);
    mkdirSync(tools, { recursive: true });
    for (const name of readdirSync(join(sdk, "build-tools", version)))
      link(
        name === "apksigner"
          ? join(bin, "apksigner")
          : join(sdk, "build-tools", version, name),
        join(tools, name),
      );
  }
  return {
    ...env,
    ANDROID_HOME: overlay,
    ANDROID_SDK_ROOT: overlay,
    NSH_REAL_ANDROID_SDK: sdk,
  };
}

export function patchIosApp(target) {
  if (config.orientation !== "landscape")
    throw new Error("Unsupported app orientation");
  const plist = join(target, "Info.plist");
  const orientations = [
    "UIInterfaceOrientationLandscapeLeft",
    "UIInterfaceOrientationLandscapeRight",
  ];
  for (const key of [
    "UISupportedInterfaceOrientations",
    "UISupportedInterfaceOrientations~ipad",
  ])
    run("plutil", [
      "-replace", key, "-json", JSON.stringify(orientations), plist,
    ]);
  run("plutil", ["-replace", "UIRequiresFullScreen", "-bool", "YES", plist]);
}

export function signIos(args) {
  const target = args.at(-1);
  if (target?.endsWith(".app") && existsSync(join(target, "Info.plist")))
    patchIosApp(target);
  const result = spawnSync("/usr/bin/codesign", args, { stdio: "inherit" });
  process.exitCode = result.status ?? 1;
}

export function signAndroid(args) {
  const sdk = process.env.NSH_REAL_ANDROID_SDK;
  if (!sdk) throw new Error("Native plugin requires the original Android SDK");
  const version = readdirSync(join(sdk, "build-tools"))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .at(-1);
  const tools = join(sdk, "build-tools", version),
    target = args.at(-1);
  if (args[0] === "sign" && target?.endsWith(".apk") && existsSync(target))
    applyAndroidPlugin(resolve(target), sdk, tools);
  const result = spawnSync(join(tools, "apksigner"), args, {
    stdio: "inherit",
  });
  process.exitCode = result.status ?? 1;
}

function applyAndroidPlugin(apk, sdk, tools) {
  const work = mkdtempSync(join(dirname(apk), "looi-plugin-"));
  try {
    const jar = join(sdk, "platforms/android-35/android.jar");
    const source = join(
      app,
      "native/android/com/superlooi/nsh/SuperLooiApplication.java",
    );
    const badging = run(join(tools, "aapt2"), ["dump", "badging", apk]);
    const field = (pattern) => {
      const value = badging.match(pattern)?.[1];
      if (!value) throw new Error("Unsupported Android package metadata");
      return value;
    };
    const packageId = field(/^package: name='([^']+)'/m);
    if (!["com.superlooi.app", "com.longbridge.nsh.host"].includes(packageId))
      throw new Error("Native plugin received an unrelated app");
    const min = field(/^(?:minSdkVersion|sdkVersion):'([^']+)'/m);
    const classes = join(work, "classes"),
      dex = join(work, "dex");
    mkdirSync(classes);
    mkdirSync(dex);
    run("javac", [
      "-source",
      "8",
      "-target",
      "8",
      "-classpath",
      jar,
      "-d",
      classes,
      source,
      join(app, "native/android/com/superlooi/nsh/MiotLoginDialog.java"),
      join(app, "native/android/com/superlooi/nsh/LooiBleBridge.java"),
    ]);
    run(join(tools, "d8"), [
      "--lib",
      jar,
      "--min-api",
      min,
      "--output",
      dex,
      ...readdirSync(join(classes, "com/superlooi/nsh"))
        .filter((name) => name.endsWith(".class"))
        .map((name) => join(classes, "com/superlooi/nsh", name)),
    ]);
    const merged = join(work, "merged.apk");
    // Stream large native debug libraries; never hold an APK in JS memory.
    run("python3", [
      "-B",
      join(app, "native/android/merge_apk.py"),
      apk,
      join(dex, "classes.dex"),
      merged,
      config.android.application,
      String(config.android.allowBackup),
      config.orientation,
      ...(config.android.permissions ?? []),
    ]);
    run(join(tools, "zipalign"), ["-P", "16", "-f", "4", merged, apk]);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
