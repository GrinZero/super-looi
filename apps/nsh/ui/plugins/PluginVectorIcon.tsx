import { Canvas, token } from "nsh";

export type PluginIconName =
  | "code"
  | "eye"
  | "gamepad"
  | "sparkles"
  | "home"
  | "wrench"
  | "search"
  | "user"
  | "terminal"
  | "cloud"
  | "refresh"
  | "alert"
  | "link"
  | "chevron_left"
  | "chevron_right"
  | "chevron_down";

export type PluginIconTone = "foreground" | "primaryFg" | "muted" | "warning" | "destructive";

function resolvePluginIconColor(tone: PluginIconTone): string {
  switch (tone) {
    case "primaryFg":
      return token("primary-foreground");
    case "muted":
      return token("muted-foreground");
    case "warning":
      return token("warning");
    case "destructive":
      return token("destructive");
    case "foreground":
    default:
      return token("foreground");
  }
}

export function normalizePluginIconName(raw: string | undefined): PluginIconName {
  switch (raw) {
    case "code":
    case "eye":
    case "gamepad":
    case "sparkles":
    case "home":
    case "wrench":
    case "search":
    case "user":
    case "terminal":
    case "cloud":
    case "refresh":
    case "alert":
    case "link":
    case "chevron_left":
    case "chevron_right":
    case "chevron_down":
      return raw;
    default:
      return "wrench";
  }
}

export function PluginVectorIcon(props: {
  name: PluginIconName;
  tone?: PluginIconTone;
  size?: number;
}) {
  const iconSize = () => props.size ?? 18;
  return (
    <Canvas
      style={{
        width: iconSize(),
        height: iconSize(),
        pointerEvents: "none",
      }}
      draw={(cx, canvasSize) => {
        const w = canvasSize.width || iconSize();
        const h = canvasSize.height || iconSize();
        const color = resolvePluginIconColor(props.tone ?? "foreground");

        cx.clearRect(0, 0, w, h);
        cx.save();
        cx.scale(w / 24, h / 24);
        cx.strokeStyle = color;
        cx.fillStyle = color;
        cx.lineWidth = 2;
        cx.lineCap = "round";
        cx.lineJoin = "round";

        switch (props.name) {
          case "code": {
            cx.beginPath();
            cx.moveTo(8.5, 8.2);
            cx.lineTo(4.5, 12);
            cx.lineTo(8.5, 15.8);
            cx.moveTo(15.5, 8.2);
            cx.lineTo(19.5, 12);
            cx.lineTo(15.5, 15.8);
            cx.moveTo(13.4, 7.2);
            cx.lineTo(10.6, 16.8);
            cx.stroke();
            break;
          }
          case "eye": {
            cx.beginPath();
            cx.moveTo(2.5, 12);
            cx.quadraticCurveTo(12, 4.5, 21.5, 12);
            cx.quadraticCurveTo(12, 19.5, 2.5, 12);
            cx.stroke();
            cx.beginPath();
            cx.arc(12, 12, 2.8, 0, Math.PI * 2);
            cx.stroke();
            break;
          }
          case "gamepad": {
            cx.beginPath();
            cx.roundRect(3.5, 6.5, 17, 11, 4.5);
            cx.stroke();
            cx.beginPath();
            cx.moveTo(8.5, 10);
            cx.lineTo(8.5, 14);
            cx.moveTo(6.5, 12);
            cx.lineTo(10.5, 12);
            cx.stroke();
            cx.beginPath();
            cx.arc(15.2, 10.8, 1, 0, Math.PI * 2);
            cx.arc(17.2, 13.2, 1, 0, Math.PI * 2);
            cx.fill();
            break;
          }
          case "sparkles": {
            cx.beginPath();
            cx.moveTo(12, 4);
            cx.lineTo(13.8, 9.8);
            cx.lineTo(19.5, 11.5);
            cx.lineTo(13.8, 13.2);
            cx.lineTo(12, 19);
            cx.lineTo(10.2, 13.2);
            cx.lineTo(4.5, 11.5);
            cx.lineTo(10.2, 9.8);
            cx.closePath();
            cx.stroke();
            break;
          }
          case "home": {
            cx.beginPath();
            cx.moveTo(4, 10.5);
            cx.lineTo(12, 4);
            cx.lineTo(20, 10.5);
            cx.lineTo(20, 19.5);
            cx.lineTo(4, 19.5);
            cx.closePath();
            cx.stroke();
            break;
          }
          case "wrench": {
            cx.beginPath();
            cx.arc(15.5, 8.5, 4.2, Math.PI * 0.2, Math.PI * 1.3);
            cx.lineTo(5.2, 18.8);
            cx.stroke();
            break;
          }
          case "search": {
            cx.beginPath();
            cx.arc(10.8, 10.8, 5.8, 0, Math.PI * 2);
            cx.stroke();
            cx.beginPath();
            cx.moveTo(15.2, 15.2);
            cx.lineTo(19.5, 19.5);
            cx.stroke();
            break;
          }
          case "user": {
            cx.beginPath();
            cx.arc(12, 8.2, 3.4, 0, Math.PI * 2);
            cx.stroke();
            cx.beginPath();
            cx.arc(12, 20.2, 6.2, Math.PI * 1.15, Math.PI * 1.85);
            cx.stroke();
            break;
          }
          case "terminal": {
            cx.beginPath();
            cx.moveTo(5.5, 8);
            cx.lineTo(10.2, 12);
            cx.lineTo(5.5, 16);
            cx.moveTo(12.2, 16);
            cx.lineTo(18.5, 16);
            cx.stroke();
            break;
          }
          case "cloud": {
            cx.beginPath();
            cx.moveTo(6.8, 18);
            cx.lineTo(17.2, 18);
            cx.arc(17.2, 14.3, 3.7, Math.PI * 0.5, Math.PI * 1.5, true);
            cx.arc(12.4, 10.8, 4.8, Math.PI * 1.88, Math.PI * 1.08, true);
            cx.arc(6.8, 14.6, 3.4, Math.PI * 1.5, Math.PI * 0.5, true);
            cx.closePath();
            cx.stroke();
            break;
          }
          case "refresh": {
            cx.beginPath();
            cx.arc(12, 12, 6.8, -Math.PI * 0.78, Math.PI * 0.65);
            cx.stroke();
            cx.beginPath();
            cx.moveTo(15.8, 4.2);
            cx.lineTo(18.6, 7.2);
            cx.lineTo(14.8, 8.2);
            cx.stroke();
            break;
          }
          case "alert": {
            cx.beginPath();
            cx.moveTo(12, 4.5);
            cx.lineTo(20.2, 19);
            cx.lineTo(3.8, 19);
            cx.closePath();
            cx.stroke();
            cx.beginPath();
            cx.moveTo(12, 10);
            cx.lineTo(12, 14);
            cx.stroke();
            cx.beginPath();
            cx.arc(12, 16.8, 1, 0, Math.PI * 2);
            cx.fill();
            break;
          }
          case "link": {
            cx.beginPath();
            cx.arc(9.5, 12, 3.8, Math.PI * 0.5, Math.PI * 1.5);
            cx.stroke();
            cx.beginPath();
            cx.arc(14.5, 12, 3.8, -Math.PI * 0.5, Math.PI * 0.5);
            cx.stroke();
            cx.beginPath();
            cx.moveTo(9, 12);
            cx.lineTo(15, 12);
            cx.stroke();
            break;
          }
          case "chevron_left": {
            cx.beginPath();
            cx.moveTo(14.5, 6);
            cx.lineTo(8.5, 12);
            cx.lineTo(14.5, 18);
            cx.stroke();
            break;
          }
          case "chevron_right": {
            cx.beginPath();
            cx.moveTo(9.5, 6);
            cx.lineTo(15.5, 12);
            cx.lineTo(9.5, 18);
            cx.stroke();
            break;
          }
          case "chevron_down": {
            cx.beginPath();
            cx.moveTo(6, 9.5);
            cx.lineTo(12, 15.5);
            cx.lineTo(18, 9.5);
            cx.stroke();
            break;
          }
        }
        cx.restore();
      }}
    />
  );
}
