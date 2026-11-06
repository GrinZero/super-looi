import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentTask } from "./executor.js";

/** Single Hub process owns these snapshots. DSH owns its separate session log. */
export class AgentTaskStore {
  private readonly tasks = new Map<string, AgentTask>();

  constructor(private readonly directory: string) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    for (const file of fs.readdirSync(directory).filter(name => name.endsWith(".json"))) {
      const task = JSON.parse(fs.readFileSync(path.join(directory, file), "utf8")) as AgentTask;
      this.assertId(task.id);
      if (file !== `${task.id}.json`) throw new Error("Invalid task snapshot filename");
      if (["queued", "running", "awaiting_approval", "awaiting_input", "cancelling"].includes(task.state)) {
        task.state = "unknown";
        task.error = "Hub restarted; previous execution outcome requires verification before explicit resume.";
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
    const target = path.join(this.directory, `${task.id}.json`);
    const temp = `${target}.${randomUUID()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(task), { mode: 0o600 });
    fs.renameSync(temp, target);
    this.tasks.set(task.id, task);
  }

  get(id: string): AgentTask | undefined { return this.tasks.get(id); }
  list(): AgentTask[] { return [...this.tasks.values()]; }
}
