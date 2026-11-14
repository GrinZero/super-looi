import {
  HOST_PLUGIN_API_VERSION,
  PLUGIN_CATEGORIES,
  type Dispose,
  type EffectScope,
  type PluginDependencyStatus,
  type PluginManifest,
  type PluginServiceDescriptor,
  type PluginServiceId,
  type PluginServiceRegistry,
} from "./contracts.js";
import { PluginKernelError } from "./errors.js";
import { parseSemVer, satisfiesSemVerRange } from "./semver.js";

const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]{1,47}$/;
const SERVICE_ID_RE = /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9.-]*$/;

export interface ValidatedTopology {
  /** Plugins ordered from foundational providers to upper-layer consumers */
  readonly bootOrder: readonly string[];
  readonly manifestsById: ReadonlyMap<string, PluginManifest>;
  readonly providersByService: ReadonlyMap<
    PluginServiceId,
    { readonly pluginId: string; readonly descriptor: PluginServiceDescriptor }
  >;
  /** Direct hard-dependent consumers (pluginId -> consumer pluginIds) */
  readonly hardConsumersByProvider: ReadonlyMap<string, readonly string[]>;
}

function findCyclePath(
  nodes: readonly string[],
  edges: ReadonlyMap<string, Set<string>>,
): string[] {
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];

  const dfs = (u: string): string[] | null => {
    state.set(u, 1);
    stack.push(u);
    for (const v of edges.get(u) ?? []) {
      const st = state.get(v) ?? 0;
      if (st === 1) {
        const idx = stack.indexOf(v);
        return [...stack.slice(idx), v];
      }
      if (st === 0) {
        const found = dfs(v);
        if (found) return found;
      }
    }
    stack.pop();
    state.set(u, 2);
    return null;
  };

  for (const node of nodes) {
    if ((state.get(node) ?? 0) === 0) {
      const cycle = dfs(node);
      if (cycle) return cycle;
    }
  }
  return nodes.slice(0, 2);
}

export function validateAndSortPluginTopology(manifests: readonly PluginManifest[]): ValidatedTopology {
  const manifestsById = new Map<string, PluginManifest>();
  const providersByService = new Map<
    PluginServiceId,
    { readonly pluginId: string; readonly descriptor: PluginServiceDescriptor }
  >();

  for (const manifest of manifests) {
    if (!PLUGIN_ID_RE.test(manifest.id)) {
      throw new PluginKernelError({
        stage: "plugin.manifest.validate",
        code: "ERR_PLUGIN_INVALID_ID",
        pluginId: manifest.id,
        reason: `Invalid plugin id "${manifest.id}"; expected /^[a-z0-9][a-z0-9-]{1,47}$/`,
      });
    }
    if (manifestsById.has(manifest.id)) {
      throw new PluginKernelError({
        stage: "plugin.manifest.validate",
        code: "ERR_PLUGIN_DUPLICATE_ID",
        pluginId: manifest.id,
        reason: `Duplicate plugin id "${manifest.id}"`,
      });
    }
    if (manifest.minHostApiVersion > HOST_PLUGIN_API_VERSION) {
      throw new PluginKernelError({
        stage: "plugin.manifest.validate",
        code: "ERR_PLUGIN_HOST_API_UNSUPPORTED",
        pluginId: manifest.id,
        reason: `Plugin "${manifest.id}" requires host API v${manifest.minHostApiVersion}, current host is v${HOST_PLUGIN_API_VERSION}`,
      });
    }
    if (!PLUGIN_CATEGORIES.includes(manifest.category)) {
      throw new PluginKernelError({
        stage: "plugin.manifest.validate",
        code: "ERR_PLUGIN_INVALID_CATEGORY",
        pluginId: manifest.id,
        reason: `Invalid category "${String(manifest.category)}" on plugin "${manifest.id}"`,
      });
    }

    parseSemVer(manifest.version, manifest.id);
    manifestsById.set(manifest.id, manifest);

    for (const provided of manifest.provides ?? []) {
      if (!SERVICE_ID_RE.test(provided.id)) {
        throw new PluginKernelError({
          stage: "plugin.manifest.validate",
          code: "ERR_PLUGIN_INVALID_SERVICE_ID",
          pluginId: manifest.id,
          reason: `Invalid service id "${provided.id}" on plugin "${manifest.id}"`,
        });
      }
      parseSemVer(provided.version, manifest.id);
      const existing = providersByService.get(provided.id);
      if (existing) {
        throw new PluginKernelError({
          stage: "plugin.manifest.validate",
          code: "ERR_PLUGIN_DUPLICATE_SERVICE",
          pluginId: manifest.id,
          reason: `Service "${provided.id}" is declared by both "${existing.pluginId}" and "${manifest.id}"`,
        });
      }
      providersByService.set(provided.id, { pluginId: manifest.id, descriptor: provided });
    }
  }

  const ids = [...manifestsById.keys()];
  const adj = new Map<string, Set<string>>(ids.map((id) => [id, new Set()]));
  const inDegree = new Map<string, number>(ids.map((id) => [id, 0]));
  const hardConsumers = new Map<string, Set<string>>(ids.map((id) => [id, new Set()]));

  for (const manifest of manifests) {
    for (const dep of manifest.dependencies ?? []) {
      if (!SERVICE_ID_RE.test(dep.service)) {
        throw new PluginKernelError({
          stage: "plugin.topology.validate",
          code: "ERR_PLUGIN_INVALID_SERVICE_ID",
          pluginId: manifest.id,
          reason: `Invalid dependency service id "${dep.service}" on plugin "${manifest.id}"`,
        });
      }
      // Validate range syntax eagerly even when provider is not installed.
      satisfiesSemVerRange("0.0.0", dep.versionRange, manifest.id);

      const provider = providersByService.get(dep.service);
      if (!provider) continue;

      if (provider.pluginId === manifest.id) {
        throw new PluginKernelError({
          stage: "plugin.topology.cycle",
          code: "ERR_PLUGIN_DEPENDENCY_CYCLE",
          pluginId: manifest.id,
          reason: `Plugin "${manifest.id}" cannot depend on its own service "${dep.service}"`,
        });
      }

      const compatible = satisfiesSemVerRange(
        provider.descriptor.version,
        dep.versionRange,
        manifest.id,
      );
      if (!compatible && !dep.optional) {
        throw new PluginKernelError({
          stage: "plugin.topology.version",
          code: "ERR_PLUGIN_SERVICE_VERSION_MISMATCH",
          pluginId: manifest.id,
          reason: `Plugin "${manifest.id}" requires "${dep.service}@${dep.versionRange}", but "${provider.pluginId}" provides v${provider.descriptor.version}`,
        });
      }

      const neighbors = adj.get(provider.pluginId)!;
      if (!neighbors.has(manifest.id)) {
        neighbors.add(manifest.id);
        inDegree.set(manifest.id, (inDegree.get(manifest.id) ?? 0) + 1);
      }
      if (!dep.optional && compatible) {
        hardConsumers.get(provider.pluginId)!.add(manifest.id);
      }
    }
  }

  // Kahn's algorithm preserving registration order among independent plugins.
  const queue: string[] = ids.filter((id) => (inDegree.get(id) ?? 0) === 0);
  const bootOrder: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    bootOrder.push(current);
    for (const next of adj.get(current) ?? []) {
      const deg = (inDegree.get(next) ?? 0) - 1;
      inDegree.set(next, deg);
      if (deg === 0) queue.push(next);
    }
  }

  if (bootOrder.length !== ids.length) {
    const cycle = findCyclePath(ids, adj);
    throw new PluginKernelError({
      stage: "plugin.topology.cycle",
      code: "ERR_PLUGIN_DEPENDENCY_CYCLE",
      pluginId: cycle[0],
      reason: `Plugin dependency cycle detected: ${cycle.join(" -> ")}`,
    });
  }

  return {
    bootOrder,
    manifestsById,
    providersByService,
    hardConsumersByProvider: new Map(
      [...hardConsumers.entries()].map(([k, set]) => [k, [...set]]),
    ),
  };
}

interface ActiveServiceRecord {
  readonly serviceId: PluginServiceId;
  readonly providerPluginId: string;
  readonly version: string;
  readonly proxy: object;
  readonly scope: EffectScope;
}

interface ServiceWatcher {
  readonly consumerPluginId: string;
  readonly serviceId: PluginServiceId;
  readonly versionRange: string;
  readonly parentScope: EffectScope;
  readonly callback: (service: any, depScope: EffectScope) => void | Promise<void>;
  depScope?: EffectScope;
}

function createAliveServiceProxy<T extends object>(
  target: T,
  serviceId: PluginServiceId,
  providerPluginId: string,
  scope: EffectScope,
): T {
  return new Proxy(target, {
    get(obj, prop) {
      if (prop === "then" || typeof prop === "symbol") {
        return Reflect.get(obj, prop, obj);
      }
      if (!scope.active) {
        throw new PluginKernelError({
          stage: "plugin.service.call",
          code: "ERR_PLUGIN_SERVICE_UNAVAILABLE",
          pluginId: providerPluginId,
          reason: `Service "${serviceId}" from plugin "${providerPluginId}" is no longer active`,
        });
      }
      const value = Reflect.get(obj, prop, obj);
      if (typeof value === "function") {
        return (...args: unknown[]) => {
          if (!scope.active) {
            throw new PluginKernelError({
              stage: "plugin.service.call",
              code: "ERR_PLUGIN_SERVICE_UNAVAILABLE",
              pluginId: providerPluginId,
              reason: `Service "${serviceId}" from plugin "${providerPluginId}" is no longer active`,
            });
          }
          return value.apply(obj, args);
        };
      }
      return value;
    },
  });
}

export class PluginServiceBroker {
  private readonly activeServices = new Map<PluginServiceId, ActiveServiceRecord>();
  private readonly watchers = new Set<ServiceWatcher>();

  constructor(
    private readonly topology: ValidatedTopology,
    private readonly onHardServiceRemoved?: (
      event: { serviceId: PluginServiceId; providerPluginId: string },
    ) => void | Promise<void>,
  ) {}

  hasCompatibleActiveService(serviceId: PluginServiceId, versionRange: string, consumerId?: string): boolean {
    const active = this.activeServices.get(serviceId);
    if (!active || !active.scope.active) return false;
    return satisfiesSemVerRange(active.version, versionRange, consumerId);
  }

  inspectDependencies(manifest: PluginManifest): PluginDependencyStatus[] {
    return (manifest.dependencies ?? []).map((dep) => {
      const providerInfo = this.topology.providersByService.get(dep.service);
      const providerManifest = providerInfo
        ? this.topology.manifestsById.get(providerInfo.pluginId)
        : undefined;
      const active = this.activeServices.get(dep.service);

      if (!providerInfo) {
        return {
          service: dep.service,
          versionRange: dep.versionRange,
          optional: Boolean(dep.optional),
          satisfied: false,
          reason: "provider_not_installed",
        };
      }

      const versionOk = satisfiesSemVerRange(
        providerInfo.descriptor.version,
        dep.versionRange,
        manifest.id,
      );
      if (!versionOk) {
        return {
          service: dep.service,
          versionRange: dep.versionRange,
          optional: Boolean(dep.optional),
          providerPluginId: providerInfo.pluginId,
          providerName: providerManifest?.name,
          satisfied: false,
          reason: `version_mismatch:${providerInfo.descriptor.version}`,
        };
      }

      const isOnline = Boolean(active && active.scope.active);
      return {
        service: dep.service,
        versionRange: dep.versionRange,
        optional: Boolean(dep.optional),
        providerPluginId: providerInfo.pluginId,
        providerName: providerManifest?.name,
        satisfied: isOnline,
        ...(isOnline ? {} : { reason: "provider_inactive" }),
      };
    });
  }

  areHardDependenciesSatisfied(manifest: PluginManifest): boolean {
    return (manifest.dependencies ?? []).every(
      (dep) => dep.optional || this.hasCompatibleActiveService(dep.service, dep.versionRange, manifest.id),
    );
  }

  createScopedRegistry(manifest: PluginManifest, defaultScope: EffectScope): PluginServiceRegistry {
    const providedMap = new Map(
      (manifest.provides ?? []).map((desc) => [desc.id, desc]),
    );
    const declaredDeps = new Map(
      (manifest.dependencies ?? []).map((dep) => [dep.service, dep]),
    );

    return {
      provide: <TService extends object>(
        serviceId: PluginServiceId,
        implementation: TService,
        scope: EffectScope = defaultScope,
      ): Dispose => {
        const descriptor = providedMap.get(serviceId);
        if (!descriptor) {
          throw new PluginKernelError({
            stage: "plugin.service.provide",
            code: "ERR_PLUGIN_UNDECLARED_SERVICE_PROVIDE",
            pluginId: manifest.id,
            reason: `Plugin "${manifest.id}" attempted to provide undeclared service "${serviceId}"`,
          });
        }
        if (this.activeServices.has(serviceId)) {
          throw new PluginKernelError({
            stage: "plugin.service.provide",
            code: "ERR_PLUGIN_SERVICE_ALREADY_ACTIVE",
            pluginId: manifest.id,
            reason: `Service "${serviceId}" is already active`,
          });
        }

        const proxy = createAliveServiceProxy(implementation, serviceId, manifest.id, scope);
        const record: ActiveServiceRecord = {
          serviceId,
          providerPluginId: manifest.id,
          version: descriptor.version,
          proxy,
          scope,
        };
        this.activeServices.set(serviceId, record);

        // Notify compatible watchers
        for (const watcher of [...this.watchers]) {
          if (
            watcher.serviceId === serviceId &&
            watcher.parentScope.active &&
            satisfiesSemVerRange(descriptor.version, watcher.versionRange, watcher.consumerPluginId)
          ) {
            this.bindWatcher(watcher, record);
          }
        }

        let removed = false;
        const teardown = async () => {
          if (removed) return;
          removed = true;
          if (this.activeServices.get(serviceId) === record) {
            this.activeServices.delete(serviceId);
          }
          for (const watcher of [...this.watchers]) {
            if (watcher.serviceId === serviceId && watcher.depScope) {
              const depScope = watcher.depScope;
              watcher.depScope = undefined;
              await depScope.dispose();
            }
          }
          await this.onHardServiceRemoved?.({
            serviceId,
            providerPluginId: manifest.id,
          });
        };

        const detachFromScope = scope.onDispose(teardown);
        return async () => {
          detachFromScope();
          await teardown();
        };
      },

      get: <TService extends object>(serviceId: PluginServiceId): TService => {
        const dep = declaredDeps.get(serviceId);
        if (!dep) {
          throw new PluginKernelError({
            stage: "plugin.service.get",
            code: "ERR_PLUGIN_UNDECLARED_SERVICE_DEPENDENCY",
            pluginId: manifest.id,
            reason: `Plugin "${manifest.id}" attempted to read undeclared dependency "${serviceId}"`,
          });
        }
        const record = this.activeServices.get(serviceId);
        if (!record || !record.scope.active) {
          throw new PluginKernelError({
            stage: "plugin.service.get",
            code: "ERR_PLUGIN_SERVICE_UNAVAILABLE",
            pluginId: manifest.id,
            reason: `Required service "${serviceId}" for plugin "${manifest.id}" is not active`,
          });
        }
        if (!satisfiesSemVerRange(record.version, dep.versionRange, manifest.id)) {
          throw new PluginKernelError({
            stage: "plugin.service.get",
            code: "ERR_PLUGIN_SERVICE_VERSION_MISMATCH",
            pluginId: manifest.id,
            reason: `Service "${serviceId}" is v${record.version}, which does not satisfy "${dep.versionRange}"`,
          });
        }
        return record.proxy as TService;
      },

      whenAvailable: <TService extends object>(
        serviceId: PluginServiceId,
        callback: (service: TService, depScope: EffectScope) => void | Promise<void>,
        scope: EffectScope = defaultScope,
      ): Dispose => {
        const dep = declaredDeps.get(serviceId);
        if (!dep) {
          throw new PluginKernelError({
            stage: "plugin.service.watch",
            code: "ERR_PLUGIN_UNDECLARED_SERVICE_DEPENDENCY",
            pluginId: manifest.id,
            reason: `Plugin "${manifest.id}" attempted to watch undeclared dependency "${serviceId}"`,
          });
        }

        const watcher: ServiceWatcher = {
          consumerPluginId: manifest.id,
          serviceId,
          versionRange: dep.versionRange,
          parentScope: scope,
          callback,
        };
        this.watchers.add(watcher);

        const active = this.activeServices.get(serviceId);
        if (
          active &&
          active.scope.active &&
          satisfiesSemVerRange(active.version, dep.versionRange, manifest.id)
        ) {
          this.bindWatcher(watcher, active);
        }

        const cleanup = async () => {
          this.watchers.delete(watcher);
          if (watcher.depScope) {
            const depScope = watcher.depScope;
            watcher.depScope = undefined;
            await depScope.dispose();
          }
        };

        const detach = scope.onDispose(cleanup);
        return async () => {
          detach();
          await cleanup();
        };
      },
    };
  }

  private bindWatcher(watcher: ServiceWatcher, record: ActiveServiceRecord): void {
    const depScope = watcher.parentScope.fork(`dep:${record.serviceId}`);
    watcher.depScope = depScope;
    Promise.resolve()
      .then(() => {
        if (
          !depScope.active ||
          !watcher.parentScope.active ||
          !record.scope.active ||
          watcher.depScope !== depScope ||
          !this.watchers.has(watcher) ||
          this.activeServices.get(record.serviceId) !== record
        ) {
          return;
        }
        return watcher.callback(record.proxy, depScope);
      })
      .catch(() => {
        // Watcher callback failures unwind their dedicated dependency scope cleanly.
        if (watcher.depScope === depScope) {
          watcher.depScope = undefined;
          void depScope.dispose().catch(() => {});
        }
      });
  }
}
