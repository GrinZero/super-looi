import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { contentText } from "@earendil-works/pi-ai";
import { SessionManager, type FileEntry, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { int, obj, oneOf, opt, str } from "@earendil-works/pi-schema";

const params = obj({
  action: oneOf(["list", "search", "read"]),
  sessionId: opt(str({ description: "Required for read; optionally restrict search to one session." })),
  query: opt(str({ description: "Required for search. Case-insensitive literal text, including tool arguments and results." })),
  cursor: opt(int({ minimum: 0, description: "Continue with the returned nextCursor. For read, a search hit's readCursor jumps to that message." })),
  limit: opt(int({ minimum: 1, maximum: 50, description: "Maximum list/search results; defaults to 20. Read returns up to 12000 characters per call." })),
});

function messageText(message: AgentMessage): string {
  switch (message.role) {
    case "assistant":
      return [
        ...message.content.flatMap(part => part.type === "text" ? [part.text]
          : part.type === "toolCall" ? [`Tool call ${part.name} (${part.id}): ${JSON.stringify(part.arguments)}`] : []),
        ...(message.errorMessage ? [`Error (${message.stopReason}): ${message.errorMessage}`] : []),
      ].join("\n");
    case "toolResult":
      return `Tool result ${message.toolName} (${message.toolCallId}), isError=${message.isError}:\n${contentText(message.content)}`;
    case "bashExecution":
      return `$ ${message.command}\n${message.output}\nexitCode=${message.exitCode}, cancelled=${message.cancelled}`;
    case "branchSummary":
    case "compactionSummary":
      return message.summary;
    default:
      return contentText(message.content);
  }
}

function historyEntry(entry: SessionEntry) {
  if (entry.type === "message") {
    return { id: entry.id, timestamp: entry.timestamp, role: entry.message.role, text: messageText(entry.message) };
  }
  if (entry.type === "compaction" || entry.type === "branch_summary") {
    return { id: entry.id, timestamp: entry.timestamp, role: entry.type, text: entry.summary };
  }
  if (entry.type === "custom_message") {
    return { id: entry.id, timestamp: entry.timestamp, role: "custom", text: contentText(entry.content) };
  }
  return undefined;
}

/** Read App-owned Pi logs without opening a writable SessionManager. */
export function createSessionsTool(host: {
  sessionsDirectory: string;
  workspaceRoot: string;
  sessionId: string;
}): AgentTool<typeof params> {
  return {
    name: "sessions",
    label: "Sessions",
    description: "Look up other, previously saved App task conversations when useful. The current session is excluded. List sessions, search literal keywords, or read an active branch in pages, including original messages from before compaction and tool results. Decide when history is relevant; it is not loaded automatically. Use list/search to find a sessionId, then read; follow nextCursor to continue.",
    parameters: params,
    executionMode: "sequential",
    execute: async (_callId, input, signal) => {
      const cursor = input.cursor ?? 0, limit = input.limit ?? 20;
      let stage = "arguments", filePath = host.sessionsDirectory, line: number | undefined;
      try {
        if ((input.action === "read" && !input.sessionId) || (input.action === "search" && !input.query?.trim())) {
          throw Object.assign(new Error(input.action === "read" ? "read requires sessionId" : "search requires a non-empty query"), { code: "INVALID_ARGUMENT" });
        }
        if (input.sessionId === host.sessionId) {
          throw Object.assign(new Error(`sessions browses other conversations; ${input.sessionId} is the current session`), { code: "CURRENT_SESSION" });
        }
        signal?.throwIfAborted();
        stage = "list_directory";
        const files = (await readdir(host.sessionsDirectory)).filter(name => name.endsWith(".jsonl") &&
          (!input.sessionId || name.endsWith(`_${input.sessionId}.jsonl`)));
        const sessions = [];
        for (const file of files) {
          signal?.throwIfAborted();
          filePath = path.join(host.sessionsDirectory, file);
          stage = "read_session";
          line = undefined;
          const raw = await readFile(filePath, "utf8");
          stage = "parse_session";
          const entries: FileEntry[] = [];
          for (const [index, text] of raw.split("\n").entries()) {
            if (!text.trim()) continue;
            line = index + 1;
            entries.push(JSON.parse(text));
          }
          const header = entries[0];
          if (header?.type !== "session") {
            throw Object.assign(new Error("Expected a Pi session header"), { code: "INVALID_SESSION" });
          }
          if (header.id === host.sessionId) continue;
          if (input.sessionId && header.id !== input.sessionId) continue;
          stage = "project_session";
          line = undefined;
          const manager = SessionManager.inMemory(host.workspaceRoot, undefined, entries);
          const branch = manager.getBranch().flatMap(entry => {
            const message = historyEntry(entry);
            return message ? [message] : [];
          });
          let transcript = "";
          const messages = branch.map(message => {
            const readCursor = transcript.length;
            transcript += `[${message.timestamp}] ${message.role} (entryId=${message.id})\n${message.text}\n\n`;
            return { ...message, readCursor };
          });
          sessions.push({
            info: {
              sessionId: header.id, name: manager.getSessionName(), cwd: header.cwd,
              createdAt: header.timestamp, updatedAt: manager.getEntries().at(-1)?.timestamp ?? header.timestamp,
              messageCount: messages.filter(message => message.role !== "compaction" && message.role !== "branch_summary").length,
              firstMessage: messages.find(message => message.role === "user")?.text.slice(0, 240) ?? "",
            },
            messages, transcript,
          });
        }
        sessions.sort((a, b) => b.info.updatedAt.localeCompare(a.info.updatedAt) || a.info.sessionId.localeCompare(b.info.sessionId));
        const page = <T>(items: T[]) => ({
          total: items.length, nextCursor: cursor + limit < items.length ? cursor + limit : null,
          items: items.slice(cursor, cursor + limit),
        });
        let result;
        if (input.action === "list") {
          result = { action: "list", ...page(sessions.map(session => session.info)) };
        } else if (input.action === "search") {
          const query = input.query!.trim().toLowerCase();
          const matches = sessions.flatMap(session => session.messages.flatMap(message => {
            const index = message.text.toLowerCase().indexOf(query);
            return index < 0 ? [] : [{
              sessionId: session.info.sessionId, entryId: message.id, timestamp: message.timestamp,
              role: message.role, readCursor: message.readCursor,
              snippet: message.text.slice(Math.max(0, index - 100), index + query.length + 200),
            }];
          }));
          result = { action: "search", query: input.query, ...page(matches) };
        } else {
          stage = "find_session";
          filePath = host.sessionsDirectory;
          const session = sessions.find(item => item.info.sessionId === input.sessionId);
          if (!session) throw Object.assign(new Error(`Session ${input.sessionId} was not found in ${host.sessionsDirectory}`), { code: "SESSION_NOT_FOUND" });
          const end = Math.min(cursor + 12000, session.transcript.length);
          result = { action: "read", ...session.info, cursor, nextCursor: end < session.transcript.length ? end : null,
            totalCharacters: session.transcript.length, text: session.transcript.slice(cursor, end) };
        }
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      } catch (error) {
        const cause = error as { code?: string; message?: string };
        const failure = { action: input.action, sessionId: input.sessionId, stage, path: filePath, line,
          code: cause.code, reason: cause.message ?? String(error) };
        return { isError: true, content: [{ type: "text", text: JSON.stringify(failure) }], details: failure };
      }
    },
  };
}
