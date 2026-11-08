/** quickjs-jit-stdlib 0.14.1's native any() captures a signal in an opaque
 * Rust callback. A JS callback keeps every edge visible to QuickJS's GC. */
export function installAbortSignalAny() {
  if (
    typeof AbortController === "undefined" ||
    typeof AbortSignal === "undefined"
  )
    return;
  Object.defineProperty(AbortSignal, "any", {
    configurable: true,
    writable: true,
    value(signals: Iterable<AbortSignal>): AbortSignal {
      const inputs = [...signals];
      for (const signal of inputs)
        if (!(signal instanceof AbortSignal))
          throw new TypeError("Expected AbortSignal");
      const controller = new AbortController();
      const aborted = inputs.find((signal) => signal.aborted);
      if (aborted) {
        controller.abort(aborted.reason);
        return controller.signal;
      }
      const listeners: Array<[AbortSignal, () => void]> = [];
      const cleanup = () => {
        for (const [signal, listener] of listeners)
          signal.removeEventListener("abort", listener);
        listeners.length = 0;
      };
      for (const signal of new Set(inputs)) {
        const listener = () => {
          cleanup();
          controller.abort(signal.reason);
        };
        listeners.push([signal, listener]);
        signal.addEventListener("abort", listener, { once: true });
      }
      return controller.signal;
    },
  });
}
