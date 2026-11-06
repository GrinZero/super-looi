import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
  Harness,
  createRegistry,
  AssistantEntry,
} from "@earendil-works/pi-durable";
import { createCodingTools } from "@earendil-works/pi-durable/tools";
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { NshExecutionEnv } from "../src/adapters/pi-durable-env.js";
import { readFileSync } from "node:fs";
import { assert, equal } from "./assert.js";
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
faux.setResponses([
  fauxAssistantMessage(
    fauxToolCall("write", { path: "durable.txt", content: "hello\n" }),
    { stopReason: "toolUse" },
  ),
  fauxAssistantMessage(
    fauxToolCall("edit", {
      path: "durable.txt",
      edits: [{ oldText: "hello", newText: "updated" }],
    }),
    { stopReason: "toolUse" },
  ),
  fauxAssistantMessage(fauxToolCall("read", { path: "durable.txt" }), {
    stopReason: "toolUse",
  }),
  fauxAssistantMessage(
    fauxToolCall("bash", { command: "cat durable.txt | grep updated" }),
    { stopReason: "toolUse" },
  ),
  fauxAssistantMessage("durable done"),
  fauxAssistantMessage("restored done"),
]);
const registry = createRegistry();
registry.install(createCodingTools());
const options = {
  models,
  registry,
  env: ({ cwd }: { cwd?: string }) =>
    new NshExecutionEnv({ cwd, namespace: "verification" }),
};
let harness = await Harness.open(
  await openNodeSqliteStorage("/durable.sqlite"),
  options,
  context,
);
let root = await harness.root(context, {
  agent: {
    model: { provider: faux.provider.id, modelId: faux.getModel().id },
    cwd: "/workspace",
    maxTurns: 8,
  },
});
const submission = await root.submit(
  { type: "input", content: "write/edit/read/bash", requestId: "request-one" },
  context,
);
const settled = await submission.wait(context);
assert(settled.status === "done", JSON.stringify(settled));
equal(readFileSync("/workspace/durable.txt", "utf8"), "updated\n");
const answer = await root.commit(
  (tx) => tx.entry(AssistantEntry, settled.answer),
  context,
);
assert(answer);
const id = root.id;
await harness.close(context);
harness = await Harness.open(
  await openNodeSqliteStorage("/durable.sqlite"),
  options,
  context,
);
root = await harness.root(context);
equal(root.id, id);
const restored = await harness.submission(submission.id, context);
assert(restored);
equal((await restored.wait(context)).status, "done");
const next = await root.submit(
  {
    type: "input",
    content: "continue after reopening",
    requestId: "request-two",
  },
  context,
);
equal((await next.wait(context)).status, "done");
await harness.close(context);
console.log(
  "PASS pi-durable@1.5.0: Harness, four upstream coding tools, SQLite journal reopen and continuation",
);
