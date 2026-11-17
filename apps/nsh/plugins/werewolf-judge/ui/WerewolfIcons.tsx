import { Canvas, token } from "nsh";
import type { WerewolfRole } from "../contracts";

export type WerewolfIconTone =
  | "foreground"
  | "muted"
  | "stageFg"
  | "stageMuted"
  | "stageBg"
  | "amber"
  | "sage"
  | "rose"
  | "mist"
  | "roseInk"
  | "verified";

export type WerewolfStageIconName =
  | "privacy_shield"
  | "hold_hand"
  | "potion_bottle"
  | "waveform"
  | "check_circle"
  | "clock"
  | "wifi"
  | "replay"
  | "speaker_on"
  | "speaker_off"
  | "more_dots"
  | "arrow_left"
  | "arrow_right"
  | "chevron_left"
  | "chevron_right"
  | "avatar_silhouette";

function resolveIconColor(tone: WerewolfIconTone | undefined): string {
  switch (tone) {
    case "muted":
      return token("muted-foreground");
    case "stageFg":
      return token("stage-fg");
    case "stageMuted":
      return token("stage-pill-muted");
    case "stageBg":
      return token("stage-bg");
    case "amber":
      return token("face-amber-core");
    case "sage":
      return token("face-sage-core");
    case "rose":
      return token("face-rose-core");
    case "mist":
      return token("face-mist-core");
    case "roseInk":
      return token("stage-rose-ink");
    case "verified":
      return token("verified");
    case "foreground":
    default:
      return token("foreground");
  }
}

export function WerewolfRoleIcon(props: {
  role: WerewolfRole;
  tone?: WerewolfIconTone;
  size?: number;
  strokeWidth?: number;
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
        const color = resolveIconColor(props.tone);
        const role = props.role;
        const sw = props.strokeWidth ?? 1.85;

        cx.clearRect(0, 0, w, h);
        cx.save();
        cx.scale(w / 24, h / 24);
        cx.strokeStyle = color;
        cx.fillStyle = color;
        cx.lineWidth = sw;
        cx.lineCap = "round";
        cx.lineJoin = "round";

        switch (role) {
          case "werewolf":
          case "white_wolf_king": {
            const dy = role === "white_wolf_king" ? 1.5 : 0;
            if (role === "white_wolf_king") {
              cx.beginPath();
              cx.moveTo(8.5, 5.2);
              cx.lineTo(9.8, 2.8);
              cx.lineTo(12, 4.6);
              cx.lineTo(14.2, 2.8);
              cx.lineTo(15.5, 5.2);
              cx.stroke();
            }
            cx.beginPath();
            cx.moveTo(6.2, 10.2 + dy);
            cx.lineTo(5.2, 4.5 + dy);
            cx.lineTo(9.2, 7.6 + dy);
            cx.lineTo(14.8, 7.6 + dy);
            cx.lineTo(18.8, 4.5 + dy);
            cx.lineTo(17.8, 10.2 + dy);
            cx.lineTo(20.2, 12.8 + dy);
            cx.lineTo(16.8, 15.8 + dy);
            cx.lineTo(14.5, 19.4 + dy);
            cx.lineTo(12, 20.6 + dy);
            cx.lineTo(9.5, 19.4 + dy);
            cx.lineTo(7.2, 15.8 + dy);
            cx.lineTo(3.8, 12.8 + dy);
            cx.closePath();
            cx.stroke();
            // Crisp nose point
            cx.beginPath();
            cx.arc(12, 16.2 + dy, 0.9, 0, Math.PI * 2);
            cx.fill();
            break;
          }
          case "seer": {
            cx.beginPath();
            cx.moveTo(3, 13.2);
            cx.quadraticCurveTo(12, 6.8, 21, 13.2);
            cx.quadraticCurveTo(12, 19.6, 3, 13.2);
            cx.stroke();
            cx.beginPath();
            cx.arc(12, 13.2, 2.6, 0, Math.PI * 2);
            cx.stroke();
            cx.beginPath();
            cx.moveTo(12, 4.2);
            cx.lineTo(12, 6.5);
            cx.moveTo(7.2, 5.4);
            cx.lineTo(8.5, 7.5);
            cx.moveTo(16.8, 5.4);
            cx.lineTo(15.5, 7.5);
            cx.stroke();
            break;
          }
          case "witch": {
            cx.beginPath();
            cx.moveTo(8.8, 4.2);
            cx.lineTo(15.2, 4.2);
            cx.moveTo(10.2, 4.2);
            cx.lineTo(10.2, 8.2);
            cx.lineTo(6.2, 12.2);
            cx.quadraticCurveTo(4.8, 14.2, 5.4, 16.8);
            cx.quadraticCurveTo(6.2, 20.2, 12, 20.2);
            cx.quadraticCurveTo(17.8, 20.2, 18.6, 16.8);
            cx.quadraticCurveTo(19.2, 14.2, 17.8, 12.2);
            cx.lineTo(13.8, 8.2);
            cx.lineTo(13.8, 4.2);
            cx.stroke();
            cx.beginPath();
            cx.moveTo(12, 12.6);
            cx.lineTo(12, 16.8);
            cx.moveTo(9.9, 14.7);
            cx.lineTo(14.1, 14.7);
            cx.stroke();
            break;
          }
          case "hunter": {
            cx.beginPath();
            cx.moveTo(5.8, 15.8);
            cx.quadraticCurveTo(5.2, 5.4, 15.8, 5.8);
            cx.stroke();
            cx.beginPath();
            cx.moveTo(5.8, 15.8);
            cx.lineTo(15.8, 5.8);
            cx.stroke();
            cx.beginPath();
            cx.moveTo(5.2, 18.8);
            cx.lineTo(18.8, 5.2);
            cx.moveTo(14.5, 5.0);
            cx.lineTo(19.0, 5.0);
            cx.lineTo(19.0, 9.5);
            cx.stroke();
            break;
          }
          case "guard": {
            cx.beginPath();
            cx.moveTo(12, 3.6);
            cx.lineTo(18.8, 6.4);
            cx.lineTo(18.8, 12.0);
            cx.quadraticCurveTo(18.8, 17.4, 12, 20.6);
            cx.quadraticCurveTo(5.2, 17.4, 5.2, 12.0);
            cx.lineTo(5.2, 6.4);
            cx.closePath();
            cx.stroke();
            cx.beginPath();
            cx.moveTo(12, 8.0);
            cx.lineTo(12, 15.6);
            cx.moveTo(9.0, 11.4);
            cx.lineTo(15.0, 11.4);
            cx.stroke();
            break;
          }
          case "idiot": {
            cx.beginPath();
            cx.arc(12, 12, 7.8, 0, Math.PI * 2);
            cx.stroke();
            cx.beginPath();
            cx.arc(9.4, 10.2, 0.9, 0, Math.PI * 2);
            cx.arc(14.6, 10.2, 0.9, 0, Math.PI * 2);
            cx.fill();
            cx.beginPath();
            cx.arc(12, 12.6, 3.6, Math.PI * 0.16, Math.PI * 0.84);
            cx.stroke();
            break;
          }
          case "villager":
          default: {
            cx.beginPath();
            cx.arc(12, 8.0, 3.3, 0, Math.PI * 2);
            cx.stroke();
            cx.beginPath();
            cx.moveTo(5.6, 19.6);
            cx.quadraticCurveTo(5.8, 14.2, 12, 14.2);
            cx.quadraticCurveTo(18.2, 14.2, 18.4, 19.6);
            cx.stroke();
            break;
          }
        }

        cx.restore();
      }}
    />
  );
}

export function WerewolfStageIcon(props: {
  name: WerewolfStageIconName;
  tone?: WerewolfIconTone;
  size?: number;
  strokeWidth?: number;
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
        const color = resolveIconColor(props.tone);
        const name = props.name;
        const sw = props.strokeWidth ?? 1.85;

        cx.clearRect(0, 0, w, h);
        cx.save();
        cx.scale(w / 24, h / 24);
        cx.strokeStyle = color;
        cx.fillStyle = color;
        cx.lineWidth = sw;
        cx.lineCap = "round";
        cx.lineJoin = "round";

        switch (name) {
          case "privacy_shield": {
            cx.beginPath();
            cx.moveTo(12, 3.4);
            cx.lineTo(19, 6.2);
            cx.lineTo(19, 11.8);
            cx.quadraticCurveTo(19, 17.6, 12, 20.8);
            cx.quadraticCurveTo(5, 17.6, 5, 11.8);
            cx.lineTo(5, 6.2);
            cx.closePath();
            cx.stroke();
            // Closed eyelid arc + lashes
            cx.beginPath();
            cx.arc(12, 10.0, 4.0, Math.PI * 0.16, Math.PI * 0.84);
            cx.stroke();
            cx.beginPath();
            cx.moveTo(9.4, 13.4);
            cx.lineTo(8.8, 14.9);
            cx.moveTo(12, 14.0);
            cx.lineTo(12, 15.6);
            cx.moveTo(14.6, 13.4);
            cx.lineTo(15.2, 14.9);
            cx.stroke();
            break;
          }
          case "hold_hand": {
            // Touch ring arc
            cx.beginPath();
            cx.arc(11.2, 8.2, 4.2, Math.PI * 1.1, Math.PI * 1.9);
            cx.stroke();
            // Index finger + palm
            cx.beginPath();
            cx.moveTo(9.6, 12.2);
            cx.lineTo(9.6, 7.8);
            cx.arc(11.2, 7.8, 1.6, Math.PI, 0);
            cx.lineTo(12.8, 12.0);
            cx.lineTo(16.6, 12.6);
            cx.quadraticCurveTo(18.6, 13.0, 18.4, 15.2);
            cx.lineTo(17.8, 18.4);
            cx.quadraticCurveTo(17.4, 20.4, 15.0, 20.4);
            cx.lineTo(10.2, 20.4);
            cx.quadraticCurveTo(8.4, 20.4, 7.4, 18.6);
            cx.lineTo(5.8, 15.2);
            cx.quadraticCurveTo(5.2, 13.8, 6.6, 13.2);
            cx.lineTo(9.6, 12.2);
            cx.stroke();
            break;
          }
          case "potion_bottle": {
            cx.beginPath();
            cx.moveTo(8.8, 4.0);
            cx.lineTo(15.2, 4.0);
            cx.moveTo(10.2, 4.0);
            cx.lineTo(10.2, 8.0);
            cx.lineTo(6.2, 12.2);
            cx.quadraticCurveTo(4.6, 14.4, 5.4, 17.2);
            cx.quadraticCurveTo(6.4, 20.4, 12, 20.4);
            cx.quadraticCurveTo(17.6, 20.4, 18.6, 17.2);
            cx.quadraticCurveTo(19.4, 14.4, 17.8, 12.2);
            cx.lineTo(13.8, 8.0);
            cx.lineTo(13.8, 4.0);
            cx.stroke();
            cx.beginPath();
            cx.moveTo(6.2, 15.0);
            cx.quadraticCurveTo(9.2, 13.8, 12.0, 15.0);
            cx.quadraticCurveTo(14.8, 16.2, 17.8, 15.0);
            cx.stroke();
            cx.beginPath();
            cx.arc(10.2, 17.4, 0.85, 0, Math.PI * 2);
            cx.arc(13.8, 12.6, 0.75, 0, Math.PI * 2);
            cx.fill();
            break;
          }
          case "waveform": {
            const bars = [
              { x: 5.2, h: 6 },
              { x: 8.6, h: 11.5 },
              { x: 12.0, h: 15.5 },
              { x: 15.4, h: 10 },
              { x: 18.8, h: 5.5 },
            ];
            for (const bar of bars) {
              cx.beginPath();
              cx.moveTo(bar.x, 12 - bar.h / 2);
              cx.lineTo(bar.x, 12 + bar.h / 2);
              cx.stroke();
            }
            break;
          }
          case "check_circle": {
            cx.beginPath();
            cx.arc(12, 12, 8.4, 0, Math.PI * 2);
            cx.stroke();
            cx.beginPath();
            cx.moveTo(8.4, 12.2);
            cx.lineTo(10.9, 14.7);
            cx.lineTo(15.8, 9.6);
            cx.stroke();
            break;
          }
          case "clock": {
            cx.beginPath();
            cx.arc(12, 12, 8.4, 0, Math.PI * 2);
            cx.stroke();
            cx.beginPath();
            cx.moveTo(12, 7.8);
            cx.lineTo(12, 12.2);
            cx.lineTo(15.0, 14.0);
            cx.stroke();
            break;
          }
          case "wifi": {
            cx.beginPath();
            cx.arc(12, 17.5, 11.2, Math.PI * 1.24, Math.PI * 1.76);
            cx.stroke();
            cx.beginPath();
            cx.arc(12, 17.5, 7.6, Math.PI * 1.24, Math.PI * 1.76);
            cx.stroke();
            cx.beginPath();
            cx.arc(12, 17.5, 4.0, Math.PI * 1.24, Math.PI * 1.76);
            cx.stroke();
            cx.beginPath();
            cx.arc(12, 18.2, 1.15, 0, Math.PI * 2);
            cx.fill();
            break;
          }
          case "replay": {
            cx.beginPath();
            cx.arc(12, 12, 7.0, -Math.PI * 0.72, Math.PI * 0.88);
            cx.stroke();
            cx.beginPath();
            cx.moveTo(5.6, 5.6);
            cx.lineTo(5.6, 9.4);
            cx.lineTo(9.4, 9.4);
            cx.stroke();
            break;
          }
          case "speaker_on": {
            cx.beginPath();
            cx.moveTo(4.2, 9.5);
            cx.lineTo(7.8, 9.5);
            cx.lineTo(12.2, 5.8);
            cx.lineTo(12.2, 18.2);
            cx.lineTo(7.8, 14.5);
            cx.lineTo(4.2, 14.5);
            cx.closePath();
            cx.stroke();
            cx.beginPath();
            cx.arc(13.2, 12, 3.8, -Math.PI * 0.34, Math.PI * 0.34);
            cx.stroke();
            cx.beginPath();
            cx.arc(13.4, 12, 6.8, -Math.PI * 0.36, Math.PI * 0.36);
            cx.stroke();
            break;
          }
          case "speaker_off": {
            cx.beginPath();
            cx.moveTo(4.2, 9.5);
            cx.lineTo(7.8, 9.5);
            cx.lineTo(12.2, 5.8);
            cx.lineTo(12.2, 18.2);
            cx.lineTo(7.8, 14.5);
            cx.lineTo(4.2, 14.5);
            cx.closePath();
            cx.stroke();
            cx.beginPath();
            cx.moveTo(15.6, 9.4);
            cx.lineTo(20.2, 14.6);
            cx.moveTo(20.2, 9.4);
            cx.lineTo(15.6, 14.6);
            cx.stroke();
            break;
          }
          case "more_dots": {
            cx.beginPath();
            cx.arc(6.5, 12, 1.35, 0, Math.PI * 2);
            cx.arc(12.0, 12, 1.35, 0, Math.PI * 2);
            cx.arc(17.5, 12, 1.35, 0, Math.PI * 2);
            cx.fill();
            break;
          }
          case "arrow_left": {
            cx.beginPath();
            cx.moveTo(18.5, 12);
            cx.lineTo(5.5, 12);
            cx.moveTo(10.5, 7);
            cx.lineTo(5.5, 12);
            cx.lineTo(10.5, 17);
            cx.stroke();
            break;
          }
          case "arrow_right": {
            cx.beginPath();
            cx.moveTo(5.5, 12);
            cx.lineTo(18.5, 12);
            cx.moveTo(13.5, 7);
            cx.lineTo(18.5, 12);
            cx.lineTo(13.5, 17);
            cx.stroke();
            break;
          }
          case "chevron_left": {
            cx.beginPath();
            cx.moveTo(14.5, 6.5);
            cx.lineTo(8.5, 12);
            cx.lineTo(14.5, 17.5);
            cx.stroke();
            break;
          }
          case "chevron_right": {
            cx.beginPath();
            cx.moveTo(9.5, 6.5);
            cx.lineTo(15.5, 12);
            cx.lineTo(9.5, 17.5);
            cx.stroke();
            break;
          }
          case "avatar_silhouette": {
            cx.beginPath();
            cx.arc(12, 8.8, 3.4, 0, Math.PI * 2);
            cx.fill();
            cx.beginPath();
            cx.moveTo(5.2, 20.0);
            cx.quadraticCurveTo(5.6, 14.0, 12, 14.0);
            cx.quadraticCurveTo(18.4, 14.0, 18.8, 20.0);
            cx.closePath();
            cx.fill();
            break;
          }
        }

        cx.restore();
      }}
    />
  );
}
