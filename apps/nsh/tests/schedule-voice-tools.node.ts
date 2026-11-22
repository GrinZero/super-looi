import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  ScheduleEngine,
  type NativeQuietHoursSnapshot,
  type NativeSchedulePort,
  type NativeUpcomingAlarm,
} from "@super-looi/runtime/schedule";
import { SqliteRuntimeStore } from "@super-looi/runtime/storage/sqlite";
import { createOpenAiRealtimeProtocol } from "../../../packages/looi-runtime/src/voice/realtime-protocol.js";
import { VoiceRuntime, type VoiceAudioPort, type VoiceSocket } from "../runtime/voice.js";
import { voiceInstructions } from "../runtime/voice/prompts.js";
import { createVoiceTools } from "../runtime/voice/tools/index.js";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForCondition(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await wait(10);
  }
  throw new Error("Timed out waiting for condition");
}

class MockVoiceSocket implements VoiceSocket {
  writes: any[] = [];
  private reader?: (value: string | null) => void;
  private pending: Array<string | null> = [];

  read(): Promise<string | null> {
    if (this.pending.length > 0) {
      return Promise.resolve(this.pending.shift()!);
    }
    return new Promise((resolve) => {
      this.reader = resolve;
    });
  }

  async write(value: string | Uint8Array): Promise<void> {
    if (typeof value === "string") {
      this.writes.push(JSON.parse(value));
    }
  }

  async close(): Promise<void> {
    this.push(null);
  }

  push(value: unknown): void {
    const raw = value === null ? null : JSON.stringify(value);
    if (this.reader) {
      const resolve = this.reader;
      this.reader = undefined;
      resolve(raw);
    } else {
      this.pending.push(raw);
    }
  }
}

function createVoiceHarness(nowRef: { value: Date }) {
  const db = new DatabaseSync(":memory:");
  const store = new SqliteRuntimeStore(db);
  const syncedAlarms: NativeUpcomingAlarm[][] = [];
  const cancelledAlarms: string[] = [];
  const syncedQuietHours: NativeQuietHoursSnapshot[] = [];

  const nativePort: NativeSchedulePort = {
    permissionStatus: () => ({ notification: "granted", exactAlarmAllowed: true }),
    requestPermission: async () => ({ notification: "granted", exactAlarmAllowed: true }),
    syncUpcomingAlarms: (alarms) => {
      syncedAlarms.push(alarms.map((item) => ({ ...item })));
    },
    cancelAlarm: (ruleId) => {
      cancelledAlarms.push(ruleId);
    },
    syncQuietHours: (snapshot) => {
      syncedQuietHours.push(structuredClone(snapshot));
    },
    postNotification: () => {},
    setAndroidKeepAlive: () => {},
    beginIosBackgroundGrace: () => null,
    endIosBackgroundGrace: () => {},
    drainEvents: () => [],
  };

  let executedRuns = 0;
  const engine = new ScheduleEngine({
    store,
    nativePort,
    now: () => nowRef.value,
    getExecutor: () => ({
      run: async (prompt, options) => {
        executedRuns++;
        const tool = options?.extraTools?.find((item) => item.name === "schedule_report");
        if (tool) {
          await tool.execute(
            "call_report_1",
            {
              outcome: "ok",
              importance: "silent",
              summary: `Checked silently: ${prompt}`,
            },
            new AbortController().signal,
          );
        }
        return {
          taskId: options?.taskId ?? `task_${executedRuns}`,
          sessionId: options?.sessionId ?? "sched_session",
          answer: "Check completed",
          steps: [],
          toolCallsCount: 1,
          durationMs: 12,
          finishReason: "stop",
          runtimeExited: true,
        };
      },
      cancel: async () => ({ state: "cancelled", runtimeExited: true, confirmed: true }),
    }),
  });

  const slots = new Map<string, string>([
    ["model", JSON.stringify({ credentials: { openai: { type: "api_key", key: "openai-voice-key" } } })],
    ["voice", JSON.stringify({ providerId: "openai", wakeEnabled: false })],
  ]);
  const vault = {
    get: (key: string) => slots.get(key) ?? "",
    set: (key: string, value: string) => {
      slots.set(key, value);
    },
    remove: (key: string) => {
      slots.delete(key);
    },
  };

  let queuedPlaybackMs = 0;
  let captureMode = "idle";
  const audio: VoiceAudioPort = {
    requestPermission: () => "granted",
    start: () => {},
    beginWake: () => 0,
    startWake: async () => {
      captureMode = "kws";
      return true;
    },
    stop: () => {
      captureMode = "idle";
    },
    enqueue: (pcm) => {
      queuedPlaybackMs += pcm.length / 48;
    },
    clearPlayback: () => {
      queuedPlaybackMs = 0;
    },
    setMuted: () => {},
    setCaptureMode: (next) => {
      captureMode = next;
    },
    playReadyCue: () => {},
    drainCapture: () => [],
    status: () => ({
      state: "running",
      permission: "granted",
      error: "",
      queuedPlaybackMs,
      captureMode,
      wakeWord: "",
      kwsReady: true,
    }),
  };

  const sockets: MockVoiceSocket[] = [];
  const voice = new VoiceRuntime({
    vault,
    audio,
    protocol: createOpenAiRealtimeProtocol({ model: "gpt-realtime" }),
    connect: async () => {
      const socket = new MockVoiceSocket();
      sockets.push(socket);
      return socket;
    },
    onState: () => {},
    requestTask: async () => "done",
    schedule: () => engine,
    isQuietHoursNow: () => engine.isQuietHoursNow(),
    conversationId: () => "voice_session_1",
  });

  const readToolOutput = (socket: MockVoiceSocket, callId: string): Record<string, unknown> => {
    const frame = socket.writes.find(
      (item) => item.type === "conversation.item.create" && item.item?.type === "function_call_output" && item.item.call_id === callId,
    );
    assert.ok(frame, `Missing function_call_output for ${callId}`);
    return JSON.parse(String(frame.item.output)) as Record<string, unknown>;
  };

  return {
    db,
    store,
    engine,
    nativePort,
    voice,
    sockets,
    syncedAlarms,
    cancelledAlarms,
    syncedQuietHours,
    readToolOutput,
    getExecutedRuns: () => executedRuns,
    cleanup: async () => {
      voice.close();
      await engine.close();
      store.close();
    },
  };
}

test("voice prompts and tool host mount schedule tools cleanly without breaking baseline", async () => {
  const zhInstructions = voiceInstructions("zh-CN");
  const enInstructions = voiceInstructions("en-US");
  assert.match(zhInstructions, /「manage schedule」/);
  assert.match(zhInstructions, /「manage quiet hours」/);
  assert.match(enInstructions, /「manage schedule」/);
  assert.match(enInstructions, /「manage quiet hours」/);

  const baselineTools = createVoiceTools(
    {
      requestTask: async () => "ok",
      sessionId: "s1",
    },
    "voice-test-secret",
  );
  assert.deepEqual(
    baselineTools.map((tool) => tool.name),
    ["run_agent_task"],
  );

  const nowRef = { value: new Date(2026, 10, 22, 22, 50, 0) };
  const h = createVoiceHarness(nowRef);
  try {
    const fullTools = createVoiceTools(
      {
        requestTask: async () => "ok",
        schedule: h.engine,
        sessionId: "s2",
      },
      "voice-test-secret",
    );
    assert.deepEqual(
      fullTools.map((tool) => tool.name),
      ["run_agent_task", "manage_schedule", "manage_quiet_hours"],
    );
  } finally {
    await h.cleanup();
  }
});

test("voice direct manage_schedule and manage_quiet_hours sync native alarms and quiet-hours snapshot", async () => {
  // Use local 22:55 so 23:00-08:00 starts inactive and activates when clock moves to 23:05.
  const nowRef = { value: new Date(2026, 10, 22, 22, 55, 0) };
  const h = createVoiceHarness(nowRef);
  try {
    await h.engine.attachNativePort(h.nativePort);
    await h.voice.start();
    const socket = h.sockets[0];
    assert.ok(socket);
    const handshakeTools = socket.writes[0]?.session?.tools as Array<{ name: string }>;
    assert.ok(handshakeTools.some((tool) => tool.name === "manage_schedule"));
    assert.ok(handshakeTools.some((tool) => tool.name === "manage_quiet_hours"));

    socket.push({ type: "session.created" });
    socket.push({ type: "session.updated", session: { id: "voice_sess" } });
    await wait(25);

    // 1. Voice creates an interval check rule via manage_schedule
    socket.push({
      type: "response.function_call_arguments.done",
      response_id: "resp_1",
      call_id: "call_sched_create",
      name: "manage_schedule",
      arguments: JSON.stringify({
        action: "create",
        title: "检查 CI 构建状态",
        prompt: "使用 github_pr_status 检查 owner=acme repo=looi pullNumber=42 的状态",
        trigger_kind: "interval",
        every_seconds: "300",
        execution_policy: "check_only",
        dedupe_key: "ci-pr-42",
      }),
    });
    await waitForCondition(() =>
      socket.writes.some((item) => item.item?.call_id === "call_sched_create"),
    );

    const createResult = h.readToolOutput(socket, "call_sched_create");
    assert.equal(createResult.created, true);
    const createdRule = createResult.rule as { id: string; sourceSessionId?: string; executionPolicy: string };
    assert.equal(createdRule.sourceSessionId, "voice_session_1");
    assert.equal(createdRule.executionPolicy, "check_only");
    assert.ok(
      h.syncedAlarms.some((list) => list.some((alarm) => alarm.ruleId === createdRule.id)),
      "manage_schedule create did not push native upcoming alarm",
    );

    // 2. Voice updates and runs the rule now
    socket.push({
      type: "response.function_call_arguments.done",
      response_id: "resp_2",
      call_id: "call_sched_update",
      name: "manage_schedule",
      arguments: JSON.stringify({
        action: "update",
        rule_id: createdRule.id,
        title: "检查 PR #42 状态",
      }),
    });
    await waitForCondition(() =>
      socket.writes.some((item) => item.item?.call_id === "call_sched_update"),
    );
    const updateResult = h.readToolOutput(socket, "call_sched_update");
    assert.equal(updateResult.updated, true);
    assert.equal((updateResult.rule as { title: string }).title, "检查 PR #42 状态");

    socket.push({
      type: "response.function_call_arguments.done",
      response_id: "resp_3",
      call_id: "call_sched_run_now",
      name: "manage_schedule",
      arguments: JSON.stringify({
        action: "run_now",
        rule_id: createdRule.id,
      }),
    });
    await waitForCondition(() =>
      socket.writes.some((item) => item.item?.call_id === "call_sched_run_now"),
    );
    const runNowResult = h.readToolOutput(socket, "call_sched_run_now");
    assert.equal((runNowResult.run as { status: string }).status, "succeeded");
    assert.equal(h.getExecutedRuns(), 1);

    // 3. Voice adds cross-midnight 23:00–08:00 quiet hours via manage_quiet_hours
    socket.push({
      type: "response.function_call_arguments.done",
      response_id: "resp_4",
      call_id: "call_qh_add",
      name: "manage_quiet_hours",
      arguments: JSON.stringify({
        action: "add",
        label: "夜间勿扰",
        start_time: "23:00",
        end_time: "08:00",
      }),
    });
    await waitForCondition(() =>
      socket.writes.some((item) => item.item?.call_id === "call_qh_add"),
    );
    const addQhResult = h.readToolOutput(socket, "call_qh_add");
    assert.equal(addQhResult.isQuietNow, false);
    const lastQuietSync = h.syncedQuietHours.at(-1);
    assert.ok(lastQuietSync);
    assert.equal(lastQuietSync.quietHoursEnabled, true);
    assert.equal(lastQuietSync.windows.length, 1);
    assert.equal(lastQuietSync.windows[0]?.startMinute, 23 * 60);
    assert.equal(lastQuietSync.windows[0]?.endMinute, 8 * 60);

    // Verify clock crossover to 23:05 activates quiet hours in real time
    nowRef.value = new Date(2026, 10, 22, 23, 5, 0);
    assert.equal(h.engine.isQuietHoursNow(), true);

    // 4. Voice cancels the rule and removes quiet hours
    const addedWindowId = lastQuietSync.windows[0]!.id;
    socket.push({
      type: "response.function_call_arguments.done",
      response_id: "resp_5",
      call_id: "call_sched_cancel",
      name: "manage_schedule",
      arguments: JSON.stringify({
        action: "cancel",
        rule_id: createdRule.id,
      }),
    });
    await waitForCondition(() =>
      socket.writes.some((item) => item.item?.call_id === "call_sched_cancel"),
    );
    const cancelResult = h.readToolOutput(socket, "call_sched_cancel");
    assert.equal(cancelResult.cancelled, true);
    assert.equal((cancelResult.rule as { state: string }).state, "cancelled");
    assert.ok(h.cancelledAlarms.includes(createdRule.id));

    socket.push({
      type: "response.function_call_arguments.done",
      response_id: "resp_6",
      call_id: "call_qh_remove",
      name: "manage_quiet_hours",
      arguments: JSON.stringify({
        action: "remove",
        window_id: addedWindowId,
      }),
    });
    await waitForCondition(() =>
      socket.writes.some((item) => item.item?.call_id === "call_qh_remove"),
    );
    const removeQhResult = h.readToolOutput(socket, "call_qh_remove");
    assert.equal((removeQhResult.settings as { quietHours: unknown[] }).quietHours.length, 0);
    assert.equal(h.syncedQuietHours.at(-1)?.windows.length, 0);
  } finally {
    await h.cleanup();
  }
});
