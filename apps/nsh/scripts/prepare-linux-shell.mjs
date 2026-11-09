import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const app = resolve(import.meta.dirname, "..");
export const linuxLock = JSON.parse(readFileSync(join(app, "native/linux/sources.lock.json"), "utf8"));
export const linuxCache = join(homedir(), "Library/Caches/super-looi-linux");
const upstream = join(linuxCache, "openminis");
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.status !== 0) throw new Error(`Linux Shell preparation failed: ${command}`);
}
async function download(url, path, sha) {
  if (!existsSync(path)) run("curl", ["-fLsS", url, "-o", path]);
  if (createHash("sha256").update(readFileSync(path)).digest("hex") !== sha)
    throw new Error(`Linux Shell source digest mismatch: ${path}`);
}
export function checkElfAlignment(path) {
  const bytes = readFileSync(path);
  const offset = Number(bytes.readBigUInt64LE(32));
  const size = bytes.readUInt16LE(54), count = bytes.readUInt16LE(56);
  for (let i = 0; i < count; i++) {
    const p = offset + i * size;
    if (bytes.readUInt32LE(p) === 1 && Number(bytes.readBigUInt64LE(p + 48)) < 16384)
      throw new Error(`Android ELF PT_LOAD requires 16 KB alignment: ${path}`);
  }
}
export async function prepareLinuxShell(target, buildEnvironment = process.env) {
  mkdirSync(linuxCache, { recursive: true });
  const ios = target === "ios" || target === "all";
  const android = target === "android" || target === "all";
  for (const tool of ["git", "make", ...(ios ? ["meson", "ninja", "ld.lld"] : [])]) {
    const result = spawnSync("which", [tool], { encoding: "utf8", env: { ...process.env, PATH: `/opt/homebrew/opt/lld/bin:${process.env.PATH}` } });
    if (result.status !== 0) throw new Error(`Missing Linux Shell build prerequisite: ${tool}`);
  }
  const llvm = "/opt/homebrew/opt/llvm/bin";
  const archive = "/opt/homebrew/opt/libarchive";
  if (ios && (!existsSync(join(llvm, "clang")) || !existsSync(join(archive, "lib/libarchive.dylib"))))
    throw new Error("iSH requires Homebrew llvm and libarchive");
  const ndk = buildEnvironment.ANDROID_NDK_HOME ?? join(homedir(), "Library/Android/sdk/ndk/28.2.13676358");
  if (android && !existsSync(join(ndk, "toolchains/llvm"))) throw new Error(`Missing Android NDK: ${ndk}`);
  if (!existsSync(join(upstream, ".git"))) {
    run("git", ["clone", "--no-checkout", "https://github.com/OpenMinis/OpenMinis.git", upstream]);
    run("git", ["checkout", "--detach", linuxLock.openminis], { cwd: upstream });
  }
  const rev = path => spawnSync("git", ["rev-parse", "HEAD"], { cwd: path, encoding: "utf8" }).stdout.trim();
  if (rev(upstream) !== linuxLock.openminis) throw new Error("OpenMinis cache revision mismatch");
  for (const name of [...(ios ? ["ish"] : []), ...(android ? ["proot"] : [])]) {
    run("git", ["submodule", "update", "--init", `deps/${name}`], { cwd: upstream });
    if (rev(join(upstream, "deps", name)) !== linuxLock[name]) throw new Error(`${name} revision mismatch`);
  }
  await download(linuxLock.alpine.url, join(linuxCache, "alpine-minirootfs.tar.gz"), linuxLock.alpine.sha256);
  if (android) {
    const destination = join(linuxCache, "android/jniLibs/arm64-v8a");
    mkdirSync(destination, { recursive: true });
    const proot = join(destination, "libproot.so");
    if (!existsSync(proot)) {
      await download(linuxLock.talloc.url, join(linuxCache, "talloc-2.4.2.tar.gz"), linuxLock.talloc.sha256);
      const build = join(upstream, "deps/build/proot-android");
      mkdirSync(build, { recursive: true });
      copyFileSync(join(linuxCache, "talloc-2.4.2.tar.gz"), join(build, "talloc-2.4.2.tar.gz"));
      // Keep the fixed upstream's standalone talloc build and loader pairing.
      const script = readFileSync(join(upstream, "deps/build_proot.sh"), "utf8")
        .replace("-Wl,-z,noexecstack -pie", "-Wl,-z,noexecstack -Wl,-z,max-page-size=16384 -pie");
      const patched = join(upstream, "deps/build_proot-looi.sh");
      writeFileSync(patched, script);
      run("bash", [patched], { env: { ...buildEnvironment, ANDROID_NDK_HOME: ndk } });
      copyFileSync(join(upstream, "src/android/app/src/main/jniLibs/arm64-v8a/libproot.so"), proot);
    }
    const loader = join(destination, "libproot-loader.so");
    await download(`https://raw.githubusercontent.com/OpenMinis/OpenMinis/${linuxLock.openminis}/${linuxLock.loader.path}`, loader, linuxLock.loader.sha256);
    checkElfAlignment(proot);
    checkElfAlignment(loader);
  }
  if (ios) {
    const ish = join(upstream, "deps/ish");
    const env = { ...process.env, PATH: `${llvm}:/opt/homebrew/opt/lld/bin:${process.env.PATH}`, PKG_CONFIG_PATH: `${archive}/lib/pkgconfig` };
    run("git", ["submodule", "update", "--init", "deps/libapps"], { cwd: ish });
    if (!existsSync(join(ish, "build-ios/libish.a")) || !existsSync(join(ish, "build-ios-sim/libish.a")))
      run("bash", [join(upstream, "deps/build_ish.sh"), "release", "--all"], { env });
    if (!existsSync(join(ish, "build-native/build.ninja")))
      run("meson", ["setup", "build-native", "--buildtype=release", "-Dlog=", "-Dkernel=ish", "-Dengine=asbestos", "-Dguest_arch=arm64"], { cwd: ish, env });
    run("ninja", ["-C", "build-native", "tools/fakefsify"], { cwd: ish, env });
    const root = join(linuxCache, "ios/rootfs");
    mkdirSync(join(linuxCache, "ios"), { recursive: true });
    if (!existsSync(join(linuxCache, "ios/rootfs.tar.gz"))) {
      run(join(ish, "build-native/tools/fakefsify"), [join(linuxCache, "alpine-minirootfs.tar.gz"), root]);
      run("tar", ["-czf", join(linuxCache, "ios/rootfs.tar.gz"), "-C", root, "."]);
    }
  }
  return linuxCache;
}
if (process.argv[1] === import.meta.filename) await prepareLinuxShell(process.argv[2] ?? "all");
