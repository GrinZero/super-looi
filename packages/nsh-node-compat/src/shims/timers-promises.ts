export function setTimeout<T = void>(
  delay = 1,
  value?: T,
  options?: { signal?: AbortSignal },
) {
  return new Promise<T>((resolve, reject) => {
    const signal = options?.signal;
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const abort = () => {
      globalThis.clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = globalThis.setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve(value as T);
    }, delay);
    signal?.addEventListener("abort", abort, { once: true });
  });
}
export const setImmediate = <T = void>(
  value?: T,
  options?: { signal?: AbortSignal },
) => setTimeout(0, value, options);
export default { setTimeout, setImmediate };
