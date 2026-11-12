import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { PiAgentExecutor } from "../src/agent/pi-executor.js";

test("an unresponsive tool cannot turn a stop timeout into an exit receipt", async () => {
  const root = mkdtempSync(join(tmpdir(), "looi-stop-"));
  const faux = fauxProvider(),
    models = createModels();
  models.setProvider(faux.provider);
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>((resolve) => {
      release = resolve;
    }),
    entered = new Promise<void>((resolve) => {
      started = resolve;
    });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" }),
  ]);
  const executor = new PiAgentExecutor({
    stateDirectory: join(root, "state"),
    workspaceRoot: join(root, "workspace"),
    modelSpec: faux.getModel(),
    modelsRegistry: models, streamFn: models.streamSimple.bind(models),
    stopGraceMs: 15,
    customTools: [
      {
        name: "hold",
        label: "Unresponsive tool",
        description: "A trusted adapter that does not honor abort",
        parameters: { type: "object", properties: {} },
        execute: async () => {
          started();
          await gate;
          return {
            content: [{ type: "text", text: "late result" }],
            details: {},
          };
        },
      },
    ],
  });
  const running = executor.run("hold", { taskId: "unresponsive" });
  const rejected = assert.rejects(running);
  try {
    await entered;
    const stop = await executor.cancel("unresponsive");
    assert.deepEqual(stop, {
      state: "unknown",
      runtimeExited: false,
      confirmed: false,
    });
    const began = Date.now();
    await assert.rejects(executor.close(), /exit is unconfirmed/);
    assert.ok(
      Date.now() - began < 1000,
      "close waited indefinitely for a non-cooperative adapter",
    );
    assert.equal(executor.getTask("unresponsive")?.state, "unknown");
  } finally {
    release();
    await rejected;
    rmSync(root, { recursive: true, force: true });
  }
});
