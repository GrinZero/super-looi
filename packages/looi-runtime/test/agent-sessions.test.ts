import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall, getCurrentSystemMessage, resolveTranscript } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { PiAgentExecutor } from "../src/agent/pi-executor.js";

for (const outcome of ["failed", "cancelled"] as const) {
  test(`JSONL checkpoints survive ${outcome} tasks and executor restart`, async () => {
    const root = mkdtempSync(join(tmpdir(), "looi-session-"));
    const workspaceRoot = join(root, "work");
    const sessionsDirectory = join(root, "state/sessions");
    const sessionId = `voice_${outcome}`;
    const faux = fauxProvider(), models = createModels();
    models.setProvider(faux.provider);
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const make = () => new PiAgentExecutor({
      stateDirectory: join(root, "state"), workspaceRoot,
      modelSpec: faux.getModel(), modelsRegistry: models, streamFn: models.streamSimple.bind(models),
      customTools: [{
        name: "checkpoint", label: "Checkpoint", description: "Wait for the test to inspect saved messages",
        parameters: { type: "object", properties: {} },
        execute: async () => {
          entered();
          await held;
          return { content: [{ type: "text" as const, text: "Recorded tool result" }], details: {} };
        },
      }],
    });
    let executor = make();
    const saved = () => SessionManager.open(SessionManager.findById(workspaceRoot, sessionId, sessionsDirectory)!);
    try {
      faux.setResponses([
        () => {
          assert.match(JSON.stringify(saved().buildSessionContext().messages), /Remember CHECKPOINT/);
          return fauxAssistantMessage(fauxToolCall("checkpoint", {}), { stopReason: "toolUse" });
        },
        fauxAssistantMessage("", { stopReason: "error", errorMessage: "Provider failed" }),
      ]);
      const running = executor.run("Remember CHECKPOINT", { taskId: "interrupted", sessionId });
      const rejected = assert.rejects(running);
      await started;
      const file = saved().getSessionFile()!;
      assert.match(file, new RegExp(`_${sessionId}\\.jsonl$`));
      const entries = readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line));
      assert.equal(entries[0].type, "session");
      assert.equal(entries[0].id, sessionId);
      assert.equal(entries[0].cwd, workspaceRoot);
      assert.ok(entries.some(entry => entry.message?.role === "user"));
      assert.ok(entries.some(entry => entry.message?.stopReason === "toolUse"));
      if (outcome === "cancelled") {
        const stopping = executor.cancel("interrupted");
        release();
        assert.equal((await stopping).confirmed, true);
      } else release();
      await rejected;
      assert.equal(executor.getTask("interrupted")?.state, outcome);
      const messages = saved().buildSessionContext().messages;
      assert.equal(messages.filter(message => message.role === "user").length, 1);
      assert.ok(messages.some(message => message.role === "toolResult"), "tool result after cancellation is still saved");
      if (outcome === "failed") {
        assert.ok(messages.some(message => message.role === "assistant" && message.stopReason === "error"));
      }
      await executor.close();
      executor = make();
      faux.setResponses([context => {
        const history = resolveTranscript(context, undefined).messages;
        assert.match(JSON.stringify(history), /Remember CHECKPOINT/);
        assert.ok(history.some(message => message.role === "toolResult"));
        return fauxAssistantMessage("CHECKPOINT retained");
      }]);
      await executor.run("Continue", { sessionId });
      assert.equal(saved().getSessionFile(), file);
      assert.equal(saved().buildSessionContext().messages.filter(message => message.role === "user").length, 2);
      assert.equal(readdirSync(sessionsDirectory).length, 1);
    } finally {
      release();
      await executor.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("legacy JSON is ignored and explicit resume requires a JSONL session", async () => {
  const root = mkdtempSync(join(tmpdir(), "looi-session-break-"));
  const workspaceRoot = join(root, "work"), stateDirectory = join(root, "state");
  const sessionsDirectory = join(stateDirectory, "sessions");
  mkdirSync(sessionsDirectory, { recursive: true });
  const legacy = JSON.stringify([{ role: "user", content: "OLD HISTORY", timestamp: Date.now() }]);
  writeFileSync(join(sessionsDirectory, "legacy.json"), legacy);
  const faux = fauxProvider(), models = createModels();
  models.setProvider(faux.provider);
  const executor = new PiAgentExecutor({
    stateDirectory, workspaceRoot, modelSpec: faux.getModel(), modelsRegistry: models, streamFn: models.streamSimple.bind(models),
    systemPrompt: "Household lamps use the home service independently of the robot dock.",
  });
  try {
    faux.setResponses([context => {
      const transcript = resolveTranscript(context, undefined).messages;
      assert.match(JSON.stringify(transcript.filter(message => message.role === "system")), /Household lamps use the home service independently of the robot dock/);
      const messages = transcript.filter(message => message.role !== "system");
      assert.equal(messages.length, 1);
      assert.doesNotMatch(JSON.stringify(messages), /OLD HISTORY/);
      return fauxAssistantMessage("Fresh JSONL history");
    }]);
    await executor.run("New request", { sessionId: "legacy", taskId: "new_request" });
    assert.equal(readFileSync(join(sessionsDirectory, "legacy.json"), "utf8"), legacy);
    const file = SessionManager.findById(workspaceRoot, "legacy", sessionsDirectory)!;
    rmSync(file);
    await assert.rejects(
      executor.run("Resume", { taskId: "new_request", resume: true }),
      /Persisted session transcript was not found/,
    );
  } finally {
    await executor.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("multi-turn runs preserve structured prompt sections and emit targeted turn_context diffs", async () => {
  const root = mkdtempSync(join(tmpdir(), "looi-sections-"));
  const workspaceRoot = join(root, "work");
  const stateDirectory = join(root, "state");
  mkdirSync(workspaceRoot, { recursive: true });
  const contexts = ["turn context one", "turn context two", undefined];
  const faux = fauxProvider(), models = createModels();
  models.setProvider(faux.provider);
  const executor = new PiAgentExecutor({
    stateDirectory,
    workspaceRoot,
    modelSpec: faux.getModel(),
    modelsRegistry: models,
    streamFn: models.streamSimple.bind(models),
    systemPrompt: "App domain instructions stay stable across turns.",
    assembleTurnContext: () => {
      const text = contexts.shift();
      return text ? { contextText: text } : undefined;
    },
  });
  const capturedSystems: Array<ReturnType<typeof getCurrentSystemMessage>> = [];
  const rawDeltas: Array<any[]> = [];
  try {
    faux.setResponses([
      (ctx) => {
        rawDeltas.push(ctx.messages.filter((m) => m.role === "system"));
        capturedSystems.push(getCurrentSystemMessage(resolveTranscript(ctx, undefined).messages));
        return fauxAssistantMessage("First reply");
      },
      (ctx) => {
        rawDeltas.push(ctx.messages.filter((m) => m.role === "system"));
        capturedSystems.push(getCurrentSystemMessage(resolveTranscript(ctx, undefined).messages));
        return fauxAssistantMessage("Second reply");
      },
      (ctx) => {
        rawDeltas.push(ctx.messages.filter((m) => m.role === "system"));
        capturedSystems.push(getCurrentSystemMessage(resolveTranscript(ctx, undefined).messages));
        return fauxAssistantMessage("Third reply");
      },
    ]);

    await executor.run("First turn", { sessionId: "sections_session", taskId: "sec_1" });
    await executor.run("Second turn", { sessionId: "sections_session", taskId: "sec_2" });
    await executor.run("Third turn", { sessionId: "sections_session", taskId: "sec_3" });

    assert.equal(capturedSystems[0]?.content, "");
    assert.match(capturedSystems[0]?.sections?.app_instructions ?? "", /App domain instructions stay stable/);
    assert.match(capturedSystems[0]?.sections?.turn_context ?? "", /turn context one/);

    assert.equal(capturedSystems[1]?.content, "");
    assert.match(capturedSystems[1]?.sections?.turn_context ?? "", /turn context two/);
    assert.match(capturedSystems[1]?.sections?.app_instructions ?? "", /App domain instructions stay stable/);
    assert.deepEqual(Object.keys(rawDeltas[1]?.at(-1)?.sections ?? {}), ["turn_context"]);

    assert.equal(capturedSystems[2]?.content, "");
    assert.equal(capturedSystems[2]?.sections?.turn_context, undefined);
    assert.match(capturedSystems[2]?.sections?.app_instructions ?? "", /App domain instructions stay stable/);
    assert.equal(rawDeltas[2]?.at(-1)?.sections?.turn_context, null);
  } finally {
    await executor.close();
    rmSync(root, { recursive: true, force: true });
  }
});
