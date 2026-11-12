import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentText, createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentTools, resolveTranscript } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createSessionsTool } from "../src/agent/tools/sessions.js";
import { PiAgentExecutor } from "../src/agent/pi-executor.js";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "looi-sessions-tool-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspaceRoot = join(root, "workspace"), stateDirectory = join(root, "state");
  const sessionsDirectory = join(stateDirectory, "sessions");
  mkdirSync(workspaceRoot, { recursive: true });
  mkdirSync(sessionsDirectory, { recursive: true });
  return { root, workspaceRoot, stateDirectory, sessionsDirectory,
    tool: createSessionsTool({ workspaceRoot, sessionsDirectory, sessionId: "current" }),
    session: (id: string) => SessionManager.create(workspaceRoot, sessionsDirectory, { id }),
  };
}

test("task agent lists, searches and reads another session through its normal tool loop", async t => {
  const f = fixture(t);
  const previous = f.session("voice_previous");
  previous.appendMessage({ role: "user", content: "Remember ORCHID for the order", timestamp: 1 });
  const order = fauxToolCall("order", { code: "ORCHID", sugar: false });
  previous.appendMessage(fauxAssistantMessage(order, { stopReason: "toolUse" }));
  previous.appendMessage({ role: "toolResult", toolCallId: order.id, toolName: "order", isError: true,
    content: [{ type: "text", text: "Order write rejected: E_ORDER_503" }], timestamp: 2 });
  previous.appendSessionInfo("Coffee order");
  const original = readFileSync(previous.getSessionFile()!, "utf8");
  const faux = fauxProvider(), models = createModels();
  models.setProvider(faux.provider);
  const executor = new PiAgentExecutor({ workspaceRoot: f.workspaceRoot, stateDirectory: f.stateDirectory,
    modelsRegistry: models, providerId: faux.getModel().provider, model: faux.getModel().id,
    requireApprovalForAllWrites: true,
  });
  const lastResult = (ctx: Parameters<typeof resolveTranscript>[0]) => {
    const last = resolveTranscript(ctx, undefined).messages.at(-1)!;
    assert.equal(last.role, "toolResult");
    return JSON.parse(contentText(last.content));
  };
  let approvals = 0;
  try {
    faux.setResponses([
      ctx => {
        assert.ok(getCurrentTools(resolveTranscript(ctx, undefined).messages).some(tool => tool.name === "sessions"));
        assert.doesNotMatch(JSON.stringify(resolveTranscript(ctx, undefined)), /ORCHID/);
        return fauxAssistantMessage(fauxToolCall("sessions", { action: "list" }), { stopReason: "toolUse" });
      },
      ctx => {
        const previous = lastResult(ctx).items.find((item: any) => item.sessionId === "voice_previous");
        assert.equal(previous.name, "Coffee order");
        assert.equal(lastResult(ctx).total, 1);
        return fauxAssistantMessage(fauxToolCall("sessions", { action: "search", query: "orchid", limit: 1 }), { stopReason: "toolUse" });
      },
      ctx => {
        const page = lastResult(ctx);
        assert.equal(page.total, 2);
        assert.equal(page.items[0].sessionId, "voice_previous");
        assert.match(page.items[0].snippet, /ORCHID/);
        return fauxAssistantMessage(fauxToolCall("sessions", { action: "search", query: "orchid", limit: 1, cursor: page.nextCursor }), { stopReason: "toolUse" });
      },
      ctx => {
        const page = lastResult(ctx);
        assert.equal(page.total, 2, "search receipts must not become new matches");
        assert.equal(page.nextCursor, null);
        const match = page.items[0];
        assert.equal(match.sessionId, "voice_previous");
        return fauxAssistantMessage(fauxToolCall("sessions", { action: "read", sessionId: match.sessionId, cursor: match.readCursor }), { stopReason: "toolUse" });
      },
      ctx => {
        const result = lastResult(ctx);
        assert.match(result.text, /Tool call order.*"sugar":false/);
        assert.match(result.text, /isError=true:[\s\S]*E_ORDER_503/);
        return fauxAssistantMessage(fauxToolCall("sessions", { action: "read", sessionId: "missing" }), { stopReason: "toolUse" });
      },
      ctx => {
        const last = resolveTranscript(ctx, undefined).messages.at(-1)!;
        assert.ok(last.role === "toolResult" && last.isError);
        assert.equal(lastResult(ctx).code, "SESSION_NOT_FOUND");
        return fauxAssistantMessage("The previous order write failed with E_ORDER_503.");
      },
    ]);
    const result = await executor.run("Look up the earlier order", { sessionId: "current", onStep(event) {
      if (event.interaction) { approvals++; executor.respond(event.taskId!, event.interaction.id, { outcome: "allowed-once" }); }
    } });
    assert.equal(result.answer, "The previous order write failed with E_ORDER_503.");
    assert.equal(approvals, 0);
    const saved = SessionManager.open(SessionManager.findById(f.workspaceRoot, "current", f.sessionsDirectory)!);
    assert.ok(saved.getEntries().some(entry => entry.type === "message" && entry.message.role === "toolResult" &&
      entry.message.isError && contentText(entry.message.content).includes("SESSION_NOT_FOUND")));
    assert.equal(readFileSync(previous.getSessionFile()!, "utf8"), original);
  } finally { await executor.close(); }
});

test("history follows the active branch and pages through original pre-compaction tool output", async t => {
  const f = fixture(t), session = f.session("large");
  const root = session.appendMessage({ role: "user", content: "Inspect the old export", timestamp: 1 });
  session.appendMessage(fauxAssistantMessage("ABANDONED_BRANCH"));
  session.branch(root);
  const output = "Export row\n".repeat(2000) + "ORIGINAL_EXPORT_END";
  const exportCall = fauxToolCall("export", {});
  session.appendMessage(fauxAssistantMessage(exportCall, { stopReason: "toolUse" }));
  const sourceId = session.appendMessage({ role: "toolResult", toolCallId: exportCall.id, toolName: "export", isError: false,
    content: [{ type: "text", text: output }], timestamp: 2 });
  const recent = session.appendMessage({ role: "user", content: "Continue after the export", timestamp: 3 });
  session.appendCompaction("The export finished. Details omitted.", recent, 10000);
  assert.doesNotMatch(JSON.stringify(session.buildSessionContext().messages), /ORIGINAL_EXPORT_END/);
  const file = session.getSessionFile()!;
  // Reading through the tool must not perform Pi's on-open newline repair.
  writeFileSync(file, readFileSync(file, "utf8").trimEnd());
  const original = readFileSync(file, "utf8");
  const search = await f.tool.execute("find", { action: "search", query: "original_export_end" });
  assert.ok(!search.isError);
  const match = JSON.parse(contentText(search.content)).items[0];
  assert.equal(match.entryId, sourceId);
  let cursor: number | null = match.readCursor, text = "", pages = 0;
  while (cursor !== null) {
    const result = await f.tool.execute("read", { action: "read", sessionId: "large", cursor });
    assert.ok(!result.isError);
    const page = JSON.parse(contentText(result.content));
    assert.ok(page.text.length <= 12000);
    text += page.text; cursor = page.nextCursor; pages++;
  }
  assert.ok(pages > 1);
  assert.ok(text.includes(output));
  assert.match(text, /Details omitted/);
  assert.doesNotMatch(text, /ABANDONED_BRANCH/);
  assert.equal(readFileSync(file, "utf8"), original);
});

test("list and search pagination can resume across multiple sessions", async t => {
  const f = fixture(t);
  for (const id of ["one", "two", "three"]) {
    f.session(id).appendMessage({ role: "user", content: `Coffee ${id}`, timestamp: 1 });
  }
  for (const action of ["list", "search"] as const) {
    const ids = [];
    let cursor: number | null = 0;
    while (cursor !== null) {
      const result = await f.tool.execute("page", { action, query: "coffee", limit: 1, cursor });
      const page = JSON.parse(contentText(result.content));
      assert.equal(page.total, 3);
      ids.push(page.items[0].sessionId); cursor = page.nextCursor;
    }
    assert.deepEqual(ids.sort(), ["one", "three", "two"]);
  }
});

test("directory and JSONL failures retain their actual stage, code and source location", async t => {
  const f = fixture(t);
  const file = join(f.root, "not-a-directory");
  writeFileSync(file, "text");
  const brokenDirectory = createSessionsTool({ workspaceRoot: f.workspaceRoot, sessionsDirectory: file, sessionId: "current" });
  const listed = await brokenDirectory.execute("list", { action: "list" });
  assert.equal(listed.isError, true);
  const directoryFailure = JSON.parse(contentText(listed.content));
  assert.equal(directoryFailure.stage, "list_directory");
  assert.equal(directoryFailure.code, "ENOTDIR");
  assert.equal(directoryFailure.path, file);
  const session = f.session("broken");
  session.appendMessage({ role: "user", content: "Coffee", timestamp: 1 });
  writeFileSync(session.getSessionFile()!, "{\"type\":\"session\",\"id\":\"broken\"}\n{not json}\n");
  const searched = await f.tool.execute("search", { action: "search", query: "coffee" });
  assert.equal(searched.isError, true);
  const parseFailure = JSON.parse(contentText(searched.content));
  assert.equal(parseFailure.stage, "parse_session");
  assert.equal(parseFailure.path, session.getSessionFile());
  assert.equal(parseFailure.line, 2);
  assert.match(parseFailure.reason, /JSON|property name/);
  const good = f.session("good");
  good.appendMessage({ role: "user", content: "Unaffected session", timestamp: 1 });
  const read = await f.tool.execute("read", { action: "read", sessionId: "good" });
  assert.ok(!read.isError);
  assert.match(JSON.parse(contentText(read.content)).text, /Unaffected session/);
  const current = await f.tool.execute("current", { action: "read", sessionId: "current" });
  assert.equal(current.isError, true);
  assert.equal(JSON.parse(contentText(current.content)).code, "CURRENT_SESSION");
});
