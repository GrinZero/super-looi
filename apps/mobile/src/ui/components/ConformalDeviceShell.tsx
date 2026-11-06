import type { ReactNode } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { ToastItem } from "../light-toast-queue.js";
import type { RobotFaceState } from "../robot-face-controller.js";
import { LOOI_PALETTE as palette, LOOI_TYPE as type } from "../theme.js";
import { LooiIcon, type LooiIconName } from "./LooiIcon.js";
import { RobotFaceView } from "./RobotFaceView.js";

export type ConformalSpace = "memories" | "tasks_and_rules" | "home" | "cabin";

export interface ConformalDeviceShellProps {
  activeSpace: ConformalSpace;
  onNavigate: (space: ConformalSpace) => void;
  onReturnToFace: () => void;
  title?: string;
  subtitle?: string;
  isDocked: boolean;
  deskFreshnessNotice?: string;
  miniGaze: { x: number; y: number };
  faceState: RobotFaceState;
  microShift: { dx: number; dy: number };
  toast?: ToastItem | null;
  children: ReactNode;
}

const DESTINATIONS: ReadonlyArray<{ space: ConformalSpace; title: string; icon: LooiIconName }> = [
  { space: "memories", title: "记忆", icon: "book" },
  { space: "tasks_and_rules", title: "任务", icon: "tasks" },
  { space: "home", title: "家居", icon: "home" },
  { space: "cabin", title: "维修", icon: "wrench" },
];

export interface LightToastCapsuleProps {
  /** The queue owner handles its three-second lifetime and speech deferral. */
  toast?: ToastItem | null;
}

export function LightToastCapsule({ toast }: LightToastCapsuleProps) {
  if (!toast) return null;
  const icon: LooiIconName = toast.priority === "urgent" || toast.color === palette.cautionAmber || toast.color === palette.alertCoral
    ? "warning"
    : toast.color === palette.confirmGreen ? "check" : "sparkles";
  return (
    <View
      pointerEvents="none"
      accessibilityLiveRegion="polite"
      accessibilityRole="alert"
      style={[styles.toast, { borderColor: toast.color }]}
    >
      <LooiIcon name={icon} color={toast.color} size={18} />
      <Text style={styles.toastText} numberOfLines={3}>{toast.message}</Text>
    </View>
  );
}

/** Shared device frame. State, capture, navigation, and toast expiry belong to its host. */
export function ConformalDeviceShell({
  activeSpace,
  onNavigate,
  onReturnToFace,
  isDocked,
  deskFreshnessNotice,
  miniGaze,
  faceState,
  microShift,
  toast,
  children,
}: ConformalDeviceShellProps) {
  const insets = useSafeAreaInsets();
  const window = useWindowDimensions();
  const compact = window.width < 720;
  const narrow = window.width < 440;
  const shortLandscape = !compact && window.height < 500;

  const navigation = (
    <ScrollView
      horizontal={compact}
      bounces={false}
      showsHorizontalScrollIndicator={false}
      showsVerticalScrollIndicator={false}
      contentContainerStyle={[styles.navigation, compact && styles.compactNavigation, shortLandscape && styles.shortNavigation]}
      style={[compact ? styles.compactScroll : styles.railScroll, !compact && shortLandscape && styles.shortRailScroll]}
    >
      {DESTINATIONS.map((destination) => {
        const selected = activeSpace === destination.space;
        return (
          <Pressable
            key={destination.space}
            accessibilityRole="button"
            accessibilityLabel={`打开${destination.title}空间`}
            accessibilityState={{ selected }}
            onPress={() => onNavigate(destination.space)}
            style={({ pressed }) => [
              styles.navButton,
              selected && styles.navSelected,
              compact && styles.compactNavButton,
              shortLandscape && styles.shortNavButton,
              narrow && styles.narrowNavButton,
              pressed && styles.pressed,
            ]}
          >
            <LooiIcon name={destination.icon} size={shortLandscape ? 20 : 23} color={selected ? palette.presenceCyan : palette.textSecondary} />
            <Text style={[styles.navText, selected && styles.navTextSelected]}>{destination.title}</Text>
            {selected && <View pointerEvents="none" style={[styles.selectionConnector, compact && styles.compactSelectionConnector]} />}
            {selected && <View pointerEvents="none" style={[styles.selectionMark, compact && styles.compactSelectionMark]} />}
          </Pressable>
        );
      })}
    </ScrollView>
  );

  return (
    <View style={[styles.stage, {
      paddingTop: insets.top,
      paddingLeft: insets.left,
      paddingRight: insets.right,
    }]}>
      <View pointerEvents="none" style={styles.ambientLight} />
      <View style={[styles.device, compact && styles.deviceCompact]}>
        <View style={[styles.rail, compact && styles.compactRail, shortLandscape && styles.shortRail, { paddingBottom: Math.max(8, insets.bottom) }]}>
          <View pointerEvents="none" style={styles.glassHighlight} />
          {!compact && <View pointerEvents="none" style={[styles.railSpine, shortLandscape && styles.shortRailSpine]} />}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="LOOI 返回全屏大脸"
            onPress={onReturnToFace}
            style={({ pressed }) => [styles.brandButton, compact && styles.compactBrandButton, shortLandscape && styles.shortBrandButton, pressed && styles.pressed]}
          >
            <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.brandAvatar}>
              <View style={{ transform: [{ scale: compact ? 0.42 : shortLandscape ? 0.44 : 0.48 }] }}>
                <RobotFaceView
                  mode="avatar"
                  expression={faceState.expression}
                  gaze={{ x: miniGaze.x, y: -miniGaze.y }}
                  blinkProgress={faceState.blinkProgress}
                  waveformBars={faceState.waveformBars}
                  microShift={microShift}
                />
              </View>
            </View>
            <View pointerEvents="none" style={styles.brandLabelRow}>
              <View style={styles.brandStatusDot} />
              <Text style={styles.brandCaption}>LOOI</Text>
            </View>
          </Pressable>
          {navigation}
          {!compact && <View pointerEvents="none" style={[styles.railFoot, shortLandscape && styles.shortRailFoot]} />}
        </View>
        <View style={styles.main}>
          {!isDocked && (
            <View pointerEvents="none" style={styles.freshnessBanner} accessibilityLiveRegion="polite" accessibilityHint={deskFreshnessNotice}>
              <LooiIcon name="undock" size={14} color={palette.cautionAmber} />
              <Text style={styles.freshnessText}>已离座 · 桌面停留在最后观察</Text>
            </View>
          )}
          {toast && <View pointerEvents="none" style={styles.toastPosition}><LightToastCapsule toast={toast} /></View>}
          <View style={[styles.content, { paddingBottom: compact || shortLandscape ? 0 : insets.bottom }]}>{children}</View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  stage: { flex: 1, backgroundColor: palette.bgDeep },
  ambientLight: {
    position: "absolute", top: -180, right: -120, width: 430, height: 430,
    borderRadius: 215, backgroundColor: "rgba(31, 124, 255, 0.04)",
  },
  device: { flex: 1, flexDirection: "row" },
  deviceCompact: { flexDirection: "column-reverse" },
  rail: {
    width: 88, backgroundColor: palette.surfaceRail, borderRightWidth: 1,
    borderRightColor: palette.lineSubtle, alignItems: "center", overflow: "hidden",
    experimental_backgroundImage: "linear-gradient(90deg, rgba(40,213,255,0.035), rgba(4,10,18,0))",
  },
  compactRail: {
    width: "100%", minHeight: 74, flexDirection: "row", borderRightWidth: 0,
    borderTopWidth: 1, borderTopColor: palette.lineSubtle, paddingHorizontal: 8,
    backgroundColor: "rgba(4,10,18,0.95)",
  },
  shortRail: { width: 80, paddingTop: 6 },
  glassHighlight: {
    position: "absolute", top: 0, left: 0, right: 0, height: 1,
    backgroundColor: "rgba(164, 204, 255, 0.15)",
  },
  railSpine: { position: "absolute", top: 100, bottom: 32, left: 3, width: 1,
    experimental_backgroundImage: "linear-gradient(180deg, rgba(40,213,255,0), rgba(40,213,255,0.25), rgba(40,213,255,0))" },
  shortRailSpine: { top: 64, bottom: 16 },
  brandButton: { minHeight: 60, width: 88, justifyContent: "center", alignItems: "center", gap: 2 },
  compactBrandButton: { width: 68, minHeight: 52 },
  shortBrandButton: { width: 80, minHeight: 52 },
  brandAvatar: { width: 76, height: 38, borderRadius: 13, borderWidth: 1, borderColor: "rgba(40,213,255,0.22)", backgroundColor: "rgba(10,24,40,0.68)", alignItems: "center", justifyContent: "center" },
  brandLabelRow: { flexDirection: "row", alignItems: "center", gap: 4 },
  brandStatusDot: { width: 4, height: 4, borderRadius: 2, backgroundColor: palette.presenceCyan, boxShadow: "0 0 6px rgba(40,213,255,0.8)" },
  brandCaption: { color: palette.textSecondary, opacity: 0.78, fontSize: 8.5, fontWeight: "700", letterSpacing: 2.2 },
  railScroll: { flex: 1, width: 88, overflow: "visible" },
  shortRailScroll: { width: 80 },
  compactScroll: { flex: 1 },
  navigation: { flexGrow: 1, justifyContent: "center", alignItems: "center", gap: 12, paddingVertical: 12, paddingHorizontal: 4 },
  compactNavigation: { flexDirection: "row", justifyContent: "space-around", gap: 4, paddingVertical: 4 },
  shortNavigation: { gap: 4, paddingVertical: 4 },
  navButton: {
    width: 68, minHeight: 68, borderRadius: 16, borderWidth: 1, borderColor: "rgba(84,167,255,0.10)",
    backgroundColor: "rgba(12,26,42,0.42)", alignItems: "center", justifyContent: "center", gap: 5, position: "relative",
  },
  compactNavButton: { minHeight: 58, width: 52 },
  shortNavButton: { width: 64, minHeight: 48, minWidth: 48, gap: 3 },
  narrowNavButton: { minHeight: 50, minWidth: 68 },
  navSelected: { borderColor: "rgba(40,213,255,0.65)", backgroundColor: "rgba(40,213,255,0.14)",
    experimental_backgroundImage: "linear-gradient(145deg, rgba(40,213,255,0.22) 0%, rgba(14,52,88,0.34) 100%)",
    boxShadow: "0 4px 16px 0 rgba(40,213,255,0.22), inset 0 1px 0 0 rgba(190,242,255,0.22)" },
  navText: { color: palette.textSecondary, fontSize: 11.5, fontWeight: "500", letterSpacing: 0.3 },
  navTextSelected: { color: palette.presenceCyan, fontWeight: "700" },
  selectionConnector: { position: "absolute", right: -8, width: 8, height: 1, backgroundColor: palette.presenceCyan },
  compactSelectionConnector: { right: undefined, top: 2, width: 1, height: 5 },
  selectionMark: { position: "absolute", right: -7, width: 6, height: 6, borderRadius: 3, backgroundColor: palette.presenceCyan,
    boxShadow: "0 0 10px 2px rgba(40,213,255,0.6)" },
  compactSelectionMark: { right: undefined, top: 2, width: 4, height: 4 },
  pressed: { opacity: 0.72, transform: [{ scale: 0.97 }] },
  railFoot: { height: 28, justifyContent: "center" },
  shortRailFoot: { height: 8 },
  main: { flex: 1, minWidth: 0, backgroundColor: palette.bgRaised, experimental_backgroundImage: "radial-gradient(ellipse at 50% 0%, rgba(28,104,180,0.09) 0%, rgba(7,17,29,0) 72%)", paddingVertical: 6, paddingHorizontal: 12, gap: 6 },
  freshnessBanner: {
    position: "absolute", top: 6, right: 12, zIndex: 35, maxWidth: "100%",
    flexDirection: "row", alignItems: "center", gap: 6, borderRadius: 16,
    backgroundColor: "rgba(31, 27, 20, 0.96)", borderWidth: 1,
    borderColor: "rgba(243, 197, 107, 0.22)", paddingHorizontal: 10, paddingVertical: 4,
  },
  freshnessText: { flexShrink: 1, color: palette.cautionAmber, fontSize: type.timestamp, lineHeight: 18 },
  content: { flex: 1, minHeight: 0 },
  toastPosition: { position: "absolute", top: 8, left: 16, right: 16, zIndex: 40, alignItems: "center" },
  toast: {
    maxWidth: 560, minHeight: 44, flexDirection: "row", alignItems: "center", gap: 10,
    borderRadius: 24, borderWidth: 1, backgroundColor: "rgba(7, 17, 29, 0.96)",
    paddingHorizontal: 18, paddingVertical: 10,
    boxShadow: "0 10px 28px rgba(0, 0, 0, 0.48)",
  },
  toastText: { color: palette.textPrimary, fontSize: type.body, lineHeight: 21, flexShrink: 1 },
});
