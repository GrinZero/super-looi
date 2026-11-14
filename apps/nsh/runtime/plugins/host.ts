import type { DatabaseSync } from "node:sqlite";
import { DualLoopAiBus, type DualLoopAiBusBridge } from "./ai-bus.js";
import type {
  CliReceipt,
  EffectScope,
  PluginAuthSnapshot,
  PluginBodyCapability,
  PluginContext,
  PluginDefinition,
  PluginEvent,
  PluginFaceCapability,
  PluginFailure,
  PluginLifecycleState,
  PluginManifest,
  PluginRuntime,
  PluginSnapshot,
  PluginStorage,
  PluginTaskContext,
  PluginVisionCapability,
} from "./contracts.js";
import { createEffectScope } from "./effect-scope.js";
import { extractPluginFailure, PluginKernelError } from "./errors.js";
import {
  PluginServiceBroker,
  validateAndSortPluginTopology,
  type ValidatedTopology,
} from "./service-registry.js";
import { PluginStageManager } from "./stage-manager.js";

export interface PluginHostHardwareDrivers {
  createFaceCapability?: (manifest: PluginManifest, scope: EffectScope) => PluginFaceCapability | undefined;
  createBodyCapability?: (manifest: PluginManifest, scope: EffectScope) => PluginBodyCapability | undefined;
  createVisionCapability?: (manifest: PluginManifest, scope: EffectScope) => PluginVisionCapability | undefined;
  aiBridge?: DualLoopAiBusBridge;
}

interface ManagedPluginEntry {
  readonly definition: PluginDefinition<any, any>;
  readonly storage: PluginStorage;
  enabled: boolean;
  installedVersion: string;
  migrated: boolean;
  lifecycle: PluginLifecycleState;
  state: Record<string, unknown>;
  auth?: PluginAuthSnapshot;
  lastExecution?: CliReceipt;
  lastError?: PluginFailure;
  scope?: EffectScope;
  runtime?: PluginRuntime<any, any>;
  mounting: boolean;
  generation: number;
  startingGeneration?: number;
  startingPromise?: Promise<void>;
  transitionQueue: Promise<void>;
}

function toStringRecord(entries: Record<string, unknown>, state: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(entries)) {
    if (typeof val === "string") out[key] = val;
    else if (typeof val === "number" || typeof val === "boolean") out[key] = String(val);
  }
  if (state && typeof state === "object") {
    for (const [key, val] of Object.entries(state as Record<string, unknown>)) {
      if (key === "cliVersion") continue;
      if (typeof val === "string") out[key] = val;
    }
  }
  return out;
}

/**
 * Plugin Microkernel Host v2:
 * Owns package catalog, SQLite installation & namespaced KV storage, SemVer migrations,
 * DAG cross-plugin service topology, EffectScope lifecycle unwinding, Stage arbitration, and Dual-Loop AI bus.
 */
export class PluginHost {
  private readonly topology: ValidatedTopology;
  private readonly entries = new Map<string, ManagedPluginEntry>();
  private readonly listeners = new Set<(event: PluginEvent) => void>();
  readonly services: PluginServiceBroker;
  readonly stage: PluginStageManager;
  readonly ai: DualLoopAiBus;
  private closing = false;

  constructor(
    private readonly database: DatabaseSync,
    definitions: readonly PluginDefinition<any, any>[],
    private readonly drivers: PluginHostHardwareDrivers = {},
  ) {
    this.topology = validateAndSortPluginTopology(definitions.map((d) => d.manifest));
    this.ensureSchemaAndMigrateLegacySettings();

    this.stage = new PluginStageManager((pluginId, presentation, revision) => {
      this.emit({
        type: "stage_changed",
        pluginId,
        ...(revision !== undefined ? { revision } : {}),
        presentation,
      });
      this.ai?.notifyStageChanged();
      for (const entry of this.entries.values()) {
        if (entry.definition.manifest.permissions.includes("stage.ui")) {
          this.publishSnapshot(entry);
        }
      }
    });

    this.ai = new DualLoopAiBus(() => this.stage.activePluginId(), drivers.aiBridge);

    this.services = new PluginServiceBroker(this.topology, async (event) => {
      if (this.closing) return;
      await this.suspendHardDependents(event.providerPluginId);
    });

    const defsById = new Map(definitions.map((d) => [d.manifest.id, d]));

    for (const pluginId of this.topology.bootOrder) {
      const definition = defsById.get(pluginId)!;
      const manifest = definition.manifest;
      const storage = this.createStorageForPlugin(manifest.id);

      const savedRow = this.database
        .prepare("SELECT enabled, installed_version FROM plugin_installations WHERE id = ?")
        .get(manifest.id) as { enabled: number; installed_version: string } | undefined;

      const enabled = savedRow ? Boolean(savedRow.enabled) : true;
      const installedVersion = savedRow ? savedRow.installed_version : manifest.version;

      if (!savedRow) {
        this.saveInstallationRow(manifest.id, enabled, installedVersion, "builtin");
      }

      const initialState = (definition.initialState(storage) ?? {}) as Record<string, unknown>;
      const hasHardDeps = (manifest.dependencies ?? []).some((d) => !d.optional);

      const entry: ManagedPluginEntry = {
        definition,
        storage,
        enabled,
        installedVersion,
        migrated: installedVersion === manifest.version || !definition.migrate,
        lifecycle: !enabled ? "stopped" : hasHardDeps ? "waiting_dependency" : "registered",
        state: structuredClone(initialState),
        mounting: false,
        generation: 0,
        transitionQueue: Promise.resolve(),
      };
      this.entries.set(manifest.id, entry);

      // Mount synchronous runtime shell when enabled, migrated, and free of unsatisfied hard dependencies.
      if (enabled && entry.migrated && this.services.areHardDependenciesSatisfied(manifest)) {
        try {
          this.mountEntrySync(entry);
        } catch {
          // Recorded on entry.lastError & entry.lifecycle = "failed".
        }
      } else if (enabled && !entry.migrated) {
        void this.enqueue(entry, () => this.migrateAndMountIfReady(entry)).catch(() => {});
      }
    }
  }

  private ensureSchemaAndMigrateLegacySettings(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS plugin_installations (
        id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL,
        installed_version TEXT NOT NULL,
        source TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS plugin_kv_storage (
        plugin_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (plugin_id, key)
      );
    `);

    const hasLegacy = this.database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'plugin_settings'")
      .get() as { name: string } | undefined;

    if (!hasLegacy) return;

    const legacyRows = this.database
      .prepare("SELECT id, enabled, configuration FROM plugin_settings")
      .all() as Array<{ id: string; enabled: number; configuration: string }>;

    for (const row of legacyRows) {
      const existing = this.database
        .prepare("SELECT id FROM plugin_installations WHERE id = ?")
        .get(row.id);
      if (existing) continue;

      const manifest = this.topology.manifestsById.get(row.id);
      const version = manifest?.version ?? "1.0.0";
      this.saveInstallationRow(row.id, Boolean(row.enabled), version, "builtin");

      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(row.configuration) as Record<string, unknown>;
      } catch {
        parsed = {};
      }
      const upsertKv = this.database.prepare(
        "INSERT INTO plugin_kv_storage (plugin_id, key, value) VALUES (?, ?, ?) ON CONFLICT(plugin_id, key) DO UPDATE SET value = excluded.value",
      );
      for (const [k, v] of Object.entries(parsed)) {
        upsertKv.run(row.id, k, JSON.stringify(v));
      }
    }
  }

  private saveInstallationRow(
    id: string,
    enabled: boolean,
    installedVersion: string,
    source: "builtin" | "marketplace" = "builtin",
  ): void {
    this.database
      .prepare(
        `INSERT INTO plugin_installations (id, enabled, installed_version, source, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           enabled = excluded.enabled,
           installed_version = excluded.installed_version,
           updated_at = excluded.updated_at`,
      )
      .run(id, Number(enabled), installedVersion, source, new Date().toISOString());
  }

  private createStorageForPlugin(pluginId: string): PluginStorage {
    const getStmt = this.database.prepare(
      "SELECT value FROM plugin_kv_storage WHERE plugin_id = ? AND key = ?",
    );
    const setStmt = this.database.prepare(
      "INSERT INTO plugin_kv_storage (plugin_id, key, value) VALUES (?, ?, ?) ON CONFLICT(plugin_id, key) DO UPDATE SET value = excluded.value",
    );
    const delStmt = this.database.prepare(
      "DELETE FROM plugin_kv_storage WHERE plugin_id = ? AND key = ?",
    );
    const allStmt = this.database.prepare(
      "SELECT key, value FROM plugin_kv_storage WHERE plugin_id = ?",
    );

    return {
      get: <T = unknown>(key: string): T | undefined => {
        const row = getStmt.get(pluginId, key) as { value: string } | undefined;
        if (!row) return undefined;
        return JSON.parse(row.value) as T;
      },
      set: <T = unknown>(key: string, value: T): void => {
        setStmt.run(pluginId, key, JSON.stringify(value));
      },
      delete: (key: string): void => {
        delStmt.run(pluginId, key);
      },
      entries: (): Record<string, unknown> => {
        const rows = allStmt.all(pluginId) as Array<{ key: string; value: string }>;
        const out: Record<string, unknown> = {};
        for (const row of rows) {
          out[row.key] = JSON.parse(row.value);
        }
        return out;
      },
    };
  }

  private mountEntrySync(entry: ManagedPluginEntry): void {
    if ((entry.runtime && entry.scope?.active) || entry.mounting) return;
    const manifest = entry.definition.manifest;
    const scope = createEffectScope(`plugin:${manifest.id}`, manifest.id);
    entry.scope = scope;
    entry.mounting = true;

    const context: PluginContext<any> = {
      manifest,
      scope,
      forkScope: (label) => scope.fork(label),
      services: this.services.createScopedRegistry(manifest, scope),
      storage: entry.storage,
      enabled: () => entry.enabled && !this.closing,
      lifecycle: () => entry.lifecycle,
      ensureStarted: async () => {
        if (entry.lifecycle === "active" && entry.runtime && entry.scope?.active) {
          return;
        }
        if (entry.startingPromise && entry.startingGeneration === entry.generation) {
          await entry.startingPromise;
          return;
        }
        await this.enqueue(entry, () => this.activateInternal(entry));
        if ((entry.lifecycle as PluginLifecycleState) === "active") {
          await this.reconcileWaitingPlugins();
        }
      },
      getState: () => structuredClone(entry.state),
      setState: (updater) => {
        const next =
          typeof updater === "function"
            ? (updater as (prev: Record<string, unknown>) => Record<string, unknown>)(
                structuredClone(entry.state),
              )
            : updater;
        entry.state = structuredClone(next);
        this.publishSnapshot(entry);
      },
      getAuth: () => (entry.auth ? structuredClone(entry.auth) : undefined),
      setAuth: (auth) => {
        entry.auth = auth ? structuredClone(auth) : undefined;
        this.publishSnapshot(entry);
      },
      getLastError: () => (entry.lastError ? structuredClone(entry.lastError) : undefined),
      setLastExecution: (receipt) => {
        entry.lastExecution = receipt ? structuredClone(receipt) : undefined;
        this.publishSnapshot(entry);
      },
      setLastError: (failure) => {
        entry.lastError = failure ? structuredClone(failure) : undefined;
        this.publishSnapshot(entry);
      },
      markFailed: (failure) => {
        entry.lifecycle = "failed";
        entry.lastError = structuredClone(failure);
        this.publishSnapshot(entry);
      },
      publish: (event) => this.emit(event),
      face: this.drivers.createFaceCapability?.(manifest, scope),
      body: this.drivers.createBodyCapability?.(manifest, scope),
      vision: this.drivers.createVisionCapability?.(manifest, scope),
      ai: this.ai.createScopedCapability(manifest, scope),
      stage: this.stage.createScopedCapability(manifest, scope),
    };

    try {
      entry.runtime = entry.definition.create(context);
    } catch (error) {
      entry.runtime = undefined;
      entry.scope = undefined;
      void scope.dispose().catch(() => {});
      entry.lifecycle = "failed";
      entry.lastError = extractPluginFailure(
        error,
        `${manifest.id}.create`,
        "ERR_PLUGIN_CREATE_FAILED",
      );
      this.publishSnapshot(entry);
      throw error;
    } finally {
      entry.mounting = false;
    }
  }

  private buildSnapshot(entry: ManagedPluginEntry): PluginSnapshot<any> {
    const manifest = entry.definition.manifest;
    return structuredClone({
      id: manifest.id,
      manifest,
      name: manifest.name["zh-CN"],
      description: manifest.summary["zh-CN"],
      category: manifest.category,
      version: manifest.version,
      enabled: entry.enabled,
      lifecycle: entry.lifecycle,
      state: entry.state,
      configuration: toStringRecord(entry.storage.entries(), entry.state),
      dependencies: this.services.inspectDependencies(manifest),
      ...(entry.auth ? { auth: entry.auth } : {}),
      ...(entry.lastExecution ? { lastExecution: entry.lastExecution } : {}),
      ...(entry.lastError ? { lastError: entry.lastError } : {}),
      ...(this.stage.presentationForPlugin(manifest.id)
        ? { stagePresentation: this.stage.presentationForPlugin(manifest.id) }
        : {}),
    });
  }

  private publishSnapshot(entry: ManagedPluginEntry): void {
    this.emit({
      type: "state_changed",
      pluginId: entry.definition.manifest.id,
      snapshot: this.buildSnapshot(entry),
    });
  }

  private emit(event: PluginEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private enqueue(entry: ManagedPluginEntry, work: () => Promise<void>): Promise<void> {
    const next = entry.transitionQueue.then(work, work);
    entry.transitionQueue = next.catch(() => {});
    return next;
  }

  private requireEntry(id: string): ManagedPluginEntry {
    const entry = this.entries.get(id);
    if (!entry) {
      throw new PluginKernelError({
        stage: "plugin.host.lookup",
        code: "ERR_PLUGIN_NOT_FOUND",
        pluginId: id,
        reason: `Plugin not found: ${id}`,
      });
    }
    if (this.closing) {
      throw new PluginKernelError({
        stage: "plugin.host.closed",
        code: "ERR_PLUGIN_HOST_CLOSED",
        pluginId: id,
        reason: "Plugin host is closed",
      });
    }
    return entry;
  }

  snapshots(): PluginSnapshot<any>[] {
    return this.topology.bootOrder.map((id) => this.buildSnapshot(this.entries.get(id)!));
  }

  snapshot(id: string): PluginSnapshot<any> {
    return this.buildSnapshot(this.requireEntry(id));
  }

  subscribe(listener: (event: PluginEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  get(id: string): PluginRuntime<any, any> {
    const entry = this.requireEntry(id);
    if (!entry.runtime) {
      if (!entry.enabled) {
        throw new PluginKernelError({
          stage: "plugin.host.get",
          code: "ERR_PLUGIN_DISABLED",
          pluginId: id,
          reason: `Plugin "${id}" is disabled`,
        });
      }
      if (!entry.migrated) {
        throw new PluginKernelError({
          stage: "plugin.host.get",
          code: "ERR_PLUGIN_MIGRATION_PENDING",
          pluginId: id,
          reason: `Plugin "${id}" version migration (${entry.installedVersion} -> ${entry.definition.manifest.version}) has not completed yet`,
        });
      }
      if (!this.services.areHardDependenciesSatisfied(entry.definition.manifest)) {
        throw new PluginKernelError({
          stage: "plugin.host.get",
          code: "ERR_PLUGIN_WAITING_DEPENDENCY",
          pluginId: id,
          reason: `Plugin "${id}" is waiting for required service dependencies`,
        });
      }
      this.mountEntrySync(entry);
    }
    return entry.runtime!;
  }

  private async runMigrationIfNeeded(entry: ManagedPluginEntry): Promise<void> {
    if (entry.migrated) return;
    const manifest = entry.definition.manifest;
    if (entry.definition.migrate) {
      try {
        await entry.definition.migrate(entry.installedVersion, manifest.version, entry.storage);
        entry.installedVersion = manifest.version;
        entry.migrated = true;
        entry.state = structuredClone(
          (entry.definition.initialState(entry.storage) ?? {}) as Record<string, unknown>,
        );
        this.saveInstallationRow(manifest.id, entry.enabled, entry.installedVersion);
      } catch (error) {
        entry.lifecycle = "failed";
        entry.lastError = extractPluginFailure(error, "plugin.migrate", "ERR_PLUGIN_MIGRATION_FAILED");
        this.publishSnapshot(entry);
        throw error;
      }
    } else {
      entry.installedVersion = manifest.version;
      entry.migrated = true;
      this.saveInstallationRow(manifest.id, entry.enabled, entry.installedVersion);
    }
  }

  private async migrateAndMountIfReady(entry: ManagedPluginEntry): Promise<void> {
    if (!entry.enabled || this.closing) return;
    await this.runMigrationIfNeeded(entry);
    if (!entry.enabled || this.closing) return;
    if (this.services.areHardDependenciesSatisfied(entry.definition.manifest)) {
      this.mountEntrySync(entry);
      this.publishSnapshot(entry);
    }
  }

  /** Starts all enabled plugins in DAG topological order. */
  async startAll(): Promise<void> {
    for (const id of this.topology.bootOrder) {
      const entry = this.entries.get(id)!;
      if (entry.enabled) {
        await this.startPlugin(id);
      }
    }
  }

  async startPlugin(id: string): Promise<PluginSnapshot<any>> {
    const entry = this.requireEntry(id);
    await this.enqueue(entry, () => this.activateInternal(entry));
    await this.reconcileWaitingPlugins();
    return this.buildSnapshot(entry);
  }

  private activateInternal(entry: ManagedPluginEntry): Promise<void> {
    if (entry.startingPromise && entry.startingGeneration === entry.generation) {
      return entry.startingPromise;
    }
    const gen = entry.generation;
    entry.startingGeneration = gen;
    const promise = this.runActivateInternal(entry, gen).finally(() => {
      if (entry.startingPromise === promise) {
        entry.startingPromise = undefined;
        entry.startingGeneration = undefined;
      }
    });
    entry.startingPromise = promise;
    return promise;
  }

  private async runActivateInternal(entry: ManagedPluginEntry, expectedGen: number): Promise<void> {
    const manifest = entry.definition.manifest;
    if (!entry.enabled || this.closing || entry.generation !== expectedGen) return;
    if (entry.lifecycle === "active" && entry.runtime && entry.scope?.active) return;

    if (!this.services.areHardDependenciesSatisfied(manifest)) {
      entry.lifecycle = "waiting_dependency";
      this.publishSnapshot(entry);
      return;
    }

    await this.runMigrationIfNeeded(entry);
    if (!entry.enabled || this.closing || entry.generation !== expectedGen) return;

    this.mountEntrySync(entry);
    const activeRuntime = entry.runtime!;
    const activeScope = entry.scope!;
    entry.lifecycle = "starting";
    entry.lastError = undefined;
    this.publishSnapshot(entry);

    try {
      await activeRuntime.start();
      if (
        !entry.enabled ||
        this.closing ||
        entry.generation !== expectedGen ||
        entry.runtime !== activeRuntime ||
        entry.scope !== activeScope ||
        !activeScope.active
      ) {
        return;
      }
      // A plugin (e.g., CLI probe failure) may explicitly mark failed/lastError without throwing.
      if ((entry.lifecycle as PluginLifecycleState) === "failed" || entry.lastError) {
        entry.lifecycle = "failed";
        this.publishSnapshot(entry);
        return;
      }
      entry.lifecycle = "active";
      this.publishSnapshot(entry);
    } catch (error) {
      if (entry.generation !== expectedGen) {
        await activeScope.dispose().catch(() => {});
        throw error;
      }
      entry.lifecycle = "failed";
      entry.lastError = entry.lastError ?? extractPluginFailure(error, `${manifest.id}.start`, "ERR_PLUGIN_START_FAILED");
      if (entry.scope === activeScope) {
        await activeScope.dispose().catch(() => {});
        entry.scope = undefined;
        entry.runtime = undefined;
      }
      this.publishSnapshot(entry);
      throw error;
    }
  }

  private async deactivateInternal(
    entry: ManagedPluginEntry,
    reason: "disabled" | "dependency_lost" | "app_shutdown",
  ): Promise<void> {
    ++entry.generation;
    entry.startingPromise = undefined;
    entry.startingGeneration = undefined;

    const manifest = entry.definition.manifest;
    const runtime = entry.runtime;
    const scope = entry.scope;

    if (!runtime && !scope) {
      entry.lifecycle = reason === "dependency_lost" ? "waiting_dependency" : "stopped";
      this.publishSnapshot(entry);
      return;
    }

    entry.lifecycle = "stopping";
    this.publishSnapshot(entry);

    let stopError: unknown;
    try {
      if (runtime?.stop) {
        await runtime.stop(reason);
      }
    } catch (error) {
      stopError = error;
    }

    try {
      if (scope) {
        await scope.dispose();
      }
    } catch (error) {
      if (!stopError) stopError = error;
    }

    entry.scope = undefined;
    entry.runtime = undefined;

    if (stopError) {
      entry.lifecycle = "failed";
      entry.lastError =
        entry.lastError ??
        extractPluginFailure(stopError, `${manifest.id}.stop`, "ERR_PLUGIN_STOP_FAILED");
      this.publishSnapshot(entry);
      throw stopError;
    }

    entry.lifecycle = reason === "dependency_lost" ? "waiting_dependency" : "stopped";
    this.publishSnapshot(entry);
  }

  private async suspendHardDependents(providerPluginId: string): Promise<void> {
    const consumers = this.topology.hardConsumersByProvider.get(providerPluginId) ?? [];
    // Suspend in reverse topological order so upper consumers unwind before intermediate ones.
    const reverseOrder = [...this.topology.bootOrder].reverse();
    for (const consumerId of reverseOrder) {
      if (!consumers.includes(consumerId)) continue;
      const entry = this.entries.get(consumerId);
      if (!entry || !entry.enabled) continue;
      if (!this.services.areHardDependenciesSatisfied(entry.definition.manifest)) {
        await this.enqueue(entry, () => this.deactivateInternal(entry, "dependency_lost")).catch(() => {});
      }
    }
  }

  private async reconcileWaitingPlugins(): Promise<void> {
    if (this.closing) return;
    let progressed = true;
    while (progressed && !this.closing) {
      progressed = false;
      for (const pluginId of this.topology.bootOrder) {
        const entry = this.entries.get(pluginId)!;
        if (!entry.enabled || entry.lifecycle !== "waiting_dependency") continue;
        if (this.services.areHardDependenciesSatisfied(entry.definition.manifest)) {
          await this.enqueue(entry, () => this.activateInternal(entry)).catch(() => {});
          if ((entry.lifecycle as PluginLifecycleState) === "active") {
            progressed = true;
          }
        }
      }
    }
  }

  async setEnabled(id: string, enabled: boolean): Promise<PluginSnapshot<any>> {
    const entry = this.requireEntry(id);
    await this.enqueue(entry, async () => {
      entry.enabled = enabled;
      this.saveInstallationRow(id, enabled, entry.installedVersion);
      if (enabled) {
        await this.activateInternal(entry);
      } else {
        await this.deactivateInternal(entry, "disabled");
      }
    });
    if (enabled) {
      await this.reconcileWaitingPlugins();
    }
    return this.buildSnapshot(entry);
  }

  async configure(
    id: string,
    enabled: boolean,
    values: Record<string, string>,
  ): Promise<PluginSnapshot<any>> {
    const entry = this.requireEntry(id);
    await this.enqueue(entry, async () => {
      const wasEnabled = entry.enabled;
      entry.enabled = enabled;
      for (const [k, v] of Object.entries(values)) {
        entry.storage.set(k, v);
      }
      this.saveInstallationRow(id, enabled, entry.installedVersion);

      if (enabled) {
        if (this.services.areHardDependenciesSatisfied(entry.definition.manifest)) {
          await this.runMigrationIfNeeded(entry);
          this.mountEntrySync(entry);
          await entry.runtime?.configure?.(values);
          if (!wasEnabled || entry.lifecycle === "waiting_dependency") {
            await this.activateInternal(entry);
          } else {
            this.publishSnapshot(entry);
          }
        } else {
          entry.lifecycle = "waiting_dependency";
          entry.state = structuredClone(
            (entry.definition.initialState(entry.storage) ?? {}) as Record<string, unknown>,
          );
          this.publishSnapshot(entry);
        }
      } else {
        if (entry.runtime?.configure) {
          await entry.runtime.configure(values);
        } else {
          entry.state = structuredClone(
            (entry.definition.initialState(entry.storage) ?? {}) as Record<string, unknown>,
          );
        }
        await this.deactivateInternal(entry, "disabled");
      }
    });
    if (enabled) {
      await this.reconcileWaitingPlugins();
    }
    return this.buildSnapshot(entry);
  }

  async sendCommand<TCommand = unknown, TResult = unknown>(
    id: string,
    command: TCommand,
  ): Promise<TResult> {
    const runtime = this.get(id);
    if (!runtime.handleCommand) {
      throw new PluginKernelError({
        stage: "plugin.command.dispatch",
        code: "ERR_PLUGIN_COMMAND_UNSUPPORTED",
        pluginId: id,
        reason: `Plugin "${id}" does not implement handleCommand`,
      });
    }
    return runtime.handleCommand(command);
  }

  reportStageCrash(
    pluginId: string,
    slot: "StageCanvas" | "StageCapsule" | "StageDrawer",
    error: unknown,
  ): PluginFailure {
    const failure = extractPluginFailure(
      error,
      `plugin:${pluginId}:ui.${slot}`,
      "ERR_PLUGIN_STAGE_CRASH",
    );
    const entry = this.entries.get(pluginId);
    if (entry) {
      entry.lastError = structuredClone(failure);
    }
    this.stage.exitPluginStage(pluginId);
    if (entry) {
      this.publishSnapshot(entry);
    }
    return failure;
  }

  contribution(context: PluginTaskContext) {
    return this.ai.taskContribution(context);
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    const reverseOrder = [...this.topology.bootOrder].reverse();
    const errors: unknown[] = [];
    for (const id of reverseOrder) {
      const entry = this.entries.get(id)!;
      try {
        await this.enqueue(entry, () => this.deactivateInternal(entry, "app_shutdown"));
      } catch (error) {
        errors.push(error);
      }
    }
    this.listeners.clear();
    if (errors.length > 0) {
      throw errors[0];
    }
  }
}
