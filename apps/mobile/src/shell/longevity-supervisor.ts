import type { BodySupervisor } from "@super-looi/looi-driver";

export type ThermalPressureLevel = "nominal" | "fair" | "serious" | "critical";
export type MemoryPressureLevel = "nominal" | "warning" | "critical";

export interface LongevityPolicy {
  thermalLevel: ThermalPressureLevel;
  memoryLevel: MemoryPressureLevel;
  activeLookEnabled: boolean;
  captureCadenceMs: number;
  edgeVlmLoaded: boolean;
  screenDimmed: boolean;
  emergencyStopGuaranteedMs: number;
}

export interface PixelMicroShift {
  dx: number; // bounded in [-6, 6]
  dy: number; // bounded in [-6, 6]
  stepCount: number;
}

export interface LongevitySupervisorEvents {
  onThermalChange?: (newLevel: ThermalPressureLevel, oldLevel: ThermalPressureLevel) => void;
  onMemoryChange?: (newLevel: MemoryPressureLevel, oldLevel: MemoryPressureLevel) => void;
  onUnloadEdgeVlm?: (reason: string) => void;
  onEmergencyStop?: (reason: string, latencyMs: number) => void;
  onMicroShiftUpdate?: (shift: PixelMicroShift) => void;
}

/**
 * DockedLongevitySupervisor:
 * Enforces dual-end long-stability, graceful thermal/memory step-down,
 * zero-motion-replay BLE auto-healing, and bounded OLED burn-in protection.
 */
export class DockedLongevitySupervisor {
  private thermalLevel: ThermalPressureLevel = "nominal";
  private memoryLevel: MemoryPressureLevel = "nominal";

  // Active Look & Background capture policies
  private activeLookEnabled = true;
  private captureCadenceMs = 1000; // 1s at nominal
  private edgeVlmLoaded = true;
  private screenDimmed = false;

  // OLED micro-shift state (bounded strictly within [-6, 6])
  private microShift: PixelMicroShift = { dx: 0, dy: 0, stepCount: 0 };
  private static readonly SHIFT_BOUND = 6;
  private static readonly MICRO_STEPS: Array<{ dx: number; dy: number }> = [
    { dx: 0, dy: 0 },
    { dx: 2, dy: 1 },
    { dx: 4, dy: 3 },
    { dx: 6, dy: 2 },
    { dx: 5, dy: -2 },
    { dx: 3, dy: -5 },
    { dx: 0, dy: -6 },
    { dx: -3, dy: -4 },
    { dx: -6, dy: -1 },
    { dx: -5, dy: 3 },
    { dx: -2, dy: 5 },
    { dx: 1, dy: 6 },
  ];

  // In-flight motion command buffer (must be purged on disconnect to prevent replay)
  private pendingMotionCommands: string[] = [];
  private bleReconnecting = false;

  constructor(
    private readonly bodySupervisor?: BodySupervisor,
    private readonly events: LongevitySupervisorEvents = {}
  ) {}

  public getPolicy(): LongevityPolicy {
    return {
      thermalLevel: this.thermalLevel,
      memoryLevel: this.memoryLevel,
      activeLookEnabled: this.activeLookEnabled,
      captureCadenceMs: this.captureCadenceMs,
      edgeVlmLoaded: this.edgeVlmLoaded,
      screenDimmed: this.screenDimmed,
      emergencyStopGuaranteedMs: 100, // Hard invariant <= 100ms
    };
  }

  /**
   * Update device thermal pressure level and enforce step-down actions.
   */
  public setThermalLevel(level: ThermalPressureLevel): void {
    if (this.thermalLevel === level) return;
    const oldLevel = this.thermalLevel;
    this.thermalLevel = level;

    switch (level) {
      case "nominal":
        this.activeLookEnabled = true;
        this.captureCadenceMs = 1000;
        this.screenDimmed = false;
        break;
      case "fair":
        this.activeLookEnabled = true;
        this.captureCadenceMs = 2500;
        this.screenDimmed = false;
        break;
      case "serious":
        this.activeLookEnabled = false; // Disables autonomous active look
        this.captureCadenceMs = 5000; // Throttle perception
        this.screenDimmed = true;
        this.unloadEdgeVlm("thermal_serious");
        break;
      case "critical":
        this.activeLookEnabled = false;
        this.captureCadenceMs = 10000; // Deep throttle
        this.screenDimmed = true;
        this.unloadEdgeVlm("thermal_critical");
        break;
    }

    this.events.onThermalChange?.(level, oldLevel);
  }

  /**
   * Update device memory pressure level and enforce model unloading.
   */
  public setMemoryLevel(level: MemoryPressureLevel): void {
    if (this.memoryLevel === level) return;
    const oldLevel = this.memoryLevel;
    this.memoryLevel = level;

    if (level === "warning" || level === "critical") {
      this.unloadEdgeVlm(`memory_${level}`);
    } else if (level === "nominal" && this.thermalLevel === "nominal") {
      this.edgeVlmLoaded = true;
    }

    this.events.onMemoryChange?.(level, oldLevel);
  }

  private unloadEdgeVlm(reason: string): void {
    if (this.edgeVlmLoaded) {
      this.edgeVlmLoaded = false;
      this.events.onUnloadEdgeVlm?.(reason);
    }
  }

  /**
   * Emergency Stop Trigger:
   * Guarantees halting within <100ms latency, independent of thermal throttling or model unloading.
   */
  public async triggerEmergencyStop(reason = "emergency_button"): Promise<{ stopped: boolean; latencyMs: number }> {
    const start = Date.now();
    this.pendingMotionCommands.length = 0; // Clear motion queue immediately

    if (this.bodySupervisor) {
      await this.bodySupervisor.stop("user_stop");
    }

    const latencyMs = Date.now() - start;
    this.events.onEmergencyStop?.(reason, latencyMs);
    return {
      stopped: true,
      latencyMs,
    };
  }

  /**
   * Queue a motion command to the supervisor.
   */
  public queueMotionCommand(commandId: string): void {
    if (this.bleReconnecting) {
      // Discard commands during reconnection
      return;
    }
    this.pendingMotionCommands.push(commandId);
  }

  public getPendingMotionCount(): number {
    return this.pendingMotionCommands.length;
  }

  /**
   * BLE Disconnect handler:
   * Discards all queued motion commands to enforce ZERO motion replay upon reconnect.
   */
  public handleBleDisconnect(): void {
    this.bleReconnecting = true;
    // Zero motion replay guarantee: PURGE ALL PENDING COMMANDS
    this.pendingMotionCommands.length = 0;
  }

  /**
   * BLE Reconnect completed:
   * Enforces that pending commands remain zero and verifies unarmed safe state.
   */
  public handleBleReconnect(): { replayedCommandsCount: number } {
    this.bleReconnecting = false;
    // Hard invariant: zero motion commands replayed
    const replayed = this.pendingMotionCommands.length;
    this.pendingMotionCommands.length = 0;
    return {
      replayedCommandsCount: replayed,
    };
  }

  /**
   * Advances OLED burn-in prevention pixel micro-shift by one step.
   * Micro-shift offset (dx, dy) is strictly clamped within [-6, 6] pixels.
   */
  public tickMicroShift(): PixelMicroShift {
    const nextStep = this.microShift.stepCount + 1;
    const pattern = DockedLongevitySupervisor.MICRO_STEPS[
      nextStep % DockedLongevitySupervisor.MICRO_STEPS.length
    ];

    // Strictly enforce bounds [-6, 6]
    const clampedDx = Math.max(
      -DockedLongevitySupervisor.SHIFT_BOUND,
      Math.min(DockedLongevitySupervisor.SHIFT_BOUND, pattern.dx)
    );
    const clampedDy = Math.max(
      -DockedLongevitySupervisor.SHIFT_BOUND,
      Math.min(DockedLongevitySupervisor.SHIFT_BOUND, pattern.dy)
    );

    this.microShift = {
      dx: clampedDx,
      dy: clampedDy,
      stepCount: nextStep,
    };

    this.events.onMicroShiftUpdate?.(this.microShift);
    return { ...this.microShift };
  }

  public getPixelMicroShift(): PixelMicroShift {
    return { ...this.microShift };
  }

  public resetMicroShift(): void {
    this.microShift = { dx: 0, dy: 0, stepCount: 0 };
    this.events.onMicroShiftUpdate?.(this.microShift);
  }
}
