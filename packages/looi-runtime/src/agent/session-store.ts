import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

const VALID_ID = /^[a-zA-Z0-9_-]{1,100}$/;

/**
 * Atomic JSON transcript persistence for multi-turn Agent sessions.
 * Keeps filesystem I/O and session ID validation isolated from the task scheduler.
 */
export class SessionTranscriptStore {
  constructor(private readonly sessionsDir: string) {
    fs.mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
  }

  private assertId(sessionId: string): void {
    if (!VALID_ID.test(sessionId)) throw new Error("Invalid task id");
  }

  load(sessionId: string): AgentMessage[] | undefined {
    this.assertId(sessionId);
    const file = path.join(this.sessionsDir, `${sessionId}.json`);
    if (!fs.existsSync(file)) return undefined;
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error("Invalid persisted session transcript");
    }
    return parsed as AgentMessage[];
  }

  save(sessionId: string, messages: AgentMessage[]): void {
    this.assertId(sessionId);
    const file = path.join(this.sessionsDir, `${sessionId}.json`);
    const temp = `${file}.${randomUUID()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(messages), { mode: 0o600 });
    fs.renameSync(temp, file);
  }
}
