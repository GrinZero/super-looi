import { Buffer } from "node:buffer";
import {
  VoiceRuntime,
  VoiceTaskCoordinator,
  toSpokenPlainText,
  type VoiceAudioPort,
  type VoiceSocket,
  type VoiceTaskRunHooks,
} from "../runtime/voice.js";
import { createOpenAiRealtimeProtocol } from "../../../packages/looi-runtime/src/voice/realtime-protocol.js";

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

class MockVoiceSocket implements VoiceSocket {
  writes: Array<Record<string, any>> = [];
  closed = false;
  private reader?: (value: string | null) => void;
  private pending: Array<string | null> = [];

  read(): Promise<string | null> {
    if (this.pending.length) return Promise.resolve(this.pending.shift()!);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.reader = resolve;
    });
  }

  async write(value: string): Promise<void> {
    this.writes.push(JSON.parse(value));
  }

  async close(): Promise<void> {
    this.closed = true;
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

function readDoubaoToolOutput(writes: Array<Record<string, any>>, callId: string): Record<string, any> {
  const frame = writes.find(
    (w) => w.type === "conversation.item.create" && w.items?.[0]?.call_id === callId,
  );
  const raw = frame?.items?.[0]?.content?.[0]?.text ?? "{}";
  return JSON.parse(raw);
}

function createMockAudio() {
  let state = "idle";
  let captureMode = "idle";
  let queuedPlaybackMs = 0;
  const port: VoiceAudioPort = {
    requestPermission: () => "granted",
    start: () => {
      state = "running";
      captureMode = "conversation";
    },
    setCaptureMode: (mode) => {
      state = "running";
      captureMode = mode;
    },
    playReadyCue: () => {},
    stop: () => {
      state = "idle";
      captureMode = "idle";
      queuedPlaybackMs = 0;
    },
    enqueue: (pcm) => {
      queuedPlaybackMs += pcm.length / 48;
    },
    clearPlayback: () => {
      queuedPlaybackMs = 0;
    },
    setMuted: () => {},
    drainCapture: () => [],
    status: () => ({
      state,
      permission: "granted",
      error: "",
      queuedPlaybackMs,
      captureMode,
      wakeWord: "",
      kwsReady: true,
    }),
  };
  return {
    port,
    setQueuedPlaybackMs(ms: number) {
      queuedPlaybackMs = ms;
    },
  };
}

export async function verifyAsyncVoiceTasks() {
  // 1. Plain-text spoken sanitizer strips Markdown, code fences, and truncates at sentence boundary.
  const cleaned = toSpokenPlainText(
    "### 重构总结\n- 已更新 `AuthService.ts` 与 [登录文档](https://example.com)。\n```ts\nconst secret = 42;\n```\n全部 **24** 个测试均已通过！接下来你可以直接在设置页切换账号体验新流程。",
    50,
  );
  check(
    !cleaned.includes("```") &&
      !cleaned.includes("`") &&
      !cleaned.includes("**") &&
      !cleaned.includes("https://") &&
      cleaned.endsWith("！"),
    `toSpokenPlainText did not sanitize or cut cleanly: ${cleaned}`,
  );

  // 2. Doubao Duplex V3: fast inline task + slow background promotion + WHEN_IDLE gate + endSession survival.
  const slots = new Map<string, string>([
    ["voice", JSON.stringify({ apiKey: "test-doubao-key", wakeEnabled: true })],
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
  const audio = createMockAudio();
  const sockets: MockVoiceSocket[] = [];
  let cancelCalls = 0;
  let activeRun:
    | {
        prompt: string;
        hooks: VoiceTaskRunHooks;
        resolve: (value: { answer: string; taskId?: string }) => void;
        reject: (error: Error) => void;
      }
    | undefined;
  let nextMode: "fast" | "controlled" = "fast";

  let voice!: VoiceRuntime;
  const coordinator = new VoiceTaskCoordinator({
    fastPathMs: 70,
    defaultLanguage: () => "zh-CN",
    runTask: async (prompt, hooks) => {
      if (nextMode === "fast") {
        await wait(15);
        return { answer: "客厅主灯已打开。", taskId: "rt_fast_1" };
      }
      return new Promise((resolve, reject) => {
        activeRun = { prompt, hooks, resolve, reject };
      });
    },
    cancelRunningTask: async () => {
      cancelCalls++;
      return true;
    },
    onNotice: (notice) => voice.enqueueNotice(notice),
    onContextNote: (note) => voice.setContextNote(note),
  });

  voice = new VoiceRuntime({
    vault,
    audio: audio.port,
    connect: async () => {
      const socket = new MockVoiceSocket();
      sockets.push(socket);
      return socket;
    },
    onState: () => {},
    taskBridge: coordinator,
  });

  await voice.start();
  const s1 = sockets[0];
  const handshakeTools = s1.writes[0]?.session?.tools;
  check(
    Array.isArray(handshakeTools) &&
      handshakeTools.some((t: any) => t.name === "run_agent_task") &&
      handshakeTools.some((t: any) => t.name === "manage_agent_task"),
    "Doubao handshake did not expose both run_agent_task and manage_agent_task",
  );

  s1.push({ type: "session.created" });
  await wait(25);

  // 2a. Fast task (< fastPathMs) finishes inline within a single turn, emitting zero proactive speech commits.
  s1.push({
    type: "response.function_call_arguments.done",
    call_id: "call_fast_1",
    name: "run_agent_task",
    arguments: JSON.stringify({ prompt: "打开客厅主灯" }),
  });
  await wait(45);
  const fastPayload = readDoubaoToolOutput(s1.writes, "call_fast_1");
  check(
    fastPayload.status === "completed" &&
      fastPayload.taskId === "rt_fast_1" &&
      fastPayload.answer === "客厅主灯已打开。",
    "fast task did not complete inline",
  );
  check(
    !s1.writes.some((w) => w.type === "speech_text_buffer.commit"),
    "fast inline task emitted redundant proactive speech",
  );
  // Complete the assistant's reply to the fast tool call so turn returns to waiting_user.
  s1.push({ type: "response.done", response: { id: "r_fast_done" } });
  await wait(20);

  // 2b. Slow task (> fastPathMs) promotes to running_in_background, supports status inspection, and gates proactive speech until WHEN_IDLE.
  nextMode = "controlled";
  s1.push({
    type: "response.function_call_arguments.done",
    call_id: "call_slow_1",
    name: "run_agent_task",
    arguments: JSON.stringify({ prompt: "重构登录模块并跑单测" }),
  });
  await wait(20);
  check(Boolean(activeRun), "controlled task did not start");
  activeRun!.hooks.onStep({
    step: 2,
    phase: "tool",
    summary: "正在修改 AuthService 并运行测试",
    taskId: "rt_long_1",
  });

  await wait(75);
  const promotedPayload = readDoubaoToolOutput(s1.writes, "call_slow_1");
  check(
    promotedPayload.status === "running_in_background" &&
      promotedPayload.taskId === "rt_long_1" &&
      promotedPayload.latestSummary === "正在修改 AuthService 并运行测试",
    "slow task did not promote to running_in_background with step summary",
  );

  // Assistant acknowledges background promotion and starts speaking.
  s1.push({ type: "response.output_audio.started", response_id: "r_ack" });
  s1.push({
    type: "response.output_audio.delta",
    response_id: "r_ack",
    delta: Buffer.alloc(960).toString("base64"),
  });
  await wait(35);
  check(voice.snapshot().phase === "speaking", "session did not enter speaking");

  // Query status via manage_agent_task while running, and verify concurrent run_agent_task returns busy.
  s1.push({
    type: "response.function_call_arguments.done",
    call_id: "call_status_1",
    name: "manage_agent_task",
    arguments: JSON.stringify({ action: "status" }),
  });
  s1.push({
    type: "response.function_call_arguments.done",
    call_id: "call_busy_1",
    name: "run_agent_task",
    arguments: JSON.stringify({ prompt: "再跑一个任务" }),
  });
  await wait(30);
  const statusPayload = readDoubaoToolOutput(s1.writes, "call_status_1");
  check(
    statusPayload.taskId === "rt_long_1" &&
      statusPayload.state === "running" &&
      statusPayload.latestSummary === "正在修改 AuthService 并运行测试",
    "manage_agent_task(status) did not return live step progress",
  );
  const busyPayload = readDoubaoToolOutput(s1.writes, "call_busy_1");
  check(
    busyPayload.status === "busy",
    "concurrent run_agent_task did not return busy",
  );

  // Background task finishes WHILE LOOI is actively speaking -> notice MUST stay queued!
  activeRun!.resolve({
    answer: "已完成 **AuthService** 重构，单测 `pnpm test` 全部通过。",
    taskId: "rt_long_1",
  });
  activeRun = undefined;
  await wait(35);
  check(
    !s1.writes.some((w) => w.type === "speech_text_buffer.commit"),
    "proactive notice interrupted active assistant speech before WHEN_IDLE",
  );

  // Finish assistant speech stream and drain native playback -> WHEN_IDLE triggers proactive speech!
  s1.push({ type: "response.output_audio.done", response_id: "r_ack" });
  s1.push({ type: "response.done", response: { id: "r_ack" } });
  audio.setQueuedPlaybackMs(0);
  await wait(45);

  const speechCommit = s1.writes.find((w) => w.type === "speech_text_buffer.commit");
  check(
    Boolean(speechCommit) &&
      speechCommit!.text.includes("已完成 AuthService 重构，单测 pnpm test 全部通过。") &&
      !speechCommit!.text.includes("**") &&
      !speechCommit!.text.includes("`"),
    "Doubao WHEN_IDLE did not commit sanitized speech_text_buffer.commit",
  );
  check(
    voice.snapshot().transcript === speechCommit!.text,
    "Doubao proactive speech did not sync local transcript",
  );
  check(
    s1.writes.some(
      (w) =>
        w.type === "session.update" &&
        typeof w.session?.instructions === "string" &&
        w.session.instructions.includes("[Background Task Receipt (rt_long_1, completed)]"),
    ),
    "Doubao proactive speech did not sync background task receipt into session instructions",
  );

  // 2c. Detached survival across endSession() (auto-sleep to standby):
  s1.push({ type: "response.done", response: { id: "r_notice_done" } });
  await wait(20);
  s1.push({
    type: "response.function_call_arguments.done",
    call_id: "call_survive_1",
    name: "run_agent_task",
    arguments: JSON.stringify({ prompt: "整理整周会议纪要" }),
  });
  await wait(90);
  check(coordinator.hasActiveTask, "detached task was not active");
  voice.endSession();
  await wait(30);
  check(
    voice.snapshot().phase === "standby" &&
      cancelCalls === 0 &&
      coordinator.hasActiveTask,
    "voice.endSession() killed an active background task instead of detaching cleanly",
  );
  activeRun!.resolve({
    answer: "会议纪要已归档到 docs/weekly.md。",
    taskId: "rt_survive_2",
  });
  activeRun = undefined;
  await wait(25);

  // Re-opening a new session after standby carries the background task receipt in initial handshake!
  await voice.start({ fromWakeWord: true });
  const s2 = sockets[1];
  check(
    typeof s2.writes[0]?.session?.instructions === "string" &&
      s2.writes[0].session.instructions.includes(
        "[Background Task Receipt (rt_survive_2, completed)]",
      ),
    "new session after standby lost detached background task receipt",
  );
  voice.close();

  // 3. OpenAI Realtime: early approval yield + user_speaking gate + proactive notice + task cancellation.
  const openAiSlots = new Map<string, string>([
    ["voice", JSON.stringify({ apiKeys: { openai: "sk-test-openai" }, wakeEnabled: false })],
  ]);
  const openAiVault = {
    get: (key: string) => openAiSlots.get(key) ?? "",
    set: (key: string, value: string) => {
      openAiSlots.set(key, value);
    },
    remove: (key: string) => {
      openAiSlots.delete(key);
    },
  };
  const openAiAudio = createMockAudio();
  const openAiSockets: MockVoiceSocket[] = [];
  let openAiRun:
    | {
        hooks: VoiceTaskRunHooks;
        resolve: (value: { answer: string; taskId?: string }) => void;
        reject: (error: Error) => void;
      }
    | undefined;
  let openAiCancels = 0;

  let openAiVoice!: VoiceRuntime;
  const openAiCoordinator = new VoiceTaskCoordinator({
    fastPathMs: 120,
    defaultLanguage: () => "en-US",
    runTask: async (_prompt, hooks) =>
      new Promise((resolve, reject) => {
        openAiRun = { hooks, resolve, reject };
      }),
    cancelRunningTask: async () => {
      openAiCancels++;
      return true;
    },
    onNotice: (notice) => openAiVoice.enqueueNotice(notice),
    onContextNote: (note) => openAiVoice.setContextNote(note),
  });

  openAiVoice = new VoiceRuntime({
    vault: openAiVault,
    audio: openAiAudio.port,
    protocol: createOpenAiRealtimeProtocol({ model: "gpt-realtime" }),
    connect: async () => {
      const socket = new MockVoiceSocket();
      openAiSockets.push(socket);
      return socket;
    },
    onState: () => {},
    taskBridge: openAiCoordinator,
  });

  await openAiVoice.start();
  const os = openAiSockets[0];
  os.push({ type: "session.created" });
  os.push({ type: "session.updated", session: { id: "sess_oa" } });
  await wait(25);

  // 3a. Approval interaction during fast window yields immediately without waiting full 120ms and without duplicate notice.
  os.push({
    type: "response.function_call_arguments.done",
    call_id: "oa_call_1",
    name: "run_agent_task",
    arguments: JSON.stringify({ prompt: "Deploy preview build" }),
  });
  await wait(15);
  openAiRun!.hooks.onStep({
    step: 1,
    phase: "approval",
    summary: "Awaiting shell deployment approval",
    taskId: "rt_oa_1",
    interaction: {
      id: "ix_approve_1",
      kind: "approval",
      details: { command: "pnpm deploy" },
    },
  });
  await wait(25);
  const approvalToolReply = os.writes.find(
    (w) => w.type === "conversation.item.create" && w.item?.call_id === "oa_call_1",
  );
  const approvalPayload = JSON.parse(approvalToolReply?.item?.output ?? "{}");
  check(
    approvalPayload.status === "waiting_user_confirmation" &&
      approvalPayload.interactionKind === "approval" &&
      approvalPayload.taskId === "rt_oa_1",
    "approval interaction did not yield early from fast window",
  );
  os.push({ type: "response.done", response: { id: "r_oa_1" } });
  await wait(25);
  check(
    !os.writes.some(
      (w) =>
        w.type === "conversation.item.create" &&
        w.item?.role === "user" &&
        JSON.stringify(w.item).includes("[Background Task Update]"),
    ),
    "early-yielded interaction emitted duplicate proactive notice",
  );

  // 3b. Post-promotion question interaction while user is speaking waits until user stops speaking!
  os.push({ type: "input_audio_buffer.speech_started" });
  await wait(15);
  openAiRun!.hooks.onStep({
    step: 2,
    phase: "question",
    summary: "Select target environment",
    taskId: "rt_oa_1",
    interaction: {
      id: "ix_question_2",
      kind: "question",
      details: {},
    },
  });
  await wait(25);
  check(
    !os.writes.some(
      (w) =>
        w.type === "conversation.item.create" &&
        w.item?.role === "user" &&
        JSON.stringify(w.item).includes("[Background Task Update]"),
    ),
    "proactive notice interrupted user_speaking on OpenAI",
  );

  // User speech turns out to be noise / transcription failed -> returns to waiting_user -> notice flushes!
  os.push({ type: "conversation.item.input_audio_transcription.failed" });
  await wait(30);
  const oaNoticeItem = os.writes.find(
    (w) =>
      w.type === "conversation.item.create" &&
      w.item?.role === "user" &&
      JSON.stringify(w.item).includes("[Background Task Update]"),
  );
  check(
    Boolean(oaNoticeItem) &&
      JSON.stringify(oaNoticeItem).includes("quick question on screen"),
    "OpenAI WHEN_IDLE did not flush queued interaction notice after user speech ended",
  );
  check(
    os.writes.filter((w) => w.type === "response.create").length >= 2,
    "OpenAI proactive notice did not trigger response.create",
  );
  os.push({ type: "response.done", response: { id: "r_oa_notice" } });
  await wait(20);

  // 3c. manage_agent_task(cancel) cancels the task and suppresses late completion/failure notices.
  const noticesBeforeCancel = os.writes.filter(
    (w) =>
      w.type === "conversation.item.create" &&
      w.item?.role === "user" &&
      JSON.stringify(w.item).includes("[Background Task Update]"),
  ).length;
  os.push({
    type: "response.function_call_arguments.done",
    call_id: "oa_cancel_1",
    name: "manage_agent_task",
    arguments: JSON.stringify({ action: "cancel", task_id: "rt_oa_1" }),
  });
  await wait(30);
  const cancelReply = os.writes.find(
    (w) => w.type === "conversation.item.create" && w.item?.call_id === "oa_cancel_1",
  );
  const cancelPayload = JSON.parse(cancelReply?.item?.output ?? "{}");
  check(
    cancelPayload.cancelled === true &&
      cancelPayload.taskId === "rt_oa_1" &&
      openAiCancels === 1,
    "manage_agent_task(cancel) did not cancel active task",
  );
  os.push({ type: "response.done", response: { id: "r_oa_cancel_done" } });
  openAiRun!.reject(new Error("aborted"));
  await wait(35);
  const noticesAfterCancel = os.writes.filter(
    (w) =>
      w.type === "conversation.item.create" &&
      w.item?.role === "user" &&
      JSON.stringify(w.item).includes("[Background Task Update]"),
  ).length;
  check(
    noticesAfterCancel === noticesBeforeCancel,
    "cancelled background task still emitted a failure notice",
  );

  // An unconfirmed runtime cancellation must leave the task visible until it finishes.
  let finishUnconfirmed!: (value: { answer: string; taskId: string }) => void;
  const unconfirmedNotices: string[] = [];
  const unconfirmed = new VoiceTaskCoordinator({
    fastPathMs: 50,
    runTask: () => new Promise((resolve) => { finishUnconfirmed = resolve; }),
    cancelRunningTask: async () => false,
    onNotice: (notice) => unconfirmedNotices.push(notice.spokenText),
  });
  const unconfirmedSubmission = await unconfirmed.submit("查看今天的日程");
  const unconfirmedCancellation = await unconfirmed.cancel(unconfirmedSubmission.taskId);
  check(!unconfirmedCancellation.cancelled, "unconfirmed cancellation was reported as successful");
  check(
    unconfirmed.hasActiveTask &&
      unconfirmed.inspect(unconfirmedSubmission.taskId)?.state === "running",
    "unconfirmed cancellation hid a still-running task",
  );
  finishUnconfirmed({ answer: "今天有两场会议。", taskId: "rt_unconfirmed_1" });
  await wait(0);
  check(
    unconfirmed.inspect("rt_unconfirmed_1")?.state === "completed" &&
      unconfirmedNotices.length === 1,
    "unconfirmed cancellation suppressed the completed task notice",
  );

  // 3d. Rapid tool reply race: response.done for the function-call turn itself OR during user_speaking must NOT flush noticeQueue prematurely.
  os.push({ type: "input_audio_buffer.speech_started" });
  await wait(15);
  openAiVoice.enqueueNotice({
    id: "oa_race_notice_1",
    spokenText: "Queued notice waiting for clean idle turn.",
  });
  // Late response.done during user_speaking must NOT flush noticeQueue!
  os.push({ type: "response.done", response: { id: "r_stale_prev" } });
  await wait(20);
  check(
    !os.writes.some((w) => JSON.stringify(w).includes("Queued notice waiting for clean idle turn.")),
    "late response.done during user_speaking flushed notice prematurely",
  );
  os.push({ type: "input_audio_buffer.speech_stopped" });
  os.push({
    type: "response.function_call_arguments.done",
    response_id: "r_tool_turn",
    call_id: "oa_status_race_1",
    name: "manage_agent_task",
    arguments: JSON.stringify({ action: "status" }),
  });
  await wait(25);
  // Tool reply already emitted response.create for the post-tool response; now r_tool_turn's own response.done arrives!
  const createsBeforeToolDone = os.writes.filter((w) => w.type === "response.create").length;
  os.push({ type: "response.done", response: { id: "r_tool_turn" } });
  await wait(25);
  check(
    os.writes.filter((w) => w.type === "response.create").length === createsBeforeToolDone &&
      !os.writes.some((w) => JSON.stringify(w).includes("Queued notice waiting for clean idle turn.")),
    "function-call turn's own response.done collided with post-tool response by flushing noticeQueue",
  );
  // Once the post-tool response `r_post_tool` finishes, the queued notice flushes cleanly!
  os.push({ type: "response.done", response: { id: "r_post_tool" } });
  await wait(30);
  check(
    os.writes.some((w) => JSON.stringify(w).includes("Queued notice waiting for clean idle turn.")),
    "queued notice did not flush after post-tool response completed",
  );
  os.push({ type: "response.done", response: { id: "r_race_notice_done" } });
  await wait(20);

  openAiVoice.close();

  // 4. Coordinator edge cases: external foreground busy, fast-window confirmed cancel, fast-path failure & promoted background failure.
  let externalBusy = true;
  const edgeNotices: string[] = [];
  const edgeNotes: string[] = [];
  let edgeMode: "hang" | "fast_fail" | "slow_fail" = "hang";
  let rejectSlowFail!: (err: Error) => void;
  const edgeCoordinator = new VoiceTaskCoordinator({
    fastPathMs: 60,
    defaultLanguage: () => "zh-CN",
    isExternalBusy: () => externalBusy,
    runTask: async () => {
      if (edgeMode === "fast_fail") {
        await wait(10);
        throw new Error("disk full");
      }
      if (edgeMode === "slow_fail") {
        return new Promise((_, reject) => {
          rejectSlowFail = reject;
        });
      }
      return new Promise(() => {});
    },
    cancelRunningTask: async () => true,
    onNotice: (n) => edgeNotices.push(n.spokenText),
    onContextNote: (note) => edgeNotes.push(note),
  });

  // 4a. External foreground task busy returns busy without polluting context notes or latestTask.
  const extBusyRes = await edgeCoordinator.submit("语音插队任务");
  check(
    extBusyRes.status === "busy" &&
      edgeCoordinator.inspect() === null &&
      edgeNotes.length === 0,
    "external foreground busy polluted coordinator state or context notes",
  );

  // 4b. Confirmed cancel inside fastPathMs settles submit() immediately instead of hanging.
  externalBusy = false;
  edgeMode = "hang";
  const pendingFastSubmit = edgeCoordinator.submit("卡住的任务");
  await wait(15);
  const fastCancel = await edgeCoordinator.cancel();
  const fastSubmitResult = await pendingFastSubmit;
  check(
    fastCancel.cancelled === true &&
      fastSubmitResult.status === "failed" &&
      !edgeCoordinator.hasActiveTask,
    "confirmed cancel inside fast window left submit() hanging",
  );

  // 4c. Fast-path failure (< fastPathMs) returns failed inline without proactive notice; promoted failure emits failure notice + context receipt.
  edgeMode = "fast_fail";
  const fastFailRes = await edgeCoordinator.submit("快失败任务");
  check(
    fastFailRes.status === "failed" && edgeNotices.length === 0,
    "fast-path failure did not fail inline cleanly",
  );
  edgeMode = "slow_fail";
  const slowFailSubmit = await edgeCoordinator.submit("慢失败后台任务");
  check(slowFailSubmit.status === "running_in_background", "slow_fail did not promote");
  rejectSlowFail(new Error("compilation failed"));
  await wait(20);
  check(
    edgeNotices.length === 1 &&
      edgeNotices[0].includes("没能顺利完成") &&
      edgeNotes.some((n) => n.includes("failed") && n.includes("compilation failed")),
    "promoted background task failure did not emit failure notice and receipt",
  );

  // 5. Concurrency & protocol edge cases on Doubao:
  //    - serverResponseDone local-drain barge-in (no 4s cancel timeout, no swallowed frames)
  //    - audio_started -> response.done without audio_done (no speaking deadlock)
  //    - multi-frame proactive send aborted & re-queued on barge-in
  //    - sequential FIFO notices (second waits for first playback to drain)
  //    - multi-turn text_delta resets transcript cleanly after proactive notice
  //    - awaitingTimer flushes noticeQueue instead of hanging up when VAD filtered noise
  //    - proactive send failure converges to runtimeVoiceNetworkSendFailed without poisoning reconnect
  const originalSetTimeout = globalThis.setTimeout;
  const originalDateNow = Date.now;
  let accelerateIdleTimers = false;
  let clockBase = originalDateNow();
  Date.now = () =>
    accelerateIdleTimers
      ? clockBase + Math.floor((originalDateNow() - clockBase) * (12000 / 120))
      : originalDateNow();
  globalThis.setTimeout = ((handler: Parameters<typeof setTimeout>[0], delay?: number, ...args: unknown[]) =>
    originalSetTimeout(
      handler,
      accelerateIdleTimers && delay && delay >= 6000 && delay <= 12000
        ? Math.round((delay * 120) / 12000)
        : delay,
      ...args,
    )) as typeof setTimeout;

  try {
    const edgeAudio = createMockAudio();
    const edgeSockets: MockVoiceSocket[] = [];
    let failNextSpeechCommit = false;
    const edgeVoice = new VoiceRuntime({
      vault: {
        get: () => JSON.stringify({ apiKey: "edge-doubao-key", wakeEnabled: false }),
        set: () => {},
        remove: () => {},
      },
      audio: edgeAudio.port,
      connect: async () => {
        const inner = new MockVoiceSocket();
        edgeSockets.push(inner);
        return {
          read: () => inner.read(),
          write: async (raw: string) => {
            const parsed = JSON.parse(raw);
            if (parsed.type === "speech_text_buffer.commit" && failNextSpeechCommit) {
              failNextSpeechCommit = false;
              throw new Error("simulated socket write failure");
            }
            await inner.write(raw);
          },
          close: () => inner.close(),
        };
      },
      onState: () => {},
    });

    await edgeVoice.start();
    const es = edgeSockets[0];
    es.push({ type: "session.created" });
    await wait(25);

    // 5a. Doubao serverResponseDone local-drain barge-in: server sends response.done early, local audio still playing -> interrupt clears locally without response.cancel!
    es.push({ type: "response.output_audio.started", response_id: "r_early" });
    es.push({
      type: "response.output_audio.delta",
      response_id: "r_early",
      delta: Buffer.alloc(960).toString("base64"),
    });
    es.push({ type: "response.output_audio.done", response_id: "r_early" });
    es.push({ type: "response.done", response: { id: "r_early" } });
    edgeAudio.setQueuedPlaybackMs(1500);
    await wait(30);
    check(edgeVoice.snapshot().phase === "speaking", "expected local playback still speaking");
    edgeVoice.interrupt();
    await wait(20);
    check(
      edgeVoice.snapshot().phase === "listening" &&
        !es.writes.some((w) => w.type === "response.cancel"),
      "post-response.done local-drain barge-in sent stale response.cancel",
    );

    // 5b. audio_started followed directly by response.done (missing audio_done) must NOT deadlock in speaking!
    es.push({ type: "response.output_audio.started", response_id: "r_truncated" });
    await wait(20);
    check(edgeVoice.snapshot().phase === "speaking", "audio_started did not enter speaking");
    es.push({ type: "response.done", response: { id: "r_truncated" } });
    edgeAudio.setQueuedPlaybackMs(0);
    await wait(45);
    check(
      edgeVoice.snapshot().phase === "listening",
      "missing audio_done before response.done deadlocked session in speaking",
    );

    // 5c. Multi-frame proactive notice aborted mid-send by user_speech_started is NOT spoken on top of user AND re-queues cleanly!
    let resumeBlockedUpdate: (() => void) | undefined;
    let blockOnce = true;
    const esOrigWrite = es.write.bind(es);
    es.write = async (raw: string) => {
      const parsed = JSON.parse(raw);
      await esOrigWrite(raw);
      if (parsed.type === "session.update" && blockOnce) {
        blockOnce = false;
        await new Promise<void>((r) => {
          resumeBlockedUpdate = r;
        });
      }
    };

    edgeVoice.enqueueNotice({
      id: "edge_abort_1",
      spokenText: "第一条可恢复通知",
      contextNote: "[Receipt abort_1]",
    });
    await wait(15);
    // User starts speaking while session.update is in flight!
    es.push({ type: "input_audio_buffer.speech_started" });
    await wait(15);
    resumeBlockedUpdate?.();
    await wait(25);
    check(
      !es.writes.some((w) => w.type === "speech_text_buffer.commit" && w.text === "第一条可恢复通知"),
      "aborted multi-frame notice still sent speech_text_buffer.commit during user speech",
    );

    // 5d. User stops speaking (`awaiting_reply`), VAD filters noise (no response.done), 12s awaitingTimer fires -> flushes re-queued notice instead of hanging up!
    clockBase = originalDateNow();
    accelerateIdleTimers = true;
    es.push({ type: "input_audio_buffer.speech_stopped" });
    await wait(160);
    accelerateIdleTimers = false;
    check(
      edgeVoice.snapshot().phase === "listening" &&
        es.writes.some((w) => w.type === "speech_text_buffer.commit" && w.text === "第一条可恢复通知"),
      "awaitingTimer dropped queued notice instead of flushing it",
    );

    // 5e. Sequential FIFO notices + clean multi-turn transcript reset:
    es.push({ type: "response.output_audio.started", response_id: "r_n1" });
    es.push({
      type: "response.output_audio.delta",
      response_id: "r_n1",
      delta: Buffer.alloc(960).toString("base64"),
    });
    await wait(25);
    edgeVoice.enqueueNotice({ id: "fifo_1", spokenText: "队列通知一" });
    edgeVoice.enqueueNotice({ id: "fifo_2", spokenText: "队列通知二" });
    es.push({ type: "response.output_audio.done", response_id: "r_n1" });
    es.push({ type: "response.done", response: { id: "r_n1" } });
    edgeAudio.setQueuedPlaybackMs(0);
    await wait(45);
    check(
      es.writes.some((w) => w.type === "speech_text_buffer.commit" && w.text === "队列通知一") &&
        !es.writes.some((w) => w.type === "speech_text_buffer.commit" && w.text === "队列通知二"),
      "FIFO notices dispatched concurrently before first notice finished speaking",
    );
    // Complete first notice's speech -> second notice dispatches!
    es.push({ type: "response.output_audio.started", response_id: "r_fifo_1" });
    es.push({ type: "response.output_audio.done", response_id: "r_fifo_1" });
    es.push({ type: "response.done", response: { id: "r_fifo_1" } });
    await wait(45);
    check(
      es.writes.some((w) => w.type === "speech_text_buffer.commit" && w.text === "队列通知二") &&
        edgeVoice.snapshot().transcript === "队列通知二",
      "second FIFO notice did not dispatch after first notice drained",
    );
    es.push({ type: "response.done", response: { id: "r_fifo_2" } });
    await wait(20);
    // Next turn's streaming text_delta must reset transcript rather than concatenating onto "队列通知二"!
    es.push({ type: "response.output_text.delta", response_id: "r_next_turn", delta: "全新回复" });
    await wait(20);
    check(
      edgeVoice.snapshot().transcript === "全新回复",
      `text_delta concatenated onto previous proactive transcript: ${edgeVoice.snapshot().transcript}`,
    );
    es.push({ type: "response.done", response: { id: "r_next_turn" } });
    await wait(20);

    // 5f. Proactive send failure converges to runtimeVoiceNetworkSendFailed without poisoning reconnect:
    failNextSpeechCommit = true;
    edgeVoice.enqueueNotice({ id: "fail_send_1", spokenText: "触发发送异常" });
    await wait(35);
    check(
      edgeVoice.snapshot().phase === "error" &&
        edgeVoice.snapshot().error === "@looi:runtimeVoiceNetworkSendFailed",
      "proactive send failure did not surface runtimeVoiceNetworkSendFailed",
    );
    await edgeVoice.start();
    edgeSockets[1].push({ type: "session.created" });
    await wait(25);
    check(
      edgeVoice.snapshot().phase === "listening",
      "failed proactive send poisoned subsequent reconnected session",
    );
    edgeVoice.close();
  } finally {
    Date.now = originalDateNow;
    globalThis.setTimeout = originalSetTimeout;
  }
}
