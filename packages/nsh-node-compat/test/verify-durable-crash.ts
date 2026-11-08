import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai";
import { assert, equal } from "./assert.js";
declare global {
  var __crash_phase: number;
}
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
faux.setResponses([
  globalThis.__crash_phase === 1
    ? async () => {
        console.log("CRASH_READY");
        return await new Promise<never>(() => {});
      }
    : fauxAssistantMessage("recovered"),
]);
const harness = await Harness.open(
  await openNodeSqliteStorage("/crash.sqlite"),
  { models, registry: createRegistry() },
  context,
);
const root = await harness.root(context, {
  agent: {
    model: { provider: faux.provider.id, modelId: faux.getModel().id },
    maxTurns: 2,
  },
});
const submission = await root.submit(
  {
    type: "input",
    content: "recover this persisted request",
    requestId: "crash-input",
  },
  context,
);
const settled = await submission.wait(context);
assert(
  globalThis.__crash_phase === 2,
  "first host should have been killed while generation was pending",
);
equal(settled.status, "done");
const same = await root.submit(
  {
    type: "input",
    content: "recover this persisted request",
    requestId: "crash-input",
  },
  context,
);
equal(same.id, submission.id);
equal(faux.state.callCount, 1);
await harness.close(context);
console.log(
  "PASS durable crash recovery: SIGKILL during pending generation, SQLite journal reopen, one resumed generation and request-id deduplication",
);
