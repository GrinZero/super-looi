import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CabinSpaceController,
  type CabinMorphState,
} from "../src/ui/cabin-space.js";
import { LOOI_PALETTE } from "../src/ui/theme.js";

describe("CabinSpaceController: 维修舱 Conformal UI & Degraded Connection Honesty (Phase 4)", () => {
  it("manages conformal morph transitions between robot face and cabin space", async () => {
    const statesReported: CabinMorphState[] = [];

    const controller = new CabinSpaceController({
      onMorphStateChange: (state) => {
        statesReported.push(state);
      },
    });

    assert.equal(controller.getMorphState(), "face_fullscreen");

    // Open cabin
    await controller.openCabinSpace();
    assert.equal(controller.getMorphState(), "cabin_open");
    assert.deepEqual(statesReported, [
      "eyes_closing_to_cabin",
      "cabin_open",
    ]);

    // Close cabin
    await controller.closeCabinSpace();
    assert.equal(controller.getMorphState(), "face_fullscreen");
    assert.deepEqual(statesReported, [
      "eyes_closing_to_cabin",
      "cabin_open",
      "cabin_converging_to_eyes",
      "face_fullscreen",
    ]);
  });

  it("reports degraded subsystem connections independently without single-green-dot masking (Screen 14)", () => {
    const controller = new CabinSpaceController();

    // 1. Initial healthy state: all 3 systems connected
    const initialSummary = controller.getOverallStatusSummary();
    assert.equal(initialSummary.isDegraded, false);
    assert.equal(initialSummary.summary, "全部系统正常在线");

    const subs = controller.getSubsystems();
    assert.equal(subs.bleDock.status, "connected");
    assert.equal(subs.hub.status, "connected");
    assert.equal(subs.homeAssistant.status, "connected");
    assert.equal(subs.bleDock.statusColor, LOOI_PALETTE.confirmGreen);

    // 2. HA gateway disconnects (e.g. WiFi dropped on bridge)
    controller.updateSubsystemStatus("homeAssistant", "disconnected");

    const degradedSubs = controller.getSubsystems();
    assert.equal(degradedSubs.homeAssistant.status, "disconnected");
    assert.equal(degradedSubs.homeAssistant.statusColor, LOOI_PALETTE.alertCoral);
    // BLE and Hub remain green!
    assert.equal(degradedSubs.bleDock.status, "connected");
    assert.equal(degradedSubs.bleDock.statusColor, LOOI_PALETTE.confirmGreen);
    assert.equal(degradedSubs.hub.status, "connected");
    assert.equal(degradedSubs.hub.statusColor, LOOI_PALETTE.confirmGreen);

    // Summary explicitly highlights HA failure
    const degradedSummary = controller.getOverallStatusSummary();
    assert.equal(degradedSummary.isDegraded, true);
    assert.match(degradedSummary.summary, /智能家居网关未连接/);
    assert.doesNotMatch(degradedSummary.summary, /LOOI底座未连/);
  });

  it("suppresses stale in-flight motion commands upon reconnection", () => {
    const controller = new CabinSpaceController();

    assert.equal(controller.getSuppressedMotionCommandsCount(), 0);

    // BLE reconnect occurs
    const res = controller.handleReconnect();
    assert.ok(res.suppressedOldMotionCommands > 0);
    assert.equal(controller.getSuppressedMotionCommandsCount(), 2);
  });

  it("controls voice/vision provider switching and reports hardware sensor activity", () => {
    let voiceChangedTo = "";
    let visionChangedTo = "";

    const controller = new CabinSpaceController({
      onVoiceProviderChange: (v) => {
        voiceChangedTo = v;
      },
      onVisionProviderChange: (v) => {
        visionChangedTo = v;
      },
    });

    assert.equal(controller.getActiveVoiceProvider(), "doubao");
    assert.equal(controller.getActiveVisionProvider(), "cloud");

    // Switch providers
    controller.setActiveVoiceProvider("modular");
    assert.equal(controller.getActiveVoiceProvider(), "modular");
    assert.equal(voiceChangedTo, "modular");

    controller.setActiveVisionProvider("lan");
    assert.equal(controller.getActiveVisionProvider(), "lan");
    assert.equal(visionChangedTo, "lan");

    // Sensor status
    controller.setSensorStatus({
      camera: true,
      microphone: false,
      backgroundProcessing: true,
    });

    const sensors = controller.getSensorsState();
    assert.equal(sensors.camera, true);
    assert.equal(sensors.microphone, false);
    assert.equal(sensors.backgroundProcessing, true);
  });
});
