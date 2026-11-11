import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-responses";
import type { Model } from "@earendil-works/pi-ai";
import { PiAgentExecutor } from "../src/agent/pi-executor.js";
import { createLangfuseTracer, type TraceObservation } from "../src/telemetry/langfuse.js";

const model: Model<"openai-responses"> = {
  id: "gpt-5.4", name: "GPT-5.4", provider: "openai", api: "openai-responses",
  baseUrl: "https://api.openai.com/v1", reasoning: true, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000, maxTokens: 4096,
};

const marker = "\uE200cite\uE202turn0search0\uE201";
const prefix = "😀这是 GRIN ZERO 的介绍。";
const text = prefix + marker;
const citations = [
  { type: "url_citation", start_index: Array.from(prefix).length, end_index: Array.from(text).length, title: "GRIN [ZERO]", url: "https://example.com/grin" },
  { type: "url_citation", start_index: Array.from(prefix).length, end_index: Array.from(text).length, title: "项目介绍", url: "https://example.com/about" },
];

function responseBody(search = true, failure = false, refusal?: string, output?: { text: string; annotations: typeof citations }): string {
  const message = {
    id: "msg_search", type: "message", role: "assistant", phase: "final_answer", status: "completed",
    content: refusal
      ? [{ type: "refusal", refusal }]
      : [{ type: "output_text", text: output?.text ?? (search ? text : "你好。"), annotations: output?.annotations ?? (search ? citations : []) }],
  };
  const call = { id: "ws_search", type: "web_search_call", status: "completed", action: { type: "search", queries: ["GRIN ZERO"] } };
  const events: unknown[] = [{ type: "response.created", response: { id: "resp_search", status: "in_progress" } }];
  if (search) events.push(
    { type: "response.output_item.added", output_index: 0, item: { ...call, status: "in_progress" } },
    { type: "response.output_item.done", output_index: 0, item: call },
  );
  if (failure) events.push({ type: "response.failed", response: { id: "resp_search", status: "failed", error: { code: "search_failed", message: "Search service unavailable" } } });
  else events.push(
    { type: "response.output_item.added", output_index: 1, item: { ...message, content: [] } },
    { type: refusal ? "response.refusal.delta" : "response.output_text.delta", output_index: 1, content_index: 0, delta: refusal ?? message.content[0].text },
    { type: "response.output_item.done", output_index: 1, item: message },
    { type: "response.completed", response: { id: "resp_search", status: "completed", output: search ? [call, message] : [message] } },
  );
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
}

test("official OpenAI enables hosted search alongside local tools, records calls and persists clickable citations", async () => {
  const root = mkdtempSync(join(tmpdir(), "looi-search-"));
  const requests: Record<string, any>[] = [];
  const observations = new Map<string, TraceObservation>();
  const tracer = createLangfuseTracer({ onObservation: node => observations.set(node.spanId, node) });
  const executor = new PiAgentExecutor({
    tracer,
    stateDirectory: root, workspaceRoot: join(root, "work"), modelSpec: model,
    streamFn: (selected, context, options) => streamSimple(selected as typeof model, context, {
      ...options, apiKey: "sk-test", maxRetries: 0,
      fetch: async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return new Response(responseBody(requests.length === 1), { headers: { "content-type": "text/event-stream" } });
      },
    }),
  });
  try {
    const result = await executor.run("搜索 GRIN ZERO 的基本介绍", { sessionId: "search_chat" });
    assert.deepEqual(requests[0].tools.at(-1), { type: "web_search", external_web_access: true });
    assert.ok(requests[0].tools.some((tool: any) => tool.name === "bash"));
    assert.match(JSON.stringify(requests[0]), /built-in web_search tool is available/);
    assert.equal(requests[0].tool_choice, undefined, "availability does not force every turn to search");
    assert.equal(result.toolCallsCount, 1);
    assert.deepEqual(result.steps.filter((step) => step.toolName === "web_search").map((step) => step.phase), ["tool_start", "tool_end"]);
    assert.equal(result.answer, `${prefix}[GRIN \\[ZERO\\]](<https://example.com/grin>) [项目介绍](<https://example.com/about>)`);
    assert.equal(executor.getTask(result.taskId)?.state, "succeeded");
    const session = JSON.parse(readFileSync(join(root, "sessions/search_chat.json"), "utf8"));
    assert.ok(JSON.stringify(session).includes("https://example.com/grin"));
    const followUp = await executor.run("谢谢", { sessionId: "search_chat" });
    assert.equal(followUp.toolCallsCount, 0);
    assert.equal(followUp.answer, "你好。");
    assert.match(JSON.stringify(requests[1].input), /https:\/\/example.com\/grin/);
    const nodes = [...observations.values()];
    const search = nodes.find(node => node.name === "agent.tool.web_search")!;
    const generations = nodes.filter(node => node.name === "llm.chat");
    assert.equal(search.parentSpanId, generations[0].spanId);
    assert.deepEqual(search.attributes["langfuse.observation.output"], { status: "completed", action: { type: "search", queries: ["GRIN ZERO"] } });
    assert.deepEqual(JSON.parse(JSON.stringify(generations[0].attributes["langfuse.observation.metadata.request"])), requests[0]);
    const context = nodes.filter(node => node.name === "agent.context")[1];
    assert.match(JSON.stringify(context.attributes["langfuse.observation.input"]), /搜索 GRIN ZERO 的基本介绍/);
    assert.equal(executor.getTask(followUp.taskId)?.trace?.traceId, context.traceId);
    assert.ok(generations.every(node => node.endedAt !== undefined));
  } finally {
    await executor.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("provider-rendered Markdown citations stay clickable without duplicate source links", async () => {
  const root = mkdtempSync(join(tmpdir(), "looi-search-markdown-"));
  const url = "https://arxiv.org/abs/2409.09896?utm_source=openai";
  const introduction = "😀这是相关论文。";
  const citation = `([arxiv.org](${url}))`;
  const output = {
    text: introduction + citation,
    annotations: [{ type: "url_citation", start_index: Array.from(introduction).length, end_index: Array.from(introduction + citation).length, title: "GRIN: Zero-Shot Metric Depth", url }],
  };
  const executor = new PiAgentExecutor({
    stateDirectory: root, modelSpec: model,
    streamFn: (selected, context, options) => streamSimple(selected as typeof model, context, {
      ...options, apiKey: "sk-test", maxRetries: 0,
      fetch: async () => new Response(responseBody(true, false, undefined, output), { headers: { "content-type": "text/event-stream" } }),
    }),
  });
  try {
    const result = await executor.run("搜索相关论文");
    assert.equal(result.answer, output.text);
  } finally {
    await executor.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("official OpenAI refusal text remains intact when there are no citations", async () => {
  const root = mkdtempSync(join(tmpdir(), "looi-search-refusal-"));
  const executor = new PiAgentExecutor({
    stateDirectory: root, modelSpec: model,
    streamFn: (selected, context, options) => streamSimple(selected as typeof model, context, {
      ...options, apiKey: "sk-test", maxRetries: 0,
      fetch: async () => new Response(responseBody(false, false, "无法协助此请求。"), { headers: { "content-type": "text/event-stream" } }),
    }),
  });
  try {
    const result = await executor.run("拒答保留用例");
    assert.equal(result.answer, "无法协助此请求。");
  } finally {
    await executor.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenAI-compatible third-party endpoints receive no hosted search declaration or prompt", async () => {
  const root = mkdtempSync(join(tmpdir(), "looi-search-custom-"));
  let request: Record<string, any> | undefined;
  const executor = new PiAgentExecutor({
    stateDirectory: root, modelSpec: { ...model, provider: "custom", baseUrl: "https://gateway.example/v1" },
    streamFn: (selected, context, options) => streamSimple(selected as typeof model, context, {
      ...options, apiKey: "sk-test", maxRetries: 0,
      fetch: async (_url, init) => {
        request = JSON.parse(String(init?.body));
        return new Response(responseBody(false), { headers: { "content-type": "text/event-stream" } });
      },
    }),
  });
  try {
    const result = await executor.run("你好");
    assert.ok(request);
    assert.ok(!request.tools.some((tool: any) => tool.type === "web_search"));
    assert.doesNotMatch(JSON.stringify(request), /built-in web_search tool is available/);
    assert.equal(result.toolCallsCount, 0);
  } finally {
    await executor.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("hosted search failures propagate without a second request that drops search", async () => {
  const root = mkdtempSync(join(tmpdir(), "looi-search-error-"));
  let requests = 0;
  const executor = new PiAgentExecutor({
    stateDirectory: root, modelSpec: model,
    streamFn: (selected, context, options) => streamSimple(selected as typeof model, context, {
      ...options, apiKey: "sk-test", maxRetries: 0,
      fetch: async () => {
        requests++;
        return new Response(responseBody(true, true), { headers: { "content-type": "text/event-stream" } });
      },
    }),
  });
  try {
    await assert.rejects(executor.run("搜索 GRIN ZERO"), /Search service unavailable/);
    assert.equal(requests, 1);
    assert.equal(executor.listTasks()[0].state, "failed");
  } finally {
    await executor.close();
    rmSync(root, { recursive: true, force: true });
  }
});
