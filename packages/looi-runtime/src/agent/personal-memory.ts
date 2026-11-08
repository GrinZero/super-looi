import fs from "node:fs";
import path from "node:path";
import { createMemoryClaim } from "@super-looi/contracts";
import type { MemoryLedgerService } from "../memory/ledger.js";

export type PersonalMemoryCategory =
  | "item_location"
  | "preference"
  | "todo"
  | "note";

export interface PersonalMemoryEntry {
  id: string;
  fact: string;
  subject?: string;
  location?: string;
  category: PersonalMemoryCategory;
  source: "voice" | "agent" | "user";
  updatedAt: string;
}

export interface PersonalMemoryStoreOptions {
  filePath?: string;
  persistToDisk?: boolean;
  ledger?: MemoryLedgerService;
  seedDefaultsIfEmpty?: boolean;
}

const DEFAULT_MEMORIES: Array<Omit<PersonalMemoryEntry, "id" | "updatedAt">> = [
  {
    subject: "钥匙",
    location: "键盘左侧",
    fact: "钥匙放在键盘左侧",
    category: "item_location",
    source: "user",
  },
  {
    subject: "AirPods 耳机盒",
    location: "显示器右下方",
    fact: "白色 AirPods 耳机盒在显示器右下方",
    category: "item_location",
    source: "user",
  },
  {
    subject: "保温杯",
    location: "书架第二层",
    fact: "黑色保温杯在书架第二层",
    category: "item_location",
    source: "user",
  },
];

export class PersonalMemoryStore {
  private readonly filePath: string;
  private readonly persistToDisk: boolean;
  private readonly ledger?: MemoryLedgerService;
  private entries: PersonalMemoryEntry[] = [];

  constructor(options: PersonalMemoryStoreOptions = {}) {
    this.filePath =
      options.filePath ??
      process.env.PERSONAL_MEMORY_PATH ??
      path.resolve(process.cwd(), "data/personal-memory.json");
    this.persistToDisk =
      options.persistToDisk ??
      Boolean(options.filePath || process.env.PERSONAL_MEMORY_PERSIST !== "0");
    this.ledger = options.ledger;

    this.loadFromDisk(options.seedDefaultsIfEmpty ?? true);
  }

  private loadFromDisk(seedDefaultsIfEmpty: boolean): void {
    if (this.persistToDisk && fs.existsSync(this.filePath)) {
      try {
        const raw = fs.readFileSync(this.filePath, "utf8");
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          this.entries = parsed;
          void this.syncAllToLedger();
          return;
        }
      } catch {
        // Ignore corrupted file and re-initialize
      }
    }

    if (seedDefaultsIfEmpty && this.entries.length === 0) {
      const now = Date.now();
      this.entries = DEFAULT_MEMORIES.map((item, idx) => ({
        ...item,
        id: `mem_seed_${idx + 1}`,
        updatedAt: new Date(now - (idx + 1) * 15 * 60_000).toISOString(),
      }));
      this.saveToDisk();
      void this.syncAllToLedger();
    }
  }

  private saveToDisk(): void {
    if (!this.persistToDisk) return;
    try {
      const dir = path.dirname(this.filePath);
      fs.mkdirSync(dir, { recursive: true });
      const tmpPath = `${this.filePath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(this.entries, null, 2), "utf8");
      fs.renameSync(tmpPath, this.filePath);
    } catch {
      // Non-fatal in read-only environments
    }
  }

  private async syncEntryToLedger(entry: PersonalMemoryEntry): Promise<void> {
    if (!this.ledger) return;
    try {
      await this.ledger.upsertClaim(
        createMemoryClaim({
          claim_id: `claim_${entry.id}`,
          predicate:
            entry.category === "item_location"
              ? "object_last_seen"
              : "personal_note",
          object: {
            target: entry.subject || entry.fact.slice(0, 18),
            location: entry.location || "个人备忘",
            text: entry.fact,
            category: entry.category,
          },
          status: "confirmed",
          source_kind: "authenticated_user_statement",
          evidence_ids: [`ev_${entry.id}`],
          derivation_roots: [`root_${entry.id}`],
          observed_at: entry.updatedAt,
          source_availability: "retained",
        }),
      );
    } catch {
      // Best-effort ledger sync
    }
  }

  private async syncAllToLedger(): Promise<void> {
    for (const entry of this.entries) {
      await this.syncEntryToLedger(entry);
    }
  }

  public async remember(input: {
    fact: string;
    subject?: string;
    location?: string;
    category?: PersonalMemoryCategory;
    source?: "voice" | "agent" | "user";
  }): Promise<PersonalMemoryEntry> {
    const cleanFact = input.fact.trim();
    if (!cleanFact) {
      throw new Error("Memory fact cannot be empty");
    }

    const subject = input.subject?.trim() || inferSubject(cleanFact);
    const location = input.location?.trim() || inferLocation(cleanFact);
    const category: PersonalMemoryCategory =
      input.category ?? (location ? "item_location" : "note");
    const nowIso = new Date().toISOString();

    // Upsert by matching subject for item locations or exact fact match
    const existingIndex = this.entries.findIndex((item) => {
      if (item.fact === cleanFact) return true;
      if (
        subject &&
        item.subject &&
        item.subject.toLowerCase() === subject.toLowerCase()
      ) {
        return true;
      }
      return false;
    });

    let entry: PersonalMemoryEntry;
    if (existingIndex >= 0) {
      const prev = this.entries[existingIndex];
      entry = {
        ...prev,
        fact: cleanFact,
        subject: subject || prev.subject,
        location: location || prev.location,
        category,
        source: input.source ?? "voice",
        updatedAt: nowIso,
      };
      this.entries.splice(existingIndex, 1);
      this.entries.unshift(entry);
    } else {
      entry = {
        id: `mem_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        fact: cleanFact,
        subject,
        location,
        category,
        source: input.source ?? "voice",
        updatedAt: nowIso,
      };
      this.entries.unshift(entry);
    }

    this.saveToDisk();
    await this.syncEntryToLedger(entry);
    return entry;
  }

  public recall(query?: string, limit = 8): PersonalMemoryEntry[] {
    const q = (query ?? "").trim().toLowerCase();
    if (!q) {
      return this.entries.slice(0, limit);
    }

    const tokens = q.split(/[\s,，。？?！!、]+/).filter(Boolean);
    const scored = this.entries
      .map((entry) => {
        const hay =
          `${entry.subject ?? ""} ${entry.location ?? ""} ${entry.fact}`.toLowerCase();
        let score = 0;
        if (hay.includes(q)) score += 10;
        for (const tok of tokens) {
          if (tok && hay.includes(tok)) score += 4;
        }
        for (const ch of q) {
          if (ch.trim() && hay.includes(ch)) score += 1;
        }
        return { entry, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);

    return scored.slice(0, limit).map((x) => x.entry);
  }

  public forget(idOrQuery: string): {
    removedCount: number;
    removed: PersonalMemoryEntry[];
  } {
    const q = idOrQuery.trim().toLowerCase();
    if (!q) return { removedCount: 0, removed: [] };

    const removed: PersonalMemoryEntry[] = [];
    this.entries = this.entries.filter((entry) => {
      const match =
        entry.id.toLowerCase() === q ||
        (entry.subject && entry.subject.toLowerCase().includes(q)) ||
        entry.fact.toLowerCase().includes(q);
      if (match) {
        removed.push(entry);
        return false;
      }
      return true;
    });

    if (removed.length > 0) {
      this.saveToDisk();
    }
    return { removedCount: removed.length, removed };
  }

  public listAll(): PersonalMemoryEntry[] {
    return [...this.entries];
  }

  public buildSystemPromptBlock(maxItems = 12, language: "zh-CN" | "en-US" = "zh-CN"): string {
    const recent = this.entries.slice(0, maxItems);
    if (recent.length === 0) {
      return language === "en-US" ? "No personal memories recorded yet." : "当前暂无已记录的个人记忆。";
    }
    const lines = recent.map((m) => {
      const time = new Date(m.updatedAt).toLocaleTimeString(language, {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
      if (m.subject && m.location) {
        if (language === "en-US") return `- [${m.subject}] Location: ${m.location} (${m.fact}, recorded at ${time})`;
        return `- [${m.subject}] 位置: ${m.location} (${m.fact}，记录于 ${time})`;
      }
      return language === "en-US" ? `- ${m.fact} (recorded at ${time})` : `- ${m.fact} (记录于 ${time})`;
    });
    return lines.join("\n");
  }
}

function inferSubject(fact: string): string | undefined {
  const m = fact.match(
    /^(?:我的|把)?([^在放是，。,\s]{1,12}?)(?:放在|在|放到|置于)/,
  );
  return m?.[1]?.trim();
}

function inferLocation(fact: string): string | undefined {
  const m = fact.match(/(?:放在|在|放到|置于)([^，。,\s]{1,16})/);
  return m?.[1]?.trim();
}
