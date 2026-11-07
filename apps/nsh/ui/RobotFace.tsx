import {
  Canvas,
  computed,
  createMotion,
  effect,
  lifecycle,
  reduceMotion,
  token,
  type CanvasRenderingContext2D,
} from "nsh";

export interface FaceVisualState {
  expression:
    | "neutral"
    | "listening"
    | "thinking"
    | "speaking"
    | "curious"
    | "sleeping"
    | "alarmed";
  gaze: { x: number; y: number };
  blinkProgress: number;
  waveformBars: number[];
}

interface EyePosture {
  scale: number;
  dx: number;
  dy: number;
  browAngle?: number;
  browLift?: number;
}

/** Pure-circle kinematics: expressions vary circle radius, posture, and outer brow arcs without elliptical squash. */
function getEyePosture(
  expression: FaceVisualState["expression"],
  index: number,
): EyePosture {
  switch (expression) {
    case "listening":
      return {
        scale: 1.06,
        dx: 0,
        dy: -4,
        browAngle: index === 0 ? -4 : 4,
        browLift: -4,
      };
    case "speaking":
      return { scale: 1.03, dx: 0, dy: -2 };
    case "curious":
      return index === 0
        ? { scale: 0.86, dx: 4, dy: 4, browAngle: -4, browLift: 2 }
        : { scale: 1.08, dx: -2, dy: -6, browAngle: 8, browLift: -8 };
    case "thinking":
      return index === 0
        ? { scale: 0.9, dx: -6, dy: -7, browAngle: -10, browLift: -3 }
        : { scale: 0.94, dx: -6, dy: -10, browAngle: 4, browLift: -7 };
    case "alarmed":
      return {
        scale: 0.95,
        dx: 0,
        dy: -3,
        browAngle: index === 0 ? 15 : -15,
        browLift: -5,
      };
    case "sleeping":
    case "neutral":
    default:
      return { scale: 1, dx: 0, dy: 0 };
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Number.isFinite(value)
    ? Math.max(minimum, Math.min(maximum, value))
    : 0;
}

function resonanceLevels(bars: number[]): number[] {
  if (bars.length === 0) return [0, 0, 0, 0, 0, 0, 0];
  return Array.from({ length: 7 }, (_, index) => {
    const position = (index / 6) * (bars.length - 1);
    const lower = Math.floor(position);
    const weight = position - lower;
    const first = clamp(bars[lower] ?? 0, 0, 1);
    const next = clamp(bars[Math.min(lower + 1, bars.length - 1)] ?? 0, 0, 1);
    return first + (next - first) * weight;
  });
}

/** The 620 × 340 pure-circle face rendered 1:1 with RobotFaceView optical layers. */
export function RobotFace(props: {
  state: FaceVisualState;
  shift: { dx: number; dy: number };
}) {
  const breath = createMotion();
  const activeBreath = computed(
    () =>
      lifecycle() === "active" &&
      !reduceMotion() &&
      props.state.expression !== "sleeping" &&
      props.state.expression !== "alarmed",
  );
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
      accessibilityLabel="LOOI 的圆眼表情"
      role="image"
      class="absolute inset-0"
      style={{ minHeight: 180, opacity: breath.opacity }}
      draw={(cx, size) => {
        const state = props.state;
        const sleeping = state.expression === "sleeping";
        const alarmed = state.expression === "alarmed";
        const blink = clamp(state.blinkProgress, 0, 1);
        const closed = sleeping || blink >= 0.98;
        const gazeX = clamp(state.gaze.x, -1, 1);
        const gazeY = -clamp(state.gaze.y, -1, 1);
        const shiftX = clamp(props.shift.dx, -6, 6);
        const shiftY = clamp(props.shift.dy, -6, 6);
        const scale = Math.max(
          0.01,
          Math.min(1.08, (size.width - 32) / 620, (size.height - 80) / 340),
        );

        cx.clearRect(0, 0, size.width, size.height);

        // 1. Subtle 39 × 21 dot matrix texture across the full viewport
        cx.fillStyle = token("face-texture");
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

        // 2. Bottom horizon glow (radial-gradient ellipse at 50% 100%)
        const horizonRadiusX = Math.min(220, size.width * 0.39);
        if (horizonRadiusX > 10) {
          cx.save();
          cx.translate(size.width / 2, size.height);
          cx.scale(1, 28 / horizonRadiusX);
          const horizon = cx.createRadialGradient(
            0,
            0,
            0,
            0,
            0,
            horizonRadiusX,
          );
          horizon.addColorStop(0, token("horizon-core"));
          horizon.addColorStop(0.48, token("horizon-mid"));
          horizon.addColorStop(1, token("horizon-zero"));
          cx.fillStyle = horizon;
          circle(cx, 0, 0, horizonRadiusX);
          cx.restore();
        }

        // 3. 620 × 340 centered face coordinate space
        cx.save();
        cx.translate(
          size.width / 2 - 310 * scale + shiftX,
          size.height / 2 - 170 * scale + shiftY,
        );
        cx.scale(scale, scale);

        const strokeColor = alarmed ? token("destructive") : token("face-stroke");

        // 4. Pure-circle eyes with soft OLED glow and conditional eyebrows
        for (let index = 0; index < 2; index++) {
          const posture = getEyePosture(state.expression, index);
          const baseX = (index === 0 ? 130 : 490) + gazeX * 10 + posture.dx;
          const baseY = 158 + gazeY * 9 + posture.dy;

          if (closed) {
            cx.save();
            cx.strokeStyle = strokeColor;
            cx.globalAlpha = 0.4;
            cx.lineWidth = 4;
            cx.lineCap = "round";
            cx.beginPath();
            cx.moveTo(baseX - 78, baseY);
            cx.lineTo(baseX + 78, baseY);
            cx.stroke();
            cx.restore();
            continue;
          }

          const blinkScale = 1 - blink * 0.08;
          const blinkOpacity = 1 - blink * 0.32;
          const ratio = posture.scale * blinkScale;
          const radius = 92 * ratio;

          cx.save();
          cx.globalAlpha = blinkOpacity;

          // 4a. Eye perimeter soft halo bloom (concentric radial gradient)
          const halo = cx.createRadialGradient(
            baseX,
            baseY,
            radius * 0.85,
            baseX,
            baseY,
            radius * 1.62,
          );
          halo.addColorStop(
            0,
            alarmed ? token("alarmed-halo") : token("eye-halo"),
          );
          halo.addColorStop(
            0.42,
            alarmed ? token("alarmed-zero") : token("halo-mid"),
          );
          halo.addColorStop(
            0.76,
            alarmed ? token("alarmed-zero") : token("halo-low"),
          );
          halo.addColorStop(
            1,
            alarmed ? token("alarmed-zero") : token("halo-zero"),
          );
          cx.fillStyle = halo;
          circle(cx, baseX, baseY, radius * 1.62);

          // 4b. Pure flat / soft-focus OLED emissive round eye
          const orb = cx.createRadialGradient(
            baseX,
            baseY,
            0,
            baseX,
            baseY,
            radius,
          );
          if (alarmed) {
            orb.addColorStop(0, token("alarmed-highlight"));
            orb.addColorStop(0.78, token("destructive"));
            orb.addColorStop(1, token("alarmed-rim"));
          } else {
            orb.addColorStop(0, token("eye-core"));
            orb.addColorStop(0.84, token("eye-core"));
            orb.addColorStop(1, token("eye-edge"));
          }
          cx.fillStyle = orb;
          circle(cx, baseX, baseY, radius);

          // 4c. Conditional outer eyebrow arc (never drawn in neutral or speaking)
          if (posture.browAngle !== undefined) {
            cx.save();
            cx.translate(baseX, baseY + (posture.browLift ?? 0) * ratio);
            cx.rotate((posture.browAngle * Math.PI) / 180);
            cx.strokeStyle = strokeColor;
            cx.lineWidth = 4 * ratio;
            cx.lineCap = "round";
            cx.globalAlpha = blinkOpacity * 0.68;
            cx.beginPath();
            cx.arc(
              0,
              -radius + 26 * ratio,
              48 * ratio,
              Math.PI * 1.2,
              Math.PI * 1.8,
            );
            cx.stroke();
            cx.restore();
          }

          cx.restore();
        }

        // 5. Mouth / Waveform / Expression Mouth at (310 + gazeX * 4, 263 + gazeY * 3)
        const mouthX = 310 + gazeX * 4;
        const mouthY = 263 + gazeY * 3;
        const levels = resonanceLevels(state.waveformBars);
        const showWaveform =
          (state.expression === "listening" ||
            state.expression === "speaking") &&
          levels.some((level) => level > 0.06);

        cx.save();
        cx.strokeStyle = strokeColor;
        cx.fillStyle = strokeColor;
        cx.lineCap = "round";

        if (showWaveform) {
          cx.lineWidth = 3;
          levels.forEach((level, index) => {
            const barHeight = 4 + level * 32;
            const barX = mouthX - 27 + index * 9;
            cx.beginPath();
            cx.moveTo(barX, mouthY - barHeight / 2);
            cx.lineTo(barX, mouthY + barHeight / 2);
            cx.stroke();
          });
        } else if (state.expression === "thinking" || sleeping) {
          cx.globalAlpha = sleeping ? 0.28 : 0.9;
          cx.lineWidth = 4;
          cx.beginPath();
          cx.moveTo(mouthX - 17, mouthY);
          cx.lineTo(mouthX + 17, mouthY);
          cx.stroke();
        } else if (alarmed) {
          cx.lineWidth = 4;
          cx.beginPath();
          cx.arc(mouthX, mouthY, 10, 0, Math.PI * 2);
          cx.stroke();
        } else {
          const offsetX = state.expression === "curious" ? 3 : 0;
          const offsetY = state.expression === "curious" ? -1 : 0;
          cx.lineWidth = 5;
          cx.beginPath();
          cx.arc(
            mouthX + offsetX,
            mouthY - 46 + offsetY,
            53.5,
            Math.PI * 0.31,
            Math.PI * 0.69,
          );
          cx.stroke();
        }
        cx.restore();
        cx.restore();
      }}
    />
  );
}

function circle(cx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  cx.beginPath();
  cx.arc(x, y, r, 0, Math.PI * 2);
  cx.fill();
}
