import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  FACE_EXPRESSION_IDS,
  getFaceExpressionBehavior,
  isFaceExpression,
  RobotFaceController,
} from "../src/face/robot-face-controller.js";

describe("Robot Face Kinematics and Expression Catalog", () => {
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
