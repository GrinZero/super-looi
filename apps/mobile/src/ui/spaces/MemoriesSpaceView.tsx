import { useEffect, useMemo, useRef, useState } from "react";
import { Keyboard, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { createMemoryClaim, type MemoryClaim } from "@super-looi/contracts";
import { MemoriesConformalSpaceController } from "../memories-space.js";
import type { HubMemoryItem } from "../../runtime/live-voice-client.js";
import { LOOI_PALETTE as P } from "../theme.js";
import { LooiIcon, type LooiIconName } from "../components/LooiIcon.js";
import { correctDemoMemory, createDemoMemoryClaims, removeDemoMemoryItem } from "./space-demo-state.js";
import { DesktopEvidenceDiagram } from "../components/DesktopEvidenceDiagram.js";
import { humanizeEpistemicStatus, humanizeMemorySource } from "../humanize.js";

export interface MemoriesSpaceViewProps {
  controller: MemoriesConformalSpaceController;
  onChange?: () => void;
  onNotify?: (message: string) => void;
  onForget?: (id: string) => Promise<void>;
  onCorrect?: (id: string, location: string) => Promise<void>;
  canCorrect?: boolean;
}

type Filter = "all" | "confirmed" | "observed" | "inferred";
const filters: { value: Filter; label: string }[] = [
  { value: "all", label: "全部" }, { value: "confirmed", label: "已确认事实" },
  { value: "observed", label: "观察记录" }, { value: "inferred", label: "推测" },
];
const store = new WeakMap<MemoriesConformalSpaceController, MemoryClaim[]>();
export function getMemorySpaceSummary(controller: MemoriesConformalSpaceController): { memoryCount: number } {
  const claims = store.get(controller) ?? createDemoMemoryClaims();
  store.set(controller, claims);
  return { memoryCount: claims.length };
}
export function syncMemorySpaceFromHub(controller: MemoriesConformalSpaceController, items: HubMemoryItem[]): void {
  if (!Array.isArray(items)) return;
  const converted = items.map((item) =>
    createMemoryClaim({
      claim_id: `claim_${item.id}`,
      predicate: item.category === "item_location" ? "object_last_seen" : "personal_note",
      object: {
        target: item.subject || item.fact.slice(0, 16),
        location: item.location || "个人备忘",
        text: item.fact,
      },
      status: "confirmed",
      source_kind: "authenticated_user_statement",
      evidence_ids: [`ev_${item.id}`],
      derivation_roots: [`root_${item.id}`],
      observed_at: item.updatedAt,
      source_availability: "retained",
    })
  );
  store.set(controller, converted);
}
function objectValue(claim: MemoryClaim, key: string): string {
  const object = claim.object;
  return object !== null && typeof object === "object" && !Array.isArray(object) ? String(object[key] ?? "") : "";
}

function MemoryAction({ icon, label, danger, onPress, disabled = false, compact = false }: { icon: LooiIconName; label: string; danger?: boolean; onPress: () => void; disabled?: boolean; compact?: boolean }) {
  const color = danger ? P.alertCoral : P.textPrimary;
  return <Pressable accessibilityRole="button" hitSlop={{ top: 4, bottom: 4 }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [styles.action, compact && styles.compactAction, danger && styles.dangerAction, { opacity: disabled ? 0.4 : pressed ? 0.78 : 1, transform: [{ scale: pressed ? 0.97 : 1 }] }]}>
    <LooiIcon name={icon} size={compact ? 13 : 18} color={color} /><Text style={[styles.actionText, compact && styles.compactActionText, { color }]}>{label}</Text>
  </Pressable>;
}

export function MemoriesSpaceView({ controller, onChange, onNotify, onForget, onCorrect, canCorrect = true }: MemoriesSpaceViewProps) {
  const { width, height, fontScale } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const wide = width >= 700 && fontScale < 1.7;
  const short = wide && height < 480;
  const [localClaims, setClaims] = useState(() => {
    const initial = store.get(controller) ?? createDemoMemoryClaims();
    store.set(controller, initial);
    return initial;
  });
  const claims = store.get(controller) ?? localClaims;
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(() => controller.getSelectedClaimId() ?? claims[0]?.claim_id ?? null);
  const rootFrame = useRef<View>(null);
  const [keyboardOffset, setKeyboardOffset] = useState(0);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const inspectorScroll = useRef<ScrollView>(null);
  const [activePane, setActivePane] = useState<"timeline" | "evidence">("timeline");
  const [choosingLocation, setChoosingLocation] = useState(false);
  const [locationDraft, setLocationDraft] = useState("");
  const compactEditor = short && choosingLocation;
  const focusedEditor = choosingLocation && (wide || activePane === "evidence") && (short || keyboardVisible);
  const measureKeyboardOffset = () => rootFrame.current?.measureInWindow((_x, y) => setKeyboardOffset(Math.max(0, y)));
  const visibleClaims = useMemo(() => claims.filter((claim) => (filter === "all" || claim.status === filter) && `${objectValue(claim, "target")} ${objectValue(claim, "location")}`.toLowerCase().includes(query.trim().toLowerCase())), [claims, filter, query]);
  const selected = visibleClaims.find((claim) => claim.claim_id === selectedId) ?? visibleClaims[0];
  const card = selected ? controller.formatClaimCard(selected) : null;

  useEffect(() => {
    const show = Keyboard.addListener(Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow", () => {
      setKeyboardVisible(true);
      measureKeyboardOffset();
    });
    const hide = Keyboard.addListener(Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide", () => setKeyboardVisible(false));
    return () => { show.remove(); hide.remove(); };
  }, []);

  const changeRef = useRef(onChange);
  useEffect(() => {
    changeRef.current = onChange;
  }, [onChange]);
  useEffect(() => {
    if (selected) {
      controller.selectMemoryCard(controller.formatClaimCard(selected));
    } else {
      controller.clearMemorySelection();
    }
    changeRef.current?.();
    setChoosingLocation(false);
  }, [controller, selected]);

  useEffect(() => {
    if (!choosingLocation) return;
    const frame = requestAnimationFrame(() => inspectorScroll.current?.scrollTo({ y: 0, animated: true }));
    return () => cancelAnimationFrame(frame);
  }, [choosingLocation, activePane, keyboardVisible]);

  const updateClaims = (next: MemoryClaim[]) => { store.set(controller, next); setClaims(next); onChange?.(); };
  const correctLocation = (location: string) => {
    if (!selected || !location.trim()) return;
    const cleanLocation = location.trim();
    if (onCorrect) {
      void onCorrect(selected.claim_id.replace(/^claim_/, ""), cleanLocation).then(() => { setChoosingLocation(false); Keyboard.dismiss(); onNotify?.("本机记忆的位置已更新"); }).catch(() => onNotify?.("修改未保存，请重试"));
      return;
    }
    controller.triggerLocationCorrection(selected.claim_id, cleanLocation);
    const updated = correctDemoMemory(selected, cleanLocation);
    updateClaims(claims.map((claim) => claim.claim_id === selected.claim_id ? updated : claim));
    setChoosingLocation(false);
    Keyboard.dismiss();
    onNotify?.(`主人已确认新位置：${cleanLocation} · 演示记录第 ${updated.revision} 版`);
  };

  const memoryActions = selected && card ? <View style={[styles.memoryActions, styles.compactActions]}>
    <MemoryAction compact disabled={!canCorrect} icon="edit" label={canCorrect ? choosingLocation ? "取消修改" : "不是这里" : "请在 Hub 更正"} onPress={() => { setLocationDraft(card.whereText); setActivePane("evidence"); setChoosingLocation((value) => !value); inspectorScroll.current?.scrollTo({ y: 0, animated: true }); }} />
    <MemoryAction compact icon="box" label="已经拿走了" disabled={selected.status === "retracted"} onPress={() => {
      if (onForget) { void onForget(selected.claim_id.replace(/^claim_/, "")).then(() => onNotify?.("旧位置已从本机记忆撤回")).catch(() => onNotify?.("撤回未保存，请重试")); return; }
      controller.triggerItemRemoved(selected.claim_id);
      updateClaims(claims.map((claim) => claim.claim_id === selected.claim_id ? removeDemoMemoryItem(claim) : claim));
      onNotify?.("演示记忆已撤回 旧位置不再有效");
    }} />
    <View style={[styles.destructiveSection, styles.compactDestructiveSection]}><MemoryAction compact icon="trash" label="忘掉这条" danger onPress={() => {
      if (onForget) { void onForget(selected.claim_id.replace(/^claim_/, "")).then(() => { setSelectedId(null); onNotify?.("已从本机记忆删除"); }).catch(() => onNotify?.("删除未保存，请重试")); return; }
      controller.triggerForgetMemory(selected.claim_id);
      updateClaims(claims.filter((claim) => claim.claim_id !== selected.claim_id));
      setSelectedId(null);
      onNotify?.("已从本地演示账本删除此条记忆");
    }} /></View>
  </View> : null;

  return <View ref={rootFrame} onLayout={measureKeyboardOffset} style={styles.keyboardFrame}>
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={keyboardOffset} style={[styles.root, short && styles.shortRoot]}>
    <View style={[styles.toolbarCard, wide && styles.wideToolbar, short && styles.shortToolbar, focusedEditor && styles.hiddenToolbar]}>
      <View style={[styles.search, wide && styles.wideSearch]}>
        <LooiIcon name="search" size={17} color={P.textSecondary} />
        <TextInput value={query} onChangeText={setQuery} placeholder="搜索物品或位置" placeholderTextColor={P.textMuted} accessibilityLabel="搜索记忆内容" style={[styles.searchInput, wide && styles.wideSearchInput]} />
        {query.length > 0 && <Pressable accessibilityRole="button" accessibilityLabel="清空记忆搜索" onPress={() => setQuery("")} style={styles.clearSearch}><Text style={styles.clearSearchText}>×</Text></Pressable>}
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" style={[styles.filterScroll, wide && styles.wideFilterScroll]} contentContainerStyle={[styles.filters, wide && styles.wideFilters]}>{filters.map((item) => <Pressable key={item.value} hitSlop={{ top: 4, bottom: 4 }} accessibilityRole="button" accessibilityState={{ selected: filter === item.value }} onPress={() => setFilter(item.value)} style={({ pressed }) => [styles.filter, wide && styles.wideFilter, filter === item.value && styles.selectedFilter, { opacity: pressed ? 0.78 : 1, transform: [{ scale: pressed ? 0.97 : 1 }] }]}><Text style={[styles.filterText, wide && styles.wideFilterText, filter === item.value && styles.activeText]}>{item.label} {claims.filter((claim) => item.value === "all" || claim.status === item.value).length}</Text></Pressable>)}</ScrollView>
    </View>
    {!wide && !focusedEditor && <View style={styles.paneTabs} accessibilityRole="tablist">
      <Pressable accessibilityRole="tab" accessibilityState={{ selected: activePane === "timeline" }} onPress={() => setActivePane("timeline")} style={[styles.paneTab, activePane === "timeline" && styles.selectedFilter]}><Text style={[styles.paneTabText, activePane === "timeline" && styles.activeText]}>记忆时间轴 ({visibleClaims.length})</Text></Pressable>
      <Pressable accessibilityRole="tab" accessibilityState={{ selected: activePane === "evidence" }} onPress={() => setActivePane("evidence")} style={[styles.paneTab, activePane === "evidence" && styles.selectedFilter]}><Text numberOfLines={1} style={[styles.paneTabText, activePane === "evidence" && styles.activeText]}>证据检视{selected ? ` · ${objectValue(selected, "target")}` : ""}</Text></Pressable>
    </View>}
    <View style={styles.columns}>
      {(wide || activePane === "timeline") && <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" style={[styles.column, wide && styles.timelineColumn]} contentContainerStyle={[styles.listContent, { paddingBottom: short ? 0 : Math.max(16, insets.bottom + 6) }]}>
        <View style={styles.timeline}>
          <View pointerEvents="none" style={styles.timelineThread} />
          {visibleClaims.map((claim) => {
            const formatted = controller.formatClaimCard(claim);
            const badge = humanizeEpistemicStatus(claim.status);
            const isSelected = selected?.claim_id === claim.claim_id;
            return <View key={claim.claim_id} style={styles.timelineEntry}>
              <View pointerEvents="none" style={[styles.timelineNode, isSelected && styles.timelineNodeActive]} /><View pointerEvents="none" style={styles.timelineLink} />
              <Pressable accessibilityRole="button" accessibilityLabel={`查看${objectValue(claim, "target")}证据`} accessibilityState={{ selected: isSelected }} onPress={() => { setSelectedId(claim.claim_id); setChoosingLocation(false); if (!wide) setActivePane("evidence"); }} style={({ pressed }) => [styles.memoryCard, short && styles.shortMemoryCard, isSelected && styles.selectedCard, { opacity: pressed ? 0.82 : 1, transform: [{ scale: pressed ? 0.985 : 1 }] }]}>
                <View style={styles.memoryHeadline}>
                  <View style={[styles.memoryIconBox, isSelected && styles.memoryIconBoxActive]}>
                    <LooiIcon name="box" size={13} color={isSelected ? P.presenceCyan : P.textSecondary} />
                  </View>
                  <Text numberOfLines={1} style={styles.memoryQuote}><Text style={styles.memoryTarget}>{objectValue(claim, "target")}</Text>  <Text style={styles.memoryWhere}>{claim.status === "retracted" ? "原记录：" : "“"}{formatted.whereText}{claim.status === "retracted" ? "" : "”"}</Text></Text>
                  <Text style={[styles.badge, { color: badge.color, borderColor: badge.color, backgroundColor: `${badge.color}14` }]}>{badge.label}</Text>
                </View>
                <Text numberOfLines={1} style={styles.sourceText}>{humanizeMemorySource(claim.source_kind)} · {formatted.whenText}{claim.source_availability === "source_expired" ? " · 原图已过期" : ""}</Text>
              </Pressable>
              {!wide && isSelected && <Pressable accessibilityRole="button" onPress={() => setActivePane("evidence")} style={styles.evidenceAction}><Text style={styles.activeText}>查看证据与纠错 →</Text></Pressable>}
            </View>;
          })}
        </View>
        {visibleClaims.length === 0 && <View style={styles.empty}><LooiIcon name="book" size={28} color={P.textMuted} /><Text style={styles.body}>没有符合筛选条件的记忆</Text></View>}
      </ScrollView>}
      {(wide || activePane === "evidence") && <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" ref={inspectorScroll} style={[styles.column, wide && styles.evidenceColumn]} contentContainerStyle={[styles.inspectorContent, { paddingBottom: short ? 0 : Math.max(16, insets.bottom + 6) }]}>
        {selected && card ? <View style={[styles.inspector, short && styles.shortInspector, compactEditor && styles.editingInspector]}>
          {!wide && <Pressable accessibilityRole="button" onPress={() => { setChoosingLocation(false); setActivePane("timeline"); Keyboard.dismiss(); }} style={styles.backToTimeline}><Text style={styles.activeText}>← 返回记忆时间轴</Text></Pressable>}
          {choosingLocation && <View style={[styles.locationPicker, compactEditor && styles.compactLocationPicker]}>
            <View style={[styles.locationEntry, compactEditor && styles.compactLocationEntry]}>
            <TextInput autoFocus accessibilityLabel="编辑记忆位置" value={locationDraft} onChangeText={setLocationDraft} placeholder="例如：书架第二层" placeholderTextColor={P.textMuted} style={[styles.locationInput, compactEditor && styles.compactLocationInput]} returnKeyType="done" onSubmitEditing={() => correctLocation(locationDraft)} />
            <View style={styles.locationEditorActions}>
              <View style={compactEditor ? styles.compactConfirm : styles.locationConfirm}><MemoryAction icon="check" label="确认新位置" disabled={!locationDraft.trim()} onPress={() => correctLocation(locationDraft)} /></View>
              <Pressable accessibilityRole="button" accessibilityLabel="取消位置修改" onPress={() => setChoosingLocation(false)} style={styles.cancelLocationBtn}><Text style={styles.activeText}>取消</Text></Pressable>
            </View>
            </View>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={styles.locationPresets}>{["书架第 2 层", "右侧抽屉", "显示器右侧", "书桌键盘左侧", "显示器右下方", "书架第二层", "右侧抽屉里"].filter((location) => location !== card.whereText).map((location) => <Pressable key={location} accessibilityRole="button" accessibilityLabel={`将位置改为${location}`} onPress={() => correctLocation(location)} style={styles.locationPreset}><Text style={styles.small}>{location}</Text></Pressable>)}</ScrollView>
          </View>}
          <View style={styles.inspectorHeader}><LooiIcon name="eye" size={16} color={P.presenceCyan} /><Text numberOfLines={1} style={styles.cardTitle}>记忆证据 · {objectValue(selected, "target")}</Text><Text numberOfLines={1} style={styles.evidenceBadge}>v{selected.revision} · {selected.evidence_ids[0] || "摘要"}{selected.source_availability === "source_expired" ? " · 原图已过期" : ""}</Text></View>
          <DesktopEvidenceDiagram compact={short} location={card.whereText} itemTitle={objectValue(selected, "target")} removed={selected.status === "retracted"} />
          <View style={styles.dimensions}>{[
            ["观察时间", card.whenText, "clock"], ["空间位置", selected.status === "retracted" ? "已拿走 · 旧位置失效" : card.whereText, "radar"],
            ["记忆依据", humanizeMemorySource(selected.source_kind), "mic"], ["认识边界", humanizeEpistemicStatus(selected.status).label, "shield"],
          ].map(([label, text, icon]) => <View key={label} style={[styles.question, short && styles.shortQuestion]}><View style={styles.row}><LooiIcon name={icon as LooiIconName} size={14} color={P.presenceCyan} /><Text style={styles.questionLabel}>{label}</Text></View><Text style={[styles.questionValue, short && styles.shortQuestionValue]}>{text}</Text></View>)}</View>
          {memoryActions}
        </View> : <View style={styles.empty}><Text style={styles.body}>选中一条记忆，查看它的来处</Text></View>}
      </ScrollView>}
    </View>
  </KeyboardAvoidingView>
  </View>;
}

const styles = StyleSheet.create({
  keyboardFrame: { flex: 1, minHeight: 0 }, hiddenToolbar: { display: "none" },
  root: { flex: 1, minHeight: 0, gap: 8 }, shortRoot: { gap: 6 },
  toolbarCard: { gap: 4 }, wideToolbar: { flexDirection: "row", alignItems: "center", gap: 8 },
  shortToolbar: { paddingVertical: 0, paddingHorizontal: 0, backgroundColor: "transparent", gap: 8 },
  search: { minWidth: 0, flexDirection: "row", alignItems: "center", gap: 8, borderWidth: 1, borderColor: P.lineSubtle, backgroundColor: "rgba(6, 15, 26, 0.85)", borderRadius: 12, paddingHorizontal: 12, minHeight: 44 },
  wideSearch: { flex: 1, minWidth: 120, minHeight: 44, paddingVertical: 0, paddingHorizontal: 12 },
  searchInput: { flex: 1, minWidth: 0, minHeight: 44, paddingVertical: 0, color: P.textPrimary, fontSize: 13 }, wideSearchInput: { minHeight: 44, paddingVertical: 0, fontSize: 13 },
  clearSearch: { width: 44, height: 44, alignItems: "center", justifyContent: "center" }, clearSearchText: { color: P.textSecondary, fontSize: 24 },
  filterScroll: { flexGrow: 0 }, wideFilterScroll: { flexShrink: 1 },
  filters: { flexDirection: "row", gap: 6, paddingVertical: 4 }, wideFilters: { flexWrap: "nowrap", gap: 6 },
  filter: { minHeight: 36, justifyContent: "center", borderRadius: 12, borderWidth: 1, borderColor: P.lineSubtle, paddingHorizontal: 11, backgroundColor: P.surfaceGlass }, wideFilter: { minHeight: 36, paddingHorizontal: 10 },
  selectedFilter: { borderColor: P.presenceCyan, backgroundColor: "rgba(40,213,255,0.14)", boxShadow: "inset 0 0 10px rgba(40,213,255,0.1)" }, filterText: { color: P.textSecondary, fontSize: 12, fontWeight: "500" }, wideFilterText: { fontSize: 11.5 }, activeText: { color: P.presenceCyan, fontWeight: "700" },
  paneTabs: { flexDirection: "row", gap: 8, minHeight: 44 }, paneTab: { flex: 1, minHeight: 44, borderRadius: 12, borderWidth: 1, borderColor: P.lineSubtle, backgroundColor: P.surfaceGlass, alignItems: "center", justifyContent: "center", paddingHorizontal: 8 }, paneTabText: { color: P.textSecondary, fontSize: 12, flexShrink: 1 },
  columns: { flex: 1, minHeight: 0, flexDirection: "row", gap: 10 }, column: { flex: 1, minWidth: 0 }, timelineColumn: { flex: 0.92 }, evidenceColumn: { flex: 1.08 }, listContent: { flexGrow: 1, justifyContent: "space-between", gap: 6 }, inspectorContent: { flexGrow: 1, gap: 6 },
  timeline: { flexGrow: 1, justifyContent: "space-between", paddingLeft: 12, gap: 6 }, timelineThread: { position: "absolute", left: 3, top: 20, bottom: 20, width: 1.5, backgroundColor: "rgba(40,213,255,0.28)" }, timelineEntry: { position: "relative" },
  timelineNode: { position: "absolute", top: 24, left: -12, width: 7, height: 7, borderRadius: 4, backgroundColor: "#1B6B93", borderWidth: 1, borderColor: "rgba(40,213,255,0.4)" }, timelineNodeActive: { backgroundColor: P.presenceCyan, boxShadow: "0 0 8px rgba(40,213,255,0.8)" }, timelineLink: { position: "absolute", left: -5, top: 27, width: 5, height: 1, backgroundColor: P.lineActive },
  memoryCard: { minHeight: 54, borderWidth: 1, borderColor: P.lineSubtle, backgroundColor: P.surfaceGlass, borderRadius: 12, paddingVertical: 8, paddingHorizontal: 10, gap: 3, justifyContent: "center" }, shortMemoryCard: { paddingVertical: 8, paddingHorizontal: 10, gap: 3 }, selectedCard: { borderColor: P.presenceCyan, backgroundColor: "rgba(40,213,255,0.08)", experimental_backgroundImage: "linear-gradient(135deg, rgba(40,213,255,0.15) 0%, rgba(10,24,40,0.88) 100%)", boxShadow: "0 4px 14px rgba(0,0,0,0.22), inset 0 1px 0 rgba(164,224,255,0.18)" },
  memoryHeadline: { flexDirection: "row", alignItems: "center", gap: 7 }, memoryIconBox: { width: 22, height: 22, borderRadius: 7, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(15, 32, 50, 0.75)", borderWidth: 1, borderColor: "rgba(84, 167, 255, 0.18)" }, memoryIconBoxActive: { borderColor: "rgba(40, 213, 255, 0.45)", backgroundColor: "rgba(40, 213, 255, 0.14)" }, memoryTarget: { fontWeight: "700", fontSize: 13, color: P.textPrimary }, memoryWhere: { color: "#A5D8F3", fontWeight: "500" }, memoryQuote: { flex: 1, color: P.textPrimary, fontSize: 12, lineHeight: 18 }, sourceText: { color: P.textSecondary, fontSize: 10.5, lineHeight: 16, paddingLeft: 29 },
  badge: { borderWidth: 1, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2, fontSize: 9.5, lineHeight: 13, fontWeight: "600", overflow: "hidden" },
  inspector: { flexGrow: 1, justifyContent: "space-between", backgroundColor: P.surfaceGlass, borderWidth: 1, borderColor: P.lineSubtle, borderRadius: 14, padding: 8, gap: 6, experimental_backgroundImage: "linear-gradient(160deg, rgba(20, 48, 76, 0.28) 0%, rgba(7, 17, 29, 0.90) 100%)" }, shortInspector: { padding: 8, gap: 6 }, inspectorHeader: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 22 },
  cardTitle: { color: P.textPrimary, fontSize: 13.5, lineHeight: 18, fontWeight: "700", flexShrink: 1 }, evidenceBadge: { marginLeft: "auto", maxWidth: "49%", color: P.presenceCyan, fontSize: 9.5, lineHeight: 14, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2, borderWidth: 1, borderColor: "rgba(40,213,255,0.22)", backgroundColor: "rgba(40,213,255,0.06)" },
  memoryActions: { flexDirection: "row", gap: 6 }, compactActions: { flexDirection: "row", gap: 6 }, destructiveSection: { flex: 1 }, compactDestructiveSection: { flex: 1, paddingLeft: 4, borderLeftWidth: 1, borderLeftColor: "rgba(250,142,134,0.2)" },
  action: { minHeight: 44, borderRadius: 10, borderWidth: 1, borderColor: "rgba(40,213,255,0.38)", backgroundColor: "rgba(40,213,255,0.10)", paddingHorizontal: 8, paddingVertical: 4, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 5 },
  compactAction: { flex: 1, minHeight: 44, paddingVertical: 4, paddingHorizontal: 6, gap: 4 }, actionText: { fontSize: 12, fontWeight: "600", flexShrink: 1 }, compactActionText: { fontSize: 11, fontWeight: "600" }, dangerAction: { borderColor: "rgba(250,142,134,0.48)", backgroundColor: "rgba(250,142,134,0.08)" },
  dimensions: { flexDirection: "row", flexWrap: "wrap", gap: 6 }, question: { flexGrow: 1, flexBasis: "48%", minWidth: 0, paddingVertical: 5, paddingHorizontal: 8, borderRadius: 9, borderWidth: 1, borderColor: "rgba(84,167,255,0.14)", backgroundColor: "rgba(8, 20, 34, 0.72)", gap: 2 }, shortQuestion: { paddingVertical: 5, paddingHorizontal: 8 }, row: { flexDirection: "row", alignItems: "center", gap: 5 }, questionLabel: { fontSize: 10, lineHeight: 13, color: P.textSecondary }, questionValue: { fontSize: 11.5, lineHeight: 14, fontWeight: "600", color: P.textPrimary }, shortQuestionValue: { fontSize: 11, lineHeight: 13 },
  editingInspector: { padding: 0 }, locationPicker: { gap: 6, padding: 4, borderWidth: 1, borderColor: P.lineSubtle, borderRadius: 9 }, compactLocationPicker: { padding: 4, gap: 8 }, locationEntry: { gap: 6 }, compactLocationEntry: { flexDirection: "row", alignItems: "center" },
  locationInput: { minHeight: 44, paddingHorizontal: 8, borderRadius: 8, borderWidth: 1, borderColor: P.lineActive, color: P.textPrimary, backgroundColor: P.bgDeep, fontSize: 13 }, compactLocationInput: { flex: 1, minWidth: 0 },
  locationEditorActions: { flexDirection: "row", alignItems: "center", gap: 4 }, locationConfirm: { flex: 1 }, compactConfirm: { width: 136 }, cancelLocationBtn: { minHeight: 44, minWidth: 44, paddingHorizontal: 14, alignItems: "center", justifyContent: "center" }, locationPresets: { flexDirection: "row", gap: 6 }, locationPreset: { minHeight: 44, justifyContent: "center", paddingHorizontal: 8, borderRadius: 8, backgroundColor: P.surfaceGlass },
  backToTimeline: { minHeight: 44, justifyContent: "center", alignSelf: "stretch", paddingHorizontal: 4 }, evidenceAction: { minHeight: 44, marginTop: 4, borderRadius: 9, borderWidth: 1, borderColor: P.lineActive, alignItems: "center", justifyContent: "center" },
  small: { color: P.textMuted, fontSize: 11, lineHeight: 16 }, body: { color: P.textSecondary, fontSize: 13, lineHeight: 20 }, empty: { padding: 25, gap: 12, alignItems: "center" },
});
