import type { FaceExpression } from "../generated/looi-runtime.js";

export type { FaceExpression };

export type FaceTint =
  | "warm"
  | "ivory"
  | "coral"
  | "amber"
  | "sage"
  | "rose"
  | "mist";

export type EyeShapeKind =
  | "orb"
  | "crescent_up"
  | "crescent_down"
  | "line"
  | "chevron"
  | "heart"
  | "star4"
  | "spiral";

export interface EyelidClipSpec {
  /** Fraction of eye diameter (0..0.85) masked from the top edge. */
  top?: number;
  /** Fraction of eye diameter (0..0.85) masked from the bottom edge. */
  bottom?: number;
  /** Rotation of the eyelid cut in degrees (clockwise in screen space). */
  angleDeg?: number;
}

export interface BrowSpec {
  angleDeg: number;
  lift?: number;
  span?: number;
  flat?: boolean;
}

export interface EyeSpec {
  shape?: EyeShapeKind;
  scale?: number;
  dx?: number;
  dy?: number;
  opacity?: number;
  eyelid?: EyelidClipSpec;
  brow?: BrowSpec;
  underArc?: boolean;
  rippleRings?: number;
}

export type MouthKind =
  | "none"
  | "smile"
  | "wide_smile"
  | "open_d"
  | "smirk"
  | "flat"
  | "dot"
  | "circle_o"
  | "oval_yawn"
  | "pout"
  | "pout_puff"
  | "wavy"
  | "cat_w"
  | "caret"
  | "kiss_3"
  | "mute_x"
  | "dots_3";

export interface MouthSpec {
  kind: MouthKind;
  dx?: number;
  dy?: number;
  scale?: number;
  tiltDeg?: number;
  opacity?: number;
}

export type FaceGlyphKind =
  | "spark_exclaim"
  | "star_sparkle"
  | "forehead_star"
  | "question"
  | "blush"
  | "heart_float"
  | "teardrop"
  | "corner_tear"
  | "gloom_lines"
  | "sweat_drop"
  | "sigh_puff"
  | "zzz"
  | "coffee_cup"
  | "chew_cheeks"
  | "straw_cup"
  | "music_notes"
  | "glasses"
  | "scan_trails"
  | "timer_clock"
  | "confetti"
  | "terminal_prompt"
  | "magnifier"
  | "checkmark"
  | "warning_bang"
  | "memory_dots"
  | "hourglass"
  | "offline_wave"
  | "lightning"
  | "wifi_arcs"
  | "sun_rays"
  | "raindrops";

export interface FaceExpressionRecipe {
  tint?: FaceTint;
  ambientOpacity?: number;
  allowsBreath?: boolean;
  eyes: readonly [EyeSpec, EyeSpec];
  mouth: MouthSpec;
  glyphs?: readonly FaceGlyphKind[];
}

function symEyes(
  base: Omit<EyeSpec, "brow"> & { mirrorBrowAngleDeg?: number; browLift?: number; browSpan?: number } = {},
): readonly [EyeSpec, EyeSpec] {
  const { mirrorBrowAngleDeg, browLift, browSpan, ...rest } = base;
  if (mirrorBrowAngleDeg === undefined) {
    return [{ ...rest }, { ...rest }];
  }
  return [
    {
      ...rest,
      brow: { angleDeg: mirrorBrowAngleDeg, lift: browLift, span: browSpan },
    },
    {
      ...rest,
      brow: { angleDeg: -mirrorBrowAngleDeg, lift: browLift, span: browSpan },
    },
  ];
}

function slantedEyes(
  base: Omit<EyeSpec, "eyelid">,
  eyelid: { top?: number; bottom?: number; inwardAngleDeg: number },
): readonly [EyeSpec, EyeSpec] {
  return [
    {
      ...base,
      eyelid: {
        top: eyelid.top,
        bottom: eyelid.bottom,
        angleDeg: eyelid.inwardAngleDeg,
      },
    },
    {
      ...base,
      eyelid: {
        top: eyelid.top,
        bottom: eyelid.bottom,
        angleDeg: -eyelid.inwardAngleDeg,
      },
    },
  ];
}

/**
 * Declarative 72-expression catalog (#01-#72) on the 620 x 340 OLED stage.
 * Zero pupils and zero glossy eyeball glints: every eye is a solid luminous primitive or clean stroke.
 */
export const FACE_EXPRESSION_RECIPES: Record<
  FaceExpression,
  FaceExpressionRecipe
> = {
  // ---------------- Group 1: Core Presence & Voice (#01-#12) ----------------
  neutral: {
    eyes: symEyes(),
    mouth: { kind: "smile" },
  },
  listening: {
    eyes: symEyes({ scale: 1.06, dy: -4, mirrorBrowAngleDeg: -4, browLift: -4 }),
    mouth: { kind: "smile" },
  },
  thinking: {
    eyes: [
      { scale: 0.9, dx: -6, dy: -7, brow: { angleDeg: -10, lift: -3 } },
      { scale: 0.94, dx: -6, dy: -10, brow: { angleDeg: 4, lift: -7 } },
    ],
    mouth: { kind: "flat", opacity: 0.9 },
  },
  speaking: {
    eyes: symEyes({ scale: 1.03, dy: -2 }),
    mouth: { kind: "smile" },
  },
  curious: {
    eyes: [
      { scale: 0.86, dx: 4, dy: 4, brow: { angleDeg: -4, lift: 2 } },
      { scale: 1.08, dx: -2, dy: -6, brow: { angleDeg: 8, lift: -8 } },
    ],
    mouth: { kind: "smile", dx: 3, dy: -1 },
  },
  sleeping: {
    allowsBreath: false,
    eyes: symEyes({ shape: "line", opacity: 0.4 }),
    mouth: { kind: "flat", opacity: 0.28 },
  },
  alarmed: {
    tint: "coral",
    allowsBreath: false,
    eyes: symEyes({ scale: 0.95, dy: -3, mirrorBrowAngleDeg: 15, browLift: -5 }),
    mouth: { kind: "circle_o" },
  },
  wake_spark: {
    tint: "ivory",
    eyes: symEyes({ scale: 1.04, dy: 2, mirrorBrowAngleDeg: -6, browLift: -10 }),
    mouth: { kind: "smile" },
    glyphs: ["spark_exclaim"],
  },
  aha_eureka: {
    tint: "ivory",
    eyes: symEyes({ scale: 1.02, dy: 2, mirrorBrowAngleDeg: -3, browLift: -8 }),
    mouth: { kind: "smile" },
    glyphs: ["star_sparkle"],
  },
  confused: {
    eyes: [
      { scale: 1.02, dx: 2, dy: 2, brow: { angleDeg: -6, lift: -6 } },
      { scale: 0.88, dx: -2, dy: 6, brow: { angleDeg: 12, lift: -2 } },
    ],
    mouth: { kind: "wavy", scale: 0.9 },
    glyphs: ["question"],
  },
  interrupted: {
    eyes: symEyes({ scale: 0.88, dy: 0 }),
    mouth: { kind: "dot" },
  },
  wave_bye: {
    eyes: symEyes({ shape: "crescent_up", scale: 0.95 }),
    mouth: { kind: "wide_smile", scale: 0.96 },
  },

  // ---------------- Group 2: Joy, Affection & Charm (#13-#24) ----------------
  happy_squint: {
    eyes: symEyes({ shape: "crescent_up", scale: 1 }),
    mouth: { kind: "wide_smile" },
  },
  laughing: {
    eyes: symEyes({ shape: "chevron", scale: 1, dy: -4 }),
    mouth: { kind: "open_d", scale: 1.08, dy: -4 },
  },
  wink: {
    eyes: [
      { shape: "orb", scale: 0.98 },
      { shape: "crescent_up", scale: 0.92, dy: 4 },
    ],
    mouth: { kind: "smirk", dx: 4 },
  },
  love_eyes: {
    tint: "rose",
    eyes: symEyes({ shape: "heart", scale: 0.96, dy: -2 }),
    mouth: { kind: "smile" },
  },
  shy_blush: {
    eyes: [
      { scale: 0.94, dx: 10, dy: 4 },
      { scale: 0.94, dx: -10, dy: 4 },
    ],
    mouth: { kind: "wavy", scale: 0.84, dy: 2 },
    glyphs: ["blush"],
  },
  starry_eyed: {
    tint: "ivory",
    eyes: symEyes({ shape: "star4", scale: 0.96, dy: -2 }),
    mouth: { kind: "smile" },
    glyphs: ["star_sparkle"],
  },
  smug_proud: {
    eyes: [
      {
        scale: 0.92,
        eyelid: { top: 0.44 },
        brow: { angleDeg: 0, lift: -10, flat: true },
      },
      {
        scale: 0.92,
        eyelid: { top: 0.44 },
        brow: { angleDeg: 6, lift: -14 },
      },
    ],
    mouth: { kind: "smirk", dx: 6 },
  },
  kitty_playful: {
    eyes: symEyes({ scale: 1.04, dy: -2 }),
    mouth: { kind: "cat_w" },
  },
  touched_warm: {
    eyes: [
      { scale: 1.02, dy: 2, brow: { angleDeg: -14, lift: -8 }, underArc: true },
      { scale: 1.02, dy: 2, brow: { angleDeg: 14, lift: -8 }, underArc: true },
    ],
    mouth: { kind: "smile", scale: 0.92, dy: 4 },
  },
  kissy: {
    eyes: [
      { shape: "orb", scale: 0.98 },
      { shape: "crescent_up", scale: 0.9, dy: 4 },
    ],
    mouth: { kind: "kiss_3" },
    glyphs: ["heart_float"],
  },
  excited_bounce: {
    tint: "ivory",
    eyes: symEyes({ scale: 1.06, dy: 2, mirrorBrowAngleDeg: -6, browLift: -12 }),
    mouth: { kind: "open_d", scale: 0.82, dy: 4 },
    glyphs: ["star_sparkle"],
  },
  zen_content: {
    eyes: symEyes({ shape: "crescent_down", scale: 0.96, dy: 4 }),
    mouth: { kind: "smile", scale: 0.94 },
  },

  // ---------------- Group 3: Moods, Sassy & Quirky (#25-#36) ----------------
  pouty: {
    eyes: symEyes({ scale: 0.98, dy: 6, mirrorBrowAngleDeg: -16, browLift: -6 }),
    mouth: { kind: "pout" },
  },
  sad_droop: {
    eyes: [
      {
        scale: 0.94,
        dy: 8,
        eyelid: { top: 0.36, angleDeg: -14 },
        brow: { angleDeg: -18, lift: -8 },
      },
      {
        scale: 0.94,
        dy: 8,
        eyelid: { top: 0.36, angleDeg: 14 },
        brow: { angleDeg: 18, lift: -8 },
      },
    ],
    mouth: { kind: "pout", scale: 0.85, dy: 4 },
  },
  teary_cry: {
    eyes: symEyes({ scale: 0.98, dy: 4, mirrorBrowAngleDeg: -16, browLift: -6 }),
    mouth: { kind: "wavy", scale: 1.05 },
    glyphs: ["teardrop"],
  },
  grumpy_puff: {
    eyes: [
      { scale: 0.96, dx: -8, eyelid: { top: 0.34 } },
      { scale: 0.96, dx: -8, eyelid: { top: 0.34 } },
    ],
    mouth: { kind: "pout_puff", dx: -6 },
  },
  angry_glare: {
    tint: "amber",
    eyes: [
      {
        scale: 0.98,
        dy: 4,
        eyelid: { top: 0.38, angleDeg: 18 },
        brow: { angleDeg: 18, lift: 6, span: 1.15 },
      },
      {
        scale: 0.98,
        dy: 4,
        eyelid: { top: 0.38, angleDeg: -18 },
        brow: { angleDeg: -18, lift: 6, span: 1.15 },
      },
    ],
    mouth: { kind: "caret" },
  },
  speechless: {
    eyes: symEyes({ scale: 0.96, dy: 4, eyelid: { top: 0.5 } }),
    mouth: { kind: "flat", scale: 1.25 },
    glyphs: ["gloom_lines"],
  },
  side_eye: {
    eyes: [
      { scale: 0.94, dx: 24, eyelid: { top: 0.28 } },
      { scale: 0.94, dx: 24, eyelid: { top: 0.28 } },
    ],
    mouth: { kind: "dot" },
  },
  shocked: {
    tint: "ivory",
    eyes: symEyes({ scale: 0.68, dy: 2, mirrorBrowAngleDeg: -4, browLift: -22 }),
    mouth: { kind: "circle_o", scale: 1.25 },
  },
  dizzy_spiral: {
    eyes: symEyes({ shape: "spiral", scale: 0.96 }),
    mouth: { kind: "wavy", scale: 1.1 },
  },
  nervous_sweat: {
    eyes: [
      { scale: 0.96, dx: 8, dy: 2 },
      { scale: 0.96, dx: 8, dy: 2 },
    ],
    mouth: { kind: "smile", scale: 0.78, dy: 2 },
    glyphs: ["sweat_drop"],
  },
  mischievous: {
    tint: "amber",
    eyes: slantedEyes({ scale: 0.96, dy: 2 }, { top: 0.38, inwardAngleDeg: 16 }),
    mouth: { kind: "smirk", dx: 8 },
  },
  relieved_sigh: {
    eyes: symEyes({ shape: "crescent_down", scale: 0.94, dy: -4 }),
    mouth: { kind: "circle_o", scale: 0.72, dy: -2 },
    glyphs: ["sigh_puff"],
  },

  // ---------------- Group 4: Desktop Companion & Daily Life (#37-#48) ----------------
  sleepy_drowsy: {
    ambientOpacity: 0.88,
    eyes: [
      { scale: 0.96, dy: 10, eyelid: { top: 0.58, angleDeg: -4 } },
      { scale: 0.96, dy: 10, eyelid: { top: 0.58, angleDeg: 4 } },
    ],
    mouth: { kind: "flat", scale: 0.85, dy: 4 },
  },
  yawning: {
    eyes: symEyes({ shape: "chevron", scale: 0.92, dy: -6 }),
    mouth: { kind: "oval_yawn", dy: -6 },
    glyphs: ["corner_tear"],
  },
  deep_snore: {
    allowsBreath: false,
    ambientOpacity: 0.84,
    eyes: symEyes({ shape: "crescent_down", scale: 0.9, dy: 16 }),
    mouth: { kind: "none" },
    glyphs: ["zzz"],
  },
  coffee_sip: {
    eyes: symEyes({ shape: "crescent_up", scale: 0.88, dy: -12 }),
    mouth: { kind: "none" },
    glyphs: ["coffee_cup"],
  },
  munching: {
    eyes: symEyes({ shape: "crescent_up", scale: 0.88, dy: -14 }),
    mouth: { kind: "cat_w", scale: 1.08, dy: -6 },
    glyphs: ["chew_cheeks"],
  },
  sipping_straw: {
    eyes: [
      { scale: 0.9, dx: 12, dy: -18 },
      { scale: 0.9, dx: -12, dy: -18 },
    ],
    mouth: { kind: "none" },
    glyphs: ["straw_cup"],
  },
  music_vibe: {
    eyes: symEyes({ shape: "crescent_up", scale: 0.9, dy: 2 }),
    mouth: { kind: "smile", scale: 0.94, dy: 4 },
    glyphs: ["music_notes"],
  },
  focus_glasses: {
    eyes: symEyes({ scale: 0.86, dy: 2 }),
    mouth: { kind: "flat", scale: 0.88, dy: 8 },
    glyphs: ["glasses"],
  },
  reading_scan: {
    eyes: [
      { scale: 0.92, dx: 12, dy: 4 },
      { scale: 0.92, dx: 12, dy: 4 },
    ],
    mouth: { kind: "flat", scale: 0.92, dy: 4 },
    glyphs: ["scan_trails"],
  },
  pomodoro_timer: {
    eyes: symEyes({ scale: 0.94, dy: 12 }),
    mouth: { kind: "smile", scale: 0.88, dy: 8 },
    glyphs: ["timer_clock"],
  },
  celebrate_party: {
    tint: "ivory",
    eyes: symEyes({ shape: "crescent_up", scale: 0.94, dy: -4 }),
    mouth: { kind: "open_d", scale: 0.96, dy: 2 },
    glyphs: ["confetti"],
  },
  bored_sigh: {
    eyes: symEyes({ scale: 0.92, dy: -6, mirrorBrowAngleDeg: 14, browLift: -8 }),
    mouth: { kind: "flat", scale: 1.2, tiltDeg: -10, dy: 4 },
  },

  // ---------------- Group 5: Agent Work & Tool States (#49-#60) ----------------
  coding_terminal: {
    eyes: symEyes({ scale: 0.92, dy: 4 }),
    mouth: { kind: "flat", scale: 1.1, dy: 4 },
    glyphs: ["terminal_prompt"],
  },
  searching_radar: {
    eyes: [
      { scale: 0.86, dx: -6, dy: 4 },
      { scale: 0.9, dx: 2, dy: 2 },
    ],
    mouth: { kind: "flat", scale: 0.95, dx: -16, dy: 6 },
    glyphs: ["magnifier"],
  },
  approval_ask: {
    eyes: symEyes({ scale: 1.02, dy: 4, mirrorBrowAngleDeg: -5, browLift: -8 }),
    mouth: { kind: "smile", scale: 0.86, dy: 4 },
  },
  task_verified: {
    tint: "sage",
    eyes: symEyes({ shape: "crescent_up", scale: 0.92 }),
    mouth: { kind: "smile", scale: 0.96 },
    glyphs: ["checkmark"],
  },
  task_warning: {
    tint: "amber",
    eyes: symEyes({ scale: 0.94, dy: 8, mirrorBrowAngleDeg: -14, browLift: -6 }),
    mouth: { kind: "pout", scale: 0.82, dy: 4 },
    glyphs: ["warning_bang"],
  },
  memory_recall: {
    eyes: [
      { scale: 0.96, dx: 8, dy: 2 },
      { scale: 0.96, dx: 8, dy: 2 },
    ],
    mouth: { kind: "smile", scale: 0.92, dy: 2 },
    glyphs: ["memory_dots"],
  },
  memory_saved: {
    tint: "ivory",
    eyes: symEyes({ shape: "crescent_down", scale: 0.9, dy: 10 }),
    mouth: { kind: "smile", scale: 0.94, dy: 6 },
    glyphs: ["forehead_star"],
  },
  sync_pulse: {
    eyes: symEyes({ scale: 0.94, dy: 0 }),
    mouth: { kind: "dots_3" },
  },
  privacy_shield: {
    allowsBreath: false,
    ambientOpacity: 0.78,
    eyes: symEyes({ shape: "line", opacity: 0.72 }),
    mouth: { kind: "mute_x" },
  },
  rate_limited: {
    eyes: symEyes({ scale: 0.92, dy: 8, eyelid: { top: 0.52 } }),
    mouth: { kind: "wavy", scale: 1.05, dy: 2 },
    glyphs: ["hourglass"],
  },
  offline_lost: {
    ambientOpacity: 0.74,
    eyes: symEyes({ scale: 0.94, dy: 4 }),
    mouth: { kind: "flat", scale: 0.92, dy: 4 },
    glyphs: ["offline_wave"],
  },
  night_watch: {
    allowsBreath: false,
    ambientOpacity: 0.42,
    eyes: symEyes({ scale: 0.34, dy: 0 }),
    mouth: { kind: "flat", scale: 0.5, opacity: 0.24 },
  },

  // ---------------- Group 6: Embodied Dock, Smart Home & Weather (#61-#72) ----------------
  dock_snap: {
    tint: "ivory",
    eyes: symEyes({ scale: 0.88, rippleRings: 2 }),
    mouth: { kind: "smile", scale: 0.96, dy: 4 },
  },
  undock_float: {
    eyes: symEyes({ scale: 0.92, dy: 6 }),
    mouth: { kind: "circle_o", scale: 0.88, dy: 2 },
  },
  drive_forward: {
    eyes: slantedEyes({ scale: 0.94, dy: 2 }, { top: 0.44, inwardAngleDeg: 14 }),
    mouth: { kind: "smirk", dx: 6, dy: 0 },
  },
  turn_peek: {
    eyes: [
      { scale: 0.88, dx: 28, dy: 4 },
      { scale: 0.98, dx: 24, dy: 2 },
    ],
    mouth: { kind: "smile", dx: 24, dy: 4 },
  },
  head_up_sky: {
    tint: "ivory",
    eyes: symEyes({ scale: 0.94, dy: -6, mirrorBrowAngleDeg: -4, browLift: -8 }),
    mouth: { kind: "circle_o", scale: 0.82, dy: 2 },
  },
  head_down_floor: {
    eyes: symEyes({ scale: 0.88, dy: 82 }),
    mouth: { kind: "dot", dy: 34 },
  },
  charging_pulse: {
    tint: "sage",
    eyes: symEyes({ shape: "crescent_up", scale: 0.9, dy: 12 }),
    mouth: { kind: "none" },
    glyphs: ["lightning"],
  },
  low_battery: {
    tint: "coral",
    ambientOpacity: 0.82,
    eyes: symEyes({ scale: 0.92, dy: 6, eyelid: { top: 0.48 } }),
    mouth: { kind: "wavy", scale: 1.05, dy: 4 },
  },
  fill_light_glow: {
    tint: "ivory",
    eyes: symEyes({ scale: 1.08, dy: 0 }),
    mouth: { kind: "smile", scale: 0.98, dy: 6 },
  },
  home_command: {
    eyes: symEyes({ scale: 0.94, dy: 6 }),
    mouth: { kind: "smile", scale: 0.94, dy: 6 },
    glyphs: ["wifi_arcs"],
  },
  weather_sunny: {
    tint: "amber",
    eyes: symEyes({ shape: "crescent_up", scale: 0.92, dy: 8 }),
    mouth: { kind: "smile", scale: 0.96, dy: 8 },
    glyphs: ["sun_rays"],
  },
  weather_rain_chill: {
    tint: "mist",
    eyes: symEyes({ scale: 0.92, dy: 6 }),
    mouth: { kind: "smile", scale: 0.84, dy: 6 },
    glyphs: ["raindrops"],
  },
};

export const FACE_EXPRESSION_IDS = Object.freeze(
  Object.keys(FACE_EXPRESSION_RECIPES) as FaceExpression[],
);
