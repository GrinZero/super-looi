import type { Dispose, EffectScope } from "./contracts.js";
import { PluginKernelError } from "./errors.js";

let nextScopeSeq = 0;

/**
 * Creates a reversible LIFO EffectScope.
 * Child scopes forked from this scope unwind before own cleanups, in reverse registration order.
 */
export function createEffectScope(label = "root", pluginId?: string, onDetachedFromParent?: () => void): EffectScope {
  const id = `${label}#${++nextScopeSeq}`;
  const cleanups: Dispose[] = [];
  const children: EffectScope[] = [];
  let disposed = false;
  let disposingPromise: Promise<void> | undefined;

  const removeCleanup = (fn: Dispose) => {
    const idx = cleanups.lastIndexOf(fn);
    if (idx >= 0) cleanups.splice(idx, 1);
  };

  const removeChild = (child: EffectScope) => {
    const idx = children.indexOf(child);
    if (idx >= 0) children.splice(idx, 1);
  };

  const scope: EffectScope = {
    id,
    get active() {
      return !disposed;
    },
    onDispose(cleanup: Dispose): Dispose {
      if (disposed) {
        try {
          void cleanup();
        } catch {
          // Best-effort immediate rollback before surfacing lifecycle violation.
        }
        throw new PluginKernelError({
          stage: "plugin.scope.register",
          code: "ERR_PLUGIN_SCOPE_DISPOSED",
          pluginId,
          reason: `Cannot register effect on already disposed scope "${id}"`,
        });
      }
      cleanups.push(cleanup);
      let cancelled = false;
      return () => {
        if (cancelled) return;
        cancelled = true;
        removeCleanup(cleanup);
      };
    },
    fork(childLabel = "child"): EffectScope {
      if (disposed) {
        throw new PluginKernelError({
          stage: "plugin.scope.fork",
          code: "ERR_PLUGIN_SCOPE_DISPOSED",
          pluginId,
          reason: `Cannot fork child "${childLabel}" from already disposed scope "${id}"`,
        });
      }
      const child = createEffectScope(`${label}/${childLabel}`, pluginId, () => removeChild(child));
      children.push(child);
      return child;
    },
    dispose(): Promise<void> {
      if (disposingPromise) return disposingPromise;
      disposed = true;
      onDetachedFromParent?.();

      disposingPromise = (async () => {
        const errors: unknown[] = [];

        // 1. Unwind active child scopes in LIFO order.
        const snapshotChildren = [...children].reverse();
        children.length = 0;
        for (const child of snapshotChildren) {
          try {
            await child.dispose();
          } catch (error) {
            errors.push(error);
          }
        }

        // 2. Unwind own registered effects in LIFO order.
        const snapshotCleanups = [...cleanups].reverse();
        cleanups.length = 0;
        for (const fn of snapshotCleanups) {
          try {
            await fn();
          } catch (error) {
            errors.push(error);
          }
        }

        if (errors.length === 1) {
          const single = errors[0];
          if (single instanceof PluginKernelError) throw single;
          throw new PluginKernelError({
            stage: "plugin.scope.dispose",
            code: "ERR_PLUGIN_SCOPE_TEARDOWN_FAILED",
            pluginId,
            reason: single instanceof Error ? single.message : String(single),
            cause: single,
          });
        }
        if (errors.length > 1) {
          throw new PluginKernelError({
            stage: "plugin.scope.dispose",
            code: "ERR_PLUGIN_SCOPE_TEARDOWN_FAILED",
            pluginId,
            reason: `${errors.length} teardown errors in scope "${id}": ${errors.map((e) => (e instanceof Error ? e.message : String(e))).join("; ")}`,
            cause: new AggregateError(errors, `Multiple teardown errors in scope "${id}"`),
          });
        }
      })();

      return disposingPromise;
    },
  };

  return scope;
}
