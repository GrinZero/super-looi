import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentTask } from "./executor.js";

export interface TaskPersistence {
  load(): AgentTask[];
  save(task: AgentTask): void;
}

/** One runtime owns task snapshots; Pi sessions have a separate append log. */
export class AgentTaskStore {
  private readonly tasks = new Map<string, AgentTask>();

  constructor(
    private readonly directory: string,
    private readonly persistence?: TaskPersistence,
  ) {
    if (!persistence) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const tasks = persistence
      ? persistence.load()
      : fs
          .readdirSync(directory)
          .filter((name) => name.endsWith(".json"))
          .map((file) => {
            const task = JSON.parse(
              fs.readFileSync(path.join(directory, file), "utf8"),
            ) as AgentTask;
            this.assertId(task.id);
            if (file !== `${task.id}.json`)
              throw new Error("Invalid task snapshot filename");
            return task;
          });
    for (const task of tasks) {
      this.assertId(task.id);
      if (
        [
          "queued",
          "running",
          "awaiting_approval",
          "awaiting_input",
          "cancelling",
        ].includes(task.state)
      ) {
        task.state = "unknown";
        task.error =
          "Runtime restarted; previous execution outcome requires verification before explicit resume.";
        delete task.interaction;
      }
      this.save(task);
    }
  }

  assertId(id: string): void {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error("Invalid task id");
  }

  save(task: AgentTask): void {
    this.assertId(task.id);
    if (this.persistence) {
      this.persistence.save(task);
      this.tasks.set(task.id, task);
      return;
    }
    const target = path.join(this.directory, `${task.id}.json`);
    const temp = `${target}.${randomUUID()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(task), { mode: 0o600 });
    fs.renameSync(temp, target);
    this.tasks.set(task.id, task);
  }

  get(id: string): AgentTask | undefined {
    return this.tasks.get(id);
  }
  list(): AgentTask[] {
    return [...this.tasks.values()];
  }
}
