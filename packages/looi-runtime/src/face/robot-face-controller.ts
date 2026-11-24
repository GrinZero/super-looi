import {
  FACE_EXPRESSION_IDS,
  getFaceExpressionBehavior,
  isFaceExpression,
  registerDynamicFaceBehavior,
  type CanonicalFaceExpression,
  type FaceExpression,
  type FaceExpressionBehavior,
  type PluginFaceExpressionId,
} from "./face-expressions.js";
import type { BodySupervisorState } from "@super-looi/contracts";

export {
  FACE_EXPRESSION_IDS,
  getFaceExpressionBehavior,
  isFaceExpression,
  registerDynamicFaceBehavior,
  type CanonicalFaceExpression,
  type FaceExpression,
  type FaceExpressionBehavior,
  type PluginFaceExpressionId,
};

export type BlinkState = "open" | "closing" | "closed" | "opening";

export interface EyeGaze {
  x: number; // -1 (left) to 1 (right)
  y: number; // -1 (down) to 1 (up)
}

export interface RobotFaceState {
  expression: FaceExpression;
  gaze: EyeGaze;
  blinkState: BlinkState;
  blinkProgress: number; // 0.0 (fully open) to 1.0 (fully closed)
  waveformBars: number[]; // 5 resonance bars, normalized 0.0 to 1.0
  isEmergencyStopAvailable: boolean;
}

export interface EmergencyStopHandler {
  stop(reason: "user_stop"): Promise<void>;
}

/**
 * Six-tier face priority stack (P0 highest -> P5 default idle):
 * P0 SYSTEM_CRITICAL   > P1 DOCK_TRANSIENT > P2 PLUGIN_FOREGROUND
 * > P3 CONVERSATIONAL  > P4 PLUGIN_BACKGROUND > P5 DEFAULT_IDLE
 */
export const FACE_PRIORITY = {
  SYSTEM_CRITICAL: 0,
  DOCK_TRANSIENT: 1,
  PLUGIN_FOREGROUND: 2,
  CONVERSATIONAL: 3,
  PLUGIN_BACKGROUND: 4,
  DEFAULT_IDLE: 5,
} as const;

export type FacePriorityLevel = (typeof FACE_PRIORITY)[keyof typeof FACE_PRIORITY];

export interface FaceLayerLease {
  setExpression(expression: FaceExpression | null): void;
  setGaze(gaze: EyeGaze | null): void;
  triggerBlink(): void;
  release(): void;
}

interface InternalFaceLease {
  readonly id: number;
  readonly priority: FacePriorityLevel;
  seq: number;
  expression: FaceExpression | null;
  gaze: EyeGaze | null;
  released: boolean;
}

function clampGaze(gaze: EyeGaze): EyeGaze {
  return {
    x: Math.max(-1.0, Math.min(1.0, gaze.x)),
    y: Math.max(-1.0, Math.min(1.0, gaze.y)),
  };
}

export class RobotFaceController {
  private baseExpression: FaceExpression = "neutral";
  private baseGaze: EyeGaze = { x: 0, y: 0 };
  private expression: FaceExpression = "neutral";
  private gaze: EyeGaze = { x: 0, y: 0 };
  private blinkState: BlinkState = "open";
  private blinkProgress = 0.0;
  private waveformBars = [0.05, 0.05, 0.05, 0.05, 0.05];
  private bodyState: BodySupervisorState = "disconnected";
  private emergencyStopHandler?: EmergencyStopHandler;
  private onStateChange?: () => void;
  private blinkTimers: Array<ReturnType<typeof setTimeout>> = [];
  private nextLeaseId = 1;
  private nextLeaseSeq = 1;
  private readonly leases = new Map<number, InternalFaceLease>();
  private readonly dynamicRecipes = new Map<PluginFaceExpressionId, Record<string, unknown>>();
  private readonly dynamicDisposers = new Map<PluginFaceExpressionId, () => void>();
  private recipeSyncBridge?: (id: PluginFaceExpressionId, recipe: Record<string, unknown> | null) => void;

  // Built-in host leases for P0, P1, and P3 so `setHostPresence` composes seamlessly with P2 & P4 plugins
  private hostSystemLease?: InternalFaceLease;
  private hostDockLease?: InternalFaceLease;
  private hostConversationalLease?: InternalFaceLease;

  constructor(
    options: {
      emergencyStopHandler?: EmergencyStopHandler;
      onStateChange?: () => void;
    } = {},
  ) {
    this.emergencyStopHandler = options.emergencyStopHandler;
    this.onStateChange = options.onStateChange;
  }

  public getState(): RobotFaceState {
    const isObservingOrManual =
      this.bodyState === "observing" || this.bodyState === "manual";
    return {
      expression: this.expression,
      gaze: { ...this.gaze },
      blinkState: this.blinkState,
      blinkProgress: this.blinkProgress,
      waveformBars: [...this.waveformBars],
      isEmergencyStopAvailable: isObservingOrManual,
    };
  }

  public setBodyState(state: BodySupervisorState): void {
    this.bodyState = state;
  }

  /**
   * Connects UI renderer recipe registry (`face-recipes.ts`) and replays any dynamic plugin recipes.
   */
  public attachRecipeSyncBridge(
    bridge: ((id: PluginFaceExpressionId, recipe: Record<string, unknown> | null) => void) | undefined,
  ): void {
    this.recipeSyncBridge = bridge;
    if (bridge) {
      for (const [id, recipe] of this.dynamicRecipes) {
        bridge(id, recipe);
      }
    }
  }

  public getDynamicRecipe(id: PluginFaceExpressionId): Record<string, unknown> | undefined {
    return this.dynamicRecipes.get(id);
  }

  private assertKnownExpression(expr: FaceExpression | null | undefined, stage: string): FaceExpression | null {
    if (expr === null || expr === undefined) return null;
    if (isFaceExpression(expr) || this.dynamicRecipes.has(expr as PluginFaceExpressionId)) {
      return expr;
    }
    throw Object.assign(new Error(`Unknown face expression "${String(expr)}"`), {
      stage,
      code: "ERR_FACE_UNKNOWN_EXPRESSION",
    });
  }

  /**
   * Registers a plugin-scoped expression recipe and behavior flags; returns an idempotent unregister function.
   */
  public registerDynamicExpression(
    id: PluginFaceExpressionId,
    recipe: Record<string, unknown>,
    behavior?: Partial<FaceExpressionBehavior>,
  ): () => void {
    this.dynamicDisposers.get(id)?.();
    const unregisterBehavior = registerDynamicFaceBehavior(id, behavior);
    this.dynamicRecipes.set(id, recipe);
    this.recipeSyncBridge?.(id, recipe);

    let disposed = false;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      if (this.dynamicDisposers.get(id) === dispose) {
        this.dynamicDisposers.delete(id);
      }
      unregisterBehavior();
      this.dynamicRecipes.delete(id);
      this.recipeSyncBridge?.(id, null);
      for (const lease of this.leases.values()) {
        if (lease.expression === id) {
          lease.expression = null;
        }
      }
      if (this.baseExpression === id) {
        this.baseExpression = "neutral";
      }
      this.recomputeEffectiveState();
    };
    this.dynamicDisposers.set(id, dispose);
    return dispose;
  }

  /**
   * Acquires a priority-layered lease on the P0–P5 stack.
   * `expression` and `gaze` compose orthogonally: e.g., P3 `speaking` + P4 plugin `gaze` tracking.
   */
  public acquireLayerLease(
    priority: FacePriorityLevel,
    initial: { expression?: FaceExpression | null; gaze?: EyeGaze | null } = {},
  ): FaceLayerLease {
    const initialExpression = this.assertKnownExpression(initial.expression, "face.acquireLayerLease");
    const record: InternalFaceLease = {
      id: this.nextLeaseId++,
      priority,
      seq: this.nextLeaseSeq++,
      expression: initialExpression,
      gaze: initial.gaze ? clampGaze(initial.gaze) : null,
      released: false,
    };
    this.leases.set(record.id, record);
    this.recomputeEffectiveState();

    return {
      setExpression: (expr) => {
        if (record.released) return;
        const resolved = this.assertKnownExpression(expr, "face.lease.setExpression");
        if (record.expression === resolved) {
          this.recomputeEffectiveState({ resetInterruptedBlink: true });
          return;
        }
        record.expression = resolved;
        record.seq = this.nextLeaseSeq++;
        this.recomputeEffectiveState({ resetInterruptedBlink: true });
      },
      setGaze: (nextGaze) => {
        if (record.released) return;
        const clamped = nextGaze ? clampGaze(nextGaze) : null;
        const unchanged =
          (record.gaze === null && clamped === null) ||
          (record.gaze !== null &&
            clamped !== null &&
            record.gaze.x === clamped.x &&
            record.gaze.y === clamped.y);
        if (unchanged) return;
        record.gaze = clamped;
        record.seq = this.nextLeaseSeq++;
        this.recomputeEffectiveState();
      },
      triggerBlink: () => {
        if (record.released) return;
        this.triggerBlink();
      },
      release: () => {
        if (record.released) return;
        record.released = true;
        this.leases.delete(record.id);
        this.recomputeEffectiveState();
      },
    };
  }

  /**
   * Updates host-owned P0 (system critical), P1 (dock transient), P3 (conversational), and P5 (idle)
   * slots atomically while preserving P2 (foreground stage plugin) and P4 (background companion plugin).
   */
  public setHostPresence(presence: {
    systemCritical?: FaceExpression | null;
    dockTransient?: FaceExpression | null;
    conversational?: FaceExpression | null;
    idle?: FaceExpression;
  }): void {
    let changed = false;
    const updateSlot = (
      current: InternalFaceLease | undefined,
      priority: FacePriorityLevel,
      expr: FaceExpression | null | undefined,
    ): InternalFaceLease | undefined => {
      if (expr === undefined) return current;
      if (!expr) {
        if (current) {
          current.released = true;
          this.leases.delete(current.id);
          changed = true;
        }
        return undefined;
      }
      if (current) {
        if (current.expression !== expr) {
          current.expression = expr;
          current.seq = this.nextLeaseSeq++;
          changed = true;
        }
        return current;
      }
      changed = true;
      const created: InternalFaceLease = {
        id: this.nextLeaseId++,
        priority,
        seq: this.nextLeaseSeq++,
        expression: expr,
        gaze: null,
        released: false,
      };
      this.leases.set(created.id, created);
      return created;
    };

    this.hostSystemLease = updateSlot(
      this.hostSystemLease,
      FACE_PRIORITY.SYSTEM_CRITICAL,
      presence.systemCritical,
    );
    this.hostDockLease = updateSlot(
      this.hostDockLease,
      FACE_PRIORITY.DOCK_TRANSIENT,
      presence.dockTransient,
    );
    this.hostConversationalLease = updateSlot(
      this.hostConversationalLease,
      FACE_PRIORITY.CONVERSATIONAL,
      presence.conversational,
    );
    if (presence.idle && this.baseExpression !== presence.idle) {
      this.baseExpression = presence.idle;
      changed = true;
    }
    if (changed) {
      this.recomputeEffectiveState({ resetInterruptedBlink: true });
    }
  }

  public setExpression(expression: FaceExpression): void {
    const resolved = this.assertKnownExpression(expression, "face.setExpression");
    this.baseExpression = resolved ?? "neutral";
    this.recomputeEffectiveState({ resetInterruptedBlink: true });
  }

  public setGaze(x: number, y: number): void {
    this.baseGaze = clampGaze({ x, y });
    this.recomputeEffectiveState({ emitOnGazeChange: false });
  }

  private recomputeEffectiveState(
    options: { emitOnGazeChange?: boolean; resetInterruptedBlink?: boolean } = {},
  ): void {
    const emitOnGazeChange = options.emitOnGazeChange ?? true;
    const resetInterruptedBlink = options.resetInterruptedBlink ?? false;
    const ordered = [...this.leases.values()].sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return b.seq - a.seq;
    });

    let targetExpression: FaceExpression = this.baseExpression;
    for (const lease of ordered) {
      if (lease.expression && isFaceExpression(lease.expression)) {
        targetExpression = lease.expression;
        break;
      }
    }
    if (!isFaceExpression(targetExpression)) {
      targetExpression = "neutral";
    }

    const prevBehavior = getFaceExpressionBehavior(this.expression);
    const behavior = getFaceExpressionBehavior(targetExpression);

    let targetGaze: EyeGaze = this.baseGaze;
    if (behavior.closedRest) {
      targetGaze = { x: 0, y: 0 };
    } else {
      for (const lease of ordered) {
        if (lease.gaze !== null) {
          targetGaze = lease.gaze;
          break;
        }
      }
    }

    const exprChanged = this.expression !== targetExpression;
    const gazeChanged =
      this.gaze.x !== targetGaze.x || this.gaze.y !== targetGaze.y;
    const blinkReset =
      !behavior.closedRest &&
      (exprChanged || resetInterruptedBlink) &&
      (this.blinkState !== "open" || this.blinkProgress !== 0);

    this.expression = targetExpression;
    this.gaze = { ...targetGaze };

    if (behavior.closedRest) {
      this.clearBlinkTimers();
      this.blinkState = "closed";
      this.blinkProgress = 1.0;
      this.waveformBars = [0, 0, 0, 0, 0];
    } else if (exprChanged || blinkReset) {
      if (prevBehavior.closedRest) {
        this.waveformBars = [0.05, 0.05, 0.05, 0.05, 0.05];
      }
      if (!behavior.allowsBlink || blinkReset) {
        this.clearBlinkTimers();
      }
      if (blinkReset) {
        this.blinkState = "open";
        this.blinkProgress = 0.0;
      }
    }

    if (exprChanged || blinkReset || (emitOnGazeChange && gazeChanged)) {
      this.onStateChange?.();
    }
  }

  public triggerBlink(): void {
    if (!getFaceExpressionBehavior(this.expression).allowsBlink) return;
    this.clearBlinkTimers();
    this.blinkState = "closing";
    this.blinkProgress = 0.5;
    this.onStateChange?.();

    // Simulate fast blink open-close cycle
    this.scheduleBlink(() => {
      this.blinkState = "closed";
      this.blinkProgress = 1.0;
      this.onStateChange?.();
      this.scheduleBlink(() => {
        this.blinkState = "opening";
        this.blinkProgress = 0.5;
        this.onStateChange?.();
        this.scheduleBlink(() => {
          this.blinkState = "open";
          this.blinkProgress = 0.0;
          this.onStateChange?.();
        }, 40);
      }, 40);
    }, 40);
  }

  /** Release pending animation work and dynamic expression registrations when unmounting. */
  public dispose(): void {
    this.clearBlinkTimers();
    for (const unregister of [...this.dynamicDisposers.values()]) {
      unregister();
    }
    this.dynamicDisposers.clear();
  }

  private scheduleBlink(callback: () => void, delayMs: number): void {
    const timer = setTimeout(() => {
      this.blinkTimers = this.blinkTimers.filter((entry) => entry !== timer);
      if (getFaceExpressionBehavior(this.expression).allowsBlink) callback();
    }, delayMs);
    this.blinkTimers.push(timer);
  }

  private clearBlinkTimers(): void {
    this.blinkTimers.forEach(clearTimeout);
    this.blinkTimers = [];
  }

  /**
   * Resonates waveform bars with microphone or assistant TTS audio RMS level (0.0 to 1.0).
   */
  public updateAudioLevel(rms: number): void {
    const behavior = getFaceExpressionBehavior(this.expression);
    if (behavior.closedRest) {
      this.waveformBars = [0, 0, 0, 0, 0];
      return;
    }
    const clampedRms = Math.max(0.0, Math.min(1.0, rms));
    if (!behavior.allowsAudioResonance || clampedRms <= 0.01) {
      this.waveformBars = [0.05, 0.05, 0.05, 0.05, 0.05];
      return;
    }

    // Distribute spectral weighting across 5 bars
    const weights = [0.65, 0.95, 1.0, 0.9, 0.6];
    this.waveformBars = weights.map((w, idx) => {
      const jitter = idx % 2 === 0 ? 0.08 : -0.06;
      return Math.max(0.05, Math.min(1.0, clampedRms * w + jitter));
    });
  }

  /**
   * Request the adapter's local emergency stop and report measured latency.
   * Physical response time depends on the native/hardware adapter.
   */
  public async triggerLocalEmergencyStop(): Promise<{
    latencyMs: number;
    success: boolean;
  }> {
    const startMs = Date.now();
    try {
      this.setHostPresence({ systemCritical: "alarmed" });
      if (this.emergencyStopHandler) {
        await this.emergencyStopHandler.stop("user_stop");
      }
      return {
        latencyMs: Date.now() - startMs,
        success: true,
      };
    } catch {
      return {
        latencyMs: Date.now() - startMs,
        success: false,
      };
    }
  }
}
