import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { UserActionRef } from "@super-looi/contracts";
import { assertFreshUiAction } from "@super-looi/runtime/agent";
import { SqliteRuntimeStore } from "@super-looi/runtime/storage";
import { createLangfuseTracer } from "@super-looi/runtime/telemetry";
import { AgentRuntime, type AgentRuntimeOptions } from "../runtime/agent.js";

function sseResponse(events: Array<unknown | "[DONE]">): Response {
  const body = events
    .map((event) =>
      event === "[DONE]" ? "data: [DONE]\n\n" : `data: ${JSON.stringify(event)}\n\n`,
    )
    .join("");
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function openAiTextChunk(content: string, id = "chat_test"): Array<unknown | "[DONE]"> {
  return [
    {
      id,
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
    },
    {
      id,
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    },
    "[DONE]",
  ];
}

function makeAction(uiSessionId: string, kind: UserActionRef["kind"] = "tap"): UserActionRef {
  const now = Date.now();
  return {
    event_id: `evt_${randomUUID()}`,
    ui_session_id: uiSessionId,
    kind,
    captured_at: new Date(now).toISOString(),
    expires_at: new Date(now + 60_000).toISOString(),
  };
}

function setupStandaloneAgent(
  t: { after: (fn: () => void | Promise<void>) => void },
  overrides: Partial<AgentRuntimeOptions> & {
    initialVault?: Record<string, string>;
    onWrite?: (key: string, value: string) => void;
  } = {},
) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "looi-agent-rt-"));
  const stateDirectory = path.join(tempRoot, "agent");
  const workspaceRoot = path.join(tempRoot, "workspace");
  fs.mkdirSync(stateDirectory, { recursive: true });
  fs.mkdirSync(workspaceRoot, { recursive: true });

  const slots = new Map<string, string>(Object.entries(overrides.initialVault ?? {}));
  let closed = false;
  const database = new DatabaseSync(":memory:");
  database.exec(
    "CREATE TABLE IF NOT EXISTS home_action_evidence (request_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, evidence TEXT NOT NULL)",
  );
  database.exec(
    "CREATE TABLE IF NOT EXISTS body_action_evidence (request_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, evidence TEXT NOT NULL)",
  );
  const storage = new SqliteRuntimeStore(database);
  const uiSessionId = `ui_${randomUUID()}`;
  const tracer = createLangfuseTracer({});

  const vault = {
    get: (key: string) => slots.get(key) ?? "",
    set: (key: string, value: string) => {
      overrides.onWrite?.(key, value);
      slots.set(key, value);
    },
    remove: (key: string) => {
      slots.delete(key);
    },
  };

  const agent = new AgentRuntime({
    vault,
    database,
    storage,
    tracer,
    uiSessionId,
    stateDirectory,
    workspaceRoot,
    assertUiAction: (action) => {
      assert.equal(closed, false);
      assertFreshUiAction(action);
      if (action.ui_session_id !== uiSessionId) {
        throw new Error("@looi:runtimeThisPageExpiredOpenItAgain");
      }
    },
    redactSecrets: (text) => text,
    isClosed: () => closed,
    ...overrides,
  });

  t.after(async () => {
    closed = true;
    await agent.close();
    await tracer.shutdown();
    storage.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  return {
    agent,
    slots,
    database,
    storage,
    uiSessionId,
    action: () => makeAction(uiSessionId),
  };
}

test("AgentRuntime standalone: 6-brand catalog, CRUD, custom model injection, and vault failure rollback across all mutations", async (t) => {
  let failWrites = false;
  const initialConfig = {
    baseUrl: "https://mock-agent.local/v1",
    model: "model-initial",
    apiKey: "sk-initial-key",
  };
  const { agent, slots, action } = setupStandaloneAgent(t, {
    initialVault: { model: JSON.stringify({ ...initialConfig, conversationId: "sess_init" }) },
    onWrite: () => {
      if (failWrites) throw new Error("vault write failed");
    },
  });

  // 1. 6-brand catalog & CRUD
  const snap0 = agent.models.snapshot();
  assert.deepEqual(
    snap0.brands.map((b) => b.brandId),
    ["openai", "kimi", "minimax", "xiaomi", "zai", "custom"],
  );
  assert.equal(agent.models.configuration().model, "model-initial");

  const snap1 = await agent.models.saveApiKey(
    { providerId: "zai-cn", apiKey: "sk-zai-1", modelId: "glm-custom-alpha" },
    action(),
  );
  assert.equal(snap1.active?.providerId, "zai-cn");
  assert.equal(snap1.active?.modelId, "glm-custom-alpha");
  const zaiModels = snap1.brands
    .find((b) => b.brandId === "zai")!
    .channels.find((c) => c.providerId === "zai-cn")!.models;
  assert.equal(zaiModels.find((m) => m.id === "glm-custom-alpha")?.isCustom, true);

  const snap2 = await agent.models.selectActive(
    { providerId: "zai-cn", modelId: "glm-custom-beta" },
    action(),
  );
  assert.equal(snap2.active?.modelId, "glm-custom-beta");

  // 2. Rollback protects configureLegacy, saveApiKey, selectActive, and removeCredential
  const originalFetch = globalThis.fetch;
  const seenModels: string[] = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
    if (body.model) seenModels.push(body.model);
    return sseResponse(openAiTextChunk("ROLLBACK_OK"));
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  failWrites = true;
  await assert.rejects(
    () =>
      agent.models.configureLegacy({
        baseUrl: "https://mock-agent.local/v1",
        model: "model-never-saved",
        apiKey: "sk-never",
      }),
    /vault write failed/,
  );
  await assert.rejects(
    () =>
      agent.models.saveApiKey(
        { providerId: "openai", apiKey: "sk-openai-never", modelId: "gpt-5.4" },
        action(),
      ),
    /vault write failed/,
  );
  await assert.rejects(
    () =>
      agent.models.selectActive(
        { providerId: "zai-cn", modelId: "glm-never" },
        action(),
      ),
    /vault write failed/,
  );
  await assert.rejects(
    () => agent.models.removeCredential("zai-cn", action()),
    /vault write failed/,
  );

  // Recovered executor must still work cleanly on glm-custom-beta
  assert.equal(agent.models.configuration().model, "glm-custom-beta");
  const resAfterRollback = await agent.run("Verify rollback", action(), () => {});
  assert.equal(resAfterRollback.answer, "ROLLBACK_OK");
  assert.equal(seenModels.at(-1), "glm-custom-beta");

  // Remove credential works cleanly once vault recovers
  failWrites = false;
  const snapRemoved = await agent.models.removeCredential("zai-cn", action());
  assert.equal(snapRemoved.active, null);
  assert.equal(JSON.parse(slots.get("model")!).active, undefined);
});

test("AgentRuntime standalone: refreshModels version race protection and OAuth PKCE/device flows", async (t) => {
  const { agent, action } = setupStandaloneAgent(t);
  await agent.models.saveApiKey(
    { providerId: "openai", apiKey: "sk-openai-test", modelId: "gpt-5.4" },
    action(),
  );

  const originalFetch = globalThis.fetch;
  let releaseFirstFetch!: () => void;
  let fetchCount = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith("/models")) {
      const idx = ++fetchCount;
      if (idx === 1) {
        await new Promise<void>((resolve) => {
          releaseFirstFetch = resolve;
        });
        return new Response(
          JSON.stringify({ data: [{ id: "gpt-5.4", name: "Stale Model" }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ data: [{ id: "gpt-5.4", name: "Fresh Model" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/api/oauth/device_authorization")) {
      return new Response(
        JSON.stringify({
          device_code: "kimi_dev_1",
          user_code: "KIMI-9999",
          verification_uri: "https://auth.kimi.com/device",
          verification_uri_complete: "https://auth.kimi.com/device?code=KIMI-9999",
          interval: 1,
          expires_in: 300,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/api/oauth/token")) {
      return new Response(
        JSON.stringify({
          access_token: "kimi_tok",
          refresh_token: "kimi_ref",
          expires_in: 3600,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  // Start slower request #1, then start & finish faster request #2, then release #1
  const req1 = agent.models.refreshModels("openai");
  const req2 = await agent.models.refreshModels("openai");
  assert.equal(
    req2.brands[0]!.channels[0]!.models.find((m) => m.id === "gpt-5.4")?.name,
    "Fresh Model",
  );
  releaseFirstFetch();
  const afterStale = await req1;
  assert.equal(
    afterStale.brands[0]!.channels[0]!.models.find((m) => m.id === "gpt-5.4")?.name,
    "Fresh Model",
  );

  // Device code OAuth flow (kimi-coding)
  const origTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => new AbortController().signal;
  t.after(() => {
    AbortSignal.timeout = origTimeout;
  });
  const events: Array<{ kind: string; userCode?: string }> = [];
  const kimiSnap = await agent.models.startOAuth("kimi-coding", action(), (ev) => {
    events.push(ev);
  });
  assert.equal(events[0]?.kind, "device_code");
  assert.equal(events[0]?.userCode, "KIMI-9999");
  assert.equal(kimiSnap.active?.providerId, "kimi-coding");
  assert.equal(kimiSnap.active?.authType, "oauth");

  // OpenAI PKCE validation + cancellation
  const openaiEvents: Array<{ kind: string }> = [];
  const pendingOpenAi = agent.models.startOAuth("openai", action(), (ev) => {
    openaiEvents.push(ev);
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(openaiEvents.some((ev) => ev.kind === "auth_url"));
  assert.throws(
    () => agent.models.submitOAuthCallback("bad-url"),
    /@looi:runtimePasteFullChatgptCallbackUrl/,
  );
  assert.throws(
    () =>
      agent.models.submitOAuthCallback(
        "http://localhost:1455/auth/callback?code=c&state=wrong",
      ),
    /@looi:runtimeChatgptCallbackDoesNotMatchSignin/,
  );
  agent.models.cancelOAuth();
  await assert.rejects(() => pendingOpenAi);
  assert.equal(agent.models.isOAuthActive, false);
});

test("AgentRuntime standalone: foreground + plugin lane concurrency, user-turn guards, session persistence, and TaskHistoryStore", async (t) => {
  let guardMode: "pass" | "handled" | "block" = "pass";
  const { agent, database, action } = setupStandaloneAgent(t, {
    evaluateUserTurn: async (text) => {
      if (guardMode === "handled") {
        return {
          decision: "handled",
          pluginId: "werewolf-judge",
          answer: `handled:${text}`,
        };
      }
      if (guardMode === "block") {
        return {
          decision: "block",
          pluginId: "werewolf-judge",
          stage: "werewolf:ai.interceptUserTurn",
          code: "ERR_NIGHT_SILENT",
          reason: "Night phase forbids voice task",
          spokenReply: "天黑请闭眼",
          cause: { round: 2 },
        };
      }
      return undefined;
    },
  });

  await agent.models.configureLegacy({
    baseUrl: "https://mock-agent.local/v1",
    model: "mock-gpt",
    apiKey: "sk-mock",
  });

  const originalFetch = globalThis.fetch;
  let releaseForegroundGate!: () => void;
  let foregroundInFlight = false;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      messages?: Array<{ role: string; content: unknown }>;
    };
    const promptText = JSON.stringify(body.messages ?? []);
    if (promptText.includes("HOLD_FG_TURN")) {
      foregroundInFlight = true;
      await new Promise<void>((resolve) => {
        releaseForegroundGate = resolve;
      });
      return sseResponse(openAiTextChunk("FG_DONE"));
    }
    return sseResponse(openAiTextChunk("BG_DONE"));
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  // Plugin handled & block preserve exact stage/code/spokenReply/cause on both foreground and plugin lanes
  guardMode = "handled";
  const handledFg = await agent.run("投 3 号", action(), () => {});
  assert.equal(handledFg.answer, "handled:投 3 号");
  assert.equal(handledFg.taskId, "");

  guardMode = "block";
  await assert.rejects(
    () => agent.run("查灯", action(), () => {}),
    (err: any) =>
      err?.stage === "werewolf:ai.interceptUserTurn" &&
      err?.code === "ERR_NIGHT_SILENT" &&
      err?.spokenReply === "天黑请闭眼" &&
      err?.cause?.round === 2,
  );
  await assert.rejects(
    () => agent.runPluginBackgroundTask("werewolf-judge", "查灯"),
    (err: any) =>
      err?.stage === "werewolf:ai.interceptUserTurn" &&
      err?.code === "ERR_NIGHT_SILENT" &&
      err?.spokenReply === "天黑请闭眼",
  );

  // Foreground + plugin concurrency
  guardMode = "pass";
  let activityUpdates = 0;
  const unsub = agent.history.subscribe(() => {
    activityUpdates++;
  });
  const fgPromise = agent.run("HOLD_FG_TURN", action(), () => {});
  await new Promise<void>((resolve) => {
    const check = () => (foregroundInFlight ? resolve() : setTimeout(check, 10));
    check();
  });
  const bgResult = await agent.runPluginBackgroundTask("codex", "BG_PING");
  assert.equal(bgResult.answer, "BG_DONE");
  releaseForegroundGate();
  const fgResult = await fgPromise;
  assert.equal(fgResult.answer, "FG_DONE");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(activityUpdates > 0);
  unsub();

  // Conversation session validation & persistence
  assert.throws(
    () => agent.adoptConversationSession("bad/../session", action()),
    /@looi:runtimeInvalidScheduleSession/,
  );
  const adopted = agent.adoptConversationSession("sess_custom_1", action());
  assert.equal(adopted.conversationId, "sess_custom_1");
  assert.equal(agent.activeConversationId(), "sess_custom_1");
  agent.newConversation(action());
  assert.notEqual(agent.activeConversationId(), "sess_custom_1");

  // TaskHistoryStore pagination, cloning, and evidence aggregation
  const page = agent.history.page(0);
  assert.ok(page.items.some((item) => item.id === fgResult.taskId));
  assert.throws(() => agent.history.page(-1), /@looi:runtimeInvalidTaskPage/);

  database
    .prepare("INSERT INTO home_action_evidence (request_id, task_id, evidence) VALUES (?, ?, ?)")
    .run("req_h1", fgResult.taskId, JSON.stringify({ requestId: "req_h1", status: "verified" }));
  database
    .prepare("INSERT INTO body_action_evidence (request_id, task_id, evidence) VALUES (?, ?, ?)")
    .run("req_b1", fgResult.taskId, JSON.stringify({ requestId: "req_b1", status: "sent" }));

  const details = agent.history.details(fgResult.taskId) as any;
  assert.equal(details.homeActions.length, 1);
  assert.equal(details.bodyActions.length, 1);
  details.prompt = "mutated";
  assert.equal(agent.history.details(fgResult.taskId).prompt, "HOLD_FG_TURN");
});
