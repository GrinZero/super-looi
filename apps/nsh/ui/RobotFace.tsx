import {
  Canvas,
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

/** The existing 620 × 340 face, drawn as one native canvas. Every eye radius
 * changes uniformly; blinking never squashes a circle into an ellipse. */
export function RobotFace(props: {
  state: FaceVisualState;
  shift: { dx: number; dy: number };
  bottomInset?: number;
}) {
  const breath = createMotion();
  effect(() => {
    if (
      lifecycle() === "active" &&
      !reduceMotion() &&
      props.state.expression !== "sleeping"
    )
      void breath.play({
        keyframes: { opacity: [0.82, 1] },
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
        const state = props.state,
          areaHeight = Math.max(1, size.height - (props.bottomInset ?? 72)),
          scale = Math.max(
            0.01,
            Math.min(1.08, (size.width - 24) / 620, (areaHeight - 12) / 340),
          );
        cx.clearRect(0, 0, size.width, size.height);
        cx.fillStyle = token("face-texture");
        for (let row = 0; row < 21; row++)
          for (let col = 0; col < 39; col++)
            cx.fillRect(
              ((col + 0.5) * size.width) / 39,
              ((row + 0.5) * size.height) / 21,
              1.2,
              1.2,
            );
        cx.save();
        cx.translate(
          size.width / 2 - 310 * scale + props.shift.dx,
          areaHeight / 2 - 170 * scale + props.shift.dy,
        );
        cx.scale(scale, scale);
        const color =
          state.expression === "alarmed" ? token("destructive") : token("eye");
        const closed =
          state.expression === "sleeping" || state.blinkProgress >= 0.92;
        for (let index = 0; index < 2; index++) {
          const thinking = state.expression === "thinking",
            curious = state.expression === "curious";
          const ratio = thinking
            ? index === 0
              ? 0.9
              : 0.94
            : curious
              ? index === 0
                ? 0.86
                : 1.08
              : state.expression === "listening"
                ? 1.06
                : 1;
          const x =
              (index === 0 ? 130 : 490) +
              state.gaze.x * 10 +
              (thinking ? -6 : 0),
            y = 158 - state.gaze.y * 9 + (thinking ? -8 : 0);
          if (closed) {
            cx.strokeStyle = color;
            cx.globalAlpha = 0.4;
            cx.lineWidth = 4;
            cx.lineCap = "round";
            cx.beginPath();
            cx.moveTo(x - 76, y);
            cx.lineTo(x + 76, y);
            cx.stroke();
            cx.globalAlpha = 1;
            continue;
          }
          const radius = 92 * ratio * (1 - state.blinkProgress * 0.08);
          const halo = cx.createRadialGradient(
            x,
            y,
            radius * 0.6,
            x,
            y,
            radius * 1.7,
          );
          halo.addColorStop(0, token("eye-halo"));
          halo.addColorStop(1, token("transparent"));
          cx.fillStyle = halo;
          circle(cx, x, y, radius * 1.7);
          const orb = cx.createRadialGradient(
            x,
            y - radius * 0.24,
            1,
            x,
            y,
            radius,
          );
          orb.addColorStop(
            0,
            state.expression === "alarmed" ? color : token("eye-highlight"),
          );
          orb.addColorStop(0.78, color);
          orb.addColorStop(
            1,
            state.expression === "alarmed" ? color : token("eye-rim"),
          );
          cx.fillStyle = orb;
          circle(cx, x, y, radius);
          const glint = cx.createRadialGradient(
            x - radius * 0.35,
            y - radius * 0.42,
            0,
            x - radius * 0.35,
            y - radius * 0.42,
            22,
          );
          glint.addColorStop(0, token("eye-glint"));
          glint.addColorStop(1, token("transparent"));
          cx.fillStyle = glint;
          circle(cx, x - radius * 0.35, y - radius * 0.42, 22);
          cx.strokeStyle = color;
          cx.lineWidth = 4;
          cx.lineCap = "round";
          cx.globalAlpha = 0.65;
          cx.beginPath();
          cx.arc(x, y - radius - 13, 48, Math.PI * 1.19, Math.PI * 1.81);
          cx.stroke();
          cx.globalAlpha = 1;
        }
        cx.strokeStyle = color;
        cx.fillStyle = color;
        cx.lineWidth = 5;
        cx.lineCap = "round";
        if (
          state.expression === "thinking" ||
          state.expression === "sleeping"
        ) {
          cx.beginPath();
          cx.moveTo(294, 267);
          cx.lineTo(326, 267);
          cx.stroke();
        } else if (state.expression === "alarmed") {
          cx.beginPath();
          cx.arc(310, 270, 10, 0, Math.PI * 2);
          cx.stroke();
        } else if (
          (state.expression === "listening" ||
            state.expression === "speaking") &&
          state.waveformBars.some((v) => v > 0.06)
        ) {
          state.waveformBars.forEach((value, index) => {
            const height = 4 + Math.max(0, Math.min(1, value)) * 32;
            cx.beginPath();
            cx.moveTo(286 + index * 12, 270 - height / 2);
            cx.lineTo(286 + index * 12, 270 + height / 2);
            cx.stroke();
          });
        } else {
          cx.beginPath();
          cx.arc(310, 218, 56, Math.PI * 0.3, Math.PI * 0.7);
          cx.stroke();
        }
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
