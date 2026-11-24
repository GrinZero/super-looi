import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { RobotFaceController } from "@super-looi/runtime/face";
import { BodyRuntime } from "../runtime/body.js";
import {
  VisionBroker,
  type NativeDeviceCameraFrame,
  type NativeDeviceCameraPort,
} from "../runtime/device-camera.js";
import type {
  DeviceCameraFrame,
  PluginDefinition,
  PluginManifest,
} from "../runtime/plugins/contracts.js";
import { createEffectScope } from "../runtime/plugins/effect-scope.js";
import {
  FaceDriverHub,
  createBodyCapability,
  createVisionCapability,
} from "../runtime/plugins/embodied-drivers.js";
import { PluginKernelError } from "../runtime/plugins/errors.js";
import { PluginHost } from "../runtime/plugins/host.js";
import {
  assembleSignedNshPackage,
  computePayloadSha256Hex,
  serializeCanonicalNshPayload,
  verifyNshPackage,
} from "../runtime/plugins/package-loader.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createMemoryVault() {
  const store = new Map<string, string>();
  return {
    get: (key: string) => store.get(key) ?? "",
    set: (key: string, value: string) => {
      store.set(key, value);
    },
    remove: (key: string) => {
      store.delete(key);
    },
  };
}

class FakeNativeDeviceCamera implements NativeDeviceCameraPort {
  permissionState: "granted" | "denied" | "undetermined" | "unavailable" = "granted";
  requestPermissionResult: "granted" | "denied" | "unavailable" = "granted";
  foreground = true;

  readonly openCalls: Array<{
    facing: string;
    maxDimension: number;
    maxFps: number;
    requestedSessionId: string;
    returnedSessionId: string;
  }> = [];
  readonly reconfigureCalls: Array<{
    sessionId: string;
    maxDimension: number;
    maxFps: number;
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
    this.permissionState = this.requestPermissionResult;
    return this.requestPermissionResult;
  }

  async openSession(
    facing: string,
    maxDimension: number,
    maxFps: number,
    sessionId: string,
  ): Promise<string> {
    const id = sessionId.trim() || `cam-${facing}-${this.openCalls.length + 1}`;
    this.openCalls.push({
      facing,
      maxDimension,
      maxFps,
      requestedSessionId: sessionId,
      returnedSessionId: id,
    });
    this.activeSessions.set(id, { facing, maxDimension, maxFps, seq: 0 });
    return id;
  }

  reconfigureSession(sessionId: string, maxDimension: number, maxFps: number): void {
    const entry = this.activeSessions.get(sessionId);
    if (!entry) {
      throw new Error(`[stage=native.reconfigure code=ERR_DEVICE_CAMERA_SESSION_MISSING] Missing ${sessionId}`);
    }
    entry.maxDimension = maxDimension;
    entry.maxFps = maxFps;
    this.reconfigureCalls.push({ sessionId, maxDimension, maxFps });
  }

  status(sessionId: string): string {
    const entry = this.activeSessions.get(sessionId);
    if (!entry) {
      throw new Error(`[stage=native.status code=ERR_DEVICE_CAMERA_SESSION_MISSING] Missing ${sessionId}`);
    }
    return JSON.stringify({
      sessionId,
      facing: entry.facing,
      frames: entry.seq,
      width: entry.maxDimension,
      height: Math.round((entry.maxDimension * 9) / 16),
      closed: false,
    });
  }

  async captureFrame(
    sessionId: string,
    maxDimension: number,
    afterSeq: number,
  ): Promise<NativeDeviceCameraFrame> {
    const entry = this.activeSessions.get(sessionId);
    if (!entry) {
      throw new Error(`[stage=native.capture code=ERR_DEVICE_CAMERA_SESSION_MISSING] Missing ${sessionId}`);
    }
    if (afterSeq >= entry.seq) {
      entry.seq = afterSeq + 1;
    }
    const width = Math.min(maxDimension, entry.maxDimension);
    const height = Math.round((width * 9) / 16);
    const jpeg = new Uint8Array([0xff, 0xd8, entry.seq & 0xff, width & 0xff, 0xff, 0xd9]);
    return {
      jpeg,
      width,
      height,
      facing: entry.facing,
      capturedAtMs: Date.now(),
      seq: entry.seq,
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

test("VisionBroker multiplexes per-facing camera sessions, dynamically reconfigures bounds, and enforces single-frame backpressure", async () => {
  const nativePort = new FakeNativeDeviceCamera();
  const broker = new VisionBroker();
  broker.attachNativePort(nativePort);

  const fastFrames: DeviceCameraFrame[] = [];
  const slowFrames: DeviceCameraFrame[] = [];
  const backFrames: DeviceCameraFrame[] = [];
  let activeSlowCallbacks = 0;
  let maxConcurrentSlowCallbacks = 0;

  // Subscriber 1 on front camera: 320px @ 4 FPS, intentionally slow (150ms processing)
  const subSlow = await broker.subscribeFrames(
    { facing: "front", maxDimension: 320, maxFps: 4 },
    async (frame) => {
      activeSlowCallbacks += 1;
      if (activeSlowCallbacks > maxConcurrentSlowCallbacks) {
        maxConcurrentSlowCallbacks = activeSlowCallbacks;
      }
      // Mutate buffer locally to prove defensive isolation across subscribers
      frame.jpeg[0] = 0x00;
      slowFrames.push(frame);
      await sleep(150);
      activeSlowCallbacks -= 1;
    },
  );

  assert.equal(nativePort.openCalls.length, 1);
  assert.equal(nativePort.openCalls[0]?.facing, "front");
  assert.equal(nativePort.openCalls[0]?.maxDimension, 320);
  assert.equal(nativePort.openCalls[0]?.maxFps, 4);

  // Subscriber 2 on front camera: 1280px @ 15 FPS -> shares the SAME native session & upgrades ceiling
  const subFast = await broker.subscribeFrames(
    { facing: "front", maxDimension: 1280, maxFps: 15 },
    (frame) => {
      fastFrames.push(frame);
    },
  );

  assert.equal(subFast.previewSessionId, subSlow.previewSessionId);
  assert.equal(nativePort.openCalls.filter((c) => c.facing === "front").length, 1);
  assert.deepEqual(nativePort.reconfigureCalls.at(-1), {
    sessionId: subFast.previewSessionId,
    maxDimension: 1280,
    maxFps: 15,
  });

  // Subscriber 3 on back camera: opens an independent native session
  const subBack = await broker.subscribeFrames(
    { facing: "back", maxDimension: 640, maxFps: 6 },
    (frame) => {
      backFrames.push(frame);
    },
  );
  assert.notEqual(subBack.previewSessionId, subFast.previewSessionId);
  assert.equal(nativePort.activeSessions.size, 2);

  await sleep(340);

  // Fast front subscriber receives high-rate 1280px frames with intact JFIF header,
  // while slow front subscriber receives downscaled 320px frames with strict single-frame-in-flight backpressure.
  assert.ok(fastFrames.length >= 3, `expected >= 3 fast frames, got ${fastFrames.length}`);
  assert.ok(slowFrames.length >= 1, `expected >= 1 slow frame, got ${slowFrames.length}`);
  assert.ok(fastFrames.length > slowFrames.length);
  assert.equal(maxConcurrentSlowCallbacks, 1);
  assert.equal(fastFrames[0]?.width, 1280);
  assert.equal(fastFrames[0]?.jpeg[0], 0xff);
  assert.equal(slowFrames[0]?.width, 320);
  assert.ok(backFrames.length >= 1);
  assert.equal(backFrames[0]?.facing, "back");

  // Closing the high-spec front subscriber downgrades the shared front session back to (320, 4)
  subFast.close();
  assert.equal(nativePort.activeSessions.has(subSlow.previewSessionId), true);
  assert.deepEqual(nativePort.reconfigureCalls.at(-1), {
    sessionId: subSlow.previewSessionId,
    maxDimension: 320,
    maxFps: 4,
  });

  // Closing remaining subscribers immediately releases native hardware sessions
  subSlow.close();
  assert.equal(nativePort.activeSessions.has(subSlow.previewSessionId), false);
  subBack.close();
  assert.equal(nativePort.activeSessions.size, 0);

  broker.close();
});

test("createVisionCapability enforces per-lens permissions, OS authorization states, and seamless foreground previewSessionId rebinding", async (t) => {
  const nativePort = new FakeNativeDeviceCamera();
  nativePort.permissionState = "undetermined";
  const broker = new VisionBroker();
  broker.attachNativePort(nativePort);
  t.after(() => {
    broker.close();
  });

  const frontOnlyManifest: PluginManifest = {
    id: "front-cam-plugin",
    version: "1.0.0",
    minHostApiVersion: 2,
    category: "vision_motion",
    icon: "camera",
    name: { "zh-CN": "前摄插件", "en-US": "Front Cam Plugin" },
    summary: { "zh-CN": "仅声明前置摄像头权限", "en-US": "Front camera permission only" },
    author: { name: "LOOI" },
    permissions: ["camera.front"],
  };

  const scope = createEffectScope("test:front-cam", frontOnlyManifest.id);
  const vision = createVisionCapability(frontOnlyManifest, scope, broker)!;
  assert.ok(vision);

  // Accessing back camera without `camera.back` fails with ERR_PLUGIN_PERMISSION_DENIED
  await assert.rejects(
    () => vision.captureFrame({ facing: "back" }),
    (err: unknown) =>
      err instanceof PluginKernelError &&
      err.code === "ERR_PLUGIN_PERMISSION_DENIED" &&
      err.pluginId === "front-cam-plugin",
  );

  // Accessing front camera while OS permission is `undetermined` fails with ERR_CAMERA_PERMISSION_UNDETERMINED
  await assert.rejects(
    () => vision.captureFrame({ facing: "front" }),
    (err: unknown) =>
      err instanceof PluginKernelError && err.code === "ERR_CAMERA_PERMISSION_UNDETERMINED",
  );

  // Explicit permission grant unlocks capture and streaming
  const granted = await vision.requestPermission();
  assert.equal(granted, "granted");
  const snap = await vision.captureFrame({ facing: "front", maxDimension: 640 });
  assert.equal(snap.width, 640);
  assert.equal(nativePort.activeSessions.size, 0); // One-shot closes immediately

  let deliveredAfterResume = 0;
  const sub = await vision.subscribeFrames({ facing: "front", maxDimension: 640, maxFps: 10 }, () => {
    deliveredAfterResume += 1;
  });
  const initialPreviewId = sub.previewSessionId;
  assert.equal(nativePort.activeSessions.has(initialPreviewId), true);

  // App backgrounding immediately closes native camera sessions and blocks new captures
  broker.setForegroundActive(false);
  assert.equal(nativePort.activeSessions.size, 0);
  await assert.rejects(
    () => vision.captureFrame({ facing: "front" }),
    (err: unknown) =>
      err instanceof PluginKernelError && err.code === "ERR_DEVICE_CAMERA_BACKGROUNDED",
  );

  // Returning to foreground seamlessly re-opens hardware bound to the SAME previewSessionId
  deliveredAfterResume = 0;
  broker.setForegroundActive(true);
  await sleep(120);
  assert.equal(nativePort.activeSessions.has(initialPreviewId), true);
  assert.equal(nativePort.openCalls.at(-1)?.requestedSessionId, initialPreviewId);
  assert.ok(deliveredAfterResume >= 1);

  // Disposing EffectScope automatically closes the camera stream
  await scope.dispose();
  assert.equal(nativePort.activeSessions.size, 0);
  broker.close();
});

interface PersonSeatTrack {
  readonly seat: number;
  readonly gazeX: number;
  readonly gazeY: number;
  readonly headDeg: number;
  readonly turn: number;
}

interface PersonTrackerService {
  seats(): readonly PersonSeatTrack[];
  latestFrame(): DeviceCameraFrame | undefined;
  previewSessionId(): string | undefined;
}

test("Cross-plugin embodied DAG ecosystem (vision-person-tracker -> games-werewolf-referee) coordinates camera, face, servo, stage, and AI bus with clean cascading unwind", async (t) => {
  const db = new DatabaseSync(":memory:");
  const vault = createMemoryVault();
  const body = new BodyRuntime({ vault, dockGreetingLeadMs: 10, dockGreetingSettleMs: 10 });
  await body.configure({ mode: "simulation" });
  await body.connect({ deviceId: "sim-looi-dock-01", deviceName: "LOOI 桌面底座" });
  body.setSimulatedDock(true);
  await sleep(35);

  const faceController = new RobotFaceController();
  const faceHub = new FaceDriverHub();
  faceHub.attachController(faceController);

  const nativeCamera = new FakeNativeDeviceCamera();
  const visionBroker = new VisionBroker();
  visionBroker.attachNativePort(nativeCamera);
  t.after(() => {
    visionBroker.close();
    body.close();
    faceController.dispose();
    try { db.close(); } catch {}
  });

  const spokenAnnouncements: string[] = [];

  const personTrackerPlugin: PluginDefinition<{ framesSeen: number }> = {
    manifest: {
      id: "vision-person-tracker",
      version: "1.1.0",
      minHostApiVersion: 2,
      category: "vision_motion",
      icon: "eye",
      name: { "zh-CN": "视觉座位追踪", "en-US": "Person Seat Tracker" },
      summary: { "zh-CN": "实时识别玩家方位与座位分布", "en-US": "Real-time player seat tracking" },
      author: { name: "LOOI Vision Lab", verified: true },
      permissions: ["camera.front"],
      provides: [{ id: "vision.person-tracker", version: "1.1.0" }],
    },
    initialState: () => ({ framesSeen: 0 }),
    create(ctx) {
      let latest: DeviceCameraFrame | undefined;
      let previewId: string | undefined;
      const detectedSeats: PersonSeatTrack[] = [
        { seat: 1, gazeX: -0.65, gazeY: -0.05, headDeg: 42, turn: -40 },
        { seat: 3, gazeX: 0.58, gazeY: -0.08, headDeg: 68, turn: 35 },
      ];

      return {
        async start() {
          const stream = await ctx.vision!.subscribeFrames(
            { facing: "front", maxDimension: 640, maxFps: 8 },
            (frame) => {
              latest = frame;
              ctx.setState((prev) => ({ framesSeen: prev.framesSeen + 1 }));
            },
          );
          previewId = stream.previewSessionId;
          ctx.services.provide<PersonTrackerService>("vision.person-tracker", {
            seats: () => detectedSeats,
            latestFrame: () => latest,
            previewSessionId: () => previewId,
          });
        },
      };
    },
  };

  const werewolfRefereePlugin: PluginDefinition<{ phase: string; targetSeat: number | null }> = {
    manifest: {
      id: "games-werewolf-referee",
      version: "2.0.0",
      minHostApiVersion: 2,
      category: "games_social",
      icon: "sparkles",
      name: { "zh-CN": "狼人杀 AI 法官", "en-US": "Werewolf AI Referee" },
      summary: { "zh-CN": "具身巡场发牌与夜晚静默交互裁判", "en-US": "Embodied night-phase AI referee" },
      author: { name: "LOOI Games", verified: true },
      permissions: [
        "stage.ui",
        "face.register",
        "face.control",
        "body.motion",
        "ai.context",
        "ai.intercept",
        "ai.proactive",
      ],
      dependencies: [
        { service: "vision.person-tracker", versionRange: "^1.0.0", optional: false },
      ],
    },
    initialState: () => ({ phase: "idle", targetSeat: null }),
    create(ctx) {
      return {
        async start() {
          ctx.services.whenAvailable<PersonTrackerService>(
            "vision.person-tracker",
            async (tracker, depScope) => {
              const wolfFaceId = ctx.face!.registerExpression(
                "wolf_judge",
                {
                  tint: "amber",
                  ambientOpacity: 0.45,
                  eyes: [
                    { shape: "chevron", scale: 1.08 },
                    { shape: "chevron", scale: 1.08 },
                  ],
                  mouth: { kind: "smirk", scale: 0.95 },
                  glyphs: ["star_sparkle"],
                },
                { allowsBlink: false, scope: depScope },
              );

              const target = tracker.seats().find((s) => s.seat === 3)!;
              const faceLease = ctx.face!.acquireLease("foreground_stage", depScope);
              faceLease.setExpression(wolfFaceId);
              faceLease.setGaze({ x: target.gazeX, y: target.gazeY });

              const servo = await ctx.body!.acquireServo("foreground_stage", depScope);
              await servo.setHeadDegrees(target.headDeg);
              await servo.setDriveVector(0, target.turn);

              ctx.stage!.usePresentation(
                {
                  active: true,
                  facePosture: { kind: "floating_top", scale: 0.34, chrome: "pill" },
                  drawerDetent: "peek",
                  preventSleep: true,
                },
                depScope,
              );

              ctx.ai!.usePersonaOverlay(
                {
                  mode: "stage_persona",
                  instructions: "你是狼人杀上帝裁判，夜晚严禁泄露玩家底牌。",
                },
                depScope,
              );

              ctx.ai!.useTurnAssembler(async (draft, _signal, next) => {
                const frame = tracker.latestFrame();
                const seatSummary = tracker
                  .seats()
                  .map((s) => `Seat#${s.seat}(gaze=${s.gazeX})`)
                  .join(", ");
                return next({
                  ...draft,
                  contextBlocks: [
                    ...draft.contextBlocks,
                    {
                      pluginId: ctx.manifest.id,
                      priority: 90,
                      text: `Visible seats: ${seatSummary}`,
                    },
                  ],
                  ephemeralImages: frame
                    ? [
                        ...draft.ephemeralImages,
                        {
                          pluginId: ctx.manifest.id,
                          mimeType: "image/jpeg",
                          bytes: frame.jpeg,
                        },
                      ]
                    : draft.ephemeralImages,
                });
              }, depScope);

              ctx.ai!.interceptToolCall((call) => {
                if (call.toolName === "reveal_secret_role") {
                  return {
                    decision: "deny",
                    stage: "werewolf.night_guard",
                    code: "ERR_NIGHT_SILENCE_RULE",
                    reason: "Night phase forbids revealing secret roles aloud",
                  };
                }
                return undefined;
              }, depScope);

              ctx.setState({ phase: "wolf_night", targetSeat: target.seat });
              await ctx.ai!.speak({
                spokenText: "天黑请闭眼，狼人请睁眼并在屏幕点选目标。",
                delivery: "interrupt",
              });
            },
          );
        },
      };
    },
  };

  const host = new PluginHost(db, [werewolfRefereePlugin, personTrackerPlugin], {
    createFaceCapability: (manifest, scope) => faceHub.createCapability(manifest, scope),
    createBodyCapability: (manifest, scope) => createBodyCapability(manifest, scope, body),
    createVisionCapability: (manifest, scope) =>
      createVisionCapability(manifest, scope, visionBroker),
    aiBridge: {
      speak: async ({ spokenText }) => {
        spokenAnnouncements.push(spokenText);
        return { completed: true };
      },
    },
  });

  // Topological boot order starts provider (`vision-person-tracker`) before consumer (`games-werewolf-referee`)
  await host.startAll();
  await sleep(100);

  assert.equal(host.snapshot("vision-person-tracker").lifecycle, "active");
  assert.equal(host.snapshot("games-werewolf-referee").lifecycle, "active");
  assert.equal(host.snapshot("games-werewolf-referee").lastError, undefined);
  assert.deepEqual(host.snapshot("games-werewolf-referee").state, {
    phase: "wolf_night",
    targetSeat: 3,
  });

  // 1. Face + Gaze active at P2 foreground stage priority
  assert.equal(faceController.getState().expression, "plugin:games-werewolf-referee:wolf_judge");
  assert.deepEqual(faceController.getState().gaze, { x: 0.58, y: -0.08 });

  // 2. Body continuous servo aimed at Seat #3
  assert.equal(body.status().headDegrees, 68);
  assert.deepEqual(body.status().motion, { speed: 0, turn: 35 });

  // 3. Morphable First-Screen Stage active
  assert.deepEqual(host.stage.activePresentation()?.presentation, {
    active: true,
    facePosture: { kind: "floating_top", scale: 0.34, chrome: "pill" },
    drawerDetent: "peek",
    preventSleep: true,
  });

  // 4. Dual-Loop AI Bus injects live camera JPEG + enforces night tool guard + delivered speech
  assert.equal(spokenAnnouncements.length, 1);
  const assembled = await host.ai.assembleTurn({
    channel: "task",
    userText: "现在场上有哪些座位？",
  });
  assert.ok(assembled.contextBlocks.some((block) => block.text.includes("Seat#3")));
  assert.equal(assembled.ephemeralImages.length, 1);
  assert.equal(assembled.ephemeralImages[0]?.mimeType, "image/jpeg");
  assert.equal(assembled.ephemeralImages[0]?.bytes[0], 0xff);

  const guardVerdict = await host.ai.evaluateToolCall({
    channel: "voice",
    toolName: "reveal_secret_role",
    approvalMode: "ask",
    arguments: { seat: 3 },
  });
  assert.equal(guardVerdict?.decision, "deny");
  assert.equal(guardVerdict?.code, "ERR_NIGHT_SILENCE_RULE");

  // 5. Cascading Unwind: disabling `vision-person-tracker` suspends `games-werewolf-referee` -> `waiting_dependency`
  //    and deterministically unwinds face recipe/lease, body servo, morphable stage, AI hooks, and native camera!
  await host.setEnabled("vision-person-tracker", false);
  assert.equal(host.snapshot("vision-person-tracker").lifecycle, "stopped");
  assert.equal(host.snapshot("games-werewolf-referee").lifecycle, "waiting_dependency");
  assert.equal(faceController.getState().expression, "neutral");
  assert.deepEqual(faceController.getState().gaze, { x: 0, y: 0 });
  assert.deepEqual(body.status().motion, { speed: 0, turn: 0 });
  assert.equal(host.stage.activePresentation(), null);
  assert.equal(nativeCamera.activeSessions.size, 0);

  // 6. Auto-Wake Recovery: re-enabling `vision-person-tracker` automatically resumes `games-werewolf-referee`!
  await host.setEnabled("vision-person-tracker", true);
  await sleep(100);
  assert.equal(host.snapshot("vision-person-tracker").lifecycle, "active");
  assert.equal(host.snapshot("games-werewolf-referee").lifecycle, "active");
  assert.equal(faceController.getState().expression, "plugin:games-werewolf-referee:wolf_judge");
  assert.deepEqual(body.status().motion, { speed: 0, turn: 35 });
  assert.equal(host.stage.activePresentation()?.pluginId, "games-werewolf-referee");
  assert.equal(nativeCamera.activeSessions.size, 1);

  await host.close();
  visionBroker.close();
  body.close();
  faceController.dispose();
  db.close();
});

test(".nshpkg Ed25519 package loader verifies OpenSSL/RFC 8032 signatures, rejects tampering/untrusted keys/incompatible APIs, and installs/upgrades dynamically on PluginHost", async (t) => {
  const trustedKeyPair = generateKeyPairSync("ed25519");
  const attackerKeyPair = generateKeyPairSync("ed25519");

  const trustedPem = trustedKeyPair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const trustedDer = new Uint8Array(
    trustedKeyPair.publicKey.export({ type: "spki", format: "der" }),
  );
  const trustedRaw32 = trustedDer.subarray(12, 44);

  const baseManifest: PluginManifest = {
    id: "smart-follow-cat",
    version: "1.0.0",
    minHostApiVersion: 2,
    category: "persona_expression",
    icon: "heart",
    name: { "zh-CN": "粘人小猫伴随", "en-US": "Sticky Cat Companion" },
    summary: { "zh-CN": "识别主人持续面向伴随", "en-US": "Faces and follows user like a cat" },
    author: { name: "LOOI Community", verified: true },
    permissions: ["face.control"],
  };

  const validPkg = assembleSignedNshPackage({
    manifest: baseManifest,
    runtimeEntry: "export default function createCatPlugin() { return { start: async () => {} }; }",
    uiEntry: "export const SettingsView = () => null;",
    keyId: "looi-marketplace-root-2026",
    signPayload: (payload) => new Uint8Array(sign(null, payload, trustedKeyPair.privateKey)),
  });

  // 1. Valid package verifies across PEM, SPKI DER, and raw 32-byte public key formats
  for (const keyMaterial of [trustedPem, trustedDer, trustedRaw32]) {
    const verified = verifyNshPackage(JSON.stringify(validPkg), {
      trustedKeys: { "looi-marketplace-root-2026": keyMaterial },
    });
    assert.equal(verified.manifest.id, "smart-follow-cat");
    assert.equal(verified.manifest.version, "1.0.0");
  }

  // 2. 1-byte archive corruption (without recomputing sha256) fails with ERR_NSHPKG_INTEGRITY_MISMATCH
  const corruptedArchive = {
    ...validPkg,
    runtimeEntry: `${validPkg.runtimeEntry}\n// tampered`,
  };
  assert.throws(
    () =>
      verifyNshPackage(corruptedArchive, {
        trustedKeys: { "looi-marketplace-root-2026": trustedPem },
      }),
    (err: unknown) =>
      err instanceof PluginKernelError && err.code === "ERR_NSHPKG_INTEGRITY_MISMATCH",
  );

  // 3. Escalated permission in manifest WITH recomputed sha256 fails Ed25519 verification (ERR_NSHPKG_SIGNATURE_INVALID)
  const forgedManifest: PluginManifest = {
    ...baseManifest,
    permissions: ["face.control", "camera.front"],
  };
  const forgedPayload = serializeCanonicalNshPayload({
    manifest: forgedManifest,
    runtimeEntry: validPkg.runtimeEntry,
    uiEntry: validPkg.uiEntry,
  });
  const forgedPkg = {
    ...validPkg,
    manifest: forgedManifest,
    sha256: computePayloadSha256Hex(forgedPayload),
  };
  assert.throws(
    () =>
      verifyNshPackage(forgedPkg, {
        trustedKeys: { "looi-marketplace-root-2026": trustedPem },
      }),
    (err: unknown) =>
      err instanceof PluginKernelError && err.code === "ERR_NSHPKG_SIGNATURE_INVALID",
  );

  // 4. Signed by wrong private key or unknown keyId fails deterministically
  const wrongKeyPkg = assembleSignedNshPackage({
    manifest: baseManifest,
    runtimeEntry: validPkg.runtimeEntry,
    keyId: "looi-marketplace-root-2026",
    signPayload: (payload) => new Uint8Array(sign(null, payload, attackerKeyPair.privateKey)),
  });
  assert.throws(
    () =>
      verifyNshPackage(wrongKeyPkg, {
        trustedKeys: { "looi-marketplace-root-2026": trustedPem },
      }),
    (err: unknown) =>
      err instanceof PluginKernelError && err.code === "ERR_NSHPKG_SIGNATURE_INVALID",
  );
  assert.throws(
    () =>
      verifyNshPackage(validPkg, {
        trustedKeys: { "other-key-id": trustedPem },
      }),
    (err: unknown) =>
      err instanceof PluginKernelError && err.code === "ERR_NSHPKG_UNTRUSTED_KEY",
  );

  // 5. Future minHostApiVersion: 99 fails with ERR_NSHPKG_HOST_API_INCOMPATIBLE
  const futurePkg = assembleSignedNshPackage({
    manifest: { ...baseManifest, minHostApiVersion: 99 },
    runtimeEntry: validPkg.runtimeEntry,
    keyId: "looi-marketplace-root-2026",
    signPayload: (payload) => new Uint8Array(sign(null, payload, trustedKeyPair.privateKey)),
  });
  assert.throws(
    () =>
      verifyNshPackage(futurePkg, {
        trustedKeys: { "looi-marketplace-root-2026": trustedPem },
      }),
    (err: unknown) =>
      err instanceof PluginKernelError && err.code === "ERR_NSHPKG_HOST_API_INCOMPATIBLE",
  );

  // 6. Dynamic installation & in-place SemVer migration on a running PluginHost
  const db = new DatabaseSync(":memory:");
  const host = new PluginHost(db, []);

  const installedV1 = await host.installMarketplacePackage(
    new TextEncoder().encode(JSON.stringify(validPkg)),
    { trustedKeys: { "looi-marketplace-root-2026": trustedPem } },
    (verified) => ({
      manifest: verified.manifest,
      initialState: (storage) => ({
        affection: storage.get<number>("affection") ?? 50,
      }),
      create: (ctx) => ({
        async start() {
          ctx.storage.set("affection", 65);
          ctx.setState({ affection: 65 });
        },
      }),
    }),
  );

  assert.equal(installedV1.lifecycle, "active");
  assert.equal(installedV1.version, "1.0.0");
  assert.deepEqual(installedV1.state, { affection: 65 });

  const rowV1 = db
    .prepare("SELECT source, installed_version FROM plugin_installations WHERE id = ?")
    .get("smart-follow-cat") as { source: string; installed_version: string };
  assert.deepEqual({ ...rowV1 }, { source: "marketplace", installed_version: "1.0.0" });

  // Upgrade to v1.2.0 via signed .nshpkg with SemVer migrate()
  const manifestV12: PluginManifest = { ...baseManifest, version: "1.2.0" };
  const pkgV12 = assembleSignedNshPackage({
    manifest: manifestV12,
    runtimeEntry: validPkg.runtimeEntry,
    keyId: "looi-marketplace-root-2026",
    signPayload: (payload) => new Uint8Array(sign(null, payload, trustedKeyPair.privateKey)),
  });

  const migrations: string[] = [];
  const installedV12 = await host.installMarketplacePackage(
    pkgV12,
    { trustedKeys: { "looi-marketplace-root-2026": trustedPem } },
    (verified) => ({
      manifest: verified.manifest,
      initialState: (storage) => ({
        affection: storage.get<number>("affection") ?? 0,
        migratedSchema: storage.get<number>("schemaVersion") ?? 1,
      }),
      migrate(fromVersion, toVersion, storage) {
        migrations.push(`${fromVersion}->${toVersion}`);
        const prev = storage.get<number>("affection") ?? 0;
        storage.set("affection", prev + 10);
        storage.set("schemaVersion", 2);
      },
      create: () => ({
        async start() {},
      }),
    }),
  );

  assert.deepEqual(migrations, ["1.0.0->1.2.0"]);
  assert.equal(installedV12.lifecycle, "active");
  assert.equal(installedV12.version, "1.2.0");
  assert.deepEqual(installedV12.state, { affection: 75, migratedSchema: 2 });

  // Verify SQLite installation row preserves `source = "marketplace"` across SemVer migrate()
  const rowV12 = db
    .prepare("SELECT source, installed_version FROM plugin_installations WHERE id = ?")
    .get("smart-follow-cat") as { source: string; installed_version: string };
  assert.deepEqual({ ...rowV12 }, { source: "marketplace", installed_version: "1.2.0" });

  // 7. Prototype key lookup hardening (`keyId: "toString"` rejects with ERR_NSHPKG_UNTRUSTED_KEY, not TypeError)
  const protoKeyPkg = { ...validPkg, keyId: "toString" };
  assert.throws(
    () =>
      verifyNshPackage(protoKeyPkg, {
        trustedKeys: { "looi-marketplace-root-2026": trustedPem },
      }),
    (err: unknown) =>
      err instanceof PluginKernelError && err.code === "ERR_NSHPKG_UNTRUSTED_KEY",
  );

  // 8. Canonical payload serialization prevents NUL-byte field boundary collisions and distinguishes `uiEntry: undefined` vs `""`
  const nulPayloadA = serializeCanonicalNshPayload({
    manifest: baseManifest,
    runtimeEntry: "a\0b",
    uiEntry: "c",
  });
  const nulPayloadB = serializeCanonicalNshPayload({
    manifest: baseManifest,
    runtimeEntry: "a",
    uiEntry: "b\0c",
  });
  assert.notEqual(
    computePayloadSha256Hex(nulPayloadA),
    computePayloadSha256Hex(nulPayloadB),
  );

  const omittedUiPayload = serializeCanonicalNshPayload({
    manifest: baseManifest,
    runtimeEntry: validPkg.runtimeEntry,
  });
  const emptyUiPayload = serializeCanonicalNshPayload({
    manifest: baseManifest,
    runtimeEntry: validPkg.runtimeEntry,
    uiEntry: "",
  });
  assert.notEqual(
    computePayloadSha256Hex(omittedUiPayload),
    computePayloadSha256Hex(emptyUiPayload),
  );

  await host.close();
  db.close();
});

test("Native string-formatted camera errors preserve stage and ERR_* code across FFI, and rapid foreground bounces do not starve in-flight subscribers", async (t) => {
  // Part A: Native string-formatted `[stage=... code=ERR_...]` preserves exact stage & code on PluginKernelError
  const failingPort = new FakeNativeDeviceCamera();
  failingPort.openSession = async () => {
    // Simulate QuickJS FFI rejection where only Error.message carries structured stage + code
    throw new Error(
      "[stage=native.ios.open code=ERR_DEVICE_CAMERA_NO_DEVICE] Camera lens (front) unavailable",
    );
  };
  const errBroker = new VisionBroker();
  errBroker.attachNativePort(failingPort);
  t.after(() => {
    errBroker.close();
  });

  const camManifest: PluginManifest = {
    id: "lens-probe",
    version: "1.0.0",
    minHostApiVersion: 2,
    category: "vision_motion",
    icon: "camera",
    name: { "zh-CN": "镜头探测", "en-US": "Lens Probe" },
    summary: { "zh-CN": "测试底层错误透传", "en-US": "Tests FFI error fidelity" },
    author: { name: "LOOI" },
    permissions: ["camera.front"],
  };
  const errScope = createEffectScope("test:lens-probe", camManifest.id);
  const errVision = createVisionCapability(camManifest, errScope, errBroker)!;

  await assert.rejects(
    () => errVision.captureFrame({ facing: "front" }),
    (err: unknown) =>
      err instanceof PluginKernelError &&
      err.stage === "native.ios.open" &&
      err.code === "ERR_DEVICE_CAMERA_NO_DEVICE" &&
      err.message.includes("Camera lens (front) unavailable"),
  );
  await errScope.dispose();

  // Part B: Rapid `setForegroundActive(false)` -> `setForegroundActive(true)` while initial `openSession` is in flight
  let openAttempt = 0;
  let releaseFirstOpen!: (id: string) => void;
  const bouncePort = new FakeNativeDeviceCamera();
  const baseOpen = bouncePort.openSession.bind(bouncePort);
  bouncePort.openSession = async (facing, maxDimension, maxFps, sessionId) => {
    openAttempt += 1;
    if (openAttempt === 1) {
      return await new Promise<string>((resolve) => {
        releaseFirstOpen = resolve;
      });
    }
    return await baseOpen(facing, maxDimension, maxFps, sessionId);
  };

  const bounceBroker = new VisionBroker();
  bounceBroker.attachNativePort(bouncePort);
  t.after(() => {
    bounceBroker.close();
  });

  let framesDelivered = 0;
  const subPromise = bounceBroker.subscribeFrames(
    { facing: "front", maxDimension: 640, maxFps: 12 },
    () => {
      framesDelivered += 1;
    },
  );

  // Wait until attempt #1 is parked in flight, then bounce background -> foreground before #1 settles
  await sleep(15);
  assert.equal(openAttempt, 1);
  bounceBroker.setForegroundActive(false);
  bounceBroker.setForegroundActive(true);

  // Resolve stale attempt #1 with the requested session ID AFTER attempt #2 already resumed in the new epoch
  const requestedId = bouncePort.openCalls[0]?.requestedSessionId ?? "bounced-session-id";
  releaseFirstOpen(requestedId);

  const sub = await subPromise;
  await sleep(120);
  assert.equal(bouncePort.activeSessions.has(sub.previewSessionId), true);
  assert.ok(framesDelivered >= 1, `expected frames after rapid foreground bounce, got ${framesDelivered}`);

  sub.close();
  assert.equal(bouncePort.activeSessions.size, 0);
});

test("PluginHost.startStartupPlugins boots default startup plugins in topological order while keeping on_demand plugins lazy-ready", async () => {
  const db = new DatabaseSync(":memory:");
  const startedOrder: string[] = [];

  const startupProvider: PluginDefinition<{ ready: boolean }> = {
    manifest: {
      id: "embodied-greeting",
      version: "1.0.0",
      minHostApiVersion: 2,
      category: "persona_expression",
      icon: "smile",
      name: { "zh-CN": "开机问候", "en-US": "Startup Greeting" },
      summary: { "zh-CN": "随应用启动自动激活", "en-US": "Auto-starts on app boot" },
      author: { name: "LOOI" },
      permissions: ["face.control"],
      provides: [{ id: "persona.greeting", version: "1.0.0" }],
    },
    initialState: () => ({ ready: false }),
    create(ctx) {
      return {
        async start() {
          startedOrder.push(ctx.manifest.id);
          ctx.services.provide("persona.greeting", { ok: true });
          ctx.setState({ ready: true });
        },
      };
    },
  };

  const startupConsumer: PluginDefinition<{ linked: boolean }> = {
    manifest: {
      id: "stage-companion",
      version: "1.0.0",
      minHostApiVersion: 2,
      category: "games_social",
      icon: "sparkles",
      name: { "zh-CN": "舞台伴侣", "en-US": "Stage Companion" },
      summary: { "zh-CN": "依赖问候服务并在启动时就绪", "en-US": "Depends on greeting at boot" },
      author: { name: "LOOI" },
      permissions: ["stage.ui"],
      activation: "startup",
      dependencies: [{ service: "persona.greeting", versionRange: "^1.0.0" }],
    },
    initialState: () => ({ linked: false }),
    create(ctx) {
      return {
        async start() {
          startedOrder.push(ctx.manifest.id);
          ctx.setState({ linked: Boolean(ctx.services.get("persona.greeting")) });
        },
      };
    },
  };

  let lazyGuestBootCount = 0;
  const lazyToolPlugin: PluginDefinition<{ executions: number }> = {
    manifest: {
      id: "heavy-guest-runner",
      version: "1.0.0",
      minHostApiVersion: 2,
      category: "productivity",
      icon: "code",
      name: { "zh-CN": "按需沙箱工具", "en-US": "On-Demand Sandbox Tool" },
      summary: { "zh-CN": "仅在工具调用时按需唤醒", "en-US": "Starts lazily when invoked" },
      author: { name: "LOOI" },
      permissions: ["ai.tools"],
      activation: "on_demand",
    },
    initialState: () => ({ executions: 0 }),
    create(ctx) {
      ctx.ai!.useContribution({
        voiceTools: [
          {
            name: "run_lazy_guest",
            description: "Wakes the on-demand plugin on first tool call",
            parametersJsonSchema: { type: "object", properties: {} },
            async execute() {
              await ctx.ensureStarted();
              ctx.setState((prev) => ({ executions: prev.executions + 1 }));
              return { ok: true, guestBoots: lazyGuestBootCount };
            },
          },
        ],
      });
      return {
        async start() {
          lazyGuestBootCount += 1;
          startedOrder.push(ctx.manifest.id);
        },
      };
    },
  };

  const host = new PluginHost(db, [startupConsumer, lazyToolPlugin, startupProvider]);
  await host.startStartupPlugins();

  // Startup plugins booted in topological order; on_demand plugin remained mounted ("registered") with registered voice tool
  assert.deepEqual(startedOrder, ["embodied-greeting", "stage-companion"]);
  assert.equal(host.snapshot("embodied-greeting").lifecycle, "active");
  assert.equal(host.snapshot("stage-companion").lifecycle, "active");
  assert.deepEqual(host.snapshot("stage-companion").state, { linked: true });
  assert.equal(host.snapshot("heavy-guest-runner").lifecycle, "registered");
  assert.equal(lazyGuestBootCount, 0);
  assert.equal(host.ai.voiceTools().some((t) => t.name === "run_lazy_guest"), true);

  // First tool invocation wakes the on_demand plugin lazily via ctx.ensureStarted()
  const tool = host.ai.voiceTools().find((t) => t.name === "run_lazy_guest")!;
  await tool.execute({}, { sessionId: "s1", signal: new AbortController().signal });
  assert.equal(lazyGuestBootCount, 1);
  assert.equal(host.snapshot("heavy-guest-runner").lifecycle, "active");
  assert.deepEqual(host.snapshot("heavy-guest-runner").state, { executions: 1 });

  await host.close();
  db.close();
});
