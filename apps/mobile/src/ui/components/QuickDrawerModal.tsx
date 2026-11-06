import { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import {
  Animated,
  Modal,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import type { PrivacyEpoch } from "@super-looi/contracts";
import { LOOI_PALETTE } from "../theme.js";
import { LooiIcon, type LooiIconName } from "./LooiIcon.js";

export type QuickDrawerDestination =
  | "memories"
  | "tasks_and_rules"
  | "home"
  | "cabin"
  | "privacy_pause"
  | "sim_lab";

export interface QuickDrawerOverlayProps {
  visible: boolean;
  onClose: () => void;
  onSelect: (destination: QuickDrawerDestination) => void;
  memoryCount?: number;
  taskCount?: number;
  pendingApprovalCount?: number;
  homeStatus?: string;
  verifiedCount?: number;
  verificationStatus?: "running" | "unverified" | "failed";
}

export interface SimLabSheetProps {
  visible: boolean;
  onClose: () => void;
  isDocked: boolean;
  onSpeakingTest: () => void;
  onRememberFrame: () => void;
  onMicroObservation: () => void;
  onToggleDock: () => void;
  onEmergencyStop: () => void;
  onRunAcceptance: () => void;
  acceptanceRunning?: boolean;
}

export interface PrivacyPauseOverlayProps {
  visible: boolean;
  privacyEpoch: PrivacyEpoch;
  /** The owner performs the resume operation and supplies the resulting state. */
  onResume: () => void;
}

export interface ConversationSubtitleOverlayProps {
  visible: boolean;
  text: string;
  mode?: "listening" | "speaking";
}

interface Entry {
  key: string;
  icon: LooiIconName;
  label: string;
  detail?: string;
  onPress: () => void;
  danger?: boolean;
  disabled?: boolean;
  badge?: string;
}

/** Only the quick drawer times out; laboratory controls stay open while in use. */
function useDrawerIdleClose(visible: boolean, onClose: () => void) {
  const interacting = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const close = useRef(onClose);

  useEffect(() => {
    close.current = onClose;
  }, [onClose]);

  const clear = useCallback(() => {
    if (timer.current !== undefined) {
      clearTimeout(timer.current);
      timer.current = undefined;
    }
  }, []);

  const reset = useCallback(() => {
    clear();
    if (visible && !interacting.current) {
      timer.current = setTimeout(() => {
        timer.current = undefined;
        close.current();
      }, 7_500);
    }
  }, [clear, visible]);

  useEffect(() => {
    reset();
    return clear;
  }, [clear, reset]);

  const setInteracting = useCallback((active: boolean) => {
    interacting.current = active;
    reset();
  }, [reset]);

  useEffect(() => { if (!visible) interacting.current = false; }, [visible]);
  return { reset, setInteracting };
}

interface GlassSheetProps {
  visible: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  onInteraction?: () => void;
  onInteractionStateChange?: (active: boolean) => void;
  children: ReactNode;
}

function GlassSheet({
  visible,
  title,
  description,
  onClose,
  onInteraction,
  onInteractionStateChange,
  children,
}: GlassSheetProps) {
  const { width, height } = useWindowDimensions();
  const shortLandscape = width > height && height < 500;
  const translateY = useRef(new Animated.Value(0)).current;
  const closing = useRef(false);
  const callbacks = useRef({ onClose, onInteraction, onInteractionStateChange, height, visible });
  useEffect(() => {
    callbacks.current = { onClose, onInteraction, onInteractionStateChange, height, visible };
  }, [onClose, onInteraction, onInteractionStateChange, height, visible]);
  const animationGeneration = useRef(0);
  useEffect(() => {
    animationGeneration.current += 1;
    translateY.stopAnimation();
    if (visible) translateY.setValue(0);
    closing.current = false;
    return () => {
      animationGeneration.current += 1;
      translateY.stopAnimation();
    };
  }, [translateY, visible]);
  const drag = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_, gesture) => !closing.current && gesture.dy > 10
      && gesture.dy > Math.abs(gesture.dx) * 1.2,
    onPanResponderGrant: () => {
      translateY.stopAnimation();
      callbacks.current.onInteraction?.();
      callbacks.current.onInteractionStateChange?.(true);
    },
    onPanResponderMove: (_, gesture) => translateY.setValue(Math.max(0, gesture.dy)),
    onPanResponderTerminationRequest: () => true,
    onPanResponderTerminate: () => {
      callbacks.current.onInteractionStateChange?.(false);
      Animated.spring(translateY, { toValue: 0, useNativeDriver: true, bounciness: 0 }).start();
    },
    onPanResponderRelease: (_, gesture) => {
      if (gesture.dy > 56 || gesture.vy > 0.55) {
        closing.current = true;
        const generation = animationGeneration.current;
        Animated.timing(translateY, { toValue: callbacks.current.height, duration: 140, useNativeDriver: true }).start(({ finished }) => {
          if (finished && generation === animationGeneration.current && callbacks.current.visible) {
            callbacks.current.onInteractionStateChange?.(false);
            callbacks.current.onClose();
          }
        });
      } else {
        callbacks.current.onInteractionStateChange?.(false);
        Animated.spring(translateY, { toValue: 0, useNativeDriver: true, bounciness: 0 }).start();
      }
    },
  }), [translateY]);
  if (!visible) return null;

  return (
    <Modal
      visible
      transparent
      animationType="fade"
      presentationStyle="overFullScreen"
      supportedOrientations={["portrait", "landscape"]}
      onRequestClose={onClose}
      statusBarTranslucent
      navigationBarTranslucent
    >
      <SafeAreaProvider>
        <View style={styles.modalStage}>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel={`关闭${title}`}
          />
          <SafeAreaView
            style={styles.sheetSafeArea}
            pointerEvents="box-none"
            edges={["top", "left", "right", "bottom"]}
          >
            <Animated.View
              style={[styles.sheet, shortLandscape && styles.shortSheet, { transform: [{ translateY }] }]}
              accessibilityViewIsModal
              onAccessibilityEscape={onClose}
              onTouchStart={() => { onInteraction?.(); onInteractionStateChange?.(true); }}
              onTouchEnd={() => { if (!closing.current) onInteractionStateChange?.(false); onInteraction?.(); }}
              onTouchCancel={() => onInteractionStateChange?.(false)}
            >
              <View pointerEvents="none" style={styles.glassHighlight} />
              <View {...drag.panHandlers}>
                <View style={styles.handleTouchArea}><View pointerEvents="none" style={styles.handle} /></View>
                <View style={[styles.sheetHeader, shortLandscape && styles.shortSheetHeader]}>
                  <View style={[styles.headingCopy, shortLandscape && styles.shortHeadingCopy]}>
                    <Text accessibilityRole="header" style={[styles.title, shortLandscape && styles.shortTitle]}>{title}</Text>
                    {!!description?.trim() && <Text style={[styles.description, shortLandscape && styles.shortDescription]}>{description}</Text>}
                  </View>
                  <Pressable
                    onPress={onClose}
                    onFocus={onInteraction}
                    accessibilityRole="button"
                    accessibilityLabel={`关闭${title}`}
                    hitSlop={10}
                    style={({ pressed }) => [styles.closeTouchTarget, pressed && styles.pressed]}
                  >
                    <View pointerEvents="none" style={[styles.closeButton, shortLandscape && styles.shortCloseButton]}>
                      <LooiIcon name="close" size={21} color={LOOI_PALETTE.textSecondary} />
                    </View>
                  </Pressable>
                </View>
              </View>
              <ScrollView
                keyboardShouldPersistTaps="handled"
                style={styles.sheetScroll}
                contentContainerStyle={[styles.sheetContent, shortLandscape && styles.shortSheetContent]}
                showsVerticalScrollIndicator
                onScroll={onInteraction}
                onScrollBeginDrag={onInteraction}
                onScrollEndDrag={onInteraction}
                onMomentumScrollEnd={onInteraction}
                scrollEventThrottle={100}
              >
                {children}
              </ScrollView>
            </Animated.View>
          </SafeAreaView>
        </View>
      </SafeAreaProvider>
    </Modal>
  );
}

function EntryGrid({ entries, onInteraction, spaces = false }: { entries: Entry[]; onInteraction?: () => void; spaces?: boolean }) {
  const { width, height, fontScale } = useWindowDimensions();
  const landscape = width > height;
  const shortLandscape = landscape && height < 500 && fontScale < 1.3;
  // Larger accessibility text gets a full-width card rather than a clipped grid.
  const columns = fontScale >= 1.3 ? 1 : landscape || width >= 740 ? (spaces ? 4 : 3) : spaces || width >= 460 ? 2 : 1;
  const cardWidth = columns === 4 ? "24%" : columns === 3 ? "31.9%" : columns === 2 ? "49%" : "100%";

  return (
    <View style={styles.entryGrid}>
      {entries.map((entry) => (
        <Pressable
          key={entry.key}
          accessibilityRole="button"
          accessibilityLabel={entry.label}
          accessibilityHint={[entry.badge, entry.detail].filter(Boolean).join("，")}
          accessibilityState={{ disabled: entry.disabled === true }}
          disabled={entry.disabled}
          onFocus={onInteraction}
          onPress={() => {
            onInteraction?.();
            entry.onPress();
          }}
          style={({ pressed }) => [
            styles.entryCard,
            spaces && styles.spaceCard,
            !spaces && styles.labTile,
            shortLandscape && !spaces && styles.shortLabTile,
            shortLandscape && spaces && styles.shortSpaceCard,
            { width: cardWidth },
            entry.danger && styles.dangerCard,
            entry.disabled && styles.disabled,
            pressed && styles.pressed,
          ]}
        >
          <View style={[styles.iconTile, spaces && styles.spaceIconTile, shortLandscape && styles.shortIconTile, entry.danger && styles.dangerIconTile]}>
            <LooiIcon
              name={entry.icon}
              size={shortLandscape ? 20 : 23}
              color={entry.danger ? LOOI_PALETTE.emergencyCoral : spaces ? LOOI_PALETTE.presenceCyan : LOOI_PALETTE.textPrimary}
            />
          </View>
          <View style={[styles.entryCopy, shortLandscape && styles.shortEntryCopy]}>
            <Text style={[styles.entryLabel, shortLandscape && styles.shortEntryLabel, entry.danger && styles.dangerText]}>{entry.label}</Text>
            {entry.badge && (
              <View style={styles.badgeRow}>
                <View style={styles.badgeDot} />
                <Text numberOfLines={1} style={styles.entryBadge}>{entry.badge}</Text>
              </View>
            )}
            {!!entry.detail?.trim() && <Text style={[styles.entryDetail, shortLandscape && styles.shortEntryDetail]}>{entry.detail}</Text>}
          </View>
        </Pressable>
      ))}
    </View>
  );
}

export function QuickDrawerOverlay({
  visible,
  onClose,
  onSelect,
  memoryCount,
  taskCount,
  pendingApprovalCount,
  homeStatus,
  verifiedCount,
  verificationStatus = "unverified",
}: QuickDrawerOverlayProps) {
  const { reset: resetIdle, setInteracting } = useDrawerIdleClose(visible, onClose);
  const select = (destination: QuickDrawerDestination) => () => {
    onClose();
    onSelect(destination);
  };
  const entries: Entry[] = [
    { key: "memories", icon: "book", label: "回忆册", badge: memoryCount === undefined ? "等待记忆" : `${memoryCount} 条记忆`, onPress: select("memories") },
    { key: "tasks_and_rules", icon: "tasks", label: "约定任务", badge: pendingApprovalCount ? `${pendingApprovalCount} 项待批授权` : taskCount === undefined ? "暂无待批" : `${taskCount} 项任务与约定`, onPress: select("tasks_and_rules") },
    { key: "home", icon: "home", label: "书房家居", badge: homeStatus ?? "连接待核实", onPress: select("home") },
    { key: "cabin", icon: "wrench", label: "维修舱", badge: verificationStatus === "running" ? "正在核验" : verifiedCount !== undefined ? `${verifiedCount} 项核验通过` : verificationStatus === "failed" ? "核验未完成" : "尚未核验", onPress: select("cabin") },
  ];
  const utilities: Entry[] = [
    { key: "privacy_pause", icon: "shield", label: "隐私暂停", onPress: select("privacy_pause") },
    { key: "sim_lab", icon: "sparkles", label: "仿真演练台", onPress: select("sim_lab") },
  ];

  return (
    <GlassSheet
      visible={visible}
      title="想一起做什么"
      onClose={onClose}
      onInteraction={resetIdle}
      onInteractionStateChange={setInteracting}
    >
      <EntryGrid entries={entries} onInteraction={resetIdle} spaces />
      <View style={styles.utilities}>
        {utilities.map((entry) => <Pressable key={entry.key} accessibilityRole="button" accessibilityLabel={entry.key === "sim_lab" ? `${entry.label} LAB` : entry.label}
          onFocus={resetIdle} onPress={() => { resetIdle(); entry.onPress(); }}
          style={({ pressed }) => [styles.utility, pressed && styles.pressed]}>
          <LooiIcon name={entry.icon} size={17} color={LOOI_PALETTE.textSecondary} />
          <Text style={styles.utilityLabel}>{entry.label}</Text>
          {entry.key === "sim_lab" && <Text style={styles.labTag}>LAB</Text>}
        </Pressable>)}
      </View>
    </GlassSheet>
  );
}

export function SimLabSheet({
  visible,
  onClose,
  isDocked,
  onSpeakingTest,
  onRememberFrame,
  onMicroObservation,
  onToggleDock,
  onEmergencyStop,
  onRunAcceptance,
  acceptanceRunning = false,
}: SimLabSheetProps) {
  const entries: Entry[] = [
    { key: "speaking", icon: "mic", label: "说话中测试", onPress: onSpeakingTest },
    { key: "remember", icon: "camera", label: "记当前画面", onPress: onRememberFrame },
    { key: "observe", icon: "radar", label: "主动微观察", onPress: onMicroObservation },
    { key: "dock", icon: isDocked ? "undock" : "dock", label: isDocked ? "拔下手机" : "放回底座", onPress: onToggleDock },
    { key: "stop", icon: "stop", label: "触发急停", onPress: onEmergencyStop, danger: true },
    { key: "acceptance", icon: "check", label: acceptanceRunning ? "验收运行中" : "运行48项验收", onPress: onRunAcceptance, disabled: acceptanceRunning },
  ];

  return (
    <GlassSheet
      visible={visible}
      title="仿真演练台"
      onClose={onClose}
    >
      <EntryGrid entries={entries} />
    </GlassSheet>
  );
}

// Closing a privacy panel must never silently restart sensing. Only the explicit
// resume button delegates that operation to the state/hardware owner.
const keepPrivacyPaused = () => undefined;

export function PrivacyPauseOverlay({ visible, privacyEpoch, onResume }: PrivacyPauseOverlayProps) {
  if (!visible) return null;
  const cameraOff = privacyEpoch.camera === "off";
  const microphoneOff = privacyEpoch.microphone === "off";
  const sensorsOff = cameraOff && microphoneOff;
  const bufferCleared = privacyEpoch.local_buffer_state === "cleared";
  const bufferLabel = bufferCleared
    ? "本地缓冲已清空"
    : privacyEpoch.local_buffer_state === "clearing"
      ? "本地缓冲正在清理"
      : "本地缓冲状态：不适用";

  return (
    <Modal
      visible
      animationType="fade"
      presentationStyle="fullScreen"
      supportedOrientations={["portrait", "landscape"]}
      onRequestClose={keepPrivacyPaused}
    >
      <SafeAreaProvider>
        <SafeAreaView style={styles.privacyStage}>
          <ScrollView contentContainerStyle={styles.privacyScroll}>
            <View style={styles.privacyCard} accessibilityViewIsModal>
              <View pointerEvents="none" style={styles.glassHighlight} />
              <View style={styles.sleepingMark} accessible={false}>
                <View style={styles.sleepingEye} />
                <View style={styles.sleepingEye} />
              </View>
              <View style={styles.privacyHeading}>
                <LooiIcon name="shield" size={26} color={LOOI_PALETTE.textSecondary} />
                <Text accessibilityRole="header" style={styles.title}>
                  {sensorsOff ? "隐私暂停，安心休眠" : "隐私暂停待确认"}
                </Text>
              </View>
              <Text style={styles.privacyDescription}>
                {sensorsOff ? "已切断镜头与麦克风" : "正在等待镜头与麦克风关闭确认"}
              </Text>
              <View style={styles.privacyStatusList}>
                <PrivacyStatus icon="camera" text={cameraOff ? "镜头已关闭" : "镜头仍开启"} pending={!cameraOff} />
                <PrivacyStatus icon="mic" text={microphoneOff ? "麦克风已关闭" : "麦克风仍开启"} pending={!microphoneOff} />
                <PrivacyStatus icon="shield" text={`PrivacyEpoch 隐私纪元 ${privacyEpoch.capture_epoch}`} />
                <PrivacyStatus icon="box" text={bufferLabel} pending={privacyEpoch.local_buffer_state === "clearing"} />
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="轻触屏幕恢复感知"
                accessibilityHint="请求恢复镜头与麦克风的感知"
                onPress={onResume}
                style={({ pressed }) => [styles.resumeButton, pressed && styles.pressed]}
              >
                <LooiIcon name="play" size={21} color={LOOI_PALETTE.textPrimary} />
                <Text style={styles.resumeLabel}>轻触屏幕恢复感知</Text>
              </Pressable>
            </View>
          </ScrollView>
        </SafeAreaView>
      </SafeAreaProvider>
    </Modal>
  );
}

function PrivacyStatus({ icon, text, pending = false }: { icon: LooiIconName; text: string; pending?: boolean }) {
  return (
    <View style={styles.privacyStatus}>
      <LooiIcon name={icon} size={20} color={pending ? LOOI_PALETTE.cautionAmber : LOOI_PALETTE.textSecondary} />
      <Text style={[styles.privacyStatusText, pending && styles.pendingText]}>{text}</Text>
    </View>
  );
}

export function ConversationSubtitleOverlay({ visible, text, mode = "listening" }: ConversationSubtitleOverlayProps) {
  if (!visible || !text.trim()) return null;

  return (
    <SafeAreaView
      pointerEvents="none"
      edges={["left", "right", "bottom"]}
      style={styles.subtitleSafeArea}
    >
      <View style={styles.subtitleCapsule}>
        <View pointerEvents="none" style={styles.glassHighlight} />
        <LooiIcon name="mic" size={21} color={LOOI_PALETTE.presenceCyan} />
        <Text
          style={styles.subtitleText}
          numberOfLines={2}
          ellipsizeMode="tail"
          accessibilityLabel={`${mode === "listening" ? "正在聆听" : "LOOI 正在说"}：${text}`}
          accessibilityLiveRegion="polite"
        >
          {text}
        </Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  modalStage: { flex: 1, backgroundColor: "rgba(3, 7, 13, 0.10)" },
  sheetSafeArea: { flex: 1, justifyContent: "flex-end", padding: 12, alignItems: "center" },
  sheet: {
    width: "100%", maxWidth: 980, maxHeight: "76%", flexShrink: 1,
    borderRadius: 28, borderWidth: 1, borderColor: LOOI_PALETTE.lineSubtle,
    backgroundColor: LOOI_PALETTE.surfaceGlass, overflow: "hidden",
    shadowColor: LOOI_PALETTE.bgDeep, shadowOpacity: 0.5, shadowRadius: 24,
    shadowOffset: { width: 0, height: 10 }, elevation: 20,
  },
  shortSheet: { paddingHorizontal: 18, paddingTop: 4, paddingBottom: 10, maxHeight: "100%" },
  shortHeadingCopy: { flexDirection: "row", alignItems: "center", gap: 10 },
  shortTitle: { fontSize: 18 },
  shortDescription: { fontSize: 10, lineHeight: 14, flex: 1 },
  shortCloseButton: { width: 32, height: 32, minHeight: 32, borderRadius: 16 },
  shortSpaceCard: { minHeight: 72, flexDirection: "row", alignItems: "center", paddingHorizontal: 10, paddingVertical: 10, gap: 8 },
  shortIconTile: { width: 38, height: 38, borderRadius: 12 },
  shortEntryLabel: { fontSize: 15, fontWeight: "700" },
  shortEntryDetail: { fontSize: 9.5, lineHeight: 13, letterSpacing: -0.2 },
  shortSheetHeader: { minHeight: 44, paddingHorizontal: 0, paddingTop: 0, paddingBottom: 4, alignItems: "center" },
  shortSheetContent: { paddingHorizontal: 0, paddingBottom: 0 },
  glassHighlight: {
    position: "absolute", left: 22, right: 22, top: 0, height: 1,
    backgroundColor: LOOI_PALETTE.lineActive, opacity: 0.45,
  },
  handleTouchArea: { minHeight: 20, alignItems: "center", justifyContent: "center" },
  handle: { width: 44, height: 5, borderRadius: 3, backgroundColor: LOOI_PALETTE.textMuted, opacity: 0.55, alignSelf: "center" },
  sheetHeader: { flexDirection: "row", alignItems: "flex-start", gap: 12, paddingHorizontal: 20, paddingTop: 12, paddingBottom: 16 },
  headingCopy: { flex: 1, gap: 6 },
  title: { fontSize: 24, fontWeight: "700", color: LOOI_PALETTE.textPrimary },
  description: { fontSize: 14, lineHeight: 21, color: LOOI_PALETTE.textSecondary },
  closeTouchTarget: { width: 44, minHeight: 44, alignItems: "center", justifyContent: "center" },
  closeButton: { width: 44, minHeight: 44, borderRadius: 22, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: LOOI_PALETTE.lineSubtle, backgroundColor: LOOI_PALETTE.surfaceElevated },
  sheetScroll: { flexShrink: 1 },
  sheetContent: { paddingHorizontal: 20, paddingBottom: 20 },
  entryGrid: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", rowGap: 10 },
  entryCard: { minHeight: 84, padding: 12, flexDirection: "row", alignItems: "center", gap: 11, borderRadius: 18, borderWidth: 1, borderColor: LOOI_PALETTE.lineSubtle, backgroundColor: LOOI_PALETTE.surfaceElevated, experimental_backgroundImage: "linear-gradient(145deg, rgba(22, 48, 74, 0.42) 0%, rgba(10, 22, 36, 0.88) 100%)" },
  labTile: { minHeight: 74 },
  shortLabTile: { minHeight: 54, paddingHorizontal: 12, paddingVertical: 8 },
  shortEntryCopy: { gap: 4 },
  spaceCard: { minHeight: 98, padding: 12, flexDirection: "column", alignItems: "flex-start", gap: 6, borderColor: "rgba(40, 213, 255, 0.28)", experimental_backgroundImage: "linear-gradient(145deg, rgba(28, 86, 128, 0.34) 0%, rgba(7, 18, 30, 0.86) 100%)", boxShadow: "0 6px 18px 0 rgba(0, 0, 0, 0.26), inset 0 1px 0 0 rgba(164, 224, 255, 0.14)" },
  badgeRow: { flexDirection: "row", alignItems: "center", gap: 5 },
  badgeDot: { width: 5, height: 5, borderRadius: 3, backgroundColor: LOOI_PALETTE.presenceCyan, boxShadow: "0 0 6px rgba(40, 213, 255, 0.7)" },
  entryBadge: { color: LOOI_PALETTE.presenceCyan, fontSize: 12, lineHeight: 16, fontWeight: "500", flexShrink: 1 },
  utilities: { flexDirection: "row", gap: 10, marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: LOOI_PALETTE.lineSubtle },
  utility: { minHeight: 44, minWidth: 44, flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", paddingHorizontal: 12, gap: 7, borderRadius: 22, borderWidth: 1, borderColor: "rgba(84, 167, 255, 0.18)", backgroundColor: "rgba(14, 28, 44, 0.65)" },
  utilityLabel: { flexShrink: 1, textAlign: "center", color: LOOI_PALETTE.textPrimary, fontSize: 13, fontWeight: "500" },
  labTag: { color: LOOI_PALETTE.presenceCyan, fontSize: 10, fontWeight: "700", letterSpacing: 1, paddingHorizontal: 6, paddingVertical: 1, borderRadius: 5, backgroundColor: "rgba(40, 213, 255, 0.14)" },
  iconTile: { width: 42, height: 42, borderRadius: 13, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(8, 20, 34, 0.85)", borderWidth: 1, borderColor: LOOI_PALETTE.lineSubtle },
  spaceIconTile: { borderColor: "rgba(40, 213, 255, 0.30)", backgroundColor: "rgba(14, 42, 68, 0.65)" },
  entryCopy: { flex: 1, gap: 5 },
  entryLabel: { color: LOOI_PALETTE.textPrimary, fontSize: 17, fontWeight: "600" },
  entryDetail: { color: LOOI_PALETTE.textSecondary, fontSize: 13, lineHeight: 19 },
  dangerCard: { borderColor: LOOI_PALETTE.emergencyCoral, backgroundColor: "rgba(80, 35, 38, 0.72)" },
  dangerIconTile: { borderColor: LOOI_PALETTE.emergencyCoral },
  dangerText: { color: LOOI_PALETTE.emergencyCoral },
  pressed: { opacity: 0.78, transform: [{ scale: 0.97 }] },
  disabled: { opacity: 0.5 },
  privacyStage: { flex: 1, backgroundColor: LOOI_PALETTE.bgDeep },
  privacyScroll: { flexGrow: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  privacyCard: { width: "100%", maxWidth: 560, borderRadius: 30, borderWidth: 1, borderColor: LOOI_PALETTE.lineSubtle, backgroundColor: LOOI_PALETTE.surfaceGlass, padding: 24, overflow: "hidden" },
  sleepingMark: { flexDirection: "row", alignSelf: "center", gap: 55, paddingVertical: 16, marginBottom: 14 },
  sleepingEye: { width: 48, height: 4, borderRadius: 2, backgroundColor: LOOI_PALETTE.presenceCyan, opacity: 0.4 },
  privacyHeading: { flexDirection: "row", alignItems: "center", justifyContent: "center", flexWrap: "wrap", gap: 10 },
  privacyDescription: { color: LOOI_PALETTE.textSecondary, textAlign: "center", fontSize: 15, lineHeight: 23, marginTop: 10 },
  privacyStatusList: { marginVertical: 24, gap: 16 },
  privacyStatus: { flexDirection: "row", alignItems: "center", gap: 12 },
  privacyStatusText: { flex: 1, fontSize: 15, lineHeight: 22, color: LOOI_PALETTE.textSecondary },
  pendingText: { color: LOOI_PALETTE.cautionAmber },
  resumeButton: { minHeight: 58, padding: 14, gap: 10, flexDirection: "row", alignItems: "center", justifyContent: "center", borderRadius: 20, borderWidth: 1, borderColor: LOOI_PALETTE.lineActive, backgroundColor: LOOI_PALETTE.surfaceElevated },
  resumeLabel: { flexShrink: 1, fontSize: 17, fontWeight: "600", color: LOOI_PALETTE.textPrimary, textAlign: "center" },
  subtitleSafeArea: { position: "absolute", bottom: 16, left: 16, right: 16, alignItems: "center" },
  subtitleCapsule: { width: "100%", maxWidth: 720, minHeight: 54, paddingHorizontal: 20, paddingVertical: 14, flexDirection: "row", alignItems: "center", gap: 12, borderRadius: 28, overflow: "hidden", borderWidth: 1, borderColor: LOOI_PALETTE.lineSubtle, backgroundColor: LOOI_PALETTE.surfaceGlass },
  subtitleText: { flex: 1, fontSize: 17, fontWeight: "500", lineHeight: 25, color: LOOI_PALETTE.textPrimary },
});
