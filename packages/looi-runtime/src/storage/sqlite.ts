import type { AgentTask } from "../agent/executor.js";
import type { TaskPersistence } from "../agent/task-store.js";
import type { TraceObservation } from "../telemetry/langfuse.js";

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
// Earlier observers could record a repeated provider event after the first tool result.
const voiceToolCalls = `FROM runtime_observations WHERE rowid IN (
  SELECT min(rowid) FROM runtime_observations
  WHERE json_extract(snapshot, '$.name') = 'realtime.tool_call'
    AND json_type(snapshot, '$.attributes."langfuse.observation.input".name') = 'text'
    AND json_extract(snapshot, '$.attributes."langfuse.observation.input".name')
      NOT IN ('', 'run_agent_task', 'manage_agent_task')
  GROUP BY trace_id, coalesce(nullif(json_extract(snapshot, '$.attributes."langfuse.observation.metadata.callId"'), ''), span_id)
)`;

type TaskSummary = Pick<AgentTask, "id" | "prompt" | "state" | "updatedAt">;
function decodeTask(row: Record<string, unknown>): AgentTask {
  const task = JSON.parse(String(row.snapshot)) as AgentTask;
  if (task.id !== row.id) throw new Error("Task snapshot identity mismatch");
  return task;
}

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
      CREATE TABLE IF NOT EXISTS runtime_tasks (id TEXT PRIMARY KEY, snapshot TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runtime_observations (span_id TEXT PRIMARY KEY, trace_id TEXT NOT NULL, started_at INTEGER NOT NULL, snapshot TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS runtime_observations_trace ON runtime_observations(trace_id, started_at);`);
    // Open observations belong to the previous runtime, which is no longer running.
    for (const row of db.prepare("SELECT snapshot FROM runtime_observations").all()) {
      const node = JSON.parse(String(row.snapshot)) as TraceObservation;
      if (node.endedAt === undefined && node.attributes["langfuse.observation.metadata.interrupted"] !== true) {
        node.attributes["langfuse.observation.metadata.interrupted"] = true;
        this.saveObservation(node);
      }
    }
    this.tasks = {
      load: () => {
        this.assertOpen();
        return db
          .prepare("SELECT id,snapshot FROM runtime_tasks ORDER BY id")
          .all()
          .map(decodeTask);
      },
      save: (task) => {
        this.assertOpen();
        db.prepare(
          "INSERT INTO runtime_tasks(id,snapshot) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET snapshot=excluded.snapshot",
        ).run(task.id, encode(task));
      },
    };
  }

  task(id: string): AgentTask | undefined {
    this.assertOpen();
    const row = this.db.prepare("SELECT id,snapshot FROM runtime_tasks WHERE id = ?").get(id);
    return row ? decodeTask(row) : undefined;
  }

  taskHistoryPage(offset: number, limit: number) {
    this.assertOpen();
    const total = this.db.prepare(`SELECT
      (SELECT count(*) FROM runtime_tasks) + (SELECT count(*) ${voiceToolCalls}) AS total`).get();
    const rows = this.db.prepare(`SELECT id, prompt, state, updatedAt, observation FROM (
      SELECT id, substr(json_extract(snapshot, '$.prompt'), 1, 160) AS prompt,
        json_extract(snapshot, '$.state') AS state, json_extract(snapshot, '$.updatedAt') AS updatedAt,
        NULL AS observation FROM runtime_tasks
      UNION ALL
      SELECT span_id, NULL, NULL,
        strftime('%Y-%m-%dT%H:%M:%fZ', coalesce(json_extract(snapshot, '$.endedAt'), started_at) / 1000.0, 'unixepoch'),
        snapshot ${voiceToolCalls}
    ) ORDER BY updatedAt DESC, id LIMIT ? OFFSET ?`).all(limit, offset);
    return {
      total: Number(total?.total),
      entries: rows.map(({ observation, ...summary }): TaskSummary | TraceObservation =>
        typeof observation === "string" ? JSON.parse(observation) as TraceObservation : summary as TaskSummary),
    };
  }

  observation(spanId: string): TraceObservation | undefined {
    this.assertOpen();
    const row = this.db.prepare("SELECT snapshot FROM runtime_observations WHERE span_id = ?").get(spanId);
    return row ? JSON.parse(String(row.snapshot)) as TraceObservation : undefined;
  }

  saveObservation(observation: TraceObservation): void {
    this.assertOpen();
    this.db.prepare("INSERT INTO runtime_observations(span_id,trace_id,started_at,snapshot) VALUES(?,?,?,?) ON CONFLICT(span_id) DO UPDATE SET snapshot=excluded.snapshot")
      .run(observation.spanId, observation.traceId, observation.startedAt, JSON.stringify(observation));
  }

  traceObservations(traceId: string): TraceObservation[] {
    this.assertOpen();
    return this.db.prepare("SELECT snapshot FROM runtime_observations WHERE trace_id = ? ORDER BY started_at, rowid")
      .all(traceId).map(row => JSON.parse(String(row.snapshot)) as TraceObservation);
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
