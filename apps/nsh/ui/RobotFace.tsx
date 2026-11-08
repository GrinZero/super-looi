import { t } from "../i18n";
import {
  Canvas,
  computed,
  createMotion,
  effect,
  lifecycle,
  reduceMotion,
  safeArea,
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

function clamp(value: number, minimum: number, maximum: number): number {
  return Number.isFinite(value)
    ? Math.max(minimum, Math.min(maximum, value))
    : minimum;
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
): void {
  const recipe =
    FACE_EXPRESSION_RECIPES[state.expression] ?? FACE_EXPRESSION_RECIPES.neutral;
  const tint = recipe.tint ?? "warm";
  const palette = resolveTintPalette(tint, resolveToken);
  const ambientOpacity = clamp(recipe.ambientOpacity ?? 1, 0.1, 1);
  const blink = clamp(state.blinkProgress, 0, 1);
  const gazeX = clamp(state.gaze.x, -1, 1);
  const gazeY = -clamp(state.gaze.y, -1, 1);
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
    const spec = recipe.eyes[index];
    eyeCenters[index] = {
      x: (index === 0 ? 130 : 490) + gazeX * 10 + (spec.dx ?? 0),
      y: 158 + gazeY * 9 + (spec.dy ?? 0),
      scale: spec.scale ?? 1,
    };
  }

  // 3b. Underlay glyphs (soft cheek blush & scan trails behind eyes)
  if (recipe.glyphs) {
    for (const glyph of recipe.glyphs) {
      if (glyph === "blush" || glyph === "scan_trails") {
        drawGlyph(cx, glyph, eyeCenters, ambientOpacity, palette, resolveToken);
      }
    }
  }

  // 4. Dual eyes across the 5 orthogonal channels
  for (let index = 0; index < 2; index++) {
    drawEye(
      cx,
      index,
      recipe.eyes[index],
      eyeCenters[index].x,
      eyeCenters[index].y,
      blink,
      ambientOpacity,
      tint === "coral",
      palette,
    );
  }

  // 5. Expression mouth; audio amplitude does not change its shape.
  const mouthX = 310 + gazeX * 4 + (recipe.mouth.dx ?? 0);
  const mouthY = 263 + gazeY * 3 + (recipe.mouth.dy ?? 0);
  drawMouth(cx, recipe.mouth, mouthX, mouthY, ambientOpacity, palette);

  // 6. Planar companion micro-glyphs (foreground layer)
  if (recipe.glyphs) {
    for (const glyph of recipe.glyphs) {
      if (glyph !== "blush" && glyph !== "scan_trails") {
        drawGlyph(cx, glyph, eyeCenters, ambientOpacity, palette, resolveToken);
      }
    }
  }

  cx.restore();
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
): void {
  const shape = spec.shape ?? "orb";
  const baseScale = spec.scale ?? 1;
  const closedByBlink = shape === "orb" && blink >= 0.98;

  if (shape === "line" || closedByBlink) {
    const lineHalfWidth = 78 * baseScale;
    cx.save();
    cx.strokeStyle = palette.stroke;
    cx.globalAlpha = ambientOpacity * (spec.opacity ?? 0.4);
    cx.lineWidth = 4;
    cx.lineCap = "round";
    cx.beginPath();
    cx.moveTo(baseX - lineHalfWidth, baseY);
    cx.lineTo(baseX + lineHalfWidth, baseY);
    cx.stroke();
    cx.restore();
    return;
  }

  const blinkScale = shape === "orb" ? 1 - blink * 0.08 : 1;
  const blinkOpacity =
    ambientOpacity * (spec.opacity ?? 1) * (shape === "orb" ? 1 - blink * 0.32 : 1);
  const ratio = baseScale * blinkScale;
  const radius = 92 * ratio;

  cx.save();
  cx.globalAlpha = blinkOpacity;

  if (shape === "orb") {
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
    if (spec.rippleRings && spec.rippleRings > 0) {
      for (let ring = 1; ring <= spec.rippleRings; ring++) {
        cx.save();
        cx.strokeStyle = palette.stroke;
        cx.lineWidth = 2.4;
        cx.globalAlpha = blinkOpacity * (ring === 1 ? 0.36 : 0.18);
        cx.beginPath();
        cx.arc(baseX, baseY, radius * (1 + ring * 0.16), 0, Math.PI * 2);
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
    if (spec.underArc) {
      cx.save();
      cx.strokeStyle = palette.core;
      cx.lineCap = "round";
      cx.lineWidth = 3.5 * ratio;
      cx.globalAlpha = blinkOpacity * 0.65;
      cx.beginPath();
      cx.arc(baseX, baseY + 14 * ratio, radius + 6 * ratio, Math.PI * 0.24, Math.PI * 0.76);
      cx.stroke();
      cx.globalAlpha = blinkOpacity * 0.34;
      cx.beginPath();
      cx.arc(baseX, baseY + 22 * ratio, radius + 10 * ratio, Math.PI * 0.28, Math.PI * 0.72);
      cx.stroke();
      cx.restore();
    }
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
      fillHeart(cx, baseX, baseY, radius * 0.94, palette);
    } else if (shape === "star4") {
      fillFourPointStar(cx, baseX, baseY, radius * 0.96, palette.core);
    } else if (shape === "spiral") {
      drawSpiralEye(cx, baseX, baseY, radius * 0.9, index === 1, palette.core, 8.5 * ratio);
    }
  }

  // 4c. Conditional outer eyebrow
  if (spec.brow !== undefined) {
    const brow = spec.brow;
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

  cx.restore();
}

function drawMouth(
  cx: CanvasRenderingContext2D,
  mouth: MouthSpec,
  mouthX: number,
  mouthY: number,
  ambientOpacity: number,
  palette: TintPalette,
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
      cx.fillStyle = palette.core;
      cx.beginPath();
      cx.ellipse(0, 2, 16 * s, 26 * s, 0, 0, Math.PI * 2);
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
      const alphas = [0.45, 0.72, 1];
      for (let i = 0; i < 3; i++) {
        cx.save();
        cx.globalAlpha = alpha * alphas[i];
        cx.fillStyle = palette.core;
        fillCircle(cx, (i - 1) * 18 * s, 0, 4.6 * s);
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
      cx.strokeStyle = palette.stroke;
      cx.lineWidth = 3;
      cx.globalAlpha = ambientOpacity * 0.28;
      for (const eye of eyeCenters) {
        cx.beginPath();
        cx.moveTo(eye.x - 132, eye.y - 46);
        cx.lineTo(eye.x - 86, eye.y - 46);
        cx.moveTo(eye.x - 142, eye.y + 38);
        cx.lineTo(eye.x - 90, eye.y + 38);
        cx.stroke();
      }
      break;
    }
    case "spark_exclaim": {
      cx.strokeStyle = palette.core;
      cx.fillStyle = palette.core;
      cx.lineWidth = 6.5;
      cx.beginPath();
      cx.moveTo(310, 38);
      cx.lineTo(310, 68);
      cx.stroke();
      fillCircle(cx, 310, 84, 4.2);
      break;
    }
    case "star_sparkle": {
      fillFourPointStar(cx, 582, 56, 22, resolveToken("face-amber-core"));
      fillCircle(cx, 602, 80, 3.2);
      break;
    }
    case "forehead_star": {
      fillFourPointStar(cx, 310, 74, 30, palette.core);
      break;
    }
    case "question": {
      cx.strokeStyle = palette.core;
      cx.fillStyle = palette.core;
      cx.lineWidth = 5.5;
      cx.beginPath();
      cx.arc(582, 52, 13, Math.PI * 1.1, Math.PI * 0.35);
      cx.quadraticCurveTo(582, 70, 582, 76);
      cx.stroke();
      fillCircle(cx, 582, 90, 3.6);
      break;
    }
    case "heart_float": {
      drawOutlineHeart(cx, 578, 66, 22, resolveToken("face-rose-core"));
      break;
    }
    case "teardrop": {
      drawDroplet(
        cx,
        eyeCenters[0].x - 36,
        eyeCenters[0].y + 86,
        18,
        resolveToken("face-mist-core"),
      );
      break;
    }
    case "corner_tear": {
      drawDroplet(
        cx,
        eyeCenters[1].x + 56,
        eyeCenters[1].y + 18,
        9,
        resolveToken("face-mist-core"),
      );
      break;
    }
    case "sweat_drop": {
      drawDroplet(cx, 582, 78, 19, resolveToken("face-mist-core"));
      break;
    }
    case "gloom_lines": {
      cx.strokeStyle = palette.stroke;
      cx.lineWidth = 4;
      const xs = [566, 580, 594];
      const ys = [42, 34, 46];
      for (let i = 0; i < 3; i++) {
        cx.beginPath();
        cx.moveTo(xs[i], ys[i]);
        cx.lineTo(xs[i], ys[i] + 28);
        cx.stroke();
      }
      break;
    }
    case "sigh_puff": {
      cx.strokeStyle = palette.stroke;
      cx.lineWidth = 4.2;
      cx.globalAlpha = ambientOpacity * 0.78;
      cx.beginPath();
      cx.moveTo(352, 266);
      cx.quadraticCurveTo(398, 278, 418, 258);
      cx.arc(408, 248, 12, Math.PI * 0.3, Math.PI * 1.45, true);
      cx.stroke();
      break;
    }
    case "zzz": {
      drawZGlyph(cx, 520, 96, 13, palette.core, ambientOpacity * 0.62);
      drawZGlyph(cx, 548, 68, 18, palette.core, ambientOpacity * 0.8);
      drawZGlyph(cx, 582, 36, 24, palette.core, ambientOpacity);
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
      // Two gentle steam wisps
      cx.lineWidth = 3;
      cx.globalAlpha = ambientOpacity * 0.72;
      for (const sx of [301, 315]) {
        cx.beginPath();
        cx.moveTo(sx, 256);
        cx.quadraticCurveTo(sx - 5, 246, sx + 2, 238);
        cx.quadraticCurveTo(sx + 6, 232, sx, 224);
        cx.stroke();
      }
      break;
    }
    case "chew_cheeks": {
      cx.strokeStyle = palette.core;
      cx.lineWidth = 5;
      cx.beginPath();
      cx.arc(258, 256, 18, Math.PI * 0.68, Math.PI * 1.32);
      cx.stroke();
      cx.beginPath();
      cx.arc(362, 256, 18, -Math.PI * 0.32, Math.PI * 0.32);
      cx.stroke();
      break;
    }
    case "straw_cup": {
      cx.strokeStyle = palette.core;
      cx.lineWidth = 5.5;
      // Straw from mouth into cup
      cx.beginPath();
      cx.moveTo(304, 232);
      cx.lineTo(328, 256);
      cx.lineTo(318, 326);
      cx.stroke();
      // Cup rim & sides
      cx.lineWidth = 4.5;
      cx.beginPath();
      cx.moveTo(266, 328);
      cx.lineTo(262, 286);
      cx.lineTo(358, 286);
      cx.lineTo(354, 328);
      cx.stroke();
      break;
    }
    case "music_notes": {
      drawSingleNote(cx, 42, 168, 0.9, palette.core);
      drawBeamedNote(cx, 566, 94, 1, palette.core);
      drawSingleNote(cx, 582, 198, 0.78, palette.core);
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
      cx.strokeStyle = palette.core;
      cx.lineWidth = 4.2;
      cx.beginPath();
      cx.arc(310, 68, 24, 0, Math.PI * 2);
      cx.stroke();
      // Top button & hands
      cx.beginPath();
      cx.moveTo(303, 39);
      cx.lineTo(317, 39);
      cx.moveTo(310, 68);
      cx.lineTo(310, 54);
      cx.moveTo(310, 68);
      cx.lineTo(320, 74);
      cx.stroke();
      break;
    }
    case "confetti": {
      const amber = resolveToken("face-amber-core");
      const rose = resolveToken("face-rose-core");
      const sage = resolveToken("face-sage-core");
      fillFourPointStar(cx, 54, 128, 12, sage);
      fillFourPointStar(cx, 566, 98, 16, sage);
      fillFourPointStar(cx, 588, 168, 11, amber);
      fillDiamond(cx, 128, 66, 9, rose);
      fillDiamond(cx, 96, 268, 13, rose);
      cx.fillStyle = amber;
      fillCircle(cx, 392, 58, 6);
      fillCircle(cx, 546, 228, 7);
      cx.fillStyle = sage;
      fillCircle(cx, 286, 78, 5);
      break;
    }
    case "terminal_prompt": {
      cx.strokeStyle = palette.core;
      cx.lineWidth = 4.2;
      cx.beginPath();
      cx.moveTo(560, 44);
      cx.lineTo(574, 55);
      cx.lineTo(560, 66);
      cx.moveTo(580, 68);
      cx.lineTo(598, 68);
      cx.stroke();
      break;
    }
    case "magnifier": {
      const right = eyeCenters[1];
      const ringR = 92 * right.scale + 18;
      cx.strokeStyle = palette.core;
      cx.lineWidth = 5;
      cx.beginPath();
      cx.arc(right.x, right.y, ringR, 0, Math.PI * 2);
      cx.stroke();
      cx.lineWidth = 10;
      cx.beginPath();
      cx.moveTo(right.x + ringR * 0.72, right.y + ringR * 0.72);
      cx.lineTo(right.x + ringR * 1.08, right.y + ringR * 1.08);
      cx.stroke();
      break;
    }
    case "checkmark": {
      cx.strokeStyle = resolveToken("face-sage-edge");
      cx.lineWidth = 5.5;
      cx.beginPath();
      cx.moveTo(566, 54);
      cx.lineTo(577, 66);
      cx.lineTo(598, 42);
      cx.stroke();
      break;
    }
    case "warning_bang": {
      const amber = resolveToken("face-amber-edge");
      cx.strokeStyle = amber;
      cx.fillStyle = amber;
      cx.lineWidth = 6.5;
      cx.beginPath();
      cx.moveTo(584, 38);
      cx.lineTo(584, 68);
      cx.stroke();
      fillCircle(cx, 584, 84, 4.2);
      break;
    }
    case "memory_dots": {
      cx.fillStyle = palette.core;
      cx.globalAlpha = ambientOpacity * 0.65;
      fillCircle(cx, 556, 52, 5.5);
      cx.globalAlpha = ambientOpacity * 0.9;
      fillCircle(cx, 578, 64, 8.5);
      cx.globalAlpha = ambientOpacity * 0.75;
      fillCircle(cx, 588, 86, 6);
      break;
    }
    case "hourglass": {
      cx.strokeStyle = resolveToken("face-amber-edge");
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
      break;
    }
    case "offline_wave": {
      cx.strokeStyle = palette.stroke;
      cx.lineWidth = 3.8;
      cx.globalAlpha = ambientOpacity * 0.72;
      for (const r of [14, 26]) {
        cx.beginPath();
        cx.arc(578, 72, r, -Math.PI * 0.78, -Math.PI * 0.22);
        cx.stroke();
      }
      // Slash across wave
      cx.beginPath();
      cx.moveTo(562, 42);
      cx.lineTo(594, 74);
      cx.stroke();
      break;
    }
    case "lightning": {
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
      break;
    }
    case "wifi_arcs": {
      cx.strokeStyle = palette.core;
      cx.lineWidth = 4.6;
      for (const r of [22, 38, 54]) {
        cx.beginPath();
        cx.arc(544, 94, r, -Math.PI * 0.46, -Math.PI * 0.04);
        cx.stroke();
      }
      break;
    }
    case "sun_rays": {
      const amber = resolveToken("face-amber-core");
      cx.fillStyle = amber;
      cx.strokeStyle = amber;
      fillCircle(cx, 576, 56, 12);
      cx.lineWidth = 3.2;
      for (let i = 0; i < 8; i++) {
        const a = (i * Math.PI) / 4;
        cx.beginPath();
        cx.moveTo(576 + Math.cos(a) * 17, 56 + Math.sin(a) * 17);
        cx.lineTo(576 + Math.cos(a) * 23, 56 + Math.sin(a) * 23);
        cx.stroke();
      }
      break;
    }
    case "raindrops": {
      cx.strokeStyle = resolveToken("face-mist-core");
      cx.lineWidth = 5;
      cx.beginPath();
      cx.moveTo(574, 40);
      cx.lineTo(558, 68);
      cx.moveTo(596, 56);
      cx.lineTo(580, 84);
      cx.stroke();
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
): void {
  const steps = 54;
  const maxTheta = Math.PI * 5.4;
  const dir = mirror ? -1 : 1;
  cx.strokeStyle = color;
  cx.lineWidth = lineWidth;
  cx.lineCap = "round";
  cx.beginPath();
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const theta = t * maxTheta;
    const r = (0.08 + 0.92 * t) * maxRadius;
    const px = x + dir * Math.cos(theta) * r;
    const py = y + Math.sin(theta) * r;
    if (i === 0) cx.moveTo(px, py);
    else cx.lineTo(px, py);
  }
  cx.stroke();
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

/** The 620 x 340 OLED companion face driven by declarative 72-expression recipes. */
export function RobotFace(props: {
  state: FaceVisualState;
  shift: { dx: number; dy: number };
}) {
  const breath = createMotion();
  const activeBreath = computed(() => {
    const recipe =
      FACE_EXPRESSION_RECIPES[props.state.expression] ??
      FACE_EXPRESSION_RECIPES.neutral;
    return (
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
  return (
    <Canvas
      testID="looi-face"
      accessibilityLabel={t("looisRoundeyeExpression")}
      role="image"
      class="absolute inset-0"
      style={{ minHeight: 180, opacity: breath.opacity }}
      draw={(cx, size) =>
        drawRobotFace(cx, size, props.state, props.shift, token, safeArea())
      }
    />
  );
}
