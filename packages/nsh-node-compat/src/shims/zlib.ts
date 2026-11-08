import * as native from "__nsh_native/zlib";
import { call } from "../bridge.js";
// Use the VM's native compression and fill its missing Node crc32 export.
export const deflateRawSync: typeof import("node:zlib").deflateRawSync =
  native.deflateRawSync;
export const inflateRawSync: typeof import("node:zlib").inflateRawSync =
  native.inflateRawSync;
export const gzipSync: typeof import("node:zlib").gzipSync = native.gzipSync;
export const gunzipSync: typeof import("node:zlib").gunzipSync =
  native.gunzipSync;
export const deflateSync: typeof import("node:zlib").deflateSync =
  native.deflateSync;
export const inflateSync: typeof import("node:zlib").inflateSync =
  native.inflateSync;
export const brotliCompressSync: typeof import("node:zlib").brotliCompressSync =
  native.brotliCompressSync;
export const brotliDecompressSync: typeof import("node:zlib").brotliDecompressSync =
  native.brotliDecompressSync;
export function crc32(data: string | Uint8Array, value = 0) {
  return call<number>("crc32", {
    data: Array.from(typeof data === "string" ? Buffer.from(data) : data),
    seed: value,
  });
}
