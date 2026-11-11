import { randomUUID } from "node:crypto";

/** Logical backend context; independent of voice connections and model transport. */
export class VoiceConversationWindow {
  private context?: { id: string; lastActivityAt: number };
  private running = false;

  constructor(
    private readonly idleMs = 15 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  begin(): string {
    this.touch();
    this.context ??= { id: `voice_${randomUUID()}`, lastActivityAt: this.now() };
    this.running = true;
    return this.context.id;
  }

  touch(): void {
    if (!this.context) return;
    const now = this.now();
    if (!this.running && now - this.context.lastActivityAt >= this.idleMs) {
      this.context = undefined;
    } else {
      this.context.lastActivityAt = now;
    }
  }

  finish(): void {
    this.touch();
    this.running = false;
  }
}
