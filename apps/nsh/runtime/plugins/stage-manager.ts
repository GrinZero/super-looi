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
  presentation: PluginStagePresentation;
}

/**
 * Arbitrates which active plugin currently owns the Morphable First-Screen Stage.
 * Bound to EffectScope so closing a game phase or disabling a plugin atomically restores `{ kind: "full" }`.
 */
export class PluginStageManager {
  private readonly stack: StageStackEntry[] = [];

  constructor(
    private readonly onChanged?: (
      pluginId: string | null,
      presentation: PluginStagePresentation | null,
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

  activePresentation(): { pluginId: string; presentation: PluginStagePresentation } | null {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      if (this.stack[i].presentation.active) {
        return {
          pluginId: this.stack[i].pluginId,
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
    if (changed) this.emitChange();
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
    };
  }

  private emitChange(): void {
    const current = this.activePresentation();
    this.onChanged?.(current?.pluginId ?? null, current?.presentation ?? null);
  }
}
