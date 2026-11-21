import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { RealtimeAgent, RealtimeSession, tool } from "@openai/agents-realtime";
import { createVoiceTools } from "../runtime/voice/tools/index.js";
import { NativeRealtimeTransport } from "../runtime/voice/sdk-transport.js";
import {
  createDoubaoDuplexV3Protocol,
  createOpenAiRealtimeProtocol,
  createMossLiveProtocol,
  type RealtimeProtocolAdapter,
} from "../runtime/voice/protocol.js";
import {
  createLangfuseTracer,
  type TraceObservation,
} from "../../../packages/looi-runtime/src/telemetry/langfuse.js";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
async function fixture(
  t: TestContext,
  protocol: RealtimeProtocolAdapter,
  tools: ReturnType<typeof tool>[] = [],
) {
  const writes: any[] = [],
    records: TraceObservation[] = [];
  const queue: string[] = [];
  let reader: ((event: string | null) => void) | undefined;
  let writeImpl = async (_value: string | Uint8Array) => {};
  const transport = new NativeRealtimeTransport({
    protocol,
    voiceId: "test",
    purpose: "conversation",
    sessionId: "sdk-test",
    fromWakeWord: false,
    tracer: createLangfuseTracer({
      onObservation: (item) => records.push(item),
    }),
    connect: async () => ({
      read: () =>
        queue.length
          ? Promise.resolve(queue.shift()!)
          : new Promise((resolve) => {
              reader = resolve;
            }),
      write: async (value) => {
        if (typeof value === "string") writes.push(JSON.parse(value));
        await writeImpl(value);
      },
      close: async () => {
        reader?.(null);
      },
    }),
    stage: () => {},
    onEvent: async () => true,
    onInterrupt: () => {},
    onMute: () => {},
  });
  const session = new RealtimeSession(
    new RealtimeAgent({ name: "LOOI test", tools }),
    { transport, tracingDisabled: true },
  );
  const errors: unknown[] = [];
  session.on("error", (event) => errors.push(event.error));
  await session.connect({ apiKey: "fixture-key" });
  t.after(() => session.close());
  const push = (event: unknown) => {
    const raw = JSON.stringify(event);
    if (reader) {
      const resolve = reader;
      reader = undefined;
      resolve(raw);
    } else queue.push(raw);
  };
  return {
    session,
    transport,
    writes,
    records,
    errors,
    push,
    setWrite: (fn: typeof writeImpl) => {
      writeImpl = fn;
    },
  };
}

test("SDK history keeps consecutive turns while both final transcriptions are late", async (t) => {
  const h = await fixture(t, createDoubaoDuplexV3Protocol());
  for (const id of ["u1", "u2"]) {
    h.push({ type: "input_audio_buffer.speech_started" });
    h.push({ type: "input_audio_buffer.speech_stopped", item_id: id });
    h.push({ type: "input_audio_buffer.committed", item_id: id });
  }
  h.push({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "u1",
    text: "第一个问题",
  });
  h.push({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "u2",
    text: "第二个问题",
  });
  await flush();
  const history = h.session.history.filter(
    (item) => item.type === "message" && item.role === "user",
  );
  assert.deepEqual(
    history.map(
      (item) =>
        item.type === "message" &&
        item.content.map((part) =>
          "transcript" in part ? part.transcript : "",
        ),
    ),
    [["第一个问题"], ["第二个问题"]],
  );
  assert.equal(h.errors.length, 0);
});

test("MOSS interruption replaces generated transcript with the provider's final heard text", async (t) => {
  const h = await fixture(t, createMossLiveProtocol());
  h.push({
    action: "output.transcript.updated",
    data: { run_id: "r", text: "太阳系以太阳为中心，有八颗行星。" },
  });
  h.push({
    action: "response.audio.stop",
    data: { run_id: "r", reason: "user_interrupt" },
  });
  h.push({
    action: "response.interrupted",
    data: { run_id: "r", text: "太阳系以太阳为中心", reason: "user_interrupt" },
  });
  await flush();
  const item = h.session.history[0];
  assert.equal(item.type, "message");
  if (item.type !== "message" || item.role !== "assistant")
    throw new Error("Missing assistant history");
  assert.equal(item.status, "incomplete");
  assert.equal(
    "transcript" in item.content[0] && item.content[0].transcript,
    "太阳系以太阳为中心",
  );
});

test("graceful close records a final playback write's original EPIPE failure", async (t) => {
  const h = await fixture(t, createOpenAiRealtimeProtocol());
  let reject!: (error: Error) => void;
  h.setWrite(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  const write = h.transport.write({ type: "playback.final" });
  await flush();
  h.transport.shutdown("graceful");
  reject(
    Object.assign(new Error("native final write rejected"), { code: "EPIPE" }),
  );
  await assert.rejects(write, { code: "EPIPE" });
  await flush();
  const root = h.records.find(
    (item) => item.name === "voice.session" && item.endedAt,
  );
  assert.equal(root?.attributes["langfuse.observation.level"], "ERROR");
  assert.equal(
    root?.attributes["langfuse.observation.metadata.errorCode"],
    "EPIPE",
  );
  assert.equal(
    root?.attributes["langfuse.observation.metadata.failureStage"],
    "websocket.write",
  );
});

function fixtureTool() {
  return tool({
    name: "read",
    description: "Read a fixture value",
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
    execute: async () => ({ value: 1 }),
  });
}

test("OpenAI writes both tool results before requesting one continuation after response.done", async (t) => {
  const h = await fixture(t, createOpenAiRealtimeProtocol(), [fixtureTool()]);
  h.push({ type: "response.created", response: { id: "r" } });
  for (const id of ["c1", "c2"])
    h.push({
      type: "response.function_call_arguments.done",
      response_id: "r",
      call_id: id,
      name: "read",
      arguments: "{}",
    });
  await flush();
  assert.equal(
    h.writes.filter((frame) => frame.item?.type === "function_call_output")
      .length,
    2,
  );
  assert.equal(
    h.writes.filter((frame) => frame.type === "response.create").length,
    0,
  );
  h.push({ type: "response.done", response: { id: "r" } });
  await flush();
  assert.equal(
    h.writes.filter((frame) => frame.type === "response.create").length,
    1,
  );
  h.push({
    type: "response.function_call_arguments.done",
    response_id: "r",
    call_id: "c1",
    name: "read",
    arguments: "{}",
  });
  await flush();
  assert.equal(
    h.writes.filter((frame) => frame.type === "response.create").length,
    1,
  );
});

test("MOSS combines confirmed tool outputs into one continuation and ignores repeated acknowledgments", async (t) => {
  const h = await fixture(t, createMossLiveProtocol(), [fixtureTool()]);
  h.push({
    action: "response.function_call_arguments.done",
    data: { run_id: "r", call_id: "c1", name: "read", arguments: "{}" },
  });
  await flush();
  h.push({
    action: "conversation.item.created",
    data: { item: { type: "function_call_output", call_id: "c1" } },
  });
  await flush();
  assert.equal(
    h.writes.filter((frame) => frame.action === "response.create").length,
    0,
    "early acknowledgment resumed an unsealed tool batch",
  );
  h.push({
    action: "response.done",
    data: {
      run_id: "r",
      response: {
        output: ["c1", "c2"].map((call_id) => ({
          type: "function_call",
          call_id,
          name: "read",
          arguments: "{}",
        })),
      },
    },
  });
  await flush();
  assert.equal(
    h.writes.filter((frame) => frame.action === "response.create").length,
    0,
  );
  const confirm = (call_id: string) =>
    h.push({
      action: "conversation.item.created",
      data: { item: { type: "function_call_output", call_id } },
    });
  confirm("c1");
  await flush();
  assert.equal(
    h.writes.filter((frame) => frame.action === "response.create").length,
    0,
  );
  confirm("c2");
  await flush();
  const continuation = h.writes.filter(
    (frame) => frame.action === "response.create",
  );
  assert.equal(continuation.length, 1);
  assert.deepEqual(continuation[0].response.call_ids, ["c1", "c2"]);
  confirm("c2");
  await flush();
  assert.equal(
    h.writes.filter((frame) => frame.action === "response.create").length,
    1,
  );
  const calls = h.records.filter(record => record.name === "realtime.tool_call");
  assert.equal(new Set(calls.map(record => record.spanId)).size, 2);
  assert.equal(calls.filter(record => record.endedAt !== undefined).length, 2);
});

test("MOSS preserves an unrelated active voice run across either tool-batch event order", async t => {
  for (const speechFirst of [false, true]) {
    const h = await fixture(t, createMossLiveProtocol(), [fixtureTool()]);
    const speech = { action: "response.audio.started", data: { run_id: "speaking-run", turn_id: "spoken-turn" } };
    if (speechFirst) h.push(speech);
    h.push({ action: "response.done", data: { run_id: "tool-run", response: { output: [{ type: "function_call", call_id: "c", name: "read", arguments: "{}" }] } } });
    await flush();
    if (!speechFirst) h.push(speech);
    h.push({ action: "conversation.item.created", data: { item: { type: "function_call_output", call_id: "c" } } });
    await flush();
    assert.equal(h.writes.filter(frame => frame.action === "response.create").length, 0);
    h.push({ action: "response.ended", data: { run_id: "speaking-run", status: "completed" } });
    await flush();
    assert.equal(h.writes.filter(frame => frame.action === "response.create").length, 1);
  }
});

test("SDK business-tool failure keeps the native stage, code and cause in its receipt", async (t) => {
  const tools = createVoiceTools(
    {
      controlBody: async () => {
        throw Object.assign(
          new Error("fixture-key native characteristic write rejected", {
            cause: Object.assign(new Error("write busy"), { code: 17 }),
          }),
          { stage: "body.write", code: "GATT_WRITE_FAILED" },
        );
      },
    },
    "fixture-key",
  );
  const h = await fixture(t, createOpenAiRealtimeProtocol(), tools);
  h.push({
    type: "response.function_call_arguments.done",
    response_id: "r",
    call_id: "body-c",
    name: "control_looi_body",
    arguments: '{"action":"stop"}',
  });
  await flush();
  const output = h.writes.find(
    (frame) => frame.item?.type === "function_call_output",
  );
  const failure = JSON.parse(output.item.output).error;
  assert.equal(failure.stage, "body.write");
  assert.equal(failure.code, "GATT_WRITE_FAILED");
  assert.equal(failure.cause.code, 17);
  assert.equal(failure.cause.message, "write busy");
  assert.equal(
    failure.message,
    "[redacted] native characteristic write rejected",
  );
  const toolRecord = h.records.find(
    (record) => record.name === "realtime.tool_call" && record.endedAt,
  );
  assert.match(JSON.stringify(toolRecord?.attributes), /GATT_WRITE_FAILED/);
});

test("a tool result survives a failed send and keeps the delivery error on its trace", async (t) => {
  const h = await fixture(t, createOpenAiRealtimeProtocol(), [fixtureTool()]);
  h.setWrite(async (raw) => {
    if (typeof raw === "string" && JSON.parse(raw).item?.type === "function_call_output") {
      throw Object.assign(new Error("socket write rejected"), { code: "EPIPE" });
    }
  });
  h.push({
    type: "response.function_call_arguments.done", response_id: "r", call_id: "c",
    name: "read", arguments: "{}",
  });
  await flush();
  h.session.close();
  await flush();
  const call = h.records.find(record => record.name === "realtime.tool_call" && record.endedAt !== undefined);
  assert.ok(call);
  assert.deepEqual(JSON.parse(String(call.attributes["langfuse.observation.output"])), { value: 1 });
  const failedDelivery = h.records.find(record => record.parentSpanId === call.spanId && record.endedAt !== undefined);
  assert.equal(failedDelivery?.attributes["langfuse.observation.metadata.failureStage"], "tool.output");
  assert.equal(failedDelivery?.attributes["langfuse.observation.metadata.errorCode"], "EPIPE");
  assert.match(String(failedDelivery?.attributes["langfuse.observation.status_message"]), /socket write rejected/);
});
