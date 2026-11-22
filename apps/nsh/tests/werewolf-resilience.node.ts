import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createOpenAiRealtimeProtocol } from "../../../packages/looi-runtime/src/voice/realtime-protocol.js";
import { visionPersonTrackerDefinition } from "../plugins/vision-person-tracker/runtime/index.js";
import {
  WEREWOLF_PLUGIN_ID,
  type WerewolfCommand,
  type WerewolfPublicState,
} from "../plugins/werewolf-judge/contracts.js";
import { WerewolfEngine } from "../plugins/werewolf-judge/runtime/engine.js";
import { LanCompanionController } from "../plugins/werewolf-judge/runtime/lan-companion.js";
import { buildPresetRules } from "../plugins/werewolf-judge/runtime/presets.js";
import { werewolfJudgeDefinition } from "../plugins/werewolf-judge/runtime/index.js";
import { BodyRuntime } from "../runtime/body.js";
import { VisionBroker } from "../runtime/device-camera.js";
import { LanRoomBroker, createLanRoomCapability } from "../runtime/lan-room.js";
import type {
  DetectedCameraFace,
  NativeDeviceCameraFrame,
  NativeDeviceCameraPort,
  NativeLanHttpRequest,
  NativeLanRoomInfo,
  NativeLanRoomPort,
} from "../runtime/plugins/shared-types.js";
import { createEffectScope } from "../runtime/plugins/effect-scope.js";
import { createBodyCapability, createVisionCapability } from "../runtime/plugins/embodied-drivers.js";
import { PluginHost, type PluginHostAiBridge } from "../runtime/plugins/host.js";
import { VoiceRuntime, type VoiceAudioPort, type VoiceSocket } from "../runtime/voice.js";
import { LiveVoiceSession } from "../runtime/voice/live-session.js";

function makeMemoryVault(initial: Record<string, string> = {}) {
  const slots = new Map<string, string>(Object.entries(initial));
  return {
    slots,
    get: (key: string) => slots.get(key) ?? "",
    set: (key: string, value: string) => {
      slots.set(key, value);
    },
    remove: (key: string) => {
      slots.delete(key);
    },
  };
}

class MockCameraPort implements NativeDeviceCameraPort {
  foreground = true;
  readonly activeSessions = new Map<string, { seq: number; maxDim: number; maxFps: number }>();

  permission(): string {
    return "granted";
  }

  async requestPermission(): Promise<string> {
    return "granted";
  }

  async openSession(
    _facing: string,
    maxDimension: number,
    maxFps: number,
    sessionId: string,
  ): Promise<string> {
    this.activeSessions.set(sessionId, { seq: 0, maxDim: maxDimension, maxFps });
    return sessionId;
  }

  reconfigureSession(sessionId: string, maxDimension: number, maxFps: number): void {
    const s = this.activeSessions.get(sessionId);
    if (s) {
      s.maxDim = maxDimension;
      s.maxFps = maxFps;
    }
  }

  status(sessionId: string): string {
    return this.activeSessions.has(sessionId) ? "streaming" : "closed";
  }

  async captureFrame(
    sessionId: string,
    _maxDimension: number,
    afterSeq: number,
  ): Promise<NativeDeviceCameraFrame> {
    const s = this.activeSessions.get(sessionId);
    const seq = s ? ++s.seq : afterSeq + 1;
    const faces: DetectedCameraFace[] = [
      { trackId: 1, offsetX: 0.05, offsetY: 0, width: 0.3, height: 0.35, confidence: 0.95 },
    ];
    return {
      jpeg: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
      width: 640,
      height: 360,
      facing: "front",
      capturedAtMs: Date.now(),
      seq,
      faces,
    };
  }

  closeSession(sessionId: string): void {
    this.activeSessions.delete(sessionId);
  }

  setForeground(active: boolean): void {
    this.foreground = active;
  }

  stopAll(): void {
    this.activeSessions.clear();
  }
}

class MockLanRoomPort implements NativeLanRoomPort {
  foreground = true;
  nextPort = 44200;
  readonly occupiedPorts = new Set<number>();
  readonly openPortLog: Array<{ roomId: string; preferredPort?: number; boundPort: number }> = [];
  readonly rooms = new Map<
    string,
    {
      roomId: string;
      port: number;
      lanIpv4: string;
      baseUrl: string;
      revision: number;
      pendingRequests: NativeLanHttpRequest[];
      waiters: Array<(req: NativeLanHttpRequest) => void>;
      rejecters: Array<(err: Error) => void>;
      responseResolvers: Map<
        string,
        (res: { status: number; contentType: string; cacheControl: string; body: string }) => void
      >;
    }
  >();

  async openRoom(roomId: string, preferredPort?: number): Promise<NativeLanRoomInfo> {
    if (!this.foreground) {
      throw new Error("[stage=lan.open code=ERR_LAN_ROOM_BACKGROUNDED] Backgrounded");
    }
    const inUse = new Set([...this.occupiedPorts, ...[...this.rooms.values()].map((r) => r.port)]);
    const port =
      preferredPort !== undefined && preferredPort > 0 && !inUse.has(preferredPort)
        ? preferredPort
        : this.nextPort++;
    const lanIpv4 = "192.168.50.10";
    const baseUrl = `http://${lanIpv4}:${port}`;
    this.openPortLog.push({ roomId, preferredPort, boundPort: port });
    this.rooms.set(roomId, {
      roomId,
      port,
      lanIpv4,
      baseUrl,
      revision: 0,
      pendingRequests: [],
      waiters: [],
      rejecters: [],
      responseResolvers: new Map(),
    });
    return { roomId, port, lanIpv4, baseUrl };
  }

  async nextRequest(roomId: string): Promise<NativeLanHttpRequest> {
    const room = this.rooms.get(roomId);
    if (!room) {
      throw new Error(`[stage=lan.next code=ERR_LAN_ROOM_CLOSED] Closed ${roomId}`);
    }
    if (room.pendingRequests.length > 0) {
      return room.pendingRequests.shift()!;
    }
    return new Promise((resolve, reject) => {
      room.waiters.push(resolve);
      room.rejecters.push(reject);
    });
  }

  respondRequest(
    roomId: string,
    requestId: string,
    status: number,
    contentType: string,
    cacheControl: string,
    body: string,
  ): void {
    const room = this.rooms.get(roomId);
    const resolver = room?.responseResolvers.get(requestId);
    if (resolver) {
      room!.responseResolvers.delete(requestId);
      resolver({ status, contentType, cacheControl, body });
    }
  }

  notifyRevision(roomId: string, revision: number): void {
    const room = this.rooms.get(roomId);
    if (room) {
      room.revision = revision;
    }
  }

  refreshAddresses(roomId: string): NativeLanRoomInfo {
    const room = this.rooms.get(roomId);
    if (!room) {
      throw new Error(`[stage=lan.refresh code=ERR_LAN_ROOM_MISSING] Missing ${roomId}`);
    }
    return {
      roomId: room.roomId,
      port: room.port,
      lanIpv4: room.lanIpv4,
      baseUrl: room.baseUrl,
    };
  }

  closeRoom(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    this.rooms.delete(roomId);
    for (const reject of room.rejecters) {
      reject(new Error("[stage=lan.close code=ERR_LAN_ROOM_CLOSED] Room closed"));
    }
  }

  setForeground(active: boolean): void {
    this.foreground = active;
  }

  stopAll(): void {
    for (const roomId of [...this.rooms.keys()]) {
      this.closeRoom(roomId);
    }
  }

  async simulateHttp(
    roomId: string,
    input: {
      method: "GET" | "POST";
      path: string;
      query?: Record<string, string>;
      body?: unknown;
    },
  ): Promise<{ status: number; contentType: string; json: any; text: string }> {
    const room = this.rooms.get(roomId);
    assert.ok(room, `Expected active LAN room ${roomId}`);
    const requestId = `req_${Math.random().toString(36).slice(2, 10)}`;
    const rawReq: NativeLanHttpRequest = {
      requestId,
      method: input.method,
      path: input.path,
      queryJson: JSON.stringify(input.query ?? {}),
      headersJson: JSON.stringify({ "user-agent": "ResilienceTestPhone/1.0" }),
      bodyText:
        input.body === undefined
          ? ""
          : typeof input.body === "string"
            ? input.body
            : JSON.stringify(input.body),
      remoteAddr: "192.168.50.101:55210",
    };

    const resPromise = new Promise<{
      status: number;
      contentType: string;
      cacheControl: string;
      body: string;
    }>((resolve) => {
      room.responseResolvers.set(requestId, resolve);
    });

    const waiter = room.waiters.shift();
    if (waiter) {
      room.rejecters.shift();
      waiter(rawReq);
    } else {
      room.pendingRequests.push(rawReq);
    }

    const res = await resPromise;
    let json: any = null;
    if (res.contentType.includes("json") && res.body) {
      json = JSON.parse(res.body);
    }
    return { status: res.status, contentType: res.contentType, json, text: res.body };
  }
}

async function createDockedBody(): Promise<BodyRuntime> {
  const vault = makeMemoryVault({
    body: JSON.stringify({
      mode: "simulation",
      savedDeviceId: "sim-dock-resilience",
      savedDeviceName: "Sim Dock",
      autoConnect: true,
    }),
  });
  const body = new BodyRuntime({ vault, dockGreetingLeadMs: 1, dockGreetingSettleMs: 1 });
  await body.connect({ deviceId: "sim-dock-resilience", deviceName: "Sim Dock" });
  body.setSimulatedDock(true);
  return body;
}

const FIXED_6P_ROLES = {
  1: "werewolf",
  2: "werewolf",
  3: "seer",
  4: "witch",
  5: "villager",
  6: "villager",
} as const;

async function createHarness(options: {
  db?: DatabaseSync;
  now?: () => number;
  speakerTickMs?: number;
  speakImpl?: PluginHostAiBridge["speak"];
} = {}) {
  const db = options.db ?? new DatabaseSync(":memory:");
  const cameraPort = new MockCameraPort();
  const visionBroker = new VisionBroker();
  visionBroker.attachNativePort(cameraPort);
  const nativeLan = new MockLanRoomPort();
  const lanBroker = new LanRoomBroker();
  lanBroker.attachNativePort(nativeLan);
  const bodyRuntime = await createDockedBody();

  const host = new PluginHost(
    db,
    [
      visionPersonTrackerDefinition(),
      werewolfJudgeDefinition({
        now: options.now,
        sleep: async () => {},
        nightIntroDelayMs: 0,
        speakerTickMs: options.speakerTickMs ?? 250,
        fixedRolesBySeat: FIXED_6P_ROLES,
      }),
    ],
    {
      createBodyCapability: (manifest, scope) => createBodyCapability(manifest, scope, bodyRuntime),
      createVisionCapability: (manifest, scope) =>
        createVisionCapability(manifest, scope, visionBroker),
      createLanCapability: (manifest, scope) =>
        createLanRoomCapability(manifest, scope, lanBroker),
      aiBridge: {
        speak:
          options.speakImpl ??
          (async () => ({
            completed: true,
          })),
        runBackgroundTask: async () => ({ taskId: "t-mvp", answer: "MVP: 3号" }),
      },
    },
  );

  const send = (cmd: WerewolfCommand) =>
    host.sendCommand<WerewolfCommand, WerewolfPublicState>(WEREWOLF_PLUGIN_ID, cmd);
  const readState = () => host.snapshot(WEREWOLF_PLUGIN_ID).state as WerewolfPublicState;

  return {
    db,
    host,
    nativeLan,
    lanBroker,
    visionBroker,
    bodyRuntime,
    send,
    readState,
    async dispose() {
      await host.close();
      lanBroker.close();
      visionBroker.close();
      bodyRuntime.close();
    },
  };
}

async function advance6pMatchToDay(
  send: (cmd: WerewolfCommand) => Promise<WerewolfPublicState>,
  readState: () => WerewolfPublicState,
  poisonTargetSeat: number | null = null,
) {
  await send({ type: "open_lobby", presetId: "6p_joy" });
  await send({ type: "start_dealing" });
  for (let seat = 1; seat <= 6; seat += 1) {
    await send({ type: "confirm_seat_dealt", seat });
  }
  await send({ type: "begin_first_night" });
  const deadline = Date.now() + 200;
  while (readState().phase === "night_intro" && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
  await send({ type: "submit_wolf_action", targetSeat: null });
  await send({ type: "submit_witch_action", save: false, poisonTargetSeat });
  await send({ type: "submit_seer_check", targetSeat: 1 });
  await send({ type: "finish_seer_turn" });
}

async function prepareHistoryMatch(h: Awaited<ReturnType<typeof createHarness>>) {
  await advance6pMatchToDay(h.send, h.readState, 1);
  if (h.readState().phase === "dawn_announce") {
    await h.send({ type: "acknowledge_dawn" });
  }
  while (h.readState().phase === "leave_resolution") {
    await h.send({ type: "finish_last_words" });
  }
  assert.equal(h.readState().phase, "day_discussion");
}

test("Host votes and LAN actions archive settled matches once across a database reopen", async () => {
  const dir = mkdtempSync(join(tmpdir(), "werewolf-match-history-"));
  const path = join(dir, "plugin.sqlite");
  let nowMs = Date.UTC(2026, 10, 22, 11, 5);
  try {
    const db = new DatabaseSync(path);
    const h = await createHarness({ db, now: () => nowMs });
    let history: WerewolfPublicState["matchHistory"];
    try {
      await h.host.startAll();
      assert.deepEqual(h.readState().matchHistory, []);
      await prepareHistoryMatch(h);
      assert.deepEqual(h.readState().matchHistory, []);

      await h.send({ type: "start_voting" });
      for (const [voterSeat, targetSeat] of [[2, 3], [3, 2], [4, 2], [5, 3], [6, null]] as const) {
        await h.send({ type: "cast_on_device_vote", voterSeat, targetSeat });
      }
      await h.send({ type: "finalize_votes" });
      assert.equal(h.readState().phase, "day_pk_speech");
      while (h.readState().phase === "day_pk_speech") {
        await h.send({ type: "advance_speaker" });
      }
      await h.send({ type: "cast_on_device_vote", voterSeat: 4, targetSeat: 2 });
      await h.send({ type: "finalize_votes" });
      const [first] = h.readState().matchHistory;
      assert.ok(first);
      assert.deepEqual(first, {
        id: first.id,
        endedAtMs: nowMs,
        presetId: "6p_joy",
        playerCount: 6,
        winner: "good",
        day: 1,
        highlight: { kind: "day_tie", day: 1 },
      });
      await h.send({ type: "play_again" });

      nowMs += 60_000;
      await h.send({ type: "update_rules", patch: { surfaceMode: "lan_companion" } });
      await prepareHistoryMatch(h);
      assert.deepEqual(h.readState().matchHistory, [first]);
      const [roomId] = h.nativeLan.rooms.keys();
      assert.ok(roomId);
      const claim = await h.nativeLan.simulateHttp(roomId, {
        method: "POST",
        path: "/api/claim",
        body: { seat: 2 },
      });
      assert.equal(claim.status, 200);
      const finish = await h.nativeLan.simulateHttp(roomId, {
        method: "POST",
        path: "/api/action",
        body: { action: "wolf_self_explode", seat: 2, token: claim.json.seatToken },
      });
      assert.equal(finish.status, 200);
      assert.equal(finish.json.view.phase, "game_over");
      assert.equal("matchHistory" in finish.json.view, false);
      history = h.readState().matchHistory;
      assert.equal(history.length, 2);
      assert.equal(history[0]?.endedAtMs, nowMs);
      assert.notEqual(history[0]?.id, first.id);
      assert.deepEqual(history[1], first);
      await h.send({ type: "play_again" });
      await h.host.setEnabled(WEREWOLF_PLUGIN_ID, false);
      assert.deepEqual(h.readState().matchHistory, history);
    } finally {
      await h.dispose();
      db.close();
    }

    const reopened = new DatabaseSync(path);
    const next = await createHarness({ db: reopened, now: () => nowMs });
    try {
      assert.equal(next.host.snapshot(WEREWOLF_PLUGIN_ID).enabled, false);
      assert.equal(next.readState().phase, "idle");
      assert.deepEqual(next.readState().matchHistory, history);
      await next.host.setEnabled(WEREWOLF_PLUGIN_ID, true);
      assert.deepEqual(next.readState().matchHistory, history);
    } finally {
      await next.dispose();
      reopened.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("An archive write failure keeps the terminal checkpoint recoverable", async () => {
  const db = new DatabaseSync(":memory:");
  const h = await createHarness({ db });
  const checkpointRow = () => db
    .prepare("SELECT value FROM plugin_kv_storage WHERE plugin_id = ? AND key = ?")
    .get(WEREWOLF_PLUGIN_ID, "match_checkpoint_v1") as { value: string } | undefined;
  try {
    try {
      await h.host.startAll();
      await prepareHistoryMatch(h);
      await h.send({ type: "start_voting" });
      await h.send({ type: "cast_on_device_vote", voterSeat: 4, targetSeat: 2 });
      db.exec(`
        CREATE TEMP TRIGGER reject_match_history BEFORE INSERT ON plugin_kv_storage
        WHEN NEW.key = 'match_history_v1'
        BEGIN
          SELECT RAISE(ABORT, 'history write fixture');
        END
      `);

      const failure = {
        stage: "history.write",
        code: "ERR_SQLITE_ERROR",
        message: "history write fixture",
      };
      await assert.rejects(h.send({ type: "finalize_votes" }), failure);
      assert.equal(h.readState().phase, "game_over");
      assert.deepEqual(h.readState().matchHistory, []);
      assert.deepEqual(h.host.snapshot(WEREWOLF_PLUGIN_ID).lastError, {
        stage: failure.stage,
        code: failure.code,
        reason: failure.message,
      });
      await assert.rejects(h.send({ type: "play_again" }), failure);
      assert.equal(h.readState().phase, "game_over");
      assert.ok(checkpointRow());
    } finally {
      await h.dispose();
    }

    const saved = checkpointRow();
    assert.ok(saved);
    const completed = JSON.parse(saved.value).completedMatch;
    assert.ok(completed.id);
    db.exec("DROP TRIGGER reject_match_history");
    const reopened = await createHarness({ db });
    try {
      await reopened.host.startAll();
      assert.equal(reopened.readState().phase, "idle");
      assert.deepEqual(reopened.readState().matchHistory, [completed]);
      assert.equal(checkpointRow(), undefined);
    } finally {
      await reopened.dispose();
    }
  } finally {
    db.close();
  }
});

test("Scenario 1: Host exit pauses match, freezes speaker timer, populates resumable pill, and resume restores progress", async () => {
  const h = await createHarness({ speakerTickMs: 40 });
  try {
    await h.host.startAll();
    await advance6pMatchToDay(h.send, h.readState);
    assert.equal(h.readState().phase, "day_discussion");

    const beforePauseSec = h.readState().speakingRemainingSec;
    const beforeDay = h.readState().day;
    h.host.stage.exitPluginStage(WEREWOLF_PLUGIN_ID);

    const pauseDeadline = Date.now() + 200;
    while (!h.readState().hostPaused && Date.now() < pauseDeadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(h.host.stage.activePluginId(), null);
    assert.equal(h.readState().hostPaused, true);
    assert.equal(h.readState().hasResumableMatch, true);

    const pill = h.host.resumableStage();
    assert.ok(pill);
    assert.equal(pill.pluginId, WEREWOLF_PLUGIN_ID);
    assert.match(pill.title, /狼人杀/);

    const frozenSec = h.readState().speakingRemainingSec;
    assert.ok(frozenSec <= beforePauseSec);
    await new Promise((r) => setTimeout(r, 130));
    assert.equal(
      h.readState().speakingRemainingSec,
      frozenSec,
      "Paused match must freeze speaking clock",
    );

    await h.host.resumePluginStage(WEREWOLF_PLUGIN_ID);
    assert.equal(h.host.stage.activePluginId(), WEREWOLF_PLUGIN_ID);
    assert.equal(h.host.resumableStage(), null);
    assert.equal(h.readState().hostPaused, false);
    assert.equal(h.readState().phase, "day_discussion");
    assert.equal(h.readState().day, beforeDay);

    await new Promise((r) => setTimeout(r, 120));
    assert.ok(
      h.readState().speakingRemainingSec < frozenSec,
      "Resumed daytime match should restart speaking countdown",
    );
  } finally {
    await h.dispose();
  }
});

test("Scenario 2: Cold reboot restores persisted match_checkpoint_v1 into hostPaused with masked cards/night gate without hijacking home", async () => {
  const sharedDb = new DatabaseSync(":memory:");

  // Reboot case A: Dealing checkpoint (Seat 1 revealed & dealt -> Seat 2 waiting, Seat 2 revealed before crash)
  const run1 = await createHarness({ db: sharedDb });
  try {
    await run1.host.startStartupPlugins();
    await run1.send({ type: "open_lobby", presetId: "6p_joy" });
    await run1.send({ type: "start_dealing" });
    await run1.send({ type: "capture_seat_portrait", seat: 1 });
    assert.match(run1.readState().seats[0]!.portraitDataUri ?? "", /^data:image\/jpeg/);
    await run1.send({ type: "confirm_seat_dealt", seat: 1 });
    await run1.send({ type: "set_deal_reveal", seat: 2, revealing: true });
    assert.equal(run1.readState().dealingRevealingSeat, 2);

    const row = sharedDb
      .prepare("SELECT value FROM plugin_kv_storage WHERE plugin_id = ? AND key = ?")
      .get(WEREWOLF_PLUGIN_ID, "match_checkpoint_v1") as { value: string } | undefined;
    assert.ok(row?.value, "match_checkpoint_v1 should be persisted during dealing");
    const parsedCheckpoint = JSON.parse(row.value) as {
      seats: Array<{ portraitDataUri: string | null }>;
    };
    assert.equal(
      parsedCheckpoint.seats[0]?.portraitDataUri,
      null,
      "Persisted checkpoint must strip ephemeral base64 portraits",
    );
  } finally {
    await run1.dispose();
  }

  const run2 = await createHarness({ db: sharedDb });
  try {
    await run2.host.startStartupPlugins();
    assert.equal(
      run2.host.snapshot(WEREWOLF_PLUGIN_ID).lifecycle,
      "active",
      "werewolf-judge startup manifest must activate on cold boot",
    );
    assert.equal(
      run2.host.stage.activePluginId(),
      null,
      "Cold boot recovery must NOT hijack home stage immediately",
    );
    const restored = run2.readState();
    assert.equal(restored.phase, "dealing");
    assert.equal(restored.hostPaused, true);
    assert.equal(restored.hasResumableMatch, true);
    assert.equal(restored.dealingCurrentSeat, 2);
    assert.equal(restored.dealingRevealingSeat, null, "Revealed role must re-mask on restart");
    assert.equal(run2.host.resumableStage()?.pluginId, WEREWOLF_PLUGIN_ID);

    // Advance into night_witch (after confirming rest of dealing & wolf vote), close, and verify nightGateUnlocked masks on cold boot
    await run2.host.resumePluginStage(WEREWOLF_PLUGIN_ID);
    assert.equal(run2.readState().hostPaused, false);
    for (let s = 2; s <= 6; s += 1) {
      await run2.send({ type: "confirm_seat_dealt", seat: s });
    }
    await run2.send({ type: "begin_first_night" });
    await run2.send({ type: "submit_wolf_action", targetSeat: 5 });
    assert.equal(run2.readState().phase, "night_witch");
    await run2.send({ type: "set_night_gate", unlocked: true });
    assert.equal(run2.readState().nightPrompt?.gateUnlocked, true);
  } finally {
    await run2.dispose();
  }

  const run3 = await createHarness({ db: sharedDb });
  try {
    await run3.host.startStartupPlugins();
    const st3 = run3.readState();
    assert.equal(st3.phase, "night_witch");
    assert.equal(st3.hostPaused, true);
    assert.equal(st3.nightPrompt?.gateUnlocked, false, "Night gate must re-lock on recovery");
    await run3.host.resumePluginStage(WEREWOLF_PLUGIN_ID);
    assert.equal(run3.readState().phase, "night_witch");
    assert.equal(run3.readState().hostPaused, false);
  } finally {
    await run3.dispose();
    sharedDb.close();
  }
});

test("Scenario 3: Voice muted_broadcast + verbatim prompt + recovery after connection failure + standby auto-close", async () => {
  // 3A: OpenAI verbatim proactive speech prompt
  const openAi = createOpenAiRealtimeProtocol({ providerId: "openai" });
  const payloads = openAi.encodeProactiveSpeech({
    spokenText: "请 3 号玩家开始发言",
    verbatim: true,
  });
  const itemCreate = payloads.find((p) => p.type === "conversation.item.create") as any;
  const promptText = String(itemCreate?.item?.content?.[0]?.text ?? "");
  assert.match(promptText, /请 3 号玩家开始发言/);
  assert.match(promptText, /Verbatim|word-for-word/i);
  assert.ok(payloads.some((p) => p.type === "response.create"));

  // 3B: VoiceRuntime muted_broadcast, connection failure recovery, and closeToStandbyOnComplete
  let captureState = "idle";
  let captureMode = "idle";
  let mutedState: boolean[] = [];
  let failConnectOnce = true;

  const audio: VoiceAudioPort = {
    beginWake: () => 0,
    startWake: async () => {
      captureState = "running";
      captureMode = "kws";
      return true;
    },
    requestPermission: () => "granted",
    start: () => {
      captureState = "running";
      captureMode = "conversation";
    },
    setCaptureMode: (mode) => {
      captureState = "running";
      captureMode = mode;
    },
    playReadyCue: () => {},
    stop: () => {
      captureState = "idle";
      captureMode = "idle";
    },
    enqueue: () => {},
    clearPlayback: () => {},
    setMuted: (muted: boolean) => {
      mutedState.push(muted);
    },
    drainCapture: () => [],
    status: () => ({
      state: captureState,
      permission: "granted",
      error: "",
      queuedPlaybackMs: 0,
      captureMode,
      wakeWord: "",
      kwsReady: true,
    }),
  };

  let activeSocketPush: ((event: Record<string, unknown>) => void) | null = null;
  let socketWrites: Record<string, unknown>[] = [];
  const vault = makeMemoryVault();

  const voice = new VoiceRuntime({
    defaultLanguage: () => "zh-CN",
    vault,
    audio,
    connect: async () => {
      if (failConnectOnce) {
        failConnectOnce = false;
        throw new Error("[stage=ws.connect code=ECONNREFUSED] simulated initial connect error");
      }
      const incoming: string[] = [];
      let reader: ((v: string | null) => void) | undefined;
      let closed = false;
      activeSocketPush = (ev) => {
        const raw = JSON.stringify(ev);
        if (reader) {
          const resolve = reader;
          reader = undefined;
          resolve(raw);
        } else {
          incoming.push(raw);
        }
      };
      const socket: VoiceSocket = {
        read: () =>
          incoming.length > 0
            ? Promise.resolve(incoming.shift()!)
            : closed
              ? Promise.resolve(null)
              : new Promise((resolve) => {
                  reader = resolve;
                }),
        write: async (raw) => {
          socketWrites.push(JSON.parse(raw));
        },
        close: async () => {
          closed = true;
          reader?.(null);
          reader = undefined;
        },
      };
      return socket;
    },
    onState: () => {},
    requestTask: async () => "ok",
    cancelTask: () => {},
  });
  voice.setWakeEnabled(true);
  voice.configure("TEST_KEY");

  // A failed connection restores local wake listening.
  await voice.start().catch(() => {});
  assert.equal(voice.snapshot().phase, "standby");
  assert.equal(voice.snapshot().error, "");

  // Night muted_broadcast reconnects from standby and keeps the session muted.
  const nightSpeakPromise = voice.speak({
    spokenText: "天黑请闭眼",
    capturePolicy: "muted_broadcast",
    verbatim: true,
    closeToStandbyOnComplete: false,
  });

  const sockWait = Date.now() + 200;
  while (!activeSocketPush && Date.now() < sockWait) {
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.ok(activeSocketPush);
  activeSocketPush!({ type: "session.created" });
  await new Promise((r) => setTimeout(r, 25));

  assert.equal(mutedState.includes(true), true, "muted_broadcast must mute microphone");
  assert.equal(voice.snapshot().muted, true);

  activeSocketPush!({ type: "response.created", response: { id: "resp-1" } });
  activeSocketPush!({ type: "response.done", response: { id: "resp-1" } });
  const nightResult = await nightSpeakPromise;
  assert.equal(nightResult.completed, true);
  assert.equal(voice.snapshot().muted, true);
  assert.notEqual(voice.snapshot().phase, "standby");

  // Day speak with closeToStandbyOnComplete=true automatically returns cleanly to standby with no error
  const daySpeakPromise = voice.speak({
    spokenText: "昨晚是个平安夜",
    capturePolicy: "muted_broadcast",
    verbatim: true,
    holdAliveMs: 25,
    closeToStandbyOnComplete: true,
  });
  await new Promise((r) => setTimeout(r, 15));
  activeSocketPush!({ type: "response.created", response: { id: "resp-2" } });
  activeSocketPush!({ type: "response.done", response: { id: "resp-2" } });
  const dayResult = await daySpeakPromise;
  assert.equal(dayResult.completed, true);

  const standbyDeadline = Date.now() + 1000;
  while (voice.snapshot().phase !== "standby" && Date.now() < standbyDeadline) {
    await new Promise((r) => setTimeout(r, 15));
  }
  assert.equal(voice.snapshot().phase, "standby");
  assert.equal(voice.snapshot().error, "");
  await voice.stop();

  // 3C: LiveVoiceSession extends idle hold beyond 12s IDLE_SLEEP_MS and excludes [Verbatim Announcement] history
  const recordedConversations: Array<Array<{ role: string; content: string }>> = [];
  const session = new LiveVoiceSession({
    apiKey: "TEST_KEY",
    voiceId: "",
    purpose: "conversation",
    initialLanguage: "zh-CN",
    fromWakeWord: false,
    initialMuted: true,
    protocol: createOpenAiRealtimeProtocol({ providerId: "openai" }),
    audio,
    connect: async () => ({
      read: async () => null,
      write: async () => {},
      close: async () => {},
    }),
    requestTask: async () => "",
    cancelTask: () => {},
    onConversation: (messages) => {
      recordedConversations.push(messages);
    },
    onStatePatch: () => {},
    onSessionComplete: () => {},
    onSessionError: () => {},
  });
  (session as unknown as { silenceSince: number }).silenceSince = Date.now();
  session.holdIdleFor(20_000);
  const remaining = (session as unknown as { remainingSilenceMs(): number }).remainingSilenceMs();
  assert.ok(remaining > 18_000, `Expected holdAliveMs > 12_000ms IDLE_SLEEP_MS, got ${remaining}`);

  (session as unknown as { publishHistory(items: unknown[]): void }).publishHistory([
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "现在几号发言" }],
    },
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "当前由 3 号玩家发言。" }],
    },
    {
      type: "message",
      role: "user",
      content: [
        {
          type: "input_text",
          text: "[Verbatim Announcement] 严格原话朗读，不要增删改写任何字词：天黑请闭眼",
        },
      ],
    },
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "天黑请闭眼" }],
    },
  ]);
  const latestConv = recordedConversations.at(-1) ?? [];
  assert.deepEqual(latestConv, [
    { role: "user", content: "现在几号发言" },
    { role: "assistant", content: "当前由 3 号玩家发言。" },
  ]);
  session.dispose("immediate");
});

test("Scenario 4: enqueueOperation mutex serialization + JudgeSpeechCoordinator retry, degraded error retention, mute, and replay", async () => {
  let speakAttempts = 0;
  let shouldFailSpeak = true;
  const spokenHistory: string[] = [];

  const h = await createHarness({
    speakImpl: async ({ spokenText }) => {
      speakAttempts += 1;
      if (shouldFailSpeak) {
        throw new Error("[stage=voice.connect code=ERR_NET] socket closed");
      }
      await new Promise((r) => setTimeout(r, 15));
      spokenHistory.push(spokenText);
      return { completed: true };
    },
  });

  try {
    await h.host.startAll();
    await h.send({ type: "open_lobby", presetId: "6p_joy" });
    await h.send({ type: "start_dealing" });

    // Reset attempt counter after start_dealing's initial announcements settle, then trigger replay while failing -> 1 initial try + 1 retry
    await new Promise((r) => setTimeout(r, 20));
    speakAttempts = 0;
    await h.send({ type: "replay_last_speech" });
    const failDeadline = Date.now() + 300;
    while (
      (speakAttempts < 2 || !h.readState().voiceStatus.degradedToSubtitles || h.readState().voiceStatus.speaking) &&
      Date.now() < failDeadline
    ) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(speakAttempts, 2);
    const failedVoice = h.readState().voiceStatus;
    assert.equal(failedVoice.degradedToSubtitles, true);
    assert.match(failedVoice.lastInterruptedReason ?? "", /socket closed/);

    // Concurrent commands fired back-to-back must serialize cleanly through enqueueOperation without dropping steps
    shouldFailSpeak = false;
    await Promise.all([
      h.send({ type: "confirm_seat_dealt", seat: 1 }),
      h.send({ type: "confirm_seat_dealt", seat: 2 }),
      h.send({ type: "confirm_seat_dealt", seat: 3 }),
    ]);
    assert.equal(h.readState().dealingCurrentSeat, 4);

    // Recover by replaying last speech
    await h.send({ type: "replay_last_speech" });
    const recoverDeadline = Date.now() + 300;
    while (
      (h.readState().voiceStatus.degradedToSubtitles || h.readState().voiceStatus.speaking) &&
      Date.now() < recoverDeadline
    ) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(h.readState().voiceStatus.degradedToSubtitles, false);
    assert.ok(spokenHistory.length >= 1);

    // Host mute skips TTS calls while keeping subtitle text synchronized
    const countBeforeMute = spokenHistory.length;
    await h.send({ type: "set_judge_voice_muted", muted: true });
    assert.equal(h.readState().voiceStatus.mutedByHost, true);
    await h.send({ type: "confirm_seat_dealt", seat: 4 });
    assert.equal(spokenHistory.length, countBeforeMute);
    assert.ok((h.readState().voiceStatus.lastSpokenText ?? "").length > 0);
  } finally {
    await h.dispose();
  }
});

test("Scenario 5: Voice tool werewolf_open_lobby resumes active match instead of resetting to lobby", async () => {
  const h = await createHarness();
  try {
    await h.host.startAll();
    await h.send({ type: "open_lobby", presetId: "6p_joy" });
    await h.send({ type: "start_dealing" });
    await h.send({ type: "confirm_seat_dealt", seat: 1 });
    h.host.stage.exitPluginStage(WEREWOLF_PLUGIN_ID);
    const pauseDeadline = Date.now() + 300;
    while (!h.readState().hostPaused && Date.now() < pauseDeadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(h.readState().hostPaused, true);

    const openTool = h.host.ai.voiceTools().find((t) => t.name === "werewolf_open_lobby");
    assert.ok(openTool);
    const result = (await openTool.execute(
      { presetId: "9p_standard" },
      { sessionId: "s-voice-1", signal: new AbortController().signal },
    )) as any;

    assert.equal(result.resumedExistingMatch, true);
    assert.equal(result.phase, "dealing");
    assert.equal(h.readState().rules.presetId, "6p_joy");
    assert.equal(h.readState().dealingCurrentSeat, 2);
    assert.equal(h.host.stage.activePluginId(), WEREWOLF_PLUGIN_ID);
  } finally {
    await h.dispose();
  }
});

test("Scenario 6: step_back_deal rewinds during dealing and after final seat before night, rejecting seat 1", async () => {
  const h = await createHarness();
  try {
    await h.host.startAll();
    await h.send({ type: "open_lobby", presetId: "6p_joy" });
    await h.send({ type: "start_dealing" });

    assert.equal(h.readState().dealingCurrentSeat, 1);
    assert.equal(h.readState().canStepBackDeal, false);
    await assert.rejects(
      h.send({ type: "step_back_deal" }),
      /ERR_WEREWOLF_CANNOT_STEP_BACK/,
    );

    await h.send({ type: "confirm_seat_dealt", seat: 1 });
    await h.send({ type: "set_deal_reveal", seat: 2, revealing: true });
    assert.equal(h.readState().dealingCurrentSeat, 2);
    assert.equal(h.readState().canStepBackDeal, true);

    await h.send({ type: "step_back_deal" });
    assert.equal(h.readState().dealingCurrentSeat, 1);
    assert.equal(h.readState().seats[0]!.dealtConfirmed, false);
    assert.equal(h.readState().dealingRevealingSeat, null);
    assert.equal(h.readState().canStepBackDeal, false);

    for (let s = 1; s <= 6; s += 1) {
      await h.send({ type: "confirm_seat_dealt", seat: s });
    }
    assert.equal(h.readState().dealingCurrentSeat, null);
    assert.equal(h.readState().canStepBackDeal, true);

    await h.send({ type: "step_back_deal" });
    assert.equal(h.readState().dealingCurrentSeat, 6);
    assert.equal(h.readState().seats[5]!.dealtConfirmed, false);
  } finally {
    await h.dispose();
  }
});

test("Scenario 7: LanRoomBroker rebinds preferredPort and restores revision on foreground; mobile companion only clears localStorage on 401", async () => {
  const nativeLan = new MockLanRoomPort();
  const broker = new LanRoomBroker();
  broker.attachNativePort(nativeLan);

  const scope = createEffectScope("lan-resilience");
  const cap = createLanRoomCapability(
    {
      id: WEREWOLF_PLUGIN_ID,
      version: "1.0.0",
      minHostApiVersion: 2,
      category: "games_social",
      icon: "sparkles",
      name: { "zh-CN": "狼人杀", "en-US": "Werewolf" },
      summary: { "zh-CN": "狼人杀", "en-US": "Werewolf" },
      author: { name: "Test" },
      permissions: ["network.lan_room"],
    },
    scope,
    broker,
  )!;

  try {
    const session = await cap.openRoom({
      scope,
      onRequest: () => ({
        status: 200,
        contentType: "application/json",
        cacheControl: "no-store",
        body: "{}",
      }),
    });
    const firstPort = session.port;
    session.notifyRevision(19);

    broker.setForegroundActive(false);
    assert.equal(nativeLan.rooms.size, 0);

    broker.setForegroundActive(true);
    const refreshed = await session.refreshAddressesAsync!();
    assert.equal(refreshed.port, firstPort);
    assert.equal(nativeLan.openPortLog.length, 2);
    assert.equal(nativeLan.openPortLog[1]!.preferredPort, firstPort);
    assert.equal(nativeLan.openPortLog[1]!.boundPort, firstPort);
    assert.equal(nativeLan.rooms.get(session.roomId)?.revision, 19);

    // Companion inline HTML script policy assertions
    const engine = new WerewolfEngine({
      initialRules: buildPresetRules("6p_joy", { surfaceMode: "lan_companion" }),
    });
    engine.openLobby("6p_joy");
    const companion = new LanCompanionController({
      engine,
      onClaimsChanged: () => {},
      onAuthenticatedAction: () => {},
    });
    const htmlRes = await companion.handleHttpRequest({
      method: "GET",
      path: "/",
      query: {},
      headers: {},
      bodyText: "",
      remoteAddr: "127.0.0.1",
    });
    const html = htmlRes.body;
    assert.match(html, /err && err\.status === 401/);
    assert.match(html, /正在重连主持人设备/);
    assert.match(html, /await refresh\(\)/);
  } finally {
    await scope.dispose();
    broker.close();
  }
});

test("Scenario 8: release_lan_seat revokes old seat token (401) and allows immediate re-claim", async () => {
  const h = await createHarness();
  try {
    await h.host.startAll();
    await h.send({ type: "update_rules", patch: { surfaceMode: "lan_companion" } });
    await h.send({ type: "open_lobby", presetId: "6p_joy" });

    const roomId = [...h.nativeLan.rooms.keys()][0]!;
    const claimA = await h.nativeLan.simulateHttp(roomId, {
      method: "POST",
      path: "/api/claim",
      body: { seat: 3, nickname: "OldPhone" },
    });
    assert.equal(claimA.status, 200);
    const tokenA = claimA.json.seatToken as string;
    assert.deepEqual(h.readState().lan.claimedSeats, [3]);

    // Release seat 3 -> old token immediately rejected with 401
    await h.send({ type: "release_lan_seat", seat: 3 });
    assert.deepEqual(h.readState().lan.claimedSeats, []);
    assert.equal(h.readState().seats[2]!.lanClaimed, false);

    const staleAttempt = await h.nativeLan.simulateHttp(roomId, {
      method: "GET",
      path: "/api/state",
      query: { seat: "3", token: tokenA },
    });
    assert.equal(staleAttempt.status, 401);
    assert.equal(staleAttempt.json.code, "ERR_LAN_UNAUTHORIZED_TOKEN");

    // New phone can claim seat 3 immediately
    const claimB = await h.nativeLan.simulateHttp(roomId, {
      method: "POST",
      path: "/api/claim",
      body: { seat: 3, nickname: "NewPhone" },
    });
    assert.equal(claimB.status, 200);
    assert.notEqual(claimB.json.seatToken, tokenA);
    assert.deepEqual(h.readState().lan.claimedSeats, [3]);
  } finally {
    await h.dispose();
  }
});

test("Scenario 9: abort_match_to_lobby and exit_to_idle clear checkpoint, claims, and resumable session", async () => {
  const db = new DatabaseSync(":memory:");
  const h = await createHarness({ db });
  try {
    await h.host.startAll();
    await h.send({ type: "update_rules", patch: { surfaceMode: "lan_companion" } });
    await h.send({ type: "open_lobby", presetId: "6p_joy" });
    await h.send({ type: "start_dealing" });
    assert.equal(h.readState().hasResumableMatch, true);

    const beforeRow = db
      .prepare("SELECT value FROM plugin_kv_storage WHERE plugin_id = ? AND key = ?")
      .get(WEREWOLF_PLUGIN_ID, "match_checkpoint_v1") as { value: string } | undefined;
    assert.ok(beforeRow?.value);

    // Abort to lobby clears checkpoint & resumable stage pill
    await h.send({ type: "abort_match_to_lobby" });
    assert.equal(h.readState().phase, "lobby");
    assert.equal(h.readState().hasResumableMatch, false);
    assert.equal(h.host.resumableStage(), null);
    const afterAbortRow = db
      .prepare("SELECT value FROM plugin_kv_storage WHERE plugin_id = ? AND key = ?")
      .get(WEREWOLF_PLUGIN_ID, "match_checkpoint_v1");
    assert.equal(afterAbortRow, undefined);

    // Start again, claim LAN seat, then exit_to_idle clears claims, checkpoint, and active stage
    await h.send({ type: "start_dealing" });
    const roomId = [...h.nativeLan.rooms.keys()][0]!;
    await h.nativeLan.simulateHttp(roomId, {
      method: "POST",
      path: "/api/claim",
      body: { seat: 1, nickname: "Seat1" },
    });
    assert.deepEqual(h.readState().lan.claimedSeats, [1]);

    await h.send({ type: "exit_to_idle" });
    assert.equal(h.readState().phase, "idle");
    assert.equal(h.host.stage.activePluginId(), null);
    assert.equal(h.host.resumableStage(), null);
    assert.equal(h.nativeLan.rooms.size, 0);
    assert.deepEqual(h.readState().lan.claimedSeats, []);
  } finally {
    await h.dispose();
    db.close();
  }
});
