import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const version = "v1.12.26";
export const cache = join(homedir(), ".cache/super-looi/sherpa-onnx", version);
const root = "https://github.com/k2-fsa/sherpa-onnx/releases/download";
const artifacts = {
  model: [`${root}/kws-models/sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20.tar.bz2`, "68447f4fbc67e70eee3a93961f36e81e98f47aef73ce7e7ca00885c6cd3616a6"],
  ios: [`${root}/${version}/sherpa-onnx-${version}-ios-no-tts.tar.bz2`, "c07c4156d1d714a98a226714016be732690bc880d519d718a237a1a8b58b4492"],
  android: [`${root}/${version}/sherpa-onnx-${version}-android.tar.bz2`, "e8d0f789f920e9ab93c1a2a49dcb3b02fd1ccaa39e78d94f9866c034bb6fcf4e"],
};
function digest(path) {
  const hash = createHash("sha256");
  return new Promise((resolve, reject) => {
    const source = createReadStream(path);
    source.on("data", (bytes) => hash.update(bytes));
    source.on("error", reject);
    source.on("end", () => resolve(hash.digest("hex")));
  });
}
function elfAligned(path) {
  const data = readFileSync(path);
  const le = data[5] === 1;
  const is64 = data[4] === 2;
  if (data.toString("ascii", 1, 4) !== "ELF" || !le) throw new Error(`Invalid ELF: ${path}`);
  const offset = is64 ? Number(data.readBigUInt64LE(32)) : data.readUInt32LE(28);
  const size = data.readUInt16LE(is64 ? 54 : 42);
  const count = data.readUInt16LE(is64 ? 56 : 44);
  for (let i = 0; i < count; i++) {
    const program = offset + i * size;
    if (data.readUInt32LE(program) !== 1) continue;
    const align = is64 ? Number(data.readBigUInt64LE(program + 48)) : data.readUInt32LE(program + 28);
    if (align < 16384) throw new Error(`Android PT_LOAD is not 16 KB aligned: ${path}`);
  }
}
export async function prepareSherpaKws(target = "all") {
  const needed = target === "all" ? ["model", "ios", "android"] : ["model", target];
  for (const kind of needed) {
    const [url, sha] = artifacts[kind];
    const archive = join(cache, "downloads", `${kind}.tar.bz2`);
    mkdirSync(join(cache, "downloads"), { recursive: true });
    if (!existsSync(archive) || await digest(archive) !== sha) {
      const response = await fetch(url);
      if (!response.ok || !response.body) throw new Error(`Cannot download sherpa-onnx ${kind}`);
      await pipeline(Readable.fromWeb(response.body), createWriteStream(archive));
    }
    if (await digest(archive) !== sha) throw new Error(`sherpa-onnx ${kind} SHA256 mismatch`);
    const destination = join(cache, kind);
    mkdirSync(destination, { recursive: true });
    const expected = kind === "model"
      ? join(destination, "sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20/tokens.txt")
      : kind === "ios"
        ? join(destination, "build-ios-no-tts/sherpa-onnx.xcframework/ios-arm64/libsherpa-onnx.a")
        : join(destination, "jniLibs/arm64-v8a/libsherpa-onnx-c-api.so");
    if (!existsSync(expected)) {
      const unpacked = spawnSync("tar", ["-xjf", archive, "-C", destination], { stdio: "inherit" });
      if (unpacked.status !== 0) throw new Error(`Cannot unpack sherpa-onnx ${kind}`);
    }
  }
  if (needed.includes("ios")) for (const arch of ["arm64", "x86_64"]) {
    const output = join(cache, "ios/derived", `${arch}-sim`);
    mkdirSync(output, { recursive: true });
    for (const [lib, source] of [
      ["libsherpa-onnx.a", join(cache, "ios/build-ios-no-tts/sherpa-onnx.xcframework/ios-arm64_x86_64-simulator/libsherpa-onnx.a")],
      ["libonnxruntime.a", join(cache, "ios/build-ios-no-tts/ios-onnxruntime/1.17.1/onnxruntime.xcframework/ios-arm64_x86_64-simulator/libonnxruntime.a")],
    ]) {
      const outputFile = join(output, lib);
      if (existsSync(outputFile)) continue;
      const thin = spawnSync("xcrun", ["lipo", "-thin", arch, source, "-output", outputFile], { stdio: "inherit" });
      if (thin.status !== 0) throw new Error(`Cannot prepare ${arch} iOS simulator archive`);
    }
  }
  if (needed.includes("android")) for (const abi of ["arm64-v8a", "armeabi-v7a", "x86_64"])
    for (const lib of ["libsherpa-onnx-c-api.so", "libonnxruntime.so"])
      elfAligned(join(cache, "android/jniLibs", abi, lib));
  return cache;
}
if (process.argv[1] === import.meta.filename)
  await prepareSherpaKws(process.argv[2] || "all");
