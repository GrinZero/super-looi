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

test("assembleTurnContext injects multimodal ephemeral images and contextText once per initial turn", async () => {
  const root = mkdtempSync(join(tmpdir(), "looi-plugin-multimodal-"));
  const faux = fauxProvider({ models: [{ id: "faux-vision", input: ["text", "image"] }] });
  const models = createModels();
  models.setProvider(faux.provider);

  const jpegBase64 =
    "/9j/4AAQSkZJRgABAgAAAQABAAD/wAARCAABAAEDAREAAhEBAxEB/9sAQwAGBAUGBQQGBgUGBwcGCAoQCgoJCQoUDg8MEBcUGBgXFBYWGh0lHxobIxwWFiAsICMmJykqKRkfLTAtKDAlKCko/9sAQwEHBwcKCAoTCgoTKBoWGigoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgo/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDzqvjT+kT/2Q==";
  let assembleCalls = 0;

  const executor = new PiAgentExecutor({
    stateDirectory: join(root, "agent"),
    workspaceRoot: join(root, "workspace"),
    modelsRegistry: models,
    modelSpec: faux.getModel("faux-vision"),
    streamFn: models.streamSimple.bind(models),
    assembleTurnContext: async ({ prompt }) => {
      assembleCalls++;
      return {
        contextText: `[VisionPlugin] Active tracking for: ${prompt}`,
        images: [{ type: "image", data: jpegBase64, mimeType: "image/jpeg" }],
      };
    },
  });

  try {
    faux.setResponses([
      (ctx) => {
        const transcript = resolveTranscript(ctx, undefined);
        const serialized = JSON.stringify(transcript);
        assert.match(serialized, /\[VisionPlugin\] Active tracking for: Who is in front of LOOI\?/);
        assert.ok(
          serialized.includes(jpegBase64),
          "Multimodal base64 JPEG payload must reach the model turn transcript",
        );
        return fauxAssistantMessage("I see Alice waving at LOOI.");
      },
    ]);
    const res = await executor.run("Who is in front of LOOI?", {
      sessionId: "vision_sess_1",
      approvalMode: "yolo",
    });
    assert.equal(res.answer, "I see Alice waving at LOOI.");
    assert.equal(assembleCalls, 1, "assembleTurnContext must execute only once on initial turn");
  } finally {
    await executor.close();
    rmSync(root, { recursive: true, force: true });
  }
});
