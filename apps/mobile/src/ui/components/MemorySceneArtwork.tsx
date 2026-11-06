import { StyleSheet, Text, View } from "react-native";
import { resolveMemorySceneTarget } from "../humanize.js";
import { LooiIcon } from "./LooiIcon.js";

export interface MemorySceneArtworkProps { location: string; itemTitle: string; removed?: boolean; compact?: boolean }

/** A deliberately labelled illustration. It never loads, reconstructs, or implies retained camera evidence. */
export function MemorySceneArtwork({ location, itemTitle, removed = false, compact = false }: MemorySceneArtworkProps) {
  const { zone } = resolveMemorySceneTarget(location, itemTitle);
  const warm = zone === "bookshelf";
  return <View style={[s.scene, compact && s.compactScene, warm && s.warmScene]} accessibilityLabel={`${location}场景插画，非原始画面${removed ? "，原位置已失效" : ""}`}>
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, removed && s.removed]}>
      <View style={s.horizon} /><View style={s.desk} />
      {zone === "keyboard_left" && <>
        <View style={s.keyboard}>
          {Array.from({ length: 32 }, (_, i) => <View key={i} style={[s.keycap, i % 7 === 0 && s.litKey]}><View style={s.keyLegend} /></View>)}
          <View style={s.spacebar} />
        </View>
        <View style={s.metalKey}><View style={s.keyHead}><View style={s.keyHole} /></View><View style={s.keyShaft} /><View style={s.keyToothA} /><View style={s.keyToothB} /></View>
        <View style={s.keyReflection} />
      </>}
      {zone === "monitor_right" && <>
        <View style={s.monitor}><View style={s.display}><View style={s.displayCurve} /><View style={s.displayCurveSmall} /></View><View style={s.monitorChin} /></View>
        <View style={s.monitorStand} /><View style={s.monitorBase} />
        <View style={s.caseShadow} /><View style={s.airpodsCase}><View style={s.caseLid} /><View style={s.caseLight} /></View>
      </>}
      {zone === "bookshelf" && <>
        <View style={s.shelfFrame}>
          <View style={s.bookRow}>{[23, 30, 26, 34, 29].map((height, i) => <View key={i} style={[s.book, { height, backgroundColor: ["#263C49", "#263142", "#4D453B", "#1A3545", "#39424D"][i] }]} />)}</View>
          <View style={s.shelfBoard} /><View style={s.bottomBooks}><View style={s.flatBook} /><View style={[s.flatBook, { width: "80%", backgroundColor: "#344254" }]} /></View><View style={s.shelfBoardBottom} />
        </View>
        <View style={s.mugHandle} /><View style={s.mug}><View style={s.mugLip} /><View style={s.mugHighlight} /></View><View style={s.steam} />
      </>}
      {zone === "drawer_right" && <>
        <View style={s.drawerBack} /><View style={s.drawerInterior}>
          <View style={s.cableOuter}><View style={s.cableMiddle}><View style={s.cableInner} /></View></View>
          <View style={s.cableTail} /><View style={s.cablePlug}><LooiIcon name="sensor" color="#A5E5F5" size={18} /></View>
        </View><View style={s.drawerFront}><View style={s.drawerPull} /></View>
      </>}
    </View>
    <View style={s.caption}><LooiIcon name="eye" color="#8EA4B8" size={11} /><Text style={s.captionText}>场景插画 · 非原始画面</Text></View>
    {removed && <View style={s.removedBadge}><Text style={s.removedText}>物品已拿走 · 原位置失效</Text></View>}
  </View>;
}

const s = StyleSheet.create({
  compactScene: { height: 76, aspectRatio: undefined, padding: 8 },
  scene: { width: "100%", aspectRatio: 16 / 9, borderRadius: 13, overflow: "hidden", backgroundColor: "#03070D", experimental_backgroundImage: "radial-gradient(ellipse at 68% 68%, rgba(0, 119, 255, 0.26) 0%, rgba(3, 7, 13, 0) 72%), linear-gradient(150deg, #111D2C 0%, #03070D 64%)" },
  warmScene: { experimental_backgroundImage: "radial-gradient(ellipse at 65% 56%, rgba(255, 179, 71, 0.2) 0%, rgba(3, 7, 13, 0) 72%), linear-gradient(150deg, #14202A 0%, #06090D 70%)" },
  horizon: { position: "absolute", top: "63%", left: 0, right: 0, height: 1, backgroundColor: "rgba(67, 161, 232, 0.13)" },
  desk: { position: "absolute", top: "64%", bottom: 0, left: 0, right: 0, experimental_backgroundImage: "linear-gradient(180deg, rgba(30, 48, 65, 0.45), rgba(2, 5, 9, 0.6))" },
  keyboard: { position: "absolute", left: "48%", top: "18%", width: "55%", height: "66%", transform: [{ rotate: "-12deg" }], borderWidth: 2, borderColor: "#264568", borderBottomColor: "#31B8FF", borderRadius: 9, backgroundColor: "#08111D", padding: "2%", gap: "3%", flexDirection: "row", flexWrap: "wrap", boxShadow: "0 7px 15px rgba(0, 0, 0, 0.8), 0 2px 9px rgba(25, 140, 255, 0.65)" },
  keycap: { width: "9.5%", height: "16%", borderRadius: 3, backgroundColor: "#1B2B40", borderTopWidth: 1, borderTopColor: "#38506D", borderBottomWidth: 2, borderBottomColor: "#04080E", alignItems: "center", justifyContent: "center" },
  litKey: { backgroundColor: "#164474" }, keyLegend: { width: 3, height: 2, backgroundColor: "#53BFFF", boxShadow: "0 0 4px #209BFF" },
  spacebar: { width: "48%", height: "15%", marginLeft: "20%", borderRadius: 3, backgroundColor: "#21334C", borderBottomWidth: 2, borderBottomColor: "#050A12" },
  metalKey: { position: "absolute", top: "39%", left: "18%", width: "30%", height: "39%", transform: [{ rotate: "35deg" }] },
  keyHead: { position: "absolute", top: 0, left: 0, width: "47%", height: "63%", borderRadius: 10, borderWidth: 2, borderColor: "#C7D5DF", experimental_backgroundImage: "linear-gradient(135deg, #DFE7E9 0%, #758B9E 48%, #BDCBD3 75%, #5C7185 100%)", boxShadow: "0 5px 8px rgba(0, 0, 0, 0.85), 0 0 9px rgba(118, 204, 255, 0.25)" },
  keyHole: { position: "absolute", top: "15%", left: "20%", width: "36%", height: "32%", borderRadius: 12, backgroundColor: "#0A121E", borderWidth: 1, borderColor: "#D6E4EB" },
  keyShaft: { position: "absolute", top: "24%", left: "41%", width: "54%", height: "21%", backgroundColor: "#AABDCB", borderWidth: 1, borderColor: "#DBE4EB", borderRadius: 2 },
  keyToothA: { position: "absolute", left: "64%", top: "38%", height: "18%", width: "10%", backgroundColor: "#9BADBC" }, keyToothB: { position: "absolute", left: "83%", top: "38%", height: "18%", width: "10%", backgroundColor: "#B9C9D5" },
  keyReflection: { position: "absolute", left: "15%", top: "84%", width: "33%", height: "5%", borderRadius: 40, experimental_backgroundImage: "radial-gradient(ellipse, rgba(110, 191, 233, 0.2), transparent)" },
  monitor: { position: "absolute", left: "7%", top: "8%", width: "68%", height: "55%", borderRadius: 11, borderBottomLeftRadius: 23, borderBottomRightRadius: 23, borderWidth: 3, borderColor: "#1F344A", borderTopColor: "#3F556C", backgroundColor: "#060B12", padding: 4, boxShadow: "0 9px 15px rgba(0, 0, 0, 0.8)" },
  display: { flex: 1, borderRadius: 7, overflow: "hidden", experimental_backgroundImage: "linear-gradient(135deg, #06192B 0%, #133D65 55%, #08101A 100%)" }, displayCurve: { position: "absolute", width: "130%", height: "160%", top: "30%", left: "-10%", borderRadius: 160, borderWidth: 2, borderColor: "#215B9C", transform: [{ rotate: "-14deg" }] }, displayCurveSmall: { position: "absolute", width: "100%", height: "120%", top: "60%", borderRadius: 150, borderWidth: 1, borderColor: "#28A5E0" }, monitorChin: { height: 3, width: "10%", alignSelf: "center", marginTop: 3, backgroundColor: "#39536B" },
  monitorStand: { position: "absolute", left: "36%", top: "62%", width: "8%", height: "17%", experimental_backgroundImage: "linear-gradient(90deg, #0B1119, #273A4A, #0B1119)" }, monitorBase: { position: "absolute", left: "24%", top: "76%", width: "32%", height: "5%", borderRadius: 20, backgroundColor: "#172533", borderTopWidth: 1, borderTopColor: "#3A4B5D" },
  caseShadow: { position: "absolute", left: "60%", top: "84%", width: "28%", height: "7%", borderRadius: 30, experimental_backgroundImage: "radial-gradient(ellipse, rgba(109, 189, 255, 0.5), transparent)" },
  airpodsCase: { position: "absolute", left: "61%", top: "56%", width: "24%", height: "30%", borderRadius: 15, borderWidth: 1, borderColor: "#A9C9E4", experimental_backgroundImage: "linear-gradient(145deg, #F0F7FC 0%, #B7CEE0 38%, #7D9CB8 100%)", boxShadow: "inset 0 2px 3px rgba(255, 255, 255, 0.8), 0 5px 12px #02050B, 0 0 17px rgba(57, 154, 255, 0.3)" }, caseLid: { position: "absolute", top: "32%", height: 1, left: 2, right: 2, backgroundColor: "#6F8DA8" }, caseLight: { position: "absolute", top: "56%", left: "48%", width: 3, height: 3, borderRadius: 2, backgroundColor: "#C2FFE9", boxShadow: "0 0 4px #73FFD1" },
  shelfFrame: { position: "absolute", left: "10%", top: "10%", width: "79%", height: "76%", borderLeftWidth: 5, borderRightWidth: 5, borderColor: "#2E3541", backgroundColor: "rgba(4, 8, 14, 0.45)" }, bookRow: { position: "absolute", top: "5%", left: "10%", flexDirection: "row", alignItems: "flex-end", gap: 5 }, book: { width: 13, borderLeftWidth: 2, borderColor: "rgba(211, 205, 182, 0.22)", borderRadius: 1 }, shelfBoard: { position: "absolute", top: "42%", left: 0, right: 0, height: 5, backgroundColor: "#4A4540", borderTopWidth: 1, borderTopColor: "#71665B", boxShadow: "0 4px 8px #02050B" }, shelfBoardBottom: { position: "absolute", bottom: 0, left: 0, right: 0, height: 6, backgroundColor: "#4A4540", borderTopWidth: 1, borderTopColor: "#7A6C59" }, bottomBooks: { position: "absolute", bottom: "6%", left: "8%", width: "37%", gap: 2 }, flatBook: { width: "100%", height: 11, backgroundColor: "#4B4A44", borderRadius: 2, borderTopWidth: 2, borderTopColor: "#7D7C70" },
  mug: { position: "absolute", left: "59%", top: "49%", width: "17%", height: "34%", borderRadius: 6, borderBottomLeftRadius: 12, borderBottomRightRadius: 12, experimental_backgroundImage: "linear-gradient(90deg, #80664B, #E0B778 45%, #9D7951 90%)", boxShadow: "0 3px 12px rgba(0, 0, 0, 0.8), 0 0 18px rgba(255, 179, 71, 0.15)" }, mugLip: { position: "absolute", top: -2, left: 0, right: 0, height: 9, borderRadius: 20, borderWidth: 2, borderColor: "#C9A578", backgroundColor: "#372B22" }, mugHighlight: { position: "absolute", left: "20%", top: "22%", width: 2, height: "55%", backgroundColor: "rgba(255, 234, 191, 0.45)" }, mugHandle: { position: "absolute", left: "73%", top: "56%", width: "9%", height: "19%", borderRadius: 12, borderWidth: 4, borderColor: "#AA8659" }, steam: { position: "absolute", left: "64%", top: "32%", height: "14%", width: "4%", borderRadius: 20, borderLeftWidth: 1, borderLeftColor: "rgba(255, 228, 188, 0.3)", transform: [{ rotate: "12deg" }] },
  drawerBack: { position: "absolute", left: "11%", top: "13%", width: "78%", height: "58%", borderRadius: 7, borderWidth: 2, borderColor: "#263E54", backgroundColor: "#050B13" }, drawerInterior: { position: "absolute", left: "16%", top: "25%", width: "68%", height: "52%", borderRadius: 6, borderWidth: 2, borderColor: "#273B4E", experimental_backgroundImage: "linear-gradient(140deg, #0B1521, #15283A 65%, #07101B)", boxShadow: "inset 0 6px 10px #02060C" }, drawerFront: { position: "absolute", left: "12%", top: "74%", width: "76%", height: "14%", borderRadius: 5, borderWidth: 1, borderColor: "#3A536B", experimental_backgroundImage: "linear-gradient(180deg, #2B4054, #111D2B)" }, drawerPull: { alignSelf: "center", width: "30%", height: 5, marginTop: 5, borderRadius: 4, backgroundColor: "#7690A4", boxShadow: "0 3px 3px #02060C" },
  cableOuter: { position: "absolute", left: "23%", top: "15%", width: "44%", height: "65%", borderWidth: 3, borderColor: "#8DADC1", borderRadius: 40, alignItems: "center", justifyContent: "center", boxShadow: "0 2px 5px #02050A, 0 0 9px rgba(40, 213, 255, 0.16)" }, cableMiddle: { width: "76%", height: "72%", borderWidth: 3, borderColor: "#7A9CB4", borderRadius: 40, alignItems: "center", justifyContent: "center" }, cableInner: { width: "65%", height: "60%", borderWidth: 2, borderColor: "#6789A4", borderRadius: 30 }, cableTail: { position: "absolute", left: "61%", top: "53%", width: "19%", height: 3, backgroundColor: "#9BBBCF", transform: [{ rotate: "25deg" }] }, cablePlug: { position: "absolute", left: "75%", top: "48%", borderRadius: 3, backgroundColor: "#1B3D53", transform: [{ rotate: "25deg" }] },
  caption: { position: "absolute", left: 8, bottom: 6, flexDirection: "row", alignItems: "center", gap: 4, borderRadius: 5, paddingHorizontal: 5, paddingVertical: 2, backgroundColor: "rgba(2, 5, 10, 0.8)" }, captionText: { fontSize: 9, color: "#91A3B6" }, removed: { opacity: 0.35 }, removedBadge: { position: "absolute", top: 10, right: 8, borderRadius: 6, padding: 6, backgroundColor: "#291B24" }, removedText: { fontSize: 11, color: "#FA8E86" },
});
