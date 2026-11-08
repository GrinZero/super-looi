import {
  FACE_EXPRESSION_IDS,
  getFaceExpressionBehavior,
  isFaceExpression,
  type FaceExpression,
  type FaceExpressionBehavior,
} from "../shell/presence-state.js";
import type { BodySupervisorState } from "@super-looi/contracts";

export {
  FACE_EXPRESSION_IDS,
  getFaceExpressionBehavior,
  isFaceExpression,
  type FaceExpression,
  type FaceExpressionBehavior,
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

export class RobotFaceController {
  private expression: FaceExpression = "neutral";
  private gaze: EyeGaze = { x: 0, y: 0 };
  private blinkState: BlinkState = "open";
  private blinkProgress = 0.0;
  private waveformBars = [0.05, 0.05, 0.05, 0.05, 0.05];
  private bodyState: BodySupervisorState = "disconnected";
  private emergencyStopHandler?: EmergencyStopHandler;
  private onStateChange?: () => void;
  private blinkTimers: Array<ReturnType<typeof setTimeout>> = [];

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

  public setExpression(expression: FaceExpression): void {
    const prevBehavior = getFaceExpressionBehavior(this.expression);
    const behavior = getFaceExpressionBehavior(expression);
    const changed = this.expression !== expression;
    const blinkReset =
      !behavior.closedRest &&
      (this.blinkState !== "open" || this.blinkProgress !== 0);
    this.expression = expression;
    if (behavior.closedRest) {
      this.clearBlinkTimers();
      this.blinkState = "closed";
      this.blinkProgress = 1.0;
      this.waveformBars = [0, 0, 0, 0, 0];
    } else {
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
    if (changed || blinkReset) this.onStateChange?.();
  }

  public setGaze(x: number, y: number): void {
    this.gaze = {
      x: Math.max(-1.0, Math.min(1.0, x)),
      y: Math.max(-1.0, Math.min(1.0, y)),
    };
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

  /** Release pending animation work when the owning screen unmounts. */
  public dispose(): void {
    this.clearBlinkTimers();
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
      this.setExpression("alarmed");
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

/**
 * Landscape Keep-Awake policy manager:
 * Keeps the screen awake when docked and captureMode !== 'off'.
 * Releases wake lock when undocked or in privacy pause to save battery/thermals.
 */
export class KeepAwakeController {
  private isDocked = false;
  private captureMode: "off" | "foreground_explicit" | "docked_context" =
    "docked_context";
  private nativeKeepAwakeActive = false;

  public updatePolicy(
    isDocked: boolean,
    captureMode: "off" | "foreground_explicit" | "docked_context",
  ): boolean {
    this.isDocked = isDocked;
    this.captureMode = captureMode;
    const shouldKeepAwake = this.isDocked && this.captureMode !== "off";
    this.nativeKeepAwakeActive = shouldKeepAwake;
    return shouldKeepAwake;
  }

  public isKeepAwakeActive(): boolean {
    return this.nativeKeepAwakeActive;
  }
}
