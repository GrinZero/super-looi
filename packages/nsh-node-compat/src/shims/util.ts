import { unsupported } from "../bridge.js";
const custom = Symbol.for("nodejs.util.promisify.custom");
export const promisify = Object.assign(
  (fn: (...args: any[]) => void) => {
    const supplied = (fn as any)[custom];
    if (supplied) return supplied;
    return function (this: unknown, ...args: any[]) {
      return new Promise((resolve, reject) =>
        fn.call(this, ...args, (error: unknown, ...values: any[]) =>
          error ? reject(error) : resolve(values[0]),
        ),
      );
    };
  },
  { custom },
);
export function callbackify(fn: (...args: any[]) => Promise<unknown>) {
  return function (this: unknown, ...args: any[]) {
    const callback = args.pop();
    void Promise.resolve()
      .then(() => fn.apply(this, args))
      .then(
        (value) => callback(null, value),
        (error) => callback(error),
      );
  };
}
export function inherits(child: any, parent: any) {
  child.super_ = parent;
  Object.setPrototypeOf(child.prototype, parent.prototype);
}
export function deprecate<T extends (...args: any[]) => any>(
  fn: T,
  message: string,
): T {
  let warned = false;
  return function (this: unknown, ...args: any[]) {
    if (!warned) {
      warned = true;
      console.warn(message);
    }
    return fn.apply(this, args);
  } as T;
}
export function inspect(value: unknown, _options?: unknown) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
export function format(...args: unknown[]) {
  return args.map((v) => inspect(v)).join(" ");
}
export const debuglog = (_name: string) =>
  Object.assign((..._args: unknown[]) => {}, { enabled: false });
export const types = {
  isUint8Array: (value: unknown) => value instanceof Uint8Array,
  isArrayBuffer: (value: unknown) => value instanceof ArrayBuffer,
  isArrayBufferView: ArrayBuffer.isView,
  isTypedArray: (value: unknown) =>
    ArrayBuffer.isView(value) && !(value instanceof DataView),
  isNativeError: (value: unknown) => value instanceof Error,
};
export const TextEncoder = globalThis.TextEncoder,
  TextDecoder = globalThis.TextDecoder;
export const parseArgs = () =>
  unsupported("util.parseArgs; use the programmatic SDK");
export default {
  promisify,
  callbackify,
  inherits,
  deprecate,
  inspect,
  format,
  debuglog,
  types,
  TextEncoder,
  TextDecoder,
  parseArgs,
};
