import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { RobotFaceController } from "../../../packages/looi-runtime/src/ui/robot-face-controller.js";
import {
  PERSON_TRACKER_SERVICE_ID,
  encodeJpegDataUri,
  visionPersonTrackerDefinition,
  type DetectedCameraFace,
  type PersonTrackerService,
  type PersonTrackingFrame,
} from "../plugins/vision-person-tracker/runtime/index.js";
import {
  WEREWOLF_PLUGIN_ID,
  WEREWOLF_ROLE_LABELS,
  type WerewolfCommand,
  type WerewolfLanStatus,
  type WerewolfPublicState,
  type WerewolfRole,
} from "../plugins/werewolf-judge/contracts.js";
import {
  WEREWOLF_DYNAMIC_FACE_RECIPES,
  WerewolfChoreographer,
  computeDeadRoleMaskDelayMs,
  computeFaceCenteringTurn,
  resolveStagePresentation,
  type WerewolfFaceSlot,
} from "../plugins/werewolf-judge/runtime/choreography.js";
import {
  WerewolfEngine,
  WerewolfRuleError,
} from "../plugins/werewolf-judge/runtime/engine.js";
import { werewolfJudgeDefinition } from "../plugins/werewolf-judge/runtime/index.js";
import { LanCompanionController } from "../plugins/werewolf-judge/runtime/lan-companion.js";
import {
  applyCustomRoleCount,
  buildPresetRules,
  expandDeckFromRoleCounts,
  randomTokenHex,
  shuffleRolesCsprng,
  validateRulesConfig,
} from "../plugins/werewolf-judge/runtime/presets.js";
import { BodyRuntime } from "../runtime/body.js";
import {
  VisionBroker,
  type NativeDeviceCameraFrame,
  type NativeDeviceCameraPort,
} from "../runtime/device-camera.js";
import {
  LanRoomBroker,
  createLanRoomCapability,
  type NativeLanRoomInfo,
  type NativeLanRoomPort,
} from "../runtime/lan-room.js";
import type { PluginDefinition } from "../runtime/plugins/contracts.js";
import { createEffectScope } from "../runtime/plugins/effect-scope.js";
import {
  FaceDriverHub,
  createBodyCapability,
  createVisionCapability,
} from "../runtime/plugins/embodied-drivers.js";
import { PluginHost } from "../runtime/plugins/host.js";
import { validateDynamicFaceRecipeIssue } from "../runtime/plugins/shared-types.js";
import {
  clearDynamicFaceRecipe,
  registerDynamicFaceRecipe,
} from "../ui/face-recipes.js";

const DEFAULT_PUBLIC_EXTRAS: {
  readonly dealingFaceAligned: boolean;
  readonly previewSessionId: string | null;
  readonly visionAvailable: boolean;
  readonly lan: WerewolfLanStatus;
  readonly hostPaused: boolean;
} = {
  dealingFaceAligned: false,
  previewSessionId: null,
  visionAvailable: true,
  lan: {
    active: false,
    baseUrl: null,
    lanIpv4: null,
    port: null,
    claimedSeats: [],
    error: null,
  },
  hostPaused: false,
};

function assertNoSecretLeakBeforeGameOver(engine: WerewolfEngine): void {
  const pub = engine.projectPublicState(DEFAULT_PUBLIC_EXTRAS);
  assert.notEqual(pub.phase, "game_over");
  assert.deepEqual(pub.fullTimelineReveal, []);

  for (const seat of pub.seats) {
    if (seat.idiotRevealed) {
      assert.equal(seat.revealedRole, "idiot");
    } else if (
      pub.phase === "dealing" &&
      pub.dealingCurrentSeat === seat.seat &&
      pub.dealingRevealingSeat === seat.seat
    ) {
      assert.notEqual(seat.revealedRole, null);
    } else {
      assert.equal(
        seat.revealedRole,
        null,
        `Seat ${seat.seat} leaked role ${String(seat.revealedRole)} during phase ${pub.phase}`,
      );
    }
  }

  if (pub.nightPrompt && (!pub.nightPrompt.gateUnlocked || engine.isCurrentNightStepDecoy())) {
    assert.equal(pub.nightPrompt.witchContext, null);
    assert.equal(pub.nightPrompt.seerResult, null);
    assert.equal(pub.nightPrompt.lastGuardedSeat, null);
    assert.deepEqual(pub.nightPrompt.wolfTeammateSeats, []);
  }

  const daySummary = engine.exportPublicDayContextSummary();
  for (const label of Object.values(WEREWOLF_ROLE_LABELS)) {
    assert.equal(
      daySummary.includes(`底牌【${label["zh-CN"]}】`),
      false,
      `Public day summary must never expose secret role assignment (${label["zh-CN"]})`,
    );
  }

  assert.throws(
    () => engine.exportMatchBattleReportForAi(),
    (err: unknown) =>
      err instanceof WerewolfRuleError && err.code === "ERR_WEREWOLF_MATCH_NOT_OVER",
  );
}

class FakeTrackingCameraPort implements NativeDeviceCameraPort {
  permissionState: "granted" | "denied" | "undetermined" | "unavailable" = "granted";
  foreground = true;
  facesQueue: DetectedCameraFace[][] = [];
  defaultFaces: DetectedCameraFace[] = [
    {
      trackId: 7,
      offsetX: 0.4,
      offsetY: -0.1,
      width: 0.28,
      height: 0.36,
      confidence: 0.96,
    },
  ];

  readonly openCalls: Array<{
    facing: string;
    maxDimension: number;
    maxFps: number;
    sessionId: string;
  }> = [];
  readonly closeCalls: string[] = [];
  readonly activeSessions = new Map<
    string,
    { facing: string; maxDimension: number; maxFps: number; seq: number }
  >();

  permission(): string {
    return this.permissionState;
  }

  async requestPermission(): Promise<string> {
    this.permissionState = "granted";
    return "granted";
  }

  async openSession(
    facing: string,
    maxDimension: number,
    maxFps: number,
    sessionId: string,
  ): Promise<string> {
    const resolvedId = sessionId.trim() || `cam-${this.openCalls.length + 1}`;
    this.openCalls.push({ facing, maxDimension, maxFps, sessionId: resolvedId });
    this.activeSessions.set(resolvedId, { facing, maxDimension, maxFps, seq: 0 });
    return resolvedId;
  }

  reconfigureSession(sessionId: string, maxDimension: number, maxFps: number): void {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      throw new Error(
        `[stage=native.reconfigure code=ERR_DEVICE_CAMERA_SESSION_MISSING] ${sessionId}`,
      );
    }
    session.maxDimension = maxDimension;
    session.maxFps = maxFps;
  }

  status(sessionId: string): string {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      throw new Error(
        `[stage=native.status code=ERR_DEVICE_CAMERA_SESSION_MISSING] ${sessionId}`,
      );
    }
    return JSON.stringify({
      sessionId,
      facing: session.facing,
      frames: session.seq,
      width: session.maxDimension,
      height: Math.round((session.maxDimension * 9) / 16),
      closed: false,
    });
  }

  async captureFrame(
    sessionId: string,
    maxDimension: number,
    afterSeq: number,
  ): Promise<NativeDeviceCameraFrame> {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      throw new Error(
        `[stage=native.capture code=ERR_DEVICE_CAMERA_SESSION_MISSING] ${sessionId}`,
      );
    }
    if (afterSeq > 0) {
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    if (!this.activeSessions.has(sessionId)) {
      throw new Error(`[stage=native.capture code=ERR_DEVICE_CAMERA_CLOSED] ${sessionId}`);
    }
    session.seq = Math.max(session.seq + 1, afterSeq + 1);
    const faces =
      this.facesQueue.length > 0 ? this.facesQueue.shift()! : this.defaultFaces;
    const width = Math.min(maxDimension, session.maxDimension);
    const height = Math.round((width * 9) / 16);
    const jpeg = new Uint8Array([
      0xff,
      0xd8,
      0xff,
      0xe0,
      session.seq & 0xff,
      0xff,
      0xd9,
    ]);
    return {
      jpeg,
      width,
      height,
      facing: session.facing,
      capturedAtMs: Date.now(),
      seq: session.seq,
      faces,
    };
  }

  closeSession(sessionId: string): void {
    if (this.activeSessions.delete(sessionId)) {
      this.closeCalls.push(sessionId);
    }
  }

  setForeground(active: boolean): void {
    this.foreground = active;
  }

  stopAll(): void {
    for (const id of [...this.activeSessions.keys()]) {
      this.closeSession(id);
    }
  }
}

class FakeNativeLanRoomPort implements NativeLanRoomPort {
  foreground = true;
  nextPort = 43120;
  readonly rooms = new Map<
    string,
    {
      roomId: string;
      port: number;
      lanIpv4: string;
      baseUrl: string;
      revision: number;
      pendingRequests: Array<{
        requestId: string;
        method: string;
        path: string;
        queryJson: string;
        headersJson: string;
        bodyText: string;
        remoteAddr: string;
      }>;
      waiters: Array<(req: any) => void>;
      rejecters: Array<(err: Error) => void>;
      responseResolvers: Map<
        string,
        (res: {
          status: number;
          contentType: string;
          cacheControl: string;
          body: string;
        }) => void
      >;
    }
  >();

  async openRoom(roomId: string): Promise<NativeLanRoomInfo> {
    if (!this.foreground) {
      throw new Error("[stage=lan.open code=ERR_LAN_ROOM_BACKGROUNDED] Backgrounded");
    }
    const port = this.nextPort++;
    const lanIpv4 = "192.168.31.88";
    const baseUrl = `http://${lanIpv4}:${port}`;
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

  async nextRequest(roomId: string) {
    const room = this.rooms.get(roomId);
    if (!room) {
      throw new Error(`[stage=lan.next code=ERR_LAN_ROOM_CLOSED] Closed ${roomId}`);
    }
    if (room.pendingRequests.length > 0) {
      return room.pendingRequests.shift()!;
    }
    return new Promise<any>((resolve, reject) => {
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
    const rawReq = {
      requestId,
      method: input.method,
      path: input.path,
      queryJson: JSON.stringify(input.query ?? {}),
      headersJson: JSON.stringify({ "user-agent": "PlayerPhoneTest/1.0" }),
      bodyText:
        input.body === undefined
          ? ""
          : typeof input.body === "string"
            ? input.body
            : JSON.stringify(input.body),
      remoteAddr: "192.168.31.102:54112",
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

    const rawRes = await resPromise;
    let parsedJson: any = null;
    if (rawRes.contentType.includes("application/json")) {
      parsedJson = JSON.parse(rawRes.body);
    }
    return {
      status: rawRes.status,
      contentType: rawRes.contentType,
      json: parsedJson,
      text: rawRes.body,
    };
  }
}

function makeMemoryVault(initial: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    get: (key: string) => map.get(key) ?? "",
    set: (key: string, value: string) => {
      map.set(key, value);
    },
    remove: (key: string) => {
      map.delete(key);
    },
  };
}

async function createSimulatedDockedBody(): Promise<BodyRuntime> {
  const vault = makeMemoryVault({
    body: JSON.stringify({
      mode: "simulation",
      savedDeviceId: "sim-looi-dock-01",
      savedDeviceName: "LOOI 桌面底座",
      autoConnect: true,
    }),
  });
  const body = new BodyRuntime({
    vault,
    dockGreetingLeadMs: 5,
    dockGreetingSettleMs: 5,
  });
  await body.connect({ deviceId: "sim-looi-dock-01", deviceName: "LOOI 桌面底座" });
  body.setSimulatedDock(true);
  return body;
}

function drainDawnAndLastWords(engine: WerewolfEngine): void {
  if (engine.getPhase() === "dawn_announce") {
    engine.acknowledgeDawn();
  }
  while (
    engine.getPhase() === "leave_resolution" &&
    engine.projectPublicState(DEFAULT_PUBLIC_EXTRAS).pendingLeaveReason === "last_words"
  ) {
    engine.finishLastWords();
  }
}

test("Preset boards, custom deck balancing, CSPRNG shuffle, and structured rule errors", () => {
  for (const presetId of ["6p_joy", "9p_standard", "12p_guard", "12p_idiot"] as const) {
    const rules = buildPresetRules(presetId);
    const check = validateRulesConfig(rules);
    assert.deepEqual(check, { valid: true }, `Preset ${presetId} must validate cleanly`);
    const deck = expandDeckFromRoleCounts(rules.roleCounts);
    assert.equal(deck.length, rules.playerCount);
    const shuffled = shuffleRolesCsprng(deck);
    assert.equal(shuffled.length, deck.length);
    assert.deepEqual([...shuffled].sort(), [...deck].sort());
  }

  const invalidCount = validateRulesConfig({
    ...buildPresetRules("6p_joy"),
    playerCount: 5,
  });
  assert.equal(invalidCount.valid, false);
  if (!invalidCount.valid) {
    assert.equal(invalidCount.stage, "validate_rules");
    assert.equal(invalidCount.code, "ERR_WEREWOLF_PLAYER_COUNT_RANGE");
  }

  const dupSeer = validateRulesConfig({
    ...buildPresetRules("6p_joy"),
    roleCounts: {
      ...buildPresetRules("6p_joy").roleCounts,
      seer: 2,
      villager: 1,
    },
  });
  assert.equal(dupSeer.valid, false);
  if (!dupSeer.valid) {
    assert.equal(dupSeer.code, "ERR_WEREWOLF_DUPLICATE_SINGLETON_ROLE");
  }

  const wolfMajority = validateRulesConfig({
    ...buildPresetRules("6p_joy"),
    roleCounts: {
      ...buildPresetRules("6p_joy").roleCounts,
      werewolf: 3,
      villager: 1,
    },
  });
  assert.equal(wolfMajority.valid, false);
  if (!wolfMajority.valid) {
    assert.equal(wolfMajority.code, "ERR_WEREWOLF_WOLF_MAJORITY_AT_START");
  }

  const customAdjusted = applyCustomRoleCount(buildPresetRules("9p_standard"), "guard", 1);
  assert.equal(customAdjusted.presetId, "custom");
  assert.equal(validateRulesConfig(customAdjusted).valid, true);

  const tokenA = randomTokenHex(16);
  const tokenB = randomTokenHex(16);
  assert.equal(tokenA.length, 32);
  assert.notEqual(tokenA, tokenB);
});

test("6P Joy slaughter_all full match: continues after gods fall, runs dead-god decoys, and hides secret LAN ballots", () => {
  const engine = new WerewolfEngine({
    initialRules: buildPresetRules("6p_joy", { surfaceMode: "lan_companion" }),
  });
  engine.openLobby("6p_joy");
  engine.startDealing({
    fixedRolesBySeat: {
      1: "werewolf",
      2: "werewolf",
      3: "seer",
      4: "witch",
      5: "villager",
      6: "villager",
    },
  });
  assertNoSecretLeakBeforeGameOver(engine);

  // Parallel LAN deal confirmation out of seat order
  for (const seat of [6, 2, 1, 4, 3, 5]) {
    engine.confirmSeatDealt(seat);
  }

  engine.beginFirstNight();
  assert.equal(engine.getPhase(), "night_intro");
  engine.advanceFromNightIntro();
  assert.equal(engine.getPhase(), "night_wolf");
  assertNoSecretLeakBeforeGameOver(engine);

  // Night 1: Wolves kill Seer (Seat 3); Witch saves nobody
  engine.submitWolfCompanionVote(1, 3, true);
  assert.equal(
    engine.getPhase(),
    "night_wolf",
    "Single wolf vote without teammate consensus must wait",
  );
  engine.submitWolfCompanionVote(2, 3, true);
  assert.equal(engine.getPhase(), "night_witch");
  engine.submitWitchAction({ save: false, poisonTargetSeat: null }, 4);
  assert.equal(engine.getPhase(), "night_seer");

  const seerCheck = engine.submitSeerCheck(1, 3);
  assert.deepEqual(seerCheck, { targetSeat: 1, isWolf: true });
  assertNoSecretLeakBeforeGameOver(engine);
  engine.finishSeerTurn(3);

  // Night 1 casualty Seat 3 enters leave_resolution (last_words) -> drain into day_discussion
  assert.equal(engine.getPhase(), "leave_resolution");
  drainDawnAndLastWords(engine);
  assert.equal(engine.getPhase(), "day_discussion");

  // Day 1 exile: Witch (Seat 4) gets exiled! Both gods (3 & 4) are now dead, while 2 villagers (5, 6) remain!
  engine.startVoting();
  engine.castVote(1, 4);
  engine.castVote(2, 4);
  engine.castVote(5, 4);

  // Secret LAN ballot in progress hides target map
  const midVotePub = engine.projectPublicState(DEFAULT_PUBLIC_EXTRAS);
  assert.deepEqual(midVotePub.votesByVoter, {});
  assert.deepEqual(midVotePub.votedSeats, [1, 2, 5]);

  engine.finalizeVotes();
  drainDawnAndLastWords(engine);

  // In slaughter_all, losing all gods does NOT end the match if villagers still live (unless wolf parity triggers);
  // if Night 2 runs, verify both dead Witch and dead Seer enter decoy steps that refuse nightGate unlock!
  if (engine.getPhase() !== "game_over") {
    assert.equal(engine.getPhase(), "night_intro");
    engine.advanceFromNightIntro();
    assert.equal(engine.getPhase(), "night_wolf");
    engine.submitWolfAction(5);

    assert.equal(engine.getPhase(), "night_witch");
    assert.equal(engine.isCurrentNightStepDecoy(), true);
    engine.setNightGate(true);
    assert.equal(
      engine.projectPublicState(DEFAULT_PUBLIC_EXTRAS).nightPrompt?.gateUnlocked,
      false,
      "Decoy dead-witch step must NEVER unlock nightGate",
    );
    engine.advanceDecoyNightStep();

    assert.equal(engine.getPhase(), "night_seer");
    assert.equal(engine.isCurrentNightStepDecoy(), true);
    engine.advanceDecoyNightStep();
  }

  if (engine.getPhase() !== "game_over") {
    drainDawnAndLastWords(engine);
    if (engine.getPhase() === "day_discussion") engine.startVoting();
    if (engine.getPhase() === "day_voting") {
      engine.castVote(1, 6);
      engine.castVote(2, 6);
      engine.finalizeVotes();
    }
  }

  assert.equal(engine.getPhase(), "game_over");
  const finalPub = engine.projectPublicState(DEFAULT_PUBLIC_EXTRAS);
  assert.equal(finalPub.winner, "werewolf");
  assert.equal(finalPub.fullTimelineReveal.length > 0, true);
  assert.equal(finalPub.seats[0]!.revealedRole, "werewolf");
  const aiReport = engine.exportMatchBattleReportForAi();
  assert.match(aiReport, /全员底牌/);
  assert.match(aiReport, /预言家/);
});

test("9P Standard slaughter_side + Hunter shoot when bitten/exiled vs blocked when poisoned", () => {
  const fixedRoles: Record<number, WerewolfRole> = {
    1: "werewolf",
    2: "werewolf",
    3: "werewolf",
    4: "seer",
    5: "witch",
    6: "hunter",
    7: "villager",
    8: "villager",
    9: "villager",
  };

  // Subcase A: Hunter simultaneously bitten by wolves AND poisoned by Witch -> CANNOT shoot!
  {
    const engine = new WerewolfEngine({ initialRules: buildPresetRules("9p_standard") });
    engine.openLobby("9p_standard");
    engine.startDealing({ fixedRolesBySeat: fixedRoles });
    engine.beginFirstNight();
    engine.advanceFromNightIntro();
    engine.submitWolfAction(6); // Wolves bite Hunter (6)
    engine.submitWitchAction({ save: false, poisonTargetSeat: 6 }, 5); // Witch ALSO poisons Hunter (6)!
    engine.submitSeerCheck(1, 4);
    engine.finishSeerTurn(4);

    assert.equal(engine.getPhase(), "leave_resolution");
    const pub = engine.projectPublicState(DEFAULT_PUBLIC_EXTRAS);
    assert.equal(
      pub.pendingLeaveReason,
      "last_words",
      "Poisoned hunter (even if also bitten) must only get Day 1 last_words, NEVER hunter_shoot",
    );
  }

  // Subcase B: Hunter bitten cleanly (no poison) -> CAN shoot!
  {
    const engine = new WerewolfEngine({ initialRules: buildPresetRules("9p_standard") });
    engine.openLobby("9p_standard");
    engine.startDealing({ fixedRolesBySeat: fixedRoles });
    engine.beginFirstNight();
    engine.advanceFromNightIntro();
    engine.submitWolfAction(7); // Kill villager 7
    engine.submitWitchAction({ save: false, poisonTargetSeat: 1 }, 5); // Witch poisons Wolf 1
    engine.submitSeerCheck(2, 4);
    engine.finishSeerTurn(4);
    drainDawnAndLastWords(engine);

    // Day 1: Exile Wolf 2
    engine.startVoting();
    for (const voter of [4, 5, 6, 8, 9]) {
      engine.castVote(voter, 2);
    }
    engine.finalizeVotes();
    drainDawnAndLastWords(engine);

    // Night 2: Remaining Wolf 3 bites Hunter (Seat 6)!
    assert.equal(engine.getPhase(), "night_intro");
    engine.advanceFromNightIntro();
    engine.submitWolfAction(6);
    engine.submitWitchAction({ save: false, poisonTargetSeat: null }, 5);
    engine.submitSeerCheck(3, 4);
    engine.finishSeerTurn(4);

    // Hunter (Seat 6) was bitten by wolves without poison -> MUST get hunter_shoot and shoot Wolf 3 to win!
    assert.equal(engine.getPhase(), "leave_resolution");
    assert.equal(
      engine.projectPublicState(DEFAULT_PUBLIC_EXTRAS).pendingLeaveReason,
      "hunter_shoot",
    );
    const shotOutcome = engine.resolveHunterShot(3, 6);
    assert.equal(shotOutcome.gameEnded, true);
    assert.equal(engine.getPhase(), "game_over");
    assert.equal(engine.projectPublicState(DEFAULT_PUBLIC_EXTRAS).winner, "good");
  }
});

test("Guard consecutive-target ban, sameGuardSameSaveDies (奶穿), and Witch self-save / dual-potion rules", () => {
  const fixed12Guard: Record<number, WerewolfRole> = {
    1: "werewolf",
    2: "werewolf",
    3: "werewolf",
    4: "white_wolf_king",
    5: "seer",
    6: "witch",
    7: "hunter",
    8: "guard",
    9: "villager",
    10: "villager",
    11: "villager",
    12: "villager",
  };

  // 1. Milk-pierce (同守同救奶穿 = true): Guard guards 9 + Wolves bite 9 + Witch saves 9 -> 9 DIES!
  const engine = new WerewolfEngine({
    initialRules: {
      ...buildPresetRules("12p_guard"),
      hasSheriff: false,
      sameGuardSameSaveDies: true,
      witchSelfSaveMode: "first_night_only",
    },
  });
  engine.openLobby();
  engine.startDealing({ fixedRolesBySeat: fixed12Guard });
  engine.beginFirstNight();
  engine.advanceFromNightIntro();

  assert.equal(engine.getPhase(), "night_guard");
  engine.submitGuardAction(9, 8);
  assert.equal(engine.getPhase(), "night_wolf");
  engine.submitWolfAction(9);
  assert.equal(engine.getPhase(), "night_witch");

  // Dual potion in same night rejected
  assert.throws(
    () => engine.submitWitchAction({ save: true, poisonTargetSeat: 1 }, 6),
    (err: unknown) =>
      err instanceof WerewolfRuleError && err.code === "ERR_WEREWOLF_DUAL_POTION_FORBIDDEN",
  );

  engine.submitWitchAction({ save: true, poisonTargetSeat: null }, 6);
  engine.submitSeerCheck(1, 5);
  engine.finishSeerTurn(5);

  const dawn1 = engine.projectPublicState(DEFAULT_PUBLIC_EXTRAS);
  assert.deepEqual(
    dawn1.dawnDeathsToday,
    [9],
    "When sameGuardSameSaveDies=true, guarded + saved victim must die (奶穿)",
  );

  // 2. sameGuardSameSaveDies = false -> survives, AND Guard cannot guard Seat 10 twice in a row, AND Witch cannot self-save on Night 2!
  const engineNoPierce = new WerewolfEngine({
    initialRules: {
      ...buildPresetRules("12p_guard"),
      hasSheriff: false,
      sameGuardSameSaveDies: false,
      witchSelfSaveMode: "first_night_only",
    },
  });
  engineNoPierce.openLobby();
  engineNoPierce.startDealing({ fixedRolesBySeat: fixed12Guard });
  engineNoPierce.beginFirstNight();
  engineNoPierce.advanceFromNightIntro();
  engineNoPierce.submitGuardAction(10, 8);
  engineNoPierce.submitWolfAction(10);
  // Keep antidote available so we can test Night 2 Witch self-save ban!
  engineNoPierce.submitWitchAction({ save: false, poisonTargetSeat: null }, 6);
  engineNoPierce.submitSeerCheck(1, 5);
  engineNoPierce.finishSeerTurn(5);

  assert.deepEqual(
    engineNoPierce.projectPublicState(DEFAULT_PUBLIC_EXTRAS).dawnDeathsToday,
    [],
    "Guard alone blocks wolf kill cleanly into peaceful day_discussion",
  );
  assert.equal(engineNoPierce.getPhase(), "day_discussion");
  engineNoPierce.startVoting();
  engineNoPierce.finalizeVotes();

  // Night 2: Guard tries to guard Seat 10 again -> REJECTED!
  engineNoPierce.advanceFromNightIntro();
  assert.throws(
    () => engineNoPierce.submitGuardAction(10, 8),
    (err: unknown) =>
      err instanceof WerewolfRuleError && err.code === "ERR_WEREWOLF_CONSECUTIVE_GUARD",
  );
  engineNoPierce.submitGuardAction(null, 8); // Empty guard allowed

  // Wolves bite Witch (Seat 6) on Night 2 -> first_night_only forbids Witch self-save on Night 2!
  engineNoPierce.submitWolfAction(6);
  assert.throws(
    () => engineNoPierce.submitWitchAction({ save: true, poisonTargetSeat: null }, 6),
    (err: unknown) =>
      err instanceof WerewolfRuleError && err.code === "ERR_WEREWOLF_SELF_SAVE_FORBIDDEN",
  );
});

test("Day 1 Sheriff election before Night 1 death announce: PK tie, double-tie badge loss, 1.5x vote weight, and badge transfer", () => {
  const fixed12: Record<number, WerewolfRole> = {
    1: "werewolf",
    2: "werewolf",
    3: "werewolf",
    4: "white_wolf_king",
    5: "seer",
    6: "witch",
    7: "hunter",
    8: "guard",
    9: "villager",
    10: "villager",
    11: "villager",
    12: "villager",
  };

  // Part A: Double-tie loses Sheriff badge and then applies Night 1 casualty
  {
    const engine = new WerewolfEngine({ initialRules: buildPresetRules("12p_guard") });
    engine.openLobby("12p_guard");
    engine.startDealing({ fixedRolesBySeat: fixed12 });
    engine.beginFirstNight();
    engine.advanceFromNightIntro();
    engine.submitGuardAction(null, 8);
    engine.submitWolfAction(9); // Seat 9 bitten on Night 1 — still alive during Sheriff election!
    engine.submitWitchAction({ save: false, poisonTargetSeat: null }, 6);
    engine.submitSeerCheck(1, 5);
    engine.finishSeerTurn(5);

    // Must enter sheriff_election BEFORE Night 1 death announce!
    assert.equal(engine.getPhase(), "sheriff_election");
    const preDawnPub = engine.projectPublicState(DEFAULT_PUBLIC_EXTRAS);
    assert.equal(preDawnPub.sheriffSubphase, "signup");
    assert.equal(
      preDawnPub.seats[8]!.alive,
      true,
      "Night 1 victim is not revealed dead before sheriff election",
    );

    engine.toggleSheriffCandidate(1);
    engine.toggleSheriffCandidate(5);
    engine.toggleSheriffCandidate(9);
    engine.lockSheriffCandidates();
    assert.equal(engine.projectPublicState(DEFAULT_PUBLIC_EXTRAS).sheriffSubphase, "speech");

    // Seat 9 drops out during speech
    engine.sheriffDropOut(9);
    while (engine.projectPublicState(DEFAULT_PUBLIC_EXTRAS).sheriffSubphase === "speech") {
      engine.advanceSpeaker();
    }
    assert.equal(engine.projectPublicState(DEFAULT_PUBLIC_EXTRAS).sheriffSubphase, "voting");

    // Tie 1 vote each (Seat 2 -> 1, Seat 6 -> 5; others abstain) -> PK speech!
    engine.castVote(2, 1);
    engine.castVote(6, 5);
    engine.finalizeVotes();
    assert.equal(engine.projectPublicState(DEFAULT_PUBLIC_EXTRAS).sheriffSubphase, "pk_speech");

    while (engine.projectPublicState(DEFAULT_PUBLIC_EXTRAS).sheriffSubphase === "pk_speech") {
      engine.advanceSpeaker();
    }
    assert.equal(engine.projectPublicState(DEFAULT_PUBLIC_EXTRAS).sheriffSubphase, "pk_voting");

    // Tie a second time -> badge lost -> announces Night 1 death (Seat 9) -> enters leave_resolution (last_words)!
    engine.castVote(2, 1);
    engine.castVote(6, 5);
    engine.finalizeVotes();

    const postElectionPub = engine.projectPublicState(DEFAULT_PUBLIC_EXTRAS);
    assert.equal(postElectionPub.sheriffSeat, null);
    assert.deepEqual(postElectionPub.dawnDeathsToday, [9]);
    assert.equal(postElectionPub.seats[8]!.alive, false);
  }

  // Part B: Elected Sheriff speaks last, carries 1.5 vote weight to break 1-vs-1 tie, and transfers badge on death
  {
    const engine = new WerewolfEngine({ initialRules: buildPresetRules("12p_guard") });
    engine.openLobby("12p_guard");
    engine.startDealing({ fixedRolesBySeat: fixed12 });
    engine.beginFirstNight();
    engine.advanceFromNightIntro();
    engine.submitGuardAction(null, 8);
    engine.submitWolfAction(null); // Peaceful night
    engine.submitWitchAction({ save: false, poisonTargetSeat: null }, 6);
    engine.submitSeerCheck(1, 5);
    engine.finishSeerTurn(5);

    // Seat 5 (Seer) runs unopposed -> auto-elected Sheriff -> peaceful night enters day_discussion!
    engine.toggleSheriffCandidate(5);
    engine.lockSheriffCandidates();
    assert.equal(engine.getPhase(), "day_discussion");
    const discussPub = engine.projectPublicState(DEFAULT_PUBLIC_EXTRAS);
    assert.equal(discussPub.sheriffSeat, 5);
    assert.equal(
      discussPub.speakingOrder[discussPub.speakingOrder.length - 1],
      5,
      "Living Sheriff must wrap up speeches last (归票位)",
    );

    // Exile vote: Sheriff Seat 5 votes for Wolf Seat 1 (1.5 votes) vs Seat 2 votes for Seat 10 (1.0 vote) -> Seat 1 exiled!
    engine.startVoting();
    engine.castVote(5, 1);
    engine.castVote(2, 10);
    engine.finalizeVotes();
    assert.equal(engine.projectPublicState(DEFAULT_PUBLIC_EXTRAS).seats[0]!.alive, false);
    drainDawnAndLastWords(engine);

    // Night 2: Wolves kill Sheriff Seat 5 -> Dawn 2 prompts sheriff_badge transfer!
    assert.equal(engine.getPhase(), "night_intro");
    engine.advanceFromNightIntro();
    engine.submitGuardAction(null, 8);
    engine.submitWolfAction(5);
    engine.submitWitchAction({ save: false, poisonTargetSeat: null }, 6);
    engine.submitSeerCheck(2, 5);
    engine.finishSeerTurn(5);

    assert.equal(engine.getPhase(), "leave_resolution");
    assert.equal(
      engine.projectPublicState(DEFAULT_PUBLIC_EXTRAS).pendingLeaveReason,
      "sheriff_badge",
    );
    engine.resolveSheriffTransfer(6, 5);
    assert.equal(engine.projectPublicState(DEFAULT_PUBLIC_EXTRAS).sheriffSeat, 6);
  }
});

test("12P Idiot flip-card exile survival, permanent vote/sheriff loss, and Wolf / White Wolf King daytime self-explode", () => {
  // Part A: Idiot flips card on exile, survives, loses vote & sheriff transfer eligibility
  {
    const fixed12Idiot: Record<number, WerewolfRole> = {
      1: "werewolf",
      2: "werewolf",
      3: "werewolf",
      4: "werewolf",
      5: "seer",
      6: "witch",
      7: "hunter",
      8: "idiot",
      9: "villager",
      10: "villager",
      11: "villager",
      12: "villager",
    };
    const engine = new WerewolfEngine({
      initialRules: { ...buildPresetRules("12p_idiot"), hasSheriff: true },
    });
    engine.openLobby("12p_idiot");
    engine.startDealing({ fixedRolesBySeat: fixed12Idiot });
    engine.beginFirstNight();
    engine.advanceFromNightIntro();
    engine.submitWolfAction(null);
    engine.submitWitchAction({ save: false, poisonTargetSeat: null }, 6);
    engine.submitSeerCheck(1, 5);
    engine.finishSeerTurn(5);

    engine.toggleSheriffCandidate(5);
    engine.lockSheriffCandidates(); // Seat 5 becomes Sheriff -> peaceful night -> day_discussion

    // Vote out Idiot (Seat 8)
    engine.startVoting();
    engine.castVote(1, 8);
    engine.castVote(2, 8);
    engine.castVote(3, 8);
    engine.finalizeVotes();

    const afterFlip = engine.projectPublicState(DEFAULT_PUBLIC_EXTRAS);
    const idiotSeat = afterFlip.seats[7]!;
    assert.equal(idiotSeat.alive, true, "Idiot must survive exile via card flip");
    assert.equal(idiotSeat.idiotRevealed, true);
    assert.equal(idiotSeat.revealedRole, "idiot");
    assert.equal(idiotSeat.canVote, false);

    // Night 2: Wolves kill Sheriff (Seat 5) -> Sheriff tries to transfer badge to flipped Idiot (Seat 8) -> REJECTED!
    assert.equal(engine.getPhase(), "night_intro");
    engine.advanceFromNightIntro();
    engine.submitWolfAction(5);
    engine.submitWitchAction({ save: false, poisonTargetSeat: null }, 6);
    engine.submitSeerCheck(2, 5);
    engine.finishSeerTurn(5);

    assert.throws(
      () => engine.resolveSheriffTransfer(8, 5),
      (err: unknown) =>
        err instanceof WerewolfRuleError && err.code === "ERR_WEREWOLF_IDIOT_CANNOT_BE_SHERIFF",
    );
    engine.resolveSheriffTransfer(null, 5); // Tear badge

    // Day 2 voting: Flipped Idiot (Seat 8) cannot cast vote
    engine.startVoting();
    assert.throws(
      () => engine.castVote(8, 1),
      (err: unknown) =>
        err instanceof WerewolfRuleError && err.code === "ERR_WEREWOLF_INELIGIBLE_VOTER",
    );
  }

  // Part B: Non-wolf self-explode rejected; White Wolf King daytime self-explode drags Hunter who shoots back!
  {
    const fixed12Guard: Record<number, WerewolfRole> = {
      1: "werewolf",
      2: "werewolf",
      3: "werewolf",
      4: "white_wolf_king",
      5: "seer",
      6: "witch",
      7: "hunter",
      8: "guard",
      9: "villager",
      10: "villager",
      11: "villager",
      12: "villager",
    };
    const engine = new WerewolfEngine({
      initialRules: { ...buildPresetRules("12p_guard"), hasSheriff: false },
    });
    engine.openLobby();
    engine.startDealing({ fixedRolesBySeat: fixed12Guard });
    engine.beginFirstNight();
    engine.advanceFromNightIntro();
    engine.submitGuardAction(null, 8);
    engine.submitWolfAction(null);
    engine.submitWitchAction({ save: false, poisonTargetSeat: null }, 6);
    engine.submitSeerCheck(1, 5);
    engine.finishSeerTurn(5);
    assert.equal(engine.getPhase(), "day_discussion");

    // Villager Seat 9 tries to fake wolf explode -> strictly rejected!
    assert.throws(
      () => engine.triggerWolfExplode(9),
      (err: unknown) =>
        err instanceof WerewolfRuleError && err.code === "ERR_WEREWOLF_NOT_A_WOLF",
    );

    // White Wolf King (Seat 4) explodes without immediate target -> enters white_wolf_explode prompt
    engine.triggerWolfExplode(4);
    assert.equal(engine.getPhase(), "leave_resolution");
    assert.equal(
      engine.projectPublicState(DEFAULT_PUBLIC_EXTRAS).pendingLeaveReason,
      "white_wolf_explode",
    );

    // Drags Hunter (Seat 7) -> Hunter triggers hunter_shoot -> shoots Wolf 1 -> cuts straight to Night 2!
    engine.resolveWhiteWolfExplodeTarget(7, 4);
    assert.equal(engine.getPhase(), "leave_resolution");
    assert.equal(
      engine.projectPublicState(DEFAULT_PUBLIC_EXTRAS).pendingLeaveReason,
      "hunter_shoot",
    );
    engine.resolveHunterShot(1, 7);
    assert.equal(engine.getPhase(), "night_intro");
    assert.equal(engine.getDay(), 2);
  }
});

test("WerewolfChoreographer dynamic face recipes, P-controller centering, 6-9s timing mask, and speed=0 fall safety", async () => {
  for (const [slot, entry] of Object.entries(WEREWOLF_DYNAMIC_FACE_RECIPES)) {
    const issue = validateDynamicFaceRecipeIssue(slot, entry.recipe);
    assert.equal(issue, null, `Dynamic face recipe "${slot}" had schema issue: ${String(issue)}`);
  }

  assert.deepEqual(computeFaceCenteringTurn(0.04), { aligned: true, turn: 0 });
  assert.deepEqual(computeFaceCenteringTurn(0.5), { aligned: false, turn: -24 });
  assert.deepEqual(computeFaceCenteringTurn(-2.0), { aligned: false, turn: 55 });

  for (let sample = 0; sample < 20; sample += 1) {
    const delay = computeDeadRoleMaskDelayMs();
    assert.equal(delay >= 6000 && delay <= 9000, true, `Delay ${delay} out of [6000, 9000]ms`);
  }

  assert.equal(
    resolveStagePresentation({ phase: "idle", sheriffSubphase: null, surfaceMode: "on_device" }),
    null,
  );
  assert.equal(
    resolveStagePresentation({
      phase: "night_wolf",
      sheriffSubphase: null,
      surfaceMode: "lan_companion",
    })?.facePosture.kind,
    "full",
  );

  const hub = new FaceDriverHub();
  const faceController = new RobotFaceController();
  faceController.attachRecipeSyncBridge((id, recipe) => {
    if (recipe) registerDynamicFaceRecipe(id, recipe);
    else clearDynamicFaceRecipe(id);
  });
  hub.attachController(faceController);

  const driveVectors: Array<{ speed: number; turn: number }> = [];
  const timingMasks: Array<{ role: string; plannedDelayMs: number }> = [];
  const decoySweeps: number[] = [];

  const bodyRuntime = await createSimulatedDockedBody();
  const rootScope = createEffectScope("werewolf-choreo-test");
  try {
    const manifest = {
      id: "werewolf-judge",
      version: "1.0.0",
      minHostApiVersion: 2,
      category: "games_social" as const,
      icon: "sparkles",
      name: { "zh-CN": "狼人杀", "en-US": "Werewolf" },
      summary: { "zh-CN": "裁判", "en-US": "Referee" },
      author: { name: "Test" },
      permissions: ["face.control", "face.register", "body.motion", "stage.ui"] as const,
    };

    const realBodyCap = createBodyCapability(manifest, rootScope, bodyRuntime)!;
    const spiedBodyCap: typeof realBodyCap = {
      ...realBodyCap,
      acquireServo: async (priority, scope) => {
        const lease = await realBodyCap.acquireServo(priority, scope);
        return {
          ...lease,
          setDriveVector: async (speed, turn) => {
            driveVectors.push({ speed, turn });
            return lease.setDriveVector(speed, turn);
          },
        };
      },
    };

    const choreographer = new WerewolfChoreographer({
      face: hub.createCapability(manifest, rootScope),
      body: spiedBodyCap,
      pluginScope: rootScope,
      sleep: async () => {},
      onTimingMaskScheduled: (info) => timingMasks.push(info),
      onDecoySweepExecuted: ({ pulses }) => decoySweeps.push(pulses.length),
    });

    const matchScope = rootScope.fork("match-1");
    await choreographer.acquireMatchLeases(matchScope);
    for (const slot of Object.keys(WEREWOLF_DYNAMIC_FACE_RECIPES) as WerewolfFaceSlot[]) {
      choreographer.setFaceSlot(slot, { x: 0.1, y: -0.1 });
      assert.equal(faceController.getState().expression, `plugin:werewolf-judge:${slot}`);
    }

    await choreographer.applyVisualTrackingFrame(0.35, -0.1, "embodied_patrol", true);
    await choreographer.pivotClockwiseToNextSeat(9, "embodied_patrol");
    await choreographer.performNightEntrySweep("embodied_patrol", "on_device");
    await choreographer.performAcousticDecoySweep("embodied_patrol");
    const maskedMs = await choreographer.runDeadRoleTimingMask("witch", "embodied_patrol");
    await choreographer.releaseMatchLeases();

    assert.equal(maskedMs >= 6000 && maskedMs <= 9000, true);
    assert.equal(timingMasks.length, 1);
    assert.equal(decoySweeps.length, 1);
    assert.equal(driveVectors.length > 0, true, "Expected simulated wheel pivot vectors");
    for (const vec of driveVectors) {
      assert.equal(
        vec.speed,
        0,
        `Tabletop safety violation: setDriveVector called with non-zero linear speed=${vec.speed}`,
      );
    }
  } finally {
    await rootScope.dispose();
    bodyRuntime.close();
    faceController.dispose();
  }
});

test("vision-person-tracker strictly enforces 0-subscriber camera OFF, ref-counted sharing, EMA smoothing, and base64 JPEG portrait", async () => {
  const rawBytes = new Uint8Array([0xff, 0xd8, 0x01, 0x02, 0x03, 0xff, 0xd9]);
  const uri = encodeJpegDataUri(rawBytes);
  assert.equal(uri.startsWith("data:image/jpeg;base64,"), true);
  assert.deepEqual(
    Uint8Array.from(Buffer.from(uri.slice("data:image/jpeg;base64,".length), "base64")),
    rawBytes,
  );

  const cameraPort = new FakeTrackingCameraPort();
  cameraPort.facesQueue.push(
    [{ trackId: 11, offsetX: 0.6, offsetY: 0.2, width: 0.3, height: 0.35, confidence: 0.95 }],
    [{ trackId: 11, offsetX: 0.2, offsetY: 0.0, width: 0.3, height: 0.35, confidence: 0.95 }],
  );

  const visionBroker = new VisionBroker();
  visionBroker.attachNativePort(cameraPort);

  let resolvedService: PersonTrackerService | undefined;
  const consumerProbeDef: PluginDefinition = {
    manifest: {
      id: "tracker-consumer-probe",
      version: "1.0.0",
      minHostApiVersion: 2,
      category: "utilities",
      icon: "eye",
      name: { "zh-CN": "Probe", "en-US": "Probe" },
      summary: { "zh-CN": "Probe", "en-US": "Probe" },
      author: { name: "Test" },
      permissions: [],
      dependencies: [{ service: PERSON_TRACKER_SERVICE_ID, versionRange: "^1.0.0", optional: false }],
    },
    initialState: () => ({}),
    create: (ctx) => ({
      start: async () => {
        resolvedService = ctx.services.get<PersonTrackerService>(PERSON_TRACKER_SERVICE_ID);
      },
    }),
  };

  const db = new DatabaseSync(":memory:");
  const host = new PluginHost(db, [visionPersonTrackerDefinition(), consumerProbeDef], {
    createVisionCapability: (manifest, scope) =>
      createVisionCapability(manifest, scope, visionBroker),
  });
  await host.startAll();

  // Idle invariant: enabled plugin with 0 tracking consumers MUST NOT open camera!
  assert.equal(cameraPort.openCalls.length, 0);
  assert.equal(cameraPort.activeSessions.size, 0);
  assert.equal((host.snapshot("vision-person-tracker").state as any).streaming, false);
  assert.ok(resolvedService, "Expected vision.person-tracker service to resolve via PluginHost DAG");

  const consumerScopeA = createEffectScope("consumer-a");
  const consumerScopeB = createEffectScope("consumer-b");
  const framesA: PersonTrackingFrame[] = [];
  const framesB: PersonTrackingFrame[] = [];

  const subA = await resolvedService!.acquireTracking(
    { maxFps: 8, smoothingAlpha: 0.5 },
    (frame) => framesA.push(frame),
    consumerScopeA,
  );
  await resolvedService!.acquireTracking(
    { maxFps: 10, smoothingAlpha: 0.5 },
    (frame) => framesB.push(frame),
    consumerScopeB,
  );

  assert.equal(subA.previewSessionId.length > 0, true);
  assert.equal(
    cameraPort.openCalls.length,
    1,
    "Two concurrent consumers must share a single native front-camera stream",
  );
  assert.equal(resolvedService!.isStreaming(), true);

  const deadline = Date.now() + 500;
  while (framesA.length < 2 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(framesA.length >= 2, true);
  assert.equal(framesB.length >= 1, true);
  assert.equal(framesA[0]!.primaryTarget?.offsetX, 0.6);
  // Second frame raw offsetX=0.2 with alpha=0.5 -> smoothed 0.4!
  assert.equal(framesA[1]!.primaryTarget?.offsetX, 0.4);

  const portrait = await resolvedService!.capturePortrait({ maxDimension: 320 });
  assert.equal(portrait.dataUri.startsWith("data:image/jpeg;base64,"), true);

  // Dispose consumer A -> stream stays open for consumer B
  await consumerScopeA.dispose();
  assert.equal(resolvedService!.isStreaming(), true);
  assert.equal(cameraPort.activeSessions.size, 1);

  // Dispose consumer B -> camera closes IMMEDIATELY!
  await consumerScopeB.dispose();
  assert.equal(resolvedService!.isStreaming(), false);
  assert.equal(cameraPort.activeSessions.size, 0);

  await host.close();
  visionBroker.close();
});

test("LanRoomBroker + LanCompanionController enforce seatToken secret isolation, wolf-pack night consensus, and revision notifications", async () => {
  const nativeLan = new FakeNativeLanRoomPort();
  const lanBroker = new LanRoomBroker();
  lanBroker.attachNativePort(nativeLan);

  const engine = new WerewolfEngine({
    initialRules: buildPresetRules("6p_joy", { surfaceMode: "lan_companion" }),
  });
  engine.openLobby("6p_joy");

  const notifiedRevisions: number[] = [];
  let sessionRoomId = "";

  const companion = new LanCompanionController({
    engine,
    onClaimsChanged: () => {},
    onAuthenticatedAction: (seat, payload) => {
      switch (payload.action) {
        case "confirm_deal":
          engine.confirmSeatDealt(seat);
          break;
        case "wolf_vote":
          engine.submitWolfCompanionVote(seat, payload.targetSeat, payload.confirm ?? true);
          break;
        case "witch_act":
          engine.submitWitchAction(
            { save: payload.save, poisonTargetSeat: payload.poisonTargetSeat },
            seat,
          );
          break;
        case "seer_check":
          engine.submitSeerCheck(payload.targetSeat, seat);
          break;
        case "seer_finish":
          engine.finishSeerTurn(seat);
          break;
        case "cast_vote":
          engine.castVote(seat, payload.targetSeat, { autoFinalizeWhenAllVoted: true });
          break;
        default:
          throw new Error(`Unexpected action in test: ${payload.action}`);
      }
      roomSession.notifyRevision(engine.getRevision());
      notifiedRevisions.push(engine.getRevision());
    },
  });

  const pluginScope = createEffectScope("lan-test");
  const lanCap = createLanRoomCapability(
    {
      id: "werewolf-judge",
      version: "1.0.0",
      minHostApiVersion: 2,
      category: "games_social",
      icon: "sparkles",
      name: { "zh-CN": "狼人杀", "en-US": "Werewolf" },
      summary: { "zh-CN": "裁判", "en-US": "Referee" },
      author: { name: "Test" },
      permissions: ["network.lan_room"],
    },
    pluginScope,
    lanBroker,
  )!;

  const roomSession = await lanCap.openRoom({
    scope: pluginScope,
    onRequest: (req) => companion.handleHttpRequest(req),
  });
  sessionRoomId = roomSession.roomId;
  assert.equal(roomSession.baseUrl, "http://192.168.31.88:43120");

  // 1. Mobile SPA HTML loads cleanly without external CDN links and escapes XSS in nicknames
  const htmlRes = await nativeLan.simulateHttp(sessionRoomId, { method: "GET", path: "/" });
  assert.equal(htmlRes.status, 200);
  assert.match(htmlRes.contentType, /text\/html/);
  assert.equal(/https?:\/\/cdn/i.test(htmlRes.text), false);
  assert.equal(htmlRes.text.includes("function esc("), true);

  // Verify nickname HTML XSS payload is preserved safely in JSON & rejected/bounded cleanly
  const xssClaim = await nativeLan.simulateHttp(sessionRoomId, {
    method: "POST",
    path: "/api/claim",
    body: { seat: 1, nickname: "<svg onload=1>" },
  });
  assert.equal(xssClaim.status, 200);
  const xssState = await nativeLan.simulateHttp(sessionRoomId, {
    method: "GET",
    path: "/api/state",
    query: { seat: "1", token: xssClaim.json.seatToken },
  });
  assert.equal(xssState.status, 200);
  assert.equal(xssState.json.view.seats[0].nickname, "<svg onload=1>");
  // Re-claim Seat 1 with its own valid token back to P1
  const reclaimP1 = await nativeLan.simulateHttp(sessionRoomId, {
    method: "POST",
    path: "/api/claim",
    body: { seat: 1, nickname: "P1", token: xssClaim.json.seatToken },
  });
  assert.equal(reclaimP1.status, 200);

  // 2. All 6 players claim their seats and get distinct cryptographic tokens
  const tokens = new Map<number, string>([[1, reclaimP1.json.seatToken]]);
  for (let seat = 2; seat <= 6; seat += 1) {
    const claimRes = await nativeLan.simulateHttp(sessionRoomId, {
      method: "POST",
      path: "/api/claim",
      body: { seat, nickname: `P${seat}` },
    });
    assert.equal(claimRes.status, 200);
    assert.equal(claimRes.json.ok, true);
    tokens.set(seat, claimRes.json.seatToken);
  }

  // Hijack attempt without token -> 403 ERR_LAN_SEAT_ALREADY_CLAIMED
  const hijackRes = await nativeLan.simulateHttp(sessionRoomId, {
    method: "POST",
    path: "/api/claim",
    body: { seat: 1, nickname: "Attacker" },
  });
  assert.equal(hijackRes.status, 403);
  assert.equal(hijackRes.json.code, "ERR_LAN_SEAT_ALREADY_CLAIMED");

  engine.startDealing({
    fixedRolesBySeat: {
      1: "werewolf",
      2: "werewolf",
      3: "seer",
      4: "witch",
      5: "villager",
      6: "villager",
    },
  });

  // 3. Cross-seat secret isolation: Villager (Seat 5) CANNOT read Wolf (Seat 1) state with Seat 5's token!
  const snoopingRes = await nativeLan.simulateHttp(sessionRoomId, {
    method: "GET",
    path: "/api/state",
    query: { seat: "1", token: tokens.get(5)! },
  });
  assert.equal(snoopingRes.status, 401);
  assert.equal(snoopingRes.json.code, "ERR_LAN_UNAUTHORIZED_TOKEN");

  // Villager (Seat 5) reads own view -> sees ONLY own role ("villager"), all other seats revealedRole === null!
  const p5DealView = await nativeLan.simulateHttp(sessionRoomId, {
    method: "GET",
    path: "/api/state",
    query: { seat: "5", token: tokens.get(5)! },
  });
  assert.equal(p5DealView.status, 200);
  assert.equal(p5DealView.json.view.myRole, "villager");
  for (const s of p5DealView.json.view.seats) {
    assert.equal(s.revealedRole, null);
  }

  for (let seat = 1; seat <= 6; seat += 1) {
    const res = await nativeLan.simulateHttp(sessionRoomId, {
      method: "POST",
      path: "/api/action",
      body: { seat, token: tokens.get(seat), action: "confirm_deal" },
    });
    assert.equal(res.status, 200);
  }
  engine.beginFirstNight();
  engine.advanceFromNightIntro();

  // 4. Night Wolf turn: Wolves (1 & 2) see teammate list, while Villager (5) gets actionPrompt === null
  const wolf1Night = await nativeLan.simulateHttp(sessionRoomId, {
    method: "GET",
    path: "/api/state",
    query: { seat: "1", token: tokens.get(1)! },
  });
  assert.equal(wolf1Night.json.view.actionPrompt.kind, "wolf_consensus");
  assert.equal(wolf1Night.json.view.actionPrompt.wolfTeammates.length, 2);

  const villagerNight = await nativeLan.simulateHttp(sessionRoomId, {
    method: "GET",
    path: "/api/state",
    query: { seat: "5", token: tokens.get(5)! },
  });
  assert.equal(villagerNight.json.view.actionPrompt, null);

  // Wolves reach consensus on Seat 5 -> Witch skips -> Seer checks Seat 1 -> Dawn leave_resolution!
  await nativeLan.simulateHttp(sessionRoomId, {
    method: "POST",
    path: "/api/action",
    body: { seat: 1, token: tokens.get(1), action: "wolf_vote", targetSeat: 5, confirm: true },
  });
  await nativeLan.simulateHttp(sessionRoomId, {
    method: "POST",
    path: "/api/action",
    body: { seat: 2, token: tokens.get(2), action: "wolf_vote", targetSeat: 5, confirm: true },
  });
  assert.equal(engine.getPhase(), "night_witch");

  await nativeLan.simulateHttp(sessionRoomId, {
    method: "POST",
    path: "/api/action",
    body: {
      seat: 4,
      token: tokens.get(4),
      action: "witch_act",
      save: false,
      poisonTargetSeat: null,
    },
  });
  assert.equal(engine.getPhase(), "night_seer");

  const seerCheckHttp = await nativeLan.simulateHttp(sessionRoomId, {
    method: "POST",
    path: "/api/action",
    body: { seat: 3, token: tokens.get(3), action: "seer_check", targetSeat: 1 },
  });
  assert.equal(seerCheckHttp.status, 200);
  assert.deepEqual(seerCheckHttp.json.view.actionPrompt.latestSeerResult, {
    targetSeat: 1,
    isWolf: true,
  });

  await nativeLan.simulateHttp(sessionRoomId, {
    method: "POST",
    path: "/api/action",
    body: { seat: 3, token: tokens.get(3), action: "seer_finish" },
  });
  assert.equal(engine.getPhase(), "leave_resolution");
  assert.equal(notifiedRevisions.length >= 10, true);

  // App backgrounding tears down active LAN rooms immediately
  lanBroker.setForegroundActive(false);
  assert.equal(nativeLan.rooms.size, 0);
  await pluginScope.dispose();
  lanBroker.close();
});

test("PluginHost full dual-plugin integration: nightScope interceptUserTurn, exitPluginStage onHostExit teardown, and AI MVP commentary", async () => {
  const cameraPort = new FakeTrackingCameraPort();
  const visionBroker = new VisionBroker();
  visionBroker.attachNativePort(cameraPort);

  const nativeLan = new FakeNativeLanRoomPort();
  const lanBroker = new LanRoomBroker();
  lanBroker.attachNativePort(nativeLan);

  const faceHub = new FaceDriverHub();
  const bodyRuntime = await createSimulatedDockedBody();

  const spokenAnnouncements: string[] = [];
  const backgroundPrompts: string[] = [];

  const db = new DatabaseSync(":memory:");
  const host = new PluginHost(
    db,
    [
      visionPersonTrackerDefinition(),
      werewolfJudgeDefinition({
        sleep: async () => {},
        nightIntroDelayMs: 0,
        speakerTickMs: 250,
        fixedRolesBySeat: {
          1: "werewolf",
          2: "werewolf",
          3: "seer",
          4: "witch",
          5: "villager",
          6: "villager",
        },
      }),
    ],
    {
      createFaceCapability: (manifest, scope) => faceHub.createCapability(manifest, scope),
      createBodyCapability: (manifest, scope) =>
        createBodyCapability(manifest, scope, bodyRuntime),
      createVisionCapability: (manifest, scope) =>
        createVisionCapability(manifest, scope, visionBroker),
      createLanCapability: (manifest, scope) =>
        createLanRoomCapability(manifest, scope, lanBroker),
      aiBridge: {
        speak: async ({ spokenText }) => {
          spokenAnnouncements.push(spokenText);
          return { completed: true };
        },
        runBackgroundTask: async ({ prompt }) => {
          backgroundPrompts.push(prompt);
          return {
            taskId: "mvp-1",
            answer: "本局 MVP 授予 3 号预言家与 4 号女巫，精准查杀毒狼拿下胜利！",
          };
        },
      },
    },
  );

  await host.startAll();
  try {
    const send = (cmd: WerewolfCommand) =>
      host.sendCommand<WerewolfCommand, unknown>(WEREWOLF_PLUGIN_ID, cmd);
    const readState = () => host.snapshot(WEREWOLF_PLUGIN_ID).state as WerewolfPublicState;

    await send({ type: "open_lobby", presetId: "6p_joy" });
    assert.equal(readState().phase, "lobby");
    assert.equal(readState().visionAvailable, true);
    assert.equal(host.stage.activePluginId(), WEREWOLF_PLUGIN_ID);

    // Start dealing -> automatically acquires vision-person-tracker camera stream!
    await send({ type: "start_dealing" });
    assert.equal(readState().phase, "dealing");
    assert.equal(cameraPort.openCalls.length, 1);

    // Capture portrait for Seat 1 + Hold-to-Reveal privacy gate check
    await send({ type: "capture_seat_portrait", seat: 1 });
    assert.equal(
      readState().seats[0]!.portraitDataUri?.startsWith("data:image/jpeg;base64,"),
      true,
    );

    await send({ type: "set_deal_reveal", seat: 1, revealing: true });
    assert.equal(readState().seats[0]!.revealedRole, "werewolf");
    assert.equal(readState().seats[1]!.revealedRole, null);
    await send({ type: "set_deal_reveal", seat: 1, revealing: false });
    assert.equal(readState().seats[0]!.revealedRole, null);

    for (let seat = 1; seat <= 6; seat += 1) {
      await send({ type: "confirm_seat_dealt", seat });
    }

    // Enter Night 1 -> dealing camera stream MUST close immediately, and nightScope voice guard MUST activate!
    await send({ type: "begin_first_night" });
    const waitNight = Date.now() + 200;
    while (readState().phase === "night_intro" && Date.now() < waitNight) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(readState().phase, "night_wolf");
    assert.equal(
      cameraPort.activeSessions.size,
      0,
      "Camera stream must release upon entering night",
    );

    // Night anti-leak voice guard:
    // 1) Short cough/noise (<= 3 chars) -> blocked SILENTLY (spokenReply === undefined)
    const noiseGuard = await host.ai.evaluateUserTurn({ channel: "voice", text: "咳咳" });
    assert.equal(noiseGuard?.decision, "block");
    assert.equal(noiseGuard?.spokenReply, undefined);

    // 2) Full question ("谁是狼人？") -> blocked with "天黑请保持安静"
    const leakGuard = await host.ai.evaluateUserTurn({
      channel: "voice",
      text: "请问今晚谁是狼人呀？",
    });
    assert.equal(leakGuard?.decision, "block");
    assert.match(leakGuard?.spokenReply ?? "", /天黑请保持安静/);

    // Complete Night 1: Wolves empty-knife, Witch poisons Wolf 1, Seer checks Wolf 2 -> Dawn!
    await send({ type: "submit_wolf_action", targetSeat: null });
    await send({ type: "submit_witch_action", save: false, poisonTargetSeat: 1 });
    await send({ type: "submit_seer_check", targetSeat: 2 });
    await send({ type: "finish_seer_turn" });

    if (readState().phase === "leave_resolution") {
      await send({ type: "finish_last_words" });
    }
    assert.equal(readState().phase, "day_discussion");

    // Daytime: night voice guard is disposed (user turns allowed!), public ContextSlice active without secrets!
    const dayTurnGuard = await host.ai.evaluateUserTurn({
      channel: "voice",
      text: "帮我总结一下公开台面",
    });
    assert.equal(dayTurnGuard, undefined);

    const assembled = await host.ai.assembleTurn({
      channel: "task",
      userText: "现在场上什么情况？",
    });
    const combinedCtx = assembled.contextBlocks.map((b) => b.text).join("\n");
    assert.match(combinedCtx, /狼人杀公开台面状态/);
    assert.equal(combinedCtx.includes("底牌【"), false);

    // Host stage exit (e.g. user exits MorphableStage): fires onHostExit -> pauses match & releases foreground stage!
    host.stage.exitPluginStage(WEREWOLF_PLUGIN_ID);
    const pauseDeadline = Date.now() + 200;
    while (!readState().hostPaused && Date.now() < pauseDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(host.stage.activePluginId(), null);
    assert.equal(readState().hostPaused, true);

    // Resume stage -> restores MorphableStage presentation!
    await send({ type: "resume_stage" });
    assert.equal(host.stage.activePluginId(), WEREWOLF_PLUGIN_ID);
    assert.equal(readState().hostPaused, false);

    // Exile remaining Wolf 2 -> Good wins -> triggers AI MVP battle report review!
    await send({ type: "start_voting" });
    for (const voter of [3, 4, 5, 6]) {
      await send({ type: "cast_on_device_vote", voterSeat: voter, targetSeat: 2 });
    }
    await send({ type: "finalize_votes" });

    const mvpDeadline = Date.now() + 300;
    while (readState().aiMvpReview.status !== "ready" && Date.now() < mvpDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 15));
    }

    assert.equal(readState().phase, "game_over");
    assert.equal(readState().winner, "good");
    assert.equal(readState().aiMvpReview.status, "ready");
    assert.match(readState().aiMvpReview.text ?? "", /MVP/);
    assert.equal(backgroundPrompts.length, 1);
    assert.equal(spokenAnnouncements.length > 0, true);
  } finally {
    await host.close();
    lanBroker.close();
    visionBroker.close();
    bodyRuntime.close();
  }
});
