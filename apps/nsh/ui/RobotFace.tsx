import { t } from "../i18n";
import {
  Canvas,
  cleanup,
  computed,
  createMotion,
  effect,
  lifecycle,
  reduceMotion,
  safeArea,
  signal,
  token,
  type CanvasRenderingContext2D,
} from "nsh";
import {
  FACE_EXPRESSION_RECIPES,
  type EyeSpec,
  type FaceExpression,
  type FaceExpressionRecipe,
  type FaceGlyphKind,
  type FaceTint,
  type MouthSpec,
} from "./face-recipes";

export { FACE_EXPRESSION_RECIPES, type FaceExpression, type FaceExpressionRecipe };

export interface FaceVisualState {
  expression: FaceExpression;
  gaze: { x: number; y: number };
  blinkProgress: number;
}

type AllTokenKeys = Parameters<typeof token>[0];
export type FaceTokenKey = {
  [K in AllTokenKeys]: ReturnType<typeof token<K>> extends string ? K : never;
}[AllTokenKeys];
export type TokenResolver = (name: FaceTokenKey) => string;

interface TintPalette {
  core: string;
  mid: string;
  edge: string;
  haloCore: string;
  haloMid: string;
  haloLow: string;
  haloZero: string;
  stroke: string;
}

export type FaceInsets = ReturnType<typeof safeArea>;

const ZERO_INSETS: FaceInsets = { top: 0, right: 0, bottom: 0, left: 0 };

const STATIC_GLYPHS: ReadonlySet<FaceGlyphKind> = new Set<FaceGlyphKind>([
  "blush",
  "glasses",
]);

interface AmbientKinematics {
  eyeDx: readonly [number, number];
  eyeDy: readonly [number, number];
  mouthDx: number;
  mouthDy: number;
  mouthScale: number;
}

const ZERO_KINEMATICS: AmbientKinematics = {
  eyeDx: [0, 0],
  eyeDy: [0, 0],
  mouthDx: 0,
  mouthDy: 0,
  mouthScale: 1,
};

/**
 * Returns true only for expressions with continuous idle micro-animations.
 * Resting & core conversational poses (`neutral`, `sleeping`, `privacy_shield`, `night_watch`, etc.)
 * return false so the JS ticker stops completely (0% JS CPU at rest).
 */
export function hasAmbientMotion(expression: FaceExpression): boolean {
  const recipe =
    FACE_EXPRESSION_RECIPES[expression] ?? FACE_EXPRESSION_RECIPES.neutral;
  for (const eye of recipe.eyes) {
    const shape = eye.shape ?? "orb";
    if (shape === "spiral" || shape === "heart" || shape === "star4") {
      return true;
    }
    if ((eye.rippleRings ?? 0) > 0) {
      return true;
    }
  }
  if (recipe.mouth.kind === "dots_3" || recipe.mouth.kind === "oval_yawn") {
    return true;
  }
  if (recipe.glyphs?.some((glyph) => !STATIC_GLYPHS.has(glyph))) {
    return true;
  }
  return expression === "laughing" || expression === "excited_bounce";
}

/**
 * Normalizes `blinkProgress` against the expression's eye shapes:
 * non-orb expressions (`sleeping`, `privacy_shield`, `deep_snore`, etc.) have `allowsBlink = false`
 * and may carry `blinkProgress = 1` from `RobotFaceController`, which must not bleed as an orb squash
 * when transitions are interpolated or interrupted mid-flight.
 */
export function normalizeBlinkProgress(state: FaceVisualState): number {
  const recipe =
    FACE_EXPRESSION_RECIPES[state.expression] ?? FACE_EXPRESSION_RECIPES.neutral;
  const allowsBlink = recipe.eyes.every((eye) => (eye.shape ?? "orb") === "orb");
  return allowsBlink ? clamp(state.blinkProgress, 0, 1) : 0;
}

function computeAmbientKinematics(
  expression: FaceExpression,
  timeSec: number,
): AmbientKinematics {
  if (timeSec <= 0) return ZERO_KINEMATICS;
  switch (expression) {
    case "laughing": {
      const hop = -Math.abs(Math.sin(timeSec * 6.4));
      return {
        eyeDx: [0, 0],
        eyeDy: [hop * 5.5, hop * 5.5],
        mouthDx: 0,
        mouthDy: hop * 3.6,
        mouthScale: 1 + Math.abs(hop) * 0.04,
      };
    }
    case "excited_bounce": {
      const hop = -Math.abs(Math.sin(timeSec * 5.2));
      return {
        eyeDx: [0, 0],
        eyeDy: [hop * 6, hop * 6],
        mouthDx: 0,
        mouthDy: hop * 4,
        mouthScale: 1,
      };
    }
    case "dizzy_spiral": {
      const ox = Math.sin(timeSec * 3.0) * 3.5;
      const oy = Math.sin(timeSec * 6.0) * 2.2;
      return {
        eyeDx: [ox, -ox],
        eyeDy: [oy, -oy],
        mouthDx: Math.sin(timeSec * 3.0) * 2.5,
        mouthDy: 0,
        mouthScale: 1,
      };
    }
    case "munching": {
      const chew = Math.sin(timeSec * 5.6);
      return {
        eyeDx: [0, 0],
        eyeDy: [chew * 1.2, chew * 1.2],
        mouthDx: 0,
        mouthDy: chew * 2.8,
        mouthScale: 1 + chew * 0.06,
      };
    }
    case "sipping_straw": {
      const sip = Math.sin(timeSec * 3.4);
      return {
        eyeDx: [0, 0],
        eyeDy: [sip * 2, sip * 2],
        mouthDx: 0,
        mouthDy: 0,
        mouthScale: 1,
      };
    }
    case "music_vibe": {
      const nod = Math.sin(timeSec * 3.8);
      const sway = Math.sin(timeSec * 1.9);
      return {
        eyeDx: [sway * 2.5, sway * 2.5],
        eyeDy: [nod * 3.4, nod * 3.4],
        mouthDx: sway * 2,
        mouthDy: nod * 2.4,
        mouthScale: 1,
      };
    }
    case "reading_scan": {
      const p = (timeSec * 0.55) % 1;
      let scanDx = 0;
      if (p < 0.42) {
        scanDx = 14 * (p / 0.42);
      } else if (p < 0.58) {
        const r = (p - 0.42) / 0.16;
        scanDx = lerp(14, -14, 0.5 - 0.5 * Math.cos(r * Math.PI));
      } else {
        scanDx = -14 * (1 - (p - 0.58) / 0.42);
      }
      return {
        eyeDx: [scanDx, scanDx],
        eyeDy: [0, 0],
        mouthDx: scanDx * 0.18,
        mouthDy: 0,
        mouthScale: 1,
      };
    }
    default:
      return ZERO_KINEMATICS;
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Number.isFinite(value)
    ? Math.max(minimum, Math.min(maximum, value))
    : minimum;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function easeOutCubic(t: number): number {
  const u = 1 - clamp(t, 0, 1);
  return 1 - u * u * u;
}

function easeOutBack(t: number, startValue: number, endValue: number): number {
  const x = clamp(t, 0, 1);
  const c1 = 1.45;
  const c3 = c1 + 1;
  const u = x - 1;
  const eased = 1 + c3 * u * u * u + c1 * u * u;
  return startValue + (endValue - startValue) * eased;
}

function parseCssRgba(input: string): [number, number, number, number] | null {
  const s = input.trim();
  if (s.startsWith("#")) {
    const hex = s.slice(1);
    if (hex.length === 3) {
      return [
        parseInt(hex[0] + hex[0], 16),
        parseInt(hex[1] + hex[1], 16),
        parseInt(hex[2] + hex[2], 16),
        1,
      ];
    }
    if (hex.length === 6 || hex.length === 8) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
      if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b) && Number.isFinite(a)) {
        return [r, g, b, a];
      }
    }
    return null;
  }
  const m = s.match(
    /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i,
  );
  if (!m) return null;
  return [
    Number(m[1]),
    Number(m[2]),
    Number(m[3]),
    m[4] !== undefined ? Number(m[4]) : 1,
  ];
}

function mixCssColor(a: string, b: string, t: number): string {
  if (t <= 0 || a === b) return a;
  if (t >= 1) return b;
  const ca = parseCssRgba(a);
  const cb = parseCssRgba(b);
  if (!ca || !cb) return t < 0.5 ? a : b;
  const r = Math.round(lerp(ca[0], cb[0], t));
  const g = Math.round(lerp(ca[1], cb[1], t));
  const bl = Math.round(lerp(ca[2], cb[2], t));
  const al = clamp(lerp(ca[3], cb[3], t), 0, 1);
  return `rgba(${r},${g},${bl},${al.toFixed(3)})`;
}

function mixTintPalette(a: TintPalette, b: TintPalette, t: number): TintPalette {
  if (t <= 0) return a;
  if (t >= 1) return b;
  return {
    core: mixCssColor(a.core, b.core, t),
    mid: mixCssColor(a.mid, b.mid, t),
    edge: mixCssColor(a.edge, b.edge, t),
    haloCore: mixCssColor(a.haloCore, b.haloCore, t),
    haloMid: mixCssColor(a.haloMid, b.haloMid, t),
    haloLow: mixCssColor(a.haloLow, b.haloLow, t),
    haloZero: mixCssColor(a.haloZero, b.haloZero, t),
    stroke: mixCssColor(a.stroke, b.stroke, t),
  };
}

function resolveTintPalette(
  tint: FaceTint,
  resolveToken: TokenResolver,
): TintPalette {
  switch (tint) {
    case "coral": {
      const zero = resolveToken("alarmed-zero");
      return {
        core: resolveToken("alarmed-highlight"),
        mid: resolveToken("destructive"),
        edge: resolveToken("alarmed-rim"),
        haloCore: resolveToken("alarmed-halo"),
        haloMid: zero,
        haloLow: zero,
        haloZero: zero,
        stroke: resolveToken("destructive"),
      };
    }
    case "ivory": {
      const zero = resolveToken("face-ivory-zero");
      return {
        core: resolveToken("face-ivory-core"),
        mid: resolveToken("face-ivory-core"),
        edge: resolveToken("face-ivory-edge"),
        haloCore: resolveToken("face-ivory-halo"),
        haloMid: resolveToken("halo-mid"),
        haloLow: resolveToken("halo-low"),
        haloZero: zero,
        stroke: resolveToken("face-ivory-core"),
      };
    }
    case "amber": {
      const zero = resolveToken("face-amber-zero");
      return {
        core: resolveToken("face-amber-core"),
        mid: resolveToken("face-amber-core"),
        edge: resolveToken("face-amber-edge"),
        haloCore: resolveToken("face-amber-halo"),
        haloMid: zero,
        haloLow: zero,
        haloZero: zero,
        stroke: resolveToken("face-amber-core"),
      };
    }
    case "sage": {
      const zero = resolveToken("face-sage-zero");
      return {
        core: resolveToken("face-sage-core"),
        mid: resolveToken("face-sage-core"),
        edge: resolveToken("face-sage-edge"),
        haloCore: resolveToken("face-sage-halo"),
        haloMid: zero,
        haloLow: zero,
        haloZero: zero,
        stroke: resolveToken("face-sage-core"),
      };
    }
    case "rose": {
      const zero = resolveToken("face-rose-zero");
      return {
        core: resolveToken("face-rose-core"),
        mid: resolveToken("face-rose-core"),
        edge: resolveToken("face-rose-edge"),
        haloCore: resolveToken("face-rose-halo"),
        haloMid: zero,
        haloLow: zero,
        haloZero: zero,
        stroke: resolveToken("face-stroke"),
      };
    }
    case "mist": {
      const zero = resolveToken("face-mist-zero");
      return {
        core: resolveToken("eye-core"),
        mid: resolveToken("eye-core"),
        edge: resolveToken("eye-edge"),
        haloCore: resolveToken("face-mist-halo"),
        haloMid: zero,
        haloLow: zero,
        haloZero: zero,
        stroke: resolveToken("face-stroke"),
      };
    }
    case "warm":
    default:
      return {
        core: resolveToken("eye-core"),
        mid: resolveToken("eye-core"),
        edge: resolveToken("eye-edge"),
        haloCore: resolveToken("eye-halo"),
        haloMid: resolveToken("halo-mid"),
        haloLow: resolveToken("halo-low"),
        haloZero: resolveToken("halo-zero"),
        stroke: resolveToken("face-stroke"),
      };
  }
}

/**
 * Pure deterministic renderer for the 620 x 340 OLED face coordinate space.
 * Zero pupils, zero specular white highlights, and zero raw hex literals.
 */
export function drawRobotFace(
  cx: CanvasRenderingContext2D,
  size: { width: number; height: number },
  state: FaceVisualState,
  shift: { dx: number; dy: number },
  resolveToken: TokenResolver = token,
  insets: FaceInsets = ZERO_INSETS,
  timeSec = 0,
): void {
  drawRobotFaceTransition(
    cx,
    size,
    state,
    state,
    1,
    shift,
    resolveToken,
    insets,
    timeSec,
  );
}

/**
 * Pure transition renderer interpolating continuously between `fromState` and `toState`
 * across `progress` in [0, 1] (kinematic eye/brow/eyelid/mouth glide + micro-blink shape morph),
 * plus optional `timeSec` for continuous ambient micro-animations.
 */
export function drawRobotFaceTransition(
  cx: CanvasRenderingContext2D,
  size: { width: number; height: number },
  fromState: FaceVisualState,
  toState: FaceVisualState,
  progress: number,
  shift: { dx: number; dy: number },
  resolveToken: TokenResolver = token,
  insets: FaceInsets = ZERO_INSETS,
  timeSec = 0,
): void {
  const u = clamp(progress, 0, 1);
  const safeTime = Number.isFinite(timeSec) && timeSec > 0 ? timeSec : 0;
  const fromRecipe =
    FACE_EXPRESSION_RECIPES[fromState.expression] ?? FACE_EXPRESSION_RECIPES.neutral;
  const toRecipe =
    FACE_EXPRESSION_RECIPES[toState.expression] ?? FACE_EXPRESSION_RECIPES.neutral;
  const fromKin = computeAmbientKinematics(fromState.expression, safeTime);
  const toKin =
    fromState.expression === toState.expression
      ? fromKin
      : computeAmbientKinematics(toState.expression, safeTime);

  const fromTint = fromRecipe.tint ?? "warm";
  const toTint = toRecipe.tint ?? "warm";
  const fromPalette = resolveTintPalette(fromTint, resolveToken);
  const toPalette =
    fromTint === toTint ? fromPalette : resolveTintPalette(toTint, resolveToken);
  const palette = fromTint === toTint ? toPalette : mixTintPalette(fromPalette, toPalette, u);

  const fromAmbient = clamp(fromRecipe.ambientOpacity ?? 1, 0.1, 1);
  const toAmbient = clamp(toRecipe.ambientOpacity ?? 1, 0.1, 1);
  const ambientOpacity = lerp(fromAmbient, toAmbient, u);

  const fromBlink = normalizeBlinkProgress(fromState);
  const toBlink = normalizeBlinkProgress(toState);
  const blink = lerp(fromBlink, toBlink, u);

  const fromGazeX = clamp(fromState.gaze.x, -1, 1);
  const toGazeX = clamp(toState.gaze.x, -1, 1);
  const gazeX = lerp(fromGazeX, toGazeX, u);

  const fromGazeY = -clamp(fromState.gaze.y, -1, 1);
  const toGazeY = -clamp(toState.gaze.y, -1, 1);
  const gazeY = lerp(fromGazeY, toGazeY, u);

  const shiftX = clamp(shift.dx, -6, 6);
  const shiftY = clamp(shift.dy, -6, 6);
  const faceWidth = Math.max(0, size.width - insets.left - insets.right);
  const faceHeight = Math.max(0, size.height - insets.top - insets.bottom);
  const faceCenterX = insets.left + faceWidth / 2;
  const faceCenterY = insets.top + faceHeight / 2;
  const scale = Math.max(
    0.01,
    Math.min(1.08, (faceWidth - 32) / 620, (faceHeight - 80) / 340),
  );

  cx.clearRect(0, 0, size.width, size.height);

  // 1. Subtle 39 x 21 dot matrix texture across the full viewport
  cx.fillStyle = resolveToken("face-texture");
  for (let row = 0; row < 21; row++) {
    for (let col = 0; col < 39; col++) {
      cx.fillRect(
        ((col + 0.5) * size.width) / 39,
        ((row + 0.5) * size.height) / 21,
        1.4,
        1.4,
      );
    }
  }

  // 2. Bottom horizon glow (radial-gradient ellipse centered in safe area)
  const horizonRadiusX = Math.min(220, size.width * 0.39);
  if (horizonRadiusX > 10) {
    cx.save();
    cx.translate(faceCenterX, insets.top + faceHeight);
    cx.scale(1, 28 / horizonRadiusX);
    const horizon = cx.createRadialGradient(0, 0, 0, 0, 0, horizonRadiusX);
    horizon.addColorStop(0, resolveToken("horizon-core"));
    horizon.addColorStop(0.48, resolveToken("horizon-mid"));
    horizon.addColorStop(1, resolveToken("horizon-zero"));
    cx.fillStyle = horizon;
    fillCircle(cx, 0, 0, horizonRadiusX);
    cx.restore();
  }

  // 3. 620 x 340 safe-area-centered face coordinate space
  cx.save();
  cx.translate(
    faceCenterX - 310 * scale + shiftX,
    faceCenterY - 170 * scale + shiftY,
  );
  cx.scale(scale, scale);

  const eyeCenters: Array<{ x: number; y: number; scale: number }> = [
    { x: 130, y: 158, scale: 1 },
    { x: 490, y: 158, scale: 1 },
  ];
  for (let index = 0; index < 2; index++) {
    const fSpec = fromRecipe.eyes[index];
    const tSpec = toRecipe.eyes[index];
    const anchorX = index === 0 ? 130 : 490;
    const fDx = (fSpec.dx ?? 0) + fromKin.eyeDx[index];
    const tDx = (tSpec.dx ?? 0) + toKin.eyeDx[index];
    const fDy = (fSpec.dy ?? 0) + fromKin.eyeDy[index];
    const tDy = (tSpec.dy ?? 0) + toKin.eyeDy[index];
    eyeCenters[index] = {
      x: anchorX + gazeX * 10 + lerp(fDx, tDx, u),
      y: 158 + gazeY * 9 + lerp(fDy, tDy, u),
      scale: lerp(fSpec.scale ?? 1, tSpec.scale ?? 1, u),
    };
  }

  const fromGlyphSet = new Set<FaceGlyphKind>(fromRecipe.glyphs ?? []);
  const toGlyphSet = new Set<FaceGlyphKind>(toRecipe.glyphs ?? []);
  const allGlyphs = new Set<FaceGlyphKind>([
    ...(fromRecipe.glyphs ?? []),
    ...(toRecipe.glyphs ?? []),
  ]);

  const renderGlyphLayer = (underlay: boolean) => {
    for (const glyph of allGlyphs) {
      const isUnder = glyph === "blush" || glyph === "scan_trails";
      if (isUnder !== underlay) continue;
      const inFrom = fromGlyphSet.has(glyph);
      const inTo = toGlyphSet.has(glyph);
      let gAlpha = ambientOpacity;
      let offsetY = 0;
      let glyphPalette = palette;
      if (inFrom && !inTo) {
        const outT = clamp(u / 0.5, 0, 1);
        gAlpha = fromAmbient * (1 - outT);
        offsetY = -8 * outT;
        glyphPalette = fromPalette;
      } else if (!inFrom && inTo) {
        const inT = clamp((u - 0.24) / 0.76, 0, 1);
        gAlpha = toAmbient * inT;
        offsetY = 8 * (1 - inT);
        glyphPalette = toPalette;
      }
      if (gAlpha <= 0.005) continue;
      if (offsetY !== 0) {
        cx.save();
        cx.translate(0, offsetY);
        drawGlyph(cx, glyph, eyeCenters, gAlpha, glyphPalette, resolveToken, safeTime);
        cx.restore();
      } else {
        drawGlyph(cx, glyph, eyeCenters, gAlpha, glyphPalette, resolveToken, safeTime);
      }
    }
  };

  // 3b. Underlay glyphs (soft cheek blush & scan trails behind eyes)
  renderGlyphLayer(true);

  // 4. Dual eyes across the 5 orthogonal channels (continuous glide + shape morph)
  const isCoralBlend = (u < 0.5 ? fromTint : toTint) === "coral";
  for (let index = 0; index < 2; index++) {
    drawTransitionEye(
      cx,
      index,
      fromRecipe.eyes[index],
      toRecipe.eyes[index],
      eyeCenters[index].x,
      eyeCenters[index].y,
      eyeCenters[index].scale,
      fromBlink,
      toBlink,
      blink,
      fromAmbient,
      toAmbient,
      ambientOpacity,
      u,
      fromTint === "coral",
      toTint === "coral",
      isCoralBlend,
      fromPalette,
      toPalette,
      palette,
      safeTime,
    );
  }

  // 5. Expression mouth; glides continuously and squash-morphs across mouth kinds
  const fromMouthWithKin: MouthSpec =
    fromKin.mouthScale === 1
      ? fromRecipe.mouth
      : { ...fromRecipe.mouth, scale: (fromRecipe.mouth.scale ?? 1) * fromKin.mouthScale };
  const toMouthWithKin: MouthSpec =
    toKin.mouthScale === 1
      ? toRecipe.mouth
      : { ...toRecipe.mouth, scale: (toRecipe.mouth.scale ?? 1) * toKin.mouthScale };
  const mouthX =
    310 +
    gazeX * 4 +
    lerp(
      (fromRecipe.mouth.dx ?? 0) + fromKin.mouthDx,
      (toRecipe.mouth.dx ?? 0) + toKin.mouthDx,
      u,
    );
  const mouthY =
    263 +
    gazeY * 3 +
    lerp(
      (fromRecipe.mouth.dy ?? 0) + fromKin.mouthDy,
      (toRecipe.mouth.dy ?? 0) + toKin.mouthDy,
      u,
    );
  drawTransitionMouth(
    cx,
    fromMouthWithKin,
    toMouthWithKin,
    mouthX,
    mouthY,
    fromAmbient,
    toAmbient,
    ambientOpacity,
    u,
    fromPalette,
    toPalette,
    palette,
    safeTime,
  );

  // 6. Planar companion micro-glyphs (foreground layer)
  renderGlyphLayer(false);

  cx.restore();
}

function drawTransitionEye(
  cx: CanvasRenderingContext2D,
  index: number,
  fromSpec: EyeSpec,
  toSpec: EyeSpec,
  baseX: number,
  baseY: number,
  blendedScale: number,
  fromBlink: number,
  toBlink: number,
  blendedBlink: number,
  fromAmbient: number,
  toAmbient: number,
  blendedAmbient: number,
  u: number,
  fromCoral: boolean,
  toCoral: boolean,
  blendedCoral: boolean,
  fromPalette: TintPalette,
  toPalette: TintPalette,
  blendedPalette: TintPalette,
  timeSec: number,
): void {
  const fromShape = fromSpec.shape ?? "orb";
  const toShape = toSpec.shape ?? "orb";

  if (u >= 0.999) {
    drawEye(cx, index, toSpec, baseX, baseY, toBlink, toAmbient, toCoral, toPalette, 1, 1, timeSec);
    return;
  }
  if (u <= 0.001) {
    drawEye(cx, index, fromSpec, baseX, baseY, fromBlink, fromAmbient, fromCoral, fromPalette, 1, 1, timeSec);
    return;
  }

  if (fromShape === toShape) {
    // Interpolate continuous eye parameters (eyelid & brow) without blinking
    let eyelid: EyeSpec["eyelid"];
    if (fromSpec.eyelid || toSpec.eyelid) {
      const top = lerp(fromSpec.eyelid?.top ?? 0, toSpec.eyelid?.top ?? 0, u);
      const bottom = lerp(fromSpec.eyelid?.bottom ?? 0, toSpec.eyelid?.bottom ?? 0, u);
      const fromAngle = fromSpec.eyelid
        ? (fromSpec.eyelid.angleDeg ?? 0)
        : (toSpec.eyelid?.angleDeg ?? 0);
      const toAngle = toSpec.eyelid
        ? (toSpec.eyelid.angleDeg ?? 0)
        : (fromSpec.eyelid?.angleDeg ?? 0);
      if (top > 0.003 || bottom > 0.003) {
        eyelid = { top, bottom, angleDeg: lerp(fromAngle, toAngle, u) };
      }
    }

    const interpSpec: EyeSpec = {
      shape: toShape,
      scale: blendedScale,
      opacity: lerp(fromSpec.opacity ?? 1, toSpec.opacity ?? 1, u),
      eyelid,
      underArc: Boolean(fromSpec.underArc || toSpec.underArc),
      rippleRings: Math.max(fromSpec.rippleRings ?? 0, toSpec.rippleRings ?? 0),
    };
    const underArcFade = lerp(fromSpec.underArc ? 1 : 0, toSpec.underArc ? 1 : 0, u);
    const rippleFade = lerp(
      (fromSpec.rippleRings ?? 0) > 0 ? 1 : 0,
      (toSpec.rippleRings ?? 0) > 0 ? 1 : 0,
      u,
    );

    drawEye(
      cx,
      index,
      interpSpec,
      baseX,
      baseY,
      blendedBlink,
      blendedAmbient,
      blendedCoral,
      blendedPalette,
      underArcFade,
      rippleFade,
      timeSec,
    );

    // Smoothly interpolate or fade eyebrows independently
    drawTransitionBrow(
      cx,
      fromSpec.brow,
      toSpec.brow,
      baseX,
      baseY,
      blendedScale,
      blendedAmbient * lerp(fromSpec.opacity ?? 1, toSpec.opacity ?? 1, u),
      u,
      blendedPalette,
    );
    return;
  }

  // Discrete shape change (e.g. orb <-> crescent_up / heart / star4 / line):
  // Organic micro-blink squash out -> spring pop in at the continuously gliding center
  if (u < 0.54) {
    const outT = clamp(u / 0.5, 0, 1);
    const squashY = Math.max(0.06, 1 - outT * 0.92);
    const outAlpha = fromAmbient * (1 - outT);
    if (outAlpha > 0.005) {
      cx.save();
      cx.translate(baseX, baseY);
      cx.scale(1, squashY);
      cx.translate(-baseX, -baseY);
      drawEye(cx, index, { ...fromSpec, scale: blendedScale }, baseX, baseY, fromBlink, outAlpha, fromCoral, fromPalette, 1, 1, timeSec);
      cx.restore();
    }
  }
  if (u > 0.3) {
    const inT = clamp((u - 0.3) / 0.7, 0, 1);
    const popY = Math.max(0.06, easeOutBack(inT, 0.14, 1));
    const inAlpha = toAmbient * clamp(inT * 1.35, 0, 1);
    if (inAlpha > 0.005) {
      cx.save();
      cx.translate(baseX, baseY);
      cx.scale(1, popY);
      cx.translate(-baseX, -baseY);
      drawEye(cx, index, { ...toSpec, scale: blendedScale }, baseX, baseY, toBlink, inAlpha, toCoral, toPalette, 1, 1, timeSec);
      cx.restore();
    }
  }
}

function drawTransitionBrow(
  cx: CanvasRenderingContext2D,
  fromBrow: EyeSpec["brow"],
  toBrow: EyeSpec["brow"],
  baseX: number,
  baseY: number,
  ratio: number,
  eyeAlpha: number,
  u: number,
  palette: TintPalette,
): void {
  if (!fromBrow && !toBrow) return;
  if (fromBrow && toBrow && Boolean(fromBrow.flat) === Boolean(toBrow.flat)) {
    drawBrow(
      cx,
      {
        angleDeg: lerp(fromBrow.angleDeg, toBrow.angleDeg, u),
        lift: lerp(fromBrow.lift ?? 0, toBrow.lift ?? 0, u),
        span: lerp(fromBrow.span ?? 1, toBrow.span ?? 1, u),
        flat: toBrow.flat,
      },
      baseX,
      baseY,
      ratio,
      eyeAlpha,
      palette,
    );
    return;
  }
  if (fromBrow) {
    const outAlpha = eyeAlpha * (1 - u);
    if (outAlpha > 0.005) {
      drawBrow(
        cx,
        { ...fromBrow, lift: (fromBrow.lift ?? 0) - 8 * u },
        baseX,
        baseY,
        ratio,
        outAlpha,
        palette,
      );
    }
  }
  if (toBrow) {
    const inAlpha = eyeAlpha * u;
    if (inAlpha > 0.005) {
      drawBrow(
        cx,
        { ...toBrow, lift: (toBrow.lift ?? 0) - 8 * (1 - u) },
        baseX,
        baseY,
        ratio,
        inAlpha,
        palette,
      );
    }
  }
}

function drawTransitionMouth(
  cx: CanvasRenderingContext2D,
  fromMouth: MouthSpec,
  toMouth: MouthSpec,
  mouthX: number,
  mouthY: number,
  fromAmbient: number,
  toAmbient: number,
  blendedAmbient: number,
  u: number,
  fromPalette: TintPalette,
  toPalette: TintPalette,
  blendedPalette: TintPalette,
  timeSec: number,
): void {
  if (u >= 0.999) {
    drawMouth(cx, toMouth, mouthX, mouthY, toAmbient, toPalette, timeSec);
    return;
  }
  if (u <= 0.001) {
    drawMouth(cx, fromMouth, mouthX, mouthY, fromAmbient, fromPalette, timeSec);
    return;
  }

  if (fromMouth.kind === toMouth.kind) {
    drawMouth(
      cx,
      {
        kind: toMouth.kind,
        scale: lerp(fromMouth.scale ?? 1, toMouth.scale ?? 1, u),
        tiltDeg: lerp(fromMouth.tiltDeg ?? 0, toMouth.tiltDeg ?? 0, u),
        opacity: lerp(fromMouth.opacity ?? 1, toMouth.opacity ?? 1, u),
      },
      mouthX,
      mouthY,
      blendedAmbient,
      blendedPalette,
      timeSec,
    );
    return;
  }

  if (fromMouth.kind !== "none" && u < 0.52) {
    const outT = clamp(u / 0.48, 0, 1);
    const sy = Math.max(0.15, 1 - outT * 0.8);
    const sx = 1 - outT * 0.16;
    const outAlpha = fromAmbient * (1 - outT);
    if (outAlpha > 0.005) {
      cx.save();
      cx.translate(mouthX, mouthY);
      cx.scale(sx, sy);
      cx.translate(-mouthX, -mouthY);
      drawMouth(cx, fromMouth, mouthX, mouthY, outAlpha, fromPalette, timeSec);
      cx.restore();
    }
  }
  if (toMouth.kind !== "none" && u > 0.3) {
    const inT = clamp((u - 0.3) / 0.7, 0, 1);
    const sy = Math.max(0.15, easeOutBack(inT, 0.2, 1));
    const sx = lerp(0.84, 1, inT);
    const inAlpha = toAmbient * clamp(inT * 1.35, 0, 1);
    if (inAlpha > 0.005) {
      cx.save();
      cx.translate(mouthX, mouthY);
      cx.scale(sx, sy);
      cx.translate(-mouthX, -mouthY);
      drawMouth(cx, toMouth, mouthX, mouthY, inAlpha, toPalette, timeSec);
      cx.restore();
    }
  }
}

function drawEye(
  cx: CanvasRenderingContext2D,
  index: number,
  spec: EyeSpec,
  baseX: number,
  baseY: number,
  blink: number,
  ambientOpacity: number,
  isCoralTint: boolean,
  palette: TintPalette,
  underArcFade = 1,
  rippleFade = 1,
  timeSec = 0,
): void {
  const shape = spec.shape ?? "orb";
  const baseScale = spec.scale ?? 1;
  const eyeBaseOpacity = ambientOpacity * (spec.opacity ?? 1);
  const closedByBlink = shape === "orb" && blink >= 0.98;

  if (shape === "line" || closedByBlink) {
    const lineHalfWidth = 78 * baseScale;
    cx.save();
    cx.strokeStyle = palette.stroke;
    cx.globalAlpha =
      shape === "line"
        ? ambientOpacity * (spec.opacity ?? 0.4)
        : eyeBaseOpacity * 0.45;
    cx.lineWidth = 4;
    cx.lineCap = "round";
    cx.beginPath();
    cx.moveTo(baseX - lineHalfWidth, baseY);
    cx.lineTo(baseX + lineHalfWidth, baseY);
    cx.stroke();
    cx.restore();
    if (spec.brow !== undefined) {
      drawBrow(cx, spec.brow, baseX, baseY, baseScale, eyeBaseOpacity, palette);
    }
    return;
  }

  const blinkSquashY = shape === "orb" ? Math.max(0.025, 1 - blink * 0.975) : 1;
  const blinkOpacity =
    eyeBaseOpacity * (shape === "orb" ? 1 - blink * 0.55 : 1);
  const ratio = baseScale;
  const radius = 92 * ratio;

  cx.save();
  cx.globalAlpha = blinkOpacity;

  if (shape === "orb") {
    cx.save();
    if (blinkSquashY < 0.999) {
      cx.translate(baseX, baseY);
      cx.scale(1, blinkSquashY);
      cx.translate(-baseX, -baseY);
    }

    // 4a. Eye perimeter soft halo bloom
    const halo = cx.createRadialGradient(
      baseX,
      baseY,
      radius * 0.85,
      baseX,
      baseY,
      radius * 1.62,
    );
    halo.addColorStop(0, palette.haloCore);
    halo.addColorStop(0.42, palette.haloMid);
    halo.addColorStop(0.76, palette.haloLow);
    halo.addColorStop(1, palette.haloZero);
    cx.fillStyle = halo;
    fillCircle(cx, baseX, baseY, radius * 1.62);

    // Optional magnetic dock concentric ripple rings (#61 dock_snap)
    if (spec.rippleRings && spec.rippleRings > 0 && rippleFade > 0.005) {
      const ringCount = spec.rippleRings;
      for (let ring = 0; ring < ringCount; ring++) {
        const phase = ((timeSec * 0.52) + (ring + 0.32) / ringCount) % 1;
        const env = Math.sin(phase * Math.PI);
        cx.save();
        cx.strokeStyle = palette.stroke;
        cx.lineWidth = 2.4;
        cx.globalAlpha = blinkOpacity * rippleFade * env * 0.42;
        cx.beginPath();
        cx.arc(baseX, baseY, radius * (1.05 + phase * 0.38), 0, Math.PI * 2);
        cx.stroke();
        cx.restore();
      }
    }

    // 4b. Solid flat/soft-focus OLED emissive round eye (with optional eyelid clip)
    cx.save();
    if (spec.eyelid) {
      const topCut = clamp(spec.eyelid.top ?? 0, 0, 0.85);
      const bottomCut = clamp(spec.eyelid.bottom ?? 0, 0, 0.85);
      const angleRad = ((spec.eyelid.angleDeg ?? 0) * Math.PI) / 180;
      const yTop = -radius + topCut * 2 * radius;
      const visibleHeight = Math.max(4, (1 - topCut - bottomCut) * 2 * radius);
      cx.translate(baseX, baseY);
      if (angleRad !== 0) cx.rotate(angleRad);
      cx.beginPath();
      cx.rect(-radius * 1.45, yTop, radius * 2.9, visibleHeight);
      cx.clip();
      cx.translate(-baseX, -baseY);
    }

    const orb = cx.createRadialGradient(baseX, baseY, 0, baseX, baseY, radius);
    if (isCoralTint) {
      orb.addColorStop(0, palette.core);
      orb.addColorStop(0.78, palette.mid);
      orb.addColorStop(1, palette.edge);
    } else {
      orb.addColorStop(0, palette.core);
      orb.addColorStop(0.84, palette.mid);
      orb.addColorStop(1, palette.edge);
    }
    cx.fillStyle = orb;
    fillCircle(cx, baseX, baseY, radius);
    cx.restore();

    // Optional warm touched shimmer curves beneath orb (#21 touched_warm)
    if (spec.underArc && underArcFade > 0.005) {
      cx.save();
      cx.strokeStyle = palette.core;
      cx.lineCap = "round";
      cx.lineWidth = 3.5 * ratio;
      cx.globalAlpha = blinkOpacity * underArcFade * 0.65;
      cx.beginPath();
      cx.arc(baseX, baseY + 14 * ratio, radius + 6 * ratio, Math.PI * 0.24, Math.PI * 0.76);
      cx.stroke();
      cx.globalAlpha = blinkOpacity * underArcFade * 0.34;
      cx.beginPath();
      cx.arc(baseX, baseY + 22 * ratio, radius + 10 * ratio, Math.PI * 0.28, Math.PI * 0.72);
      cx.stroke();
      cx.restore();
    }
    cx.restore();
  } else {
    // Soft ambient bloom behind non-orb symbolic/arc eyes
    drawSoftEyeBloom(cx, baseX, baseY, radius * 1.28, palette);

    if (shape === "crescent_up") {
      cx.strokeStyle = palette.core;
      cx.lineWidth = 14 * ratio;
      cx.lineCap = "round";
      cx.beginPath();
      cx.arc(baseX, baseY + 24 * ratio, 62 * ratio, Math.PI * 1.14, Math.PI * 1.86);
      cx.stroke();
    } else if (shape === "crescent_down") {
      cx.strokeStyle = palette.core;
      cx.lineWidth = 11 * ratio;
      cx.lineCap = "round";
      cx.beginPath();
      cx.arc(baseX, baseY - 24 * ratio, 60 * ratio, Math.PI * 0.16, Math.PI * 0.84);
      cx.stroke();
    } else if (shape === "chevron") {
      const dir = index === 0 ? 1 : -1;
      cx.strokeStyle = palette.core;
      cx.lineWidth = 13 * ratio;
      cx.lineCap = "round";
      cx.lineJoin = "round";
      cx.beginPath();
      cx.moveTo(baseX - dir * 48 * ratio, baseY - 34 * ratio);
      cx.lineTo(baseX + dir * 38 * ratio, baseY);
      cx.lineTo(baseX - dir * 48 * ratio, baseY + 34 * ratio);
      cx.stroke();
    } else if (shape === "heart") {
      const p = (timeSec * 1.05) % 1;
      const lub = Math.sin(clamp(p / 0.22, 0, 1) * Math.PI);
      const dub = Math.sin(clamp((p - 0.24) / 0.22, 0, 1) * Math.PI);
      const pulseScale = 1 + 0.075 * lub * lub + 0.048 * dub * dub;
      fillHeart(cx, baseX, baseY, radius * 0.94 * pulseScale, palette);
    } else if (shape === "star4") {
      const twinkle = 1 + (index === 0 ? 1 : -1) * 0.075 * Math.sin(timeSec * 3.8);
      fillFourPointStar(cx, baseX, baseY, radius * 0.96 * twinkle, palette.core);
    } else if (shape === "spiral") {
      drawSpiralEye(
        cx,
        baseX,
        baseY,
        radius * 0.9,
        index === 1,
        palette.core,
        8.5 * ratio,
        timeSec * 4.2,
      );
    }
  }

  // 4c. Conditional outer eyebrow
  if (spec.brow !== undefined) {
    drawBrow(cx, spec.brow, baseX, baseY, ratio, eyeBaseOpacity, palette);
  }

  cx.restore();
}

function drawBrow(
  cx: CanvasRenderingContext2D,
  brow: NonNullable<EyeSpec["brow"]>,
  baseX: number,
  baseY: number,
  ratio: number,
  blinkOpacity: number,
  palette: TintPalette,
): void {
  const radius = 92 * ratio;
  const span = clamp(brow.span ?? 1, 0.5, 1.5);
  cx.save();
  cx.translate(baseX, baseY + (brow.lift ?? 0) * ratio);
  cx.rotate((brow.angleDeg * Math.PI) / 180);
  cx.strokeStyle = palette.stroke;
  cx.lineWidth = 4 * ratio;
  cx.lineCap = "round";
  cx.globalAlpha = blinkOpacity * 0.68;
  cx.beginPath();
  if (brow.flat) {
    cx.moveTo(-36 * ratio * span, -radius - 14 * ratio);
    cx.lineTo(36 * ratio * span, -radius - 14 * ratio);
  } else {
    cx.arc(
      0,
      -radius + 26 * ratio,
      48 * ratio,
      Math.PI * (1.5 - 0.3 * span),
      Math.PI * (1.5 + 0.3 * span),
    );
  }
  cx.stroke();
  cx.restore();
}

function drawMouth(
  cx: CanvasRenderingContext2D,
  mouth: MouthSpec,
  mouthX: number,
  mouthY: number,
  ambientOpacity: number,
  palette: TintPalette,
  timeSec = 0,
): void {
  if (mouth.kind === "none") return;

  const s = mouth.scale ?? 1;
  const alpha = ambientOpacity * (mouth.opacity ?? 1);

  cx.save();
  cx.translate(mouthX, mouthY);
  if (mouth.tiltDeg) {
    cx.rotate((mouth.tiltDeg * Math.PI) / 180);
  }
  cx.globalAlpha = alpha;
  cx.strokeStyle = palette.stroke;
  cx.fillStyle = palette.core;
  cx.lineCap = "round";
  cx.lineJoin = "round";

  switch (mouth.kind) {
    case "flat": {
      cx.lineWidth = 4;
      cx.beginPath();
      cx.moveTo(-17 * s, 0);
      cx.lineTo(17 * s, 0);
      cx.stroke();
      break;
    }
    case "dot": {
      cx.fillStyle = palette.stroke;
      fillCircle(cx, 0, 0, 4.2 * s);
      break;
    }
    case "circle_o": {
      cx.lineWidth = 4;
      cx.beginPath();
      cx.arc(0, 0, 10 * s, 0, Math.PI * 2);
      cx.stroke();
      break;
    }
    case "oval_yawn": {
      const yawn = Math.sin(timeSec * 1.8);
      const rx = Math.max(4, 16 * s * (1 - 0.05 * yawn));
      const ry = Math.max(6, 26 * s * (1 + 0.14 * yawn));
      cx.fillStyle = palette.core;
      cx.beginPath();
      cx.ellipse(0, 2, rx, ry, 0, 0, Math.PI * 2);
      cx.fill();
      break;
    }
    case "wide_smile": {
      cx.lineWidth = 6;
      cx.beginPath();
      cx.arc(0, -34 * s, 48 * s, Math.PI * 0.22, Math.PI * 0.78);
      cx.stroke();
      break;
    }
    case "open_d": {
      cx.lineWidth = 5.5;
      cx.beginPath();
      cx.arc(0, -6 * s, 28 * s, 0, Math.PI);
      cx.closePath();
      cx.stroke();
      break;
    }
    case "smirk": {
      cx.lineWidth = 5;
      cx.beginPath();
      cx.moveTo(-18 * s, 2 * s);
      cx.quadraticCurveTo(8 * s, 6 * s, 28 * s, -10 * s);
      cx.stroke();
      break;
    }
    case "pout": {
      cx.lineWidth = 5;
      cx.beginPath();
      cx.arc(0, 28 * s, 30 * s, Math.PI * 1.24, Math.PI * 1.76);
      cx.stroke();
      break;
    }
    case "pout_puff": {
      cx.lineWidth = 4.6;
      cx.beginPath();
      cx.arc(-4 * s, 20 * s, 20 * s, Math.PI * 1.22, Math.PI * 1.78);
      cx.stroke();
      cx.beginPath();
      cx.arc(23 * s, 4 * s, 12 * s, Math.PI * 0.72, Math.PI * 1.28);
      cx.stroke();
      break;
    }
    case "wavy": {
      const w = 26 * s;
      cx.lineWidth = 4.6;
      cx.beginPath();
      cx.moveTo(-w, 2);
      cx.quadraticCurveTo(-w * 0.5, -7 * s, 0, 2);
      cx.quadraticCurveTo(w * 0.5, 11 * s, w, 2);
      cx.stroke();
      break;
    }
    case "cat_w": {
      const r = 14 * s;
      cx.lineWidth = 5;
      cx.beginPath();
      cx.arc(-r, -4 * s, r, Math.PI * 0.92, Math.PI * 0.04, true);
      cx.arc(r, -4 * s, r, Math.PI * 0.96, Math.PI * 0.08, true);
      cx.stroke();
      break;
    }
    case "caret": {
      cx.lineWidth = 5;
      cx.beginPath();
      cx.moveTo(-14 * s, 6 * s);
      cx.lineTo(0, -8 * s);
      cx.lineTo(14 * s, 6 * s);
      cx.stroke();
      break;
    }
    case "kiss_3": {
      const r = 9 * s;
      cx.lineWidth = 4.8;
      cx.beginPath();
      cx.arc(-2, -r * 0.85, r, -Math.PI * 0.45, Math.PI * 0.55);
      cx.arc(-2, r * 0.85, r, -Math.PI * 0.55, Math.PI * 0.45);
      cx.stroke();
      break;
    }
    case "mute_x": {
      const d = 11 * s;
      cx.lineWidth = 4.5;
      cx.beginPath();
      cx.moveTo(-d, -d);
      cx.lineTo(d, d);
      cx.moveTo(d, -d);
      cx.lineTo(-d, d);
      cx.stroke();
      break;
    }
    case "dots_3": {
      for (let i = 0; i < 3; i++) {
        const phase = timeSec * 4.6 - i * 1.05 + 2.1;
        const wave = 0.5 + 0.5 * Math.cos(phase);
        const dotAlpha = alpha * (0.35 + 0.65 * wave);
        const hopY = -3.2 * s * Math.max(0, Math.sin(phase));
        cx.save();
        cx.globalAlpha = dotAlpha;
        cx.fillStyle = palette.core;
        fillCircle(cx, (i - 1) * 18 * s, hopY, 4.6 * s);
        cx.restore();
      }
      break;
    }
    case "smile":
    default: {
      cx.lineWidth = 5;
      cx.beginPath();
      cx.arc(0, -46 * s, 53.5 * s, Math.PI * 0.31, Math.PI * 0.69);
      cx.stroke();
      break;
    }
  }

  cx.restore();
}

function drawGlyph(
  cx: CanvasRenderingContext2D,
  glyph: FaceGlyphKind,
  eyeCenters: ReadonlyArray<{ x: number; y: number; scale: number }>,
  ambientOpacity: number,
  palette: TintPalette,
  resolveToken: TokenResolver,
  timeSec = 0,
): void {
  cx.save();
  cx.globalAlpha = ambientOpacity;
  cx.lineCap = "round";
  cx.lineJoin = "round";

  switch (glyph) {
    case "blush": {
      for (let i = 0; i < 2; i++) {
        const bx = eyeCenters[i].x + (i === 0 ? -12 : 12);
        const by = eyeCenters[i].y + 88;
        cx.save();
        cx.translate(bx, by);
        cx.scale(1, 0.52);
        const grad = cx.createRadialGradient(0, 0, 4, 0, 0, 56);
        grad.addColorStop(0, resolveToken("face-rose-blush"));
        grad.addColorStop(1, resolveToken("face-rose-zero"));
        cx.fillStyle = grad;
        fillCircle(cx, 0, 0, 56);
        cx.restore();
      }
      break;
    }
    case "scan_trails": {
      const shimmer = 0.24 + 0.14 * Math.abs(Math.sin(timeSec * 3.4));
      const stretch = Math.sin(timeSec * 3.4) * 8;
      cx.strokeStyle = palette.stroke;
      cx.lineWidth = 3;
      cx.globalAlpha = ambientOpacity * shimmer;
      for (const eye of eyeCenters) {
        cx.beginPath();
        cx.moveTo(eye.x - 132 - stretch, eye.y - 46);
        cx.lineTo(eye.x - 86, eye.y - 46);
        cx.moveTo(eye.x - 142 + stretch * 0.6, eye.y + 38);
        cx.lineTo(eye.x - 90, eye.y + 38);
        cx.stroke();
      }
      break;
    }
    case "spark_exclaim": {
      const bobY = Math.sin(timeSec * 3.2) * 3;
      cx.strokeStyle = palette.core;
      cx.fillStyle = palette.core;
      cx.lineWidth = 6.5;
      cx.beginPath();
      cx.moveTo(310, 38 + bobY);
      cx.lineTo(310, 68 + bobY);
      cx.stroke();
      fillCircle(cx, 310, 84 + bobY, 4.2);
      break;
    }
    case "star_sparkle": {
      const twinkle = 1 + 0.14 * Math.sin(timeSec * 3.8);
      const subTwinkle = 1 - 0.2 * Math.sin(timeSec * 3.8);
      fillFourPointStar(cx, 582, 56, 22 * twinkle, resolveToken("face-amber-core"));
      fillCircle(cx, 602, 80, Math.max(1.5, 3.2 * subTwinkle));
      break;
    }
    case "forehead_star": {
      const twinkle = 1 + 0.12 * Math.sin(timeSec * 3.2);
      const bobY = Math.sin(timeSec * 2.2) * 2.5;
      fillFourPointStar(cx, 310, 74 + bobY, 30 * twinkle, palette.core);
      break;
    }
    case "question": {
      const bobY = Math.sin(timeSec * 2.8) * 3;
      const tilt = Math.sin(timeSec * 2.0) * 0.09;
      cx.save();
      cx.translate(582, 68 + bobY);
      cx.rotate(tilt);
      cx.translate(-582, -68);
      cx.strokeStyle = palette.core;
      cx.fillStyle = palette.core;
      cx.lineWidth = 5.5;
      cx.beginPath();
      cx.arc(582, 52, 13, Math.PI * 1.1, Math.PI * 0.35);
      cx.quadraticCurveTo(582, 70, 582, 76);
      cx.stroke();
      fillCircle(cx, 582, 90, 3.6);
      cx.restore();
      break;
    }
    case "heart_float": {
      const swayX = Math.sin(timeSec * 2.2) * 3.5;
      const bobY = -Math.sin(timeSec * 2.9) * 5;
      const pulse = 1 + 0.07 * Math.sin(timeSec * 2.9);
      drawOutlineHeart(
        cx,
        578 + swayX,
        66 + bobY,
        22 * pulse,
        resolveToken("face-rose-core"),
      );
      break;
    }
    case "teardrop": {
      const dripY = (1 - Math.cos(timeSec * 2.6)) * 3.5;
      drawDroplet(
        cx,
        eyeCenters[0].x - 36,
        eyeCenters[0].y + 86 + dripY,
        18,
        resolveToken("face-mist-core"),
      );
      break;
    }
    case "corner_tear": {
      const dripY = (1 - Math.cos(timeSec * 2.2)) * 2.2;
      drawDroplet(
        cx,
        eyeCenters[1].x + 56,
        eyeCenters[1].y + 18 + dripY,
        9,
        resolveToken("face-mist-core"),
      );
      break;
    }
    case "sweat_drop": {
      const dripY = (1 - Math.cos(timeSec * 2.8)) * 4;
      drawDroplet(cx, 582, 78 + dripY, 19, resolveToken("face-mist-core"));
      break;
    }
    case "gloom_lines": {
      const sinkY = (1 - Math.cos(timeSec * 2.4)) * 3.2;
      cx.strokeStyle = palette.stroke;
      cx.lineWidth = 4;
      const xs = [566, 580, 594];
      const ys = [42, 34, 46];
      for (let i = 0; i < 3; i++) {
        const stagger = (1 - Math.cos(timeSec * 2.4 + i * 0.55)) * 1.2;
        cx.beginPath();
        cx.moveTo(xs[i], ys[i] + sinkY + stagger);
        cx.lineTo(xs[i], ys[i] + 28 + sinkY + stagger);
        cx.stroke();
      }
      break;
    }
    case "sigh_puff": {
      const breath = 0.5 - 0.5 * Math.cos(timeSec * 2.1);
      const driftX = breath * 9;
      const driftY = -breath * 3;
      cx.save();
      cx.translate(driftX, driftY);
      cx.strokeStyle = palette.stroke;
      cx.lineWidth = 4.2;
      cx.globalAlpha = ambientOpacity * (0.78 - breath * 0.24);
      cx.beginPath();
      cx.moveTo(352, 266);
      cx.quadraticCurveTo(398, 278, 418, 258);
      cx.arc(408, 248, 12, Math.PI * 0.3, Math.PI * 1.45, true);
      cx.stroke();
      cx.restore();
      break;
    }
    case "zzz": {
      // 3 staggered Z glyphs continuously spawning near brow, swaying & rising, dissolving at top
      for (let i = 0; i < 3; i++) {
        const phase = ((timeSec * 0.36) + (i + 0.5) / 3) % 1;
        const env =
          phase < 0.22
            ? phase / 0.22
            : phase > 0.76
              ? (1 - phase) / 0.24
              : 1;
        const zx = lerp(512, 590, phase) + Math.sin(phase * Math.PI * 2) * 5;
        const zy = lerp(104, 26, phase);
        const zSize = lerp(11.5, 25.5, phase);
        if (env > 0.01) {
          drawZGlyph(cx, zx, zy, zSize, palette.core, ambientOpacity * env * 0.95);
        }
      }
      break;
    }
    case "coffee_cup": {
      cx.fillStyle = palette.core;
      cx.strokeStyle = palette.stroke;
      cx.lineWidth = 3.5;
      // Cup body
      cx.beginPath();
      cx.moveTo(286, 266);
      cx.lineTo(330, 266);
      cx.quadraticCurveTo(328, 300, 308, 300);
      cx.quadraticCurveTo(288, 300, 286, 266);
      cx.closePath();
      cx.fill();
      // Cup handle & saucer
      cx.beginPath();
      cx.arc(331, 281, 8, -Math.PI * 0.45, Math.PI * 0.45);
      cx.stroke();
      cx.beginPath();
      cx.moveTo(278, 306);
      cx.lineTo(338, 306);
      cx.stroke();
      // Two rising curling steam wisps
      cx.lineWidth = 3;
      const steamLanes = [300, 316];
      for (let i = 0; i < 2; i++) {
        const sx = steamLanes[i];
        const phase = ((timeSec * 0.46) + (i + 0.36) / 2) % 1;
        const env = Math.sin(phase * Math.PI);
        const baseY = 258 - phase * 16;
        const sway = Math.sin(phase * Math.PI * 2 + i * 1.6) * 4.2;
        cx.save();
        cx.globalAlpha = ambientOpacity * 0.78 * env;
        cx.beginPath();
        cx.moveTo(sx, baseY);
        cx.quadraticCurveTo(sx - 5 + sway, baseY - 10, sx + 2 + sway * 0.7, baseY - 18);
        cx.quadraticCurveTo(sx + 6 - sway * 0.5, baseY - 24, sx + sway * 0.4, baseY - 31);
        cx.stroke();
        cx.restore();
      }
      break;
    }
    case "chew_cheeks": {
      const chew = Math.sin(timeSec * 5.6);
      const puffR = Math.max(12, 18 + chew * 1.8);
      const puffDx = chew * 3.2;
      cx.strokeStyle = palette.core;
      cx.lineWidth = 5;
      cx.beginPath();
      cx.arc(258 - puffDx, 256, puffR, Math.PI * 0.68, Math.PI * 1.32);
      cx.stroke();
      cx.beginPath();
      cx.arc(362 + puffDx, 256, puffR, -Math.PI * 0.32, Math.PI * 0.32);
      cx.stroke();
      break;
    }
    case "straw_cup": {
      const bobY = Math.sin(timeSec * 3.4) * 1.5;
      cx.strokeStyle = palette.core;
      cx.lineWidth = 5.5;
      // Straw from mouth into cup
      cx.beginPath();
      cx.moveTo(304, 232);
      cx.lineTo(328, 256 + bobY * 0.5);
      cx.lineTo(318, 326 + bobY);
      cx.stroke();
      // Sipping droplet traveling smoothly up the straw (sipEnv = 0 at t = 0)
      const sipP = (timeSec * 0.72) % 1;
      const sipEnv = Math.sin(sipP * Math.PI);
      if (sipEnv > 0.01) {
        let bx = 318;
        let by = 320;
        if (sipP < 0.68) {
          const seg = sipP / 0.68;
          bx = lerp(318, 328, seg);
          by = lerp(322 + bobY, 256 + bobY * 0.5, seg);
        } else {
          const seg = (sipP - 0.68) / 0.32;
          bx = lerp(328, 304, seg);
          by = lerp(256 + bobY * 0.5, 232, seg);
        }
        cx.save();
        cx.globalAlpha = ambientOpacity * 0.85 * sipEnv;
        cx.fillStyle = palette.core;
        fillCircle(cx, bx, by, 4.2);
        cx.restore();
      }
      // Cup rim & sides
      cx.lineWidth = 4.5;
      cx.beginPath();
      cx.moveTo(266, 328 + bobY);
      cx.lineTo(262, 286 + bobY);
      cx.lineTo(358, 286 + bobY);
      cx.lineTo(354, 328 + bobY);
      cx.stroke();
      break;
    }
    case "music_notes": {
      const n1x = 42 + Math.sin(timeSec * 2.4) * 3.5;
      const n1y = 168 + Math.sin(timeSec * 3.8) * 7;
      const n2x = 566 + Math.sin(timeSec * 2.1 + 1.2) * 3.5;
      const n2y = 94 + Math.sin(timeSec * 3.8 + 1.9) * 7.5;
      const n3x = 582 + Math.sin(timeSec * 2.6 + 2.4) * 3;
      const n3y = 198 + Math.sin(timeSec * 3.8 + 3.8) * 6.5;
      drawSingleNote(cx, n1x, n1y, 0.9, palette.core);
      drawBeamedNote(cx, n2x, n2y, 1, palette.core);
      drawSingleNote(cx, n3x, n3y, 0.78, palette.core);
      break;
    }
    case "glasses": {
      const left = eyeCenters[0];
      const right = eyeCenters[1];
      const leftFrameR = 96 * left.scale + 12;
      const rightFrameR = 96 * right.scale + 12;
      cx.strokeStyle = palette.core;
      cx.lineWidth = 4.5;
      cx.beginPath();
      cx.arc(left.x, left.y, leftFrameR, 0, Math.PI * 2);
      cx.stroke();
      cx.beginPath();
      cx.arc(right.x, right.y, rightFrameR, 0, Math.PI * 2);
      cx.stroke();
      // Bridge connecting inner rims & outer temple ticks
      cx.beginPath();
      cx.moveTo(left.x + leftFrameR, left.y - 4);
      cx.quadraticCurveTo(
        (left.x + right.x) / 2,
        (left.y + right.y) / 2 - 24,
        right.x - rightFrameR,
        right.y - 4,
      );
      cx.stroke();
      cx.beginPath();
      cx.moveTo(left.x - leftFrameR - 10, left.y - 4);
      cx.lineTo(left.x - leftFrameR, left.y - 4);
      cx.moveTo(right.x + rightFrameR, right.y - 4);
      cx.lineTo(right.x + rightFrameR + 10, right.y - 4);
      cx.stroke();
      break;
    }
    case "timer_clock": {
      const minAngle = -Math.PI / 2 + timeSec * 2.2;
      const hourAngle = Math.PI / 6 + timeSec * 0.22;
      cx.strokeStyle = palette.core;
      cx.lineWidth = 4.2;
      cx.beginPath();
      cx.arc(310, 68, 24, 0, Math.PI * 2);
      cx.stroke();
      // Top button & rotating hands
      cx.beginPath();
      cx.moveTo(303, 39);
      cx.lineTo(317, 39);
      cx.moveTo(310, 68);
      cx.lineTo(310 + Math.cos(minAngle) * 14, 68 + Math.sin(minAngle) * 14);
      cx.moveTo(310, 68);
      cx.lineTo(310 + Math.cos(hourAngle) * 11.5, 68 + Math.sin(hourAngle) * 11.5);
      cx.stroke();
      break;
    }
    case "confetti": {
      const amber = resolveToken("face-amber-core");
      const rose = resolveToken("face-rose-core");
      const sage = resolveToken("face-sage-core");
      const bob = (i: number) => Math.sin(timeSec * 3.2 + i * 1.1) * 5.5;
      const sway = (i: number) => Math.sin(timeSec * 2.1 + i * 1.7) * 3.2;
      const tw = (i: number) => 1 + 0.14 * Math.sin(timeSec * 4.2 + i * 1.3);
      fillFourPointStar(cx, 54 + sway(0), 128 + bob(0), 12 * tw(0), sage);
      fillFourPointStar(cx, 566 + sway(1), 98 + bob(1), 16 * tw(1), sage);
      fillFourPointStar(cx, 588 + sway(2), 168 + bob(2), 11 * tw(2), amber);
      fillDiamond(cx, 128 + sway(3), 66 + bob(3), 9 * tw(3), rose);
      fillDiamond(cx, 96 + sway(4), 268 + bob(4), 13 * tw(4), rose);
      cx.fillStyle = amber;
      fillCircle(cx, 392 + sway(5), 58 + bob(5), 6 * tw(5));
      fillCircle(cx, 546 + sway(6), 228 + bob(6), 7 * tw(6));
      cx.fillStyle = sage;
      fillCircle(cx, 286 + sway(7), 78 + bob(7), 5 * tw(7));
      break;
    }
    case "terminal_prompt": {
      const cursorAlpha = clamp(0.5 + Math.cos(timeSec * Math.PI * 2.2) * 1.4, 0.08, 1);
      cx.strokeStyle = palette.core;
      cx.lineWidth = 4.2;
      cx.beginPath();
      cx.moveTo(560, 44);
      cx.lineTo(574, 55);
      cx.lineTo(560, 66);
      cx.stroke();
      cx.save();
      cx.globalAlpha = ambientOpacity * cursorAlpha;
      cx.beginPath();
      cx.moveTo(580, 68);
      cx.lineTo(598, 68);
      cx.stroke();
      cx.restore();
      break;
    }
    case "magnifier": {
      const right = eyeCenters[1];
      const ox = Math.sin(timeSec * 2.6) * 7.5;
      const oy = (1 - Math.cos(timeSec * 2.6)) * 4.5;
      const mx = right.x + ox;
      const my = right.y + oy;
      const ringR = 92 * right.scale + 18;
      cx.strokeStyle = palette.core;
      cx.lineWidth = 5;
      cx.beginPath();
      cx.arc(mx, my, ringR, 0, Math.PI * 2);
      cx.stroke();
      cx.lineWidth = 10;
      cx.beginPath();
      cx.moveTo(mx + ringR * 0.72, my + ringR * 0.72);
      cx.lineTo(mx + ringR * 1.08, my + ringR * 1.08);
      cx.stroke();
      break;
    }
    case "checkmark": {
      const bobY = Math.sin(timeSec * 2.6) * 2.5;
      cx.strokeStyle = resolveToken("face-sage-edge");
      cx.lineWidth = 5.5;
      cx.beginPath();
      cx.moveTo(566, 54 + bobY);
      cx.lineTo(577, 66 + bobY);
      cx.lineTo(598, 42 + bobY);
      cx.stroke();
      break;
    }
    case "warning_bang": {
      const pulse = 0.78 + 0.22 * Math.cos(timeSec * 4.2);
      const bobY = Math.sin(timeSec * 4.2) * 2.2;
      const amber = resolveToken("face-amber-edge");
      cx.save();
      cx.globalAlpha = ambientOpacity * pulse;
      cx.strokeStyle = amber;
      cx.fillStyle = amber;
      cx.lineWidth = 6.5;
      cx.beginPath();
      cx.moveTo(584, 38 + bobY);
      cx.lineTo(584, 68 + bobY);
      cx.stroke();
      fillCircle(cx, 584, 84 + bobY, 4.2);
      cx.restore();
      break;
    }
    case "memory_dots": {
      const dots = [
        { x: 588, y: 86, r: 6 },
        { x: 578, y: 64, r: 8.5 },
        { x: 556, y: 52, r: 5.5 },
      ];
      cx.fillStyle = palette.core;
      for (let i = 0; i < dots.length; i++) {
        const d = dots[i];
        const phase = timeSec * 3.8 - i * 1.15 + 1.15;
        const wave = 0.5 + 0.5 * Math.cos(phase);
        const a = 0.38 + 0.62 * wave;
        const dy = -Math.sin(phase) * 2.4;
        cx.globalAlpha = ambientOpacity * a;
        fillCircle(cx, d.x, d.y + dy, d.r);
      }
      break;
    }
    case "hourglass": {
      const amber = resolveToken("face-amber-edge");
      cx.strokeStyle = amber;
      cx.lineWidth = 3.8;
      cx.beginPath();
      cx.moveTo(566, 40);
      cx.lineTo(594, 40);
      cx.moveTo(566, 82);
      cx.lineTo(594, 82);
      cx.moveTo(569, 40);
      cx.lineTo(591, 82);
      cx.moveTo(591, 40);
      cx.lineTo(569, 82);
      cx.stroke();
      const sandP = (timeSec * 0.95) % 1;
      const sandEnv = Math.sin(sandP * Math.PI);
      if (sandEnv > 0.01) {
        cx.save();
        cx.globalAlpha = ambientOpacity * 0.88 * sandEnv;
        cx.fillStyle = amber;
        fillCircle(cx, 580, lerp(61, 79, sandP), 2.3);
        cx.restore();
      }
      break;
    }
    case "offline_wave": {
      cx.strokeStyle = palette.stroke;
      cx.lineWidth = 3.8;
      const radii = [14, 26];
      for (let i = 0; i < radii.length; i++) {
        const pulse = 0.36 + 0.48 * (0.5 + 0.5 * Math.cos(timeSec * 2.8 - i * 1.0));
        cx.globalAlpha = ambientOpacity * pulse;
        cx.beginPath();
        cx.arc(578, 72, radii[i], -Math.PI * 0.78, -Math.PI * 0.22);
        cx.stroke();
      }
      // Slash across wave
      cx.globalAlpha = ambientOpacity * 0.78;
      cx.beginPath();
      cx.moveTo(562, 42);
      cx.lineTo(594, 74);
      cx.stroke();
      break;
    }
    case "lightning": {
      const bobY = Math.sin(timeSec * 2.8) * 3.5;
      const pulse = 1 + 0.065 * Math.sin(timeSec * 2.8);
      cx.save();
      cx.translate(311, 67 + bobY);
      cx.scale(pulse, pulse);
      cx.translate(-311, -67);
      cx.fillStyle = resolveToken("face-sage-edge");
      cx.beginPath();
      cx.moveTo(316, 36);
      cx.lineTo(294, 68);
      cx.lineTo(310, 68);
      cx.lineTo(304, 98);
      cx.lineTo(328, 62);
      cx.lineTo(312, 62);
      cx.closePath();
      cx.fill();
      cx.restore();
      break;
    }
    case "wifi_arcs": {
      cx.strokeStyle = palette.core;
      cx.lineWidth = 4.6;
      const radii = [22, 38, 54];
      for (let i = 0; i < radii.length; i++) {
        const wave = 0.32 + 0.68 * (0.5 + 0.5 * Math.cos(timeSec * 4.4 - i * 1.05));
        cx.globalAlpha = ambientOpacity * wave;
        cx.beginPath();
        cx.arc(544, 94, radii[i], -Math.PI * 0.46, -Math.PI * 0.04);
        cx.stroke();
      }
      break;
    }
    case "sun_rays": {
      const amber = resolveToken("face-amber-core");
      const spin = timeSec * 0.55;
      cx.fillStyle = amber;
      cx.strokeStyle = amber;
      fillCircle(cx, 576, 56, 12);
      cx.lineWidth = 3.2;
      for (let i = 0; i < 8; i++) {
        const a = (i * Math.PI) / 4 + spin;
        const outer = 23 + Math.sin(timeSec * 2.6 + (i % 2) * Math.PI) * 1.4;
        cx.beginPath();
        cx.moveTo(576 + Math.cos(a) * 17, 56 + Math.sin(a) * 17);
        cx.lineTo(576 + Math.cos(a) * outer, 56 + Math.sin(a) * outer);
        cx.stroke();
      }
      break;
    }
    case "raindrops": {
      cx.strokeStyle = resolveToken("face-mist-core");
      cx.lineWidth = 5;
      const lanes = [
        { x: 568, y: 26 },
        { x: 590, y: 34 },
        { x: 606, y: 24 },
      ];
      for (let i = 0; i < lanes.length; i++) {
        const phase = ((timeSec * 0.78) + (i + 0.25) / lanes.length) % 1;
        const env = Math.sin(phase * Math.PI);
        const rx = lanes[i].x - phase * 18;
        const ry = lanes[i].y + phase * 34;
        cx.save();
        cx.globalAlpha = ambientOpacity * 0.92 * env;
        cx.beginPath();
        cx.moveTo(rx, ry);
        cx.lineTo(rx - 12, ry + 21);
        cx.stroke();
        cx.restore();
      }
      break;
    }
  }

  cx.restore();
}

function drawSoftEyeBloom(
  cx: CanvasRenderingContext2D,
  x: number,
  y: number,
  outerRadius: number,
  palette: TintPalette,
): void {
  const halo = cx.createRadialGradient(x, y, outerRadius * 0.15, x, y, outerRadius);
  halo.addColorStop(0, palette.haloCore);
  halo.addColorStop(0.55, palette.haloMid);
  halo.addColorStop(1, palette.haloZero);
  cx.fillStyle = halo;
  fillCircle(cx, x, y, outerRadius);
}

function fillHeart(
  cx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  palette: TintPalette,
): void {
  const topY = y - size * 0.34;
  const bottomY = y + size * 0.78;
  const grad = cx.createRadialGradient(x, y, 0, x, y, size);
  grad.addColorStop(0, palette.core);
  grad.addColorStop(1, palette.edge);
  cx.fillStyle = grad;
  cx.beginPath();
  cx.moveTo(x, bottomY);
  cx.bezierCurveTo(
    x - size * 1.05,
    y + size * 0.16,
    x - size * 0.98,
    y - size * 0.76,
    x,
    topY,
  );
  cx.bezierCurveTo(
    x + size * 0.98,
    y - size * 0.76,
    x + size * 1.05,
    y + size * 0.16,
    x,
    bottomY,
  );
  cx.closePath();
  cx.fill();
}

function drawOutlineHeart(
  cx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  color: string,
): void {
  const topY = y - size * 0.32;
  const bottomY = y + size * 0.82;
  cx.strokeStyle = color;
  cx.lineWidth = 4.6;
  cx.beginPath();
  cx.moveTo(x, bottomY);
  cx.bezierCurveTo(
    x - size * 1.08,
    y + size * 0.16,
    x - size * 0.98,
    y - size * 0.78,
    x,
    topY,
  );
  cx.bezierCurveTo(
    x + size * 0.98,
    y - size * 0.78,
    x + size * 1.08,
    y + size * 0.16,
    x,
    bottomY,
  );
  cx.closePath();
  cx.stroke();
}

function fillFourPointStar(
  cx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  color: string,
): void {
  const inner = radius * 0.26;
  cx.fillStyle = color;
  cx.beginPath();
  cx.moveTo(x, y - radius);
  cx.quadraticCurveTo(x + inner, y - inner, x + radius, y);
  cx.quadraticCurveTo(x + inner, y + inner, x, y + radius);
  cx.quadraticCurveTo(x - inner, y + inner, x - radius, y);
  cx.quadraticCurveTo(x - inner, y - inner, x, y - radius);
  cx.closePath();
  cx.fill();
}

function fillDiamond(
  cx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  color: string,
): void {
  cx.fillStyle = color;
  cx.beginPath();
  cx.moveTo(x, y - radius);
  cx.lineTo(x + radius, y);
  cx.lineTo(x, y + radius);
  cx.lineTo(x - radius, y);
  cx.closePath();
  cx.fill();
}

function drawSpiralEye(
  cx: CanvasRenderingContext2D,
  x: number,
  y: number,
  maxRadius: number,
  mirror: boolean,
  color: string,
  lineWidth: number,
  spinRad = 0,
): void {
  const steps = 54;
  const maxTheta = Math.PI * 5.4;
  const dir = mirror ? -1 : 1;
  cx.save();
  cx.translate(x, y);
  if (spinRad !== 0) {
    cx.rotate(dir * spinRad);
  }
  cx.strokeStyle = color;
  cx.lineWidth = lineWidth;
  cx.lineCap = "round";
  cx.beginPath();
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const theta = t * maxTheta;
    const r = (0.08 + 0.92 * t) * maxRadius;
    const px = dir * Math.cos(theta) * r;
    const py = Math.sin(theta) * r;
    if (i === 0) cx.moveTo(px, py);
    else cx.lineTo(px, py);
  }
  cx.stroke();
  cx.restore();
}

function drawDroplet(
  cx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  color: string,
): void {
  cx.fillStyle = color;
  cx.beginPath();
  cx.moveTo(x, y - radius * 1.45);
  cx.quadraticCurveTo(x + radius * 1.15, y - radius * 0.1, x + radius * 0.88, y + radius * 0.48);
  cx.arc(x, y + radius * 0.36, radius * 0.92, Math.PI * 0.08, Math.PI * 0.92);
  cx.quadraticCurveTo(x - radius * 1.15, y - radius * 0.1, x, y - radius * 1.45);
  cx.closePath();
  cx.fill();
}

function drawZGlyph(
  cx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  color: string,
  alpha: number,
): void {
  cx.save();
  cx.globalAlpha = alpha;
  cx.strokeStyle = color;
  cx.lineWidth = Math.max(3, size * 0.2);
  cx.beginPath();
  cx.moveTo(x - size * 0.45, y - size * 0.45);
  cx.lineTo(x + size * 0.45, y - size * 0.45);
  cx.lineTo(x - size * 0.45, y + size * 0.45);
  cx.lineTo(x + size * 0.45, y + size * 0.45);
  cx.stroke();
  cx.restore();
}

function drawSingleNote(
  cx: CanvasRenderingContext2D,
  x: number,
  y: number,
  scale: number,
  color: string,
): void {
  cx.fillStyle = color;
  cx.strokeStyle = color;
  cx.lineWidth = 3.8 * scale;
  fillCircle(cx, x, y, 6.5 * scale);
  cx.beginPath();
  cx.moveTo(x + 5 * scale, y);
  cx.lineTo(x + 5 * scale, y - 26 * scale);
  cx.quadraticCurveTo(x + 16 * scale, y - 22 * scale, x + 15 * scale, y - 12 * scale);
  cx.stroke();
}

function drawBeamedNote(
  cx: CanvasRenderingContext2D,
  x: number,
  y: number,
  scale: number,
  color: string,
): void {
  cx.fillStyle = color;
  cx.strokeStyle = color;
  cx.lineWidth = 3.8 * scale;
  fillCircle(cx, x, y, 6.5 * scale);
  fillCircle(cx, x + 22 * scale, y - 5 * scale, 6.5 * scale);
  cx.beginPath();
  cx.moveTo(x + 5 * scale, y);
  cx.lineTo(x + 5 * scale, y - 26 * scale);
  cx.lineTo(x + 27 * scale, y - 31 * scale);
  cx.lineTo(x + 27 * scale, y - 5 * scale);
  cx.stroke();
}

function fillCircle(
  cx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
): void {
  cx.beginPath();
  cx.arc(x, y, r, 0, Math.PI * 2);
  cx.fill();
}

function cloneVisualState(s: FaceVisualState): FaceVisualState {
  return {
    expression: s.expression,
    gaze: { x: s.gaze.x, y: s.gaze.y },
    blinkProgress: s.blinkProgress,
  };
}

/** The 620 x 340 OLED companion face driven by declarative 72-expression recipes. */
export function RobotFace(props: {
  active?: boolean;
  state: FaceVisualState;
  shift: { dx: number; dy: number };
}) {
  const breath = createMotion();
  const activeBreath = computed(() => {
    const recipe =
      FACE_EXPRESSION_RECIPES[props.state.expression] ??
      FACE_EXPRESSION_RECIPES.neutral;
    return (
      props.active !== false &&
      lifecycle() === "active" &&
      !reduceMotion() &&
      recipe.allowsBreath !== false
    );
  });
  effect(() => {
    if (activeBreath())
      void breath.play({
        keyframes: { opacity: [0.97, 1] },
        duration: 3100,
        direction: "alternate",
        iterations: "infinite",
        easing: "easeInOut",
      });
    else breath.reset();
    return () => breath.stop();
  });

  const mountEpoch = Date.now();
  const initial = cloneVisualState(props.state);
  let fromSnapshot = initial;
  let toSnapshot = initial;
  let transitionStartMs = mountEpoch;
  let transitionDurationMs = 0;
  let currentEased = 1;
  let timer: ReturnType<typeof setInterval> | null = null;
  let timerIntervalMs = 0;
  const frame = signal<{
    from: FaceVisualState;
    to: FaceVisualState;
    progress: number;
    timeSec: number;
  }>({
    from: initial,
    to: initial,
    progress: 1,
    timeSec: 0,
  });

  const stopTimer = () => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
      timerIntervalMs = 0;
    }
  };
  cleanup(stopTimer);

  const syncTicker = (active: boolean) => {
    if (!active) {
      stopTimer();
      fromSnapshot = toSnapshot;
      currentEased = 1;
      frame.set({
        from: toSnapshot,
        to: toSnapshot,
        progress: 1,
        timeSec: 0,
      });
      return;
    }

    const inTransition = currentEased < 1;
    const needsAmbient =
      hasAmbientMotion(toSnapshot.expression) ||
      (inTransition && hasAmbientMotion(fromSnapshot.expression));

    if (!inTransition && !needsAmbient) {
      stopTimer();
      return;
    }

    const desiredIntervalMs = inTransition ? 16 : 28;
    if (timer !== null && timerIntervalMs === desiredIntervalMs) {
      return;
    }

    stopTimer();
    timerIntervalMs = desiredIntervalMs;
    timer = setInterval(() => {
      const now = Date.now();
      const elapsedSec = (now - mountEpoch) / 1000;
      if (currentEased < 1) {
        const raw =
          transitionDurationMs > 0
            ? (now - transitionStartMs) / transitionDurationMs
            : 1;
        if (raw >= 1) {
          fromSnapshot = toSnapshot;
          currentEased = 1;
          const keepAmbient = hasAmbientMotion(toSnapshot.expression);
          frame.set({
            from: toSnapshot,
            to: toSnapshot,
            progress: 1,
            timeSec: keepAmbient ? elapsedSec : 0,
          });
          syncTicker(true);
          return;
        }
        currentEased = easeOutCubic(raw);
        frame.set({
          from: fromSnapshot,
          to: toSnapshot,
          progress: currentEased,
          timeSec: elapsedSec,
        });
        return;
      }
      frame.set({
        from: toSnapshot,
        to: toSnapshot,
        progress: 1,
        timeSec: elapsedSec,
      });
    }, desiredIntervalMs);
  };

  effect(() => {
    const active = props.active !== false && lifecycle() === "active" && !reduceMotion();
    const next = cloneVisualState(props.state);
    const exprChanged = toSnapshot.expression !== next.expression;
    const gazeDelta =
      Math.abs(toSnapshot.gaze.x - next.gaze.x) +
      Math.abs(toSnapshot.gaze.y - next.gaze.y);
    const blinkDelta = Math.abs(
      normalizeBlinkProgress(toSnapshot) - normalizeBlinkProgress(next),
    );

    if (!active) {
      fromSnapshot = next;
      toSnapshot = next;
      currentEased = 1;
      syncTicker(false);
      return;
    }

    if (!exprChanged && gazeDelta < 0.002 && blinkDelta < 0.002) {
      syncTicker(true);
      return;
    }

    // Mid-flight interruption: start seamlessly from the currently displayed state
    const now = Date.now();
    const elapsedSec = (now - mountEpoch) / 1000;
    const startFrom: FaceVisualState =
      currentEased >= 0.999
        ? toSnapshot
        : {
            expression:
              currentEased < 0.45 ? fromSnapshot.expression : toSnapshot.expression,
            gaze: {
              x: lerp(fromSnapshot.gaze.x, toSnapshot.gaze.x, currentEased),
              y: lerp(fromSnapshot.gaze.y, toSnapshot.gaze.y, currentEased),
            },
            blinkProgress: lerp(
              normalizeBlinkProgress(fromSnapshot),
              normalizeBlinkProgress(toSnapshot),
              currentEased,
            ),
          };

    transitionDurationMs = exprChanged ? 260 : gazeDelta >= 0.01 ? 190 : 95;
    transitionStartMs = now;
    fromSnapshot = startFrom;
    toSnapshot = next;
    currentEased = 0;
    frame.set({
      from: startFrom,
      to: next,
      progress: 0,
      timeSec: elapsedSec,
    });
    syncTicker(true);
  });

  return (
    <Canvas
      testID="looi-face"
      accessibilityLabel={t("looisRoundeyeExpression")}
      role="image"
      class="absolute inset-0"
      style={{ minHeight: 180, opacity: breath.opacity }}
      draw={(cx, size) => {
        const currentFrame = frame();
        drawRobotFaceTransition(
          cx,
          size,
          currentFrame.from,
          currentFrame.to,
          currentFrame.progress,
          props.shift,
          token,
          safeArea(),
          currentFrame.timeSec,
        );
      }}
    />
  );
}
