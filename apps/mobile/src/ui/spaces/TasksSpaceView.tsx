import { useEffect, useRef, useState, type ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { TaskEvent } from "@super-looi/contracts";
import { TasksAndRulesSpaceController } from "../tasks-and-rules-space.js";
import { LOOI_PALETTE as P } from "../theme.js";
import { LooiIcon, type LooiIconName } from "../components/LooiIcon.js";
import { createDemoArtifactReadback, createDemoTaskEvent, requestDemoTaskCancellation, resolveDemoTaskCancellation } from "./space-demo-state.js";
import { humanizeArtifactId, humanizeCommitmentRule, humanizeTaskSummary, humanizeWorkspaceId } from "../humanize.js";

export interface TasksSpaceViewProps {
  controller: TasksAndRulesSpaceController;
  onChange?: () => void;
  onNotify?: (message: string) => void;
}
const taskStore = new WeakMap<TasksAndRulesSpaceController, TaskEvent>();
export function getTasksSpaceSummary(controller: TasksAndRulesSpaceController): { taskCount: number; pendingApprovalCount: number } {
  const task = taskStore.get(controller) ?? createDemoTaskEvent();
  taskStore.set(controller, task);
  return { taskCount: 1 + controller.getCommitments().length, pendingApprovalCount: task.state === "awaiting_approval" ? 1 : 0 };
}
const seededControllers = new WeakSet<TasksAndRulesSpaceController>();
const workspacePath = "/workspaces/super-looi-demo";
const statusLabels: Record<TaskEvent["state"], string> = {
  queued: "排队中", running: "执行中 · 等待回读", awaiting_approval: "等待单次授权", cancelling: "请求取消中",
  succeeded: "已完成 · 产物已核验", failed: "执行失败", cancelled: "已确认进程退出", unknown: "连接中断 · 结果待核实",
};

function Button({ icon, children, onPress, danger, primary, disabled = false, compact = false }: { icon: LooiIconName; children: ReactNode; onPress: () => void; danger?: boolean; primary?: boolean; disabled?: boolean; compact?: boolean }) {
  const color = primary ? "#211407" : danger ? P.alertCoral : P.textPrimary;
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled }} onPress={onPress} disabled={disabled} hitSlop={{ top: 4, bottom: 4 }}
    style={({ pressed }) => [styles.button, compact && styles.compactButton, danger && styles.dangerButton, primary && styles.primaryButton,
      { opacity: disabled ? 0.4 : pressed ? 0.78 : 1, transform: [{ scale: pressed ? 0.97 : 1 }] }]}>
    <LooiIcon name={icon} size={compact ? 12 : 18} color={color} /><Text style={[styles.buttonText, compact && styles.compactButtonText, { color }]}>{children}</Text>
  </Pressable>;
}

function CancellationBanner({ task }: { task: TaskEvent }) {
  if (task.state !== "cancelling" && task.state !== "cancelled" && task.state !== "unknown") return null;
  const confirmed = task.state === "cancelled" && task.cancellation.phase === "confirmed";
  const uncertain = task.state === "unknown" || (task.state === "cancelled" && !confirmed);
  const color = confirmed ? P.confirmGreen : uncertain ? P.alertCoral : P.cautionAmber;
  return <View accessibilityRole="alert" accessibilityLiveRegion="polite" style={[styles.cancellationBanner, { borderColor: color }]}>
    <View style={[styles.statusIcon, { borderColor: color }]}><LooiIcon name={confirmed ? "check" : uncertain ? "warning" : "clock"} size={14} color={color} /></View>
    <View style={styles.grow}>
      <Text style={[styles.bannerTitle, { color }]}>{confirmed ? "已确认进程退出" : uncertain ? "连接中断 · 结果待核实" : "请求取消中"}</Text>
      <Text style={styles.body}>{confirmed ? "退出回执已核验" : uncertain ? "无退出确证 · 不自动重放" : "等待进程退出证据"}</Text>
    </View>
  </View>;
}

export function TasksSpaceView({ controller, onChange, onNotify }: TasksSpaceViewProps) {
  const { width, height, fontScale } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const wide = width >= 700 && fontScale < 1.7;
  const short = width >= 700 && height < 480 && fontScale < 1.3;
  const [task, setTask] = useState(() => {
    const initial = taskStore.get(controller) ?? createDemoTaskEvent();
    taskStore.set(controller, initial);
    if (!seededControllers.has(controller)) {
      seededControllers.add(controller);
      controller.addCommitment({ id: "demo_stand", title: "下午站立活动与倒水", conditionDescription: "每天 16:00 用户显式约定", status: "active", createdAt: new Date().toISOString() });
      controller.addCommitment({ id: "demo_sleep", title: "睡前调暗书房顶灯", conditionDescription: "每天 23:00 仅限书房灯光域", status: "active", createdAt: new Date().toISOString() });
    }
    return initial;
  });
  const [activeTab, setActiveTab] = useState<"tasks" | "approval">("tasks");
  const pendingApproval = task.state === "awaiting_approval";
  const autoFocusedApproval = useRef(false);
  useEffect(() => {
    if (!wide && pendingApproval && !autoFocusedApproval.current) {
      autoFocusedApproval.current = true;
      setActiveTab("approval");
    }
    if (!pendingApproval) autoFocusedApproval.current = false;
  }, [wide, pendingApproval]);
  const [readback] = useState(() => createDemoArtifactReadback());
  const [, refreshRules] = useState(0);
  const [eventHistory, setEventHistory] = useState<TaskEvent[]>(() => [task]);
  const color = task.state === "cancelling" || task.state === "awaiting_approval" ? P.cautionAmber : task.state === "unknown" || task.state === "failed" ? P.alertCoral : task.state === "cancelled" || task.state === "succeeded" ? P.confirmGreen : P.presenceCyan;
  const commitments = controller.getCommitments();
  const updateTask = (next: TaskEvent, message: string) => {
    if (next === task) return;
    taskStore.set(controller, next);
    setTask(next);
    setEventHistory((history) => [...history, next].slice(-6));
    controller.handleTaskEventNotification(next);
    onChange?.();
    onNotify?.(message);
  };
  const requestCancellation = () => updateTask(requestDemoTaskCancellation(task), "本地演示已请求取消，等待退出证据，尚未确认停止");

  return <View style={[styles.root, short && styles.shortRoot]}>
    {!wide && <View accessibilityRole="tablist" style={styles.tabs}>
      <Pressable accessibilityRole="tab" accessibilityState={{ selected: activeTab === "tasks" }} onPress={() => setActiveTab("tasks")} style={[styles.tab, activeTab === "tasks" && styles.selectedTab]}>
        <Text style={styles.tabText}>任务与产物 (1)</Text>
      </Pressable>
      <Pressable accessibilityRole="tab" accessibilityState={{ selected: activeTab === "approval" }} onPress={() => setActiveTab("approval")} style={[styles.tab, activeTab === "approval" && styles.selectedTab]}>
        {pendingApproval && <View accessibilityLabel="有待审批的高危指令" style={styles.approvalDot} />}
        <Text style={styles.tabText}>审批与约定 ({(pendingApproval ? 1 : 0) + commitments.length})</Text>
      </Pressable>
    </View>}
    <View style={[styles.columns, short && styles.shortColumns]}>
      {(wide || activeTab === "tasks") && <ScrollView style={styles.column} contentContainerStyle={[styles.content, short && styles.shortColumnContent, { paddingBottom: short ? 0 : Math.max(16, insets.bottom + 6) }]} keyboardShouldPersistTaps="handled">
        {!wide && pendingApproval && <Pressable accessibilityRole="button" onPress={() => setActiveTab("approval")} style={styles.approvalShortcut}>
          <LooiIcon name="shield" size={18} color={P.cautionAmber} /><Text style={styles.approvalShortcutText}>有 1 项高危指令待你审批 →</Text>
        </Pressable>}
        <View style={[styles.card, styles.taskHeroCard]}>
          <View style={styles.titleRow}>
            <View style={[styles.taskIconBox, { borderColor: `${color}55`, backgroundColor: `${color}14` }]}>
              <LooiIcon name="tasks" size={14} color={color} />
            </View>
            <Text style={styles.cardTitle}>楼梯碰撞修复</Text>
            <Text style={styles.workspaceBadge}>{humanizeWorkspaceId(workspacePath)}</Text>
            <Text style={[styles.badge, { color, borderColor: color, backgroundColor: `${color}14` }]}>{statusLabels[task.state]}</Text>
          </View>
          <Text numberOfLines={1} style={styles.body}>{humanizeTaskSummary(task.summary)}</Text>
          <View style={styles.progressTrack}><View style={[styles.progressFill, { width: task.state === "cancelled" ? "100%" : task.state === "unknown" ? "55%" : task.state === "awaiting_approval" ? "45%" : "70%", backgroundColor: color }]} /></View>
          <View style={styles.eventHistory}>{eventHistory.map((event) => <Text key={event.event_id} style={styles.eventText}>#{event.event_seq} {statusLabels[event.state]}</Text>)}</View>
          <View style={styles.cancellationStatus}><CancellationBanner task={task} />{task.cancellation.phase === "confirmed" && <View style={styles.terminationEvidence}><Text selectable style={styles.verified}>退出凭据 · {task.cancellation.termination_evidence_ids.join(" · ")} · 核验于 {new Date(task.cancellation.confirmed_at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</Text></View>}</View>
          {task.state === "cancelling" && <View style={styles.cancellationPanel}>
            <View style={styles.grow}><Button compact icon="check" onPress={() => updateTask(resolveDemoTaskCancellation(task, "cancelled"), "演示退出证据已返回，已确认进程退出")}>模拟收到退出回执</Button></View>
            <View style={styles.grow}><Button compact icon="warning" onPress={() => updateTask(resolveDemoTaskCancellation(task, "unknown"), "演示连接中断，结果待核实，未宣称取消成功")}>模拟连接中断</Button></View>
          </View>}

          {task.state !== "cancelling" && <View style={styles.taskActions}>
          {task.state === "awaiting_approval" || task.state === "running" || task.state === "unknown" ? <View style={styles.grow}><Button compact icon="stop" danger onPress={requestCancellation}>{task.state === "unknown" ? "重新请求取消验证" : "请求取消任务"}</Button></View> : null}
          {(task.state === "cancelled" || task.state === "unknown") && <View style={styles.grow}><Button compact icon="play" onPress={() => {
            const initial = createDemoTaskEvent();
            const next = { ...initial, event_seq: task.event_seq + 1, event_id: `demo_task_event_${task.event_seq + 1}` };
            updateTask(next, "已重置本地演示样例，未重放任何远端命令");
          }}>重置演示样例</Button></View>}
          </View>}
        </View>
        <View style={[styles.card, styles.artifactCard]} accessibilityLabel="独立核验的演示产物">
          <View style={styles.artifactHeader}>
            <View style={styles.artifactIconBox}><LooiIcon name="box" size={14} color={P.confirmGreen} /></View>
            <Text style={styles.cardTitle}>已核验产物</Text>
            <View style={styles.verifiedPill}><LooiIcon name="check" size={11} color={P.confirmGreen} /><Text style={styles.verified}>已回读 {String(readback.value.bytes)} B</Text></View>
          </View>
          <View style={styles.artifactFileBox}>
            <Text style={styles.artifactTitle}>{humanizeArtifactId(String(readback.value.path))}</Text>
            <Text selectable style={styles.monospace}>{String(readback.value.path)}</Text>
          </View>
          <View style={styles.artifactMetadata}>
            <Text selectable style={styles.artifactMetaPill}>回读凭据 · {readback.evidence_ids.join(" · ")}</Text>
            <Text selectable style={styles.small}>核验于 {new Date(readback.observed_at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</Text>
          </View>
        </View>
      </ScrollView>}
      {(wide || activeTab === "approval") && <ScrollView style={styles.column} contentContainerStyle={[styles.content, short && styles.shortColumnContent, { paddingBottom: short ? 0 : Math.max(16, insets.bottom + 6) }]} keyboardShouldPersistTaps="handled">
        <View style={styles.approvalFrame}><View style={[styles.approvalCard, short && styles.shortApprovalCard]}>
          <View style={styles.titleRow}>
            <View style={styles.shieldIconBox}><LooiIcon name="shield" size={14} color={P.cautionAmber} /></View>
            <Text style={styles.cardTitle}>高危作用域审批</Text>
            <Text style={[styles.badge, styles.cautionHeading]}>{pendingApproval ? "需要你的单次授权" : statusLabels[task.state]}</Text>
          </View>
          <Text selectable style={[styles.blockedCommand, short && styles.shortCommand]}>rm -rf build/tmp &amp;&amp; ./scripts/deploy.sh</Text>
          <View style={styles.scopeGrid}>
            <Text style={[styles.scopePill, short && styles.shortScopePill]}>读写 · 当前演示工程</Text>
            <Text style={[styles.scopePill, short && styles.shortScopePill]}>仅此命令 · 仅本次执行</Text>
          </View>
          <View style={styles.approvalActions}>
            <View style={styles.grow}><Button compact icon="shield" primary disabled={!pendingApproval} onPress={() => updateTask({
              ...task, state: "running", event_seq: task.event_seq + 1, event_id: `demo_task_event_${task.event_seq + 1}`, recorded_at: new Date().toISOString(), summary: "本地演示已单次批准，等待执行器与回读证据",
            }, "本地演示已批准单次作用域，等待执行与回读，未宣称完成")}>批准本次执行</Button></View>
            <View style={styles.grow}><Button compact icon="stop" danger disabled={!pendingApproval} onPress={requestCancellation}>拒绝并请求取消</Button></View>
          </View>
        </View></View>
        <View style={[styles.card, styles.commitmentsCard]}>
          <View style={styles.commitmentsHeader}>
            <View style={styles.ruleIconBox}><LooiIcon name="clock" size={13} color={P.presenceCyan} /></View>
            <Text style={styles.cardTitle}>我们的日常约定</Text>
            <Text style={[styles.small, styles.countBadge]}>{commitments.length} 条</Text>
            <View style={styles.addCommitment}><Button compact icon="clock" onPress={() => {
              const id = `demo_commitment_${Date.now()}`;
              controller.addCommitment({ id, title: "每天提醒整理书桌", conditionDescription: "本地演示 用户显式创建 每天 18:00", status: "active", createdAt: new Date().toISOString() });
              refreshRules((value) => value + 1); onChange?.(); onNotify?.("已添加本地演示约定");
            }}>+ 添加整理书桌约定</Button></View>
          </View>
          {commitments.map((item) => {
            const rule = humanizeCommitmentRule(item);
            return <View key={item.id} style={styles.commitment}>
              <View style={styles.commitmentCopy}><Text style={styles.commitmentTitle}>{rule.title}</Text><Text style={styles.small}>{rule.description}</Text><Text style={[styles.small, { color: item.status === "active" ? P.confirmGreen : P.textMuted }]}>{item.status === "active" ? "● 生效中" : item.status === "paused" ? "○ 已暂停" : "已完成"}</Text></View>
              <View style={styles.actions}><Button compact icon={item.status === "active" ? "stop" : "play"} onPress={() => {
                controller.addCommitment({ ...item, status: item.status === "active" ? "paused" : "active" }); refreshRules((value) => value + 1); onChange?.();
              }}>{item.status === "active" ? "暂停约定" : "恢复约定"}</Button><View style={styles.destructiveAction}><Button compact icon="trash" danger onPress={() => { controller.removeCommitment(item.id); refreshRules((value) => value + 1); onChange?.(); onNotify?.("已删除本地日常约定"); }}>删除</Button></View></View>
            </View>;
          })}
          {commitments.length === 0 && <Text style={styles.body}>暂无日常约定</Text>}

        </View>
      </ScrollView>}
    </View>
  </View>;
}

const styles = StyleSheet.create({
  root: { flex: 1, minHeight: 0, gap: 8 }, shortRoot: { paddingHorizontal: 0, paddingTop: 0, gap: 6 },
  columns: { flex: 1, minHeight: 0, flexDirection: "row", gap: 10 }, shortColumns: { gap: 10 }, column: { flex: 1, minWidth: 0 }, content: { gap: 8 }, shortColumnContent: { flexGrow: 1, gap: 8 }, grow: { flex: 1, minWidth: 0 },
  tabs: { flexDirection: "row", minHeight: 44, gap: 8 }, tab: { flex: 1, minWidth: 0, minHeight: 44, paddingHorizontal: 8, flexDirection: "row", gap: 6, alignItems: "center", justifyContent: "center", borderRadius: 12, borderWidth: 1, borderColor: P.lineSubtle, backgroundColor: P.surfaceGlass }, selectedTab: { borderColor: P.presenceCyan, backgroundColor: "rgba(40,213,255,0.08)" }, tabText: { color: P.textPrimary, fontSize: 12, fontWeight: "600", flexShrink: 1 }, approvalDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: P.cautionAmber },
  approvalShortcut: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: 8, borderRadius: 12, paddingHorizontal: 12, backgroundColor: "rgba(243,197,107,0.1)" }, approvalShortcutText: { color: P.cautionAmber, fontSize: 12, flexShrink: 1 },
  card: { borderWidth: 1, borderColor: "rgba(155, 215, 255, 0.16)", backgroundColor: "rgba(14, 23, 35, 0.88)", padding: 10, borderRadius: 14, gap: 4, experimental_backgroundImage: "linear-gradient(165deg, rgba(24, 38, 56, 0.92) 0%, rgba(10, 17, 27, 0.94) 100%)" },
  taskHeroCard: { borderColor: "rgba(40, 213, 255, 0.24)", gap: 6 },
  taskIconBox: { width: 26, height: 26, borderRadius: 8, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  artifactIconBox: { width: 26, height: 26, borderRadius: 8, borderWidth: 1, borderColor: "rgba(74, 222, 128, 0.32)", backgroundColor: "rgba(74, 222, 128, 0.1)", alignItems: "center", justifyContent: "center" },
  shieldIconBox: { width: 26, height: 26, borderRadius: 8, borderWidth: 1, borderColor: "rgba(243, 197, 107, 0.36)", backgroundColor: "rgba(243, 197, 107, 0.12)", alignItems: "center", justifyContent: "center" },
  ruleIconBox: { width: 24, height: 24, borderRadius: 7, borderWidth: 1, borderColor: "rgba(40, 213, 255, 0.28)", backgroundColor: "rgba(40, 213, 255, 0.1)", alignItems: "center", justifyContent: "center" },
  titleRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }, cardTitle: { color: P.textPrimary, fontSize: 13, lineHeight: 18, fontWeight: "700", flexShrink: 1 },
  workspaceBadge: { color: P.presenceCyan, fontSize: 9, lineHeight: 14, fontWeight: "600", paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, borderWidth: 1, borderColor: "rgba(40, 213, 255, 0.24)", backgroundColor: "rgba(40,213,255,0.1)" }, badge: { marginLeft: "auto", paddingVertical: 2, paddingHorizontal: 6, borderWidth: 0.5, borderRadius: 999, overflow: "hidden", fontSize: 9, lineHeight: 14, fontWeight: "600" }, body: { fontSize: 11, lineHeight: 16, color: P.textSecondary }, small: { fontSize: 10, lineHeight: 14, color: P.textMuted, flexShrink: 1 }, shortSmall: { fontSize: 10, lineHeight: 14 },
  progressTrack: { height: 4, borderRadius: 2, backgroundColor: "rgba(155, 215, 255, 0.14)", overflow: "hidden" }, progressFill: { height: 4, borderRadius: 2 }, eventHistory: { flexDirection: "row", flexWrap: "wrap", gap: 5 }, eventText: { color: P.textSecondary, fontSize: 9, lineHeight: 14, paddingVertical: 2, paddingHorizontal: 6, borderRadius: 6, borderWidth: 1, borderColor: "rgba(155, 215, 255, 0.12)", backgroundColor: "rgba(8, 15, 24, 0.65)" },
  taskActions: { flexDirection: "row", gap: 8 }, button: { minWidth: 44, minHeight: 44, borderWidth: 1, borderColor: "rgba(155, 215, 255, 0.2)", backgroundColor: "rgba(19, 31, 46, 0.85)", paddingVertical: 5, paddingHorizontal: 8, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 5, borderRadius: 10 }, compactButton: { minHeight: 44, paddingHorizontal: 8, paddingVertical: 4, gap: 4, borderRadius: 10 }, buttonText: { fontSize: 12, fontWeight: "600", flexShrink: 1 }, compactButtonText: { fontSize: 10, fontWeight: "600" }, dangerButton: { borderColor: "rgba(250, 142, 134, 0.45)", backgroundColor: "rgba(250,142,134,0.1)" }, primaryButton: { backgroundColor: P.cautionAmber, borderColor: "#FFE2A8", experimental_backgroundImage: "linear-gradient(180deg, #F7D388 0%, #E5B24D 100%)" },
  cancellationStatus: { flexDirection: "row", alignItems: "center", gap: 4 }, cancellationBanner: { flex: 1, flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 4, paddingHorizontal: 6, borderWidth: 1, borderRadius: 8, backgroundColor: P.bgRaised }, statusIcon: { width: 24, height: 24, borderWidth: 1, borderRadius: 7, alignItems: "center", justifyContent: "center" }, bannerTitle: { fontSize: 11, lineHeight: 14, fontWeight: "600" }, cancellationPanel: { flexDirection: "row", gap: 8 }, terminationEvidence: { flex: 1, minWidth: 0, paddingVertical: 3, paddingHorizontal: 5, borderRadius: 6, backgroundColor: "rgba(74,222,128,0.06)" },
  artifactCard: { flexGrow: 1, justifyContent: "space-between", padding: 10, gap: 4, borderColor: "rgba(74, 222, 128, 0.22)" }, artifactHeader: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6 }, verifiedPill: { marginLeft: "auto", flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 999, borderWidth: 1, borderColor: "rgba(74, 222, 128, 0.3)", backgroundColor: "rgba(74, 222, 128, 0.1)" }, artifactFileBox: { paddingVertical: 6, paddingHorizontal: 8, borderRadius: 9, borderWidth: 1, borderColor: "rgba(155, 215, 255, 0.12)", backgroundColor: "rgba(8, 15, 24, 0.6)", gap: 2 }, artifactTitle: { color: P.textPrimary, fontSize: 11, lineHeight: 15, fontWeight: "600", flexShrink: 1 }, verified: { color: P.confirmGreen, fontSize: 10, lineHeight: 14, fontWeight: "600" }, artifactMetadata: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 4 }, artifactMetaPill: { color: P.textSecondary, fontSize: 9, lineHeight: 13, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, backgroundColor: "rgba(155, 215, 255, 0.08)" }, monospace: { fontFamily: "monospace", fontSize: 10, lineHeight: 14, color: P.presenceCyan, flexShrink: 1 },
  approvalFrame: { borderRadius: 14, padding: 1, backgroundColor: "rgba(243,197,107,0.42)" }, approvalCard: { backgroundColor: "#111A24", padding: 10, borderRadius: 13, gap: 6, experimental_backgroundImage: "linear-gradient(165deg, rgba(34, 28, 22, 0.94) 0%, rgba(14, 21, 31, 0.96) 100%)" }, shortApprovalCard: { padding: 10, gap: 6 }, cautionHeading: { color: P.cautionAmber, borderColor: "rgba(243, 197, 107, 0.45)", backgroundColor: "rgba(243, 197, 107, 0.12)" }, blockedCommand: { fontFamily: "monospace", fontSize: 11, lineHeight: 16, color: "#FFB4AB", borderWidth: 1, borderColor: "rgba(250, 142, 134, 0.28)", backgroundColor: "rgba(250,142,134,0.09)", padding: 6, borderRadius: 8 }, shortCommand: { padding: 6, fontSize: 11, lineHeight: 16 },
  scopeGrid: { flexDirection: "row", flexWrap: "wrap", gap: 6 }, scopePill: { paddingVertical: 3, paddingHorizontal: 7, borderRadius: 6, borderWidth: 1, borderColor: "rgba(243, 197, 107, 0.25)", color: P.cautionAmber, fontSize: 9, lineHeight: 13, fontWeight: "600", backgroundColor: "rgba(243, 197, 107, 0.08)" }, shortScopePill: { paddingVertical: 3, paddingHorizontal: 7, fontSize: 9, lineHeight: 13 }, approvalActions: { flexDirection: "row", gap: 8 },
  commitmentsCard: { flexGrow: 1, justifyContent: "space-between" }, commitmentsHeader: { flexDirection: "row", alignItems: "center", gap: 6 }, countBadge: { paddingHorizontal: 6, paddingVertical: 1, borderRadius: 999, backgroundColor: "rgba(155, 215, 255, 0.1)", color: P.textSecondary }, addCommitment: { marginLeft: "auto", flexShrink: 1 }, commitment: { flexDirection: "row", alignItems: "center", gap: 6, borderTopWidth: 1, borderTopColor: P.lineSubtle, paddingTop: 5 }, commitmentCopy: { flex: 1, minWidth: 0, gap: 1 }, commitmentTitle: { color: P.textPrimary, fontSize: 11, lineHeight: 15, fontWeight: "600" }, actions: { flexDirection: "row", alignItems: "center", gap: 4 }, destructiveAction: { marginLeft: "auto", paddingLeft: 8, borderLeftWidth: 1, borderLeftColor: P.lineSubtle },
});
