import type { AgentTask } from "../agent/executor.js";
import type { TaskPersistence } from "../agent/task-store.js";

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

/** Owns the SQLite connection and task snapshots used by the mobile runtime. */
export class SqliteRuntimeStore {
  private closed = false;
  readonly tasks: TaskPersistence;

  constructor(private readonly db: RuntimeDatabase) {
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS runtime_tasks (id TEXT PRIMARY KEY, snapshot TEXT NOT NULL);`);
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

  private assertOpen(): void {
    if (this.closed) throw new Error("Runtime store is closed");
  }
  close(): void {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }
}
