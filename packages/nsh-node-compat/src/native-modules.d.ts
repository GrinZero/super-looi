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
declare module "pi-codemode-native/prelude" {
  export const PRELUDE_SOURCE: string;
}
declare module "__nsh_native/url" {
  export * from "node:url";
}
declare module "__nsh_native/crypto" {
  export * from "node:crypto";
}
declare module "__nsh_native/buffer" {
  export * from "node:buffer";
}
