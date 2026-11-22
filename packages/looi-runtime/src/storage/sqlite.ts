import type { AgentTask } from "../agent/executor.js";
import type { TaskPersistence } from "../agent/task-store.js";
import { nextCronOccurrence } from "../schedule/cron.js";
import {
  DEFAULT_SCHEDULE_SETTINGS,
  type ScheduleExecutionPolicy,
  type ScheduleFailure,
  type ScheduleOrigin,
  type ScheduleRule,
  type ScheduleRuleState,
  type ScheduleRunRecord,
  type ScheduleRunStatus,
  type ScheduleSettings,
  type ScheduleToolFailure,
  type ScheduleTrigger,
} from "../schedule/types.js";
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

const RECOVERY_ERROR: ScheduleFailure = {
  stage: "schedule.recover",
  code: "ERR_SCHEDULE_RESULT_UNCONFIRMED",
  reason: "App exited before the scheduled run persisted its outcome",
};

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

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function decodeScheduleRule(row: Record<string, unknown>): ScheduleRule {
  const trigger = JSON.parse(String(row.trigger_json)) as ScheduleTrigger;
  return {
    id: String(row.id),
    title: String(row.title),
    prompt: String(row.prompt),
    origin: String(row.origin) as ScheduleOrigin,
    ...(optionalString(row.dedupe_key) ? { dedupeKey: String(row.dedupe_key) } : {}),
    trigger,
    executionPolicy: String(row.execution_policy) as ScheduleExecutionPolicy,
    enabled: Number(row.enabled) !== 0,
    state: String(row.state) as ScheduleRuleState,
    ...(optionalString(row.active_run_id) ? { activeRunId: String(row.active_run_id) } : {}),
    nextRunAt: typeof row.next_run_at === "string" ? row.next_run_at : null,
    ...(optionalString(row.last_run_at) ? { lastRunAt: String(row.last_run_at) } : {}),
    ...(optionalString(row.last_run_id) ? { lastRunId: String(row.last_run_id) } : {}),
    ...(optionalString(row.source_session_id)
      ? { sourceSessionId: String(row.source_session_id) }
      : {}),
    ...(optionalString(row.source_task_id) ? { sourceTaskId: String(row.source_task_id) } : {}),
    chain: {
      rootRuleId: String(row.root_rule_id),
      followUpCount: Number(row.follow_up_count ?? 0),
      maxFollowUps: Number(row.max_follow_ups ?? 3),
    },
    misfireGraceSeconds: Number(row.misfire_grace_seconds),
    ...(optionalString(row.expires_at) ? { expiresAt: String(row.expires_at) } : {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function decodeScheduleRun(row: Record<string, unknown>): ScheduleRunRecord {
  return {
    id: String(row.id),
    ruleId: String(row.rule_id),
    ruleTitle: String(row.rule_title),
    ...(optionalString(row.task_id) ? { taskId: String(row.task_id) } : {}),
    ...(optionalString(row.session_id) ? { sessionId: String(row.session_id) } : {}),
    triggerReason: String(row.trigger_reason) as ScheduleRunRecord["triggerReason"],
    scheduledFor: String(row.scheduled_for),
    startedAt: String(row.started_at),
    ...(optionalString(row.finished_at) ? { finishedAt: String(row.finished_at) } : {}),
    status: String(row.status) as ScheduleRunStatus,
    sideEffectDispatched: Number(row.side_effect_dispatched ?? 0) !== 0,
    ...(optionalString(row.report_source)
      ? { reportSource: String(row.report_source) as ScheduleRunRecord["reportSource"] }
      : {}),
    ...(optionalString(row.importance)
      ? { importance: String(row.importance) as ScheduleRunRecord["importance"] }
      : {}),
    ...(typeof row.summary === "string" ? { summary: row.summary } : {}),
    ...(typeof row.error === "string" && row.error
      ? { error: JSON.parse(row.error) as ScheduleFailure }
      : {}),
    ...(typeof row.tool_failures === "string" && row.tool_failures
      ? { toolFailures: JSON.parse(row.tool_failures) as ScheduleToolFailure[] }
      : {}),
    ...(optionalString(row.follow_up_rule_id)
      ? { followUpRuleId: String(row.follow_up_rule_id) }
      : {}),
  };
}

/** Owns the SQLite connection, task snapshots, and schedule persistence used by the mobile runtime. */
export class SqliteRuntimeStore {
  private closed = false;
  private txDepth = 0;
  private savepointSeq = 0;
  private readonly now: () => Date;
  readonly tasks: TaskPersistence;

  constructor(
    private readonly db: RuntimeDatabase,
    options?: { now?: () => Date },
  ) {
    this.now = options?.now ?? (() => new Date());
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS runtime_tasks (id TEXT PRIMARY KEY, snapshot TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runtime_observations (span_id TEXT PRIMARY KEY, trace_id TEXT NOT NULL, started_at INTEGER NOT NULL, snapshot TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS runtime_observations_trace ON runtime_observations(trace_id, started_at);

      CREATE TABLE IF NOT EXISTS schedule_rules (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        prompt TEXT NOT NULL,
        origin TEXT NOT NULL,
        dedupe_key TEXT,
        trigger_kind TEXT NOT NULL,
        trigger_json TEXT NOT NULL,
        execution_policy TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        state TEXT NOT NULL,
        active_run_id TEXT,
        next_run_at TEXT,
        last_run_at TEXT,
        last_run_id TEXT,
        source_session_id TEXT,
        source_task_id TEXT,
        root_rule_id TEXT NOT NULL,
        follow_up_count INTEGER NOT NULL DEFAULT 0,
        max_follow_ups INTEGER NOT NULL DEFAULT 3,
        misfire_grace_seconds INTEGER NOT NULL,
        expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS schedule_rules_state_next
        ON schedule_rules(state, next_run_at);
      CREATE UNIQUE INDEX IF NOT EXISTS schedule_rules_active_dedupe
        ON schedule_rules(origin, execution_policy, dedupe_key)
        WHERE state = 'active' AND dedupe_key IS NOT NULL;

      CREATE TABLE IF NOT EXISTS schedule_runs (
        id TEXT PRIMARY KEY,
        rule_id TEXT NOT NULL,
        rule_title TEXT NOT NULL,
        task_id TEXT,
        session_id TEXT,
        trigger_reason TEXT NOT NULL,
        scheduled_for TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        status TEXT NOT NULL,
        side_effect_dispatched INTEGER NOT NULL DEFAULT 0,
        report_source TEXT,
        importance TEXT,
        summary TEXT,
        error TEXT,
        tool_failures TEXT,
        follow_up_rule_id TEXT
      );
      CREATE INDEX IF NOT EXISTS schedule_runs_rule_started
        ON schedule_runs(rule_id, started_at DESC);

      CREATE TABLE IF NOT EXISTS schedule_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        settings_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );`);
    // Open observations belong to the previous runtime, which is no longer running.
    for (const row of db.prepare("SELECT snapshot FROM runtime_observations").all()) {
      const node = JSON.parse(String(row.snapshot)) as TraceObservation;
      if (node.endedAt === undefined && node.attributes["langfuse.observation.metadata.interrupted"] !== true) {
        node.attributes["langfuse.observation.metadata.interrupted"] = true;
        this.saveObservation(node);
      }
    }
    this.recoverInterruptedSchedules();
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

  /**
   * Executes `fn` inside a `BEGIN IMMEDIATE ... COMMIT` transaction (or a nested
   * savepoint when already inside a transaction), rolling back cleanly on error.
   */
  inTransaction<T>(fn: () => T): T {
    this.assertOpen();
    const depth = this.txDepth;
    const sp = depth > 0 ? `sp_looi_${++this.savepointSeq}` : undefined;
    if (depth === 0) {
      this.db.exec("BEGIN IMMEDIATE");
    } else {
      this.db.exec(`SAVEPOINT ${sp}`);
    }
    this.txDepth++;
    try {
      const result = fn();
      this.txDepth--;
      if (depth === 0) {
        this.db.exec("COMMIT");
      } else {
        this.db.exec(`RELEASE SAVEPOINT ${sp}`);
      }
      return result;
    } catch (error) {
      this.txDepth--;
      try {
        if (depth === 0) {
          this.db.exec("ROLLBACK");
        } else {
          this.db.exec(`ROLLBACK TO SAVEPOINT ${sp}; RELEASE SAVEPOINT ${sp}`);
        }
      } catch {
        // Keep original failure instead of masking it with rollback errors.
      }
      throw error;
    }
  }

  /** Executes a DML statement and reads `SELECT changes() AS changes` portably for Node & QuickJS. */
  runChanges(sql: string, ...values: Value[]): number {
    this.assertOpen();
    this.db.prepare(sql).run(...values);
    const row = this.db.prepare("SELECT changes() AS changes").get();
    return Number(row?.changes ?? 0);
  }

  private recoverInterruptedSchedules(): void {
    const recoveryNow = this.now();
    const nowIso = recoveryNow.toISOString();
    const errorJson = JSON.stringify(RECOVERY_ERROR);

    this.inTransaction(() => {
      const leftoverRunRows = this.db
        .prepare("SELECT * FROM schedule_runs WHERE status IN ('running', 'awaiting_user')")
        .all();
      const recoveredRuleSideEffect = new Map<string, boolean>();
      const updateRunStmt = this.db.prepare(
        "UPDATE schedule_runs SET status = 'result_unconfirmed', finished_at = ?, error = ? WHERE id = ?",
      );

      for (const row of leftoverRunRows) {
        const runId = String(row.id);
        const ruleId = String(row.rule_id);
        const sideEffect = Number(row.side_effect_dispatched ?? 0) !== 0;
        updateRunStmt.run(nowIso, errorJson, runId);
        recoveredRuleSideEffect.set(
          ruleId,
          (recoveredRuleSideEffect.get(ruleId) ?? false) || sideEffect,
        );
      }

      const affectedRuleRows = this.db
        .prepare("SELECT * FROM schedule_rules WHERE state = 'running' OR active_run_id IS NOT NULL")
        .all();
      const seenRuleIds = new Set<string>();
      const allRuleRows: Record<string, unknown>[] = [...affectedRuleRows];
      for (const row of affectedRuleRows) {
        seenRuleIds.add(String(row.id));
      }
      for (const ruleId of recoveredRuleSideEffect.keys()) {
        if (seenRuleIds.has(ruleId)) continue;
        const row = this.db.prepare("SELECT * FROM schedule_rules WHERE id = ?").get(ruleId);
        if (row) {
          seenRuleIds.add(ruleId);
          allRuleRows.push(row);
        }
      }

      const updateRuleStmt = this.db.prepare(
        "UPDATE schedule_rules SET state = ?, active_run_id = NULL, next_run_at = ?, updated_at = ? WHERE id = ?",
      );

      for (const row of allRuleRows) {
        const rule = decodeScheduleRule(row);
        const hadSideEffect = recoveredRuleSideEffect.get(rule.id) ?? false;
        let nextState: ScheduleRuleState;
        let nextRunAt: string | null = null;

        if (
          rule.trigger.kind === "once" ||
          (rule.executionPolicy === "authorized_action" && hadSideEffect)
        ) {
          nextState = "unconfirmed";
          nextRunAt = null;
        } else {
          if (rule.trigger.kind === "interval") {
            nextRunAt = new Date(
              recoveryNow.getTime() + rule.trigger.everySeconds * 1000,
            ).toISOString();
          } else {
            try {
              nextRunAt = nextCronOccurrence(rule.trigger.expr, recoveryNow).toISOString();
            } catch {
              nextState = "unconfirmed";
              nextRunAt = null;
              updateRuleStmt.run(nextState, nextRunAt, nowIso, rule.id);
              continue;
            }
          }
          const expiresAtMs = rule.expiresAt ? Date.parse(rule.expiresAt) : NaN;
          if (
            Number.isFinite(expiresAtMs) &&
            Date.parse(nextRunAt) > expiresAtMs
          ) {
            nextState = "expired";
            nextRunAt = null;
          } else {
            nextState = rule.enabled ? "active" : "paused";
          }
        }

        updateRuleStmt.run(nextState, nextRunAt, nowIso, rule.id);
      }
    });
  }

  getScheduleSettings(): ScheduleSettings {
    this.assertOpen();
    const row = this.db
      .prepare("SELECT settings_json FROM schedule_settings WHERE id = 1")
      .get();
    if (!row || typeof row.settings_json !== "string") {
      return structuredClone(DEFAULT_SCHEDULE_SETTINGS);
    }
    const parsed = JSON.parse(row.settings_json) as Partial<ScheduleSettings>;
    return {
      autoFollowUpEnabled:
        typeof parsed.autoFollowUpEnabled === "boolean"
          ? parsed.autoFollowUpEnabled
          : DEFAULT_SCHEDULE_SETTINGS.autoFollowUpEnabled,
      maxActiveInferredRules:
        typeof parsed.maxActiveInferredRules === "number" &&
        Number.isFinite(parsed.maxActiveInferredRules)
          ? parsed.maxActiveInferredRules
          : DEFAULT_SCHEDULE_SETTINGS.maxActiveInferredRules,
      quietHoursEnabled:
        typeof parsed.quietHoursEnabled === "boolean"
          ? parsed.quietHoursEnabled
          : DEFAULT_SCHEDULE_SETTINGS.quietHoursEnabled,
      quietHours: Array.isArray(parsed.quietHours)
        ? structuredClone(parsed.quietHours)
        : [],
    };
  }

  saveScheduleSettings(settings: ScheduleSettings): ScheduleSettings {
    this.assertOpen();
    const nowIso = this.now().toISOString();
    const normalized: ScheduleSettings = {
      autoFollowUpEnabled: settings.autoFollowUpEnabled,
      maxActiveInferredRules: settings.maxActiveInferredRules,
      quietHoursEnabled: settings.quietHoursEnabled,
      quietHours: structuredClone(settings.quietHours),
    };
    this.db
      .prepare(
        "INSERT INTO schedule_settings(id, settings_json, updated_at) VALUES(1, ?, ?) ON CONFLICT(id) DO UPDATE SET settings_json = excluded.settings_json, updated_at = excluded.updated_at",
      )
      .run(JSON.stringify(normalized), nowIso);
    return normalized;
  }

  getScheduleRule(id: string): ScheduleRule | undefined {
    this.assertOpen();
    const row = this.db.prepare("SELECT * FROM schedule_rules WHERE id = ?").get(id);
    return row ? decodeScheduleRule(row) : undefined;
  }

  findActiveDedupeRule(
    origin: ScheduleOrigin,
    executionPolicy: ScheduleExecutionPolicy,
    dedupeKey: string,
  ): ScheduleRule | undefined {
    this.assertOpen();
    const row = this.db
      .prepare(
        "SELECT * FROM schedule_rules WHERE state = 'active' AND origin = ? AND execution_policy = ? AND dedupe_key = ?",
      )
      .get(origin, executionPolicy, dedupeKey);
    return row ? decodeScheduleRule(row) : undefined;
  }

  listScheduleRules(filter?: {
    state?: ScheduleRuleState;
    origin?: ScheduleOrigin;
    limit?: number;
  }): ScheduleRule[] {
    this.assertOpen();
    const clauses: string[] = [];
    const params: Value[] = [];
    if (filter?.state) {
      clauses.push("state = ?");
      params.push(filter.state);
    }
    if (filter?.origin) {
      clauses.push("origin = ?");
      params.push(filter.origin);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const limitSql = filter?.limit !== undefined ? "LIMIT ?" : "";
    if (filter?.limit !== undefined) {
      params.push(filter.limit);
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM schedule_rules ${where} ORDER BY CASE WHEN next_run_at IS NULL THEN 1 ELSE 0 END, next_run_at ASC, created_at DESC ${limitSql}`,
      )
      .all(...params);
    return rows.map(decodeScheduleRule);
  }

  insertScheduleRule(rule: ScheduleRule): void {
    this.assertOpen();
    this.db
      .prepare(
        `INSERT INTO schedule_rules(
          id, title, prompt, origin, dedupe_key, trigger_kind, trigger_json,
          execution_policy, enabled, state, active_run_id, next_run_at,
          last_run_at, last_run_id, source_session_id, source_task_id,
          root_rule_id, follow_up_count, max_follow_ups,
          misfire_grace_seconds, expires_at, created_at, updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        rule.id,
        rule.title,
        rule.prompt,
        rule.origin,
        rule.dedupeKey ?? null,
        rule.trigger.kind,
        JSON.stringify(rule.trigger),
        rule.executionPolicy,
        rule.enabled ? 1 : 0,
        rule.state,
        rule.activeRunId ?? null,
        rule.nextRunAt,
        rule.lastRunAt ?? null,
        rule.lastRunId ?? null,
        rule.sourceSessionId ?? null,
        rule.sourceTaskId ?? null,
        rule.chain.rootRuleId,
        rule.chain.followUpCount,
        rule.chain.maxFollowUps,
        rule.misfireGraceSeconds,
        rule.expiresAt ?? null,
        rule.createdAt,
        rule.updatedAt,
      );
  }

  updateScheduleRule(rule: ScheduleRule): void {
    this.assertOpen();
    this.db
      .prepare(
        `UPDATE schedule_rules SET
          title = ?, prompt = ?, origin = ?, dedupe_key = ?,
          trigger_kind = ?, trigger_json = ?, execution_policy = ?,
          enabled = ?, state = ?, active_run_id = ?, next_run_at = ?,
          last_run_at = ?, last_run_id = ?, source_session_id = ?,
          source_task_id = ?, root_rule_id = ?, follow_up_count = ?,
          max_follow_ups = ?, misfire_grace_seconds = ?, expires_at = ?,
          updated_at = ?
        WHERE id = ?`,
      )
      .run(
        rule.title,
        rule.prompt,
        rule.origin,
        rule.dedupeKey ?? null,
        rule.trigger.kind,
        JSON.stringify(rule.trigger),
        rule.executionPolicy,
        rule.enabled ? 1 : 0,
        rule.state,
        rule.activeRunId ?? null,
        rule.nextRunAt,
        rule.lastRunAt ?? null,
        rule.lastRunId ?? null,
        rule.sourceSessionId ?? null,
        rule.sourceTaskId ?? null,
        rule.chain.rootRuleId,
        rule.chain.followUpCount,
        rule.chain.maxFollowUps,
        rule.misfireGraceSeconds,
        rule.expiresAt ?? null,
        rule.updatedAt,
        rule.id,
      );
  }

  deleteScheduleRule(id: string): boolean {
    return this.inTransaction(() => {
      this.db.prepare("DELETE FROM schedule_runs WHERE rule_id = ?").run(id);
      return this.runChanges("DELETE FROM schedule_rules WHERE id = ?", id) > 0;
    });
  }

  claimScheduleRuleForRun(input: {
    ruleId: string;
    run: ScheduleRunRecord;
    allowedStates: readonly ScheduleRuleState[];
    maxScheduledFor?: string;
    nowIso: string;
  }): boolean {
    return this.inTransaction(() => {
      const statePlaceholders = input.allowedStates.map(() => "?").join(", ");
      const params: Value[] = [input.run.id, input.nowIso, input.ruleId, ...input.allowedStates];
      let dueClause = "";
      if (input.maxScheduledFor !== undefined) {
        dueClause = "AND enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?";
        params.push(input.maxScheduledFor);
      }
      const changes = this.runChanges(
        `UPDATE schedule_rules
         SET state = 'running', active_run_id = ?, updated_at = ?
         WHERE id = ? AND active_run_id IS NULL AND state IN (${statePlaceholders}) ${dueClause}`,
        ...params,
      );
      if (changes !== 1) return false;
      this.insertScheduleRun(input.run);
      return true;
    });
  }

  insertScheduleRun(run: ScheduleRunRecord): void {
    this.assertOpen();
    this.db
      .prepare(
        `INSERT INTO schedule_runs(
          id, rule_id, rule_title, task_id, session_id, trigger_reason,
          scheduled_for, started_at, finished_at, status, side_effect_dispatched,
          report_source, importance, summary, error, tool_failures, follow_up_rule_id
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        run.id,
        run.ruleId,
        run.ruleTitle,
        run.taskId ?? null,
        run.sessionId ?? null,
        run.triggerReason,
        run.scheduledFor,
        run.startedAt,
        run.finishedAt ?? null,
        run.status,
        run.sideEffectDispatched ? 1 : 0,
        run.reportSource ?? null,
        run.importance ?? null,
        run.summary ?? null,
        run.error ? JSON.stringify(run.error) : null,
        run.toolFailures ? JSON.stringify(run.toolFailures) : null,
        run.followUpRuleId ?? null,
      );
  }

  updateScheduleRun(run: ScheduleRunRecord): void {
    this.assertOpen();
    this.db
      .prepare(
        `UPDATE schedule_runs SET
          task_id = ?, session_id = ?, finished_at = ?, status = ?,
          side_effect_dispatched = ?, report_source = ?, importance = ?,
          summary = ?, error = ?, tool_failures = ?, follow_up_rule_id = ?
        WHERE id = ?`,
      )
      .run(
        run.taskId ?? null,
        run.sessionId ?? null,
        run.finishedAt ?? null,
        run.status,
        run.sideEffectDispatched ? 1 : 0,
        run.reportSource ?? null,
        run.importance ?? null,
        run.summary ?? null,
        run.error ? JSON.stringify(run.error) : null,
        run.toolFailures ? JSON.stringify(run.toolFailures) : null,
        run.followUpRuleId ?? null,
        run.id,
      );
  }

  markRunSideEffectDispatched(runId: string): void {
    this.assertOpen();
    this.db
      .prepare("UPDATE schedule_runs SET side_effect_dispatched = 1 WHERE id = ?")
      .run(runId);
  }

  updateScheduleRunStatus(runId: string, status: ScheduleRunStatus): void {
    this.assertOpen();
    this.db
      .prepare("UPDATE schedule_runs SET status = ? WHERE id = ? AND status IN ('running', 'awaiting_user')")
      .run(status, runId);
  }

  getScheduleRun(runId: string): ScheduleRunRecord | undefined {
    this.assertOpen();
    const row = this.db.prepare("SELECT * FROM schedule_runs WHERE id = ?").get(runId);
    return row ? decodeScheduleRun(row) : undefined;
  }

  listScheduleRuns(ruleId?: string, limit = 50): ScheduleRunRecord[] {
    this.assertOpen();
    const rows = ruleId
      ? this.db
          .prepare(
            "SELECT * FROM schedule_runs WHERE rule_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?",
          )
          .all(ruleId, limit)
      : this.db
          .prepare("SELECT * FROM schedule_runs ORDER BY started_at DESC, rowid DESC LIMIT ?")
          .all(limit);
    return rows.map(decodeScheduleRun);
  }

  hasScheduleRuleForSourceTask(taskId: string): boolean {
    this.assertOpen();
    const row = this.db
      .prepare("SELECT 1 AS found FROM schedule_rules WHERE source_task_id = ? LIMIT 1")
      .get(taskId);
    return row !== undefined;
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
