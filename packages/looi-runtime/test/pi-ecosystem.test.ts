import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentTools, resolveTranscript } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { PiAgentExecutor, type PiExecutorConfig } from "../src/agent/pi-executor.js";

function fixture(config: Partial<PiExecutorConfig> = {}, fauxOptions?: Parameters<typeof fauxProvider>[0]) {
  const root = mkdtempSync(join(tmpdir(), "looi-pi-sdk-"));
  const workspaceRoot = join(root, "workspace"), stateDirectory = join(root, "agent");
  mkdirSync(workspaceRoot, { recursive: true });
  mkdirSync(stateDirectory, { recursive: true });
  const faux = fauxProvider(fauxOptions), models = createModels();
  models.setProvider(faux.provider);
  const executor = new PiAgentExecutor({
    workspaceRoot, stateDirectory, modelsRegistry: models,
    providerId: faux.getModel().provider, model: faux.getModel().id,
    ...config,
  });
  return { root, workspaceRoot, stateDirectory, faux, models, executor,
    session(id: string) { return SessionManager.open(SessionManager.findById(workspaceRoot, id, join(stateDirectory, "sessions"))!); },
    async close() { await executor.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

test("official resources discover project rules, skills, templates and extension tools", async () => {
  const f = fixture();
  try {
    const skillDir = join(f.workspaceRoot, ".pi/skills/coffee");
    mkdirSync(skillDir, { recursive: true });
    mkdirSync(join(f.workspaceRoot, ".pi/prompts"), { recursive: true });
    mkdirSync(join(f.workspaceRoot, ".pi/extensions"), { recursive: true });
    writeFileSync(join(f.workspaceRoot, "AGENTS.md"), "PROJECT_RULE_MARKER: keep the coffee warm.\n");
    writeFileSync(join(skillDir, "SKILL.md"), "---\nname: coffee\ndescription: Remember coffee orders.\n---\nSKILL_BODY_MARKER: ask about sugar.\n");
    writeFileSync(join(f.workspaceRoot, ".pi/prompts/order.md"), "Prepare coffee for $1.\n");
    writeFileSync(join(f.workspaceRoot, ".pi/extensions/order.ts"), `export default pi => {
      pi.on("session_start", () => pi.appendEntry("coffee_started", { connected: true }));
      pi.registerTool({name:"coffee_order", label:"Coffee order", description:"Read a coffee order", parameters:{type:"object",properties:{}}, execute:async()=>({content:[{type:"text",text:"no sugar"}],details:{}})});
    };`);
    f.faux.setResponses([
      ctx => {
        const text = JSON.stringify(resolveTranscript(ctx, undefined));
        assert.match(text, /PROJECT_RULE_MARKER/);
        assert.match(text, /Remember coffee orders/);
        assert.doesNotMatch(text, /SKILL_BODY_MARKER/);
        assert.match(text, /Prepare coffee for Ada/);
        assert.match(text, /coffee_order/);
        return fauxAssistantMessage(fauxToolCall("coffee_order", {}), { stopReason: "toolUse" });
      },
      ctx => {
        assert.match(JSON.stringify(resolveTranscript(ctx, undefined).messages.at(-1)), /no sugar/);
        return fauxAssistantMessage("Order read");
      },
      ctx => {
        assert.match(JSON.stringify(resolveTranscript(ctx, undefined)), /SKILL_BODY_MARKER/);
        return fauxAssistantMessage("Skill loaded");
      },
    ]);
    assert.equal((await f.executor.run("/order Ada", { sessionId: "resources" })).answer, "Order read");
    assert.ok(f.session("resources").getEntries().some(entry => entry.type === "custom" && entry.customType === "coffee_started"));
    assert.equal((await f.executor.run("/skill:coffee", { sessionId: "resources" })).answer, "Skill loaded");
  } finally { await f.close(); }
});

test("Pi standard write, edit and bounded read preserve approval and artifacts", async () => {
  const f = fixture({ requireApprovalForAllWrites: true });
  let approvals = 0;
  try {
    f.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("write", { path: "order.txt", content: "tea\nsugar\n" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("edit", { path: "order.txt", edits: [{ oldText: "sugar", newText: "no sugar" }] }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("read", { path: "order.txt", offset: 2, limit: 1 }), { stopReason: "toolUse" }),
      ctx => {
        const last = resolveTranscript(ctx, undefined).messages.at(-1)!;
        assert.match(JSON.stringify(last), /no sugar/);
        assert.doesNotMatch(JSON.stringify(last), /tea/);
        return fauxAssistantMessage("Verified order");
      },
    ]);
    const result = await f.executor.run("Update the order", { onStep(event) {
      if (event.interaction?.kind !== "approval") return;
      approvals++;
      f.executor.respond(event.taskId!, event.interaction.id, { outcome: "allowed-once" });
    } });
    assert.equal(approvals, 2);
    assert.equal(readFileSync(join(f.workspaceRoot, "order.txt"), "utf8"), "tea\nno sugar\n");
    assert.ok(result.artifacts?.some(item => item.path === "order.txt"));
  } finally { await f.close(); }
});

test("Pi extension dialogs and notifications reach the App interaction surface", async () => {
  const f = fixture({ resources: { extensionFactories: [(pi) => {
    pi.registerTool({ name: "choose_order", label: "Choose order", description: "Ask for an order", parameters: { type: "object", properties: {} },
      execute: async (_id, _params, _signal, _update, ctx) => {
        ctx.ui.notify("Order extension connected");
        const choice = await ctx.ui.select("Choose a drink", ["coffee", "tea"]);
        const approved = await ctx.ui.confirm("Confirm order", String(choice));
        return { content: [{ type: "text", text: `${choice}:${approved}` }], details: {} };
      },
    });
  }] } });
  try {
    f.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("choose_order", {}), { stopReason: "toolUse" }),
      ctx => {
        assert.match(JSON.stringify(resolveTranscript(ctx, undefined).messages.at(-1)), /coffee:true/);
        return fauxAssistantMessage("Order confirmed");
      },
    ]);
    const result = await f.executor.run("Choose a drink", { onStep(event) {
      if (!event.interaction) return;
      f.executor.respond(event.taskId!, event.interaction.id,
        event.interaction.kind === "approval" ? { outcome: "allowed-once" } : {
          answers: [{ id: (event.interaction.details.questions as Array<{ id: string }>)[0].id, selected: ["coffee"] }],
        });
    } });
    assert.ok(result.steps.some(step => step.summary === "Order extension connected"));
  } finally { await f.close(); }
});

test("standard extension commands complete without requiring a model response", async () => {
  const f = fixture({ resources: { extensionFactories: [(pi) => {
    pi.registerCommand("ping", { description: "Ping the extension", handler: async (_args, ctx) => { ctx.ui.notify("Command succeeded"); } });
    pi.registerCommand("broken", { description: "Expose command failure", handler: async () => { throw new Error("E_COMMAND: fixture refused"); } });
  }] } });
  try {
    const result = await f.executor.run("/ping");
    assert.equal(result.answer, "Command succeeded");
    assert.equal(result.finishReason, "handled");
    assert.equal(f.faux.state.callCount, 0);
    await assert.rejects(f.executor.run("/broken"), /E_COMMAND: fixture refused/);
  } finally { await f.close(); }
});

test("Pi codemode-only settings and standard tool selection remain authoritative", async () => {
  for (const only of [false, true]) {
    const f = fixture({ settings: { defaultTools: only ? ["read", "write", "codemode"] : ["read"], codemode: { mode: only ? "only" : "on" } } });
    try {
      f.faux.setResponses([ctx => {
        const names = getCurrentTools(resolveTranscript(ctx, undefined).messages).map(tool => tool.name);
        if (only) assert.deepEqual(names, ["codemode"]);
        else { assert.ok(names.includes("read")); assert.ok(!names.includes("bash")); }
        return fauxAssistantMessage("Selection respected");
      }]);
      await f.executor.run("Inspect tools");
    } finally { await f.close(); }
  }
});

test("cancellation waits for startup and never starts extensions after cancellation", async () => {
  let entered!: () => void, release!: () => void, effects = 0;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const f = fixture({ stopGraceMs: 15, resources: { extensionFactories: [async (pi) => {
    entered(); await held;
    pi.on("session_start", () => { effects++; });
  }] } });
  try {
    const run = f.executor.run("Start", { taskId: "startup" });
    const rejected = assert.rejects(run, /stop|startup/);
    await started;
    assert.deepEqual(await f.executor.cancel("startup"), { state: "unknown", runtimeExited: false, confirmed: false });
    release();
    await rejected;
    assert.equal(effects, 0);
    assert.equal(f.faux.state.callCount, 0);
  } finally { release(); await f.close(); }
});

test("an unresponsive extension shutdown stays unknown and cannot hang task completion", async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const f = fixture({ stopGraceMs: 15, resources: { extensionFactories: [(pi) => {
    pi.on("session_shutdown", () => held);
  }] } });
  try {
    f.faux.setResponses([fauxAssistantMessage("Done")]);
    await assert.rejects(f.executor.run("Run", { taskId: "shutdown" }), /Pi session shutdown exceeded 15 ms/);
    assert.equal(f.executor.getTask("shutdown")?.state, "unknown");
    assert.equal(f.executor.getTask("shutdown")?.runtimeExited, false);
  } finally { release(); await f.close(); }
});

test("cancellation during extension shutdown cannot return a completed task", async () => {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const f = fixture({ resources: { extensionFactories: [(pi) => {
    pi.on("session_shutdown", () => { entered(); return held; });
  }] } });
  try {
    f.faux.setResponses([fauxAssistantMessage("Done")]);
    const run = f.executor.run("Run", { taskId: "shutdown-cancel" });
    const rejected = assert.rejects(run, /cancel/i);
    await started;
    const cancellation = f.executor.cancel("shutdown-cancel");
    release();
    assert.deepEqual(await cancellation, { state: "cancelled", runtimeExited: true, confirmed: true });
    await rejected;
    assert.equal(f.executor.getTask("shutdown-cancel")?.result?.finishReason, "cancelled");
  } finally { release(); await f.close(); }
});

test("Pi retries transient model errors before the App completes the task", async () => {
  const f = fixture({ settings: { retry: { enabled: true, baseDelayMs: 1, maxRetries: 1 } } });
  try {
    f.faux.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 rate limit: provider busy" }),
      fauxAssistantMessage("Recovered"),
    ]);
    const result = await f.executor.run("Try the provider", { sessionId: "retry" });
    assert.equal(result.answer, "Recovered");
    assert.equal(f.faux.state.callCount, 2);
    assert.ok(result.steps.some(step => step.summary.includes("429 rate limit: provider busy")));
    assert.equal(f.executor.getTask(result.taskId)?.state, "succeeded");
    assert.ok(f.session("retry").getEntries().some(entry => entry.type === "context_edit"));
  } finally { await f.close(); }
});

for (const behavior of ["steer", "followUp"] as const) {
  test(`Pi ${behavior} queues a message during a running tool`, async () => {
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const f = fixture({ additionalTools: [{ name: "hold", label: "Hold", description: "Wait for input", parameters: { type: "object", properties: {} },
      execute: async () => { entered(); await held; return { content: [{ type: "text", text: "released" }], details: {} }; },
    }] });
    try {
      f.faux.setResponses([
        fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" }),
        ...(behavior === "followUp" ? [fauxAssistantMessage("First answer")] : []),
        ctx => {
          assert.match(JSON.stringify(resolveTranscript(ctx, undefined)), /SUPPLEMENT/);
          return fauxAssistantMessage("Supplement processed");
        },
      ]);
      const running = f.executor.run("Start", { taskId: "queued", sessionId: "queue" });
      await started;
      assert.equal(await f.executor.sendMessage("queued", "SUPPLEMENT", behavior), "queued");
      release();
      assert.equal((await running).answer, "Supplement processed");
      assert.match(JSON.stringify(f.session("queue").buildSessionContext().messages), /SUPPLEMENT/);
    } finally { release(); await f.close(); }
  });
}

test("Pi automatic compaction persists a summary and reuses it after restart", async () => {
  const f = fixture({ settings: { compaction: { enabled: true, reserveTokens: 512, keepRecentTokens: 64 } } }, {
    models: [{ id: "compact", contextWindow: 4096, maxTokens: 512 }],
  });
  try {
    const answer = fauxAssistantMessage("ORCHID retained");
    f.faux.setResponses([
      answer,
      fauxAssistantMessage("ORCHID retained again"),
      ctx => {
        assert.match(JSON.stringify(resolveTranscript(ctx, undefined)), /structured context checkpoint/);
        return fauxAssistantMessage("Goal: remember ORCHID. Progress: stored the code.");
      },
      ctx => {
        const text = JSON.stringify(resolveTranscript(ctx, undefined));
        assert.match(text, /Goal: remember ORCHID/);
        return fauxAssistantMessage("ORCHID");
      },
    ]);
    await f.executor.run("Remember ORCHID. " + "Earlier conversation. ".repeat(900), { sessionId: "compact" });
    const result = await f.executor.run("Keep the code for the next question. " + "Recent context. ".repeat(25), { sessionId: "compact" });
    const raw = f.session("compact");
    assert.ok(raw.getEntries().some(entry => entry.type === "compaction"), JSON.stringify({ calls: f.faux.state.callCount, steps: result.steps }));
    assert.ok(raw.getEntries().some(entry => entry.type === "message" && JSON.stringify(entry).includes("Earlier conversation")));
    await f.executor.close();
    const resumed = new PiAgentExecutor({ stateDirectory: f.stateDirectory, workspaceRoot: f.workspaceRoot,
      modelsRegistry: f.models, providerId: f.faux.getModel().provider, model: f.faux.getModel().id,
    });
    try {
      assert.equal((await resumed.run("What is the code?", { sessionId: "compact" })).answer, "ORCHID");
    } finally { await resumed.close(); }
  } finally { await f.close(); }
});

test("official codemode calls standard tools through the same approval pipeline", async () => {
  const f = fixture({ requireApprovalForAllWrites: true, settings: { defaultTools: ["read", "write", "edit", "bash", "codemode"] } });
  let approvals = 0;
  try {
    f.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("codemode", { code: 'await tools.write({ path: "script.txt", content: "Pi codemode" }); text("written");' }), { stopReason: "toolUse" }),
      ctx => {
        const last = JSON.stringify(resolveTranscript(ctx, undefined).messages.at(-1));
        assert.match(last, /Script completed/);
        assert.match(last, /written/);
        return fauxAssistantMessage("Script completed");
      },
    ]);
    const result = await f.executor.run("Write through codemode", { onStep(event) {
      if (event.interaction?.kind !== "approval") return;
      approvals++;
      f.executor.respond(event.taskId!, event.interaction.id, { outcome: "allowed-once" });
    } });
    assert.equal(approvals, 1);
    assert.equal(readFileSync(join(f.workspaceRoot, "script.txt"), "utf8"), "Pi codemode");
    assert.ok(result.steps.some(step => step.toolName === "write"));
  } finally { await f.close(); }
});

test("official MCP loads configured HTTP tools and tool_search activates deferred tools", async () => {
  let calls = 0;
  const server = createServer(async (request, response) => {
    if (request.method !== "POST") { response.writeHead(405).end(); return; }
    let body = "";
    for await (const chunk of request) body += chunk;
    const message = JSON.parse(body);
    if (message.id === undefined) { response.writeHead(202).end(); return; }
    const result = message.method === "initialize"
      ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
      : message.method === "tools/list"
        ? { tools: [{ name: "coffee", description: "Read the coffee order", inputSchema: { type: "object", properties: {} } }] }
        : message.method === "tools/call"
          ? (calls++, { content: [{ type: "text", text: "MCP coffee: no sugar" }] })
          : {};
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const f = fixture();
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = f.stateDirectory;
  try {
    writeFileSync(join(f.stateDirectory, "mcp.json"), JSON.stringify({ mcpServers: {
      fixture: { url: `http://127.0.0.1:${address.port}/mcp`, exposure: "deferred" },
    } }));
    f.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("tool_search", { query: "coffee", limit: 1 }), { stopReason: "toolUse" }),
      ctx => {
        assert.match(JSON.stringify(resolveTranscript(ctx, undefined)), /mcp__fixture__coffee/);
        return fauxAssistantMessage(fauxToolCall("mcp__fixture__coffee", {}), { stopReason: "toolUse" });
      },
      ctx => {
        assert.match(JSON.stringify(resolveTranscript(ctx, undefined).messages.at(-1)), /MCP coffee: no sugar/);
        return fauxAssistantMessage("MCP order read");
      },
    ]);
    assert.equal((await f.executor.run("Read the coffee order")).answer, "MCP order read");
    assert.equal(calls, 1);
  } finally {
    await f.close();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
