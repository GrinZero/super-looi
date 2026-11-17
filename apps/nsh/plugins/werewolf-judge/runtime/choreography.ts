import type {
  BodyServoLease,
  EffectScope,
  FaceLease,
  PluginBodyCapability,
  PluginFaceCapability,
  PluginStagePresentation,
  ScopedExpressionId,
} from "../../../runtime/plugins/contracts.js";
import type {
  WerewolfMotionMode,
  WerewolfPhase,
  WerewolfSheriffSubphase,
  WerewolfSurfaceMode,
} from "../contracts.js";
import { defaultCsprngInt, type RandomIntFn } from "./presets.js";

export type WerewolfFaceSlot =
  | "judge_lobby"
  | "night_slumber"
  | "wolf_prowl"
  | "witch_brew"
  | "seer_oracle"
  | "guard_shield"
  | "dawn_solemn"
  | "victory_party";

export const WEREWOLF_DYNAMIC_FACE_RECIPES: Readonly<
  Record<
    WerewolfFaceSlot,
    {
      readonly recipe: Record<string, unknown>;
      readonly closedRest?: boolean;
      readonly allowsBlink?: boolean;
      readonly allowsAudioResonance?: boolean;
    }
  >
> = {
  judge_lobby: {
    recipe: {
      tint: "ivory",
      ambientOpacity: 0.92,
      allowsBreath: true,
      eyes: [
        { shape: "orb", scale: 1.0, brow: { angleDeg: -4, lift: -5 } },
        { shape: "orb", scale: 1.0, brow: { angleDeg: 4, lift: -5 } },
      ],
      mouth: { kind: "smile" },
    },
  },
  night_slumber: {
    closedRest: true,
    allowsBlink: false,
    allowsAudioResonance: false,
    recipe: {
      tint: "mist",
      ambientOpacity: 0.48,
      allowsBreath: true,
      eyes: [
        { shape: "crescent_down", scale: 0.9, opacity: 0.65 },
        { shape: "crescent_down", scale: 0.9, opacity: 0.65 },
      ],
      mouth: { kind: "flat", scale: 0.72, opacity: 0.55 },
      glyphs: ["zzz"],
    },
  },
  wolf_prowl: {
    recipe: {
      tint: "ivory",
      ambientOpacity: 0.76,
      allowsBreath: true,
      eyes: [
        { shape: "orb", scale: 0.94, eyelid: { top: 0.44, angleDeg: 8 } },
        { shape: "orb", scale: 0.94, eyelid: { top: 0.44, angleDeg: -8 } },
      ],
      mouth: { kind: "smile", scale: 0.88 },
    },
  },
  witch_brew: {
    recipe: {
      tint: "ivory",
      ambientOpacity: 0.78,
      allowsBreath: true,
      eyes: [
        { shape: "orb", scale: 0.94, eyelid: { top: 0.48 } },
        { shape: "orb", scale: 0.94, eyelid: { top: 0.48 } },
      ],
      mouth: { kind: "smile", scale: 0.9 },
    },
  },
  seer_oracle: {
    recipe: {
      tint: "ivory",
      ambientOpacity: 0.82,
      allowsBreath: true,
      eyes: [
        { shape: "orb", scale: 0.96, eyelid: { top: 0.36 } },
        { shape: "orb", scale: 0.96, eyelid: { top: 0.36 } },
      ],
      mouth: { kind: "smile", scale: 0.9 },
      glyphs: ["star_sparkle"],
    },
  },
  guard_shield: {
    recipe: {
      tint: "mist",
      ambientOpacity: 0.76,
      allowsBreath: true,
      eyes: [
        { shape: "orb", scale: 0.95, eyelid: { top: 0.42 } },
        { shape: "orb", scale: 0.95, eyelid: { top: 0.42 } },
      ],
      mouth: { kind: "flat", scale: 0.86 },
    },
  },
  dawn_solemn: {
    recipe: {
      tint: "ivory",
      ambientOpacity: 0.9,
      allowsBreath: true,
      eyes: [
        { shape: "orb", scale: 0.92 },
        { shape: "orb", scale: 0.92 },
      ],
      mouth: { kind: "smile", scale: 0.92 },
      glyphs: ["glasses"],
    },
  },
  victory_party: {
    recipe: {
      tint: "warm",
      ambientOpacity: 0.95,
      allowsBreath: true,
      eyes: [
        { shape: "chevron", scale: 1.06, dy: -3 },
        { shape: "chevron", scale: 1.06, dy: -3 },
      ],
      mouth: { kind: "open_d", scale: 1.08, dy: -3 },
      glyphs: ["confetti", "spark_exclaim"],
    },
  },
};

export function computeFaceCenteringTurn(offsetX: number): {
  readonly aligned: boolean;
  readonly turn: number;
} {
  if (!Number.isFinite(offsetX) || Math.abs(offsetX) <= 0.08) {
    return { aligned: true, turn: 0 };
  }
  const rawTurn = Math.round(-offsetX * 48);
  const clampedTurn = Math.max(-55, Math.min(55, rawTurn));
  return { aligned: false, turn: clampedTurn };
}

export function computeHeadPitchDegrees(baseDegrees: number, offsetY = 0): number {
  const adjusted = Math.round(baseDegrees - offsetY * 12);
  return Math.max(32, Math.min(78, adjusted));
}

export function computeDeadRoleMaskDelayMs(
  randomInt: RandomIntFn = defaultCsprngInt,
): number {
  // Strictly [6000, 9000] ms jittered window to defeat timing side-channels.
  return 6000 + randomInt(3001);
}

export function resolveStagePresentation(input: {
  readonly phase: WerewolfPhase;
  readonly sheriffSubphase: WerewolfSheriffSubphase | null;
  readonly surfaceMode: WerewolfSurfaceMode;
}): PluginStagePresentation | null {
  const { phase, sheriffSubphase, surfaceMode } = input;
  switch (phase) {
    case "idle":
      return null;

    case "lobby":
      return {
        active: true,
        facePosture: { kind: "floating_top", scale: 0.18, chrome: "frameless" },
        drawerDetent: "closed",
        capsulePlacement: "top_bar",
        allowUserSwipeCollapse: false,
        hideDefaultDock: true,
      };

    case "dealing":
      return {
        active: true,
        facePosture: { kind: "split_left", widthRatio: 0.34 },
        drawerDetent: "closed",
        capsulePlacement: "top_bar",
        allowUserSwipeCollapse: false,
        hideDefaultDock: true,
        confirmSystemBackExit: true,
      };

    case "night_intro":
    case "dawn_settle":
      return {
        active: true,
        facePosture: { kind: "full" },
        drawerDetent: "closed",
        capsulePlacement: "top_bar",
        allowUserSwipeCollapse: false,
        hideDefaultDock: true,
        confirmSystemBackExit: true,
      };

    case "night_guard":
    case "night_wolf":
    case "night_witch":
    case "night_seer":
      if (surfaceMode === "lan_companion") {
        return {
          active: true,
          facePosture: { kind: "full" },
          drawerDetent: "peek",
          capsulePlacement: "top_bar",
          allowUserSwipeCollapse: true,
          hideDefaultDock: true,
          confirmSystemBackExit: true,
        };
      }
      return {
        active: true,
        facePosture: { kind: "floating_top", scale: 0.18, chrome: "frameless" },
        drawerDetent: "closed",
        capsulePlacement: "top_bar",
        allowUserSwipeCollapse: false,
        hideDefaultDock: true,
        confirmSystemBackExit: true,
      };

    case "sheriff_election":
      if (sheriffSubphase === "speech" || sheriffSubphase === "pk_speech") {
        return {
          active: true,
          facePosture: { kind: "split_left", widthRatio: 0.32 },
          drawerDetent: "closed",
          capsulePlacement: "top_bar",
          allowUserSwipeCollapse: false,
          hideDefaultDock: true,
          confirmSystemBackExit: true,
        };
      }
      return {
        active: true,
        facePosture: { kind: "floating_top", scale: 0.18, chrome: "frameless" },
        drawerDetent: "closed",
        capsulePlacement: "top_bar",
        allowUserSwipeCollapse: false,
        hideDefaultDock: true,
        confirmSystemBackExit: true,
      };

    case "dawn_announce":
    case "day_discussion":
    case "day_pk_speech":
      return {
        active: true,
        facePosture: { kind: "split_left", widthRatio: 0.32 },
        drawerDetent: "closed",
        capsulePlacement: "top_bar",
        allowUserSwipeCollapse: false,
        hideDefaultDock: true,
        confirmSystemBackExit: true,
      };

    case "leave_resolution":
      return {
        active: true,
        facePosture: { kind: "floating_top", scale: 0.18, chrome: "frameless" },
        drawerDetent: "closed",
        capsulePlacement: "top_bar",
        allowUserSwipeCollapse: false,
        hideDefaultDock: true,
        confirmSystemBackExit: true,
      };

    case "day_voting":
    case "day_pk_voting":
      return {
        active: true,
        facePosture: { kind: "floating_top", scale: 0.18, chrome: "frameless" },
        drawerDetent: "closed",
        capsulePlacement: "top_bar",
        allowUserSwipeCollapse: false,
        hideDefaultDock: true,
        confirmSystemBackExit: true,
      };

    case "game_over":
      return {
        active: true,
        facePosture: { kind: "split_left", widthRatio: 0.3 },
        drawerDetent: "closed",
        capsulePlacement: "top_bar",
        allowUserSwipeCollapse: false,
        hideDefaultDock: true,
      };
  }
}

export function defaultAbortableSleep(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface WerewolfChoreographyOptions {
  readonly face?: PluginFaceCapability;
  readonly body?: PluginBodyCapability;
  readonly pluginScope: EffectScope;
  readonly randomInt?: RandomIntFn;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly onTimingMaskScheduled?: (info: {
    readonly role: "guard" | "witch" | "seer";
    readonly plannedDelayMs: number;
  }) => void;
  readonly onDecoySweepExecuted?: (info: {
    readonly pulses: ReadonlyArray<{ readonly speed: 0; readonly turn: number; readonly durationMs: number }>;
  }) => void;
}

export class WerewolfChoreographer {
  private readonly randomInt: RandomIntFn;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly expressionIds = new Map<WerewolfFaceSlot, ScopedExpressionId>();

  private activeFaceLease: FaceLease | null = null;
  private activeServoLease: BodyServoLease | null = null;
  private servoPreempted = false;

  constructor(private readonly options: WerewolfChoreographyOptions) {
    this.randomInt = options.randomInt ?? defaultCsprngInt;
    this.sleep = options.sleep ?? defaultAbortableSleep;
    this.registerExpressions();
  }

  private registerExpressions(): void {
    const face = this.options.face;
    if (!face) return;

    const slots = Object.keys(WEREWOLF_DYNAMIC_FACE_RECIPES) as WerewolfFaceSlot[];
    for (const slot of slots) {
      const spec = WEREWOLF_DYNAMIC_FACE_RECIPES[slot];
      const scopedId = face.registerExpression(slot, spec.recipe, {
        closedRest: spec.closedRest,
        allowsBlink: spec.allowsBlink,
        allowsAudioResonance: spec.allowsAudioResonance,
        scope: this.options.pluginScope,
      });
      this.expressionIds.set(slot, scopedId);
    }
  }

  async ensureMatchLeases(matchScope: EffectScope): Promise<void> {
    await this.acquireMatchLeases(matchScope);
  }

  async acquireMatchLeases(matchScope: EffectScope): Promise<void> {
    if (this.options.face && !this.activeFaceLease) {
      const lease = this.options.face.acquireLease("foreground_stage", matchScope);
      this.activeFaceLease = lease;
      matchScope.onDispose(() => {
        if (this.activeFaceLease === lease) {
          this.activeFaceLease = null;
        }
      });
    }

    if (this.options.body && !this.activeServoLease) {
      const status = this.options.body.status();
      if (status.mode !== "disabled" && (status.isDocked || status.simulation)) {
        try {
          const servo = await this.options.body.acquireServo("foreground_stage", matchScope);
          this.activeServoLease = servo;
          this.servoPreempted = false;
          servo.onPreempted(() => {
            this.servoPreempted = true;
            if (this.activeServoLease === servo) {
              this.activeServoLease = null;
            }
          });
          matchScope.onDispose(async () => {
            if (this.activeServoLease === servo) {
              this.activeServoLease = null;
            }
          });
        } catch {
          // Body dock may not be connected; referee continues cleanly with screen + voice.
          this.activeServoLease = null;
        }
      }
    }
  }

  async releaseMatchLeases(): Promise<void> {
    const servo = this.activeServoLease;
    this.activeServoLease = null;
    if (servo) {
      try {
        await servo.setDriveVector(0, 0);
        await servo.setLight(false, 0);
      } catch {
        // Ignore dock disconnect during teardown
      }
      await servo.release();
    }

    const faceLease = this.activeFaceLease;
    this.activeFaceLease = null;
    if (faceLease) {
      faceLease.release();
    }
  }

  setFaceSlot(slot: WerewolfFaceSlot, gaze?: { x: number; y: number } | null): void {
    if (!this.activeFaceLease) return;
    const id = this.expressionIds.get(slot);
    if (id) {
      this.activeFaceLease.setExpression(id);
    }
    if (gaze !== undefined) {
      this.activeFaceLease.setGaze(gaze);
    }
  }

  applyPhaseAtmosphere(phase: WerewolfPhase): void {
    switch (phase) {
      case "lobby":
      case "dealing":
        this.setFaceSlot("judge_lobby", { x: 0, y: 0 });
        void this.safeSetHeadAndLight(60, false, 0);
        break;
      case "night_intro":
      case "dawn_settle":
        this.setFaceSlot("night_slumber", { x: 0, y: 0 });
        void this.safeSetHeadAndLight(44, true, 18);
        break;
      case "night_guard":
        this.setFaceSlot("guard_shield", { x: 0, y: 0.08 });
        void this.safeSetHeadAndLight(42, true, 20);
        break;
      case "night_wolf":
        this.setFaceSlot("wolf_prowl", { x: 0.14, y: 0.06 });
        void this.safeSetHeadAndLight(42, true, 24);
        break;
      case "night_witch":
        this.setFaceSlot("witch_brew", { x: -0.1, y: 0.05 });
        void this.safeSetHeadAndLight(42, true, 22);
        break;
      case "night_seer":
        this.setFaceSlot("seer_oracle", { x: 0, y: -0.05 });
        void this.safeSetHeadAndLight(44, true, 26);
        break;
      case "sheriff_election":
      case "dawn_announce":
      case "day_discussion":
      case "day_pk_speech":
        this.setFaceSlot("dawn_solemn", { x: 0, y: 0 });
        void this.safeSetHeadAndLight(58, false, 0);
        break;
      case "leave_resolution":
      case "day_voting":
      case "day_pk_voting":
        this.setFaceSlot("judge_lobby", { x: 0, y: 0 });
        void this.safeSetHeadAndLight(58, false, 0);
        break;
      case "game_over":
        this.setFaceSlot("victory_party", { x: 0, y: 0 });
        void this.safeSetHeadAndLight(64, true, 45);
        break;
      case "idle":
        break;
    }
  }

  /**
   * Closed-loop visual face alignment step (`speed = 0` strictly enforced).
   */
  async applyVisualTrackingFrame(
    offsetX: number,
    offsetY: number,
    motionMode: WerewolfMotionMode,
    allowWheelAlign: boolean,
  ): Promise<{ readonly aligned: boolean }> {
    if (this.activeFaceLease) {
      this.activeFaceLease.setGaze({
        x: Math.max(-1, Math.min(1, -offsetX * 0.75)),
        y: Math.max(-1, Math.min(1, offsetY * 0.6)),
      });
    }

    const centering = computeFaceCenteringTurn(offsetX);
    const servo = this.usableServo();
    if (!servo || motionMode === "stationary_gaze") {
      return { aligned: centering.aligned };
    }

    await servo.setHeadDegrees(computeHeadPitchDegrees(58, offsetY));
    if (allowWheelAlign) {
      await this.safePivotDrive(servo, centering.turn);
    }
    return { aligned: centering.aligned };
  }

  async stopWheelPivot(): Promise<void> {
    const servo = this.usableServo();
    if (!servo) return;
    await this.safePivotDrive(servo, 0);
  }

  /**
   * Step clockwise to the next seat during `dealing` (`speed = 0` strictly enforced).
   */
  async pivotClockwiseToNextSeat(
    playerCount: number,
    motionMode: WerewolfMotionMode,
    signal?: AbortSignal,
  ): Promise<void> {
    if (motionMode === "stationary_gaze") return;
    const servo = this.usableServo();
    if (!servo) return;

    const pulseMs = Math.max(120, Math.min(340, Math.round(1560 / Math.max(6, playerCount))));
    await this.safePivotDrive(servo, 42);
    await this.sleep(pulseMs, signal);
    await this.safePivotDrive(servo, 0);
  }

  /**
   * Randomized entry + post-turn Acoustic Decoy Sweep so closed-eye players cannot deduce
   * which seat acted from motor sound direction or duration (`speed = 0` strictly enforced).
   */
  async performNightEntrySweep(
    motionMode: WerewolfMotionMode,
    surfaceMode: WerewolfSurfaceMode,
    signal?: AbortSignal,
  ): Promise<void> {
    if (motionMode === "stationary_gaze") return;
    const servo = this.usableServo();
    if (!servo) return;

    const sign = this.randomInt(2) === 0 ? 1 : -1;
    const turn = surfaceMode === "lan_companion" ? 28 * sign : (30 + this.randomInt(16)) * sign;
    const durationMs = surfaceMode === "lan_companion" ? 360 : 260 + this.randomInt(240);

    await this.safePivotDrive(servo, turn);
    await this.sleep(durationMs, signal);
    await this.safePivotDrive(servo, 0);
  }

  async performAcousticDecoySweep(
    motionMode: WerewolfMotionMode,
    signal?: AbortSignal,
  ): Promise<void> {
    if (motionMode === "stationary_gaze") return;
    const servo = this.usableServo();
    const firstSign = this.randomInt(2) === 0 ? 1 : -1;
    const pulseA = {
      speed: 0 as const,
      turn: (28 + this.randomInt(18)) * firstSign,
      durationMs: 220 + this.randomInt(180),
    };
    const pulseB = {
      speed: 0 as const,
      turn: -(26 + this.randomInt(18)) * firstSign,
      durationMs: 220 + this.randomInt(180),
    };
    this.options.onDecoySweepExecuted?.({ pulses: [pulseA, pulseB] });

    if (!servo) return;
    await this.safePivotDrive(servo, pulseA.turn);
    await this.sleep(pulseA.durationMs, signal);
    await this.safePivotDrive(servo, pulseB.turn);
    await this.sleep(pulseB.durationMs, signal);
    await this.safePivotDrive(servo, 0);
  }

  /**
   * Executes the `6–9s` jittered fake-out window for a secretly dead night role.
   */
  async runDeadRoleTimingMask(
    role: "guard" | "witch" | "seer",
    motionMode: WerewolfMotionMode,
    signal?: AbortSignal,
  ): Promise<number> {
    const plannedDelayMs = computeDeadRoleMaskDelayMs(this.randomInt);
    this.options.onTimingMaskScheduled?.({ role, plannedDelayMs });

    const servo = motionMode === "embodied_patrol" ? this.usableServo() : null;
    if (servo) {
      const sign = this.randomInt(2) === 0 ? 1 : -1;
      const patrolMs = Math.min(320, Math.floor(plannedDelayMs / 4));
      await this.safePivotDrive(servo, 26 * sign);
      await this.sleep(patrolMs, signal);
      await this.safePivotDrive(servo, 0);
      await this.sleep(Math.max(0, plannedDelayMs - patrolMs), signal);
    } else {
      await this.sleep(plannedDelayMs, signal);
    }
    return plannedDelayMs;
  }

  /**
   * Tabletop fall-prevention invariant: `speed` is ALWAYS `0`.
   */
  private async safePivotDrive(servo: BodyServoLease, rawTurn: number): Promise<void> {
    const clampedTurn = Math.max(-60, Math.min(60, Math.round(rawTurn)));
    await servo.setDriveVector(0, clampedTurn);
  }

  private async safeSetHeadAndLight(
    headDegrees: number,
    lightOn: boolean,
    brightness: number,
  ): Promise<void> {
    const servo = this.usableServo();
    if (!servo) return;
    try {
      await servo.setHeadDegrees(Math.max(28, Math.min(82, Math.round(headDegrees))));
      await servo.setLight(lightOn, brightness);
    } catch {
      // Ignore transient BLE failure on atmosphere cue
    }
  }

  private usableServo(): BodyServoLease | null {
    if (!this.activeServoLease || this.servoPreempted) return null;
    return this.activeServoLease;
  }
}
