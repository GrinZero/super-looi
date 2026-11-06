import { useEffect, useState, type ComponentProps, type ReactElement } from "react";
import { Text, View, type StyleProp, type ViewStyle } from "react-native";
import type IoniconsType from "@expo/vector-icons/Ionicons";
import { LOOI_PALETTE } from "../theme.js";

export type LooiIconName =
  | "eye" | "book" | "tasks" | "home" | "wrench" | "shield"
  | "sparkles" | "mic" | "camera" | "radar" | "dock" | "undock"
  | "stop" | "check" | "warning" | "close" | "search" | "sun"
  | "lamp" | "wind" | "sensor" | "bluetooth" | "server" | "gateway"
  | "play" | "edit" | "box" | "trash" | "clock" | "chevron-up";

export interface LooiIconProps {
  name: LooiIconName;
  size?: number;
  color?: string;
}

type IoniconsComponent = typeof IoniconsType;
const ICON_NAMES: Record<LooiIconName, ComponentProps<IoniconsComponent>["name"]> = {
  eye: "eye-outline", book: "book-outline", tasks: "clipboard-outline", home: "home-outline",
  wrench: "build-outline", shield: "shield-checkmark-outline", sparkles: "sparkles-outline",
  mic: "mic-outline", camera: "camera-outline", radar: "radio-outline", dock: "download-outline",
  undock: "push-outline", stop: "stop-circle-outline", check: "checkmark", warning: "warning-outline",
  close: "close", search: "search-outline", sun: "sunny-outline", lamp: "bulb-outline",
  wind: "leaf-outline", sensor: "hardware-chip-outline", bluetooth: "bluetooth-outline",
  server: "server-outline", gateway: "wifi-outline", play: "play-outline", edit: "create-outline",
  box: "cube-outline", trash: "trash-outline", clock: "time-outline", "chevron-up": "chevron-up",
};

// Keep font loading out of module evaluation: Node/SSR has no ExpoFont native module.
// Only mount Ionicons once its font is ready, so failed or pending loads never emit tofu.
let loadedIcons: IoniconsComponent | undefined;
let iconLoad: Promise<IoniconsComponent | undefined> | undefined;
function loadIcons(): Promise<IoniconsComponent | undefined> {
  if (!iconLoad) {
    iconLoad = Promise.resolve().then(async () => {
      const module = require("@expo/vector-icons/Ionicons") as { default: IoniconsComponent };
      await module.default.loadFont();
      loadedIcons = module.default;
      return loadedIcons;
    }).catch(() => undefined);
  }
  return iconLoad;
}

const FALLBACK: Partial<Record<LooiIconName, string>> = {
  check: "✓", close: "×", play: "▷", stop: "□", "chevron-up": "⌃", warning: "!",
  dock: "↓", undock: "↑", sparkles: "✧", clock: "◷", search: "⌕",
};

/** Ionicons uses the ExpoFont already linked into the prebuilt native runtime. */
export function LooiIcon({ name, size = 24, color = LOOI_PALETTE.textPrimary }: LooiIconProps): ReactElement {
  const extent = Number.isFinite(size) ? Math.max(1, size) : 24;
  const [Icon, setIcon] = useState<IoniconsComponent | undefined>(() => loadedIcons);
  useEffect(() => {
    let active = true;
    void loadIcons().then((component) => { if (active && component) setIcon(() => component); });
    return () => { active = false; };
  }, []);
  return <View accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
    pointerEvents="none" style={{ width: extent, height: extent, flexShrink: 0, alignItems: "center", justifyContent: "center" }}>
    {Icon ? <Icon name={ICON_NAMES[name]} size={extent} color={color} />
      : <Text style={{ color, fontSize: extent * 0.8, lineHeight: extent, textAlign: "center" }}>{FALLBACK[name] ?? "·"}</Text>}
  </View>;
}

export interface LooiBrandMarkProps { size?: number; color?: string; style?: StyleProp<ViewStyle> }

/** The open visor and two ears form LOOI's own emblem, independent of icon fonts. */
export function LooiBrandMark({ size = 40, color = LOOI_PALETTE.presenceCyan, style }: LooiBrandMarkProps): ReactElement {
  const extent = Number.isFinite(size) ? Math.max(1, size) : 40;
  const u = extent / 40;
  const segments = [
    [8, 34, 5, 28], [5, 28, 6, 22], [6, 22, 11, 10],
    [11, 10, 20, 19], [20, 19, 29, 10], [29, 10, 34, 22],
    [34, 22, 35, 28], [35, 28, 32, 34],
    [8, 20, 14, 18], [14, 18, 20, 21], [20, 21, 26, 18], [26, 18, 32, 20],
  ];
  return <View accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
    pointerEvents="none" style={[{ width: extent, height: extent, flexShrink: 0 }, style]}>
    {segments.map(([x1 = 0, y1 = 0, x2 = 0, y2 = 0], index) => {
      const length = Math.hypot(x2 - x1, y2 - y1) * u;
      return <View key={index} style={{ position: "absolute",
        left: (x1 + x2) / 2 * u - length / 2, top: (y1 + y2) / 2 * u - 1.8 * u,
        width: length + u, height: 3.6 * u, borderRadius: 1.8 * u, backgroundColor: color,
        boxShadow: `0 0 ${7 * u}px 0 rgba(29, 196, 255, 0.24)`,
        transform: [{ rotate: `${Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI}deg` }],
      }} />;
    })}
  </View>;
}

export interface LooiWaveOrnamentProps {
  bars?: 5 | 7 | 9;
  /** Height of the tallest bar; the ornament's width scales proportionally. */
  size?: number;
  color?: string;
  style?: StyleProp<ViewStyle>;
}

/** A quiet, symmetrical frequency ornament, not a fabricated microphone waveform. */
export function LooiWaveOrnament({ bars = 7, size = 24, color = LOOI_PALETTE.presenceCyan, style }: LooiWaveOrnamentProps): ReactElement {
  const extent = Number.isFinite(size) ? Math.max(1, size) : 24;
  const levels = bars === 9 ? [0.13, 0.18, 0.3, 0.55, 1, 0.55, 0.3, 0.18, 0.13]
    : bars === 5 ? [0.3, 0.62, 1, 0.62, 0.3] : [0.16, 0.28, 0.52, 1, 0.52, 0.28, 0.16];
  return <View accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
    pointerEvents="none" style={[{ height: extent, flexDirection: "row", alignItems: "center", gap: extent * 0.17 }, style]}>
    {levels.map((level, index) => <View key={index} style={{ width: Math.max(1, extent * 0.065),
      height: Math.max(2, extent * level), borderRadius: extent * 0.04, backgroundColor: color,
      opacity: 0.35 + level * 0.65, boxShadow: `0 0 4px 0 ${color}` }} />)}
  </View>;
}
