import type { RuntimeDatabase } from "@super-looi/runtime/storage/sqlite";

/** Disposable home data; credentials remain in the native vault. */
export interface HomeCache {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

export function createHomeCache(db: RuntimeDatabase): HomeCache {
  db.exec("CREATE TABLE IF NOT EXISTS home_cache (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const read = db.prepare("SELECT value FROM home_cache WHERE key = ?");
  const write = db.prepare("INSERT INTO home_cache(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
  const remove = db.prepare("DELETE FROM home_cache WHERE key = ?");
  return {
    get: (key) => (read.get(key)?.value as string | undefined) ?? null,
    set: (key, value) => { write.run(key, value); },
    remove: (key) => { remove.run(key); },
  };
}
