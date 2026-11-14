/** Canonical ordered catalog of all 72 Super-LOOI desktop pet expressions (#01-#72). */
export const FACE_EXPRESSION_IDS = [
  // Group 1: Core Presence & Voice (#01-#12)
  "neutral",
  "listening",
  "thinking",
  "speaking",
  "curious",
  "sleeping",
  "alarmed",
  "wake_spark",
  "aha_eureka",
  "confused",
  "interrupted",
  "wave_bye",
  // Group 2: Joy, Affection & Charm (#13-#24)
  "happy_squint",
  "laughing",
  "wink",
  "love_eyes",
  "shy_blush",
  "starry_eyed",
  "smug_proud",
  "kitty_playful",
  "touched_warm",
  "kissy",
  "excited_bounce",
  "zen_content",
  // Group 3: Moods, Sassy & Quirky (#25-#36)
  "pouty",
  "sad_droop",
  "teary_cry",
  "grumpy_puff",
  "angry_glare",
  "speechless",
  "side_eye",
  "shocked",
  "dizzy_spiral",
  "nervous_sweat",
  "mischievous",
  "relieved_sigh",
  // Group 4: Desktop Companion & Daily Life (#37-#48)
  "sleepy_drowsy",
  "yawning",
  "deep_snore",
  "coffee_sip",
  "munching",
  "sipping_straw",
  "music_vibe",
  "focus_glasses",
  "reading_scan",
  "pomodoro_timer",
  "celebrate_party",
  "bored_sigh",
  // Group 5: Agent Work & Tool States (#49-#60)
  "coding_terminal",
  "searching_radar",
  "approval_ask",
  "task_verified",
  "task_warning",
  "memory_recall",
  "memory_saved",
  "sync_pulse",
  "privacy_shield",
  "rate_limited",
  "offline_lost",
  "night_watch",
  // Group 6: Embodied Dock, Smart Home & Weather (#61-#72)
  "dock_snap",
  "undock_float",
  "drive_forward",
  "turn_peek",
  "head_up_sky",
  "head_down_floor",
  "charging_pulse",
  "low_battery",
  "fill_light_glow",
  "home_command",
  "weather_sunny",
  "weather_rain_chill",
] as const;

export type CanonicalFaceExpression = (typeof FACE_EXPRESSION_IDS)[number];
export type PluginFaceExpressionId = `plugin:${string}:${string}`;
export type FaceExpression = CanonicalFaceExpression | PluginFaceExpressionId;

export interface FaceExpressionBehavior {
  /** Closed-eye resting state: locks blinkProgress at 1.0 and silences waveform bars. */
  closedRest: boolean;
  /** Whether periodic spontaneous blinks may run without clashing with non-orb eye shapes. */
  allowsBlink: boolean;
  /** Whether microphone / TTS audio amplitude updates resonance bars. */
  allowsAudioResonance: boolean;
}

const FACE_EXPRESSION_SET: ReadonlySet<string> = new Set(FACE_EXPRESSION_IDS);
const DYNAMIC_FACE_BEHAVIORS = new Map<PluginFaceExpressionId, FaceExpressionBehavior>();
const DYNAMIC_FACE_BEHAVIOR_REFS = new Map<PluginFaceExpressionId, number>();

const CLOSED_REST_EXPRESSIONS: ReadonlySet<CanonicalFaceExpression> = new Set([
  "sleeping",
  "deep_snore",
  "privacy_shield",
]);

const NON_BLINK_EXPRESSIONS: ReadonlySet<CanonicalFaceExpression> = new Set([
  "sleeping",
  "wave_bye",
  "happy_squint",
  "laughing",
  "wink",
  "love_eyes",
  "starry_eyed",
  "kissy",
  "zen_content",
  "dizzy_spiral",
  "relieved_sigh",
  "yawning",
  "deep_snore",
  "coffee_sip",
  "munching",
  "music_vibe",
  "celebrate_party",
  "task_verified",
  "memory_saved",
  "privacy_shield",
  "charging_pulse",
  "weather_sunny",
]);

export function registerDynamicFaceBehavior(
  id: PluginFaceExpressionId,
  options: Partial<FaceExpressionBehavior> = {},
): () => void {
  if (!/^plugin:[a-z0-9][a-z0-9._-]{1,62}:[a-z0-9_-]{1,64}$/.test(id)) {
    throw Object.assign(new Error(`Invalid scoped expression ID: ${id}`), {
      stage: "face.registerExpression",
      code: "ERR_INVALID_SCOPED_EXPRESSION_ID",
    });
  }
  const closedRest = Boolean(options.closedRest);
  DYNAMIC_FACE_BEHAVIORS.set(id, {
    closedRest,
    allowsBlink: closedRest ? false : (options.allowsBlink ?? true),
    allowsAudioResonance: closedRest ? false : (options.allowsAudioResonance ?? true),
  });
  DYNAMIC_FACE_BEHAVIOR_REFS.set(id, (DYNAMIC_FACE_BEHAVIOR_REFS.get(id) ?? 0) + 1);
  let unregistered = false;
  return () => {
    if (unregistered) return;
    unregistered = true;
    const remaining = (DYNAMIC_FACE_BEHAVIOR_REFS.get(id) ?? 1) - 1;
    if (remaining <= 0) {
      DYNAMIC_FACE_BEHAVIOR_REFS.delete(id);
      DYNAMIC_FACE_BEHAVIORS.delete(id);
    } else {
      DYNAMIC_FACE_BEHAVIOR_REFS.set(id, remaining);
    }
  };
}

export function isFaceExpression(value: unknown): value is FaceExpression {
  return (
    typeof value === "string" &&
    (FACE_EXPRESSION_SET.has(value) || DYNAMIC_FACE_BEHAVIORS.has(value as PluginFaceExpressionId))
  );
}

export function getFaceExpressionBehavior(
  expression: FaceExpression,
): FaceExpressionBehavior {
  const dynamic = DYNAMIC_FACE_BEHAVIORS.get(expression as PluginFaceExpressionId);
  if (dynamic) {
    return { ...dynamic };
  }
  if (!FACE_EXPRESSION_SET.has(expression)) {
    return {
      closedRest: false,
      allowsBlink: true,
      allowsAudioResonance: true,
    };
  }
  const canonical = expression as CanonicalFaceExpression;
  const closedRest = CLOSED_REST_EXPRESSIONS.has(canonical);
  return {
    closedRest,
    allowsBlink: !NON_BLINK_EXPRESSIONS.has(canonical),
    allowsAudioResonance: !closedRest && canonical !== "night_watch",
  };
}
