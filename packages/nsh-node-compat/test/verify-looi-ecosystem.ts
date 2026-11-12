import fs from "node:fs";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, resolveTranscript } from "@earendil-works/pi-ai";
import { SessionManager, defineTool, isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { PiAgentExecutor } from "../../looi-runtime/src/agent/pi-executor.js";
import { registerPrecompiledModule } from "../src/shims/precompiled-jiti.js";
import { assert, equal } from "./assert.js";
import { installFixtureHttp, FixtureResponse } from "./http-fixture.js";

installFixtureHttp();

const cwd = "/workspace/pi-ecosystem", state = "/home/pi-ecosystem";
process.env.PI_CODING_AGENT_DIR = state;
fs.mkdirSync(`${cwd}/.pi/skills/order`, { recursive: true });
fs.mkdirSync(`${cwd}/.pi/extensions`, { recursive: true });
fs.mkdirSync(`${cwd}/.pi/prompts`, { recursive: true });
fs.mkdirSync(state, { recursive: true });
fs.writeFileSync(`${cwd}/AGENTS.md`, "NATIVE_RULE: preserve order IDs.\n");
fs.writeFileSync(`${cwd}/.pi/skills/order/SKILL.md`, "---\nname: order\ndescription: Read coffee orders.\n---\nNATIVE_SKILL_BODY: preserve sugar preferences.\n");
fs.writeFileSync(`${cwd}/.pi/prompts/order.md`, "Read the order for $1.\n");
fs.writeFileSync(`${cwd}/.pi/extensions/order.js`, "precompiled extension\n");
fs.writeFileSync(`${cwd}/.pi/settings.json`, JSON.stringify({ retry: { maxRetries: 1, baseDelayMs: 1 }, compaction: { reserveTokens: 512, keepRecentTokens: 64 } }));
const unregister = registerPrecompiledModule(`${cwd}/.pi/extensions/order.js`, { default: (pi: any) => {
  pi.on("session_start", () => pi.appendEntry("native_extension_start", { connected: true }));
  pi.on("tool_call", (event: any) => { if (isToolCallEventType("native_order", event)) equal(event.toolName, "native_order"); });
  pi.registerTool(defineTool({ name: "native_order", label: "Order", description: "Read order", parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [{ type: "text", text: "NATIVE_ORDER: no sugar" }], details: {} }),
  }));
} });
const faux = fauxProvider({ models: [{ id: "mobile", contextWindow: 4096, maxTokens: 512 }] });
const models = createModels();
models.setProvider(faux.provider);
const make = () => new PiAgentExecutor({ stateDirectory: state, workspaceRoot: cwd, modelsRegistry: models,
  providerId: faux.getModel().provider, model: faux.getModel().id,
});
let executor = make();
try {
  faux.setResponses([
    ctx => {
      const text = JSON.stringify(resolveTranscript(ctx, undefined));
      assert(text.includes("NATIVE_RULE") && text.includes("Read coffee orders") && text.includes("Read the order for App"), text);
      assert(!text.includes("NATIVE_SKILL_BODY"), "skill body loaded eagerly");
      return fauxAssistantMessage(fauxToolCall("native_order", {}), { stopReason: "toolUse" });
    },
    ctx => { assert(JSON.stringify(resolveTranscript(ctx, undefined)).includes("NATIVE_ORDER: no sugar")); return fauxAssistantMessage("Order read"); },
    ctx => { assert(JSON.stringify(resolveTranscript(ctx, undefined)).includes("NATIVE_SKILL_BODY")); return fauxAssistantMessage("Skill loaded"); },
  ]);
  equal((await executor.run("/order App", { sessionId: "resources" })).answer, "Order read");
  equal((await executor.run("/skill:order", { sessionId: "resources" })).answer, "Skill loaded");
  const resourceFile = SessionManager.findById(cwd, "resources", `${state}/sessions`)!;
  assert(SessionManager.open(resourceFile).getEntries().some(entry => entry.type === "custom" && entry.customType === "native_extension_start"));
  console.log("PASS Pi App resources: standard rules, lazy skills, prompt templates and precompiled extension lifecycle");

  faux.setResponses([
    fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 rate limit: mobile fixture" }),
    fauxAssistantMessage("Recovered"),
  ]);
  equal((await executor.run("Retry", { sessionId: "retry" })).answer, "Recovered");

  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("codemode", { code: 'await tools.write({path:"native-script.txt",content:"native Pi codemode"});text("written");' }), { stopReason: "toolUse" }),
    ctx => { const last = JSON.stringify(resolveTranscript(ctx, undefined).messages.at(-1)); assert(last.includes("Script completed"), last); return fauxAssistantMessage("Written"); },
  ]);
  equal((await executor.run("Write through codemode", { sessionId: "script", approvalMode: "local_auto" })).answer, "Written");
  equal(fs.readFileSync(`${cwd}/native-script.txt`, "utf8"), "native Pi codemode");
  console.log("PASS Pi App recovery and codemode: automatic retry and native nested standard tool execution");

  faux.setResponses([
    fauxAssistantMessage("ORCHID retained"),
    fauxAssistantMessage("Ready for the next question"),
    fauxAssistantMessage("Goal: remember ORCHID. Progress: order stored."),
    ctx => { assert(JSON.stringify(resolveTranscript(ctx, undefined)).includes("Goal: remember ORCHID")); return fauxAssistantMessage("ORCHID"); },
  ]);
  await executor.run("Remember ORCHID. " + "Earlier conversation. ".repeat(900), { sessionId: "compact" });
  const compacted = await executor.run("Keep the code. " + "Recent context. ".repeat(100), { sessionId: "compact" });
  const compactFile = SessionManager.findById(cwd, "compact", `${state}/sessions`)!;
  assert(SessionManager.open(compactFile).getEntries().some(entry => entry.type === "compaction"), JSON.stringify({ calls: faux.state.callCount, steps: compacted.steps, settings: SessionManager.open(compactFile).getEntries().filter(entry => entry.type === "custom") }));
  await executor.close();
  executor = make();
  equal((await executor.run("What is the code?", { sessionId: "compact" })).answer, "ORCHID");
  console.log("PASS Pi App compaction: real summary generation, JSONL persistence and context restore after reopen");

  const originalFetch = globalThis.fetch;
  let mcpCalls = 0, refreshCalls = 0;
  globalThis.fetch = (async (url: any, init: any) => {
    if (String(url) === "https://mcp.fixture/token") {
      assert(String(init.body).includes("refresh_token=native-refresh"));
      refreshCalls++;
      return new FixtureResponse(JSON.stringify({ access_token: "native-renewed", token_type: "Bearer", expires_in: 3600 }), { headers: { "content-type": "application/json" } });
    }
    equal(String(url), "https://mcp.fixture/orders");
    if (init?.method !== "POST") return new FixtureResponse(null, { status: 405 });
    const message = JSON.parse(String(init.body));
    if (message.id === undefined) return new FixtureResponse(null, { status: 202 });
    const result = message.method === "initialize"
      ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "orders", version: "1" } }
      : message.method === "tools/list"
        ? { tools: [{ name: "coffee", description: "Read coffee order", inputSchema: { type: "object", properties: {} } }] }
        : message.method === "tools/call"
          ? (mcpCalls++, { content: [{ type: "text", text: "NATIVE_MCP: no sugar" }] }) : {};
    return new FixtureResponse(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }), { headers: { "content-type": "application/json" } });
  }) as any;
  try {
    fs.writeFileSync(`${state}/mcp.json`, JSON.stringify({ mcpServers: { orders: { url: "https://mcp.fixture/orders", exposure: "deferred" } } }));
    fs.writeFileSync(`${state}/mcp-auth.json`, JSON.stringify({ "mcp__orders|https://mcp.fixture/orders": {
      serverUrl: "https://mcp.fixture/orders",
      clientInformation: { client_id: "native-client" },
      tokens: { access_token: "native-expired", refresh_token: "native-refresh", token_type: "Bearer" },
      tokensExpireAt: 1,
      discovery: { authorizationServerUrl: "https://mcp.fixture", authorizationServerMetadata: {
        issuer: "https://mcp.fixture", authorization_endpoint: "https://mcp.fixture/authorize", token_endpoint: "https://mcp.fixture/token", response_types_supported: ["code"], token_endpoint_auth_methods_supported: ["none"],
      } },
    } }));
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("tool_search", { query: "coffee", limit: 1 }), { stopReason: "toolUse" }),
      ctx => {
        assert(JSON.stringify(resolveTranscript(ctx, undefined)).includes("mcp__orders__coffee"));
        return fauxAssistantMessage(fauxToolCall("mcp__orders__coffee", {}), { stopReason: "toolUse" });
      },
      ctx => {
        assert(JSON.stringify(resolveTranscript(ctx, undefined).messages.at(-1)).includes("NATIVE_MCP: no sugar"));
        return fauxAssistantMessage("MCP order read");
      },
    ]);
    equal((await executor.run("Read remote order", { sessionId: "mcp" })).answer, "MCP order read");
    equal(mcpCalls, 1);
    equal(refreshCalls, 1);
    assert(fs.readFileSync(`${state}/mcp-auth.json`, "utf8").includes("native-renewed"));
    console.log("PASS Pi App MCP: HTTP discovery, deferred tools, OAuth refresh lock and durable renewed tokens");
  } finally { globalThis.fetch = originalFetch; }
} finally {
  await executor.close();
  unregister();
}
