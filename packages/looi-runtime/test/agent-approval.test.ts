import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { AgentStepEvent, AgentTaskState } from "../src/agent/executor.js";
import { PiAgentExecutor } from "../src/agent/pi-executor.js";

test("additional tool rules drive the existing approval interaction before execution", async () => {
  for (const outcome of ["allowed-once", "rejected", "cancelled"] as const) {
    const root = mkdtempSync(join(tmpdir(), "looi-agent-approval-"));
    const faux = fauxProvider(), models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("publish", { target: "draft" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Finished"),
    ]);
    let executed = false;
    let approvalEvent: AgentStepEvent | undefined;
    let approvalState: AgentTaskState | undefined;
    let executedWhenAsked: boolean | undefined;
    const executor = new PiAgentExecutor({
      stateDirectory: join(root, "state"), workspaceRoot: join(root, "workspace"),
      modelSpec: faux.getModel(), modelsRegistry: models, streamFn: models.streamSimple.bind(models),
      additionalTools: [{
        name: "publish", label: "Publish", description: "Publish a draft",
        parameters: { type: "object", properties: { target: { type: "string" } } },
        async execute() {
          executed = true;
          return { content: [{ type: "text", text: "published" }], details: {} };
        },
      }],
      toolApprovalRules: { publish: ({ arguments: args }) => ({ operation: "publish", target: args.target }) },
    });
    try {
      const result = await executor.run("publish", { onStep(event) {
        if (event.interaction?.kind !== "approval") return;
        approvalEvent = event;
        approvalState = executor.getTask(event.taskId!)?.state;
        executedWhenAsked = executed;
        executor.respond(event.taskId!, event.interaction.id, { outcome });
      }});
      assert.ok(approvalEvent?.interaction);
      assert.equal(executedWhenAsked, false);
      assert.equal(approvalState, "awaiting_approval");
      assert.equal(typeof approvalEvent.interaction.details.callId, "string");
      assert.deepEqual(approvalEvent.interaction.details, {
        callId: approvalEvent.interaction.details.callId, toolName: "publish", sessionId: result.sessionId,
        operation: "publish", target: "draft",
      });
      assert.equal(executed, outcome === "allowed-once");
      assert.equal(executor.getTask(result.taskId)?.interaction, undefined);
    } finally {
      await executor.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
});
