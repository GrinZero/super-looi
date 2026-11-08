import { expect, open, test } from "nsh/test";
import {
  FACE_EXPRESSION_IDS as RUNTIME_FACE_EXPRESSION_IDS,
  getFaceExpressionBehavior,
} from "./generated/looi-runtime.js";
import { FACE_EXPRESSION_IDS, FACE_EXPRESSION_RECIPES } from "./ui/face-recipes";
import {
  drawRobotFace,
  drawRobotFaceTransition,
  hasAmbientMotion,
  normalizeBlinkProgress,
} from "./ui/RobotFace";
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
  const rotates: number[] = [];
  const moveTos: Array<{ x: number; y: number }> = [];
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
      rotates.push(angle);
    },
    beginPath() {},
    closePath() {},
    moveTo(x: number, y: number) {
      checkNums([x, y]);
      moveTos.push({ x, y });
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
    rotates,
    moveTos,
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

  // Transition interpolation across continuous orb->orb and discrete shape/tint/glyph morphs
  const cssResolver = (name: string) =>
    name.endsWith("-zero") ? "rgba(232,218,195,0)" : "#E8DAC3";
  const pairs: Array<[typeof FACE_EXPRESSION_IDS[number], typeof FACE_EXPRESSION_IDS[number]]> = [
    ["neutral", "angry_glare"],
    ["angry_glare", "sad_droop"],
    ["neutral", "love_eyes"],
    ["love_eyes", "happy_squint"],
    ["wake_spark", "coffee_sip"],
    ["neutral", "sleeping"],
    ["alarmed", "task_verified"],
  ];
  for (const [fromExpr, toExpr] of pairs) {
    for (const p of [0, 0.2, 0.42, 0.65, 0.88, 1]) {
      const transAudit = createAuditCanvas();
      drawRobotFaceTransition(
        transAudit.cx,
        { width: 844, height: 390 },
        { expression: fromExpr, gaze: { x: -0.4, y: 0.2 }, blinkProgress: 0 },
        { expression: toExpr, gaze: { x: 0.5, y: -0.3 }, blinkProgress: 0 },
        p,
        { dx: 0, dy: 0 },
        cssResolver,
      );
      expect(transAudit.stats().saveDepth).toBe(0);
      expect(transAudit.stats().arcCount > 0).toBe(true);
    }
  }

  // Ambient motion discipline: calm idle states stop the JS ticker; special expressions animate
  for (const calm of [
    "neutral",
    "listening",
    "thinking",
    "speaking",
    "sleeping",
    "privacy_shield",
    "night_watch",
    "shy_blush",
    "focus_glasses",
  ] as const) {
    expect(hasAmbientMotion(calm)).toBe(false);
  }
  for (const lively of [
    "dizzy_spiral",
    "deep_snore",
    "coffee_sip",
    "munching",
    "sipping_straw",
    "music_vibe",
    "reading_scan",
    "pomodoro_timer",
    "celebrate_party",
    "coding_terminal",
    "searching_radar",
    "memory_recall",
    "sync_pulse",
    "dock_snap",
    "charging_pulse",
    "home_command",
    "weather_sunny",
    "weather_rain_chill",
    "love_eyes",
    "starry_eyed",
    "laughing",
    "yawning",
  ] as const) {
    expect(hasAmbientMotion(lively)).toBe(true);
  }

  // Every expression preserves balanced save/restore and finite geometry across live timeSec ticks
  for (const expression of FACE_EXPRESSION_IDS) {
    for (const timeSec of [0.37, 1.15, 2.43]) {
      const liveAudit = createAuditCanvas();
      drawRobotFace(
        liveAudit.cx,
        { width: 844, height: 390 },
        { expression, gaze: { x: 0.2, y: -0.15 }, blinkProgress: 0 },
        { dx: 0, dy: 0 },
        cssResolver,
        undefined,
        timeSec,
      );
      expect(liveAudit.stats().saveDepth).toBe(0);
    }
  }

  // dizzy_spiral counter-rotates left & right spiral eyes when timeSec > 0
  const spiralLive = createAuditCanvas();
  drawRobotFace(
    spiralLive.cx,
    { width: 844, height: 390 },
    { expression: "dizzy_spiral", gaze: { x: 0, y: 0 }, blinkProgress: 0 },
    { dx: 0, dy: 0 },
    cssResolver,
    undefined,
    0.5,
  );
  expect(spiralLive.rotates.length).toBe(2);
  expect(Math.abs(spiralLive.rotates[0] + spiralLive.rotates[1]) < 1e-9).toBe(true);
  expect(Math.abs(spiralLive.rotates[0]) > 1).toBe(true);

  // deep_snore ZZZ glyphs continuously drift upward across timeSec frames
  const snoreEarly = createAuditCanvas();
  drawRobotFace(
    snoreEarly.cx,
    { width: 844, height: 390 },
    { expression: "deep_snore", gaze: { x: 0, y: 0 }, blinkProgress: 0 },
    { dx: 0, dy: 0 },
    cssResolver,
    undefined,
    0.1,
  );
  const snoreLater = createAuditCanvas();
  drawRobotFace(
    snoreLater.cx,
    { width: 844, height: 390 },
    { expression: "deep_snore", gaze: { x: 0, y: 0 }, blinkProgress: 0 },
    { dx: 0, dy: 0 },
    cssResolver,
    undefined,
    0.6,
  );
  expect(snoreLater.moveTos[0].y < snoreEarly.moveTos[0].y).toBe(true);

  // Browed orb expressions keep drawing both eyebrows during full blink (u = 0.5 and u = 1.0)
  const thinkingBlinkMid = createAuditCanvas();
  drawRobotFaceTransition(
    thinkingBlinkMid.cx,
    { width: 844, height: 390 },
    { expression: "thinking", gaze: { x: 0, y: 0 }, blinkProgress: 1 },
    { expression: "thinking", gaze: { x: 0, y: 0 }, blinkProgress: 1 },
    0.5,
    { dx: 0, dy: 0 },
    cssResolver,
  );
  const thinkingBlinkEnd = createAuditCanvas();
  drawRobotFaceTransition(
    thinkingBlinkEnd.cx,
    { width: 844, height: 390 },
    { expression: "thinking", gaze: { x: 0, y: 0 }, blinkProgress: 1 },
    { expression: "thinking", gaze: { x: 0, y: 0 }, blinkProgress: 1 },
    1,
    { dx: 0, dy: 0 },
    cssResolver,
  );
  // 1 horizon circle + 2 eyebrow arcs when eyes are closed lines (mouth is flat)
  expect(thinkingBlinkMid.stats().arcCount).toBe(3);
  expect(thinkingBlinkEnd.stats().arcCount).toBe(3);
  expect(thinkingBlinkEnd.rotates.length).toBe(2);

  // Non-orb expressions clamp blinkProgress=1 to 0 so wake interruptions never squash orb eyes
  expect(
    normalizeBlinkProgress({
      expression: "sleeping",
      gaze: { x: 0, y: 0 },
      blinkProgress: 1,
    }),
  ).toBe(0);
  expect(
    normalizeBlinkProgress({
      expression: "neutral",
      gaze: { x: 0, y: 0 },
      blinkProgress: 0.65,
    }),
  ).toBe(0.65);

  // Zero-to-live continuity: t = 0 -> t = 0.001 has no jump in primitive counts or coordinates
  for (const expression of FACE_EXPRESSION_IDS) {
    const t0 = createAuditCanvas();
    drawRobotFace(
      t0.cx,
      { width: 844, height: 390 },
      { expression, gaze: { x: 0, y: 0 }, blinkProgress: 0 },
      { dx: 0, dy: 0 },
      cssResolver,
      undefined,
      0,
    );
    const tEps = createAuditCanvas();
    drawRobotFace(
      tEps.cx,
      { width: 844, height: 390 },
      { expression, gaze: { x: 0, y: 0 }, blinkProgress: 0 },
      { dx: 0, dy: 0 },
      cssResolver,
      undefined,
      0.001,
    );
    expect(tEps.moveTos.length).toBe(t0.moveTos.length);
    for (let i = 0; i < t0.moveTos.length; i++) {
      expect(Math.abs(tEps.moveTos[i].x - t0.moveTos[i].x) < 0.5).toBe(true);
      expect(Math.abs(tEps.moveTos[i].y - t0.moveTos[i].y) < 0.5).toBe(true);
    }
  }
});

test("native NSH Canvas mounts and replays all 72 expressions, transitions, and ambient loops", async () => {
  const app = await open("./FaceProbe.tsx", {
    width: 844,
    height: 390,
    clock: {},
  });
  expect(app.texts()).toContain("Expression 1/72: neutral");

  for (let step = 1; step < FACE_EXPRESSION_IDS.length; step++) {
    await app.press("face-next");
    if (step === 32 || step === 38) {
      // Exercise mid-transition interpolation (130ms) + steady-state ambient motion (420ms)
      // on #33 dizzy_spiral and #39 deep_snore inside native NSH Canvas
      await app.wait(130);
      await app.wait(420);
    }
  }
  expect(app.texts()).toContain("Expression 72/72: weather_rain_chill");
  await app.wait(400);

  await app.press("face-blink");
  await app.wait(120);
  await app.press("face-next");
  await app.wait(300);
  expect(app.texts()).toContain("Expression 1/72: neutral");

  // Mid-flight interruption across closedRest (#06 sleeping -> #01 neutral -> #02 listening)
  await app.press("face-pick-sleeping");
  await app.wait(300);
  await app.press("face-pick-neutral");
  await app.wait(120);
  await app.press("face-pick-listening");
  await app.wait(300);
  expect(app.texts()).toContain("Expression 2/72: listening");
});
