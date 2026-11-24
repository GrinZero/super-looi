import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  FACE_EXPRESSION_IDS,
  RobotFaceController,
  isFaceExpression,
} from "@super-looi/runtime/face";
import { BodyRuntime, parseCliffPacket, type BodyServoPreemptReason } from "../runtime/body.js";
import { MotionBroker } from "../runtime/device-motion.js";
import { VisionBroker } from "../runtime/device-camera.js";
import type {
  NativeDeviceCameraPort,
  NativeDeviceMotionPort,
  NativeDeviceMotionSample,
} from "../runtime/plugins/shared-types.js";
import type { PluginDefinition, PluginManifest } from "../runtime/plugins/contracts.js";
import {
  FaceDriverHub,
  createBodyCapability,
  createMotionCapability,
  createVisionCapability,
  uint8ArrayToBase64,
} from "../runtime/plugins/embodied-drivers.js";
import { PluginKernelError } from "../runtime/plugins/errors.js";
import { PluginHost } from "../runtime/plugins/host.js";
import { createEffectScope } from "../runtime/plugins/effect-scope.js";
import { DualLoopAiBus } from "../runtime/plugins/ai-bus.js";
import { createOpenAiRealtimeProtocol } from "../runtime/voice/protocol.js";
import { createVoiceTools } from "../runtime/voice/tools/index.js";
import {
  VoiceRuntime,
  type VoiceAudioPort,
  type VoiceSocket,
} from "../runtime/voice.js";
import {
  FACE_EXPRESSION_RECIPES,
  clearDynamicFaceRecipe,
  registerDynamicFaceRecipe,
  resolveFaceExpressionRecipe,
} from "../ui/face-recipes.js";

function makeManifest(
  id: string,
  overrides: Partial<PluginManifest> = {},
): PluginManifest {
  return {
    id,
    version: "1.0.0",
    minHostApiVersion: 2,
    category: "vision_motion",
    icon: "eye",
    name: { "zh-CN": id, "en-US": id },
    summary: { "zh-CN": `${id} summary`, "en-US": `${id} summary` },
    author: { name: "Test" },
    permissions: [],
    ...overrides,
  };
}

function makeVault(initial: Record<string, string> = {}) {
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

test("FaceDriverHub & RobotFaceController compose P0-P5 priority layers, orthogonal gaze, and dynamic recipes", async () => {
  assert.equal(Object.keys(FACE_EXPRESSION_RECIPES).length, 72);
  assert.equal(FACE_EXPRESSION_IDS.length, 72);

  const hub = new FaceDriverHub();
  const db = new DatabaseSync(":memory:");

  let bgCtx!: Parameters<PluginDefinition["create"]>[0];
  let fgCtx!: Parameters<PluginDefinition["create"]>[0];

  const bgDef: PluginDefinition = {
    manifest: makeManifest("companion-cat", {
      permissions: ["face.control"],
    }),
    initialState: () => ({}),
    create: (ctx) => {
      bgCtx = ctx;
      return { start: async () => {} };
    },
  };

  const fgDef: PluginDefinition = {
    manifest: makeManifest("werewolf-judge", {
      category: "games_social",
      permissions: ["face.control", "face.register", "stage.ui"],
    }),
    initialState: () => ({}),
    create: (ctx) => {
      fgCtx = ctx;
      return { start: async () => {} };
    },
  };

  const host = new PluginHost(db, [bgDef, fgDef], {
    createFaceCapability: (manifest, scope) => hub.createCapability(manifest, scope),
  });

  await bgCtx.ensureStarted();
  await fgCtx.ensureStarted();

  // Background plugin without `stage.ui` cannot spoof `foreground_stage` lease or register expressions
  assert.throws(
    () => bgCtx.face!.acquireLease("foreground_stage"),
    (err: unknown) => err instanceof PluginKernelError && err.code === "ERR_PLUGIN_PERMISSION_DENIED",
  );
  assert.throws(
    () =>
      bgCtx.face!.registerExpression("hack", {
        eyes: [{ shape: "orb" }, { shape: "orb" }],
        mouth: { kind: "smile" },
      }),
    (err: unknown) => err instanceof PluginKernelError && err.code === "ERR_PLUGIN_PERMISSION_DENIED",
  );

  // Register dynamic expression & acquire background lease BEFORE UI controller attaches (replay test)
  const nightScope = fgCtx.forkScope("night-wolf");
  const wolfExprId = fgCtx.face!.registerExpression(
    "wolf_grin",
    {
      tint: "amber",
      eyes: [
        { shape: "chevron", scale: 1.08, brow: { angleDeg: 16 } },
        { shape: "chevron", scale: 1.08, brow: { angleDeg: -16 } },
      ],
      mouth: { kind: "smirk", scale: 1.15 },
    },
    { allowsBlink: false, allowsAudioResonance: true, scope: nightScope },
  );
  assert.equal(wolfExprId, "plugin:werewolf-judge:wolf_grin");

  const bgLease = bgCtx.face!.acquireLease("background_ambient");
  bgLease.setExpression("kitty_playful");
  bgLease.setGaze({ x: 0.68, y: -0.22 });

  // Attach UI RobotFaceController and recipe sync bridge
  const controller = new RobotFaceController();
  controller.attachRecipeSyncBridge((id, recipe) => {
    if (recipe) registerDynamicFaceRecipe(id, recipe);
    else clearDynamicFaceRecipe(id);
  });
  hub.attachController(controller);

  // Canonical table remains strictly 72 entries while dynamic lookup resolves the custom recipe
  assert.equal(Object.keys(FACE_EXPRESSION_RECIPES).length, 72);
  assert.equal(isFaceExpression(wolfExprId), true);
  assert.equal(resolveFaceExpressionRecipe(wolfExprId).mouth.kind, "smirk");

  // P4 background companion lease drives both expression and gaze when P0-P3 are empty
  assert.equal(controller.getState().expression, "kitty_playful");
  assert.deepEqual(controller.getState().gaze, { x: 0.68, y: -0.22 });

  // P3 conversational voice (`speaking`) overrides P4 expression, while P4 gaze tracking STILL composes!
  controller.setHostPresence({ conversational: "speaking", idle: "neutral" });
  assert.equal(controller.getState().expression, "speaking");
  assert.deepEqual(controller.getState().gaze, { x: 0.68, y: -0.22 });

  // P2 foreground stage plugin overrides P3 conversational expression and gaze
  const fgLease = fgCtx.face!.acquireLease("foreground_stage", nightScope);
  fgLease.setExpression(wolfExprId);
  fgLease.setGaze({ x: -0.4, y: 0.3 });
  assert.equal(controller.getState().expression, wolfExprId);
  assert.deepEqual(controller.getState().gaze, { x: -0.4, y: 0.3 });

  // P1 dock transient overrides P2 expression, while P2 gaze still composes
  controller.setHostPresence({ dockTransient: "dock_snap" });
  assert.equal(controller.getState().expression, "dock_snap");
  assert.deepEqual(controller.getState().gaze, { x: -0.4, y: 0.3 });

  // P0 system critical (`sleeping`, closedRest: true) overrides everything and zeroes gaze
  controller.setHostPresence({ systemCritical: "sleeping" });
  assert.equal(controller.getState().expression, "sleeping");
  assert.deepEqual(controller.getState().gaze, { x: 0, y: 0 });

  // Clear P0 & P1 -> back to P2 `wolf_grin`
  controller.setHostPresence({ systemCritical: null, dockTransient: null });
  assert.equal(controller.getState().expression, wolfExprId);

  // Disposing forked `nightScope` unwinds P2 lease & dynamic recipe -> falls back to P3 `speaking` + P4 `gaze`!
  await nightScope.dispose();
  assert.equal(isFaceExpression(wolfExprId), false);
  assert.equal(resolveFaceExpressionRecipe(wolfExprId), FACE_EXPRESSION_RECIPES.neutral);
  assert.equal(controller.getState().expression, "speaking");
  assert.deepEqual(controller.getState().gaze, { x: 0.68, y: -0.22 });

  await host.close();
  controller.dispose();
});

test("BodyRuntime.acquireServo enforces continuous motor leases and all 5 preemption reasons", async () => {
  const vault = makeVault({
    body: JSON.stringify({
      mode: "simulation",
      savedDeviceId: "sim-looi-dock-01",
      savedDeviceName: "LOOI 桌面底座",
      autoConnect: true,
    }),
  });
  const body = new BodyRuntime({ vault, dockGreetingLeadMs: 10, dockGreetingSettleMs: 10 });
  await body.connect({ deviceId: "sim-looi-dock-01", deviceName: "LOOI 桌面底座" });
  body.setSimulatedDock(true);

  const db = new DatabaseSync(":memory:");
  let bgCtx!: Parameters<PluginDefinition["create"]>[0];
  let fgCtx!: Parameters<PluginDefinition["create"]>[0];

  const host = new PluginHost(
    db,
    [
      {
        manifest: makeManifest("tracker-bg", { permissions: ["body.motion"] }),
        initialState: () => ({}),
        create: (ctx) => {
          bgCtx = ctx;
          return { start: async () => {} };
        },
      },
      {
        manifest: makeManifest("game-fg", { permissions: ["body.motion", "stage.ui"] }),
        initialState: () => ({}),
        create: (ctx) => {
          fgCtx = ctx;
          return { start: async () => {} };
        },
      },
    ],
    {
      createBodyCapability: (manifest, scope) => createBodyCapability(manifest, scope, body),
    },
  );

  await bgCtx.ensureStarted();
  await fgCtx.ensureStarted();

  // 1. Background companion acquires servo and drives continuously; preempted by `higher_plugin`
  const preempted1: BodyServoPreemptReason[] = [];
  const bgServo1 = await bgCtx.body!.acquireServo("background_companion");
  bgServo1.onPreempted((r) => preempted1.push(r));
  await bgServo1.setDriveVector(64, -24);
  assert.deepEqual(body.status().motion, { speed: 64, turn: -24 });
  await bgServo1.setHeadDegrees(68);
  assert.equal(body.status().headDegrees, 68);

  const preempted2: BodyServoPreemptReason[] = [];
  const fgServo = await fgCtx.body!.acquireServo("foreground_stage");
  fgServo.onPreempted((r) => preempted2.push(r));
  assert.deepEqual(preempted1, ["higher_plugin"]);
  assert.deepEqual(body.status().motion, { speed: 0, turn: 0 });

  // Background companion cannot steal servo while foreground stage plugin holds it
  await assert.rejects(
    () => bgCtx.body!.acquireServo("background_companion"),
    (err: unknown) => err instanceof PluginKernelError && err.code === "ERR_BODY_SERVO_BUSY_FOREGROUND",
  );

  // 2. User panel joystick (`setDriveVector`) preempts foreground servo with `user_panel`
  await fgServo.setDriveVector(50, 15);
  assert.deepEqual(body.status().motion, { speed: 50, turn: 15 });
  await body.setDriveVector(90, 0);
  assert.deepEqual(preempted2, ["user_panel"]);
  assert.deepEqual(body.status().motion, { speed: 90, turn: 0 });
  await body.setDriveVector(0, 0);

  // 3. Voice command (`voice_realtime`) preempts active servo with `voice_command`
  const preempted3: BodyServoPreemptReason[] = [];
  const servo3 = await bgCtx.body!.acquireServo("background_companion");
  servo3.onPreempted((r) => preempted3.push(r));
  await servo3.setDriveVector(40, 0);
  const voiceReceipt = await body.control({ action: "head_up" }, "voice_realtime");
  assert.equal(voiceReceipt.status, "verified");
  assert.deepEqual(preempted3, ["voice_command"]);

  // 4. Emergency `stop()` preempts active servo with `user_stop`
  const preempted4: BodyServoPreemptReason[] = [];
  const servo4 = await bgCtx.body!.acquireServo("background_companion");
  servo4.onPreempted((r) => preempted4.push(r));
  await servo4.setDriveVector(45, 10);
  await body.stop("user_stop");
  assert.deepEqual(preempted4, ["user_stop"]);
  assert.deepEqual(body.status().motion, { speed: 0, turn: 0 });

  // 5. Undocking (`setSimulatedDock(false)`) preempts active servo with `undocked`
  const preempted5: BodyServoPreemptReason[] = [];
  const servo5 = await bgCtx.body!.acquireServo("background_companion");
  servo5.onPreempted((r) => preempted5.push(r));
  await servo5.setDriveVector(35, -10);
  body.setSimulatedDock(false);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(preempted5, ["undocked"]);

  // Cannot acquire servo while undocked
  await assert.rejects(
    () => bgCtx.body!.acquireServo("background_companion"),
    (err: unknown) => err instanceof PluginKernelError && err.code === "ERR_BODY_NOT_DOCKED",
  );

  // Re-dock and verify forked scope auto-releases servo on dispose
  body.setSimulatedDock(true);
  const subScope = bgCtx.forkScope("chase-step");
  const scopedServo = await bgCtx.body!.acquireServo("background_companion", subScope);
  await scopedServo.setDriveVector(55, 0);
  assert.deepEqual(body.status().motion, { speed: 55, turn: 0 });
  await subScope.dispose();
  assert.deepEqual(body.status().motion, { speed: 0, turn: 0 });

  await host.close();
  body.close();
});

test("DualLoopAiBus multimodal waterfall encodes ephemeral JPEG bytes cleanly and isolates slow assemblers", async () => {
  for (const sample of [
    new Uint8Array([]),
    new Uint8Array([0xff]),
    new Uint8Array([0xff, 0xd8]),
    new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02, 0x03, 0xff, 0xd9]),
  ]) {
    assert.equal(uint8ArrayToBase64(sample), Buffer.from(sample).toString("base64"));
  }

  const db = new DatabaseSync(":memory:");
  let visionCtx!: Parameters<PluginDefinition["create"]>[0];
  let slowCtx!: Parameters<PluginDefinition["create"]>[0];

  const host = new PluginHost(db, [
    {
      manifest: makeManifest("vision-frame", { permissions: ["ai.context"] }),
      initialState: () => ({}),
      create: (ctx) => {
        visionCtx = ctx;
        return {
          start: async () => {
            ctx.ai!.useTurnAssembler(async (draft, _signal, next) => {
              const updated = {
                ...draft,
                contextBlocks: [
                  ...draft.contextBlocks,
                  { pluginId: "vision-frame", priority: 90, text: "[Vision] Person centered at x=0.05" },
                ],
                ephemeralImages: [
                  ...draft.ephemeralImages,
                  {
                    pluginId: "vision-frame",
                    mimeType: "image/jpeg" as const,
                    bytes: new Uint8Array([0xff, 0xd8, 0x42, 0xff, 0xd9]),
                  },
                ],
              };
              return next(updated);
            });
          },
        };
      },
    },
    {
      manifest: makeManifest("slow-enricher", { permissions: ["ai.context"] }),
      initialState: () => ({}),
      create: (ctx) => {
        slowCtx = ctx;
        return {
          start: async () => {
            ctx.ai!.useTurnAssembler(async (draft, signal, next) => {
              await new Promise<void>((resolve) => {
                const t = setTimeout(resolve, 140);
                signal.addEventListener("abort", () => {
                  clearTimeout(t);
                  resolve();
                });
              });
              return next({
                ...draft,
                contextBlocks: [...draft.contextBlocks, { pluginId: "slow-enricher", priority: 50, text: "LATE" }],
              });
            });
          },
        };
      },
    },
  ]);

  await visionCtx.ensureStarted();
  await slowCtx.ensureStarted();

  // Voice channel (80ms budget) skips slow-enricher while preserving fast vision-frame
  const skippedVoice: string[] = [];
  const voiceDraft = await host.ai.assembleTurn({
    channel: "voice",
    userText: "Look at me",
    onAssemblerSkipped: (info) => skippedVoice.push(info.pluginId),
  });
  assert.deepEqual(skippedVoice, ["slow-enricher"]);
  assert.ok(voiceDraft.contextBlocks.some((b) => b.pluginId === "vision-frame"));
  assert.ok(!voiceDraft.contextBlocks.some((b) => b.pluginId === "slow-enricher"));

  // Task channel (1500ms budget) allows both assemblers and preserves ephemeral JPEG bytes
  const taskDraft = await host.ai.assembleTurn({
    channel: "task",
    userText: "Analyze desk scene",
  });
  assert.ok(taskDraft.contextBlocks.some((b) => b.pluginId === "vision-frame"));
  assert.ok(taskDraft.contextBlocks.some((b) => b.pluginId === "slow-enricher"));
  assert.equal(taskDraft.ephemeralImages.length, 1);
  assert.equal(
    uint8ArrayToBase64(taskDraft.ephemeralImages[0]!.bytes),
    Buffer.from([0xff, 0xd8, 0x42, 0xff, 0xd9]).toString("base64"),
  );

  await host.close();
});

test("VoiceRuntime & createVoiceTools enforce Fail-Closed tool guards, plugin context isolation, user-turn bail, and playback-synced speak()", async () => {
  // 1. Voice tool contribution + Fail-Closed guard verification
  const tools = createVoiceTools(
    {
      sessionId: "voice_sess_1",
      controlBody: async () => ({ status: "verified" }),
      pluginTools: [
        {
          name: "werewolf_mark_target",
          description: "Record night target seat",
          parametersJsonSchema: {
            type: "object",
            properties: {
              seat: { type: "string", description: "Seat number" },
            },
            required: ["seat"],
          },
          execute: async (params) => ({ markedSeat: params.seat }),
        },
      ],
      evaluateToolCall: async ({ toolName, arguments: args }) => {
        if (toolName === "control_looi_body") {
          return {
            decision: "deny",
            stage: "werewolf:night_freeze",
            code: "ERR_NIGHT_FREEZE",
            reason: "Robot movement is locked while eyes are closed",
          };
        }
        if (toolName === "werewolf_mark_target" && args.seat === "ask_seat") {
          return {
            decision: "ask",
            promptPayload: { reason: "Confirm seat" },
          };
        }
        return undefined;
      },
    },
    "SECRET_VOICE_KEY_123",
  );

  const bodyTool = tools.find((t) => t.name === "control_looi_body")!;
  const deniedOut = await bodyTool.invoke({} as any, JSON.stringify({ action: "forward" }));
  const deniedParsed = JSON.parse(String(deniedOut));
  assert.equal(deniedParsed.error.stage, "werewolf:night_freeze");
  assert.equal(deniedParsed.error.code, "ERR_NIGHT_FREEZE");

  const wolfTool = tools.find((t) => t.name === "werewolf_mark_target")!;
  const askOut = await wolfTool.invoke({} as any, JSON.stringify({ seat: "ask_seat" }));
  const askParsed = JSON.parse(String(askOut));
  assert.equal(askParsed.error.code, "ERR_VOICE_TOOL_APPROVAL_REQUIRED");

  const okOut = await wolfTool.invoke({} as any, JSON.stringify({ seat: "3" }));
  assert.deepEqual(okOut, { markedSeat: "3" });

  // 2. Live VoiceRuntime: separate pluginContextNote, user_speech_stopped bail/waterfall, and speak() drain completion
  let audioState = "idle";
  let queuedPlaybackMs = 0;
  const audio: VoiceAudioPort = {
    beginWake: () => 0,
    startWake: async () => true,
    requestPermission: () => "granted",
    start: () => {
      audioState = "running";
    },
    setCaptureMode: () => {
      audioState = "running";
    },
    playReadyCue: () => {},
    stop: () => {
      audioState = "idle";
      queuedPlaybackMs = 0;
    },
    enqueue: () => {
      queuedPlaybackMs = 60;
    },
    clearPlayback: () => {
      queuedPlaybackMs = 0;
    },
    setMuted: () => {},
    drainCapture: () => [],
    status: () => ({
      state: audioState,
      permission: "granted",
      error: "",
      queuedPlaybackMs,
      captureMode: "conversation",
      wakeWord: "",
      kwsReady: true,
    }),
  };

  const writes: Record<string, any>[] = [];
  let reader: ((value: string | null) => void) | undefined;
  const incoming: string[] = [];
  let socketClosed = false;
  const socket: VoiceSocket = {
    read: () =>
      incoming.length
        ? Promise.resolve(incoming.shift()!)
        : socketClosed
          ? Promise.resolve(null)
          : new Promise((resolve) => {
              reader = resolve;
            }),
    write: async (raw) => {
      if (typeof raw === "string") {
        const msg = JSON.parse(raw);
        writes.push(msg);
        if (msg.type === "session.update" && writes.filter((w) => w.type === "session.update").length === 1) {
          pushServerEvent({ type: "session.updated", session: {} });
        }
      }
    },
    close: async () => {
      socketClosed = true;
      reader?.(null);
      reader = undefined;
    },
  };
  function pushServerEvent(payload: Record<string, unknown>) {
    const raw = JSON.stringify(payload);
    if (reader) {
      const r = reader;
      reader = undefined;
      r(raw);
    } else {
      incoming.push(raw);
    }
  }

  let bailNextTurn = false;
  const vault = makeVault();
  const voice = new VoiceRuntime({
    vault,
    protocol: createOpenAiRealtimeProtocol({ model: "gpt-realtime" }),
    audio,
    connect: async () => socket,
    onState: () => {},
    initialPluginContext: () => "[Plugin:werewolf Persona]\nYou are the Werewolf God Judge.",
    evaluateVoiceUserTurn: async (text) => {
      if (bailNextTurn) {
        bailNextTurn = false;
        return {
          decision: "block",
          reason: "Night silence rule",
          spokenReply: "天黑阶段请保持安静。",
        };
      }
      if (text.includes("illegal")) {
        return { decision: "handled", spokenReply: "已记录手势。" };
      }
      return undefined;
    },
    assembleVoiceTurn: async (text) => ({
      channel: "voice",
      userText: text,
      contextBlocks: [{ pluginId: "werewolf", priority: 100, text: `[Waterfall] Heard: ${text}` }],
      ephemeralImages: [],
    }),
  });

  voice.selectProvider("openai");
  voice.configure("sk-test-openai-voice-123456");
  voice.setContextNote("[TaskReceipt] Timer ready");

  await voice.start();
  await new Promise((r) => setTimeout(r, 40));

  // Verify initial session.update preserves BOTH plugin persona AND task receipt context!
  const firstUpdate = writes.find((w) => w.type === "session.update");
  assert.ok(firstUpdate);
  const initialInstructions = String(firstUpdate.session?.instructions ?? "");
  assert.ok(initialInstructions.includes("[Plugin:werewolf Persona]"));
  assert.ok(initialInstructions.includes("[TaskReceipt] Timer ready"));

  // Updating task context note does NOT erase plugin persona!
  voice.setContextNote("[TaskReceipt] Updated receipt", true);
  await new Promise((r) => setTimeout(r, 30));
  const latestUpdate = [...writes].reverse().find((w) => w.type === "session.update");
  assert.ok(String(latestUpdate?.session?.instructions ?? "").includes("[Plugin:werewolf Persona]"));
  assert.ok(String(latestUpdate?.session?.instructions ?? "").includes("[TaskReceipt] Updated receipt"));

  // Verify `speak()` waits for hardware playback drain before resolving `{ completed: true }`
  let speakResolved = false;
  const speakPromise = voice.speak({ spokenText: "天黑请闭眼", delivery: "when_idle" }).then((res) => {
    speakResolved = true;
    return res;
  });

  await new Promise((r) => setTimeout(r, 30));
  assert.equal(speakResolved, false, "speak() must not resolve before audio finishes draining");

  const pcmChunk = Buffer.alloc(960, 1).toString("base64");
  pushServerEvent({ type: "response.created", response: { id: "resp_speak_1" } });
  pushServerEvent({
    type: "response.output_audio.delta",
    response_id: "resp_speak_1",
    item_id: "item_1",
    content_index: 0,
    delta: pcmChunk,
  });
  pushServerEvent({
    type: "response.output_audio.done",
    response_id: "resp_speak_1",
    item_id: "item_1",
    content_index: 0,
  });
  pushServerEvent({ type: "response.done", response: { id: "resp_speak_1" } });

  await new Promise((r) => setTimeout(r, 45));
  assert.equal(speakResolved, false, "speak() must wait while hardware queuedPlaybackMs > 0");

  // Hardware drains queuedPlaybackMs -> 0
  queuedPlaybackMs = 0;
  const speakResult = await speakPromise;
  assert.deepEqual(speakResult, { completed: true });

  // Verify `speak()` interrupted mid-playback resolves `{ completed: false, interruptedReason: "manual" }`
  const interruptedSpeakPromise = voice.speak({
    spokenText: "女巫请睁眼，今晚死的是……",
    delivery: "when_idle",
  });
  await new Promise((r) => setTimeout(r, 30));
  pushServerEvent({ type: "response.created", response: { id: "resp_speak_2" } });
  pushServerEvent({
    type: "response.output_audio.delta",
    response_id: "resp_speak_2",
    item_id: "item_2",
    content_index: 0,
    delta: pcmChunk,
  });
  await new Promise((r) => setTimeout(r, 30));
  voice.interrupt("manual");
  const interruptedResult = await interruptedSpeakPromise;
  assert.equal(interruptedResult.completed, false);
  assert.equal(interruptedResult.interruptedReason, "manual");

  // Acknowledge cancel so session returns cleanly to waiting_user
  pushServerEvent({ type: "response.done", response: { id: "resp_speak_2", status: "cancelled" } });
  await new Promise((r) => setTimeout(r, 30));

  // Verify `user_speech_stopped` waterfall injects per-turn context within budget
  pushServerEvent({ type: "input_audio_buffer.speech_started" });
  pushServerEvent({
    type: "conversation.item.input_audio_transcription.completed",
    transcript: "我是预言家",
  });
  pushServerEvent({ type: "input_audio_buffer.speech_stopped" });
  await new Promise((r) => setTimeout(r, 40));
  const waterfallUpdate = [...writes].reverse().find((w) => w.type === "session.update");
  assert.ok(String(waterfallUpdate?.session?.instructions ?? "").includes("[Waterfall] Heard: 我是预言家"));

  // Verify `user_speech_stopped` bail guard short-circuits and triggers spokenReply
  bailNextTurn = true;
  const writesBeforeBail = writes.length;
  pushServerEvent({ type: "input_audio_buffer.speech_started" });
  pushServerEvent({
    type: "conversation.item.input_audio_transcription.completed",
    transcript: "偷看一眼",
  });
  pushServerEvent({ type: "input_audio_buffer.speech_stopped" });
  await new Promise((r) => setTimeout(r, 40));
  const newWrites = writes.slice(writesBeforeBail);
  assert.ok(
    newWrites.some(
      (w) =>
        w.type === "conversation.item.create" &&
        JSON.stringify(w).includes("天黑阶段请保持安静。"),
    ),
    "Bail guard spokenReply must be dispatched proactively",
  );

  // Verify repeated identical utterances ("偷看一眼", "偷看一眼") still evaluate on subsequent turns
  pushServerEvent({ type: "response.done", response: { id: "resp_guard_ack", status: "completed" } });
  await new Promise((r) => setTimeout(r, 30));
  bailNextTurn = true;
  const writesBeforeRepeat = writes.length;
  pushServerEvent({ type: "input_audio_buffer.speech_started" });
  pushServerEvent({ type: "input_audio_buffer.speech_stopped" });
  // Physical VAD stop alone must NOT prematurely trigger bail on stale transcript before final ASR
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(
    writes.slice(writesBeforeRepeat).some((w) => w.type === "conversation.item.create"),
    false,
    "Physical VAD speech_stopped before transcriptionFinal must not evaluate stale utterance",
  );
  pushServerEvent({
    type: "conversation.item.input_audio_transcription.completed",
    transcript: "偷看一眼",
  });
  await new Promise((r) => setTimeout(r, 40));
  assert.ok(
    writes
      .slice(writesBeforeRepeat)
      .some(
        (w) =>
          w.type === "conversation.item.create" &&
          JSON.stringify(w).includes("天黑阶段请保持安静。"),
      ),
    "Repeated identical utterance on a subsequent turn must still evaluate",
  );

  voice.close();
});

test("Review regressions: recipe validation, companion servo mutex, stopNonPluginMotion, and tool deactivation", async () => {
  const controller = new RobotFaceController();
  const faceHub = new FaceDriverHub();
  faceHub.attachController(controller);

  const scope = createEffectScope("plugin:test.reg");
  const faceCap = faceHub.createCapability(
    makeManifest("test.reg", {
      permissions: ["face.control", "face.register", "stage.ui"],
    }),
    scope,
  );

  // 1. Reject NaN / invalid glyphs in dynamic recipe, while supporting dotted plugin IDs (e.g. test.reg)
  assert.throws(
    () =>
      faceCap.registerExpression("nan_eye", {
        eyes: [
          { scale: Number.NaN, eyelid: {} },
          { scale: 1, eyelid: {} },
        ],
        mouth: { kind: "smile" },
      }),
    (err: unknown) => (err as { code?: string }).code === "ERR_INVALID_FACE_RECIPE",
  );
  assert.throws(
    () =>
      faceCap.registerExpression("bad_glyph", {
        eyes: [
          { scale: 1, eyelid: {} },
          { scale: 1, eyelid: {} },
        ],
        mouth: { kind: "smile" },
        glyphs: ["not_a_real_glyph" as never],
      }),
    (err: unknown) => (err as { code?: string }).code === "ERR_INVALID_FACE_RECIPE",
  );
  const validDottedId = faceCap.registerExpression("valid_scan", {
    eyes: [{ scale: 1.05 }, { scale: 1.05 }],
    mouth: { kind: "flat" },
    glyphs: ["scan_trails"],
  });
  assert.equal(validDottedId, "plugin:test.reg:valid_scan");

  // 2. Reject unknown expression with structured ERR_FACE_UNKNOWN_EXPRESSION
  const lease = faceCap.acquireLease("foreground_stage");
  assert.throws(
    () => lease.setExpression("plugin:ghost:missing"),
    (err: unknown) => (err as { code?: string }).code === "ERR_FACE_UNKNOWN_EXPRESSION",
  );
  await scope.dispose();
  controller.dispose();

  // 3. Same-tier background_companion cannot preempt another background_companion + stopNonPluginMotion preserves plugin servo
  const vaultMap = new Map<string, string>();
  const body = new BodyRuntime({
    vault: {
      get: (k) => vaultMap.get(k) ?? "",
      set: (k, v) => { vaultMap.set(k, v); },
      remove: (k) => { vaultMap.delete(k); },
    },
  });
  await body.configure({ mode: "simulation" });
  body.setForegroundActive(true);
  await body.connect();

  const scopeA = createEffectScope("plugin:comp.a");
  const scopeB = createEffectScope("plugin:comp.b");
  const capA = createBodyCapability(
    makeManifest("comp.a", { permissions: ["body.motion"] }),
    scopeA,
    body,
  );
  const capB = createBodyCapability(
    makeManifest("comp.b", { permissions: ["body.motion"] }),
    scopeB,
    body,
  );

  let preemptedA: string | undefined;
  const servoA = await capA.acquireServo("background_companion");
  servoA.onPreempted((r) => {
    preemptedA = r;
  });
  await assert.rejects(
    () => capB.acquireServo("background_companion"),
    (err: unknown) => (err as { code?: string }).code === "ERR_BODY_SERVO_BUSY_COMPANION",
  );

  // Voice session teardown calls stopNonPluginMotion() -> must NOT revoke plugin servoA!
  await body.stopNonPluginMotion();
  assert.equal(preemptedA, undefined);
  await servoA.setDriveVector(42, -12);
  assert.deepEqual(body.status().motion, { speed: 42, turn: -12 });

  await scopeA.dispose();
  await scopeB.dispose();
  body.close();

  // 4. Disposing a plugin contribution scope mid-session invalidates captured voiceTool execute() & voice waterfall omits duplicate ambient persona
  const bus = new DualLoopAiBus(() => null);
  const aiScope = createEffectScope("plugin:dyn.tool");
  const aiCap = bus.createScopedCapability(
    makeManifest("dyn.tool", {
      permissions: ["ai.tools", "ai.context"],
    }),
    aiScope,
  )!;
  aiCap.usePersonaOverlay({
    mode: "append_rules",
    instructions: "Keep replies concise.",
  });
  aiCap.useContribution({
    voiceTools: [
      {
        name: "ping_stage",
        description: "Ping stage",
        parametersJsonSchema: { type: "object", properties: {} },
        execute: async () => "pong",
      },
    ],
  });

  const voiceDraft = await bus.assembleTurn({ channel: "voice", userText: "hello" });
  assert.equal(
    voiceDraft.contextBlocks.some((b) => b.text.includes("Keep replies concise.")),
    false,
    "Voice assembleTurn must not duplicate ambient persona already present in pluginContextNote",
  );
  const taskDraft = await bus.assembleTurn({ channel: "task", userText: "hello" });
  assert.equal(
    taskDraft.contextBlocks.some((b) => b.text.includes("Keep replies concise.")),
    true,
    "Task assembleTurn must still include ambient persona",
  );

  const capturedTool = bus.voiceTools()[0]!;
  const toolCtx = { sessionId: "s1", signal: new AbortController().signal };
  assert.equal(await capturedTool.execute({}, toolCtx), "pong");
  await aiScope.dispose();
  await assert.rejects(
    () => capturedTool.execute({}, toolCtx),
    (err: unknown) => (err as { code?: string }).code === "ERR_PLUGIN_TOOL_INACTIVE",
  );
});

test("MotionBroker & createMotionCapability gate sensor.motion permission, ref-count IMU hardware, resetHeading, and suspend cleanly on background", async () => {
  let stopCount = 0;
  let startCount = 0;
  let foreground = true;
  let nextSeq = 1;
  let anchorDeg = 0;
  let activeSid: string | null = null;

  const makeSample = (seq: number, headingDeg: number): NativeDeviceMotionSample => ({
    seq,
    headingDeg,
    deltaDeg: seq === 1 ? 0 : 12.5,
    yawDeg: headingDeg,
    pitchDeg: 55,
    rollDeg: 0,
    qw: 1,
    qx: 0,
    qy: 0,
    qz: 0,
    monotonicMs: 1000 + seq * 20,
    sensorKind: "game_rotation_vector",
    accuracy: 3,
  });

  const port: NativeDeviceMotionPort = {
    availability: () => "available",
    startSession: async (_rateHz, sessionId) => {
      startCount += 1;
      activeSid = sessionId;
      return sessionId;
    },
    status: () => (activeSid ? "streaming" : "stopped"),
    latestSample: (sessionId) => (activeSid === sessionId ? makeSample(nextSeq, anchorDeg) : null),
    readNextSample: async (sessionId, afterSeq) => {
      await new Promise((r) => setTimeout(r, 10));
      if (!foreground) {
        throw new Error("[stage=device_motion.read code=ERR_DEVICE_MOTION_BACKGROUNDED] paused");
      }
      if (activeSid !== sessionId) {
        throw new Error("[stage=device_motion.read code=ERR_DEVICE_MOTION_CLOSED] stopped");
      }
      nextSeq = Math.max(nextSeq + 1, afterSeq + 1);
      anchorDeg += 12.5;
      return makeSample(nextSeq, anchorDeg);
    },
    resetHeading: (_sessionId, headingDeg) => {
      anchorDeg = headingDeg;
      return makeSample(nextSeq, anchorDeg);
    },
    stopSession: (sessionId) => {
      if (activeSid === sessionId) {
        activeSid = null;
        stopCount += 1;
      }
    },
    setForeground: (active) => {
      foreground = active;
      if (!active && activeSid) {
        activeSid = null;
        stopCount += 1;
      }
    },
    stopAll: () => {
      if (activeSid) {
        activeSid = null;
        stopCount += 1;
      }
    },
  };

  const broker = new MotionBroker();
  broker.attachNativePort(port);

  const deniedScope = createEffectScope("plugin:no.motion");
  assert.equal(
    createMotionCapability(makeManifest("no.motion", { permissions: ["camera.front"] }), deniedScope, broker),
    undefined,
  );
  await deniedScope.dispose();

  const scope = createEffectScope("plugin:with.motion");
  const cap = createMotionCapability(
    makeManifest("with.motion", { permissions: ["sensor.motion"] }),
    scope,
    broker,
  )!;
  assert.equal(cap.availability(), "available");
  assert.equal(startCount, 0);

  const sub1Samples: NativeDeviceMotionSample[] = [];
  const sub2Samples: NativeDeviceMotionSample[] = [];
  const sub1 = await cap.subscribeHeading({ rateHz: 50 }, (s) => {
    sub1Samples.push(s);
  });
  const sub2 = await cap.subscribeHeading({ rateHz: 50 }, (s) => {
    sub2Samples.push(s);
  });
  assert.equal(startCount, 1);

  await new Promise((r) => setTimeout(r, 45));
  assert.ok(sub1Samples.length >= 1);
  assert.ok(sub2Samples.length >= 1);
  assert.ok((cap.latestSample()?.seq ?? 0) >= 1);

  const resetSample = cap.resetHeading(0);
  assert.equal(resetSample?.headingDeg, 0);

  // Background tears down IMU session while keeping subscribers alive, foreground resumes it
  broker.setForegroundActive(false);
  assert.equal(stopCount, 1);
  broker.setForegroundActive(true);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(startCount, 2);

  // Closing last subscriber turns IMU off (0 subscribers = off)
  sub1.close();
  assert.equal(stopCount, 1);
  sub2.close();
  assert.equal(stopCount, 2);
  assert.equal(cap.latestSample(), null);

  await scope.dispose();
  broker.close();
});

test("VisionBroker & createVisionCapability support includeJpeg=false face stream, metadata timestamps, hfovDeg, and cropped portrait disk cache", async () => {
  let captureFrameCalls = 0;
  let captureFacesCalls = 0;
  const deletedTargets: string[] = [];

  const port: NativeDeviceCameraPort = {
    permission: () => "granted",
    requestPermission: async () => "granted",
    openSession: async (_facing, _dim, _fps, sessionId) => sessionId,
    reconfigureSession: () => {},
    status: () => JSON.stringify({ closed: false }),
    captureFrame: async () => {
      captureFrameCalls += 1;
      return {
        jpeg: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
        width: 640,
        height: 360,
        facing: "front",
        capturedAtMs: Date.now(),
        capturedMonotonicMs: 2001.5,
        facesMonotonicMs: 2000.5,
        hfovDeg: 71.2,
        seq: 1,
        faces: [{ trackId: 1, offsetX: 0.1, offsetY: 0, width: 0.25, height: 0.35, confidence: 0.95 }],
      };
    },
    captureFaces: async (_sessionId, afterSeq) => {
      captureFacesCalls += 1;
      await new Promise((r) => setTimeout(r, 8));
      return {
        width: 640,
        height: 360,
        facing: "front",
        capturedAtMs: Date.now(),
        capturedMonotonicMs: 2500 + afterSeq * 10,
        facesMonotonicMs: 2498 + afterSeq * 10,
        hfovDeg: 71.2,
        seq: afterSeq + 1,
        faces: [{ trackId: 1, offsetX: 0.15, offsetY: -0.05, width: 0.22, height: 0.34, confidence: 0.97 }],
      };
    },
    captureCroppedPortrait: async (_sessionId, _x, _y, _w, _h, portraitId) => ({
      uri: `file:///data/portraits/${portraitId}.jpg`,
      portraitId,
      width: 224,
      height: 224,
      byteLength: 4096,
      capturedMonotonicMs: 2600,
    }),
    deletePortrait: (target) => {
      deletedTargets.push(target);
      return true;
    },
    cameraHfovDeg: () => 71.2,
    closeSession: () => {},
    setForeground: () => {},
    stopAll: () => {},
  };

  const broker = new VisionBroker();
  broker.attachNativePort(port);
  const scope = createEffectScope("plugin:vision.ext");
  const vision = createVisionCapability(
    makeManifest("vision.ext", { permissions: ["camera.front"] }),
    scope,
    broker,
  )!;

  assert.equal(vision.cameraHfovDeg?.("front"), 71.2);

  const faceFrames: Array<{ hfovDeg?: number; capturedMonotonicMs?: number; facesMonotonicMs?: number }> = [];
  const sub = await vision.subscribeFrames(
    { facing: "front", maxDimension: 320, maxFps: 15, includeJpeg: false },
    (frame) => {
      assert.equal("jpeg" in frame, false);
      faceFrames.push(frame);
    },
  );
  await new Promise((r) => setTimeout(r, 35));
  sub.close();

  assert.equal(captureFrameCalls, 0, "includeJpeg:false stream must not encode JPEGs when captureFaces exists");
  assert.ok(captureFacesCalls >= 1);
  assert.equal(faceFrames[0]?.hfovDeg, 71.2);
  assert.ok((faceFrames[0]?.capturedMonotonicMs ?? 0) >= 2500);
  assert.ok((faceFrames[0]?.facesMonotonicMs ?? 0) >= 2498);

  const portrait = await vision.captureCroppedPortrait!({
    facing: "front",
    x: 0.2,
    y: 0.1,
    width: 0.4,
    height: 0.6,
    portraitId: "player_1",
  });
  assert.equal(portrait.uri, "file:///data/portraits/player_1.jpg");
  assert.equal(vision.deletePortrait?.(portrait.uri), true);
  assert.deepEqual(deletedTargets, ["file:///data/portraits/player_1.jpg"]);

  await scope.dispose();
  broker.close();
});

test("BodyRuntime & createBodyCapability parse FED9 cliff packets and coalesce servo setDriveVector with Latest-Wins", async () => {
  const parsed = parseCliffPacket("0101000101", 12345);
  assert.deepEqual(parsed, {
    flTriggered: false,
    frTriggered: true,
    rlTriggered: false,
    rrTriggered: false,
    anyTriggered: true,
    receivedAtMs: 12345,
    rawHex: "0101000101",
  });
  assert.equal(parseCliffPacket("05", 100), null);

  const vaultMap = new Map<string, string>();
  const body = new BodyRuntime({
    vault: {
      get: (k) => vaultMap.get(k) ?? "",
      set: (k, v) => { vaultMap.set(k, v); },
      remove: (k) => { vaultMap.delete(k); },
    },
  });
  await body.configure({ mode: "simulation" });
  body.setForegroundActive(true);
  await body.connect();

  const scope = createEffectScope("plugin:servo.lw");
  try {
    const bodyCap = createBodyCapability(
      makeManifest("servo.lw", { permissions: ["body.motion", "stage.ui"] }),
      scope,
      body,
    )!;

    const packets: string[] = [];
    const unsubPackets = bodyCap.subscribeSensorPackets!((pkt) => {
      packets.push(`${pkt.kind}:${pkt.rawHex}`);
    });
    (body as any).supervisor.handleDockNotification("0101000101");
    assert.equal(bodyCap.latestCliffState?.()?.frTriggered, true);
    assert.equal(bodyCap.latestCliffState?.()?.anyTriggered, true);
    assert.equal(bodyCap.recentSensorPackets?.().at(-1)?.kind, "cliff");
    assert.equal(bodyCap.recentSensorPackets?.().filter((p) => p.kind === "cliff").length, 1);
    assert.deepEqual(packets, ["cliff:0101000101"]);
    unsubPackets();

    // Pause first supervisor setMotion call in flight, enqueue rapid burst -> intermediate targets must be coalesced
    const supervisor = (body as any).supervisor;
    const origSetMotion = supervisor.setMotion.bind(supervisor);
    const recordedMoves: Array<{ speed: number; turn: number }> = [];
    let releaseFirstMove: (() => void) | null = null;
    supervisor.setMotion = async (lease: unknown, speed: number, turn: number) => {
      recordedMoves.push({ speed, turn });
      if (recordedMoves.length === 1) {
        await new Promise<void>((resolve) => {
          releaseFirstMove = resolve;
        });
      }
      return origSetMotion(lease, speed, turn);
    };

    const servo = await bodyCap.acquireServo("foreground_stage");
    const p1 = servo.setDriveVector(0, 20);
    while (!releaseFirstMove) {
      await new Promise((r) => setImmediate(r));
    }
    const p2 = servo.setDriveVector(0, 40);
    const p3 = servo.setDriveVector(0, 60);
    const p4 = servo.setDriveVector(0, 80);
    const p5 = servo.setDriveVector(0, 100);
    (releaseFirstMove as () => void)();
    await Promise.all([p1, p2, p3, p4, p5]);

    assert.deepEqual(recordedMoves, [
      { speed: 0, turn: 20 },
      { speed: 0, turn: 100 },
    ]);
    assert.deepEqual(body.status().motion, { speed: 0, turn: 100 });

    await servo.release();

    const nextServo = await bodyCap.acquireServo("foreground_stage");
    await nextServo.setDriveVector(0, 0);
    await nextServo.setDriveVector(0, 50);
    assert.deepEqual(recordedMoves.at(-1), { speed: 0, turn: 50 });
    await nextServo.release();
  } finally {
    await scope.dispose();
    body.close();
  }
});
