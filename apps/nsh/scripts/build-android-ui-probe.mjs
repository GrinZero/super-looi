import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { loadBuildVariables } from "./build-env.mjs";

const env = { ...process.env, ...loadBuildVariables() };
if (env.JAVA_HOME) env.PATH = join(env.JAVA_HOME, "bin") + ":" + env.PATH;
const app = resolve(import.meta.dirname, ".."),
  sdk =
    env.NSH_REAL_ANDROID_SDK ??
    env.ANDROID_HOME ??
    env.ANDROID_SDK_ROOT ??
    join(homedir(), "Library/Android/sdk");
const version = readdirSync(join(sdk, "build-tools"))
  .filter((value) => existsSync(join(sdk, "build-tools", value, "apksigner")))
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  .at(-1);
if (!version) throw new Error("Android build-tools are missing");
const tools = join(sdk, "build-tools", version),
  jar = join(sdk, "platforms/android-35/android.jar"),
  work = join(app, ".nsh/android-ui-probe");
function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", env });
  if (result.status !== 0)
    throw new Error(
      `${command}: ${result.stderr ?? result.error ?? result.status}`,
    );
}
mkdirSync(join(work, "classes"), { recursive: true });
mkdirSync(join(work, "dex"), { recursive: true });
run("javac", [
  "-source",
  "8",
  "-target",
  "8",
  "-classpath",
  jar,
  "-d",
  join(work, "classes"),
  join(app, "native/android-test/com/superlooi/nsh/test/UiProbe.java"),
]);
run(join(tools, "d8"), [
  "--lib",
  jar,
  "--min-api",
  "28",
  "--output",
  join(work, "dex"),
  join(work, "classes/com/superlooi/nsh/test/UiProbe.class"),
]);
const manifest = join(work, "AndroidManifest.xml");
writeFileSync(
  manifest,
  `<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.superlooi.nsh.uitest"><application android:label="Super LOOI UI verification" android:debuggable="true"/><instrumentation android:name="com.superlooi.nsh.test.UiProbe" android:targetPackage="com.superlooi.nsh.uitest"/></manifest>`,
);
const apk = join(work, "probe.apk");
run(join(tools, "aapt2"), [
  "link",
  "-o",
  apk,
  "-I",
  jar,
  "--manifest",
  manifest,
  "--min-sdk-version",
  "28",
  "--target-sdk-version",
  "35",
]);
run("python3", [
  "-c",
  "import zipfile,sys\nwith zipfile.ZipFile(sys.argv[1],'a') as z:z.write(sys.argv[2],'classes.dex',compress_type=zipfile.ZIP_DEFLATED)",
  apk,
  join(work, "dex/classes.dex"),
]);
const aligned = join(work, "probe-aligned.apk");
run(join(tools, "zipalign"), ["-f", "4", apk, aligned]);
run(join(tools, "apksigner"), [
  "sign",
  "--ks",
  join(homedir(), ".android/debug.keystore"),
  "--ks-key-alias",
  "androiddebugkey",
  "--ks-pass",
  "pass:android",
  "--key-pass",
  "pass:android",
  aligned,
]);
console.log(aligned);
