import type {
  Dispose,
  EffectScope,
  PluginManifest,
  PluginStageCapability,
  PluginStagePresentation,
  ResumableStageSessionInput,
  ResumableStageView,
} from "./contracts.js";
import { PluginKernelError } from "./errors.js";

interface StageStackEntry {
  readonly pluginId: string;
  readonly revision: number;
  presentation: PluginStagePresentation;
}

interface ResumableSessionEntry {
  readonly pluginId: string;
  readonly seq: number;
  readonly session: ResumableStageSessionInput;
}

/**
 * Arbitrates which active plugin currently owns the Morphable First-Screen Stage.
 * Bound to EffectScope so closing a game phase or disabling a plugin atomically restores `{ kind: "full" }`.
 */
export class PluginStageManager {
  private readonly stack: StageStackEntry[] = [];
  private readonly hostExitListeners = new Map<string, Set<() => void>>();
  private readonly resumableSessions = new Map<string, ResumableSessionEntry>();
  private nextRevision = 1;
  private nextResumableSeq = 1;
  private lastResumableKey = "";

  constructor(
    private readonly onChanged?: (
      pluginId: string | null,
      presentation: PluginStagePresentation | null,
      revision?: number,
    ) => void,
    private readonly onResumableChanged?: (view: ResumableStageView | null) => void,
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

  activeResumable(): ResumableStageView | null {
    if (this.activePresentation() !== null) return null;
    let latest: ResumableSessionEntry | undefined;
    for (const entry of this.resumableSessions.values()) {
      if (!latest || entry.seq > latest.seq) {
        latest = entry;
      }
    }
    if (!latest) return null;
    return {
      pluginId: latest.pluginId,
      title: latest.session.title,
      ...(latest.session.subtitle !== undefined ? { subtitle: latest.session.subtitle } : {}),
      ...(latest.session.badgeText !== undefined ? { badgeText: latest.session.badgeText } : {}),
    };
  }

  setResumableSession(pluginId: string, session: ResumableStageSessionInput | null): void {
    if (session === null) {
      if (this.resumableSessions.delete(pluginId)) {
        this.emitResumableIfChanged();
      }
      return;
    }
    this.resumableSessions.set(pluginId, {
      pluginId,
      seq: this.nextResumableSeq++,
      session: {
        title: session.title,
        subtitle: session.subtitle,
        badgeText: session.badgeText,
        onResume: session.onResume,
      },
    });
    this.emitResumableIfChanged();
  }

  clearPluginResumable(pluginId: string): void {
    if (this.resumableSessions.delete(pluginId)) {
      this.emitResumableIfChanged();
    }
  }

  async resumeSession(pluginId?: string): Promise<void> {
    let target: ResumableSessionEntry | undefined;
    if (pluginId) {
      target = this.resumableSessions.get(pluginId);
    } else {
      for (const entry of this.resumableSessions.values()) {
        if (!target || entry.seq > target.seq) {
          target = entry;
        }
      }
    }
    if (!target) return;
    await target.session.onResume();
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

    defaultScope.onDispose(() => {
      this.clearPluginResumable(manifest.id);
    });

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
      setResumableSession: (session: ResumableStageSessionInput | null): void => {
        if (session !== null && !defaultScope.active) {
          throw new PluginKernelError({
            stage: "plugin.stage.setResumableSession",
            code: "ERR_PLUGIN_SCOPE_DISPOSED",
            pluginId: manifest.id,
            reason: `Cannot register resumable stage session on disposed scope for "${manifest.id}"`,
          });
        }
        this.setResumableSession(manifest.id, session);
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
    this.emitResumableIfChanged();
  }

  private emitResumableIfChanged(): void {
    const view = this.activeResumable();
    const key = view ? JSON.stringify(view) : "";
    if (key === this.lastResumableKey) return;
    this.lastResumableKey = key;
    this.onResumableChanged?.(view ? structuredClone(view) : null);
  }
}
