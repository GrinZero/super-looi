import type { DatabaseSync } from "node:sqlite";
import type { AgentTask } from "@super-looi/runtime/agent/executor";
import type { SqliteRuntimeStore } from "@super-looi/runtime/storage/sqlite";
import { directVoiceToolName, voiceToolTask, voiceToolTaskPrefix } from "../voice-tool-history.js";

/**
 * Read model and activity broadcaster for task history, voice tool executions,
 * and durable home/body action evidence stored in SQLite.
 */
export class TaskHistoryStore {
  private readonly listeners = new Set<(historyChanged: boolean) => void>();
  private pendingUpdate?: { historyChanged: boolean };

  constructor(
    private readonly options: {
      database: DatabaseSync;
      storage: SqliteRuntimeStore;
      getTask: (id: string) => AgentTask | undefined;
      isClosed: () => boolean;
    },
  ) {}

  page(offset = 0) {
    if (this.options.isClosed()) throw new Error("@looi:runtimeRuntimeClosed");
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new Error("@looi:runtimeInvalidTaskPage");
    }
    const { total, entries } = this.options.storage.taskHistoryPage(offset, 10);
    return {
      total,
      offset,
      items: entries.map((entry) => {
        if (!("spanId" in entry)) return entry;
        const { id, voiceToolName, prompt, state, updatedAt } = voiceToolTask(
          entry,
          directVoiceToolName(entry)!,
        );
        return { id, voiceToolName, prompt, state, updatedAt };
      }),
    };
  }

  details(id: string) {
    if (this.options.isClosed()) throw new Error("@looi:runtimeRuntimeClosed");
    if (id.startsWith(voiceToolTaskPrefix)) {
      const observation = this.options.storage.observation(
        id.slice(voiceToolTaskPrefix.length),
      );
      const name = observation && directVoiceToolName(observation);
      if (!observation || !name) throw new Error("@looi:runtimeTaskNotFound");
      return {
        ...voiceToolTask(observation, name),
        sessionId: String(observation.attributes["session.id"] ?? ""),
        steps: [],
        homeActions: [],
        observations: this.options.storage.traceObservations(observation.traceId),
      };
    }
    const task = this.options.getTask(id) ?? this.options.storage.task(id);
    if (!task) throw new Error("@looi:runtimeTaskNotFound");
    const homeActions = this.options.database
      .prepare(
        "SELECT evidence FROM home_action_evidence WHERE task_id = ? ORDER BY rowid",
      )
      .all(task.id)
      .map((row) => JSON.parse(String(row.evidence)));
    const bodyActions = this.options.database
      .prepare(
        "SELECT evidence FROM body_action_evidence WHERE task_id = ? ORDER BY rowid",
      )
      .all(task.id)
      .map((row) => JSON.parse(String(row.evidence)));
    return {
      ...task,
      homeActions,
      bodyActions,
      observations: task.trace
        ? this.options.storage.traceObservations(task.trace.traceId)
        : [],
    };
  }

  subscribe(listener: (historyChanged: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(historyChanged: boolean): void {
    if (this.listeners.size === 0) return;
    if (this.pendingUpdate) {
      this.pendingUpdate.historyChanged ||= historyChanged;
      return;
    }
    const update = { historyChanged };
    this.pendingUpdate = update;
    // Publish after the executor updates its in-memory snapshot following persistence.
    void Promise.resolve().then(() => {
      this.pendingUpdate = undefined;
      for (const listener of this.listeners) listener(update.historyChanged);
    });
  }

  clearListeners(): void {
    this.listeners.clear();
  }
}
