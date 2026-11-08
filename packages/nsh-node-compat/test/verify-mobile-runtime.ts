import { MobileRuntime } from "../../../apps/nsh/runtime/application.js";
import { DatabaseSync } from "node:sqlite";
import { installFixtureHttp, sseResponse } from "./http-fixture.js";
import { assert, equal } from "./assert.js";

installFixtureHttp();
const oldConfig = {
  baseUrl: "https://example.invalid/v1",
  model: "original",
  apiKey: "test-only",
};
let saved = JSON.stringify({
  ...oldConfig,
  conversationId: "session_vault_test",
});
let failWrite = true;
let released = false;
const runtime = new MobileRuntime(
  {
    get: (key: string) => (key === "model" ? saved : ""),
    set: (_key, value) => {
      if (failWrite) throw new Error("vault unavailable");
      saved = value;
    },
    remove: () => {},
  },
  () => {
    released = true;
  },
);
let rejected = false;
try {
  await runtime.configure({ ...oldConfig, model: "replacement" });
} catch {
  rejected = true;
}
assert(rejected, "Native vault failure must be reported");
equal(runtime.configuration().model, "original");
equal(JSON.parse(saved).model, "original");
// Exercise the retained executor's public admission path without a network call.
// A closed executor rejects before task creation; a usable one reaches provider setup.
const now = Date.now();
let failure = "";
const nativeFetch = globalThis.fetch;
let requests = 0;
globalThis.fetch = async (_input, init) => {
  requests++;
  equal(JSON.parse(String(init?.body)).model, "original");
  return new Response(
    JSON.stringify({ error: { message: "Intentional offline provider" } }),
    { status: 401, headers: { "content-type": "application/json" } },
  );
};
try {
  await runtime.run(
    "Say OK",
    {
      event_id: "vault-failure",
      ui_session_id: runtime.uiSessionId,
      kind: "tap",
      captured_at: new Date(now).toISOString(),
      expires_at: new Date(now + 10000).toISOString(),
    },
    () => {},
  );
} catch (error) {
  failure = String(error);
} finally {
  globalThis.fetch = nativeFetch;
}
assert(
  requests > 0,
  "Recovered executor must dispatch using the previous model",
);
assert(
  failure.includes("Intentional offline provider"),
  "Expected controlled provider refusal",
);
assert(
  !failure.includes("executor is closed"),
  "Vault failure left a closed executor",
);
failWrite = false;
await runtime.configure({ ...oldConfig, model: "replacement" });
equal(runtime.configuration().model, "replacement");
equal(JSON.parse(saved).model, "replacement");
await runtime.close();
assert(released);
console.log(
  "PASS mobile runtime: failed secure configuration preserves usable prior executor; retry and close",
);

const vault = {
  get: (key: string) => (key === "model" ? saved : ""),
  set: (_key: string, value: string) => {
    saved = value;
  },
  remove: () => {},
};
let mobile = new MobileRuntime(vault, () => {});
const prompts: any[][] = [];
globalThis.fetch = async (_input, init) => {
  prompts.push(JSON.parse(String(init?.body)).messages);
  return sseResponse([
    {
      id: "mobile-chat",
      object: "chat.completion.chunk",
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: "ORCHID" },
          finish_reason: null,
        },
      ],
    },
    {
      id: "mobile-chat",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    },
    "[DONE]",
  ]);
};
const action = () => {
  const now = Date.now();
  return {
    event_id: `chat_${now}`,
    ui_session_id: mobile.uiSessionId,
    kind: "tap" as const,
    captured_at: new Date(now).toISOString(),
    expires_at: new Date(now + 10000).toISOString(),
  };
};
try {
  const first = await mobile.run("My code is ORCHID", action(), () => {});
  const conversation = JSON.parse(saved).conversationId;
  await mobile.close();
  mobile = new MobileRuntime(vault, () => {});
  const second = await mobile.run("What was my code?", action(), () => {});
  assert(
    first.taskId !== second.taskId,
    "Each turn keeps independent task evidence",
  );
  assert(
    JSON.stringify(prompts[1]).includes("My code is ORCHID"),
    "App reopen lost the previous user turn",
  );
  assert(
    prompts[1].some(
      (message: any) =>
        message.role === "assistant" && message.content === "ORCHID",
    ),
    "App reopen lost the prior answer",
  );
  const beforeTasks = mobile.taskPage();
  assert(beforeTasks.items.some((task) => task.id === first.taskId));
  const detail = mobile.taskDetails(first.taskId);
  detail.prompt = "tampered";
  equal(mobile.taskDetails(first.taskId).prompt, "My code is ORCHID");
  let invalidPage = false;
  try {
    mobile.taskPage(-1);
  } catch {
    invalidPage = true;
  }
  assert(invalidPage, "Negative task offsets must be rejected");
  mobile.newConversation(action());
  assert(JSON.parse(saved).conversationId !== conversation);
  equal(mobile.taskPage().total, beforeTasks.total);
  await mobile.run("New conversation", action(), () => {});
  assert(
    !JSON.stringify(prompts[2]).includes("ORCHID"),
    "New conversation leaked prior history",
  );
  await mobile.configure({ ...oldConfig, model: "new-account" });
  assert(
    JSON.parse(saved).conversationId !== conversation,
    "Changing model configuration must rotate conversation identity",
  );
  await mobile.run("Hello", action(), () => {});
  assert(
    !JSON.stringify(prompts[3]).includes("ORCHID"),
    "Configuration switch leaked prior conversation",
  );
  const semanticRecall = await mobile.run(
    "回忆我曾经保存的某件事",
    action(),
    () => {},
    { agentOnly: true },
  );
  assert(
    Boolean(semanticRecall.taskId) && semanticRecall.answer === "ORCHID",
    "Voice task was diverted into literal offline recall instead of Agent reasoning",
  );
} finally {
  globalThis.fetch = nativeFetch;
  await mobile.close();
}
console.log(
  "PASS mobile conversation: independent tasks, persisted transcript after reopen, configuration isolation",
);

// Actual Agent tool approval, home intent/receipt persistence, and reopen.
const homeSlots = new Map<string, string>([
  ["model", JSON.stringify(oldConfig)],
]);
let homeMobile = new MobileRuntime(
  {
    get: (key) => homeSlots.get(key) ?? "",
    set: (key, value) => {
      homeSlots.set(key, value);
    },
    remove: (key) => {
      homeSlots.delete(key);
    },
  },
  () => {},
);
const homeAction = () => {
  const now = Date.now();
  return {
    event_id: `home_${now}`,
    ui_session_id: homeMobile.uiSessionId,
    kind: "tap" as const,
    captured_at: new Date(now).toISOString(),
    expires_at: new Date(now + 10000).toISOString(),
  };
};
await homeMobile.configureHome({ mode: "simulation" }, homeAction());
const homeConnection = await homeMobile.connectHome();
let round = 0,
  approvals = 0;
let homeTask = "";
globalThis.fetch = async () => {
  const tool = round++ % 2 === 0;
  return sseResponse([
    {
      id: "home-chat",
      object: "chat.completion.chunk",
      choices: [
        {
          index: 0,
          delta: tool
            ? {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "home-control",
                    type: "function",
                    function: {
                      name: "control_home_device",
                      arguments: JSON.stringify({
                        entity_id: "light.study_ceiling",
                        service: "turn_on",
                        connectionId: homeConnection.connectionId,
                      }),
                    },
                  },
                ],
              }
            : { role: "assistant", content: "演示设备已回读确认" },
          finish_reason: tool ? "tool_calls" : "stop",
        },
      ],
    },
    "[DONE]",
  ]);
};
try {
  const outcome = await homeMobile.run(
    "打开演示书房灯",
    homeAction(),
    (event) => {
      if (event.interaction?.kind === "approval" && event.taskId) {
        approvals++;
        homeMobile.respond(event.taskId, event.interaction.id, {
          outcome: "allowed-once",
          userAction: homeAction(),
        });
      }
    },
  );
  homeTask = outcome.taskId;
  equal(approvals, 1);
  const evidence = homeMobile.taskDetails(homeTask).homeActions;
  equal(evidence.length, 1);
  equal(evidence[0].status, "verified");
  equal(evidence[0].simulation, true);
  equal(evidence[0].command.entity_id, "light.study_ceiling");
  const autoOutcome = await homeMobile.run(
    "再次打开演示书房灯",
    homeAction(),
    (event) => {
      if (event.interaction?.kind === "approval" && event.taskId) {
        approvals++;
        homeMobile.respond(event.taskId, event.interaction.id, {
          outcome: "allowed-once",
          userAction: homeAction(),
        });
      }
    },
    { approvalMode: "local_auto" },
  );
  equal(approvals, 2);
  equal(homeMobile.taskDetails(autoOutcome.taskId).homeActions[0].status, "verified");
  const yoloOutcome = await homeMobile.run(
    "自动打开演示书房灯",
    homeAction(),
    (event) => {
      if (event.interaction?.kind === "approval") approvals++;
    },
    { approvalMode: "yolo" },
  );
  equal(approvals, 2);
  equal(homeMobile.taskDetails(yoloOutcome.taskId).homeActions[0].status, "verified");
  await homeMobile.close();
  homeMobile = new MobileRuntime(
    {
      get: (key) => homeSlots.get(key) ?? "",
      set: (key, value) => {
        homeSlots.set(key, value);
      },
      remove: (key) => {
        homeSlots.delete(key);
      },
    },
    () => {},
  );
  equal(homeMobile.taskDetails(homeTask).homeActions, evidence);
  await homeMobile.close();
  // Model the durable crash boundary: intent committed, receipt not yet saved.
  const database = new DatabaseSync("/home/looi.sqlite");
  database
    .prepare(
      "UPDATE home_action_evidence SET evidence = ? WHERE request_id = ?",
    )
    .run(
      JSON.stringify({ ...evidence[0], status: "unknown", receipt: null }),
      evidence[0].requestId,
    );
  database.close();
  homeMobile = new MobileRuntime(
    {
      get: (key) => homeSlots.get(key) ?? "",
      set: (key, value) => {
        homeSlots.set(key, value);
      },
      remove: (key) => {
        homeSlots.delete(key);
      },
    },
    () => {},
  );
  equal(homeMobile.taskDetails(homeTask).state, "unknown");
  assert(homeMobile.recoveryCount() > 0);
  let blocked = false;
  try {
    await homeMobile.run("Continue", homeAction(), () => {});
  } catch (error) {
    blocked = String(error).includes("@looi:runtimeThisConversationHasUnverifiedActionsReviewTaskHistory");
  }
  assert(
    blocked,
    "Unresolved home side effect allowed same conversation to continue",
  );
  homeMobile.newConversation(homeAction());
  equal(homeMobile.taskDetails(homeTask).state, "unknown");
} finally {
  globalThis.fetch = nativeFetch;
  await homeMobile.close();
}
console.log(
  "PASS mobile home: real Agent approval, simulated control receipt, SQLite evidence after reopen",
);

const loginSlots = new Map<string, string>();
const loginMobile = new MobileRuntime({
  get: (key) => loginSlots.get(key) ?? "",
  set: (key, value) => { loginSlots.set(key, value); },
  remove: (key) => { loginSlots.delete(key); },
}, () => {});
const loginAction = () => ({ ...action(), ui_session_id: loginMobile.uiSessionId });
async function loginReject(operation: () => unknown) {
  let rejected = false;
  try { await operation(); } catch { rejected = true; }
  assert(rejected, "Login boundary unexpectedly allowed an operation");
}
try {
  await loginReject(() => loginMobile.beginMiotLogin("cn", { ...loginAction(), ui_session_id: "old-page" }));
  equal(loginSlots.size, 0);
  const session = await loginMobile.beginMiotLogin("cn", loginAction());
  await loginReject(() => loginMobile.connectHome());
  await loginReject(() => loginMobile.listHome());
  await loginReject(() => loginMobile.run("记住不应执行的笔记", loginAction(), () => {}));
  await loginReject(() => loginMobile.configureHome({ mode: "simulation" }, loginAction()));
  await loginReject(() => loginMobile.finishMiotLogin(session.attempt,
    `${session.redirectUri}?state=${session.state}&code=fixture`, () => false));
  assert(!loginMobile.homeConfiguration().hasMiotAccount, "Native invalidation persisted an account");
  const stale = loginMobile.beginMiotLogin("cn", loginAction());
  loginMobile.cancelMiotLogin();
  await loginReject(() => stale);
  const fresh = await loginMobile.beginMiotLogin("sg", loginAction());
  await loginReject(() => loginMobile.finishMiotLogin(session.attempt, "old-callback", () => true));
  await loginReject(() => loginMobile.connectHome());
  loginMobile.cancelMiotLogin();
  await loginMobile.configureHome({ mode: "simulation" }, loginAction());
  assert((await loginMobile.connectHome()).healthy, "Login cancellation did not release the home runtime");
  assert(fresh.attempt !== session.attempt, "Login attempt identity was reused");
} finally { await loginMobile.close(); }
console.log("PASS mobile MIoT: fresh UI authorization, pending-operation isolation, native commit guard and cancellation generations");

// Multi-provider LLM catalog, API Key mutation, custom models, and OAuth device flow
const llmSlots = new Map<string, string>();
const llmMobile = new MobileRuntime(
  {
    get: (key) => llmSlots.get(key) ?? "",
    set: (key, value) => {
      llmSlots.set(key, value);
    },
    remove: (key) => {
      llmSlots.delete(key);
    },
  },
  () => {},
);
const llmAction = () => ({
  event_id: `llm_${Date.now()}`,
  ui_session_id: llmMobile.uiSessionId,
  kind: "tap" as const,
  captured_at: new Date().toISOString(),
  expires_at: new Date(Date.now() + 10000).toISOString(),
});

try {
  // 1. llmSnapshot() has 6 brands (including zai-cn standard endpoint vs zai-coding-cn)
  const snapshot = llmMobile.llmSnapshot();
  equal(snapshot.brands.length, 6);
  const brandIds = snapshot.brands.map((b) => b.brandId);
  equal(brandIds, ["openai", "kimi", "minimax", "xiaomi", "zai", "custom"]);
  equal(snapshot.active, null);

  const zaiBrand = snapshot.brands.find((b) => b.brandId === "zai");
  assert(Boolean(zaiBrand), "Zai brand must be present");
  const zaiChannelIds = zaiBrand!.channels.map((c) => c.providerId);
  assert(zaiChannelIds.includes("zai-cn"), "zai-cn channel must be present");
  assert(zaiChannelIds.includes("zai-coding-cn"), "zai-coding-cn channel must be present");
  const zaiCnChannel = zaiBrand!.channels.find((c) => c.providerId === "zai-cn")!;
  equal(zaiCnChannel.baseUrl, "https://open.bigmodel.cn/api/paas/v4");
  const zaiCodingChannel = zaiBrand!.channels.find((c) => c.providerId === "zai-coding-cn")!;
  equal(zaiCodingChannel.baseUrl, "https://open.bigmodel.cn/api/coding/paas/v4");

  // 2. saveProviderApiKey saves Zhipu zai-cn API Key and switches active model
  const snapAfterSave = await llmMobile.saveProviderApiKey(
    {
      providerId: "zai-cn",
      apiKey: "test-zhipu-key-12345",
      modelId: "glm-5.3",
    },
    llmAction(),
  );
  equal(snapAfterSave.active?.providerId, "zai-cn");
  equal(snapAfterSave.active?.modelId, "glm-5.3");
  equal(snapAfterSave.active?.brandId, "zai");
  equal(snapAfterSave.active?.authType, "api_key");
  const updatedZaiBrand = snapAfterSave.brands.find((b) => b.brandId === "zai")!;
  assert(updatedZaiBrand.configured, "Zai brand should be marked configured");
  const updatedZaiCn = updatedZaiBrand.channels.find((c) => c.providerId === "zai-cn")!;
  assert(updatedZaiCn.hasApiKey, "zai-cn channel should have apiKey");
  equal(llmMobile.configuration().model, "glm-5.3");
  equal(llmMobile.configuration().baseUrl, "https://open.bigmodel.cn/api/paas/v4");
  equal(llmMobile.configuration().hasKey, true);

  // 3. selectActiveModel injects a custom model ID
  const snapAfterCustom = await llmMobile.selectActiveModel(
    {
      providerId: "zai-cn",
      modelId: "glm-custom-pro-v1",
    },
    llmAction(),
  );
  equal(snapAfterCustom.active?.providerId, "zai-cn");
  equal(snapAfterCustom.active?.modelId, "glm-custom-pro-v1");
  equal(llmMobile.configuration().model, "glm-custom-pro-v1");
  const customModelItem = snapAfterCustom.brands
    .find((b) => b.brandId === "zai")!
    .channels.find((c) => c.providerId === "zai-cn")!
    .models.find((m) => m.id === "glm-custom-pro-v1");
  assert(Boolean(customModelItem), "Injected custom model must appear in models list");
  equal(customModelItem!.isCustom, true);

  // 4. removeProviderCredential clears credential
  const snapAfterRemove = await llmMobile.removeProviderCredential("zai-cn", llmAction());
  equal(snapAfterRemove.active, null);
  const clearedZaiBrand = snapAfterRemove.brands.find((b) => b.brandId === "zai")!;
  assert(!clearedZaiBrand.configured, "Zai brand should no longer be configured");
  const clearedZaiCn = clearedZaiBrand.channels.find((c) => c.providerId === "zai-cn")!;
  assert(!clearedZaiCn.hasApiKey, "zai-cn channel should no longer have apiKey");
  equal(llmMobile.configuration().model, "");
  equal(llmMobile.configuration().hasKey, false);

  // 5. startProviderOAuth("kimi-coding", ...) under mock fetch
  const oauthFetch = globalThis.fetch;
  const origTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => new AbortController().signal;
  const oauthEvents: any[] = [];
  globalThis.fetch = async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : (input as any)?.url ?? "";
    if (url.includes("/api/oauth/device_authorization")) {
      return new Response(
        JSON.stringify({
          device_code: "kimi_device_123",
          user_code: "KIMI-4321",
          verification_uri: "https://auth.kimi.com/device",
          verification_uri_complete: "https://auth.kimi.com/device?code=KIMI-4321",
          interval: 1,
          expires_in: 300,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/api/oauth/token")) {
      return new Response(
        JSON.stringify({
          access_token: "kimi_access_secret",
          refresh_token: "kimi_refresh_secret",
          expires_in: 3600,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return oauthFetch(input, init);
  };

  try {
    const snapAfterOAuth = await llmMobile.startProviderOAuth(
      "kimi-coding",
      llmAction(),
      (ev) => {
        oauthEvents.push(ev);
      },
    );
    assert(oauthEvents.length > 0, "Should have received device code event");
    equal(oauthEvents[0].kind, "device_code");
    equal(oauthEvents[0].userCode, "KIMI-4321");
    equal(
      oauthEvents[0].verificationUri,
      "https://auth.kimi.com/device?code=KIMI-4321",
    );

    equal(snapAfterOAuth.active?.providerId, "kimi-coding");
    equal(snapAfterOAuth.active?.modelId, "k3.1-pro");
    equal(snapAfterOAuth.active?.authType, "oauth");
    equal(snapAfterOAuth.active?.brandId, "kimi");

    const kimiBrand = snapAfterOAuth.brands.find((b) => b.brandId === "kimi")!;
    assert(kimiBrand.configured, "Kimi brand should be configured");
    const kimiChannel = kimiBrand.channels.find(
      (c) => c.providerId === "kimi-coding",
    )!;
    assert(kimiChannel.hasOAuth, "kimi-coding should have OAuth");
    assert(
      typeof kimiChannel.oauthExpiresAt === "number",
      "oauthExpiresAt should be set",
    );
    equal(llmMobile.configuration().model, "k3.1-pro");
    equal(llmMobile.configuration().baseUrl, "https://api.kimi.com/coding/v1");
    equal(llmMobile.configuration().hasKey, true);

    // 6. OpenAI PKCE manual callback prompt + cancelProviderOAuth releases lock cleanly
    const openaiEvents: any[] = [];
    const pendingOpenai = llmMobile.startProviderOAuth(
      "openai",
      llmAction(),
      (ev) => {
        openaiEvents.push(ev);
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert(
      openaiEvents.some((ev) => ev.kind === "auth_url"),
      "OpenAI OAuth should emit auth_url",
    );
    llmMobile.cancelProviderOAuth();
    let cancelledError = false;
    try {
      await pendingOpenai;
    } catch {
      cancelledError = true;
    }
    assert(cancelledError, "Cancelled OpenAI OAuth should reject cleanly");
    const afterCancelSnap = await llmMobile.saveProviderApiKey(
      {
        providerId: "openai",
        apiKey: "sk-openai-after-cancel",
        modelId: "gpt-5.4",
      },
      llmAction(),
    );
    equal(afterCancelSnap.active?.providerId, "openai");
  } finally {
    globalThis.fetch = oauthFetch;
    AbortSignal.timeout = origTimeout;
  }
} finally {
  await llmMobile.close();
}
console.log(
  "PASS mobile LLM catalog: 6 brands, zai standard/coding distinction, api-key save/switch/remove, and kimi-coding OAuth flow",
);
