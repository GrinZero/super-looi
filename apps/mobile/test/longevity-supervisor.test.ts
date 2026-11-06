import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DockedLongevitySupervisor,
  type ThermalPressureLevel,
  type MemoryPressureLevel,
  type PixelMicroShift,
} from "../src/shell/longevity-supervisor.js";
import {
  BodySupervisor,
  SimulatedBleTransport,
} from "@super-looi/looi-driver";

describe("DockedLongevitySupervisor: Dual-End Longevity, Step-Down & OLED Burn-In (Phase 5)", () => {
  it("enforces graceful thermal step-down and unloads Edge VLM under high pressure", async () => {
    const thermalEvents: Array<{ newLevel: ThermalPressureLevel; oldLevel: ThermalPressureLevel }> = [];
    const unloadEvents: string[] = [];

    const supervisor = new DockedLongevitySupervisor(undefined, {
      onThermalChange: (newLevel, oldLevel) => {
        thermalEvents.push({ newLevel, oldLevel });
      },
      onUnloadEdgeVlm: (reason) => {
        unloadEvents.push(reason);
      },
    });

    const initialPolicy = supervisor.getPolicy();
    assert.equal(initialPolicy.thermalLevel, "nominal");
    assert.equal(initialPolicy.activeLookEnabled, true);
    assert.equal(initialPolicy.captureCadenceMs, 1000);
    assert.equal(initialPolicy.edgeVlmLoaded, true);
    assert.equal(initialPolicy.screenDimmed, false);

    // Step 1: Fair pressure
    supervisor.setThermalLevel("fair");
    const fairPolicy = supervisor.getPolicy();
    assert.equal(fairPolicy.thermalLevel, "fair");
    assert.equal(fairPolicy.captureCadenceMs, 2500);
    assert.equal(fairPolicy.activeLookEnabled, true);
    assert.equal(fairPolicy.edgeVlmLoaded, true);

    // Step 2: Serious pressure -> disables active look, dims screen, unloads VLM
    supervisor.setThermalLevel("serious");
    const seriousPolicy = supervisor.getPolicy();
    assert.equal(seriousPolicy.thermalLevel, "serious");
    assert.equal(seriousPolicy.activeLookEnabled, false);
    assert.equal(seriousPolicy.captureCadenceMs, 5000);
    assert.equal(seriousPolicy.screenDimmed, true);
    assert.equal(seriousPolicy.edgeVlmLoaded, false);
    assert.ok(unloadEvents.includes("thermal_serious"));

    // Step 3: Critical pressure -> deep throttle (10s)
    supervisor.setThermalLevel("critical");
    const criticalPolicy = supervisor.getPolicy();
    assert.equal(criticalPolicy.thermalLevel, "critical");
    assert.equal(criticalPolicy.captureCadenceMs, 10000);
    assert.equal(criticalPolicy.activeLookEnabled, false);

    assert.equal(thermalEvents.length, 3);
  });

  it("unloads Edge VLM when memory pressure reaches warning or critical", () => {
    const memoryEvents: Array<{ newLevel: MemoryPressureLevel; oldLevel: MemoryPressureLevel }> = [];
    const unloadReasons: string[] = [];

    const supervisor = new DockedLongevitySupervisor(undefined, {
      onMemoryChange: (newLevel, oldLevel) => {
        memoryEvents.push({ newLevel, oldLevel });
      },
      onUnloadEdgeVlm: (reason) => {
        unloadReasons.push(reason);
      },
    });

    supervisor.setMemoryLevel("warning");
    assert.equal(supervisor.getPolicy().edgeVlmLoaded, false);
    assert.ok(unloadReasons.includes("memory_warning"));

    supervisor.setMemoryLevel("critical");
    assert.equal(supervisor.getPolicy().edgeVlmLoaded, false);
    assert.equal(memoryEvents.length, 2);
  });

  it("guarantees emergency stop execution within <100ms even under thermal critical state", async () => {
    const transport = new SimulatedBleTransport();
    const bodySupervisor = new BodySupervisor(transport);
    await bodySupervisor.connect();
    transport.emitNotification("dockNotify", "05");

    let emergencyStopReported = false;
    let emergencyStopLatency = 0;

    const longevitySupervisor = new DockedLongevitySupervisor(bodySupervisor, {
      onEmergencyStop: (_reason, latency) => {
        emergencyStopReported = true;
        emergencyStopLatency = latency;
      },
    });

    // Put into thermal critical
    longevitySupervisor.setThermalLevel("critical");
    longevitySupervisor.queueMotionCommand("cmd_head_tilt");
    assert.equal(longevitySupervisor.getPendingMotionCount(), 1);

    // Trigger emergency stop
    const result = await longevitySupervisor.triggerEmergencyStop("user_voice_stop");
    assert.equal(result.stopped, true);
    assert.ok(result.latencyMs < 100, `Latency was ${result.latencyMs}ms, must be < 100ms`);
    assert.equal(emergencyStopReported, true);
    assert.ok(emergencyStopLatency < 100);
    assert.equal(longevitySupervisor.getPendingMotionCount(), 0);
  });

  it("BLE auto-heal enforces zero motion replay across disconnection and reconnection", () => {
    const supervisor = new DockedLongevitySupervisor();

    supervisor.queueMotionCommand("cmd_turn_left");
    supervisor.queueMotionCommand("cmd_turn_right");
    assert.equal(supervisor.getPendingMotionCount(), 2);

    // 1. Disconnect occurs
    supervisor.handleBleDisconnect();
    assert.equal(supervisor.getPendingMotionCount(), 0);

    // 2. Incoming commands while disconnected are discarded
    supervisor.queueMotionCommand("cmd_stale_look");
    assert.equal(supervisor.getPendingMotionCount(), 0);

    // 3. Reconnect occurs -> hard zero replay guarantee
    const reconnectResult = supervisor.handleBleReconnect();
    assert.equal(reconnectResult.replayedCommandsCount, 0);
    assert.equal(supervisor.getPendingMotionCount(), 0);
  });

  it("applies bounded OLED burn-in pixel micro-shift strictly within [-6, 6] pixels", () => {
    const shifts: PixelMicroShift[] = [];
    const supervisor = new DockedLongevitySupervisor(undefined, {
      onMicroShiftUpdate: (s) => {
        shifts.push(s);
      },
    });

    const initial = supervisor.getPixelMicroShift();
    assert.equal(initial.dx, 0);
    assert.equal(initial.dy, 0);
    assert.equal(initial.stepCount, 0);

    // Run 30 periodic micro-shift ticks (simulating 30 minutes of landscape dock presence)
    for (let i = 0; i < 30; i++) {
      const shift = supervisor.tickMicroShift();
      assert.ok(shift.dx >= -6 && shift.dx <= 6, `dx ${shift.dx} out of bounds [-6, 6]`);
      assert.ok(shift.dy >= -6 && shift.dy <= 6, `dy ${shift.dy} out of bounds [-6, 6]`);
      assert.equal(shift.stepCount, i + 1);
    }

    assert.equal(shifts.length, 30);

    // Reset micro-shift
    supervisor.resetMicroShift();
    const afterReset = supervisor.getPixelMicroShift();
    assert.equal(afterReset.dx, 0);
    assert.equal(afterReset.dy, 0);
    assert.equal(afterReset.stepCount, 0);
  });
});
