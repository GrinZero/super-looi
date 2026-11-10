import { Canvas, token, View } from "nsh";
import { Button } from "nsh/base";
import type { ApplianceIconKind } from "@super-looi/home-devices";

export type ActionIconName =
  | "power"
  | "play"
  | "pause"
  | "stop"
  | "dock"
  | "dust"
  | "wash"
  | "dry"
  | "locate"
  | "dispense"
  | "refresh"
  | "scan"
  | "new_chat"
  | "back"
  | "edit"
  | "check"
  | "swap"
  | "move_left"
  | "move_right"
  | "plus"
  | "minus"
  | "sun"
  | "moon"
  | "shield"
  | "leaf"
  | "thermometer"
  | "droplet"
  | "more"
  | "rotate_left"
  | "rotate_right";

export type IconTone =
  | "foreground"
  | "primary"
  | "primaryFg"
  | "muted"
  | "verified"
  | "warning"
  | "destructive"
  | "lighting"
  | "airflow"
  | "airQuality";

function resolveToneColor(tone: IconTone): string {
  switch (tone) {
    case "primary":
      return token("primary");
    case "primaryFg":
      return token("primary-foreground");
    case "muted":
      return token("muted-foreground");
    case "verified":
      return token("verified");
    case "warning":
      return token("warning");
    case "destructive":
      return token("destructive");
    case "lighting":
      return token("lighting");
    case "airflow":
      return token("airflow");
    case "airQuality":
      return token("air-quality");
    case "foreground":
    default:
      return token("foreground");
  }
}

/**
 * Crisp 24x24 normalized Canvas vector icon for smart home actions & controls.
 */
export function ActionIcon(props: {
  name: ActionIconName;
  tone?: IconTone;
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
        const strokeColor = resolveToneColor(props.tone ?? "foreground");

        cx.save();
        cx.scale(w / 24, h / 24);
        cx.strokeStyle = strokeColor;
        cx.fillStyle = strokeColor;
        cx.lineWidth = 2.1;
        cx.lineCap = "round";
        cx.lineJoin = "round";

        switch (props.name) {
          case "power": {
            // IEC Power symbol: vertical top bar + open circular arc
            cx.beginPath();
            cx.moveTo(12, 3.5);
            cx.lineTo(12, 11.5);
            cx.stroke();

            cx.beginPath();
            cx.arc(12, 13, 7.2, -Math.PI * 0.28, Math.PI * 1.28, false);
            cx.stroke();
            break;
          }
          case "play": {
            cx.beginPath();
            cx.moveTo(7.5, 5.2);
            cx.lineTo(18.5, 12);
            cx.lineTo(7.5, 18.8);
            cx.closePath();
            cx.fill();
            break;
          }
          case "pause": {
            cx.beginPath();
            cx.roundRect(6.5, 5, 3.8, 14, 1.5);
            cx.roundRect(13.7, 5, 3.8, 14, 1.5);
            cx.fill();
            break;
          }
          case "stop": {
            cx.beginPath();
            cx.roundRect(6.2, 6.2, 11.6, 11.6, 2.2);
            cx.fill();
            break;
          }
          case "dock": {
            // Home dock roof + charging bolt
            cx.beginPath();
            cx.moveTo(4, 11);
            cx.lineTo(12, 4.5);
            cx.lineTo(20, 11);
            cx.stroke();

            cx.beginPath();
            cx.moveTo(6.5, 10.5);
            cx.lineTo(6.5, 19);
            cx.lineTo(17.5, 19);
            cx.lineTo(17.5, 10.5);
            cx.stroke();

            cx.beginPath();
            cx.moveTo(12.6, 9.5);
            cx.lineTo(10.2, 13.2);
            cx.lineTo(13.2, 13.2);
            cx.lineTo(11.2, 16.8);
            cx.stroke();
            break;
          }
          case "dust": {
            // Cyclone / dust collection bin
            cx.beginPath();
            cx.roundRect(6.5, 6, 11, 13.5, 2);
            cx.stroke();
            cx.beginPath();
            cx.moveTo(5, 6);
            cx.lineTo(19, 6);
            cx.moveTo(9.5, 3.8);
            cx.lineTo(14.5, 3.8);
            cx.moveTo(10, 10);
            cx.lineTo(10, 15.5);
            cx.moveTo(14, 10);
            cx.lineTo(14, 15.5);
            cx.stroke();
            break;
          }
          case "wash": {
            // Water droplet + clean wave
            cx.beginPath();
            cx.moveTo(12, 4);
            cx.quadraticCurveTo(17.5, 10.5, 17.5, 14.2);
            cx.arc(12, 14.2, 5.5, 0, Math.PI, false);
            cx.quadraticCurveTo(6.5, 10.5, 12, 4);
            cx.stroke();
            break;
          }
          case "dry": {
            // Three warm rising air waves
            for (const x of [7.5, 12, 16.5]) {
              cx.beginPath();
              cx.moveTo(x, 18.5);
              cx.quadraticCurveTo(x - 2, 14.5, x, 12);
              cx.quadraticCurveTo(x + 2, 9.5, x, 5.5);
              cx.stroke();
            }
            break;
          }
          case "locate": {
            cx.beginPath();
            cx.arc(12, 12, 6.5, 0, Math.PI * 2);
            cx.stroke();
            cx.beginPath();
            cx.arc(12, 12, 2, 0, Math.PI * 2);
            cx.fill();
            cx.beginPath();
            cx.moveTo(12, 3);
            cx.lineTo(12, 5.5);
            cx.moveTo(12, 18.5);
            cx.lineTo(12, 21);
            cx.moveTo(3, 12);
            cx.lineTo(5.5, 12);
            cx.moveTo(18.5, 12);
            cx.lineTo(21, 12);
            cx.stroke();
            break;
          }
          case "dispense": {
            // Down arrow into pet bowl
            cx.beginPath();
            cx.moveTo(12, 4);
            cx.lineTo(12, 12.5);
            cx.moveTo(8.8, 9.5);
            cx.lineTo(12, 12.8);
            cx.lineTo(15.2, 9.5);
            cx.stroke();
            cx.beginPath();
            cx.moveTo(4.5, 15.5);
            cx.lineTo(19.5, 15.5);
            cx.lineTo(17.5, 19.5);
            cx.lineTo(6.5, 19.5);
            cx.closePath();
            cx.stroke();
            break;
          }
          case "refresh": {
            cx.beginPath();
            cx.arc(12, 12, 7, Math.PI / 6, Math.PI * 1.75, false);
            cx.stroke();
            cx.beginPath();
            cx.moveTo(12.5, 7);
            cx.lineTo(17, 7);
            cx.lineTo(17, 2.5);
            cx.stroke();
            break;
          }
          case "scan": {
            // Radar sweep: nearby wireless discovery, distinct from refresh.
            cx.beginPath();
            cx.arc(12, 12, 8, 0, Math.PI * 2);
            cx.moveTo(16, 12);
            cx.arc(12, 12, 4, 0, Math.PI * 1.5);
            cx.moveTo(12, 12);
            cx.lineTo(17.7, 6.3);
            cx.stroke();
            cx.beginPath();
            cx.arc(12, 12, 1.3, 0, Math.PI * 2);
            cx.fill();
            break;
          }
          case "new_chat": {
            // Open speech bubble with a plus in its upper-right corner.
            cx.beginPath();
            cx.moveTo(13, 4.5);
            cx.lineTo(7, 4.5);
            cx.quadraticCurveTo(4, 4.5, 4, 7.5);
            cx.lineTo(4, 20);
            cx.lineTo(8.5, 17);
            cx.lineTo(16, 17);
            cx.quadraticCurveTo(19, 17, 19, 14);
            cx.lineTo(19, 12);
            cx.moveTo(18.5, 3);
            cx.lineTo(18.5, 9);
            cx.moveTo(15.5, 6);
            cx.lineTo(21.5, 6);
            cx.stroke();
            break;
          }
          case "back": {
            cx.beginPath();
            cx.moveTo(15, 5.5);
            cx.lineTo(8.5, 12);
            cx.lineTo(15, 18.5);
            cx.stroke();
            break;
          }
          case "edit": {
            // 4 Bento grid squares
            cx.beginPath();
            cx.roundRect(4, 4, 6.8, 6.8, 1.5);
            cx.roundRect(13.2, 4, 6.8, 6.8, 1.5);
            cx.roundRect(4, 13.2, 6.8, 6.8, 1.5);
            cx.roundRect(13.2, 13.2, 6.8, 6.8, 1.5);
            cx.stroke();
            break;
          }
          case "check": {
            cx.beginPath();
            cx.moveTo(5, 12.5);
            cx.lineTo(9.8, 17.2);
            cx.lineTo(19, 7);
            cx.stroke();
            break;
          }
          case "swap": {
            cx.beginPath();
            cx.moveTo(6, 8.5);
            cx.lineTo(18, 8.5);
            cx.moveTo(14.5, 5.2);
            cx.lineTo(18, 8.5);
            cx.lineTo(14.5, 11.8);
            cx.moveTo(18, 15.5);
            cx.lineTo(6, 15.5);
            cx.moveTo(9.5, 12.2);
            cx.lineTo(6, 15.5);
            cx.lineTo(9.5, 18.8);
            cx.stroke();
            break;
          }
          case "move_left": {
            cx.beginPath();
            cx.moveTo(14.5, 6.5);
            cx.lineTo(9, 12);
            cx.lineTo(14.5, 17.5);
            cx.stroke();
            break;
          }
          case "move_right": {
            cx.beginPath();
            cx.moveTo(9.5, 6.5);
            cx.lineTo(15, 12);
            cx.lineTo(9.5, 17.5);
            cx.stroke();
            break;
          }
          case "plus": {
            cx.beginPath();
            cx.moveTo(12, 5.5);
            cx.lineTo(12, 18.5);
            cx.moveTo(5.5, 12);
            cx.lineTo(18.5, 12);
            cx.stroke();
            break;
          }
          case "minus": {
            cx.beginPath();
            cx.moveTo(5.5, 12);
            cx.lineTo(18.5, 12);
            cx.stroke();
            break;
          }
          case "sun": {
            cx.beginPath();
            cx.arc(12, 12, 4.2, 0, Math.PI * 2);
            cx.stroke();
            for (let i = 0; i < 8; i++) {
              const a = (i * Math.PI) / 4;
              cx.beginPath();
              cx.moveTo(12 + Math.cos(a) * 6.8, 12 + Math.sin(a) * 6.8);
              cx.lineTo(12 + Math.cos(a) * 9.2, 12 + Math.sin(a) * 9.2);
              cx.stroke();
            }
            break;
          }
          case "moon": {
            cx.beginPath();
            cx.arc(13, 12, 6.8, Math.PI * 0.25, Math.PI * 1.45, false);
            cx.quadraticCurveTo(10, 12, 16.5, 16.8);
            cx.stroke();
            break;
          }
          case "shield": {
            cx.beginPath();
            cx.moveTo(12, 3.8);
            cx.lineTo(18.5, 6.5);
            cx.lineTo(18.5, 12.2);
            cx.quadraticCurveTo(18.5, 17.8, 12, 20.5);
            cx.quadraticCurveTo(5.5, 17.8, 5.5, 12.2);
            cx.lineTo(5.5, 6.5);
            cx.closePath();
            cx.stroke();
            break;
          }
          case "leaf": {
            cx.beginPath();
            cx.moveTo(6, 18);
            cx.quadraticCurveTo(5.5, 8.5, 18.5, 5.5);
            cx.quadraticCurveTo(17.5, 17.5, 6, 18);
            cx.stroke();
            cx.beginPath();
            cx.moveTo(5.5, 18.5);
            cx.quadraticCurveTo(10.5, 14, 15, 9.5);
            cx.stroke();
            break;
          }
          case "thermometer": {
            cx.beginPath();
            cx.moveTo(10, 5.5);
            cx.arc(12, 5.5, 2, Math.PI, 0, false);
            cx.lineTo(14, 13.5);
            cx.arc(12, 16.5, 3.6, -Math.PI * 0.32, Math.PI * 1.32, false);
            cx.closePath();
            cx.stroke();
            cx.beginPath();
            cx.arc(12, 16.5, 1.5, 0, Math.PI * 2);
            cx.fill();
            cx.beginPath();
            cx.moveTo(12, 9.5);
            cx.lineTo(12, 15.5);
            cx.stroke();
            break;
          }
          case "droplet": {
            cx.beginPath();
            cx.moveTo(12, 4.2);
            cx.quadraticCurveTo(17.5, 10.8, 17.5, 14.5);
            cx.arc(12, 14.5, 5.5, 0, Math.PI, false);
            cx.quadraticCurveTo(6.5, 10.8, 12, 4.2);
            cx.closePath();
            cx.stroke();
            break;
          }
          case "more": {
            for (const x of [6, 12, 18]) {
              cx.beginPath();
              cx.arc(x, 12, 1.6, 0, Math.PI * 2);
              cx.fill();
            }
            break;
          }
          case "rotate_left": {
            cx.beginPath();
            cx.arc(12, 13, 6.2, -Math.PI * 0.25, Math.PI * 1.2, true);
            cx.stroke();
            cx.beginPath();
            cx.moveTo(8.5, 4.8);
            cx.lineTo(6.2, 7.8);
            cx.lineTo(9.8, 9.2);
            cx.stroke();
            break;
          }
          case "rotate_right": {
            cx.beginPath();
            cx.arc(12, 13, 6.2, -Math.PI * 0.75, Math.PI * 0.2, false);
            cx.stroke();
            cx.beginPath();
            cx.moveTo(15.5, 4.8);
            cx.lineTo(17.8, 7.8);
            cx.lineTo(14.2, 9.2);
            cx.stroke();
            break;
          }
        }
        cx.restore();
      }}
    />
  );
}

/**
 * Semantic 24x24 Canvas vector icon for each of the smart home appliance categories,
 * enclosed in a subtle themed badge container with domain-aware active colors.
 */
export function ApplianceIcon(props: {
  kind: ApplianceIconKind;
  active?: boolean;
  size?: "sm" | "md" | "lg";
}) {
  const boxPx = () => (props.size === "lg" ? 44 : props.size === "sm" ? 28 : 34);
  const drawPx = () => (props.size === "lg" ? 24 : props.size === "sm" ? 16 : 19);

  const semanticDomain = () => {
    switch (props.kind) {
      case "light":
      case "desk_lamp":
        return "lighting";
      case "fan":
      case "ac":
      case "dehumidifier":
        return "airflow";
      case "purifier":
        return "air-quality";
      default:
        return "default";
    }
  };

  const containerClass = () => {
    const dim =
      props.size === "lg"
        ? "w-11 h-11 rounded-2xl"
        : props.size === "sm"
          ? "w-7 h-7 rounded-lg"
          : "w-8.5 h-8.5 rounded-xl";
    if (props.active) {
      const domain = semanticDomain();
      if (domain === "lighting") {
        return `${dim} bg-lighting-bg border border-lighting-border items-center justify-center`;
      }
      if (domain === "airflow") {
        return `${dim} bg-airflow-bg border border-airflow-border items-center justify-center`;
      }
      if (domain === "air-quality") {
        return `${dim} bg-air-quality-bg border border-air-quality-border items-center justify-center`;
      }
      return `${dim} bg-primary items-center justify-center`;
    }
    return `${dim} bg-muted border border-border items-center justify-center`;
  };

  return (
    <View
      class={containerClass()}
      style={{ width: boxPx(), height: boxPx(), pointerEvents: "none" }}
    >
      <Canvas
        style={{ width: drawPx(), height: drawPx(), pointerEvents: "none" }}
        draw={(cx, canvasSize) => {
          const w = canvasSize.width || drawPx();
          const h = canvasSize.height || drawPx();
          const domain = semanticDomain();
          const color = props.active
            ? domain === "lighting"
              ? token("lighting")
              : domain === "airflow"
                ? token("airflow")
                : domain === "air-quality"
                  ? token("air-quality")
                  : token("primary-foreground")
            : token("foreground");

          cx.save();
          cx.scale(w / 24, h / 24);
          cx.strokeStyle = color;
          cx.fillStyle = color;
          cx.lineWidth = 1.9;
          cx.lineCap = "round";
          cx.lineJoin = "round";

          switch (props.kind) {
            case "camera": {
              // PTZ Security Camera: dome head + center lens + base stand
              cx.beginPath();
              cx.arc(12, 10.2, 6.2, 0, Math.PI * 2);
              cx.stroke();
              cx.beginPath();
              cx.arc(12, 10.2, 2.2, 0, Math.PI * 2);
              cx.fill();
              cx.beginPath();
              cx.moveTo(8.5, 16.2);
              cx.lineTo(6.5, 19.8);
              cx.lineTo(17.5, 19.8);
              cx.lineTo(15.5, 16.2);
              cx.stroke();
              break;
            }
            case "vacuum": {
              // Robot Vacuum: circular body + front bumper arc + top lidar turret
              cx.beginPath();
              cx.arc(12, 12, 8.2, 0, Math.PI * 2);
              cx.stroke();
              cx.beginPath();
              cx.arc(12, 12, 5.2, -Math.PI * 0.75, -Math.PI * 0.25);
              cx.stroke();
              cx.beginPath();
              cx.arc(12, 13.2, 2.3, 0, Math.PI * 2);
              cx.stroke();
              break;
            }
            case "cooker": {
              // Rice Cooker: rounded pot + lid + steam lines
              cx.beginPath();
              cx.roundRect(4.5, 9.5, 15, 10, [2, 2, 5, 5]);
              cx.stroke();
              cx.beginPath();
              cx.moveTo(3.5, 12);
              cx.lineTo(20.5, 12);
              cx.moveTo(9.5, 7);
              cx.lineTo(14.5, 7);
              cx.stroke();
              cx.beginPath();
              cx.roundRect(9.5, 14.2, 5, 2.5, 1);
              cx.stroke();
              break;
            }
            case "washer":
            case "dishwasher": {
              // Front-load Washer / Dishwasher: outer cabinet + drum circle
              cx.beginPath();
              cx.roundRect(5, 3.8, 14, 16.4, 2.4);
              cx.stroke();
              cx.beginPath();
              cx.moveTo(5, 8);
              cx.lineTo(19, 8);
              cx.stroke();
              cx.beginPath();
              cx.arc(12, 14, 3.8, 0, Math.PI * 2);
              cx.stroke();
              break;
            }
            case "microwave": {
              cx.beginPath();
              cx.roundRect(3.5, 6, 17, 12, 2.2);
              cx.stroke();
              cx.beginPath();
              cx.roundRect(6, 8.5, 8.5, 7, 1.2);
              cx.stroke();
              cx.beginPath();
              cx.arc(17.2, 10.5, 1, 0, Math.PI * 2);
              cx.arc(17.2, 14, 1, 0, Math.PI * 2);
              cx.fill();
              break;
            }
            case "ac": {
              // Split wall AC + cool breeze lines
              cx.beginPath();
              cx.roundRect(3.5, 5, 17, 8, 2.2);
              cx.stroke();
              cx.beginPath();
              cx.moveTo(6.5, 10.5);
              cx.lineTo(17.5, 10.5);
              cx.stroke();
              cx.beginPath();
              cx.moveTo(8, 15.5);
              cx.quadraticCurveTo(7, 17.5, 8.5, 19);
              cx.moveTo(12, 15.5);
              cx.quadraticCurveTo(11, 17.5, 12.5, 19);
              cx.moveTo(16, 15.5);
              cx.quadraticCurveTo(15, 17.5, 16.5, 19);
              cx.stroke();
              break;
            }
            case "fan": {
              // Pedestal Fan: circular grille + 3 curved impeller blades + hub + stand & base
              cx.beginPath();
              cx.arc(12, 9.8, 6.2, 0, Math.PI * 2);
              cx.stroke();
              cx.beginPath();
              cx.arc(12, 9.8, 1.4, 0, Math.PI * 2);
              cx.fill();
              for (let i = 0; i < 3; i++) {
                const a = (i * Math.PI * 2) / 3 - Math.PI / 2;
                cx.beginPath();
                cx.moveTo(12 + Math.cos(a) * 1.5, 9.8 + Math.sin(a) * 1.5);
                cx.quadraticCurveTo(
                  12 + Math.cos(a + 0.55) * 4.8,
                  9.8 + Math.sin(a + 0.55) * 4.8,
                  12 + Math.cos(a + 0.12) * 4.8,
                  9.8 + Math.sin(a + 0.12) * 4.8,
                );
                cx.stroke();
              }
              cx.beginPath();
              cx.moveTo(12, 16);
              cx.lineTo(12, 20);
              cx.moveTo(8.2, 20);
              cx.lineTo(15.8, 20);
              cx.stroke();
              break;
            }
            case "purifier":
            case "dehumidifier": {
              cx.beginPath();
              cx.roundRect(6.5, 3.8, 11, 16.4, 2.5);
              cx.stroke();
              cx.beginPath();
              cx.moveTo(9, 8.5);
              cx.lineTo(15, 8.5);
              cx.moveTo(9, 14);
              cx.lineTo(15, 14);
              cx.moveTo(9, 16.8);
              cx.lineTo(15, 16.8);
              cx.stroke();
              break;
            }
            case "kettle": {
              cx.beginPath();
              cx.roundRect(6.5, 6, 10, 13.5, 2.2);
              cx.stroke();
              cx.beginPath();
              cx.moveTo(16.5, 8.5);
              cx.lineTo(19.5, 8.5);
              cx.lineTo(19.5, 14.5);
              cx.lineTo(16.5, 14.5);
              cx.stroke();
              cx.beginPath();
              cx.moveTo(11.5, 10);
              cx.lineTo(11.5, 15.5);
              cx.stroke();
              break;
            }
            case "blanket": {
              cx.beginPath();
              cx.roundRect(4.5, 6, 15, 12, 2.2);
              cx.stroke();
              cx.beginPath();
              cx.moveTo(9, 9);
              cx.quadraticCurveTo(10.5, 12, 9, 15);
              cx.moveTo(15, 9);
              cx.quadraticCurveTo(16.5, 12, 15, 15);
              cx.stroke();
              break;
            }
            case "light": {
              // Ceiling / Ambient Lightbulb silhouette + warm rays
              cx.beginPath();
              cx.arc(12, 10, 5.2, Math.PI * 0.78, Math.PI * 0.22, false);
              cx.lineTo(14.2, 15.8);
              cx.lineTo(9.8, 15.8);
              cx.closePath();
              cx.stroke();
              cx.beginPath();
              cx.moveTo(10, 18.8);
              cx.lineTo(14, 18.8);
              cx.stroke();
              break;
            }
            case "desk_lamp": {
              // Architect / Study Desk Lamp: angled arm + conical shade + weighted base
              cx.beginPath();
              cx.moveTo(6.5, 19.5);
              cx.lineTo(15.5, 19.5);
              cx.moveTo(10.5, 19.5);
              cx.lineTo(7.5, 12.5);
              cx.lineTo(13, 6.8);
              cx.stroke();
              cx.beginPath();
              cx.moveTo(11.5, 5.2);
              cx.lineTo(18.5, 8.2);
              cx.lineTo(16.2, 11.2);
              cx.lineTo(10.5, 8.5);
              cx.closePath();
              cx.stroke();
              break;
            }
            case "switch_gang": {
              // 3-gang wall switch panel
              cx.beginPath();
              cx.roundRect(4.2, 4.2, 15.6, 15.6, 2.5);
              cx.stroke();
              cx.beginPath();
              cx.moveTo(9.4, 6.5);
              cx.lineTo(9.4, 17.5);
              cx.moveTo(14.6, 6.5);
              cx.lineTo(14.6, 17.5);
              cx.stroke();
              break;
            }
            case "plug": {
              // Smart socket / power outlet
              cx.beginPath();
              cx.roundRect(4.5, 4.5, 15, 15, 3.5);
              cx.stroke();
              cx.beginPath();
              cx.moveTo(9.5, 9.5);
              cx.lineTo(9.5, 13.5);
              cx.moveTo(14.5, 9.5);
              cx.lineTo(14.5, 13.5);
              cx.stroke();
              break;
            }
            case "tv": {
              cx.beginPath();
              cx.roundRect(3.5, 5.2, 17, 11, 2);
              cx.stroke();
              cx.beginPath();
              cx.moveTo(8.5, 19.2);
              cx.lineTo(15.5, 19.2);
              cx.moveTo(12, 16.2);
              cx.lineTo(12, 19.2);
              cx.stroke();
              break;
            }
            case "speaker": {
              cx.beginPath();
              cx.roundRect(6.5, 4, 11, 16, 3.5);
              cx.stroke();
              cx.beginPath();
              cx.arc(12, 13.5, 2.8, 0, Math.PI * 2);
              cx.stroke();
              cx.beginPath();
              cx.arc(12, 7.8, 1, 0, Math.PI * 2);
              cx.fill();
              break;
            }
            case "feeder":
            case "waterer": {
              cx.beginPath();
              cx.roundRect(6.5, 4.5, 11, 9.5, 2);
              cx.stroke();
              cx.beginPath();
              cx.moveTo(4.5, 16);
              cx.lineTo(19.5, 16);
              cx.lineTo(17.5, 19.5);
              cx.lineTo(6.5, 19.5);
              cx.closePath();
              cx.stroke();
              break;
            }
            case "lock":
            case "bell": {
              cx.beginPath();
              cx.roundRect(6, 10.5, 12, 9.5, 2.2);
              cx.stroke();
              cx.beginPath();
              cx.arc(12, 8.5, 3.8, Math.PI, 0, false);
              cx.lineTo(15.8, 10.5);
              cx.moveTo(8.2, 8.5);
              cx.lineTo(8.2, 10.5);
              cx.stroke();
              break;
            }
            case "router": {
              cx.beginPath();
              cx.roundRect(4, 13, 16, 6, 2);
              cx.stroke();
              cx.beginPath();
              cx.moveTo(7.5, 13);
              cx.lineTo(6, 6);
              cx.moveTo(16.5, 13);
              cx.lineTo(18, 6);
              cx.stroke();
              break;
            }
            case "sensor":
            default: {
              cx.beginPath();
              cx.arc(12, 12, 2.4, 0, Math.PI * 2);
              cx.fill();
              cx.beginPath();
              cx.arc(12, 12, 5.8, -Math.PI * 0.35, Math.PI * 0.35);
              cx.stroke();
              cx.beginPath();
              cx.arc(12, 12, 5.8, Math.PI * 0.65, Math.PI * 1.35);
              cx.stroke();
              break;
            }
          }
          cx.restore();
        }}
      />
    </View>
  );
}

/**
 * Unmistakable circular Power Icon button (`⏻`):
 * - Lit (`isOn = true`): `bg-primary` with `primary-foreground` power icon
 * - Off (`isOn = false`): `bg-muted border-border` with `muted-foreground` power icon
 * Eliminates ambiguous "开启" / "关闭" button text while remaining language-agnostic.
 */
export function PowerIconButton(props: {
  isOn: boolean;
  disabled?: boolean;
  size?: "sm" | "md" | "lg";
  testID?: string;
  accessibilityLabel: string;
  onPress: () => void;
}) {
  const dimClass = () => {
    if (props.size === "lg") return "w-12 h-12 rounded-full";
    if (props.size === "sm") return "w-9 h-9 rounded-full";
    return "w-10 h-10 rounded-full";
  };

  const surfaceClass = () => {
    if (props.isOn) {
      return `${dimClass()} bg-primary border border-transparent items-center justify-center active:opacity-75 disabled:opacity-35`;
    }
    return `${dimClass()} bg-muted border border-border items-center justify-center active:opacity-75 disabled:opacity-35`;
  };

  const iconPx = () => (props.size === "lg" ? 22 : props.size === "sm" ? 16 : 18);

  return (
    <Button
      testID={props.testID}
      selected={props.isOn}
      disabled={props.disabled}
      hitSlop={6}
      accessibilityLabel={props.accessibilityLabel}
      onPress={() => props.onPress()}
      class={surfaceClass()}
    >
      <ActionIcon
        name="power"
        tone={props.isOn ? "primaryFg" : "muted"}
        size={iconPx()}
      />
    </Button>
  );
}
