import type {
  Dispose,
  EffectScope,
  PluginManifest,
  PluginStageCapability,
  PluginStagePresentation,
} from "./contracts.js";
import { PluginKernelError } from "./errors.js";

interface StageStackEntry {
  readonly pluginId: string;
  readonly revision: number;
  presentation: PluginStagePresentation;
}

/**
 * Arbitrates which active plugin currently owns the Morphable First-Screen Stage.
 * Bound to EffectScope so closing a game phase or disabling a plugin atomically restores `{ kind: "full" }`.
 */
export class PluginStageManager {
  private readonly stack: StageStackEntry[] = [];
  private readonly hostExitListeners = new Map<string, Set<() => void>>();
  private nextRevision = 1;

  constructor(
    private readonly onChanged?: (
      pluginId: string | null,
      presentation: PluginStagePresentation | null,
      revision?: number,
    ) => void,
  ) {}

  activePluginId(): string | null {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      if (this.stack[i].presentation.active) {
        return this.stack[i].pluginId;
      }
    }
    return null;
  }

  activePresentation(): {
    pluginId: string;
    revision: number;
    presentation: PluginStagePresentation;
  } | null {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      if (this.stack[i].presentation.active) {
        return {
          pluginId: this.stack[i].pluginId,
          revision: this.stack[i].revision,
          presentation: structuredClone(this.stack[i].presentation),
        };
      }
    }
    return null;
  }

  presentationForPlugin(pluginId: string): PluginStagePresentation | undefined {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      if (this.stack[i].pluginId === pluginId) {
        return structuredClone(this.stack[i].presentation);
      }
    }
    return undefined;
  }

  exitPluginStage(pluginId: string): void {
    let changed = false;
    for (let i = this.stack.length - 1; i >= 0; i--) {
      if (this.stack[i].pluginId === pluginId) {
        this.stack.splice(i, 1);
        changed = true;
      }
    }
    if (changed) {
      this.emitChange();
    }
    const listeners = this.hostExitListeners.get(pluginId);
    if (listeners && listeners.size > 0) {
      for (const listener of [...listeners]) {
        try {
          listener();
        } catch {
          // Isolate plugin listener errors so host stage exit always completes.
        }
      }
    }
  }

  createScopedCapability(manifest: PluginManifest, defaultScope: EffectScope): PluginStageCapability | undefined {
    if (!manifest.permissions.includes("stage.ui")) return undefined;

    return {
      usePresentation: (presentation: PluginStagePresentation, scope: EffectScope = defaultScope): Dispose => {
        if (!scope.active) {
          throw new PluginKernelError({
            stage: "plugin.stage.usePresentation",
            code: "ERR_PLUGIN_SCOPE_DISPOSED",
            pluginId: manifest.id,
            reason: `Cannot mount stage presentation on disposed scope for "${manifest.id}"`,
          });
        }
        const entry: StageStackEntry = {
          pluginId: manifest.id,
          revision: this.nextRevision++,
          presentation: structuredClone(presentation),
        };
        this.stack.push(entry);
        this.emitChange();

        let removed = false;
        const remove = () => {
          if (removed) return;
          removed = true;
          const idx = this.stack.lastIndexOf(entry);
          if (idx >= 0) {
            this.stack.splice(idx, 1);
            this.emitChange();
          }
        };
        const detach = scope.onDispose(remove);
        return () => {
          detach();
          remove();
        };
      },
      currentPresentation: () => this.presentationForPlugin(manifest.id) ?? null,
      onHostExit: (listener: () => void, scope: EffectScope = defaultScope): Dispose => {
        if (!scope.active) {
          throw new PluginKernelError({
            stage: "plugin.stage.onHostExit",
            code: "ERR_PLUGIN_SCOPE_DISPOSED",
            pluginId: manifest.id,
            reason: `Cannot register stage onHostExit listener on disposed scope for "${manifest.id}"`,
          });
        }
        let bucket = this.hostExitListeners.get(manifest.id);
        if (!bucket) {
          bucket = new Set();
          this.hostExitListeners.set(manifest.id, bucket);
        }
        bucket.add(listener);
        let removed = false;
        const remove = () => {
          if (removed) return;
          removed = true;
          const current = this.hostExitListeners.get(manifest.id);
          if (current) {
            current.delete(listener);
            if (current.size === 0) {
              this.hostExitListeners.delete(manifest.id);
            }
          }
        };
        const detach = scope.onDispose(remove);
        return () => {
          detach();
          remove();
        };
      },
    };
  }

  private emitChange(): void {
    const current = this.activePresentation();
    this.onChanged?.(
      current?.pluginId ?? null,
      current?.presentation ?? null,
      current?.revision,
    );
  }
}
