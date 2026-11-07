import { NshSegmenter } from "./segmenter.js";
import { installAbortSignalAny } from "./abort.js";
import { Utf8Encoder, Utf8Decoder } from "./encoding.js";
import * as cryptoShim from "./shims/crypto.js";
import process from "./shims/process.js";
import { unsupported } from "./bridge.js";
/** Data clone used by Pi transcripts. Preserve cycles, binary, maps and dates;
 * reject functions/transfer rather than silently corrupting them via JSON. */
export function cloneValue<T>(value: T, seen = new Map<object, unknown>()): T {
  if (typeof value === "function" || typeof value === "symbol")
    return unsupported("structuredClone non-data value");
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return seen.get(value) as T;
  let copy: any;
  if (value instanceof Date) copy = new Date(value);
  else if (value instanceof RegExp)
    copy = new RegExp(value.source, value.flags);
  else if (value instanceof ArrayBuffer) copy = value.slice(0);
  else if (ArrayBuffer.isView(value)) {
    const buffer = cloneValue(value.buffer, seen);
    copy =
      value instanceof DataView
        ? new DataView(buffer, value.byteOffset, value.byteLength)
        : new (value.constructor as any)(
            buffer,
            value.byteOffset,
            (value as any).length,
          );
  } else if (value instanceof Map) {
    copy = new Map();
    seen.set(value, copy);
    for (const [k, v] of value)
      copy.set(cloneValue(k, seen), cloneValue(v, seen));
  } else if (value instanceof Set) {
    copy = new Set();
    seen.set(value, copy);
    for (const v of value) copy.add(cloneValue(v, seen));
  } else {
    if (
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    )
      return unsupported("structuredClone custom class");
    copy = Array.isArray(value) ? [] : {};
    seen.set(value, copy);
    for (const [k, v] of Object.entries(value))
      Object.defineProperty(copy, k, {
        value: cloneValue(v, seen),
        enumerable: true,
        writable: true,
        configurable: true,
      });
  }
  seen.set(value, copy);
  return copy;
}
export function installNodeCompatGlobals() {
  installAbortSignalAny();
  const g = globalThis as any;
  g.global ??= g;
  g.Intl ??= {};
  g.Intl.Segmenter ??= NshSegmenter;
  g.TextEncoder ??= Utf8Encoder;
  g.TextDecoder ??= Utf8Decoder;
  g.process = process;
  g.console ??= Object.fromEntries(
    ["log", "info", "warn", "error", "debug", "trace"].map((key) => [
      key,
      (...args: unknown[]) =>
        g.__nsh_print?.(
          args
            .map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg)))
            .join(" "),
        ),
    ]),
  );
  g.queueMicrotask ??= (fn: () => void) => {
    void Promise.resolve().then(fn);
  };
  g.structuredClone ??= (
    value: unknown,
    options?: { transfer?: unknown[] },
  ) => {
    if (options?.transfer?.length) unsupported("structuredClone transfer");
    return cloneValue(value);
  };
  g.performance ??= { now: () => Date.now() };
  g.setImmediate ??= (fn: () => void) => g.setTimeout(fn, 0);
  g.clearImmediate ??= (id: unknown) => g.clearTimeout(id);
  g.atob ??= (value: string) => Buffer.from(value, "base64").toString("binary");
  g.btoa ??= (value: string) => Buffer.from(value, "binary").toString("base64");
  if (typeof Buffer !== "undefined") {
    let supportsBase64Url = false;
    try {
      supportsBase64Url =
        Buffer.from([0xfb, 0xff]).toString("base64url") === "-_8";
    } catch {
      supportsBase64Url = false;
    }
    if (!supportsBase64Url) {
      const origToString = Buffer.prototype.toString;
      Buffer.prototype.toString = function (...args: any[]) {
        if (args[0] === "base64url") {
          const nextArgs = ["base64", ...args.slice(1)];
          return origToString
            .apply(this, nextArgs as any)
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
            .replace(/=+$/, "");
        }
        return origToString.apply(this, args as any);
      };
    }
  }
  g.crypto ??= {};
  g.crypto.randomUUID ??= () => (cryptoShim as any).randomUUID();
  g.crypto.getRandomValues ??= <T extends ArrayBufferView>(array: T): T => {
    const view = new Uint8Array(
      array.buffer,
      array.byteOffset,
      array.byteLength,
    );
    view.set((cryptoShim as any).randomBytes(view.byteLength));
    return array;
  };
  g.crypto.subtle ??= {};
  g.crypto.subtle.digest ??= async (
    algorithm: string | { name: string },
    data: BufferSource,
  ): Promise<ArrayBuffer> => {
    const rawName =
      typeof algorithm === "string" ? algorithm : algorithm?.name ?? "";
    const alg = rawName.toLowerCase().replace("-", "");
    const bytes =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const digest = (cryptoShim as any).createHash(alg).update(bytes).digest();
    return digest.buffer.slice(
      digest.byteOffset,
      digest.byteOffset + digest.byteLength,
    );
  };
}
