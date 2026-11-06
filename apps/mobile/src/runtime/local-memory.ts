import type { HubMemoryItem } from "./live-voice-client.js";

export interface LocalStorage { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<void> }
interface MemoryState { version: 1; generation: number; entries: HubMemoryItem[]; tombstones: Array<{ id: string; generation: number; deletedAt: string }> }

/** Single writer ledger. Deletion invalidates every tool write captured before it. */
export class LocalPersonalMemoryStore {
  private state: MemoryState = { version: 1, generation: 0, entries: [], tombstones: [] };
  private queue: Promise<void> = Promise.resolve();
  private loaded: Promise<void> | null = null;
  private generation = 0;
  constructor(private readonly storage: LocalStorage, private readonly id: () => string, private readonly changed: () => void = () => {}) {}

  initialize(): Promise<void> {
    if (!this.loaded) this.loaded = (async () => {
      const raw = await this.storage.get("personal-memory-v1");
      if (!raw) return;
      const parsed = JSON.parse(raw) as MemoryState;
      if (parsed.version !== 1 || !Number.isSafeInteger(parsed.generation) || parsed.generation < 0 || !Array.isArray(parsed.entries) || !Array.isArray(parsed.tombstones)
        || !parsed.entries.every((entry) => typeof entry.id === "string" && typeof entry.fact === "string" && typeof entry.updatedAt === "string")) throw new Error("本机记忆文件无法读取，请保留文件后检查");
      this.state = parsed; this.generation = parsed.generation;
    })();
    return this.loaded;
  }
  captureGeneration(): number { return this.generation; }
  invalidateCaptures(): void { ++this.generation; }
  list(query = ""): HubMemoryItem[] {
    const q = query.trim().toLowerCase();
    return this.state.entries.filter((entry) => !q || `${entry.fact} ${entry.subject ?? ""} ${entry.location ?? ""}`.toLowerCase().includes(q)).map((entry) => ({ ...entry }));
  }
  private mutate(operation: () => MemoryState, expectedGeneration?: number): Promise<void> {
    const task = this.queue.then(async () => {
      await this.initialize();
      const next = operation();
      await this.storage.set("personal-memory-v1", JSON.stringify(next));
      if (expectedGeneration !== undefined && expectedGeneration !== this.generation) {
        await this.storage.set("personal-memory-v1", JSON.stringify({ ...this.state, generation: this.generation }));
        throw new Error("记忆写入已撤销");
      }
      this.state = next; this.changed();
    });
    this.queue = task.catch(() => {});
    return task;
  }
  async remember(input: { fact: string; subject?: string; location?: string }, expectedGeneration = this.generation): Promise<HubMemoryItem> {
    let result!: HubMemoryItem;
    await this.mutate(() => {
      if (expectedGeneration !== this.generation) throw new Error("记忆写入已被删除操作撤销，请重新明确记住");
      const fact = input.fact.trim();
      if (!fact || fact.length > 4000) throw new Error("记忆内容应为 1–4000 字");
      const subject = input.subject?.trim() || fact.match(/^(?:我的|把)?(.{1,20}?)(?:放在|放到|在)/)?.[1];
      const location = input.location?.trim() || fact.match(/(?:放在|放到|在)([^，。]{1,60})/)?.[1];
      const previous = this.state.entries.find((entry) => entry.fact === fact || (subject && entry.subject === subject));
      result = { id: previous?.id ?? `mem_${this.id()}`, fact, subject, location, category: location ? "item_location" : "note", source: "voice", updatedAt: new Date().toISOString() };
      return { ...this.state, generation: this.generation, entries: [result, ...this.state.entries.filter((entry) => entry.id !== result.id)] };
    }, expectedGeneration);
    return { ...result };
  }
  async forget(idOrQuery: string): Promise<number> {
    const query = idOrQuery.trim();
    if (!query) throw new Error("请指定要忘记的记忆");
    await this.initialize();
    ++this.generation;
    let count = 0;
    await this.mutate(() => {
      const removed = this.state.entries.filter((entry) => entry.id === query || entry.fact.includes(query) || entry.subject?.includes(query));
      count = removed.length;
      const removedIds = new Set(removed.map((entry) => entry.id));
      return { ...this.state, generation: this.generation, entries: this.state.entries.filter((entry) => !removedIds.has(entry.id)),
        tombstones: [...this.state.tombstones, ...removed.map((entry) => ({ id: entry.id, generation: this.generation, deletedAt: new Date().toISOString() }))] };
    });
    return count;
  }
  async correct(id: string, location: string): Promise<void> {
    await this.initialize();
    const generation = this.generation;
    await this.mutate(() => {
      const entry = this.state.entries.find((item) => item.id === id);
      if (!entry || !location.trim() || generation !== this.generation) throw new Error("请选择仍然有效的记忆与位置");
      const subject = entry.subject ?? entry.fact;
      const updated = { ...entry, subject, location: location.trim(), fact: `${subject}在${location.trim()}`, category: "item_location" as const, source: "user" as const, updatedAt: new Date().toISOString() };
      return { ...this.state, generation, entries: this.state.entries.map((item) => item.id === id ? updated : item) };
    }, generation);
  }
}
