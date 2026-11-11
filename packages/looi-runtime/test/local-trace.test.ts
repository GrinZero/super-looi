import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { SqliteRuntimeStore } from "../src/storage/sqlite.js";
import { createLangfuseTracer } from "../src/telemetry/langfuse.js";
import { PiAgentExecutor } from "../src/agent/pi-executor.js";
import { observeVoiceSocket } from "../src/telemetry/realtime-observer.js";
import { createOpenAiRealtimeProtocol } from "../src/voice/realtime-protocol.js";

test("local trace persists starts, merged ends and relationships without Langfuse, and reopens", async () => {
  const directory = mkdtempSync(join(tmpdir(), "looi-local-trace-"));
  const file = join(directory, "runtime.sqlite");
  let storage = new SqliteRuntimeStore(new DatabaseSync(file));
  const tracer = createLangfuseTracer({ onObservation: node => storage.saveObservation(node) });
  try {
    assert.equal(tracer.enabled, true);
    tracer.registerSecret("local-model-key");
    const parent = tracer.start("agent.run", "agent", undefined, { "langfuse.observation.input": "request" });
    const tool = tracer.start("agent.tool.ping", "tool", parent.context, { "langfuse.observation.input": { key: "local-model-key" } });
    const running = storage.traceObservations(parent.context.traceId);
    assert.equal(running.length, 2);
    assert.equal(running[1].endedAt, undefined);
    tool.end({ "langfuse.observation.output": "pong" });
    parent.end({ "langfuse.observation.output": "done" });
    storage.close();
    storage = new SqliteRuntimeStore(new DatabaseSync(file));
    const restored = storage.traceObservations(parent.context.traceId);
    assert.equal(restored.length, 2, "end updates the same span");
    assert.equal(restored[1].parentSpanId, parent.spanId);
    assert.deepEqual(restored[1].attributes["langfuse.observation.input"], { key: "[redacted]" });
    assert.equal(restored[1].attributes["langfuse.observation.output"], "pong");
    assert.ok(restored.every(node => node.endedAt !== undefined));
    const unfinished = tracer.start("agent.run", "agent");
    storage.close();
    storage = new SqliteRuntimeStore(new DatabaseSync(file));
    const interrupted = storage.traceObservations(unfinished.context.traceId)[0];
    assert.equal(interrupted.endedAt, undefined, "a restart does not invent a completion time");
    assert.equal(interrupted.attributes["langfuse.observation.metadata.interrupted"], true);
  } finally { await tracer.shutdown(); storage.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("a task's delivered response keeps its parent across a new voice connection and records interruption", async () => {
  const storage = new SqliteRuntimeStore(new DatabaseSync(":memory:"));
  const tracer = createLangfuseTracer({ onObservation: node => storage.saveObservation(node) });
  const task = tracer.start("agent.run", "agent");
  task.end({ "langfuse.observation.output": "answer" });
  const delivery = tracer.start("voice.delivery", "span", task.context);
  const incoming = [
    { type: "session.updated" },
    { type: "response.created", response: { id: "delivered" } },
    { type: "response.output_audio_transcript.done", response_id: "delivered", transcript: "刚才的结果" },
    { type: "response.done", response: { id: "delivered", status: "cancelled" } },
  ].map(JSON.stringify);
  const socket = observeVoiceSocket({ read: async () => incoming.shift() ?? null, write: async () => {}, close: async () => {} }, {
    tracer, protocol: createOpenAiRealtimeProtocol(), sessionId: "new-connection", fromWakeWord: false,
  });
  try {
    socket.setResponseTraceContext(delivery.context);
    while (incoming.length) await socket.read();
    delivery.end({ "langfuse.observation.output": { status: "sent" } });
    const nodes = storage.traceObservations(task.context.traceId);
    const response = nodes.find(node => node.name === "realtime.response")!;
    assert.equal(response.parentSpanId, delivery.spanId);
    assert.notEqual(response.attributes["langfuse.observation.metadata.voiceSessionTraceId"], task.context.traceId);
    assert.equal(response.attributes["langfuse.observation.metadata.cancelled"], true);
    assert.match(JSON.stringify(response.attributes["langfuse.observation.output"]), /刚才的结果/);
  } finally { socket.finalizeSession(); await tracer.shutdown(); storage.close(); }
});

test("repeated tools retain separate calls, actual arguments, errors and generation parents", async () => {
  const directory = mkdtempSync(join(tmpdir(), "looi-local-tools-"));
  const storage = new SqliteRuntimeStore(new DatabaseSync(":memory:"));
  const tracer = createLangfuseTracer({ onObservation: node => storage.saveObservation(node) });
  const faux = fauxProvider(), models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("ping", { value: "first" })]),
    fauxAssistantMessage([fauxToolCall("ping", { value: "second" })]),
    fauxAssistantMessage("第二次调用失败。"),
  ]);
  const executor = new PiAgentExecutor({
    tracer, stateDirectory: directory, taskPersistence: storage.tasks,
    workspaceRoot: join(directory, "work"), modelSpec: faux.getModel(), streamFn: models.streamSimple.bind(models),
    customTools: [{ name: "ping", label: "ping", description: "ping", parameters: { type: "object", properties: { value: { type: "string" } } }, execute: async (_id, args) => {
      if (args.value === "second") throw new Error("second call failed");
      return { content: [{ type: "text", text: `pong ${args.value}` }], details: {} };
    } }],
  });
  try {
    const result = await executor.run("调用两次 ping", { sessionId: "local-session" });
    const task = executor.getTask(result.taskId)!;
    const nodes = storage.traceObservations(task.trace!.traceId);
    const tools = nodes.filter(node => node.name === "agent.tool.ping");
    assert.equal(tools.length, 2);
    assert.notEqual(tools[0].spanId, tools[1].spanId);
    assert.deepEqual(tools.map(node => node.attributes["langfuse.observation.input"]), [{ value: "first" }, { value: "second" }]);
    assert.ok(nodes.some(node => node.name === "llm.chat" && node.spanId === tools[0].parentSpanId));
    assert.equal(tools[1].attributes["langfuse.observation.level"], "ERROR");
    assert.match(JSON.stringify(tools[1].attributes["langfuse.observation.output"]), /second call failed/);
    assert.equal(nodes.find(node => node.spanId === task.trace!.spanId)!.attributes["langfuse.observation.output"], result.answer);
    assert.equal(storage.tasks.load()[0].trace?.spanId, task.trace?.spanId);
  } finally { await executor.close(); await tracer.shutdown(); storage.close(); rmSync(directory, { recursive: true, force: true }); }
});
