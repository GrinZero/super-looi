import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PresenceStateManager } from "../src/shell/presence-state.js";
import type { UserActionRef } from "@super-looi/contracts";

describe("PresenceStateManager and UI Navigation Guards", () => {
  it("initializes with default docked presence snapshot", () => {
    const manager = new PresenceStateManager();
    const snapshot = manager.getSnapshot();

    assert.equal(snapshot.faceExpression, "neutral");
    assert.equal(snapshot.captureMode, "docked_context");
    assert.equal(snapshot.bodyState, "disconnected");
    assert.equal(snapshot.innerSpace, "none");
    assert.equal(snapshot.privacyEpoch.capture_epoch, 1);
    assert.equal(snapshot.privacyEpoch.camera, "on");
    assert.equal(snapshot.privacyEpoch.microphone, "on");
  });

  it("bumps capture_epoch and clears buffers on user privacy pause", () => {
    let pausedNotification = false;
    const manager = new PresenceStateManager({
      onPrivacyPaused: (epoch) => {
        pausedNotification = true;
        assert.equal(epoch.capture_epoch, 2);
      },
    });

    const epoch = manager.pausePrivacy("user_owner");
    assert.equal(pausedNotification, true);
    assert.equal(epoch.capture_epoch, 2);
    assert.equal(epoch.camera, "off");
    assert.equal(epoch.microphone, "off");
    assert.equal(epoch.local_buffer_state, "cleared");

    const snapshot = manager.getSnapshot();
    assert.equal(snapshot.faceExpression, "sleeping");
    assert.equal(snapshot.captureMode, "off");

    // Resume
    const resumedEpoch = manager.resumePrivacy("docked_context");
    assert.equal(resumedEpoch.camera, "on");
    assert.equal(resumedEpoch.microphone, "on");
    assert.equal(manager.getSnapshot().faceExpression, "neutral");
  });

  it("transitions bodyState safely on undock event", () => {
    const manager = new PresenceStateManager();
    manager.setBodyState("ready");
    manager.handleDockChange(true);
    assert.equal(manager.getSnapshot().bodyState, "ready");
    assert.equal(manager.getSnapshot().isDocked, true);

    // Undock event
    manager.handleDockChange(false);
    assert.equal(manager.getSnapshot().bodyState, "connected_unarmed");
    assert.equal(manager.getSnapshot().isDocked, false);
  });

  it("blocks background tasks from hijacking the foreground screen without trusted user action", () => {
    let blockedReason: string | null = null;
    const manager = new PresenceStateManager({
      onNavigationBlocked: (reason) => {
        blockedReason = reason;
      },
    });

    // 1. Background task or model autonomous attempt -> rejected!
    const autonomousResult = manager.navigateInnerSpace("memories");
    assert.equal(autonomousResult, false);
    assert.equal(manager.getSnapshot().innerSpace, "none");
    assert.ok(blockedReason?.includes("missing explicit UserActionRef"));

    // 2. User explicit tap gesture -> accepted!
    const userTap: UserActionRef = {
      event_id: "evt_tap_987",
      ui_session_id: "ui_sess_1",
      kind: "tap",
      captured_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 5000).toISOString(),
    };

    const userResult = manager.navigateInnerSpace("memories", userTap);
    assert.equal(userResult, true);
    assert.equal(manager.getSnapshot().innerSpace, "memories");

    // 3. User navigates back to none -> always accepted
    const closeResult = manager.navigateInnerSpace("none");
    assert.equal(closeResult, true);
    assert.equal(manager.getSnapshot().innerSpace, "none");
  });
});
