import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, getCurrentTools, resolveTranscript } from "@earendil-works/pi-ai";
import { obj } from "@earendil-works/pi-schema";
import { PiAgentExecutor } from "../src/agent/pi-executor.js";

test("each task receives current plugin tools and standard Skill resources without rebuilding the executor", async () => {
  const root = mkdtempSync(join(tmpdir(), "looi-plugin-contribution-"));
  const skill = join(root, "plugin-skill"); mkdirSync(skill);
  writeFileSync(join(skill, "SKILL.md"), "---\nname: codex\ndescription: Delegate work to Codex.\n---\nUse the bundled agent.\n");
  const faux = fauxProvider(), models = createModels(); models.setProvider(faux.provider);
  let enabled = true, contributions = 0;
  const executor = new PiAgentExecutor({ stateDirectory: join(root, "agent"), workspaceRoot: join(root, "workspace"), modelsRegistry: models, modelSpec: faux.getModel(), streamFn: models.streamSimple.bind(models),
    taskTools(context) {
      contributions++; assert.equal(context.approvalMode, "yolo");
      return enabled ? { tools: [{ name: "codex_exec", label: "Codex EXEC", description: "Delegate", parameters: obj({}), execute: async () => ({ content: [{ type: "text", text: "Done" }] }) }], skillPaths: [skill] } : { tools: [], skillPaths: [] };
    },
  });
  try {
    faux.setResponses([ctx => { const transcript = resolveTranscript(ctx, undefined); assert.ok(getCurrentTools(transcript.messages).some(tool => tool.name === "codex_exec")); assert.match(JSON.stringify(transcript), /Delegate work to Codex/); return fauxAssistantMessage("Plugin available"); }]);
    assert.equal((await executor.run("List available work", { sessionId: "enabled", approvalMode: "yolo" })).answer, "Plugin available");
    enabled = false;
    faux.setResponses([ctx => { const transcript = resolveTranscript(ctx, undefined); assert.ok(!getCurrentTools(transcript.messages).some(tool => tool.name === "codex_exec")); assert.doesNotMatch(JSON.stringify(transcript), /Delegate work to Codex/); return fauxAssistantMessage("Plugin disabled"); }]);
    assert.equal((await executor.run("List available work", { sessionId: "disabled", approvalMode: "yolo" })).answer, "Plugin disabled");
    assert.equal(contributions, 2);
  } finally { await executor.close(); rmSync(root, { recursive: true, force: true }); }
});
