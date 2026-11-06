import { MobileRuntime } from "../../../apps/nsh/runtime/application.js";
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
    get: () => saved,
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
  get: () => saved,
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
  await mobile.configure({ ...oldConfig, model: "new-account" });
  assert(
    JSON.parse(saved).conversationId !== conversation,
    "Changing model configuration must rotate conversation identity",
  );
  await mobile.run("Hello", action(), () => {});
  assert(
    !JSON.stringify(prompts[2]).includes("ORCHID"),
    "Configuration switch leaked prior conversation",
  );
} finally {
  globalThis.fetch = nativeFetch;
  await mobile.close();
}
console.log(
  "PASS mobile conversation: independent tasks, persisted transcript after reopen, configuration isolation",
);
