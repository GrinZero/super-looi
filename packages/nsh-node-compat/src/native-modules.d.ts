declare module "__nsh_native/zlib" {
  export {
    deflateRawSync,
    inflateRawSync,
    gzipSync,
    gunzipSync,
    deflateSync,
    inflateSync,
    brotliCompressSync,
    brotliDecompressSync,
  } from "node:zlib";
}
