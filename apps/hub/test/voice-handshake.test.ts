import assert from "node:assert/strict";
import { once } from "node:events";
import { setImmediate } from "node:timers/promises";
import { it } from "node:test";
import type { VoiceDownMessage, VoiceUpMessage } from "@super-looi/contracts";
import { buildApp } from "../src/app.js";
import type { AgentExecutor } from "../src/agent/executor.js";
import { VoiceProviderRegistry, type VoiceSessionHandle } from "../src/voice/provider.js";

function delayedProvider() {
  const messages: VoiceUpMessage[] = [];
  const prompts: string[] = [];
  let closeCount = 0;
  let resolveSession!: (session: VoiceSessionHandle) => void;
  let emitDown!: (message: VoiceDownMessage) => void;
  const pending = new Promise<VoiceSessionHandle>((resolve) => { resolveSession = resolve; });
  const voiceRegistry = new VoiceProviderRegistry();
  voiceRegistry.register({
    kind: "doubao",
    name: "Delayed test provider",
    createSession: (options) => {
      emitDown = options.onDownMessage;
      return pending;
    },
  });
  const agentExecutor: AgentExecutor = {
    async run(prompt) {
      prompts.push(prompt);
      return { taskId: "test-task", sessionId: "test-agent", answer: "你好呀", steps: [],
        toolCallsCount: 0, durationMs: 0, finishReason: "completed", runtimeExited: true };
    },
    getTask: () => undefined,
    listTasks: () => [],
    respond() {},
    async cancel() { return { state: "cancelled", runtimeExited: true, confirmed: true }; },
    async close() {},
  };
  return {
    voiceRegistry,
    agentExecutor,
    prompts,
    emit(message: VoiceDownMessage) { emitDown(message); },
    messages,
    get closeCount() { return closeCount; },
    ready() {
      resolveSession({
        sessionId: "delayed-session",
        async sendUpMessage(message) { messages.push(message); },
        async close() { closeCount++; },
      });
    },
  };
}

it("preserves initial unmute and text messages while the upstream voice session opens", async () => {
  const provider = delayedProvider();
  const app = buildApp({ voiceRegistry: provider.voiceRegistry, agentExecutor: provider.agentExecutor });
  await app.ready();
  const socket = await app.injectWS("/ws/voice");
  try {
    socket.send(JSON.stringify({ type: "unmute_commit" }));
    socket.send(JSON.stringify({ type: "text_input", text: "你好" }));
    await setImmediate();
    assert.deepEqual(provider.messages, []);
    provider.ready();
    await setImmediate();
    assert.deepEqual(provider.messages, [
      { type: "unmute_commit" },
      { type: "speak_text", text: "你好呀" },
    ]);
    assert.deepEqual(provider.prompts, ["你好"]);
  } finally {
    const closed = once(socket, "close");
    socket.close();
    await closed;
    await app.close();
  }
});

it("closes a late upstream session when the client disconnects during the handshake", async () => {
  const provider = delayedProvider();
  const app = buildApp({ voiceRegistry: provider.voiceRegistry, agentExecutor: provider.agentExecutor });
  await app.ready();
  const socket = await app.injectWS("/ws/voice");
  try {
    socket.send(JSON.stringify({ type: "unmute_commit" }));
    await setImmediate();
    const closed = once(socket, "close");
    socket.close();
    await closed;
    provider.ready();
    await setImmediate();
    assert.equal(provider.closeCount, 1);
    assert.deepEqual(provider.messages, []);
  } finally {
    await app.close();
  }
});

it("dispatches queued barge-in and mute controls while a queued text task is running", async () => {
  const provider = delayedProvider();
  const run = provider.agentExecutor.run;
  let releaseTask!: () => void;
  const pendingTask = new Promise<void>((resolve) => { releaseTask = resolve; });
  provider.agentExecutor.run = async (prompt, options) => {
    await pendingTask;
    return run(prompt, options);
  };
  const app = buildApp({ voiceRegistry: provider.voiceRegistry, agentExecutor: provider.agentExecutor });
  await app.ready();
  const socket = await app.injectWS("/ws/voice");
  try {
    socket.send(JSON.stringify({ type: "text_input", text: "处理任务" }));
    socket.send(JSON.stringify({ type: "barge_in" }));
    socket.send(JSON.stringify({ type: "mute_commit" }));
    await setImmediate();
    provider.ready();
    await setImmediate();
    assert.deepEqual(provider.messages, [{ type: "barge_in" }, { type: "mute_commit" }]);
    releaseTask();
    await setImmediate();
    assert.equal(provider.messages.at(-1)?.type, "speak_text");
  } finally {
    releaseTask();
    const closed = once(socket, "close");
    socket.close();
    await closed;
    await app.close();
  }
});

it("dispatches a final-only speech agent task after a previous turn used a tool", async () => {
  const provider = delayedProvider();
  const app = buildApp({ voiceRegistry: provider.voiceRegistry, agentExecutor: provider.agentExecutor });
  await app.ready();
  const socket = await app.injectWS("/ws/voice");
  try {
    provider.ready();
    await setImmediate();
    provider.emit({ type: "tool_call", call_id: "task-1", name: "run_agent_task", arguments: { task: "查看状态" } });
    await setImmediate();
    provider.emit({ type: "state_change", state: "listening" });
    provider.emit({ type: "transcript", role: "user", text: "检查当前目录", is_final: true });
    provider.emit({ type: "state_change", state: "listening" });
    await setImmediate();
    assert.deepEqual(provider.prompts, ["查看状态", "检查当前目录"]);
  } finally {
    const closed = once(socket, "close");
    socket.close();
    await closed;
    await app.close();
  }
});
