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
  const tool = round++ === 0;
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
    blocked = String(error).includes("待核实");
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
