import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  FACE_EXPRESSION_IDS,
  getFaceExpressionBehavior,
  isFaceExpression,
  RobotFaceController,
  KeepAwakeController,
} from "../src/ui/robot-face-controller.js";
import { LightToastQueue } from "../src/ui/light-toast-queue.js";
import {
  LOOI_PALETTE,
  getColorForReceiptStatus,
  getColorForClaimStatus,
} from "../src/ui/theme.js";

describe("Robot Face Kinematics, Toast Queue, and Theme (Phase 1)", () => {
  it("enforces color palette semantic rules for receipts and memory claims", () => {
    assert.equal(getColorForReceiptStatus("verified"), LOOI_PALETTE.confirmGreen);
    assert.equal(getColorForReceiptStatus("unverified"), LOOI_PALETTE.amberWarning);
    assert.equal(getColorForReceiptStatus("rejected"), LOOI_PALETTE.alertCoral);

    assert.equal(getColorForClaimStatus("confirmed"), LOOI_PALETTE.confirmGreen);
    assert.equal(getColorForClaimStatus("inferred"), LOOI_PALETTE.amberWarning);
    assert.equal(getColorForClaimStatus("candidate"), LOOI_PALETTE.amberWarning);
    assert.equal(getColorForClaimStatus("observed"), LOOI_PALETTE.presenceCyan);
  });

  it("controls eye gaze vector with safe clamping in [-1, 1]", () => {
    const face = new RobotFaceController();
    face.setGaze(0.5, -0.2);
    let state = face.getState();
    assert.equal(state.gaze.x, 0.5);
    assert.equal(state.gaze.y, -0.2);

    // Over-limit clamp
    face.setGaze(2.5, -3.0);
    state = face.getState();
    assert.equal(state.gaze.x, 1.0);
    assert.equal(state.gaze.y, -1.0);
  });

  it("updates audio waveform resonance bars from PCM RMS input", () => {
    const face = new RobotFaceController();
    face.setExpression("listening");

    face.updateAudioLevel(0.8);
    let state = face.getState();
    assert.equal(state.waveformBars.length, 5);
    assert.ok(state.waveformBars[2] > 0.6); // Center bar has highest weight

    // Low RMS resets to subtle idle amplitude
    face.updateAudioLevel(0.005);
    state = face.getState();
    assert.deepEqual(state.waveformBars, [0.05, 0.05, 0.05, 0.05, 0.05]);
  });

  it("triggers local emergency stop in <100ms without network wait", async () => {
    let stopCalled = false;
    let stopReason = "";
    const mockHandler = {
      stop: async (reason: "user_stop") => {
        stopCalled = true;
        stopReason = reason;
      },
    };

    const face = new RobotFaceController({ emergencyStopHandler: mockHandler });
    face.setBodyState("observing");
    assert.equal(face.getState().isEmergencyStopAvailable, true);

    const result = await face.triggerLocalEmergencyStop();
    assert.equal(result.success, true);
    assert.ok(result.latencyMs < 100, `Emergency stop took ${result.latencyMs}ms, expected <100ms`);
    assert.equal(stopCalled, true);
    assert.equal(stopReason, "user_stop");
    assert.equal(face.getState().expression, "alarmed");
  });

  it("manages keep-awake policy across docked and privacy pause states", () => {
    const keepAwake = new KeepAwakeController();

    // 1. Docked and active -> keep-awake active
    assert.equal(keepAwake.updatePolicy(true, "docked_context"), true);
    assert.equal(keepAwake.isKeepAwakeActive(), true);

    // 2. Undocked -> keep-awake disabled (saves battery)
    assert.equal(keepAwake.updatePolicy(false, "docked_context"), false);
    assert.equal(keepAwake.isKeepAwakeActive(), false);

    // 3. Docked but in privacy pause (captureMode === 'off') -> keep-awake disabled
    assert.equal(keepAwake.updatePolicy(true, "off"), false);
    assert.equal(keepAwake.isKeepAwakeActive(), false);
  });

  it("queues toast notifications during active speech and auto-expires after 3000ms", () => {
    const queue = new LightToastQueue();
    const t0 = 10_000;

    // Normal toast shown immediately
    const t1 = queue.enqueueToast("Ceiling light turned on", { receiptStatus: "verified", nowMs: t0 });
    assert.equal(queue.getActiveToast(t0)?.id, t1.id);
    assert.equal(queue.getActiveToast(t0)?.color, LOOI_PALETTE.confirmGreen);

    // User starts speaking
    queue.updateUserSpeechState(true, t0 + 500);

    // Enqueue second toast while speaking -> deferred to pending queue
    const t2 = queue.enqueueToast("Temperature claim recorded", { claimStatus: "observed", nowMs: t0 + 1000 });
    assert.equal(queue.getPendingQueueLength(), 1);
    assert.equal(queue.getActiveToast(t0 + 1000), null); // t1 suspended during speech

    // T1 expires at t0 + 3000ms
    assert.equal(queue.getActiveToast(t0 + 3001), null);
    // T2 still deferred because user is speaking
    assert.equal(queue.getPendingQueueLength(), 1);

    // Resume T1 with its remaining 2500ms, then show T2 for a full 3000ms.
    queue.updateUserSpeechState(false, t0 + 3100);
    assert.equal(queue.getActiveToast(t0 + 3100)?.id, t1.id);
    assert.equal(queue.getActiveToast(t0 + 5599)?.id, t1.id);
    assert.equal(queue.getActiveToast(t0 + 5600)?.id, t2.id);
    assert.equal(queue.getPendingQueueLength(), 0);
    assert.equal(queue.getActiveToast(t0 + 8599)?.id, t2.id);
    assert.equal(queue.getActiveToast(t0 + 8600), null);
  });

  it("privacy pause cancels pending blink work and dispose prevents reopening", async () => {
    const face = new RobotFaceController();
    face.triggerBlink();
    face.setExpression("sleeping");
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(face.getState().blinkProgress, 1);
    assert.equal(face.getState().blinkState, "closed");
    face.setExpression("neutral");
    face.triggerBlink();
    face.dispose();
    const stopped = face.getState();
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.deepEqual(face.getState(), stopped);
  });

  it("notifies onStateChange across the full blink cycle and clears interrupted blinks", async () => {
    const observedProgress: number[] = [];
    const face = new RobotFaceController({
      onStateChange: () => {
        observedProgress.push(face.getState().blinkProgress);
      },
    });
    face.triggerBlink();
    await new Promise((resolve) => setTimeout(resolve, 180));
    assert.deepEqual(observedProgress, [0.5, 1.0, 0.5, 0.0]);
    assert.equal(face.getState().blinkState, "open");
    assert.equal(face.getState().blinkProgress, 0.0);

    // Mid-blink expression reset (including same expression or emergency stop) clears half-blink state and notifies.
    observedProgress.length = 0;
    face.triggerBlink();
    assert.equal(face.getState().blinkProgress, 0.5);
    face.setExpression("neutral");
    assert.equal(face.getState().blinkProgress, 0.0);
    assert.deepEqual(observedProgress, [0.5, 0.0]);

    face.triggerBlink();
    await face.triggerLocalEmergencyStop();
    assert.equal(face.getState().expression, "alarmed");
    assert.equal(face.getState().blinkProgress, 0.0);
    assert.equal(face.getState().blinkState, "open");
  });

  it("supports all 72 canonical expressions with blink and closed-rest invariants", async () => {
    assert.equal(FACE_EXPRESSION_IDS.length, 72);
    assert.equal(new Set(FACE_EXPRESSION_IDS).size, 72);
    assert.equal(isFaceExpression("coffee_sip"), true);
    assert.equal(isFaceExpression("unknown_expression"), false);

    const face = new RobotFaceController();
    for (const id of FACE_EXPRESSION_IDS) {
      face.setExpression(id);
      const behavior = getFaceExpressionBehavior(id);
      const state = face.getState();
      assert.equal(state.expression, id);
      if (behavior.closedRest) {
        assert.equal(state.blinkState, "closed");
        assert.equal(state.blinkProgress, 1.0);
        assert.deepEqual(state.waveformBars, [0, 0, 0, 0, 0]);
        face.updateAudioLevel(0);
        assert.deepEqual(face.getState().waveformBars, [0, 0, 0, 0, 0]);
        face.updateAudioLevel(0.75);
        assert.deepEqual(face.getState().waveformBars, [0, 0, 0, 0, 0]);
      } else {
        assert.equal(state.blinkState, "open");
        assert.equal(state.blinkProgress, 0.0);
        assert.deepEqual(state.waveformBars, [0.05, 0.05, 0.05, 0.05, 0.05]);
      }

      if (!behavior.allowsBlink) {
        const before = face.getState();
        face.triggerBlink();
        assert.deepEqual(face.getState(), before);
      }
    }

    // Switching from orb mid-blink into a symbolic/crescent expression cancels pending blink timers.
    face.setExpression("neutral");
    face.triggerBlink();
    assert.equal(face.getState().blinkProgress, 0.5);
    face.setExpression("love_eyes");
    assert.equal(face.getState().blinkState, "open");
    assert.equal(face.getState().blinkProgress, 0.0);
    await new Promise((resolve) => setTimeout(resolve, 140));
    assert.equal(face.getState().expression, "love_eyes");
    assert.equal(face.getState().blinkProgress, 0.0);
    face.dispose();
  });
});
