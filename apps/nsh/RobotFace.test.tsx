import { expect, open, test } from "nsh/test";
import {
  FACE_EXPRESSION_IDS as RUNTIME_FACE_EXPRESSION_IDS,
  getFaceExpressionBehavior,
} from "./generated/looi-runtime.js";
import { FACE_EXPRESSION_IDS, FACE_EXPRESSION_RECIPES } from "./ui/face-recipes";
import { drawRobotFace } from "./ui/RobotFace";
import type { CanvasRenderingContext2D } from "nsh";

function createAuditCanvas() {
  let saveDepth = 0;
  let clipCount = 0;
  let bezierCount = 0;
  let arcCount = 0;
  let ccwArcCount = 0;
  let quadCount = 0;
  let gradientCount = 0;
  const translates: Array<{ x: number; y: number }> = [];
  const arcs: Array<{ x: number; y: number; r: number; ccw: boolean }> = [];
  const quads: Array<{ cpx: number; cpy: number; x: number; y: number }> = [];
  const checkNums = (values: number[]) => {
    for (const v of values) {
      if (!Number.isFinite(v)) {
        throw new Error(`Non-finite canvas coordinate: ${String(v)}`);
      }
    }
  };

  const cx = {
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    lineCap: "butt",
    lineJoin: "miter",
    globalAlpha: 1,
    save() {
      saveDepth += 1;
    },
    restore() {
      saveDepth -= 1;
      if (saveDepth < 0) {
        throw new Error("Unbalanced Canvas restore()");
      }
    },
    clearRect(x: number, y: number, w: number, h: number) {
      checkNums([x, y, w, h]);
    },
    fillRect(x: number, y: number, w: number, h: number) {
      checkNums([x, y, w, h]);
    },
    translate(x: number, y: number) {
      checkNums([x, y]);
      translates.push({ x, y });
    },
    scale(x: number, y: number) {
      checkNums([x, y]);
    },
    rotate(angle: number) {
      checkNums([angle]);
    },
    beginPath() {},
    closePath() {},
    moveTo(x: number, y: number) {
      checkNums([x, y]);
    },
    lineTo(x: number, y: number) {
      checkNums([x, y]);
    },
    quadraticCurveTo(cpx: number, cpy: number, x: number, y: number) {
      checkNums([cpx, cpy, x, y]);
      quadCount += 1;
      quads.push({ cpx, cpy, x, y });
    },
    bezierCurveTo(
      cp1x: number,
      cp1y: number,
      cp2x: number,
      cp2y: number,
      x: number,
      y: number,
    ) {
      checkNums([cp1x, cp1y, cp2x, cp2y, x, y]);
      bezierCount += 1;
    },
    arc(
      x: number,
      y: number,
      r: number,
      start: number,
      end: number,
      counterclockwise = false,
    ) {
      checkNums([x, y, r, start, end]);
      if (r < 0) throw new Error(`Negative arc radius: ${r}`);
      arcCount += 1;
      if (counterclockwise) ccwArcCount += 1;
      arcs.push({ x, y, r, ccw: counterclockwise });
    },
    ellipse(
      x: number,
      y: number,
      rx: number,
      ry: number,
      rot: number,
      start: number,
      end: number,
    ) {
      checkNums([x, y, rx, ry, rot, start, end]);
      if (rx < 0 || ry < 0) throw new Error(`Negative ellipse radius: ${rx}, ${ry}`);
    },
    rect(x: number, y: number, w: number, h: number) {
      checkNums([x, y, w, h]);
    },
    fill() {},
    stroke() {},
    clip() {
      clipCount += 1;
    },
    createRadialGradient(
      x0: number,
      y0: number,
      r0: number,
      x1: number,
      y1: number,
      r1: number,
    ) {
      checkNums([x0, y0, r0, x1, y1, r1]);
      if (r0 < 0 || r1 < 0) {
        throw new Error(`Negative gradient radius: ${r0}, ${r1}`);
      }
      gradientCount += 1;
      return {
        addColorStop(offset: number, color: string) {
          checkNums([offset]);
          if (offset < 0 || offset > 1 || !color) {
            throw new Error(`Invalid gradient stop: ${offset} ${color}`);
          }
        },
      };
    },
  } as unknown as CanvasRenderingContext2D;

  return {
    cx,
    translates,
    arcs,
    quads,
    stats: () => ({
      saveDepth,
      clipCount,
      bezierCount,
      arcCount,
      ccwArcCount,
      quadCount,
      gradientCount,
    }),
  };
}

test("all 72 declarative expressions preserve balanced Canvas state and token-only paints", () => {
  expect(FACE_EXPRESSION_IDS.length).toBe(72);
  expect(FACE_EXPRESSION_IDS).toEqual(RUNTIME_FACE_EXPRESSION_IDS);
  expect(Object.keys(FACE_EXPRESSION_RECIPES).length).toBe(72);

  for (const expression of FACE_EXPRESSION_IDS) {
    const recipe = FACE_EXPRESSION_RECIPES[expression];
    const bothOrbEyes = recipe.eyes.every((eye) => (eye.shape ?? "orb") === "orb");
    expect(getFaceExpressionBehavior(expression).allowsBlink).toBe(bothOrbEyes);
  }

  const requestedTokens = new Set<string>();
  const resolver = (name: string) => {
    requestedTokens.add(name);
    return `token:${name}`;
  };

  for (const expression of FACE_EXPRESSION_IDS) {
    for (const blinkProgress of [0, 0.5, 1]) {
      const audit = createAuditCanvas();
      drawRobotFace(
        audit.cx,
        { width: 844, height: 390 },
        { expression, gaze: { x: 0.3, y: -0.2 }, blinkProgress },
        { dx: 2, dy: -2 },
        resolver,
      );
      expect(audit.stats().saveDepth).toBe(0);
      expect(audit.stats().arcCount > 0).toBe(true);
    }
  }

  // Eyelid clipping and specialized eye shapes exercise their primitives cleanly
  const angryAudit = createAuditCanvas();
  drawRobotFace(
    angryAudit.cx,
    { width: 844, height: 390 },
    { expression: "angry_glare", gaze: { x: 0, y: 0 }, blinkProgress: 0 },
    { dx: 0, dy: 0 },
    resolver,
  );
  expect(angryAudit.stats().clipCount).toBe(2);

  const loveAudit = createAuditCanvas();
  drawRobotFace(
    loveAudit.cx,
    { width: 844, height: 390 },
    { expression: "love_eyes", gaze: { x: 0, y: 0 }, blinkProgress: 0 },
    { dx: 0, dy: 0 },
    resolver,
  );
  expect(loveAudit.stats().bezierCount >= 4).toBe(true);

  expect(requestedTokens.has("eye-core")).toBe(true);
  expect(requestedTokens.has("face-ivory-core")).toBe(true);
  expect(requestedTokens.has("face-amber-core")).toBe(true);
  expect(requestedTokens.has("face-sage-core")).toBe(true);
  expect(requestedTokens.has("face-rose-core")).toBe(true);
  expect(requestedTokens.has("face-mist-core")).toBe(true);

  // Asymmetric landscape safeArea insets center horizon & face inside cutout-safe area
  const noInsetAudit = createAuditCanvas();
  drawRobotFace(
    noInsetAudit.cx,
    { width: 844, height: 390 },
    { expression: "neutral", gaze: { x: 0, y: 0 }, blinkProgress: 0 },
    { dx: 0, dy: 0 },
    resolver,
  );
  const cutoutInsetAudit = createAuditCanvas();
  drawRobotFace(
    cutoutInsetAudit.cx,
    { width: 844, height: 390 },
    { expression: "neutral", gaze: { x: 0, y: 0 }, blinkProgress: 0 },
    { dx: 0, dy: 0 },
    resolver,
    { top: 0, right: 0, bottom: 21, left: 84 },
  );
  // Horizon glow translates to safe-area horizontal center (84 + (844 - 84)/2 = 464) and safe bottom (369)
  expect(cutoutInsetAudit.translates[0]).toEqual({ x: 464, y: 369 });
  expect(cutoutInsetAudit.translates[1].x > noInsetAudit.translates[1].x).toBe(true);

  // cat_w draws two counterclockwise open omega arcs instead of a closed chord
  const kittyAudit = createAuditCanvas();
  drawRobotFace(
    kittyAudit.cx,
    { width: 844, height: 390 },
    { expression: "kitty_playful", gaze: { x: 0, y: 0 }, blinkProgress: 0 },
    { dx: 0, dy: 0 },
    resolver,
  );
  expect(kittyAudit.stats().ccwArcCount).toBe(2);

  // glasses bridge joins inner rims via quadraticCurveTo and tracks gazeX
  const glassesCenter = createAuditCanvas();
  drawRobotFace(
    glassesCenter.cx,
    { width: 844, height: 390 },
    { expression: "focus_glasses", gaze: { x: 0, y: 0 }, blinkProgress: 0 },
    { dx: 0, dy: 0 },
    resolver,
  );
  const glassesRight = createAuditCanvas();
  drawRobotFace(
    glassesRight.cx,
    { width: 844, height: 390 },
    { expression: "focus_glasses", gaze: { x: 0.8, y: 0 }, blinkProgress: 0 },
    { dx: 0, dy: 0 },
    resolver,
  );
  expect(glassesCenter.stats().quadCount).toBe(1);
  expect(glassesRight.quads[0].cpx > glassesCenter.quads[0].cpx).toBe(true);

  // grumpy_puff places cheek crease outside right mouth corner (x - r >= 10)
  const grumpyAudit = createAuditCanvas();
  drawRobotFace(
    grumpyAudit.cx,
    { width: 844, height: 390 },
    { expression: "grumpy_puff", gaze: { x: 0, y: 0 }, blinkProgress: 0 },
    { dx: 0, dy: 0 },
    resolver,
  );
  const puffCrease = grumpyAudit.arcs[grumpyAudit.arcs.length - 1];
  expect(puffCrease.x - puffCrease.r >= 10).toBe(true);
});

test("native NSH Canvas mounts and replays all 72 expressions across frames", async () => {
  const app = await open("./FaceProbe.tsx");
  expect(app.texts()).toContain("Expression 1/72: neutral");

  for (let step = 1; step < FACE_EXPRESSION_IDS.length; step++) {
    await app.press("face-next");
  }
  expect(app.texts()).toContain("Expression 72/72: weather_rain_chill");

  await app.press("face-blink");
  await app.press("face-next");
  expect(app.texts()).toContain("Expression 1/72: neutral");
});
