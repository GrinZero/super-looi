import type { AgentTask } from "../agent/executor.js";
import type { TaskPersistence } from "../agent/task-store.js";
import type { LedgerPersistence, LedgerSnapshot } from "../memory/ledger.js";
import type { DeletionTombstone } from "@super-looi/contracts";

type Value = string | number | null;
export interface RuntimeDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): {
    run(...values: Value[]): unknown;
    get(...values: Value[]): Record<string, unknown> | undefined;
    all(...values: Value[]): Record<string, unknown>[];
  };
  close(): void;
}

const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
function encode(value: unknown): string {
  const json = JSON.stringify(value);
  if (new TextEncoder().encode(json).byteLength > MAX_SNAPSHOT_BYTES)
    throw new Error("Runtime snapshot capacity exceeded");
  return json;
}

/** Owns one private SQLite connection. Deletion records are append-only and
 * committed in the same transaction as the ledger. Importing an old snapshot
 * cannot overwrite this deletion log. The host supplies the database adapter. */
export class SqliteRuntimeStore {
  private closed = false;
  readonly ledger: LedgerPersistence;
  readonly tasks: TaskPersistence;

  constructor(private readonly db: RuntimeDatabase) {
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS runtime_ledger (id INTEGER PRIMARY KEY CHECK(id=1), snapshot TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runtime_deletions (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runtime_tasks (id TEXT PRIMARY KEY, snapshot TEXT NOT NULL);`);
    this.ledger = {
      load: () => {
        this.assertOpen();
        const row = db
          .prepare("SELECT snapshot FROM runtime_ledger WHERE id=1")
          .get();
        if (!row) return undefined;
        const snapshot = JSON.parse(String(row.snapshot)) as LedgerSnapshot;
        const graves = this.deletionLog();
        snapshot.tombstones = [
          ...new Map(
            [...snapshot.tombstones, ...graves].map((grave) => [
              grave.tombstone_id,
              grave,
            ]),
          ).values(),
        ];
        return snapshot;
      },
      save: (snapshot) =>
        this.transaction(() => {
          const json = encode(snapshot);
          const insert = db.prepare(
            "INSERT OR IGNORE INTO runtime_deletions(id,payload) VALUES(?,?)",
          );
          const existing = db.prepare(
            "SELECT payload FROM runtime_deletions WHERE id=?",
          );
          for (const grave of snapshot.tombstones) {
            const payload = encode(grave),
              prior = existing.get(grave.tombstone_id);
            if (prior && prior.payload !== payload)
              throw new Error("Deletion record integrity conflict");
            insert.run(grave.tombstone_id, payload);
          }
          db.prepare(
            "INSERT INTO runtime_ledger(id,snapshot) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET snapshot=excluded.snapshot",
          ).run(json);
        }),
    };
    this.tasks = {
      load: () => {
        this.assertOpen();
        return db
          .prepare("SELECT id,snapshot FROM runtime_tasks ORDER BY id")
          .all()
          .map((row) => {
            const task = JSON.parse(String(row.snapshot)) as AgentTask;
            if (task.id !== row.id)
              throw new Error("Task snapshot identity mismatch");
            return task;
          });
      },
      save: (task) => {
        this.assertOpen();
        db.prepare(
          "INSERT INTO runtime_tasks(id,snapshot) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET snapshot=excluded.snapshot",
        ).run(task.id, encode(task));
      },
    };
  }

  deletionLog(): DeletionTombstone[] {
    this.assertOpen();
    return this.db
      .prepare("SELECT payload FROM runtime_deletions ORDER BY id")
      .all()
      .map((row) => JSON.parse(String(row.payload)) as DeletionTombstone);
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Runtime store is closed");
  }
  private transaction(write: () => void): void {
    this.assertOpen();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      write();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  close(): void {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }
}
