import { useRef, useState, type ReactElement } from "react";
import { Pressable as NativePressable, ScrollView, StyleSheet, Text, View, useWindowDimensions, type PressableProps } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { VoiceProviderKind, VisionProviderKind } from "@super-looi/contracts";
import type { CabinSpaceController, SubsystemConnection } from "../cabin-space.js";
import type { DockedLongevitySupervisor, ThermalPressureLevel } from "../../shell/longevity-supervisor.js";
import { LooiIcon, type LooiIconName } from "../components/LooiIcon.js";
import { ToggleSwitch } from "../components/ToggleSwitch.js";
import { LOOI_PALETTE as P } from "../theme.js";

export interface MobileAcceptanceReport {
  totalCases: number;
  passedCases: number;
  totalScore: number;
  maxScore: number;
  hardGates: {
    unauthorizedActions: number;
    crossSubjectLeaks: number;
    zombieResurrections: number;
    unverifiedCompletions: number;
  };
  cases: Array<{ id: string; name: string; score: 0 | 1 | 2; passed: boolean; details: string; hardGateViolation?: string }>;
  success: boolean;
}

export interface CabinSpaceViewProps {
  realHome?: boolean;
  controller: CabinSpaceController;
  supervisor: DockedLongevitySupervisor;
  onChange?: () => void;
  onNotify?: (message: string) => void;
  acceptanceRunning?: boolean;
  acceptanceReport?: MobileAcceptanceReport | null;
  acceptanceError?: string | null;
  onRunAcceptance: () => void;
}

const groups = [
  { id: "A", shortLabel: "位置观察", label: "最后位置与主动观察" },
  { id: "B", shortLabel: "语音证据", label: "语音改口与证据去重" },
  { id: "C", shortLabel: "主体隔离", label: "主人访客与打断隔离" },
  { id: "D", shortLabel: "纠错防注入", label: "纠错删除与防注入" },
  { id: "E", shortLabel: "家居验真", label: "家居白名单与验真" },
  { id: "F", shortLabel: "任务沙箱", label: "任务沙箱与诚实取消" },
  { id: "G", shortLabel: "具身急停", label: "具身租约与脱座急停" },
  { id: "H", shortLabel: "长稳降级", label: "双端长稳与降级诚实" },
];
function Pressable({ style, ...props }: PressableProps): ReactElement {
  return <NativePressable {...props} style={(state) => [typeof style === "function" ? style(state) : style, state.pressed && { opacity: 0.76, transform: [{ scale: 0.985 }] }]} />;
}
const thermalLevels: ThermalPressureLevel[] = ["nominal", "fair", "serious", "critical"];
const hardGates: Array<{ key: keyof MobileAcceptanceReport["hardGates"]; label: string }> = [
  { key: "unauthorizedActions", label: "越权执行" },
  { key: "crossSubjectLeaks", label: "跨主体泄露" },
  { key: "zombieResurrections", label: "僵尸复活" },
  { key: "unverifiedCompletions", label: "未核验成功" },
];

function verifiedTime(timestamp: string | null): string {
  if (!timestamp) return "尚未验真";
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? "时间待核实" : date.toLocaleTimeString("zh-CN", { hour12: false });
}

export function CabinSpaceView({
  realHome = false,
  controller, supervisor, onChange, onNotify,
  acceptanceRunning = false, acceptanceReport = null, acceptanceError = null, onRunAcceptance,
}: CabinSpaceViewProps): ReactElement {
  const [, setRevision] = useState(0);
  const [lastReplayCount, setLastReplayCount] = useState<number | null>(null);
  const [selectedCase, setSelectedCase] = useState<string | null>(null);
  const [matrixExpanded, setMatrixExpanded] = useState(false);
  const { width: windowWidth } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [measuredContentWidth, setContentWidth] = useState<number | null>(null);
  // The shell owns workspace padding; measure the actual remaining space after its rail.
  const contentWidth = measuredContentWidth ?? Math.max(0, windowWidth - 88 - 24 - insets.left - insets.right);
  const columns = contentWidth >= 640 ? 3 : contentWidth >= 520 ? 2 : 1;
  const panelWidth = (contentWidth - (columns - 1) * 8) / columns;
  const policyCellWidth = (panelWidth - 18 - 4) / 2;
  const acceptanceWidth = columns === 2 ? contentWidth : panelWidth;
  const gateCellWidth = (acceptanceWidth - 18 - 4) / 2;
  const groupCellWidth = (acceptanceWidth - 18 - 4) / 2;
  const scrollRef = useRef<ScrollView>(null);
  const middleYRef = useRef(0);
  const acceptanceYRef = useRef(0);
  const caseDetailsYRef = useRef<number | null>(null);
  const pendingDetailsScroll = useRef(false);
  const state = controller.getSubsystems();
  const policy = supervisor.getPolicy();
  const shift = supervisor.getPixelMicroShift();
  const voice = controller.getActiveVoiceProvider();
  const vision = controller.getActiveVisionProvider();
  const selectedResult = acceptanceReport?.cases.find((result) => result.id === selectedCase);
  const haOutageSimulated = state.homeAssistant.status !== "connected";
  const acceptanceStatus = acceptanceRunning ? "运行中" : acceptanceError ? "待核实" : acceptanceReport ? `${acceptanceReport.passedCases}/48通过` : "待验证";

  function changed() { setRevision((value) => value + 1); onChange?.(); }

  function onToggleHaOutage(disconnected: boolean) {
    controller.updateSubsystemStatus("homeAssistant", disconnected ? "disconnected" : "connected");
    changed();
    onNotify?.(disconnected ? "HA 演示链路断开，BLE 与 Hub 独立保留" : "HA 本地演示链路已恢复，家居可进行本地回读演示");
  }

  function scrollToCaseDetails() {
    requestAnimationFrame(() => {
      if (caseDetailsYRef.current === null) return;
      scrollRef.current?.scrollTo({
        y: Math.max(0, middleYRef.current + acceptanceYRef.current + caseDetailsYRef.current - 8), animated: true,
      });
    });
  }

  function selectCase(id: string) {
    pendingDetailsScroll.current = true;
    setSelectedCase(id);
    if (caseDetailsYRef.current !== null) scrollToCaseDetails();
  }

  function connectionCard(system: SubsystemConnection, name: string, icon: LooiIconName) {
    const verified = system.lastVerifiedAt !== null && !Number.isNaN(new Date(system.lastVerifiedAt).getTime());
    const status = system.status === "connected" ? (verified ? "已连接" : "待验真") : system.status === "connecting" ? "连接中" : "未连接";
    const color = system.status === "connected" && !verified ? P.amberWarning : system.statusColor;
    return <View key={system.name} accessible accessibilityLabel={`${name}，链路快照 ${status}，${verifiedTime(system.lastVerifiedAt)}，演示`} style={styles.connectionCard}>
      <LooiIcon name={icon} size={16} color={color} />
      <View style={styles.grow}>
        <Text style={styles.connectionTitle}>{name}</Text>
        <Text style={[styles.connectionStatus, { color }]}>演示 · {status}</Text>
      </View>
    </View>;
  }

  function rehearseBleReconnect() {
    supervisor.queueMotionCommand("demo_old_motion_1"); supervisor.queueMotionCommand("demo_old_motion_2");
    supervisor.handleBleDisconnect(); controller.updateSubsystemStatus("bleDock", "connecting");
    const result = supervisor.handleBleReconnect(); controller.handleReconnect();
    controller.updateSubsystemStatus("bleDock", "connected"); setLastReplayCount(result.replayedCommandsCount); changed();
    onNotify?.(`BLE 本地重连演练完成，重放 ${result.replayedCommandsCount} 条旧动作`);
  }

  function setVoice(provider: VoiceProviderKind) {
    controller.setActiveVoiceProvider(provider); changed();
    onNotify?.(`本地语音策略选择: ${provider === "doubao" ? "A 轨豆包全双工" : "B 轨模块化流式"}`);
  }

  function setVision(provider: VisionProviderKind) {
    controller.setActiveVisionProvider(provider); changed();
    onNotify?.(`本地视觉策略选择: ${provider.toUpperCase()}`);
  }

  return <ScrollView ref={scrollRef} keyboardShouldPersistTaps="handled" onLayout={(event) => setContentWidth(Math.max(0, event.nativeEvent.layout.width))} style={styles.root} contentContainerStyle={[styles.content, { paddingBottom: Math.max(6, insets.bottom + 6) }]} showsVerticalScrollIndicator>
    <View style={[styles.topStrip, columns === 3 && styles.topStripWide]}>
      <View style={[styles.connections, columns === 3 && styles.connectionsWide, columns === 1 && styles.stacked]}>
        {connectionCard(state.bleDock, "LOOI 底座 / BLE", "bluetooth")}
        {connectionCard(state.hub, "Hub 主机", "server")}
        {connectionCard(state.homeAssistant, "Home Assistant", "gateway")}
      </View>
      <View style={[styles.connectionDrills, columns === 3 && styles.drillsWide, columns === 1 && styles.stacked]}>
        {!realHome && <Pressable accessibilityRole="switch" accessibilityLabel="HA 断连模拟" accessibilityState={{ checked: haOutageSimulated }} style={[styles.switchRow, columns === 3 && styles.switchRowWide]} onPress={() => onToggleHaOutage(!haOutageSimulated)}>
          <Text style={[styles.controlText, columns === 3 && styles.compactControlText]}>HA 断连模拟</Text>
          <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <ToggleSwitch compact label="HA 断连模拟" value={haOutageSimulated} onValueChange={onToggleHaOutage} />
          </View>
        </Pressable>}
        <Pressable accessibilityRole="button" accessibilityLabel="演练 BLE 重连零动作重放" style={[styles.reconnectButton, columns === 3 && styles.reconnectButtonWide]} onPress={rehearseBleReconnect}>
          <LooiIcon name="bluetooth" size={16} color={P.presenceCyan} />
          <View style={styles.replayLabels}>
            <Text style={styles.controlText}>BLE 重连演练</Text>
            <Text accessibilityLiveRegion="polite" accessibilityLabel={lastReplayCount === null ? "BLE 尚未演练，重放数待验证" : `BLE 演练重放 ${lastReplayCount} 条，待发队列 ${supervisor.getPendingMotionCount()} 条`} style={[styles.statusPill, styles.replayTag, { color: lastReplayCount === null ? P.amberWarning : lastReplayCount === 0 ? P.confirmGreen : P.alertCoral }]}>{`重放 ${lastReplayCount ?? 0} 条`}{lastReplayCount === null ? " · 待验证" : ""}</Text>
          </View>
        </Pressable>
      </View>
    </View>
    <View onLayout={(event) => { middleYRef.current = event.nativeEvent.layout.y; }} style={styles.middle}>
      <View style={[styles.panel, { width: panelWidth }]}>
        <View style={styles.panelHeading}><LooiIcon name="server" color={P.presenceCyan} size={17} /><Text accessibilityRole="header" style={styles.panelTitle}>双脑引擎热切换</Text><Text style={styles.demoPill}>演示策略</Text></View>
        <View style={styles.options}>
          <Pressable accessibilityRole="button" accessibilityLabel="A 轨 豆包全双工" accessibilityState={{ selected: voice === "doubao" }} style={[styles.provider, voice === "doubao" && styles.selected]} onPress={() => setVoice("doubao")}><Text style={[styles.controlText, voice === "doubao" && styles.selectedText]}>A 轨 豆包全双工</Text></Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="B 轨 模块化流式" accessibilityState={{ selected: voice === "modular" }} style={[styles.provider, voice === "modular" && styles.selected]} onPress={() => setVoice("modular")}><Text style={[styles.controlText, voice === "modular" && styles.selectedText]}>B 轨 模块化流式</Text></Pressable>
        </View>
        <View style={styles.options}>{(["cloud", "lan", "edge"] as VisionProviderKind[]).map((provider) => <Pressable key={provider} accessibilityRole="button" accessibilityLabel={`视觉引擎 ${provider.toUpperCase()}`} accessibilityState={{ selected: vision === provider }} style={[styles.option, vision === provider && styles.selected]} onPress={() => setVision(provider)}><Text style={[styles.controlText, vision === provider && styles.selectedText]}>{provider.toUpperCase()}</Text></Pressable>)}</View>
        <Text style={styles.edgeStatusPill}>Edge 模型: {policy.edgeVlmLoaded ? "已加载" : "已卸载"} (空闲5s卸载)</Text>
      </View>
      <View style={[styles.panel, { width: panelWidth }]}>
        <View style={styles.panelHeading}><LooiIcon name="shield" color={P.presenceCyan} size={17} /><Text accessibilityRole="header" style={styles.panelTitle}>长稳守护器</Text></View>
        <View style={styles.thermalLadder}>{thermalLevels.map((level, index) => {
          const active = policy.thermalLevel === level;
          const color = [P.presenceCyan, P.amberWarning, "#F0A078", P.alertCoral][index];
          return <Pressable key={level} accessibilityRole="button" accessibilityLabel={`热压力演练 ${level}`} accessibilityState={{ selected: active }} onPress={() => { supervisor.setThermalLevel(level); changed(); onNotify?.(`热压力演练: ${level}，采样间隔 ${supervisor.getPolicy().captureCadenceMs}ms`); }} style={[styles.thermal, active && { borderColor: color, backgroundColor: `${color}18` }]}>
            <View style={[styles.thermalRung, { backgroundColor: color, opacity: active ? 1 : 0.28 }]} />
            <Text style={[styles.thermalText, active && { color, fontWeight: "700" }]}>{level[0].toUpperCase() + level.slice(1)}</Text>
          </Pressable>;
        })}</View>
        <View style={styles.policyGrid}>
          <View style={[styles.policyItem, { width: policyCellWidth }]}><Text style={styles.metric}>{policy.captureCadenceMs}ms 采样</Text></View>
          <View style={[styles.policyItem, { width: policyCellWidth }]}><Text style={styles.metric}>{policy.activeLookEnabled ? "允许" : "暂停"}观察</Text></View>
          <View style={[styles.policyItem, { width: policyCellWidth }]}><Text style={styles.metric}>{policy.screenDimmed ? "调暗" : "正常"}屏幕</Text></View>
          <View style={[styles.policyItem, { width: policyCellWidth }]}><Text accessibilityLabel="急停时延预算小于 100 毫秒" style={[styles.metric, { color: P.alertCoral }]}>&lt;100ms 急停</Text></View>
        </View>
        <View style={styles.oledRow}>
          <View accessible accessibilityLabel={`OLED 位移雷达，横向 ${shift.dx} 像素，纵向 ${shift.dy} 像素，范围负 6 到正 6 像素`} style={styles.oledPreview}>
            <View style={styles.radarRing} /><View style={styles.radarHorizontal} /><View style={styles.radarVertical} />
            <View style={[styles.oledPixel, { transform: [{ translateX: shift.dx * 2 }, { translateY: shift.dy * 2 }] }]} />
          </View>
          <Text style={[styles.oledText, styles.grow]}>OLED x {shift.dx}px · y {shift.dy}px · 步 {shift.stepCount}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="推进 OLED 防烧屏位移" style={styles.shiftButton} onPress={() => { supervisor.tickMicroShift(); changed(); }}><LooiIcon name="play" size={16} color={P.presenceCyan} /></Pressable>
        </View>
      </View>
      <View onLayout={(event) => { acceptanceYRef.current = event.nativeEvent.layout.y; }} style={[styles.acceptancePanel, { width: acceptanceWidth }]}>
        <View style={styles.acceptanceHeading}>
          <Text accessibilityRole="header" style={styles.panelTitle}>48 项核心验收</Text>
          <Text accessibilityLiveRegion="polite" accessibilityLabel={acceptanceReport ? `Hub 验收 ${acceptanceStatus}，报告 ${acceptanceReport.passedCases}/${acceptanceReport.totalCases} 通过，${acceptanceReport.totalScore}/${acceptanceReport.maxScore} 分，${acceptanceReport.success ? "全部验收通过" : "验收未全部通过"}` : `Hub 验收 ${acceptanceStatus}`} style={[styles.statusPill, { color: acceptanceRunning || acceptanceError || !acceptanceReport ? P.amberWarning : acceptanceReport.success ? P.confirmGreen : P.alertCoral }]}>{acceptanceStatus}</Text>
        </View>
        <View style={styles.acceptanceActions}>
          <Pressable accessibilityRole="button" accessibilityLabel="运行 48 项验收" accessibilityState={{ disabled: acceptanceRunning, busy: acceptanceRunning }} disabled={acceptanceRunning} onPress={onRunAcceptance} style={[styles.runButton, acceptanceRunning && styles.disabled]}><LooiIcon name="play" size={14} color={P.presenceCyan} /><Text style={styles.controlText}>{acceptanceRunning ? "正在运行" : "运行 48 项"}</Text></Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel={`${matrixExpanded ? "收起" : "展开"} 48 项用例矩阵`} accessibilityState={{ expanded: matrixExpanded }} onPress={() => setMatrixExpanded((expanded) => !expanded)} style={styles.matrixToggle}>
            <View style={{ transform: [{ rotate: matrixExpanded ? "0deg" : "180deg" }] }}><LooiIcon name="chevron-up" color={P.presenceCyan} size={14} /></View>
            <Text style={styles.controlText}>{matrixExpanded ? "收起" : "展开"}</Text>
          </Pressable>
        </View>
        {acceptanceReport && (acceptanceRunning || acceptanceError) && <Text style={styles.small}>下方保留上次 Hub 报告</Text>}
        {acceptanceError && <View accessibilityRole="alert" style={styles.error}><Text style={styles.errorText}>{acceptanceError}。本次结果待核实，不记为成功。</Text></View>}
        <View style={styles.gates}>{hardGates.map((gate) => {
          const value = acceptanceReport?.hardGates[gate.key];
          const color = value === undefined ? P.amberWarning : value === 0 ? P.confirmGreen : P.alertCoral;
          return <View key={gate.key} accessible accessibilityLabel={`${gate.label}，${value === undefined ? "待验证" : `Hub 报告 ${value}，${value === 0 ? "零违规" : "安全门禁未通过"}`}`} style={[styles.gate, { width: gateCellWidth }]}>
            <Text style={styles.gateLabel}>{gate.label}</Text><Text style={[styles.gateValue, { color }]}>{value === undefined ? "待验证" : value}</Text>
          </View>;
        })}</View>
        {selectedCase && <View onLayout={(event) => {
          caseDetailsYRef.current = event.nativeEvent.layout.y;
          if (pendingDetailsScroll.current) { pendingDetailsScroll.current = false; scrollToCaseDetails(); }
        }} style={styles.caseDetails}>
          <View style={styles.caseDetailsHeading}><Text style={[styles.controlText, styles.grow]}>{selectedCase} {selectedResult?.name ?? "等待真实验收报告"}</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="收起用例详情" onPress={() => { setSelectedCase(null); caseDetailsYRef.current = null; pendingDetailsScroll.current = false; }} style={styles.dismissDetails}><Text style={styles.controlText}>收起详情</Text></Pressable>
          </View>
          <Text selectable style={styles.description}>{selectedResult?.details ?? "此用例尚无已核验执行结果。"}</Text>
          {selectedResult && <Text style={styles.small}>Hub 报告 · {selectedResult.passed && selectedResult.score === 2 ? "通过" : "未通过"} · {selectedResult.score}/2 分</Text>}
          {selectedResult?.hardGateViolation && <Text style={styles.errorText}>{selectedResult.hardGateViolation}</Text>}
        </View>}
        <View style={styles.groups}>{groups.map((group) => {
          const results = acceptanceReport?.cases.filter((result) => result.id.startsWith(group.id)) ?? [];
          const passed = results.filter((result) => result.passed && result.score === 2).length;
          return <View style={[styles.group, { width: groupCellWidth }]} key={group.id}>
            <View accessibilityRole="progressbar" accessibilityLabel={`${group.id} 组 ${group.label} ${acceptanceReport ? `${passed}/6 通过` : "待验证"}`} accessibilityValue={{ min: 0, max: 6, now: passed, text: acceptanceReport ? `${passed}/6 通过` : "待验证" }} style={styles.groupSummary}>
              <View style={styles.groupHeader}><Text style={styles.groupLetter}>{group.id}</Text><Text style={[styles.groupName, styles.grow]}>{group.shortLabel}</Text><Text style={styles.groupCount}>{passed}/6</Text></View>
              <View style={styles.groupProgressTrack}><View style={[styles.groupProgressFill, { width: `${passed / 6 * 100}%` }]} /></View>
            </View>
            {matrixExpanded && <View style={styles.caseRow}>{Array.from({ length: 6 }, (_, index) => {
              const id = `${group.id}${String(index + 1).padStart(2, "0")}`;
              const result = results.find((item) => item.id === id);
              const passedCase = result?.passed && result.score === 2;
              const color = !result ? P.textMuted : passedCase ? P.confirmGreen : P.alertCoral;
              return <Pressable key={id} accessibilityRole="button" accessibilityLabel={`${id} ${result?.name ?? "待运行"} ${!result ? "待验证" : passedCase ? "通过" : "未通过"}`} onPress={() => selectCase(id)} style={[styles.case, selectedCase === id && styles.selected]}><LooiIcon name={!result ? "clock" : passedCase ? "check" : "warning"} size={14} color={color} /><Text style={[styles.caseId, { color }]}>{id}</Text></Pressable>;
            })}</View>}
          </View>;
        })}</View>
      </View>
    </View>
  </ScrollView>;
}

const styles = StyleSheet.create({
  root: { flex: 1, minHeight: 0 },
  content: { paddingHorizontal: 0, paddingTop: 0, gap: 8 },
  grow: { flex: 1, minWidth: 0 },
  topStrip: { gap: 6 },
  topStripWide: { flexDirection: "row", alignItems: "stretch", flexWrap: "nowrap" },
  connections: { flexDirection: "row", gap: 6 },
  connectionsWide: { flex: 1, minWidth: 0 },
  stacked: { flexDirection: "column", alignItems: "stretch" },
  connectionCard: { flex: 1, minWidth: 0, minHeight: 46, flexDirection: "row", alignItems: "center", paddingVertical: 8, paddingHorizontal: 10, gap: 6, borderRadius: 14, borderWidth: 1, borderColor: "rgba(155, 215, 255, 0.16)", backgroundColor: "rgba(14, 23, 35, 0.88)", experimental_backgroundImage: "linear-gradient(165deg, rgba(24, 38, 56, 0.92) 0%, rgba(10, 17, 27, 0.94) 100%)" },
  connectionTitle: { color: P.textPrimary, fontSize: 10, lineHeight: 14, fontWeight: "700", letterSpacing: -0.2 },
  connectionStatus: { fontSize: 10, lineHeight: 14, fontWeight: "600" },
  statusPill: { fontSize: 10, lineHeight: 14, fontWeight: "600", paddingHorizontal: 6, paddingVertical: 2, borderRadius: 999, backgroundColor: "rgba(19, 31, 46, 0.85)", flexShrink: 1 },
  connectionDrills: { flexDirection: "row", alignItems: "stretch", flexWrap: "wrap", gap: 6 },
  drillsWide: { flexDirection: "row", flexWrap: "nowrap", flexShrink: 0 },
  switchRow: { minWidth: 44, minHeight: 46, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 6, paddingLeft: 8, paddingRight: 4, borderRadius: 14, borderWidth: 1, borderColor: "rgba(155, 215, 255, 0.18)", backgroundColor: "rgba(14, 23, 35, 0.88)", experimental_backgroundImage: "linear-gradient(165deg, rgba(24, 38, 56, 0.92) 0%, rgba(10, 17, 27, 0.94) 100%)" },
  switchRowWide: { width: 116, gap: 1, paddingLeft: 6, paddingRight: 1 },
  reconnectButton: { minWidth: 44, minHeight: 46, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 5, paddingHorizontal: 8, borderRadius: 14, borderWidth: 1, borderColor: "rgba(40, 213, 255, 0.26)", backgroundColor: "rgba(14, 23, 35, 0.88)", experimental_backgroundImage: "linear-gradient(165deg, rgba(18, 42, 62, 0.88) 0%, rgba(10, 18, 29, 0.94) 100%)" },
  reconnectButtonWide: { width: 118, paddingHorizontal: 6 },
  replayLabels: { minWidth: 0, flexShrink: 1 },
  replayTag: { alignSelf: "flex-start", fontSize: 9, lineHeight: 12, paddingHorizontal: 0, paddingVertical: 0, backgroundColor: "transparent" },
  middle: { flexDirection: "row", flexWrap: "wrap", alignItems: "stretch", gap: 8 },
  panel: { minWidth: 0, justifyContent: "space-between", padding: 8, borderRadius: 14, borderWidth: 1, borderColor: "rgba(155, 215, 255, 0.16)", backgroundColor: "rgba(14, 23, 35, 0.88)", gap: 6, experimental_backgroundImage: "linear-gradient(165deg, rgba(24, 38, 56, 0.92) 0%, rgba(10, 17, 27, 0.94) 100%)" },
  panelHeading: { flexDirection: "row", alignItems: "center", gap: 6 },
  panelTitle: { color: P.textPrimary, fontSize: 13, lineHeight: 18, fontWeight: "700", flexShrink: 1 },
  controlText: { color: P.textPrimary, fontSize: 11, lineHeight: 15, fontWeight: "600", flexShrink: 1 },
  compactControlText: { fontSize: 9, lineHeight: 13, letterSpacing: -0.3 },
  demoPill: { marginLeft: "auto", color: P.presenceCyan, fontSize: 9, lineHeight: 12, fontWeight: "600", paddingHorizontal: 6, paddingVertical: 2, borderRadius: 999, borderWidth: 1, borderColor: "rgba(40, 213, 255, 0.25)", backgroundColor: "rgba(40, 213, 255, 0.1)" },
  small: { color: P.textSecondary, fontSize: 10, lineHeight: 14 },
  edgeStatusPill: { color: P.textSecondary, fontSize: 10, lineHeight: 14, paddingVertical: 6, paddingHorizontal: 8, borderRadius: 9, borderWidth: 1, borderColor: "rgba(155, 215, 255, 0.14)", backgroundColor: "rgba(8, 15, 24, 0.65)" },
  description: { color: P.textSecondary, fontSize: 12, lineHeight: 18 },
  options: { flexDirection: "row", flexWrap: "wrap", gap: 5 },
  provider: { flex: 1, minWidth: 44, minHeight: 48, alignItems: "center", justifyContent: "center", paddingHorizontal: 6, paddingVertical: 6, borderRadius: 10, borderWidth: 1, borderColor: "rgba(155, 215, 255, 0.16)", backgroundColor: "rgba(8, 15, 24, 0.65)" },
  option: { flex: 1, minWidth: 44, minHeight: 46, alignItems: "center", justifyContent: "center", paddingHorizontal: 4, paddingVertical: 5, borderRadius: 10, borderWidth: 1, borderColor: "rgba(155, 215, 255, 0.16)", backgroundColor: "rgba(8, 15, 24, 0.65)" },
  selected: { borderColor: P.lineActive, backgroundColor: "rgba(40,213,255,0.14)", boxShadow: "0 0 10px rgba(40, 213, 255, 0.18)" },
  selectedText: { color: P.presenceCyan, fontWeight: "700" },
  thermalLadder: { flexDirection: "row", flexWrap: "wrap", gap: 3 },
  thermal: { flex: 1, minWidth: 44, minHeight: 46, paddingHorizontal: 1, paddingVertical: 5, alignItems: "center", justifyContent: "center", gap: 5, borderRadius: 9, borderWidth: 1, borderColor: "rgba(155, 215, 255, 0.15)", backgroundColor: "rgba(8, 15, 24, 0.65)" },
  thermalRung: { width: 18, height: 3, borderRadius: 2 },
  thermalText: { color: P.textSecondary, fontSize: 9, lineHeight: 13, letterSpacing: -0.2, flexShrink: 1 },
  policyGrid: { flexDirection: "row", flexWrap: "wrap", gap: 4 },
  policyItem: { flexGrow: 0, flexShrink: 0, minWidth: 0, paddingHorizontal: 6, paddingVertical: 6, borderWidth: 1, borderColor: "rgba(155, 215, 255, 0.12)", backgroundColor: "rgba(8, 15, 24, 0.65)", borderRadius: 8 },
  metric: { color: P.textPrimary, fontSize: 10, lineHeight: 14, fontWeight: "600" },
  oledRow: { flexDirection: "row", alignItems: "center", gap: 3 },
  oledPreview: { width: 46, height: 46, borderRadius: 10, borderWidth: 1, borderColor: "rgba(40, 213, 255, 0.28)", backgroundColor: "rgba(6, 12, 20, 0.85)", alignItems: "center", justifyContent: "center" },
  radarRing: { position: "absolute", width: 30, height: 30, borderRadius: 15, borderWidth: 1, borderColor: "rgba(40,213,255,0.22)" },
  radarHorizontal: { position: "absolute", width: 36, height: 1, backgroundColor: "rgba(40,213,255,0.28)" },
  radarVertical: { position: "absolute", width: 1, height: 36, backgroundColor: "rgba(40,213,255,0.28)" },
  oledPixel: { width: 6, height: 6, borderRadius: 3, backgroundColor: P.presenceCyan, boxShadow: "0 0 8px rgba(40, 213, 255, 0.8)" },
  oledText: { color: P.textSecondary, fontSize: 8, lineHeight: 12, fontWeight: "600", letterSpacing: -0.5 },
  shiftButton: { width: 44, height: 46, alignItems: "center", justifyContent: "center", borderRadius: 10, backgroundColor: "rgba(40, 213, 255, 0.1)", borderWidth: 1, borderColor: "rgba(40, 213, 255, 0.32)" },
  acceptancePanel: { minWidth: 0, justifyContent: "space-between", padding: 8, borderRadius: 14, borderWidth: 1, borderColor: "rgba(155, 215, 255, 0.16)", backgroundColor: "rgba(14, 23, 35, 0.88)", gap: 4, experimental_backgroundImage: "linear-gradient(165deg, rgba(24, 38, 56, 0.92) 0%, rgba(10, 17, 27, 0.94) 100%)" },
  acceptanceHeading: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 4 },
  acceptanceActions: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 4 },
  runButton: { minWidth: 44, minHeight: 44, flexGrow: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 5, paddingHorizontal: 6, paddingVertical: 4, borderRadius: 10, borderWidth: 1, borderColor: P.lineActive, backgroundColor: "rgba(40,213,255,0.14)" },
  matrixToggle: { minWidth: 44, minHeight: 44, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 3, paddingHorizontal: 6, paddingVertical: 4, borderRadius: 10, borderWidth: 1, borderColor: "rgba(155, 215, 255, 0.18)", backgroundColor: "rgba(8, 15, 24, 0.65)" },
  disabled: { opacity: 0.5 },
  error: { padding: 6, borderRadius: 8, backgroundColor: "rgba(243,197,107,0.07)" },
  errorText: { color: P.amberWarning, fontSize: 11, lineHeight: 16 },
  gates: { flexDirection: "row", flexWrap: "wrap", gap: 4 },
  gate: { flexGrow: 0, flexShrink: 0, minWidth: 0, flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 2, paddingHorizontal: 5, paddingVertical: 3, borderRadius: 7, backgroundColor: "rgba(8, 15, 24, 0.65)" },
  gateLabel: { color: P.textSecondary, fontSize: 9, lineHeight: 12 },
  gateValue: { fontSize: 9, lineHeight: 12, fontWeight: "700" },
  groups: { flexDirection: "row", flexWrap: "wrap", gap: 4 },
  group: { flexGrow: 0, flexShrink: 0, minWidth: 0, padding: 2, borderRadius: 7, borderWidth: 1, borderColor: "rgba(155, 215, 255, 0.14)", backgroundColor: "rgba(8, 15, 24, 0.65)", gap: 4 },
  groupSummary: { gap: 2 },
  groupHeader: { flexDirection: "row", alignItems: "center", gap: 3 },
  groupLetter: { color: P.presenceCyan, fontSize: 10, lineHeight: 12, fontWeight: "700" },
  groupName: { color: P.textPrimary, fontSize: 9, lineHeight: 12 },
  groupCount: { color: P.textSecondary, fontSize: 9, lineHeight: 12 },
  groupProgressTrack: { height: 2, borderRadius: 2, backgroundColor: "rgba(94,132,164,0.22)", overflow: "hidden" },
  groupProgressFill: { height: "100%", borderRadius: 2, backgroundColor: P.confirmGreen },
  caseRow: { flexDirection: "row", flexWrap: "wrap", gap: 4 },
  case: { flexGrow: 1, minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center", gap: 2, paddingHorizontal: 3, paddingVertical: 4, borderRadius: 7, borderWidth: 1, borderColor: P.lineSubtle, backgroundColor: P.bgDeep },
  caseId: { fontSize: 10, lineHeight: 14 },
  caseDetails: { gap: 5, padding: 6, borderRadius: 9, borderWidth: 1, borderColor: P.lineSubtle, backgroundColor: P.bgRaised },
  caseDetailsHeading: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 4 },
  dismissDetails: { minWidth: 44, minHeight: 44, justifyContent: "center", alignItems: "center", paddingHorizontal: 5 },
});
