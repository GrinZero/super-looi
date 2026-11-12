import assert from "node:assert/strict";
import { test } from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiAgentExecutor } from "../src/agent/pi-executor.js";
import { createLangfuseTracer, NOOP_TRACER } from "../src/telemetry/langfuse.js";
import { observeVoiceSocket } from "../src/telemetry/realtime-observer.js";
import { wrapStreamFnWithLangfuse } from "../src/telemetry/llm-observer.js";
import { createDoubaoDuplexV3Protocol, createOpenAiRealtimeProtocol } from "../src/voice/realtime-protocol.js";

function fixture() {
  const requests: any[] = [];
  const tracer = createLangfuseTracer({
    baseUrl: "http://localhost:3000", publicKey: "pk-test", secretKey: "sk-test", flushIntervalMs: 60_000,
    fetch: async (url, init) => { requests.push({ url, ...init, body: JSON.parse(String(init?.body)) }); return new Response("", { status: 200 }); },
  });
  const spans = () => requests.flatMap((request) => request.body.resourceSpans.flatMap((resource: any) => resource.scopeSpans.flatMap((scope: any) => scope.spans)));
  const attrs = (span: any) => Object.fromEntries(span.attributes.map((item: any) => [item.key, item.value]));
  return { tracer, requests, spans, attrs };
}

test("OTLP v4 export preserves trace hierarchy and JSON string attributes", async () => {
  assert.equal(NOOP_TRACER.enabled, false);
  await NOOP_TRACER.flush();
  const { tracer, requests, spans, attrs } = fixture();
  const root = tracer.start("voice.session", "span", { traceId: "", traceName: "voice.session", sessionId: "session-1" });
  tracer.registerSecret("model-key");
  const child = tracer.start("realtime.response", "generation", root.context);
  child.end({
    "langfuse.observation.input": { prompt: "model-key 你好" },
    "langfuse.observation.output": { text: "你好" },
    "langfuse.observation.usage_details": { input: 2 },
    "langfuse.observation.cost_details": { total: 0.01 },
    "langfuse.observation.completion_start_time": 1_700_000_000_000,
  });
  root.end();
  await tracer.shutdown();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "http://localhost:3000/api/public/otel/v1/traces");
  assert.equal(requests[0].headers["x-langfuse-ingestion-version"], "4");
  const [generation, session] = spans();
  assert.match(generation.traceId, /^[a-f0-9]{32}$/);
  assert.match(generation.spanId, /^[a-f0-9]{16}$/);
  assert.equal(generation.parentSpanId, session.spanId);
  for (const span of spans()) {
    assert.equal(attrs(span)["session.id"].stringValue, "session-1");
    assert.equal(attrs(span)["langfuse.trace.name"].stringValue, "voice.session");
  }
  for (const key of ["langfuse.observation.input", "langfuse.observation.output", "langfuse.observation.usage_details", "langfuse.observation.cost_details"])
    assert.equal(typeof attrs(generation)[key].stringValue, "string");
  assert.equal(attrs(generation)["langfuse.observation.input"].stringValue.includes("model-key"), false);
  assert.equal(attrs(generation)["langfuse.observation.completion_start_time"].stringValue, "2023-11-14T22:13:20.000Z");
});

test("voice observer folds audio and finalizes root synchronously", async () => {
  const { tracer, spans, attrs } = fixture();
  const messages = [
    { type: "session.created", session: { id: "remote" } },
    { type: "input_audio_buffer.speech_started" },
    { type: "input_audio_buffer.committed" },
    { type: "conversation.item.input_audio_transcription.started" },
    { type: "conversation.item.input_audio_transcription.delta", delta: "开" },
    { type: "conversation.item.input_audio_transcription.delta", delta: "开灯" },
    { type: "conversation.item.input_audio_transcription.completed" },
    { type: "response.created", response_id: "r" },
    ...Array.from({ length: 50 }, () => ({ type: "response.output_audio.delta", response_id: "r", delta: "AAAA" })),
    { type: "response.output_text.done", response_id: "r", text: "好的" },
    { type: "response.done", response_id: "r" },
  ].map(JSON.stringify);
  const socket = observeVoiceSocket({ read: async () => messages.shift() ?? null, write: async () => {}, close: async () => {} }, {
    tracer, protocol: createDoubaoDuplexV3Protocol(), sessionId: "voice-1", fromWakeWord: true, connectStartedAt: Date.now() - 120,
  });
  await socket.read();
  for (let i = 0; i < 10; i++) await socket.write(JSON.stringify({ type: "input_audio_buffer.append", audio: "AAAA" }));
  await socket.read();
  for (let i = 0; i < 100; i++) await socket.write(JSON.stringify({ type: "input_audio_buffer.append", audio: "AAAA" }));
  while (messages.length) await socket.read();
  socket.finalizeSession("end_session");
  await tracer.shutdown();
  assert.equal(spans().filter((span: any) => span.name === "realtime.response").length, 1);
  assert.equal(spans().filter((span: any) => span.name === "realtime.user_turn").length, 1);
  const handshake = spans().find((span: any) => span.name === "realtime.handshake");
  assert.ok(Number(attrs(handshake)["langfuse.observation.metadata.handshakeMs"].intValue) >= 120);
  const turn = spans().find((span: any) => span.name === "realtime.user_turn");
  assert.equal(attrs(turn)["langfuse.observation.metadata.inputFrames"].intValue, "100");
  assert.equal(attrs(turn)["langfuse.observation.output"].stringValue, "开灯");
  const root = spans().find((span: any) => span.name === "voice.session");
  assert.deepEqual(JSON.parse(attrs(root)["langfuse.observation.input"].stringValue), [{ role: "user", content: "开灯" }]);
  assert.deepEqual(JSON.parse(attrs(root)["langfuse.observation.output"].stringValue), [{ role: "assistant", content: "好的" }]);
  assert.equal(attrs(root)["langfuse.observation.metadata.closeReason"].stringValue, "end_session");
  const generation = spans().find((span: any) => span.name === "realtime.response");
  assert.deepEqual(JSON.parse(attrs(generation)["langfuse.observation.input"].stringValue), [{ role: "user", content: "开灯" }]);
  assert.deepEqual(JSON.parse(attrs(generation)["langfuse.observation.output"].stringValue), [{ role: "assistant", content: "好的" }]);
  assert.equal(attrs(generation)["langfuse.observation.metadata.outputFrames"].intValue, "50");
  assert.equal(attrs(generation)["langfuse.observation.metadata.outputBytes"].intValue, "150");
  assert.equal(typeof attrs(generation)["langfuse.observation.completion_start_time"].stringValue, "string");
});

test("OpenAI transcript arriving after response remains on its user turn", async () => {
  const { tracer, spans, attrs } = fixture();
  const messages = [
    { type: "session.updated" },
    { type: "input_audio_buffer.speech_started" },
    { type: "input_audio_buffer.speech_stopped", item_id: "user-1" },
    { type: "response.created", response: { id: "response-1" } },
    { type: "response.done", response: { id: "response-1" } },
    { type: "conversation.item.input_audio_transcription.completed", item_id: "user-1", transcript: "打开灯" },
  ].map(JSON.stringify);
  const socket = observeVoiceSocket({ read: async () => messages.shift() ?? null, write: async () => {}, close: async () => {} }, {
    tracer, protocol: createOpenAiRealtimeProtocol(), sessionId: "late-asr", fromWakeWord: false,
  });
  await socket.read();
  await socket.read();
  await socket.write(JSON.stringify({ type: "input_audio_buffer.append", audio: "AAAA" }));
  while (messages.length) await socket.read();
  socket.finalizeSession();
  await tracer.shutdown();
  const root = spans().find((span: any) => span.name === "voice.session");
  const turn = spans().find((span: any) => span.name === "realtime.user_turn");
  const generation = spans().find((span: any) => span.name === "realtime.response");
  assert.deepEqual(JSON.parse(attrs(root)["langfuse.observation.input"].stringValue), [{ role: "user", content: "打开灯" }]);
  assert.deepEqual(JSON.parse(attrs(generation)["langfuse.observation.input"].stringValue), [{ role: "user", content: "打开灯" }]);
  assert.equal(attrs(turn)["langfuse.observation.output"].stringValue, "打开灯");
  assert.equal(attrs(turn)["langfuse.observation.metadata.inputFrames"].intValue, "1");
});

test("session replay keeps user and assistant messages in turn order", async () => {
  const { tracer, spans, attrs } = fixture();
  const messages = [
    { type: "session.created" },
    { type: "input_audio_buffer.speech_started" },
    { type: "input_audio_buffer.speech_stopped" },
    { type: "response.created", response_id: "first" },
    { type: "response.output_text.done", response_id: "first", text: "第一句回复" },
    { type: "response.done", response_id: "first" },
    { type: "conversation.item.input_audio_transcription.completed", text: "第一句提问" },
    { type: "input_audio_buffer.speech_started" },
    { type: "conversation.item.input_audio_transcription.completed", text: "第二句提问" },
    { type: "response.created", response_id: "second" },
    { type: "response.output_text.done", response_id: "second", text: "第二句回复" },
    { type: "response.done", response_id: "second" },
  ].map(JSON.stringify);
  const socket = observeVoiceSocket({ read: async () => messages.shift() ?? null, write: async () => {}, close: async () => {} }, {
    tracer, protocol: createDoubaoDuplexV3Protocol(), sessionId: "replay", fromWakeWord: false,
  });
  while (messages.length) await socket.read();
  socket.finalizeSession();
  await tracer.shutdown();
  const root = spans().find((span: any) => span.name === "voice.session");
  assert.deepEqual(JSON.parse(attrs(root)["langfuse.observation.input"].stringValue), [
    { role: "user", content: "第一句提问" },
    { role: "assistant", content: "第一句回复" },
    { role: "user", content: "第二句提问" },
  ]);
  assert.deepEqual(JSON.parse(attrs(root)["langfuse.observation.output"].stringValue), [
    { role: "assistant", content: "第二句回复" },
  ]);
  const generations = spans().filter((span: any) => span.name === "realtime.response");
  assert.deepEqual(generations.map((span: any) => JSON.parse(attrs(span)["langfuse.observation.input"].stringValue)), [
    [{ role: "user", content: "第一句提问" }],
    [{ role: "user", content: "第一句提问" }, { role: "assistant", content: "第一句回复" }, { role: "user", content: "第二句提问" }],
  ]);
});

test("ASR failure releases a completed response without changing its end time", async () => {
  const { tracer, spans, attrs } = fixture();
  const messages = [
    { type: "session.updated" },
    { type: "input_audio_buffer.speech_started" },
    { type: "input_audio_buffer.speech_stopped", item_id: "user-1" },
    { type: "response.created", response: { id: "response-1" } },
    { type: "response.output_audio_transcript.done", response_id: "response-1", transcript: "请再说一遍。" },
    { type: "response.done", response: { id: "response-1" } },
    { type: "conversation.item.input_audio_transcription.failed", item_id: "user-1" },
  ].map(JSON.stringify);
  const socket = observeVoiceSocket({ read: async () => messages.shift() ?? null, write: async () => {}, close: async () => {} }, {
    tracer, protocol: createOpenAiRealtimeProtocol(), sessionId: "failed-asr", fromWakeWord: false,
  });
  for (let index = 0; index < 6; index++) await socket.read();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const transcriptionFailedAt = Date.now();
  await socket.read();
  await tracer.flush();
  const response = spans().find((span: any) => span.name === "realtime.response");
  assert.ok(response);
  assert.ok(BigInt(response.endTimeUnixNano) < BigInt(transcriptionFailedAt) * 1_000_000n);
  assert.deepEqual(JSON.parse(attrs(response)["langfuse.observation.output"].stringValue), [{ role: "assistant", content: "请再说一遍。" }]);
  socket.finalizeSession();
  await tracer.shutdown();
});

test("LLM observer emits known costs and omits unknown custom model costs", async () => {
  const { tracer, spans, attrs } = fixture();
  const run = async (priced: boolean) => {
    const model = { id: priced ? "priced" : "custom", api: "openai-completions", provider: "openai", cost: { input: priced ? 1 : 0, output: priced ? 2 : 0, cacheRead: 0, cacheWrite: 0 } } as any;
    const message = { role: "assistant", content: [{ type: "text", text: "回答" }], api: model.api, provider: model.provider, model: model.id,
      usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 } }, stopReason: "stop", timestamp: Date.now() } as any;
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "start", partial: message });
    stream.push({ type: "text_delta", contentIndex: 0, delta: "回", partial: message });
    stream.push({ type: "done", reason: "stop", message });
    const wrapped = wrapStreamFnWithLangfuse(() => stream, { tracer, getTraceContext: () => ({ traceId: "a".repeat(32), parentSpanId: "b".repeat(16), traceName: "agent.run", sessionId: "task-1" }) });
    const result = await wrapped(model, { messages: [{ role: "system", content: "你是助手", toolsAdded: [{ name: "ping", description: "ping", parameters: { type: "object", properties: {} } }], timestamp: 1 }] } as any);
    await result.result();
  };
  await run(true);
  await run(false);
  await tracer.shutdown();
  const priced = spans().find((span: any) => attrs(span)["langfuse.observation.model.name"].stringValue === "priced");
  const unknown = spans().find((span: any) => attrs(span)["langfuse.observation.model.name"].stringValue === "custom");
  assert.ok(attrs(priced)["langfuse.observation.cost_details"]);
  assert.equal(attrs(unknown)["langfuse.observation.cost_details"], undefined);
  assert.equal(attrs(priced)["langfuse.observation.usage_details"].stringValue.includes('"input":2'), true);
  assert.deepEqual(JSON.parse(attrs(priced)["langfuse.observation.input"].stringValue), {
    systemPrompt: "你是助手", messages: [{ role: "system", content: "你是助手", toolsAdded: [{ name: "ping", description: "ping", parameters: { type: "object", properties: {} } }], timestamp: 1 }],
    tools: [{ name: "ping", description: "ping", parameters: { type: "object", properties: {} } }],
  });
});

test("failed LLM generation records the provider error on the observation", async () => {
  const { tracer, spans, attrs } = fixture();
  const model = { id: "test-model", api: "openai-completions", provider: "openai", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as any;
  const failed = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "error", errorMessage: "model access denied", timestamp: Date.now() } as any;
  const stream = createAssistantMessageEventStream();
  stream.push({ type: "error", reason: "error", error: failed });
  stream.end(failed);
  const wrapped = wrapStreamFnWithLangfuse(() => stream, { tracer, getTraceContext: () => undefined });
  const result = await wrapped(model, { messages: [] } as any);
  await result.result();
  await tracer.shutdown();
  const generation = spans().find((span: any) => span.name === "llm.chat");
  assert.equal(attrs(generation)["langfuse.observation.level"].stringValue, "ERROR");
  assert.equal(attrs(generation)["langfuse.observation.status_message"].stringValue, "model access denied");
});

test("voice tool context connects agent, generation and tool observations", async () => {
  const { tracer, spans, attrs } = fixture();
  const root = mkdtempSync(join(tmpdir(), "looi-trace-"));
  const faux = fauxProvider(), models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("ping", {}), { stopReason: "toolUse" }),
    fauxAssistantMessage("任务完成"),
  ]);
  const executor = new PiAgentExecutor({
    tracer, stateDirectory: join(root, "state"), workspaceRoot: join(root, "workspace"),
    modelSpec: faux.getModel(), modelsRegistry: models, streamFn: models.streamSimple.bind(models),
    customTools: [{ name: "ping", label: "ping", description: "ping", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [{ type: "text", text: "pong" }], details: {} }) }],
  });
  try {
    const traceContext = { traceId: "a".repeat(32), parentSpanId: "b".repeat(16), traceName: "voice.session", sessionId: "voice-42" };
    const result = await executor.run("执行 ping", { taskId: "trace-task", sessionId: "agent-session", traceContext });
    assert.equal(result.answer, "任务完成");
    await executor.close();
    await tracer.shutdown();
    const agent = spans().find((span: any) => span.name === "agent.run");
    const generations = spans().filter((span: any) => span.name === "llm.chat");
    const tool = spans().find((span: any) => span.name === "agent.tool.ping");
    assert.equal(agent.parentSpanId, traceContext.parentSpanId);
    assert.equal(generations.length, 2);
    assert.equal(tool.parentSpanId, generations[0].spanId);
    for (const span of [agent, ...generations, tool]) {
      assert.equal(span.traceId, traceContext.traceId);
      assert.equal(attrs(span)["session.id"].stringValue, "voice-42");
      assert.equal(attrs(span)["langfuse.trace.name"].stringValue, "voice.session");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Doubao initial context and audio-only proactive speech keep their text", async () => {
  const { tracer, spans, attrs } = fixture();
  const events: string[] = [];
  const socket = observeVoiceSocket({ read: async () => events.shift() ?? null, write: async () => {}, close: async () => {} }, {
    tracer, protocol: createDoubaoDuplexV3Protocol(), sessionId: "proactive-text", fromWakeWord: false,
  });
  const initial = { type: "session.create", session: { instructions: "此前问过位置。", tools: [{ name: "run_agent_task" }] } };
  await socket.write(JSON.stringify(initial));
  await socket.write(JSON.stringify({ type: "speech_text_buffer.commit", text: "现在是 11 月 11 日。" }));
  events.push(...[
    { type: "response.created", response_id: "tts" },
    { type: "response.output_audio.delta", response_id: "tts", delta: "AAAA" },
    { type: "response.done", response_id: "tts" },
  ].map(JSON.stringify));
  while (events.length) await socket.read();
  // Some responses also return a text transcript; the submitted text must not be appended twice.
  await socket.write(JSON.stringify({ type: "speech_text_buffer.commit", text: "第二次播报。" }));
  events.push(...[
    { type: "response.created", response_id: "tts-2" },
    { type: "response.output_text.delta", response_id: "tts-2", delta: "第二次" },
    { type: "response.output_text.delta", response_id: "tts-2", delta: "播报。" },
    { type: "response.done", response_id: "tts-2" },
  ].map(JSON.stringify));
  while (events.length) await socket.read();
  socket.finalizeSession();
  await tracer.shutdown();
  const context = spans().find((span: any) => span.name === "realtime.context");
  assert.deepEqual(JSON.parse(attrs(context)["langfuse.observation.input"].stringValue), initial);
  const responses = spans().filter((span: any) => span.name === "realtime.response");
  assert.deepEqual(responses.map((span: any) => JSON.parse(attrs(span)["langfuse.observation.output"].stringValue)), [
    [{ role: "assistant", content: "现在是 11 月 11 日。" }],
    [{ role: "assistant", content: "第二次播报。" }],
  ]);
  const root = spans().find((span: any) => span.name === "voice.session");
  assert.deepEqual(JSON.parse(attrs(root)["langfuse.observation.input"].stringValue), [{ role: "assistant", content: "现在是 11 月 11 日。" }]);
});

test("failed outgoing speech is not collected as a successful assistant transcript", async () => {
  const { tracer, spans, attrs } = fixture();
  const socket = observeVoiceSocket({ read: async () => null, write: async () => { throw new Error("send failed"); }, close: async () => {} }, {
    tracer, protocol: createDoubaoDuplexV3Protocol(), sessionId: "failed-speech", fromWakeWord: false,
  });
  await assert.rejects(socket.write(JSON.stringify({ type: "speech_text_buffer.commit", text: "没有发出去的播报。" })), /send failed/);
  socket.finalizeSession();
  await tracer.shutdown();
  assert.equal(spans().filter((span: any) => span.name === "realtime.response").length, 0);
  const root = spans().find((span: any) => span.name === "voice.session");
  assert.deepEqual(JSON.parse(attrs(root)["langfuse.observation.metadata.assistantTranscripts"].stringValue), []);
});

test("TTS error or cancellation before audio does not invent a spoken history entry", async () => {
  for (const event of [{ type: "error", error: { message: "TTS failed" } }, { type: "response.canceled", response_id: "tts" }]) {
    for (const enabled of [true, false]) {
      const { tracer, spans, attrs } = fixture();
      let history: unknown = [];
      const events = [JSON.stringify(event)];
      const socket = observeVoiceSocket({ read: async () => events.shift() ?? null, write: async () => {}, close: async () => {} }, {
        tracer: enabled ? tracer : NOOP_TRACER, protocol: createDoubaoDuplexV3Protocol(), sessionId: "tts-failed", fromWakeWord: false,
        onConversation: (messages) => { history = messages; },
      });
      await socket.write(JSON.stringify({ type: "speech_text_buffer.commit", text: "尚未发声的内容。" }));
      await socket.read();
      socket.finalizeSession();
      await tracer.shutdown();
      assert.deepEqual(history, []);
      if (enabled) {
        const response = spans().find((span: any) => span.name === "realtime.response");
        assert.deepEqual(JSON.parse(attrs(response)["langfuse.observation.output"].stringValue), []);
        assert.equal(attrs(response)["langfuse.observation.metadata.requestedSpeech"].stringValue, "尚未发声的内容。");
      }
    }
  }
});
