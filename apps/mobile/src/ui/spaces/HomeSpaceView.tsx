import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { Pressable as NativePressable, ScrollView, StyleSheet, Text, View, useWindowDimensions, type PressableProps } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { CabinSpaceController } from "../cabin-space.js";
import { StudyHomeDemo, type StudyDeviceId, type StudyRuleProposal } from "../home-demo.js";
import { LooiIcon, type LooiIconName } from "../components/LooiIcon.js";
import { LOOI_PALETTE as P } from "../theme.js";
import { ToggleSwitch } from "../components/ToggleSwitch.js";
import { BrightnessSliderBar } from "../components/BrightnessSliderBar.js";
import { ConnectedHomeSpaceView } from "./ConnectedHomeSpaceView.js";

export interface HomeSpaceViewProps {
  hubOrigin?: string;
  controller: CabinSpaceController;
  onNotify?: (message: string) => void;
}

const homeModels = new WeakMap<CabinSpaceController, StudyHomeDemo>();
function Pressable({ style, ...props }: PressableProps): ReactElement {
  return <NativePressable {...props} style={(state) => [typeof style === "function" ? style(state) : style, state.pressed && { opacity: 0.76, transform: [{ scale: 0.985 }] }]} />;
}
const temperaturePresets = [
  { value: 3000, label: "3000K 暖黄", color: "#FFB347" },
  { value: 4000, label: "4000K 自然白", color: "#FFF4E0" },
  { value: 5500, label: "5500K 清冷光", color: "#8CE0FF" },
];

function clock(timestamp: string): string {
  return new Date(timestamp).toLocaleTimeString("zh-CN", { hour12: false });
}

export function HomeSpaceView(props: HomeSpaceViewProps): ReactElement {
  return props.hubOrigin ? <ConnectedHomeSpaceView {...props} hubOrigin={props.hubOrigin} /> : <DemoHomeSpaceView {...props} />;
}

function DemoHomeSpaceView({ controller, onNotify }: HomeSpaceViewProps): ReactElement {
  const insets = useSafeAreaInsets();
  const [resetRevision, setResetRevision] = useState(0);
  const [sliderDragging, setSliderDragging] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  const [feedbackRevision, setFeedbackRevision] = useState(0);
  const [activeFeedback, setActiveFeedback] = useState<"conflict" | "gate" | "proposal" | null>(null);
  const feedbackScrollPending = useRef<"conflict" | "gate" | "proposal" | null>(null);
  const feedbackPositions = useRef<Partial<Record<"conflict" | "gate" | "proposal", number>>>({});
  const feedbackFrame = useRef<number | null>(null);
  function revealFeedback() {
    const target = feedbackScrollPending.current;
    if (!target || feedbackPositions.current[target] === undefined) return;
    if (feedbackFrame.current !== null) cancelAnimationFrame(feedbackFrame.current);
    feedbackFrame.current = requestAnimationFrame(() => {
      const y = feedbackPositions.current[target];
      if (feedbackScrollPending.current === target && y !== undefined) {
        scrollRef.current?.scrollTo({ y: Math.max(0, y - 8), animated: true });
        feedbackScrollPending.current = null;
      }
      feedbackFrame.current = null;
    });
  }
  function feedbackDidLayout(kind: "conflict" | "gate" | "proposal", y: number) {
    feedbackPositions.current[kind] = y;
    if (feedbackScrollPending.current === kind) revealFeedback();
  }
  function requestFeedbackScroll(kind: "conflict" | "gate" | "proposal") {
    feedbackScrollPending.current = kind;
    setActiveFeedback(kind);
    setFeedbackRevision((revision) => revision + 1);
  }
  useEffect(() => {
    if (feedbackRevision > 0) revealFeedback();
  }, [feedbackRevision]);
  useEffect(() => () => {
    if (feedbackFrame.current !== null) cancelAnimationFrame(feedbackFrame.current);
  }, []);
  const model = useMemo(() => homeModels.get(controller) ?? new StudyHomeDemo(), [controller, resetRevision]);
  useEffect(() => {
    homeModels.set(controller, model);
  }, [controller, model]);
  const [, refresh] = useState(0);
  const [pending, setPending] = useState<StudyDeviceId[]>([]);
  const [unverified, setUnverified] = useState<StudyDeviceId[]>([]);
  const [verified, setVerified] = useState<StudyDeviceId[]>([]);
  const inFlight = useRef(new Set<StudyDeviceId>());
  const [conflict, setConflict] = useState<string | null>(null);
  const [gateResult, setGateResult] = useState<string | null>(null);
  const [proposal, setProposal] = useState<StudyRuleProposal | null>(model.getProposal());
  const { width, height, fontScale } = useWindowDimensions();
  const short = width >= 700 && height < 480 && fontScale < 1.3;
  const compact = width < 660;
  const online = controller.getSubsystems().homeAssistant.status === "connected";
  useEffect(() => {
    model.setHealthy(online);
  }, [model, online]);

  async function execute(entityId: StudyDeviceId, target: { on?: boolean; brightness?: number; kelvin?: number }) {
    if (inFlight.current.has(entityId)) return;
    inFlight.current.add(entityId);
    model.setHealthy(controller.getSubsystems().homeAssistant.status === "connected");
    setPending((items) => [...items, entityId]);
    const result = await model.execute(entityId, target);
    inFlight.current.delete(entityId);
    setPending((items) => items.filter((item) => item !== entityId));
    setVerified((items) => result.status === "verified" ? [...items.filter((item) => item !== entityId), entityId] : items.filter((item) => item !== entityId));
    setUnverified((items) => result.status === "verified" ? items.filter((item) => item !== entityId) : [...items.filter((item) => item !== entityId), entityId]);
    refresh((value) => value + 1);
    onNotify?.(result.status === "verified" ? "本地家居演示已回读目标状态" : `未确认设备状态: ${result.reason}`);
  }

  // Keep each result available through its top action, but show only the latest banner.
  const feedbackKind = activeFeedback === "conflict" && conflict ? "conflict"
    : activeFeedback === "gate" && gateResult ? "gate"
    : proposal && proposal.status !== "dismissed" ? "proposal"
    : gateResult ? "gate" : conflict ? "conflict" : null;

  function deviceCard(entityId: StudyDeviceId, title: string, icon: LooiIconName) {
    const state = model.getSnapshot(entityId);
    const isPending = pending.includes(entityId);
    const uncertain = !online || unverified.includes(entityId);
    const isLight = entityId.startsWith("light.");
    const readback = verified.includes(entityId) && !uncertain && !isPending;
    const status = !online ? "离线待核实" : isPending ? "等待回读" : uncertain ? "结果待核实" : state.on ? "已开启" : "已关闭";
    const snapshotLabel = !online ? "演示快照 · 待核实" : isPending ? "演示快照 · 待回读" : uncertain ? "演示快照 · 待核实" : readback ? "演示已回读" : "演示快照";
    const statusColor = uncertain ? P.alertCoral : isPending ? P.amberWarning : state.on ? P.confirmGreen : P.textSecondary;
    return <View key={entityId} style={[styles.card, compact && styles.cardCompact, short && styles.shortCard, state.on && !uncertain && !isPending && styles.cardOn]}>
      <View style={styles.deviceHeader}>
        <View style={[styles.deviceIconBox, state.on && !uncertain && styles.deviceIconBoxOn]}>
          <LooiIcon name={icon} color={uncertain ? P.textSecondary : state.on ? P.presenceCyan : P.textSecondary} size={short ? 17 : 20} />
        </View>
        <View style={styles.deviceHeading}>
          <Text numberOfLines={1} style={[styles.cardTitle, short && styles.shortCardTitle]}>{title}</Text>
        </View>
        <View style={[styles.statusPill, state.on && !uncertain && !isPending && styles.statusPillOn]}>
          <Text style={[styles.deviceStatus, { color: statusColor }]}>{status}</Text>
        </View>
        <ToggleSwitch compact value={state.on} disabled={!online || isPending} pending={isPending || uncertain} label={`${title}开关`} onValueChange={(on) => void execute(entityId, { on })} />
      </View>
      {isLight && <BrightnessSliderBar onDragStateChange={setSliderDragging} compact={short} inactive={!state.on} value={state.brightness} disabled={!online || isPending} label={`${title}亮度`} onChange={(brightness) => void execute(entityId, { on: true, brightness })} />}
      {entityId === "light.study_ceiling" && <View style={[styles.presets, short && styles.shortPresets]}>
        {temperaturePresets.map((preset) => <Pressable
          hitSlop={{ top: 4, bottom: 4 }}
          key={preset.value}
          accessibilityRole="button"
          accessibilityLabel={preset.label}
          accessibilityState={{ selected: state.kelvin === preset.value, disabled: !online || isPending }}
          disabled={!online || isPending}
          onPress={() => void execute(entityId, { on: true, kelvin: preset.value })}
          style={[styles.preset, short && styles.shortPreset, state.kelvin === preset.value && styles.presetActive, (!online || isPending) && styles.disabled]}
        ><View style={[styles.temperatureDot, { backgroundColor: preset.color }]} /><Text style={[styles.presetText, state.kelvin === preset.value && styles.presetTextActive]}>{preset.value}K</Text></Pressable>)}
      </View>}
      {entityId === "light.study_desk" && <View style={[styles.deskFooter, short && styles.shortDeskFooter]}>
        <View style={styles.deskModePill}>
          <View style={[styles.temperatureDot, { backgroundColor: "#FFF4E0" }]} />
          <Text style={styles.deskModeText}>阅读暖白</Text>
        </View>
        <View style={styles.deskTelemetryPill}>
          <Text numberOfLines={1} style={styles.timestamp}>{snapshotLabel} · {clock(state.updatedAt)} · {state.brightness}/255</Text>
        </View>
      </View>}
      {!isLight && <View style={styles.deviceFooter}>
        <View style={styles.airflowArtwork} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          {[0, 1, 2].map((index) => <View key={index} style={[styles.airflowLine, { width: `${100 - index * 18}%`, opacity: state.on && !uncertain && !isPending ? 0.9 - index * 0.22 : 0.25 }]} />)}
        </View>
        <Text numberOfLines={1} style={styles.timestamp}>空气循环 · {snapshotLabel} · {clock(state.updatedAt)}</Text>
      </View>}
    </View>;
  }

  return <ScrollView ref={scrollRef} scrollEnabled={!sliderDragging} keyboardShouldPersistTaps="handled" onContentSizeChange={revealFeedback} style={styles.root} contentContainerStyle={[styles.content, short && styles.shortContent, { paddingBottom: short ? Math.max(6, insets.bottom) : Math.max(16, insets.bottom + 6) }]} showsVerticalScrollIndicator={false}>
    <View style={[styles.statusBar, short && styles.shortStatusBar]}>
      <View style={styles.statusLeft}>
        <View style={[styles.gatewayDot, { backgroundColor: online ? P.confirmGreen : P.alertCoral }]} />
        <Text style={styles.statusBarText}>书房家居 · 网关{online ? "在线" : "离线"}</Text>
      </View>
      <View style={styles.topActions}>
        <Pressable hitSlop={{ top: 4, bottom: 4 }} accessibilityRole="button" accessibilityLabel="物理与视觉冲突诚实调和演示" style={styles.actionPill} onPress={() => {
          if (!online) { onNotify?.("网关离线，无法用旧快照调和当前物理状态"); return; }
          setConflict(model.reconcile().explanation); requestFeedbackScroll("conflict"); onNotify?.("冲突证据已分别保留，以设备回读裁定开关状态");
        }}><Text style={styles.actionText}>冲突调和</Text></Pressable>
        <Pressable hitSlop={{ top: 4, bottom: 4 }} accessibilityRole="button" accessibilityLabel="记录第3次微调并生成规则晋升提案" style={styles.actionPill} onPress={() => { const nextProposal = model.recordThirdAdjustment(); setProposal(nextProposal); if (nextProposal) requestFeedbackScroll("proposal"); onNotify?.("第 3 次微调已记录，仅生成待确认提案"); }}><Text style={styles.actionText}>微调提案</Text></Pressable>
        <Pressable hitSlop={{ top: 4, bottom: 4 }} accessibilityRole="button" accessibilityLabel="测试高危门锁域拦截" style={styles.actionPill} onPress={() => {
          void model.execute("lock.front_door", { on: false }).then((result) => {
            const message = result.status === "rejected" ? "门锁已在发送前拦截 · 未下发命令" : "门锁结果待核实 · 未确认完成";
            setGateResult(message); requestFeedbackScroll("gate"); onNotify?.("高危门锁域已拦截，没有下发命令");
          });
        }}><Text style={styles.actionText}>门锁拦截</Text></Pressable>
        <Pressable hitSlop={{ top: 4, bottom: 4 }} accessibilityRole="button" disabled={pending.length > 0} accessibilityState={{ disabled: pending.length > 0 }} style={styles.resetPill} onPress={() => {
          homeModels.set(controller, new StudyHomeDemo()); setResetRevision((value) => value + 1);
          setVerified([]); setUnverified([]); setConflict(null); setGateResult(null); setProposal(null); setActiveFeedback(null);
          feedbackScrollPending.current = null; feedbackPositions.current = {};
          onNotify?.("已重置本地家居演示状态，未操作真实硬件");
        }}><Text style={styles.resetText}>重置演示状态</Text></Pressable>
      </View>
    </View>
    {feedbackKind && <View key={feedbackKind} onLayout={({ nativeEvent }) => {
      if (feedbackKind === "conflict") feedbackDidLayout("conflict", nativeEvent.layout.y);
      if (feedbackKind === "gate") feedbackDidLayout("gate", nativeEvent.layout.y);
      if (feedbackKind === "proposal") feedbackDidLayout("proposal", nativeEvent.layout.y);
    }} style={[styles.feedbackBar, compact && styles.stackedFeedback, feedbackKind === "proposal" && proposal?.status === "confirmed" && styles.confirmedProposal]} accessibilityLiveRegion="polite">
      {feedbackKind === "conflict" && <Text accessibilityLabel={conflict ?? undefined} numberOfLines={2} style={styles.feedbackText}>演示 · 视觉{conflict?.includes("画面偏暗") ? "偏暗" : "明亮"} / 回读{conflict?.includes("回读为开启") ? "开启" : "关闭"}；开关按回读，环境量按传感器。</Text>}
      {feedbackKind === "gate" && <Text numberOfLines={2} style={styles.feedbackText}>{gateResult}</Text>}
      {feedbackKind === "proposal" && proposal && <>
        <Text numberOfLines={short ? 2 : undefined} style={styles.feedbackText}>{proposal.status === "confirmed" ? "本地演示规则已确认" : `${proposal.count} 次微调 · 待确认`} · 晚读吸顶灯 {proposal.kelvin}K · {proposal.brightness}/255 · 仅本地演示</Text>
        {proposal.status === "proposed" && <View style={styles.confirmActions}>
          <Pressable accessibilityRole="button" style={[styles.confirmAction, styles.confirmPrimary]} onPress={() => { setProposal(model.confirmProposal(`user_confirm_${Date.now()}`)); onNotify?.("已通过你的显式点击确认本地规则"); }}><Text style={styles.actionText}>确认设为规则</Text></Pressable>
          <Pressable accessibilityRole="button" style={styles.confirmAction} onPress={() => { model.dismissProposal(); setProposal(model.getProposal()); }}><Text style={styles.actionText}>暂不启用</Text></Pressable>
        </View>}
      </>}
    </View>}
    <View style={[styles.grid, short && styles.shortGrid]}>
      {deviceCard("light.study_ceiling", "书房吸顶灯", "sun")}
      {deviceCard("light.study_desk", "书房台灯", "lamp")}
      {deviceCard("fan.study_fresh_air", "书房新风", "wind")}
      <View style={[styles.card, compact && styles.cardCompact, short && styles.shortCard]}>
        <View style={styles.sensorHeader}>
          <View style={[styles.deviceIconBox, styles.deviceIconBoxOn]}>
            <LooiIcon name="sensor" color={P.presenceCyan} size={short ? 17 : 20} />
          </View>
          <Text numberOfLines={1} style={[styles.cardTitle, short && styles.shortCardTitle]}>环境传感器</Text>
          <Text style={styles.sensorSource}>{online ? "实测采样 · 演示" : "离线 · 待核实"} · {clock(model.sensorUpdatedAt)}</Text>
        </View>
        <View style={styles.sensorReadings}>
          {[{ value: "23.8°C", label: "温度" }, { value: "48%", label: "湿度" }, { value: "612ppm", label: "CO₂" }].map((metric) => <View key={metric.label} style={styles.metricPill}>
            <Text style={styles.metricValue}>{online ? metric.value : "待核实"}</Text><Text style={styles.metricLabel}>{metric.label}</Text>
          </View>)}
        </View>
      </View>
    </View>
  </ScrollView>;
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: 16, gap: 10 },
  shortContent: { padding: 0, gap: 6 },
  statusBar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", minHeight: 44, paddingHorizontal: 12, paddingVertical: 0, borderRadius: 14, borderWidth: 1, borderColor: P.lineSubtle, backgroundColor: P.surfaceGlass, gap: 8 },
  shortStatusBar: { paddingVertical: 0, paddingHorizontal: 10, backgroundColor: "rgba(10, 22, 36, 0.65)", minHeight: 44, flexWrap: "nowrap" },
  statusLeft: { flexDirection: "row", alignItems: "center", gap: 8 },
  gatewayDot: { width: 7, height: 7, borderRadius: 4, boxShadow: "0 0 8px rgba(74, 222, 128, 0.6)" },
  statusBarText: { color: P.textPrimary, fontSize: 12.5, fontWeight: "600" },
  topActions: { flexDirection: "row", alignItems: "center", minHeight: 44, paddingVertical: 4, gap: 6 },
  actionPill: { minHeight: 36, justifyContent: "center", paddingHorizontal: 10, borderRadius: 9, borderWidth: 1, borderColor: "rgba(84,167,255,0.18)", backgroundColor: P.surfaceElevated },
  resetPill: { minHeight: 36, justifyContent: "center", paddingHorizontal: 10, borderRadius: 9, borderWidth: 1, borderColor: "rgba(40,213,255,0.32)", backgroundColor: "rgba(40,213,255,0.08)" },
  resetText: { color: P.presenceCyan, fontSize: 11, fontWeight: "600" },
  actionText: { color: P.textPrimary, fontSize: 11, fontWeight: "500" },
  feedbackBar: { flexDirection: "row", alignItems: "center", paddingVertical: 6, paddingHorizontal: 10, gap: 6, borderRadius: 10, borderWidth: 1, borderColor: "rgba(243,197,107,0.25)", backgroundColor: "rgba(243,197,107,0.05)" },
  stackedFeedback: { flexDirection: "column", alignItems: "stretch" },
  feedbackText: { flexShrink: 1, color: P.textSecondary, fontSize: 11, lineHeight: 16 },
  confirmActions: { flexDirection: "row", gap: 6 },
  confirmAction: { minHeight: 44, justifyContent: "center", paddingHorizontal: 8, borderRadius: 8, borderWidth: 1, borderColor: P.lineSubtle },
  confirmPrimary: { borderColor: "rgba(74,222,128,0.4)", backgroundColor: "rgba(74,222,128,0.10)" },
  confirmedProposal: { borderColor: "rgba(74,222,128,0.4)" },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  shortGrid: { gap: 8 },
  card: { flexBasis: "48%", flexGrow: 1, minWidth: 0, borderWidth: 1, borderColor: P.lineSubtle, borderRadius: 16, backgroundColor: P.surfaceGlass, padding: 12, gap: 6 },
  cardCompact: { flexBasis: "100%" },
  shortCard: { padding: 9, gap: 4, borderRadius: 15 },
  deviceHeader: { flexDirection: "row", alignItems: "center", minHeight: 40, gap: 7 },
  deviceIconBox: { width: 30, height: 30, borderRadius: 9, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(12, 26, 42, 0.75)", borderWidth: 1, borderColor: "rgba(84, 167, 255, 0.16)" },
  deviceIconBoxOn: { borderColor: "rgba(40, 213, 255, 0.35)", backgroundColor: "rgba(40, 213, 255, 0.10)" },
  deviceHeading: { flex: 1, minWidth: 0, gap: 2 },
  cardTitle: { minWidth: 0, color: P.textPrimary, fontWeight: "700", fontSize: 14 },
  shortCardTitle: { fontSize: 13 },
  statusPill: { borderRadius: 8, paddingHorizontal: 7, paddingVertical: 3, borderWidth: 1, borderColor: "rgba(148,163,184,0.16)", backgroundColor: "rgba(15, 28, 42, 0.65)" },
  statusPillOn: { borderColor: "rgba(74,222,128,0.28)", backgroundColor: "rgba(74,222,128,0.08)" },
  deviceStatus: { fontSize: 10, fontWeight: "600" },
  presets: { flexDirection: "row", gap: 8, minHeight: 44, paddingVertical: 4 },
  shortPresets: { minHeight: 44, gap: 6, paddingVertical: 4 },
  preset: { minHeight: 44, flex: 1, flexDirection: "row", gap: 5, justifyContent: "center", alignItems: "center", paddingHorizontal: 6, borderRadius: 9, borderWidth: 1, borderColor: P.lineSubtle, backgroundColor: "rgba(9,21,31,0.8)" },
  shortPreset: { minHeight: 36, borderRadius: 8 },
  presetActive: { borderColor: P.presenceCyan, backgroundColor: "rgba(40,213,255,0.14)" },
  presetText: { color: P.textSecondary, fontSize: 11, fontWeight: "500" },
  presetTextActive: { color: P.textPrimary, fontWeight: "700" },
  temperatureDot: { width: 7, height: 7, borderRadius: 4 },
  disabled: { opacity: 0.42 },
  cardOn: { borderColor: "rgba(40,213,255,0.30)", experimental_backgroundImage: "linear-gradient(135deg, rgba(36, 98, 132, 0.22) 0%, rgba(7, 19, 32, 0.86) 62%, rgba(255, 179, 71, 0.05) 100%)", boxShadow: "inset 0 1px 16px 0 rgba(40,213,255,0.06), 0 6px 18px 0 rgba(0,0,0,0.18)" },
  deskFooter: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 44, paddingVertical: 4 },
  shortDeskFooter: { minHeight: 44, paddingVertical: 4 },
  deskModePill: { flexDirection: "row", alignItems: "center", gap: 5, minHeight: 36, paddingHorizontal: 10, borderRadius: 8, borderWidth: 1, borderColor: "rgba(255, 244, 224, 0.22)", backgroundColor: "rgba(255, 244, 224, 0.06)" },
  deskModeText: { color: "#FFF4E0", fontSize: 11, fontWeight: "600" },
  deskTelemetryPill: { flex: 1, minHeight: 36, justifyContent: "center", paddingHorizontal: 10, borderRadius: 8, borderWidth: 1, borderColor: "rgba(84, 167, 255, 0.14)", backgroundColor: "rgba(9, 21, 31, 0.72)" },
  deviceFooter: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8, paddingHorizontal: 10, borderRadius: 10, borderWidth: 1, borderColor: "rgba(40, 213, 255, 0.14)", backgroundColor: "rgba(8, 20, 34, 0.65)" },
  timestamp: { flexShrink: 1, color: P.textSecondary, fontSize: 10.5, lineHeight: 14 },
  airflowArtwork: { width: 48, gap: 4 },
  airflowLine: { height: 2.5, borderRadius: 2, backgroundColor: P.presenceCyan, boxShadow: "0 0 6px rgba(40, 213, 255, 0.45)" },
  sensorHeader: { flexDirection: "row", alignItems: "center", minHeight: 40, gap: 7 },
  sensorSource: { flex: 1, textAlign: "right", color: P.textSecondary, fontSize: 10 },
  sensorReadings: { flexDirection: "row", gap: 6 },
  metricPill: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "baseline", justifyContent: "center", gap: 4, paddingVertical: 7, paddingHorizontal: 6, borderRadius: 10, borderWidth: 1, borderColor: "rgba(40,213,255,0.18)", backgroundColor: "rgba(8, 22, 36, 0.72)" },
  metricValue: { color: P.presenceCyan, fontSize: 13.5, lineHeight: 16, fontWeight: "700", fontVariant: ["tabular-nums"] },
  metricLabel: { color: P.textSecondary, fontSize: 10 },
});
