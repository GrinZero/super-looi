import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  ScheduleEngine,
  ScheduleError,
  type NativeSchedulePort,
} from "@super-looi/runtime/schedule";
import { SqliteRuntimeStore } from "@super-looi/runtime/storage";
import type { UserActionRef } from "@super-looi/contracts";
import { openRuntime, type NativeScheduleHost } from "../generated/looi-runtime.js";
import { codexDefinition } from "../plugins/codex/runtime/index.js";
import { DualLoopAiBus } from "../runtime/plugins/ai-bus.js";
import { PluginHost } from "../runtime/plugins/host.js";
import { createScheduleNativePort } from "../runtime/schedule-native-adapter.js";
import {
  clearGitHubToken,
  createGitHubPrStatusTool,
  createScheduleTools,
  githubCredentialStatus,
  saveGitHubToken,
  verifyGitHubToken,
} from "../runtime/tools/index.js";
import { createOpenAiRealtimeProtocol } from "@super-looi/runtime/voice";
import { VoiceRuntime, type VoiceAudioPort, type VoiceSocket } from "../runtime/voice.js";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForCondition(check: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await wait(15);
  }
  throw new Error("Timed out waiting for condition");
}

function makeUiAction(
  uiSessionId: string,
  kind: UserActionRef["kind"] = "tap",
): UserActionRef {
  const now = Date.now();
  return {
    event_id: `evt_${randomUUID()}`,
    ui_session_id: uiSessionId,
    kind,
    captured_at: new Date(now).toISOString(),
    expires_at: new Date(now + 60_000).toISOString(),
  };
}

function createMemoryVault(initial: Record<string, string> = {}) {
  const slots = new Map<string, string>(Object.entries(initial));
  return {
    slots,
    get: (key: string) => slots.get(key) ?? "",
    set: (key: string, value: string) => {
      slots.set(key, value);
    },
    remove: (key: string) => {
      slots.delete(key);
    },
  };
}

function createNodeCompatHost(tempRoot: string) {
  const databases = new Map<number, DatabaseSync>();
  let nextDbId = 1;
  let nextWatchId = 1;

  const resolveVirtualPath = (rawPath: string): string => {
    const cleaned = rawPath.replace(/^~(?=\/|$)/, "/home");
    const rel = cleaned.replace(/^\/+/, "");
    const resolved = path.resolve(tempRoot, rel);
    const rootResolved = path.resolve(tempRoot);
    if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
      throw new Error(`Path escapes test sandbox: ${rawPath}`);
    }
    return resolved;
  };

  const toStatJson = (stats: fs.Stats) => ({
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    directory: stats.isDirectory(),
    file: stats.isFile(),
    symlink: stats.isSymbolicLink(),
  });

  const handleOp = (payload: Record<string, unknown>): unknown => {
    const op = String(payload.op ?? "");
    switch (op) {
      case "uuid":
        return randomUUID();
      case "sqlite.open": {
        const raw = String(payload.path ?? "");
        const dbPath =
          raw === ":memory:"
            ? ":memory:"
            : (() => {
                const resolved = resolveVirtualPath(raw);
                fs.mkdirSync(path.dirname(resolved), { recursive: true });
                return resolved;
              })();
        const id = nextDbId++;
        databases.set(
          id,
          new DatabaseSync(dbPath, {
            timeout: typeof payload.timeout === "number" ? payload.timeout : undefined,
          }),
        );
        return id;
      }
      case "sqlite.exec": {
        const db = databases.get(Number(payload.id));
        if (!db) throw new Error("SQLite database not open");
        db.exec(String(payload.sql ?? ""));
        return null;
      }
      case "sqlite.run": {
        const db = databases.get(Number(payload.id));
        if (!db) throw new Error("SQLite database not open");
        const args = (Array.isArray(payload.args) ? payload.args : []) as any[];
        const res = db.prepare(String(payload.sql ?? "")).run(...args);
        return { changes: Number(res.changes), lastInsertRowid: Number(res.lastInsertRowid) };
      }
      case "sqlite.get": {
        const db = databases.get(Number(payload.id));
        if (!db) throw new Error("SQLite database not open");
        const args = (Array.isArray(payload.args) ? payload.args : []) as any[];
        return db.prepare(String(payload.sql ?? "")).get(...args) ?? null;
      }
      case "sqlite.all": {
        const db = databases.get(Number(payload.id));
        if (!db) throw new Error("SQLite database not open");
        const args = (Array.isArray(payload.args) ? payload.args : []) as any[];
        return db.prepare(String(payload.sql ?? "")).all(...args);
      }
      case "sqlite.close": {
        const id = Number(payload.id);
        const db = databases.get(id);
        if (db) {
          db.close();
          databases.delete(id);
        }
        return null;
      }
      case "fs.read": {
        const target = resolveVirtualPath(String(payload.path ?? ""));
        return Array.from(fs.readFileSync(target));
      }
      case "fs.write": {
        const target = resolveVirtualPath(String(payload.path ?? ""));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, Uint8Array.from((payload.data as number[]) ?? []));
        return null;
      }
      case "fs.append": {
        const target = resolveVirtualPath(String(payload.path ?? ""));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.appendFileSync(target, Uint8Array.from((payload.data as number[]) ?? []));
        return null;
      }
      case "fs.stat":
        return toStatJson(fs.statSync(resolveVirtualPath(String(payload.path ?? ""))));
      case "fs.lstat":
        return toStatJson(fs.lstatSync(resolveVirtualPath(String(payload.path ?? ""))));
      case "fs.utimes":
        fs.utimesSync(
          resolveVirtualPath(String(payload.path ?? "")),
          Number(payload.atime ?? 0),
          Number(payload.mtime ?? 0),
        );
        return null;
      case "fs.mkdir":
        fs.mkdirSync(resolveVirtualPath(String(payload.path ?? "")), {
          recursive: Boolean(payload.recursive),
        });
        return null;
      case "fs.readdir":
        return fs
          .readdirSync(resolveVirtualPath(String(payload.path ?? "")), { withFileTypes: true })
          .map((entry) => ({
            name: entry.name,
            directory: entry.isDirectory(),
            file: entry.isFile(),
            symlink: entry.isSymbolicLink(),
          }));
      case "fs.rm":
        fs.rmSync(resolveVirtualPath(String(payload.path ?? "")), {
          recursive: Boolean(payload.recursive),
          force: Boolean(payload.force),
        });
        return null;
      case "fs.rename":
        fs.renameSync(
          resolveVirtualPath(String(payload.path ?? "")),
          resolveVirtualPath(String(payload.dest ?? "")),
        );
        return null;
      case "fs.copy":
        fs.copyFileSync(
          resolveVirtualPath(String(payload.path ?? "")),
          resolveVirtualPath(String(payload.dest ?? "")),
        );
        return null;
      case "fs.realpath":
        return fs.realpathSync(resolveVirtualPath(String(payload.path ?? "")));
      case "fs.open": {
        const target = resolveVirtualPath(String(payload.path ?? ""));
        return fs.openSync(target, String(payload.flags ?? "r") as fs.OpenMode);
      }
      case "fs.readfd": {
        const length = Number(payload.length ?? 0);
        const buf = Buffer.alloc(Math.max(0, length));
        const read = fs.readSync(
          Number(payload.fd),
          buf,
          0,
          buf.length,
          typeof payload.offset === "number" ? payload.offset : null,
        );
        return Array.from(buf.subarray(0, read));
      }
      case "fs.writefd":
        fs.writeSync(Number(payload.fd), Uint8Array.from((payload.data as number[]) ?? []));
        return null;
      case "fs.fstat":
        return toStatJson(fs.fstatSync(Number(payload.fd)));
      case "fs.close":
        fs.closeSync(Number(payload.fd));
        return null;
      case "fs.watch":
        return nextWatchId++;
      case "fs.watch.close":
      case "fs.watch.drain":
        return [];
      case "shell.create":
        return `shell_${randomUUID()}`;
      case "shell.drain":
      case "shell.cancel":
        return [];
      default:
        throw new Error(`Unsupported test compat op: ${op}`);
    }
  };

  return {
    request(raw: string): string {
      try {
        const payload = JSON.parse(raw) as Record<string, unknown>;
        return JSON.stringify({ value: handleOp(payload) });
      } catch (error) {
        const errObj = error as { code?: string; message?: string };
        const prefix = errObj?.code ? `${errObj.code}: ` : "";
        return JSON.stringify({
          error: `${prefix}${errObj?.message ?? String(error)}`,
        });
      }
    },
    begin: (_kind: string, raw: string) => raw,
    wait: async () =>
      JSON.stringify({
        value: {
          status: 0,
          stdout: "https://github.com/acme/app/pull/88\n",
          stderr: "",
        },
      }),
    close: () => {
      for (const db of databases.values()) {
        try {
          db.close();
        } catch {
          // Ignore close cleanup errors
        }
      }
      databases.clear();
    },
  };
}

function createFakeNativeScheduleHost() {
  const syncedAlarms: Array<Array<{ ruleId: string; title: string; body: string; triggerAtMs: number; silent: boolean }>> = [];
  const cancelledAlarms: string[] = [];
  const quietSnapshots: Array<{ quietHoursEnabled: boolean; windows: Array<Record<string, unknown>> }> = [];
  const postedNotifications: Array<{ id?: string; ruleId?: string; runId?: string; sessionId?: string; title: string; body?: string; silent?: boolean }> = [];
  const keepAliveHistory: Array<{ active: boolean; hasRunningCheck: boolean; nextTriggerAtMs: number | null | undefined }> = [];
  const pendingEvents: Array<{
    kind: string;
    ruleId: string;
    notificationId: string;
    handle: string;
    payloadJson: string;
    occurredAtMs: number;
  }> = [];
  let foreground = true;

  const host: NativeScheduleHost = {
    permissionStatus: () => "granted",
    requestPermission: async () => "granted",
    exactAlarmStatus: () => ({
      mode: "exact",
      degraded: false,
      canOpenSettings: true,
      reason: "EXACT_ALARM_ALLOWED",
    }),
    openExactAlarmSettings: () => true,
    syncUpcomingAlarms: (alarmsJson) => {
      const parsed = JSON.parse(alarmsJson) as typeof syncedAlarms[number];
      syncedAlarms.push(parsed);
      return {
        syncedCount: parsed.length,
        cancelledCount: 0,
        exactAlarmDegraded: false,
        exactAlarmMode: "exact",
      };
    },
    cancelAlarm: (ruleId) => {
      cancelledAlarms.push(ruleId);
      return true;
    },
    syncQuietHours: (quietSnapshotJson) => {
      quietSnapshots.push(JSON.parse(quietSnapshotJson));
    },
    postNotification: (payloadJson) => {
      const payload = JSON.parse(payloadJson) as typeof postedNotifications[number];
      postedNotifications.push(payload);
      return `looi.sched.post.${payload.id ?? "1"}`;
    },
    setAndroidKeepAlive: (active, hasRunningCheck, nextTriggerAtMs) => {
      keepAliveHistory.push({ active, hasRunningCheck, nextTriggerAtMs });
      return {
        active,
        hasRunningCheck,
        quotaExhausted: false,
        dailyUsedMs: 0,
        dailyCapMs: 18_000_000,
        sessionUsedMs: 0,
        sessionCapMs: 3_600_000,
        reason: "ok",
      };
    },
    beginIosBackgroundGrace: (label) => `ios_grace_${label}`,
    endIosBackgroundGrace: () => {},
    drainEvents: () => pendingEvents.splice(0, pendingEvents.length),
    setForeground: (active) => {
      foreground = active;
    },
  };

  return {
    host,
    syncedAlarms,
    cancelledAlarms,
    quietSnapshots,
    postedNotifications,
    keepAliveHistory,
    pushEvent: (ev: typeof pendingEvents[number]) => pendingEvents.push(ev),
    getForeground: () => foreground,
  };
}

function buildOpenAiSseResponse(
  turn:
    | { type: "text"; text: string }
    | { type: "tool_calls"; calls: Array<{ id: string; name: string; arguments: string }> },
): Response {
  const chunks: string[] = [];
  const pushChunk = (delta: Record<string, unknown>, finishReason: string | null) => {
    chunks.push(
      `data: ${JSON.stringify({
        id: "chatcmpl_mock",
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: "mock-gpt",
        choices: [{ index: 0, delta, finish_reason: finishReason }],
        ...(finishReason
          ? {
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            }
          : {}),
      })}\n\n`,
    );
  };

  pushChunk({ role: "assistant" }, null);
  if (turn.type === "tool_calls") {
    for (let i = 0; i < turn.calls.length; i++) {
      const call = turn.calls[i]!;
      pushChunk(
        {
          tool_calls: [
            {
              index: i,
              id: call.id,
              type: "function",
              function: { name: call.name, arguments: call.arguments },
            },
          ],
        },
        null,
      );
    }
    pushChunk({}, "tool_calls");
  } else {
    pushChunk({ content: turn.text }, null);
    pushChunk({}, "stop");
  }
  chunks.push("data: [DONE]\n\n");

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(chunks.join("")));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

test("github_pr_status handles public/private repos, rate-limit/auth/network errors, verifyGitHubToken, and secret redaction", async () => {
  const vault = createMemoryVault();
  const requests: Array<{ url: string; auth: string | null }> = [];
  const secretToken = "github_pat_11ABCDEFSECRETTOKEN999";

  const mockFetcher: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers);
    const auth = headers.get("Authorization");
    requests.push({ url, auth });

    if (url.endsWith("/rate_limit")) {
      if (auth === `Bearer ${secretToken}`) {
        return new Response(
          JSON.stringify({ rate: { limit: 5000, remaining: 4998, reset: 1800000000 } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 });
    }

    if (url.includes("/repos/pub/app/pulls/10/reviews")) {
      return new Response(
        JSON.stringify([{ state: "APPROVED", user: { login: "alice" } }]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.includes("/repos/pub/app/pulls/10")) {
      return new Response(
        JSON.stringify({
          number: 10,
          title: "Add schedule",
          state: "open",
          draft: false,
          merged: false,
          mergeable_state: "clean",
          html_url: "https://github.com/pub/app/pull/10",
          head: { sha: "abc123", ref: "feat/sched" },
          base: { ref: "main" },
          updated_at: "2026-11-22T12:00:00Z",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.includes("/repos/pub/app/commits/abc123/check-runs")) {
      return new Response(
        JSON.stringify({
          total_count: 1,
          check_runs: [{ name: "ci/test", status: "completed", conclusion: "success" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.includes("/repos/pub/app/commits/abc123/status")) {
      return new Response(
        JSON.stringify({ state: "success", total_count: 1, statuses: [] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (url.includes("/repos/priv/secret/")) {
      if (auth !== `Bearer ${secretToken}`) {
        return new Response(
          JSON.stringify({ message: `Unauthorized with Bearer ${secretToken}` }),
          { status: 401 },
        );
      }
      if (url.endsWith("/pulls/7")) {
        return new Response(
          JSON.stringify({
            number: 7,
            title: "Private PR",
            state: "open",
            draft: false,
            merged: false,
            mergeable_state: "blocked",
            head: { sha: "def456", ref: "fix/auth" },
            base: { ref: "main" },
          }),
          { status: 200 },
        );
      }
      if (url.includes("/check-runs")) {
        return new Response(
          JSON.stringify({
            total_count: 1,
            check_runs: [{ name: "build", status: "completed", conclusion: "failure" }],
          }),
          { status: 200 },
        );
      }
      if (url.includes("/status")) {
        return new Response(JSON.stringify({ state: "failure", total_count: 0, statuses: [] }), { status: 200 });
      }
      if (url.includes("/reviews")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
    }

    if (url.includes("/repos/rate/limit/pulls/1")) {
      return new Response(
        JSON.stringify({ message: "API rate limit exceeded" }),
        {
          status: 429,
          headers: { "x-ratelimit-remaining": "0", "retry-after": "60" },
        },
      );
    }

    if (url.includes("/repos/net/fail/pulls/1")) {
      throw Object.assign(new Error(`connect ECONNREFUSED using Bearer ${secretToken}`), {
        code: "ECONNREFUSED",
      });
    }

    return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
  };

  const tool = createGitHubPrStatusTool({ vault, fetcher: mockFetcher });

  // 1. Public anonymous read-only GET (no PAT saved)
  const pubRes = await tool.execute("c1", { owner: "pub", repo: "app", pullNumber: 10 }, new AbortController().signal);
  assert.equal((pubRes as any).isError, undefined);
  assert.equal((pubRes.details as any).pr.number, 10);
  assert.equal((pubRes.details as any).checks.overall, "passed");
  assert.equal((pubRes.details as any).reviews.approved, 1);
  assert.ok(requests.every((r) => r.auth === null));

  // 2. Reject invalid input segments
  const badSeg = await tool.execute("c2", { owner: "bad/owner", repo: "app", pullNumber: 1 }, new AbortController().signal);
  assert.equal((badSeg as any).isError, true);
  assert.equal((badSeg.details as any).failure.code, "ERR_INVALID_ARGUMENT");

  // 3. Save token -> never returns plaintext, verifies via /rate_limit
  const saved = saveGitHubToken(vault, secretToken);
  assert.equal(saved.configured, true);
  assert.ok(!saved.tokenHint?.includes(secretToken));
  assert.equal(githubCredentialStatus(vault).configured, true);

  const verified = await verifyGitHubToken(vault, { fetcher: mockFetcher });
  assert.equal(verified.valid, true);
  assert.equal(verified.rateLimit?.limit, 5000);

  // 4. Private PR succeeds with Bearer token
  const privRes = await tool.execute("c3", { owner: "priv", repo: "secret", pullNumber: 7 }, new AbortController().signal);
  assert.equal((privRes as any).isError, undefined);
  assert.equal((privRes.details as any).checks.overall, "failed");
  assert.equal((privRes.details as any).checks.checkRuns.failed, 1);
  assert.ok(requests.some((r) => r.url.includes("/priv/secret/") && r.auth === `Bearer ${secretToken}`));

  // 5. 429 rate limit preserves status code without fake timeout
  const rateRes = await tool.execute("c4", { owner: "rate", repo: "limit", pullNumber: 1 }, new AbortController().signal);
  assert.equal((rateRes as any).isError, true);
  assert.equal((rateRes.details as any).failure.code, 429);
  assert.doesNotMatch((rateRes.details as any).failure.reason, /timeout/i);

  // 6. Network failure preserves ECONNREFUSED and redacts token/Bearer
  const netRes = await tool.execute("c5", { owner: "net", repo: "fail", pullNumber: 1 }, new AbortController().signal);
  assert.equal((netRes as any).isError, true);
  assert.equal((netRes.details as any).failure.code, "ECONNREFUSED");
  assert.ok(!(netRes.details as any).failure.reason.includes(secretToken));

  // 7. 401 when wrong token stored also redacts secret from error message
  saveGitHubToken(vault, "wrong_pat_value_9999");
  const unauthVerify = await verifyGitHubToken(vault, { fetcher: mockFetcher });
  assert.equal(unauthVerify.valid, false);
  assert.equal(unauthVerify.failure?.code, 401);

  // 8. Bare hosts without globalThis.fetch must not throw during tool creation and report structured unavailability at call time
  const originalGlobalFetch = globalThis.fetch;
  delete (globalThis as { fetch?: typeof fetch }).fetch;
  try {
    const bareTool = createGitHubPrStatusTool({ vault });
    const bareRes = await bareTool.execute("c6", { owner: "pub", repo: "app", pullNumber: 1 }, new AbortController().signal);
    assert.equal((bareRes as any).isError, true);
    assert.equal((bareRes.details as any).failure.stage, "github.pr_status.fetch");
    assert.equal((bareRes.details as any).failure.code, "ERR_GITHUB_FETCH_UNAVAILABLE");

    const bareVerify = await verifyGitHubToken(vault);
    assert.equal(bareVerify.valid, false);
    assert.equal(bareVerify.failure?.stage, "github.token.verify");
    assert.equal(bareVerify.failure?.code, "ERR_GITHUB_FETCH_UNAVAILABLE");
  } finally {
    globalThis.fetch = originalGlobalFetch;
  }

  assert.equal(clearGitHubToken(vault).configured, false);
});

test("Codex plugin exposes codex_cloud_status in normal & check_only modes and enforces ERR_CODEX_CHECK_ONLY_DENIED", async (t) => {
  const tempCodexRoot = fs.mkdtempSync(path.join(os.tmpdir(), "looi-codex-test-"));
  t.after(() => {
    fs.rmSync(tempCodexRoot, { recursive: true, force: true });
  });

  const db = new DatabaseSync(":memory:");
  let lastCmdArgs: string[] = [];
  let cliMode: "ok" | "unauth" | "http404" = "ok";

  const codexDef = codexDefinition({
    directory: path.join(tempCodexRoot, "plugins", "codex"),
    runner: {
      run: (req) => {
        const id = randomUUID();
        if (req.args.includes("--version")) {
          return {
            id,
            cancel: () => {},
            promise: Promise.resolve({
              id,
              stage: req.stage,
              args: req.args,
              state: "exited",
              exitCode: 0,
              stdout: "codex-cli 0.2.0\n",
              stderr: "",
            }),
          };
        }
        if (req.operation === "read_credentials" || (req.args[0] === "login" && req.args[1] === "status")) {
          if (cliMode === "unauth") {
            return {
              id,
              cancel: () => {},
              promise: Promise.resolve({
                id,
                stage: req.stage,
                args: req.args,
                state: "execution_failed",
                exitCode: 1,
                stdout: "",
                stderr: "Not logged in",
                failure: { stage: req.stage, code: 1, reason: "Not logged in" },
              }),
            };
          }
          return {
            id,
            cancel: () => {},
            promise: Promise.resolve({
              id,
              stage: req.stage,
              args: req.args,
              state: "exited",
              exitCode: 0,
              stdout: "Logged in using ChatGPT\n",
              stderr: "",
            }),
          };
        }
        lastCmdArgs = [...req.args];
        if (cliMode === "http404") {
          return {
            id,
            cancel: () => {},
            promise: Promise.resolve({
              id,
              stage: req.stage,
              args: req.args,
              state: "execution_failed",
              exitCode: 1,
              stdout: "",
              stderr: "GET https://chatgpt.com/backend-api/wham/tasks/task_x failed: HTTP 404 Not Found",
              failure: {
                stage: req.stage,
                code: 1,
                reason: "GET https://chatgpt.com/backend-api/wham/tasks/task_x failed: HTTP 404 Not Found",
              },
            }),
          };
        }
        return {
          id,
          cancel: () => {},
          promise: Promise.resolve({
            id,
            stage: req.stage,
            args: req.args,
            state: "exited",
            exitCode: 0,
            stdout: `Task ${req.args.at(-1)}: completed (2 files changed)\n`,
            stderr: "",
          }),
        };
      },
      stop: async () => {},
    },
  });

  const host = new PluginHost(db, [codexDef], {});
  await host.startStartupPlugins();
  await host.setEnabled("codex", true);

  try {
    // 1. Normal mode: all 3 tools registered
    const normalContrib = host.contribution({
      taskId: "t_norm",
      workspaceRoot: "/workspace",
      approvalMode: "ask",
      commandTimeoutMs: 5000,
    });
    assert.deepEqual(
      normalContrib.tools.map((t) => t.name).sort(),
      ["codex_cloud", "codex_cloud_status", "codex_exec"],
    );

    // 2. check_only mode: ONLY codex_cloud_status registered
    const checkOnlyContrib = host.contribution({
      taskId: "t_check",
      workspaceRoot: "/workspace",
      approvalMode: "ask",
      commandTimeoutMs: 5000,
      scheduleExecutionPolicy: "check_only",
    });
    assert.deepEqual(
      checkOnlyContrib.tools.map((t) => t.name),
      ["codex_cloud_status"],
    );

    // 3. Execute codex_cloud_status with valid & invalid taskId
    const statusTool = checkOnlyContrib.tools[0]!;
    const okRes = await statusTool.execute(
      "call_1",
      { taskId: "task_cloud_1234" },
      new AbortController().signal,
    );
    assert.equal(Boolean((okRes as any).isError), false, JSON.stringify(okRes));
    assert.deepEqual(lastCmdArgs, ["cloud", "status", "--", "task_cloud_1234"]);
    assert.match((okRes.content[0] as { text: string }).text, /completed/);

    // Invalid taskId (non-matching characters) rejected cleanly
    const badRes = await statusTool.execute(
      "call_2",
      { taskId: "bad/task id" },
      new AbortController().signal,
    );
    assert.equal((badRes as any).isError, true);
    assert.equal((badRes.details as any).failure.code, "ERR_INVALID_ARGUMENT");

    // HTTP 404 failure preserves exact status code in details.failure
    cliMode = "http404";
    const err404Res = await statusTool.execute(
      "call_3",
      { taskId: "task_cloud_9999" },
      new AbortController().signal,
    );
    assert.equal((err404Res as any).isError, true);
    assert.equal((err404Res.details as any).failure.code, 404);
    cliMode = "ok";

    // Unauthenticated status failure returns structured details.failure
    cliMode = "unauth";
    await host.get("codex").auth?.refresh().catch(() => {});
    const unauthRes = await statusTool.execute(
      "call_4",
      { taskId: "task_cloud_9999" },
      new AbortController().signal,
    );
    assert.equal((unauthRes as any).isError, true);
    assert.equal((unauthRes.details as any).failure.stage, "codex.account");
    assert.ok((unauthRes.details as any).failure.code);

    // 4. DualLoopAiBus guards: check_only allows codex_cloud_status without ask, denies codex_exec/codex_cloud
    // Use host.ai directly since PluginHost creates its own DualLoopAiBus instance
    const statusGuard = await host.ai.evaluateToolCall({
      channel: "task",
      toolName: "codex_cloud_status",
      approvalMode: "ask",
      arguments: { taskId: "task_cloud_1234" },
      scheduleExecutionPolicy: "check_only",
    });
    assert.equal(statusGuard?.decision, "allow");

    for (const mutatingTool of ["codex_exec", "codex_cloud"]) {
      const denied = await host.ai.evaluateToolCall({
        channel: "task",
        toolName: mutatingTool,
        approvalMode: "ask",
        arguments: { prompt: "mutate" },
        scheduleExecutionPolicy: "check_only",
      });
      assert.equal(denied?.decision, "deny");
      assert.equal(denied?.stage, "codex.policy");
      assert.equal(denied?.code, "ERR_CODEX_CHECK_ONLY_DENIED");
    }
    void DualLoopAiBus;
  } finally {
    await host.close();
    db.close();
  }
});

test("Pi schedule tools auto-bind session/task and enforce check_only restrictions", async () => {
  const db = new DatabaseSync(":memory:");
  const store = new SqliteRuntimeStore(db);
  const engine = new ScheduleEngine({
    store,
    getExecutor: () => undefined,
  });

  try {
    let mutated = 0;
    const interactiveTools = createScheduleTools({
      engine,
      sourceSessionId: "sess_fg_1",
      sourceTaskId: "task_fg_1",
      checkOnly: false,
      onMutated: () => {
        mutated++;
      },
    });
    assert.deepEqual(
      interactiveTools.map((t) => t.name),
      ["manage_schedule", "manage_quiet_hours"],
    );

    const manageSchedule = interactiveTools[0]!;
    const createRes = await manageSchedule.execute(
      "call_create",
      {
        action: "create",
        title: "Watch PR",
        prompt: "Check PR #12",
        origin: "agent_inferred",
        executionPolicy: "check_only",
        triggerKind: "interval",
        everySeconds: 120,
      },
      new AbortController().signal,
    );
    assert.equal((createRes as any).isError, undefined);
    assert.equal((createRes.details as any).rule.sourceSessionId, "sess_fg_1");
    assert.equal((createRes.details as any).rule.sourceTaskId, "task_fg_1");
    assert.equal(mutated, 1);

    const checkOnlyTools = createScheduleTools({
      engine,
      sourceSessionId: "sess_sched_1",
      sourceTaskId: "task_sched_1",
      checkOnly: true,
    });
    assert.deepEqual(
      checkOnlyTools.map((t) => t.name),
      ["manage_schedule"],
    );
    const listOnly = await checkOnlyTools[0]!.execute(
      "call_list",
      { action: "list" },
      new AbortController().signal,
    );
    assert.equal((listOnly.details as any).count, 1);

    const deniedCreate = await checkOnlyTools[0]!.execute(
      "call_create_denied",
      {
        action: "create",
        title: "No",
        prompt: "No",
        triggerKind: "interval",
        everySeconds: 120,
      },
      new AbortController().signal,
    );
    assert.equal((deniedCreate as any).isError, true);
    assert.equal((deniedCreate.details as any).failure.code, "ERR_SCHEDULE_CHECK_ONLY_TOOL_DENIED");
    assert.ok(ScheduleError);
  } finally {
    await engine.close();
    store.close();
  }
});

test("VoiceRuntime enforces real-time 3-point quiet-hours suppression across 22:59 -> 23:00 boundary", async () => {
  class QuietTestSocket implements VoiceSocket {
    writes: any[] = [];
    private reader?: (val: string | null) => void;
    private queue: Array<string | null> = [];
    read(): Promise<string | null> {
      return this.queue.length
        ? Promise.resolve(this.queue.shift()!)
        : new Promise((resolve) => {
            this.reader = resolve;
          });
    }
    async write(raw: string | Uint8Array) {
      if (typeof raw === "string") this.writes.push(JSON.parse(raw));
    }
    async close() {
      this.push(null);
    }
    push(val: unknown) {
      const encoded = val === null ? null : JSON.stringify(val);
      if (this.reader) {
        const r = this.reader;
        this.reader = undefined;
        r(encoded);
      } else {
        this.queue.push(encoded);
      }
    }
  }

  const db = new DatabaseSync(":memory:");
  const store = new SqliteRuntimeStore(db);
  const nowRef = { value: new Date(2026, 10, 22, 22, 59, 0) }; // 22:59 local
  const engine = new ScheduleEngine({
    store,
    now: () => nowRef.value,
    getExecutor: () => undefined,
  });
  engine.addQuietHoursWindow({
    id: "night",
    startMinute: 23 * 60,
    endMinute: 8 * 60,
    enabled: true,
  });
  engine.setQuietHoursEnabled(true);

  const vault = createMemoryVault({
    model: JSON.stringify({ credentials: { openai: { type: "api_key", key: "k" } } }),
    voice: JSON.stringify({ providerId: "openai", wakeEnabled: false }),
  });

  let clearCount = 0;
  const audio: VoiceAudioPort = {
    requestPermission: () => "granted",
    start: () => {},
    beginWake: () => 0,
    startWake: async () => true,
    stop: () => {},
    enqueue: () => {},
    clearPlayback: () => {
      clearCount++;
    },
    setMuted: () => {},
    setCaptureMode: () => {},
    playReadyCue: () => {},
    drainCapture: () => [],
    status: () => ({
      state: "running",
      permission: "granted",
      error: "",
      queuedPlaybackMs: 0,
      captureMode: "conversation",
      wakeWord: "",
      kwsReady: true,
    }),
  };

  const sockets: QuietTestSocket[] = [];
  const voice = new VoiceRuntime({
    vault,
    audio,
    protocol: createOpenAiRealtimeProtocol({ model: "gpt-realtime" }),
    connect: async () => {
      const sock = new QuietTestSocket();
      sockets.push(sock);
      return sock;
    },
    onState: () => {},
    requestTask: async () => "ok",
    schedule: () => engine,
    isQuietHoursNow: () => engine.isQuietHoursNow(),
  });

  try {
    // --- Point 1: VoiceRuntime.speak() suppresses BEFORE starting session when already 23:00 ---
    nowRef.value = new Date(2026, 10, 22, 23, 0, 0);
    assert.equal(engine.isQuietHoursNow(), true);
    const point1 = await voice.speak({
      spokenText: "PR #101 构建成功",
      contextNote: "定时检查结果: PR #101 CI 已全部通过",
      respectQuietHours: true,
    });
    assert.deepEqual(point1, {
      completed: false,
      interruptedReason: "quiet_hours_suppressed",
    });
    assert.equal(sockets.length, 0, "Point 1 must suppress before opening a session");

    // Verify suppressed contextNote from Point 1 reaches subsequent voice session handshake
    nowRef.value = new Date(2026, 10, 22, 22, 59, 0);
    await voice.start();
    await waitForCondition(() => sockets.length === 1);
    const sockAfterPoint1 = sockets[0]!;
    assert.match(
      String(sockAfterPoint1.writes[0]?.session?.instructions ?? ""),
      /PR #101 CI 已全部通过/,
    );
    sockAfterPoint1.push({ type: "session.created" });
    sockAfterPoint1.push({ type: "session.updated", session: { id: "s0" } });
    await wait(15);
    voice.endSession();
    await wait(15);

    // --- Point 2: speak() initiated at 22:59, flips to 23:00 before session.updated flush ---
    nowRef.value = new Date(2026, 10, 22, 22, 59, 30);
    assert.equal(engine.isQuietHoursNow(), false);
    const point2Promise = voice.speak({
      spokenText: "Codex 云端任务完成",
      contextNote: "定时检查结果: Codex 云端任务已完成",
      delivery: "when_idle",
      respectQuietHours: true,
    });
    await waitForCondition(() => sockets.length === 2);
    const sock = sockets[1]!;

    // Test Fix #4: quiet-suppressed notice arriving AFTER handshake while phase === "connecting"
    nowRef.value = new Date(2026, 10, 22, 23, 0, 0);
    const duringConnectPromise = voice.speak({
      spokenText: "连接期静默提醒",
      contextNote: "定时检查结果: 连接中静默更新",
      delivery: "when_idle",
      respectQuietHours: true,
    });
    assert.equal(sock.writes.length, 1);

    // Emit session_ready -> pendingNotices flush AND pendingInstructionSync must sync "连接中静默更新"
    sock.push({ type: "session.created" });
    sock.push({ type: "session.updated", session: { id: "s1" } });
    const [point2, duringConnect] = await Promise.all([point2Promise, duringConnectPromise]);
    assert.deepEqual(point2, {
      completed: false,
      interruptedReason: "quiet_hours_suppressed",
    });
    assert.deepEqual(duringConnect, {
      completed: false,
      interruptedReason: "quiet_hours_suppressed",
    });
    assert.ok(
      !sock.writes.some(
        (frame) =>
          frame.type === "conversation.item.create" &&
          (JSON.stringify(frame).includes("Codex 云端任务完成") ||
            JSON.stringify(frame).includes("连接期静默提醒")),
      ),
      "Point 2 must not encode suppressed speech over socket",
    );
    await waitForCondition(() =>
      sock.writes.some(
        (frame, index) =>
          index > 0 &&
          frame.type === "session.update" &&
          String(frame.session?.instructions ?? "").includes("连接中静默更新"),
      ),
    );

    // --- Point 3: Enqueued while idle check is blocked at 22:59 during active turn; flips to 23:00 before flushNoticeIfIdle ---
    nowRef.value = new Date(2026, 10, 22, 22, 59, 45);
    // Re-enter active turn
    sock.push({ type: "response.created", response: { id: "resp_busy" } });
    await wait(15);

    const point3Results: Array<{ completed: boolean; interruptedReason?: string }> = [];
    voice.enqueueNotice({
      id: "notice_point_3",
      spokenText: "第三次后台复查完成",
      contextNote: "定时检查结果: 第三次复查有新评论",
      delivery: "when_idle",
      respectQuietHours: true,
      onResult: (res) => point3Results.push(res),
    });

    // Advance into quiet hours BEFORE response.done triggers flushNoticeIfIdle()
    nowRef.value = new Date(2026, 10, 22, 23, 0, 5);
    const clearBeforePoint3 = clearCount;
    sock.push({ type: "response.done", response: { id: "resp_busy", status: "completed" } });
    await waitForCondition(() => point3Results.length === 1);
    assert.deepEqual(point3Results[0], {
      completed: false,
      interruptedReason: "quiet_hours_suppressed",
    });
    assert.ok(clearCount > clearBeforePoint3, "Point 3 must clear playback cleanly");
    assert.ok(
      !sock.writes.some((frame) => JSON.stringify(frame).includes("第三次后台复查完成")),
      "Point 3 must suppress before encodeProactiveSpeech",
    );
    assert.ok(
      sock.writes.some(
        (frame) =>
          frame.type === "session.update" &&
          String(frame.session?.instructions ?? "").includes("第三次复查有新评论"),
      ),
      "Point 3 must update contextNote for later voice conversation",
    );

    // Notices without respectQuietHours: true still speak even during quiet hours
    const unthrottledResults: Array<{ completed: boolean; interruptedReason?: string }> = [];
    voice.enqueueNotice({
      id: "notice_unthrottled",
      spokenText: "手动触发播报",
      delivery: "when_idle",
      respectQuietHours: false,
      onResult: (res) => unthrottledResults.push(res),
    });
    await waitForCondition(() =>
      sock.writes.some((frame) => JSON.stringify(frame).includes("手动触发播报")),
    );
    sock.push({ type: "response.done", response: { id: "resp_unthrottled", status: "completed" } });
    await waitForCondition(() => unthrottledResults.length === 1);
    assert.deepEqual(unthrottledResults[0], { completed: true });
  } finally {
    voice.close();
    await engine.close();
    store.close();
  }
});

test("MobileRuntime bundle: GitHub PAT guards, adoptConversationSession persistence, ScheduleHost bridge, 3-lane concurrency, interaction isolation, and rebuild cancel+reconcile", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "looi-sched-rt-"));
  t.after(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const vault = createMemoryVault();
  const fakeNative = createFakeNativeScheduleHost();

  // Mock fetch for https://mock-llm.local/v1 and https://api.github.com
  const originalFetch = globalThis.fetch;
  let releaseScheduleToolGate: (() => void) | undefined;
  let scheduleToolStartedCount = 0;
  let lastFgToolNames: string[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

    if (url === "https://api.github.com/rate_limit") {
      const auth = new Headers(init?.headers).get("Authorization");
      if (auth === "Bearer github_pat_MOBILE_RUNTIME_1234") {
        return new Response(JSON.stringify({ rate: { limit: 5000, remaining: 4999, reset: 1900000000 } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 });
    }

    if (url.startsWith("https://api.github.com/repos/")) {
      return new Response(JSON.stringify({
        number: 88,
        title: "PR 88",
        state: "open",
        draft: false,
        merged: false,
        head: { sha: "sha88", ref: "feat" },
        base: { ref: "main" },
      }), { status: 200 });
    }

    if (url.startsWith("https://mock-llm.local/v1/chat/completions")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        messages?: Array<{ role: string; content: unknown }>;
        tools?: unknown[];
      };
      const messages = body.messages ?? [];
      const systemContent =
        typeof messages[0]?.content === "string"
          ? messages[0].content
          : JSON.stringify(messages[0]?.content ?? "");
      const isObserver =
        (!Array.isArray(body.tools) || body.tools.length === 0) &&
        (systemContent.includes("shouldFollowUp") || JSON.stringify(messages).includes("shouldFollowUp"));
      const lastUserIdx = messages.map((m) => m.role).lastIndexOf("user");
      const currentUserText = lastUserIdx >= 0 ? JSON.stringify(messages[lastUserIdx]?.content ?? "") : "";
      const currentToolResults =
        lastUserIdx >= 0
          ? messages.slice(lastUserIdx + 1).filter((m) => m.role === "tool")
          : [];

      if (isObserver) {
        return buildOpenAiSseResponse({
          type: "text",
          text: JSON.stringify({
            shouldFollowUp: true,
            title: "Check PR acme/app#88 CI",
            delaySeconds: 180,
            target: {
              kind: "github_pr",
              owner: "acme",
              repo: "app",
              pullNumber: 88,
            },
          }),
        });
      }

      if (currentUserText.includes("CREATE_AND_CHECK_PR_88")) {
        if (currentToolResults.length === 0) {
          return buildOpenAiSseResponse({
            type: "tool_calls",
            calls: [
              {
                id: "call_bash_pr_88",
                name: "bash",
                arguments: JSON.stringify({ command: "gh pr create --title PR88" }),
              },
            ],
          });
        }
        return buildOpenAiSseResponse({
          type: "text",
          text: "Opened PR #88 on acme/app. Waiting for CI checks.",
        });
      }

      if (currentUserText.includes("SCHED_CONTROL_HOME")) {
        if (currentToolResults.length === 0) {
          return buildOpenAiSseResponse({
            type: "tool_calls",
            calls: [
              {
                id: "call_sched_list_home",
                name: "list_home_devices",
                arguments: JSON.stringify({}),
              },
            ],
          });
        }
        if (currentToolResults.length === 1) {
          const listContent =
            typeof currentToolResults[0]!.content === "string"
              ? currentToolResults[0]!.content
              : Array.isArray(currentToolResults[0]!.content)
                ? (currentToolResults[0]!.content as Array<{ text?: string }>)
                    .map((p) => p.text ?? "")
                    .join("")
                : "";
          const listJson = JSON.parse(listContent) as {
            connectionId?: string;
            devices?: Array<{ entity_id?: string }>;
          };
          const connectionId = listJson.connectionId ?? "";
          const entity_id = listJson.devices?.[0]?.entity_id ?? "light.study_ceiling";
          return buildOpenAiSseResponse({
            type: "tool_calls",
            calls: [
              {
                id: "call_sched_home_1",
                name: "control_home_device",
                arguments: JSON.stringify({
                  entity_id,
                  connectionId,
                  service: "turn_on",
                }),
              },
            ],
          });
        }
        if (currentToolResults.length === 2) {
          return buildOpenAiSseResponse({
            type: "tool_calls",
            calls: [
              {
                id: "call_sched_report_ok",
                name: "schedule_report",
                arguments: JSON.stringify({
                  outcome: "ok",
                  importance: "notify",
                  summary: "书房灯已打开",
                }),
              },
            ],
          });
        }
        return buildOpenAiSseResponse({ type: "text", text: "书房灯已打开" });
      }

      if (currentUserText.includes("SCHED_NOTIFY_ONLY")) {
        if (currentToolResults.length === 0) {
          return buildOpenAiSseResponse({
            type: "tool_calls",
            calls: [
              {
                id: "call_sched_notify_only",
                name: "schedule_report",
                arguments: JSON.stringify({
                  outcome: "ok",
                  importance: "notify",
                  summary: "Notify delivery test",
                }),
              },
            ],
          });
        }
        return buildOpenAiSseResponse({ type: "text", text: "Notify delivery checked" });
      }

      if (currentUserText.includes("HOLD_SCHED_RUN")) {
        scheduleToolStartedCount++;
        await new Promise<void>((resolve) => {
          releaseScheduleToolGate = resolve;
          init?.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        if (init?.signal?.aborted) {
          throw Object.assign(new Error("Request aborted"), { name: "AbortError" });
        }
        return buildOpenAiSseResponse({ type: "text", text: "held schedule done" });
      }

      if (currentUserText.includes("FG_FAST_QUESTION")) {
        lastFgToolNames = Array.isArray(body.tools)
          ? body.tools
              .map((tool: any) =>
                typeof tool?.function?.name === "string"
                  ? tool.function.name
                  : typeof tool?.name === "string"
                    ? tool.name
                    : "",
              )
              .filter(Boolean)
          : [];
        return buildOpenAiSseResponse({ type: "text", text: "Foreground answered concurrently" });
      }

      return buildOpenAiSseResponse({ type: "text", text: `Echo: ${currentUserText}` });
    }

    return originalFetch(input, init);
  }) as typeof fetch;

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  // Boot first MobileRuntime via bundled generated/looi-runtime.js
  let runtime1 = await openRuntime(createNodeCompatHost(tempRoot), vault);
  try {
    const tap = () => makeUiAction(runtime1.uiSessionId, "tap");

    // 1. GitHub token UI action guard + secret redaction + verify
    assert.throws(
      () => runtime1.github.save("github_pat_MOBILE_RUNTIME_1234", makeUiAction(runtime1.uiSessionId, "voice_command")),
      /fresh explicit UI action/i,
    );
    const ghSaved = runtime1.github.save("github_pat_MOBILE_RUNTIME_1234", tap());
    assert.equal(ghSaved.configured, true);
    assert.ok(!ghSaved.tokenHint?.includes("github_pat_MOBILE_RUNTIME_1234"));
    assert.equal(
      runtime1.redactSecrets("failed with github_pat_MOBILE_RUNTIME_1234!"),
      "failed with [redacted]!",
    );
    const ghVerify = await runtime1.github.verify(tap());
    assert.equal(ghVerify.valid, true);
    assert.equal(ghVerify.rateLimit?.limit, 5000);
    assert.equal(runtime1.github.clear(tap()).configured, false);

    // Configure model + simulated home
    await runtime1.agent.models.configureLegacy({
      baseUrl: "https://mock-llm.local/v1",
      model: "mock-gpt",
      apiKey: "sk-mock-llm-1234",
    });
    await runtime1.home.configure({ mode: "simulation" }, tap());

    // Attach ScheduleHost
    await runtime1.schedule.attachNative(fakeNative.host, { foregroundActive: true });
    assert.equal(runtime1.schedule.exactAlarmStatus()?.mode, "exact");

    // 2. adoptConversationSession persists across close/reopen & enforces guards
    assert.throws(
      () => runtime1.agent.adoptConversationSession("sess_bad/../x", tap()),
      /runtimeInvalidScheduleSession/,
    );
    assert.throws(
      () => runtime1.agent.adoptConversationSession("sess_adopted_1", makeUiAction(runtime1.uiSessionId, "voice_command")),
      /fresh explicit UI action/i,
    );
    const adopted = runtime1.agent.adoptConversationSession("sess_adopted_1", tap());
    assert.equal(adopted.conversationId, "sess_adopted_1");
    assert.equal(runtime1.agent.activeConversationId(), "sess_adopted_1");
  } finally {
    await runtime1.close();
  }

  // Reopen MobileRuntime against same tempRoot + vault -> verifies persisted conversationId
  const runtime2 = await openRuntime(createNodeCompatHost(tempRoot), vault);
  try {
    const tap = () => makeUiAction(runtime2.uiSessionId, "tap");
    assert.equal(runtime2.agent.activeConversationId(), "sess_adopted_1");

    await runtime2.schedule.attachNative(fakeNative.host, { foregroundActive: true });

    // Quiet hours mutation pushes syncQuietHours & updates isQuietHoursNow
    runtime2.schedule.addQuietHoursWindow(
      { id: "qh_all_day", startMinute: 0, endMinute: 23 * 60 + 59, enabled: true },
      tap(),
    );
    runtime2.schedule.setQuietHoursEnabled(false, tap());
    assert.equal(runtime2.schedule.isQuietHoursNow(), false);
    assert.ok(fakeNative.quietSnapshots.length >= 2);

    // Track activity & schedule interactions
    const activities: Array<{
      kind: string;
      ruleId?: string;
      notificationPosted?: boolean;
      notificationError?: { stage: string; code?: string | number; reason: string };
    }> = [];
    const interactions: Array<any> = [];
    runtime2.schedule.subscribeActivity((ev) => activities.push(ev));
    runtime2.schedule.subscribeInteractions((ev) => interactions.push(ev));

    // 3. Foreground turn calling bash -> PostTurnScheduleObserver seeds check_only rule automatically
    const fgRes = await runtime2.agent.run("CREATE_AND_CHECK_PR_88", tap(), (step) => {
      if (step.phase === "awaiting_approval" && step.interaction) {
        runtime2.agent.respond(step.taskId!, step.interaction.id, {
          outcome: "allowed-once",
          userAction: tap(),
        });
      }
    });
    assert.match(fgRes.answer, /PR #88/);
    await waitForCondition(() =>
      runtime2.schedule
        .listRules({ origin: "agent_inferred" })
        .some((r) => r.dedupeKey === "github_pr:acme/app#88" && r.executionPolicy === "check_only"),
    );

    // 4. Create an authorized_action schedule rule that triggers control_home_device (awaiting_approval)
    const { rule: authRule1 } = runtime2.schedule.createRule({
      title: "开客厅灯检查",
      prompt: "SCHED_CONTROL_HOME rule 1",
      origin: "user",
      executionPolicy: "authorized_action",
      trigger: { kind: "interval", everySeconds: 3600 },
    });
    await waitForCondition(() =>
      fakeNative.syncedAlarms.some((list) => list.some((a) => a.ruleId === authRule1.id)),
    );

    // Run rule 1 -> pauses at awaiting_approval -> emits subscribeInteractions
    await runtime2.schedule.setForegroundActive(false);
    const run1Promise = runtime2.schedule.runRuleNow(authRule1.id);
    await waitForCondition(
      () =>
        interactions.some((ev) => ev.type === "requested" && ev.ruleId === authRule1.id) ||
        runtime2.schedule.listRuns(authRule1.id).some((r) => r.status !== "running"),
    );

    const req1 = runtime2.schedule.pendingInteractions().find((ev) => ev.ruleId === authRule1.id);
    assert.ok(
      req1,
      `Expected pending schedule interaction, runs=${JSON.stringify(runtime2.schedule.listRuns(authRule1.id))}, interactions=${JSON.stringify(interactions)}`,
    );
    assert.equal(req1.interaction.kind, "approval");

    // WHILE schedule run is paused on schedule lane:
    // (a) Second rule on schedule lane cannot double-enter schedule lane
    const { rule: authRule2 } = runtime2.schedule.createRule({
      title: "第二个调度规则",
      prompt: "FG_FAST_QUESTION",
      origin: "user",
      executionPolicy: "check_only",
      trigger: { kind: "interval", everySeconds: 3600 },
    });
    await assert.rejects(
      () => runtime2.schedule.runRuleNow(authRule2.id),
      (error: any) => error?.code === "ERR_AGENT_LANE_BUSY",
    );

    // (b) Foreground turn STILL succeeds concurrently without hitting busy lock!
    const concurrentFg = await runtime2.agent.run("FG_FAST_QUESTION", tap(), () => {});
    assert.equal(concurrentFg.answer, "Foreground answered concurrently");

    // Resolve first scheduled interaction via respond -> settles & clears ONLY task 1, posts notification (background!)
    runtime2.agent.respond(req1.taskId, req1.interaction.id, {
      outcome: "allowed-once",
      userAction: tap(),
    });
    const run1Result = await run1Promise;
    assert.equal(run1Result.status, "succeeded", JSON.stringify(run1Result));
    assert.equal(run1Result.importance, "notify");
    await waitForCondition(() =>
      interactions.some((ev) => ev.type === "cleared" && ev.taskId === req1.taskId),
    );
    assert.equal(runtime2.schedule.pendingInteractions().length, 0);
    assert.ok(
      fakeNative.postedNotifications.some((n) => n.ruleId === authRule1.id && n.silent === false),
      "Settled background notify run should post native OS notification once",
    );
    assert.ok(
      activities.some((a) => a.kind === "run_settled" && a.ruleId === authRule1.id && a.notificationPosted === true),
    );

    // Tap notification event -> handleNativeEvents returns tappedRule & tappedRun
    fakeNative.pushEvent({
      kind: "notification_tapped",
      ruleId: authRule1.id,
      notificationId: run1Result.id,
      handle: run1Result.id,
      payloadJson: JSON.stringify({
        source: "notification",
        sessionId: run1Result.sessionId,
      }),
      occurredAtMs: Date.now(),
    });
    const tapped = await runtime2.schedule.handleNativeEvents();
    assert.equal(tapped.tappedRule?.id, authRule1.id);
    assert.equal(tapped.tappedRun?.id, run1Result.id);

    // 5. Multi-task interaction isolation: concurrent foreground + scheduled approval without cross-clearing
    let fgPaused: { taskId: string; interactionId: string } | undefined;
    let fgDone = false;
    const fgPausedPromise = runtime2.agent
      .run("CREATE_AND_CHECK_PR_88", tap(), (step) => {
        if (step.phase === "awaiting_approval" && step.interaction && step.taskId) {
          fgPaused = { taskId: step.taskId, interactionId: step.interaction.id };
        }
      })
      .then((res) => {
        fgDone = true;
        return res;
      });
    await waitForCondition(() => Boolean(fgPaused));

    const run1AgainPromise = runtime2.schedule.runRuleNow(authRule1.id);
    await waitForCondition(() => interactions.some((ev) => ev.type === "requested" && ev.taskId !== req1.taskId));
    const req2 = runtime2.schedule.pendingInteractions()[0]!;
    assert.notEqual(req2.taskId, fgPaused!.taskId);

    // Cancelling ONLY the scheduled interaction leaves foreground interaction untouched
    await runtime2.agent.cancelTask(req2.taskId);
    const run1Again = await run1AgainPromise;
    assert.notEqual(run1Again.status, "running");
    await waitForCondition(() =>
      interactions.some((ev) => ev.type === "cleared" && ev.taskId === req2.taskId),
    );
    assert.equal(fgDone, false, "Cancelling schedule task must not clear or settle foreground task");

    // Now respond to the foreground interaction and verify it completes cleanly
    runtime2.agent.respond(fgPaused!.taskId, fgPaused!.interactionId, {
      outcome: "allowed-once",
      userAction: tap(),
    });
    const fgResumedResult = await fgPausedPromise;
    assert.match(fgResumedResult.answer, /PR #88/);

    // 6. Body configuration updates taskTools dynamically without killing active schedule runs;
    // real model rebuild cancels active schedule run cleanly and restores healthy execution + reconcile
    const { rule: heldRule } = runtime2.schedule.createRule({
      title: "长耗时复查",
      prompt: "HOLD_SCHED_RUN",
      origin: "user",
      executionPolicy: "check_only",
      trigger: { kind: "interval", everySeconds: 3600 },
    });
    let heldSettledFlag = false;
    const heldPromise = runtime2.schedule.runRuleNow(heldRule.id).then((run) => {
      heldSettledFlag = true;
      return run;
    });
    await waitForCondition(() => scheduleToolStartedCount === 1);
    await runtime2.body.configure({ mode: "simulation" }, tap());
    await wait(30);
    assert.equal(heldSettledFlag, false, "Body configuration must not cancel an active schedule run");
    const dynamicToolsFg = await runtime2.agent.run("FG_FAST_QUESTION", tap(), () => {});
    assert.equal(dynamicToolsFg.answer, "Foreground answered concurrently");
    assert.ok(
      lastFgToolNames.includes("get_looi_body_status") && lastFgToolNames.includes("control_looi_body"),
      `Expected body tools to mount dynamically without executor rebuild, got: ${JSON.stringify(lastFgToolNames)}`,
    );

    await runtime2.agent.models.configureLegacy({
      baseUrl: "https://mock-llm.local/v1",
      model: "mock-gpt-v2",
      apiKey: "sk-mock-llm-1234",
    });
    const heldSettled = await heldPromise;
    assert.notEqual(heldSettled.status, "running");
    const postRebuildFg = await runtime2.agent.run("FG_FAST_QUESTION", tap(), () => {});
    assert.equal(postRebuildFg.answer, "Foreground answered concurrently");

    // Direct schedule-native-adapter unit assertion on drainEvents & permission normalization
    fakeNative.pushEvent({
      kind: "notification_tapped",
      ruleId: authRule1.id,
      notificationId: "looi.sched.post.1",
      handle: run1Result.id,
      payloadJson: JSON.stringify({ source: "notification", sessionId: "sess_from_native" }),
      occurredAtMs: 1700000000000,
    });
    const directPort = createScheduleNativePort(fakeNative.host);
    const drained = directPort.drainEvents() as Array<{ kind: string; ruleId?: string; runId?: string; sessionId?: string }>;
    assert.equal(drained.length, 1);
    assert.equal(drained[0]?.kind, "notification_tapped");
    assert.equal(drained[0]?.runId, run1Result.id);
    assert.equal(drained[0]?.sessionId, "sess_from_native");
    assert.deepEqual(directPort.permissionStatus(), {
      notification: "granted",
      exactAlarmAllowed: true,
      exactAlarmDegraded: false,
    });

    // Verify notification delivery failures preserve stage, code, and redacted reason (Fix #2)
    runtime2.github.save("github_pat_MOBILE_NOTIFY_SECRET_99", tap());
    const origPostNotification = fakeNative.host.postNotification;
    fakeNative.host.postNotification = () => {
      throw Object.assign(
        new Error("OS permission denied for token github_pat_MOBILE_NOTIFY_SECRET_99"),
        { code: "ERR_OS_NOTIFY_DENIED" },
      );
    };
    const { rule: failingNotifyRule } = runtime2.schedule.createRule({
      title: "通知失败留痕检查",
      prompt: "SCHED_NOTIFY_ONLY",
      origin: "user",
      executionPolicy: "check_only",
      trigger: { kind: "interval", everySeconds: 3600 },
    });
    await runtime2.schedule.setForegroundActive(false);
    await runtime2.schedule.runRuleNow(failingNotifyRule.id);
    fakeNative.host.postNotification = origPostNotification;
    const notifyFailEv = activities.find(
      (ev) => ev.kind === "run_settled" && ev.ruleId === failingNotifyRule.id,
    );
    assert.ok(notifyFailEv, "Expected run_settled activity event for notification failure");
    assert.equal(notifyFailEv.notificationPosted, false);
    assert.equal(notifyFailEv.notificationError?.stage, "schedule.notification");
    assert.equal(notifyFailEv.notificationError?.code, "ERR_OS_NOTIFY_DENIED");
    assert.match(notifyFailEv.notificationError?.reason ?? "", /OS permission denied/);
    assert.ok(!notifyFailEv.notificationError?.reason.includes("github_pat_MOBILE_NOTIFY_SECRET_99"));
    void releaseScheduleToolGate;
  } finally {
    await runtime2.close();
  }
});
