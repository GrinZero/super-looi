import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Animated, Easing, StyleSheet, Text, View } from "react-native";
import { resolveMemorySceneTarget } from "../humanize.js";
import { LOOI_PALETTE as P } from "../theme.js";

/** Normalized schematic anchors come from the selected claim, not camera measurements. */
export function DesktopEvidenceDiagram({ location, itemTitle, removed, compact = false }: { location: string; itemTitle: string; removed: boolean; compact?: boolean }) {
  const target = resolveMemorySceneTarget(location, itemTitle);
  const pulse = useRef(new Animated.Value(0)).current;
  const [reduceMotion, setReduceMotion] = useState(true);
  useEffect(() => {
    let active = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => { if (active) setReduceMotion(value); }).catch(() => {});
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduceMotion);
    return () => { active = false; subscription.remove(); };
  }, []);
  useEffect(() => {
    pulse.setValue(0);
    if (reduceMotion || removed) return;
    const animation = Animated.loop(Animated.sequence([
      Animated.timing(pulse, { toValue: 1, duration: 1400, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      Animated.timing(pulse, { toValue: 0, duration: 1400, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
    ]));
    animation.start();
    return () => animation.stop();
  }, [pulse, reduceMotion, removed, location, itemTitle]);
  return <View style={[s.frame, compact && s.compactFrame]}>
    <View style={[s.diagram, compact && s.compactDiagram]} accessibilityLabel={`桌面空间示意图，${removed ? "物品已拿走，旧位置失效" : `当前定位${location}`}，非原始画面`}>
      {Array.from({ length: 7 }, (_, index) => <View key={`h${index}`} style={[s.gridHorizontal, { top: `${12 + index * 12}%` }]} />)}
      {Array.from({ length: 9 }, (_, index) => <View key={`v${index}`} style={[s.gridVertical, { left: `${8 + index * 10}%` }]} />)}
      <View style={s.deskPlane} />
      <View style={s.monitor}><View style={s.screen}><View style={s.screenCurve} /></View><View style={s.monitorLed} /></View>
      <View style={s.monitorStem} /><View style={s.monitorFoot} />
      <View style={s.keyboard}>{Array.from({ length: 24 }, (_, index) => <View key={index} style={s.key} />)}</View>
      <View style={s.bookshelf}>
        <View style={s.books}>{Array.from({ length: 4 }, (_, i) => <View key={i} style={[s.book, { height: 12 + i * 2 }]} />)}</View><View style={s.shelfLine} /><View style={s.shelfLine} />
      </View>
      <View style={s.drawer}><View style={s.drawerHandle} /></View>
      <View style={s.coaster}><View style={s.cup} /></View>
      {!removed && <View pointerEvents="none" testID="memory-scene-active-zone" style={[s.activeZone, { left: `${target.xPercent - 9}%`, top: `${target.yPercent - 12}%` }]} />}
      {!removed && <View testID="memory-scene-target" style={[s.target, compact && s.compactTarget, { left: `${target.xPercent}%`, top: `${target.yPercent}%` }]}>
        <Animated.View style={[s.targetPulse, { opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.6, 0.18] }), transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.8] }) }] }]} />
        <View style={s.targetRing} /><View style={s.crossHorizontal} /><View style={s.crossVertical} /><View style={s.targetCore} />
      </View>}
    </View>
    <View style={s.diagramBar}>
      <View style={s.zoneLegend}>{["键盘左侧", "显示器右侧", "书架", "右侧抽屉"].map((zone) => <Text key={zone} style={s.zoneLabel}>{zone}</Text>)}</View>
      <View style={s.legend}><View style={[s.legendDot, removed && { backgroundColor: P.alertCoral, boxShadow: "none" }]} /><Text numberOfLines={1} style={s.legendText}>{removed ? "物品已拿走 · 不再标注旧位置" : `当前标注 · ${location}`}</Text></View>
    </View>
  </View>;
}

const s = StyleSheet.create({
  compactFrame: { gap: 4 }, compactDiagram: { height: 84, minHeight: 84, aspectRatio: undefined },
  compactTarget: { transform: [{ scale: 0.58 }] },
  diagramBar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 6 }, zoneLegend: { flexDirection: "row", gap: 4 }, zoneLabel: { fontSize: 9, color: P.textSecondary, flexShrink: 1 },
  frame: { gap: 4 }, diagram: { width: "100%", height: 108, aspectRatio: undefined, borderRadius: 15, borderWidth: 1, borderColor: P.lineSubtle, backgroundColor: "#040911", overflow: "hidden", experimental_backgroundImage: "radial-gradient(ellipse at 52% 50%, rgba(30, 92, 146, 0.18), transparent 74%)" },
  gridHorizontal: { position: "absolute", left: "5%", right: "5%", height: 1, backgroundColor: "rgba(92, 148, 194, 0.07)" }, gridVertical: { position: "absolute", top: "8%", bottom: "12%", width: 1, backgroundColor: "rgba(92, 148, 194, 0.07)" },
  deskPlane: { position: "absolute", top: "10%", left: "5%", right: "5%", bottom: "11%", borderWidth: 1, borderColor: "#203446", borderRadius: 11, backgroundColor: "rgba(14, 28, 40, 0.45)" },
  monitor: { position: "absolute", width: "43%", height: "34%", top: "12%", left: "29%", borderWidth: 2, borderColor: "#4A6279", borderBottomColor: "#253B51", borderRadius: 9, padding: 5, backgroundColor: "#101C29", boxShadow: "0 4px 10px #01040A" }, screen: { flex: 1, borderRadius: 5, overflow: "hidden", experimental_backgroundImage: "linear-gradient(125deg, #07101A, #193C61 60%, #0B1928)" }, screenCurve: { position: "absolute", width: "120%", height: "100%", top: "55%", borderRadius: 100, borderWidth: 1, borderColor: "#285E8D" }, monitorLed: { position: "absolute", width: 3, height: 2, bottom: 1, left: "50%", backgroundColor: "#72BDDD" }, monitorStem: { position: "absolute", left: "49%", width: "4%", top: "46%", height: "9%", backgroundColor: "#2F475D" }, monitorFoot: { position: "absolute", left: "41%", width: "20%", top: "54%", height: "2%", borderRadius: 4, backgroundColor: "#39536B" },
  keyboard: { position: "absolute", left: "29%", top: "63%", width: "43%", height: "18%", flexDirection: "row", flexWrap: "wrap", gap: 3, padding: 5, borderWidth: 1, borderColor: "#31577A", borderRadius: 5, backgroundColor: "#0A1420", boxShadow: "0 2px 6px rgba(24, 123, 216, 0.2)" }, key: { width: "8.5%", height: "25%", borderRadius: 2, backgroundColor: "#20364E", borderTopWidth: 1, borderTopColor: "#416889" },
  bookshelf: { position: "absolute", left: "8%", top: "12%", width: "15%", height: "38%", borderWidth: 1, borderColor: "#3A4858", borderRadius: 3, justifyContent: "space-evenly", backgroundColor: "#101A27" }, books: { flexDirection: "row", alignItems: "flex-end", justifyContent: "center", gap: 2 }, book: { width: 5, backgroundColor: "#53677A", borderLeftWidth: 1, borderLeftColor: "#8B9AA6" }, shelfLine: { height: 2, backgroundColor: "#405163" }, drawer: { position: "absolute", left: "79%", top: "76%", width: "15%", height: "12%", borderWidth: 1, borderColor: "#4E6275", borderRadius: 4, alignItems: "center", justifyContent: "center", backgroundColor: "#152437" }, drawerHandle: { width: 13, height: 3, borderRadius: 3, backgroundColor: "#8398AC" }, coaster: { position: "absolute", left: "82%", top: "62%", width: "9%", aspectRatio: 1, borderWidth: 1, borderColor: "#456076", borderRadius: 30, alignItems: "center", justifyContent: "center" }, cup: { width: "62%", height: "62%", borderRadius: 20, borderWidth: 2, borderColor: "#9A8F7F", backgroundColor: "#222222" },
  activeZone: { position: "absolute", width: "18%", height: "24%", borderRadius: 8, borderWidth: 1, borderColor: "rgba(40, 213, 255, 0.65)", backgroundColor: "rgba(40, 213, 255, 0.13)", boxShadow: "0 0 14px rgba(40, 213, 255, 0.25), inset 0 0 10px rgba(40, 213, 255, 0.12)" },
  target: { position: "absolute", marginLeft: -15, marginTop: -15, width: 30, height: 30, alignItems: "center", justifyContent: "center" }, targetPulse: { position: "absolute", width: 30, height: 30, borderWidth: 1, borderRadius: 15, borderColor: P.presenceCyan }, targetRing: { width: 24, height: 24, borderWidth: 1, borderRadius: 12, borderColor: P.presenceCyan, backgroundColor: P.eyeHaloGlow, boxShadow: "0 0 10px rgba(40, 213, 255, 0.6)" }, targetCore: { position: "absolute", width: 5, height: 5, borderRadius: 3, backgroundColor: "#D1F9FF", boxShadow: "0 0 7px #28D5FF" }, crossHorizontal: { position: "absolute", width: 36, height: 1, backgroundColor: P.presenceCyan }, crossVertical: { position: "absolute", width: 1, height: 36, backgroundColor: P.presenceCyan },
  legend: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 4 }, legendDot: { width: 5, height: 5, borderRadius: 3, backgroundColor: P.presenceCyan, boxShadow: "0 0 6px #28D5FF" }, legendText: { color: P.textSecondary, fontSize: 9, lineHeight: 14, flexShrink: 1 },
});
