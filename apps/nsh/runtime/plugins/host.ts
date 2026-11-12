import type { DatabaseSync } from "node:sqlite";
import type { PluginDefinition, PluginEvent, PluginRuntime, PluginTaskContext } from "./contracts.js";

/** App-owned instances and settings; Pi remains the tool and Skill loader. */
export class PluginHost {
  private readonly instances = new Map<string, { runtime: PluginRuntime; enabled: boolean }>();
  private readonly listeners = new Set<(event: PluginEvent) => void>();
  private closing = false;
  constructor(private readonly database: DatabaseSync, definitions: readonly PluginDefinition[]) {
    database.exec("CREATE TABLE IF NOT EXISTS plugin_settings (id TEXT PRIMARY KEY, enabled INTEGER NOT NULL, configuration TEXT NOT NULL)");
    for (const definition of definitions) {
      const saved = database.prepare("SELECT enabled, configuration FROM plugin_settings WHERE id = ?").get(definition.id) as { enabled: number; configuration: string } | undefined;
      const entry = { enabled: saved ? Boolean(saved.enabled) : true, runtime: undefined as unknown as PluginRuntime };
      entry.runtime = definition.create({
        enabled: () => entry.enabled && !this.closing,
        configuration: saved ? JSON.parse(saved.configuration) : {},
        publish: event => { for (const listener of this.listeners) listener(event); },
      });
      this.instances.set(definition.id, entry);
    }
  }
  snapshots() { return [...this.instances.values()].map(entry => entry.runtime.snapshot()); }
  subscribe(listener: (event: PluginEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  get(id: string) {
    const entry = this.instances.get(id);
    if (!entry) throw new Error(`Plugin not found: ${id}`);
    if (this.closing) throw new Error("Plugin host is closed");
    return entry.runtime;
  }
  private save(id: string) {
    const entry = this.instances.get(id)!;
    this.database.prepare("INSERT INTO plugin_settings (id, enabled, configuration) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled, configuration=excluded.configuration")
      .run(id, Number(entry.enabled), JSON.stringify(entry.runtime.snapshot().configuration));
  }
  async configure(id: string, enabled: boolean, values: Record<string, string>) {
    const runtime = this.get(id);
    const entry = this.instances.get(id)!;
    entry.enabled = enabled;
    await runtime.configure(values);
    this.save(id);
    if (enabled) await runtime.start();
    else await runtime.stop("disabled");
    return runtime.snapshot();
  }
  contribution(context: PluginTaskContext) {
    const active = [...this.instances.values()].filter(entry => entry.enabled);
    return {
      tools: active.flatMap(entry => entry.runtime.tools(context)),
      skillPaths: active.flatMap(entry => [...(entry.runtime.skillPaths ?? [])]),
    };
  }
  async close() {
    this.closing = true;
    await Promise.all([...this.instances.values()].map(entry => entry.runtime.stop("app_shutdown")));
    this.listeners.clear();
  }
}
