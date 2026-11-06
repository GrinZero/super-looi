import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import { BrightnessGesture } from "../src/ui/brightness-gesture.js";

const source = (path: string) => readFileSync(new URL(`../src/ui/${path}`, import.meta.url), "utf8");

// Read the actual style values so density checks fail when dimensions regress.
function stylesFor(path: string): Record<string, Record<string, string | number>> {
  const stylesheet = source(path).split("const styles = StyleSheet.create(")[1];
  assert.ok(stylesheet, `missing stylesheet in ${path}`);
  return runInNewContext(`(${stylesheet.replace(/\);\s*$/u, "")})`, { P: {} });
}
const homeStyles = stylesFor("spaces/HomeSpaceView.tsx");
const sliderStyles = stylesFor("components/BrightnessSliderBar.tsx");
const size = (styles: typeof homeStyles, name: string, property: string): number => {
  const value = styles[name]?.[property];
  assert.equal(typeof value, "number", `${name}.${property} must be an explicit dimension`);
  return Number(value);
};

describe("RSI Home slider interaction invariants", () => {
  it("leaves initial and vertical movements available to the surrounding scroll view", () => {
    const gesture = new BrightnessGesture();
    gesture.start(200, 100, 50);
    assert.equal(gesture.canClaim(0, 0), false);
    assert.equal(gesture.canClaim(5, 0), false);
    assert.equal(gesture.canClaim(7, 12), false);
    assert.equal(gesture.canClaim(8, 4), true);
  });

  it("commits a stationary tap using its location inside the track, not screen coordinates", () => {
    const gesture = new BrightnessGesture();
    gesture.start(350, 100, 100);
    assert.equal(gesture.release(350, 100, 200), 128);
    assert.equal(gesture.release(350, 100, 200), null, "native touch and responder release cannot double-submit");
  });

  it("includes movement before responder grant in the live drag target", () => {
    const gesture = new BrightnessGesture();
    gesture.start(300, 100, 50);
    gesture.move(310, 102);
    gesture.claim();
    assert.equal(gesture.targetAt(350, 200), 128);
    assert.equal(gesture.release(350, 103, 200), 128);
  });

  it("never commits a vertical scroll, even if it later changes into horizontal movement", () => {
    const gesture = new BrightnessGesture();
    gesture.start(200, 100, 50);
    gesture.move(202, 120);
    assert.equal(gesture.canClaim(100, 20), false);
    gesture.claim();
    assert.equal(gesture.release(300, 120, 200), null);
  });

  it("cancels a horizontal drag when the user turns vertically", () => {
    const gesture = new BrightnessGesture();
    gesture.start(200, 100, 50);
    gesture.move(220, 102);
    gesture.claim();
    gesture.move(220, 160);
    assert.equal(gesture.release(220, 160, 200), null);
  });

  it("termination, disabling, or unmount cancellation never submits a target", () => {
    const gesture = new BrightnessGesture();
    gesture.start(200, 100, 50);
    gesture.claim();
    gesture.cancel();
    assert.equal(gesture.release(240, 100, 200), null);
    gesture.start(200, 100, 50);
    assert.equal(gesture.release(200, 100, 200), 64, "a fresh touch recovers normally");
  });

  it("does not treat a wandering touch that returns to its origin as a tap", () => {
    const gesture = new BrightnessGesture();
    gesture.start(200, 100, 50);
    gesture.move(208, 100);
    assert.equal(gesture.release(200, 100, 200), null);
  });

  it("clamps drag targets at both ends of the track", () => {
    const gesture = new BrightnessGesture();
    gesture.start(200, 100, 50);
    assert.equal(gesture.targetAt(-100, 200), 1);
    assert.equal(gesture.targetAt(800, 200), 255);
  });

  it("connects scroll locking and feedback reveal to the mounted Home scroll view", () => {
    const home = source("spaces/HomeSpaceView.tsx");
    assert.match(home, /scrollEnabled=\{!sliderDragging\}/u);
    assert.match(home, /isLight && <BrightnessSliderBar onDragStateChange=\{setSliderDragging\}/u);
    assert.match(home, /keyboardShouldPersistTaps="handled"/u);
    assert.match(home, /onContentSizeChange=/u);
    assert.match(home, /scrollRef\.current\?\.scrollTo\(\{ y: Math\.max\(0, y - 8\), animated: true \}\)/u);
    for (const kind of ["conflict", "gate", "proposal"]) {
      assert.ok(home.includes(`feedbackDidLayout("${kind}", nativeEvent.layout.y)`));
      assert.ok(home.includes(`requestFeedbackScroll("${kind}")`));
    }
    assert.match(home, /feedbackScrollPending\.current === target/u);
  });

  it("keeps five accessible presets with effective 44-point targets below a full-width adjustable track", () => {
    const slider = source("components/BrightnessSliderBar.tsx");
    const toggle = source("components/ToggleSwitch.tsx");
    assert.match(slider, /quickSteps = \[20, 40, 60, 80, 100\]/u);
    assert.ok(slider.includes('accessibilityLabel={`${label}设为 ${step}%`}'));
    assert.match(slider, /accessibilityRole="adjustable"/u);
    assert.match(slider, /accessibilityActions=\{\[\{ name: "increment"[\s\S]*name: "decrement"/u);
    assert.ok(size(sliderStyles, "touchTrack", "minHeight") >= 44);
    assert.ok(size(sliderStyles, "compactTouchTrack", "minWidth") >= 120);
    assert.ok(size(sliderStyles, "compactStep", "minHeight") + 12 >= 40);
    assert.ok(size(sliderStyles, "compactStep", "minWidth") >= 44);
    assert.equal(size(sliderStyles, "compactStep", "flex"), 1);
    assert.match(toggle, /compactTouchTarget: \{ width: 48, minWidth: 48, minHeight: 44/u);
    assert.match(toggle, /pending && styles\.trackPending/u);
  });

  it("gives the compact slider a full-width track row above the five-step preset row", () => {
    const slider = source("components/BrightnessSliderBar.tsx");
    assert.equal(sliderStyles.compactSliderRow.flexDirection, "row");
    assert.equal(sliderStyles.compactSliderRow.alignItems, "center");
    assert.equal(sliderStyles.compactSteps.flexDirection, "row");
    assert.equal(sliderStyles.steps.flexDirection, "row");
    assert.match(slider, /!compact && <View style=\{styles\.heading\}/u);
    assert.match(slider, /compact && <Text pointerEvents="none" style=\{\[styles\.value, styles\.compactValue\]\}>\{percent\}%<\/Text>/u);
    assert.match(slider, /useEffect\(\(\) => \{\s*latest\.current = \{ disabled, onChange, onDragStateChange \};\s*\}, \[disabled, onChange, onDragStateChange\]\)/u);
    assert.match(slider, /if \(!latest\.current\.disabled && target !== null\) latest\.current\.onChange\(target\)/u);
    assert.match(slider, /onPanResponderTerminate: cancelDrag/u);
    assert.match(slider, /onTouchCancel=\{cancelDrag\}/u);
    assert.match(slider, /if \(disabled\) cancelDrag\(\)/u);
    assert.match(slider, /event\.nativeEvent\.touches\.length > 1/u);
  });

  it("places all four compact demo actions in the top bar with their full accessible names", () => {
    const home = source("spaces/HomeSpaceView.tsx");
    const top = home.slice(home.indexOf('<View style={[styles.statusBar,'), home.indexOf('{feedbackKind && <View'));
    assert.match(top, /style=\{\[styles\.statusBar, short && styles\.shortStatusBar\]\}/u);
    assert.ok(top.includes('书房家居 · 网关{online ? "在线" : "离线"}'));
    for (const [label, title] of [
      ["物理与视觉冲突诚实调和演示", "冲突调和"],
      ["记录第3次微调并生成规则晋升提案", "微调提案"],
      ["测试高危门锁域拦截", "门锁拦截"],
    ]) {
      assert.ok(top.includes(`accessibilityLabel="${label}"`));
      assert.ok(top.includes(`>${title}</Text>`));
    }
    assert.ok(top.includes('style={styles.resetPill}'));
    assert.ok(top.includes('>重置演示状态</Text>'));
    assert.equal(top.match(/hitSlop=\{\{ top: 4, bottom: 4 \}\}/gu)?.length, 4);
    assert.equal(homeStyles.shortStatusBar.flexWrap, "nowrap");
    assert.equal(homeStyles.statusBar.flexWrap, "wrap", "portrait can wrap the action group");
    for (const name of ["actionPill", "resetPill"]) {
      const pillHeight = size(homeStyles, name, "minHeight");
      assert.ok(pillHeight >= 36);
      assert.ok(size(homeStyles, "topActions", "minHeight") >= pillHeight + 8);
      assert.ok(size(homeStyles, "topActions", "paddingVertical") >= 4);
    }
  });

  it("shows one latest feedback banner before the grid without losing explicit proposal confirmation", () => {
    const home = source("spaces/HomeSpaceView.tsx");
    const feedbackStart = home.indexOf('{feedbackKind && <View');
    const gridStart = home.indexOf('<View style={[styles.grid,');
    assert.ok(feedbackStart > home.indexOf('<View style={[styles.statusBar,'));
    assert.ok(gridStart > feedbackStart);
    const feedback = home.slice(feedbackStart, gridStart);
    assert.equal(home.match(/accessibilityLiveRegion="polite"/gu)?.length, 1);
    assert.match(home, /setActiveFeedback\(kind\)/u);
    assert.match(home, /activeFeedback === "conflict" && conflict/u);
    assert.match(home, /activeFeedback === "gate" && gateResult/u);
    assert.match(feedback, /key=\{feedbackKind\}/u, "switching kinds lays out the selected banner again");
    assert.match(feedback, /proposal\.status === "proposed" && <View style=\{styles\.confirmActions\}/u);
    assert.match(feedback, /onPress=\{\(\) => \{ setProposal\(model\.confirmProposal\(`user_confirm_\$\{Date\.now\(\)\}`\)\)/u);
    assert.match(feedback, /model\.dismissProposal\(\); setProposal\(model\.getProposal\(\)\)/u);
    for (const title of ["确认设为规则", "暂不启用"]) assert.ok(feedback.includes(`>${title}</Text>`));
    assert.equal(homeStyles.confirmActions.flexDirection, "row");
    assert.ok(size(homeStyles, "confirmAction", "minHeight") >= 44);
    assert.equal(size(homeStyles, "feedbackBar", "paddingVertical"), 6);
    assert.equal(size(homeStyles, "feedbackBar", "paddingHorizontal"), 10);
    assert.doesNotMatch(home, /\{conflict && <View|\{gateResult && <View/u, "feedback states cannot stack");
  });

  it("preserves pending readback, offline uncertainty, and model execution in the dense cards", () => {
    const home = source("spaces/HomeSpaceView.tsx");
    assert.match(home, /if \(inFlight\.current\.has\(entityId\)\) return/u);
    assert.match(home, /const result = await model\.execute\(entityId, target\)/u);
    assert.match(home, /const readback = verified\.includes\(entityId\) && !uncertain && !isPending/u);
    assert.match(home, /!online \? "离线待核实" : isPending \? "等待回读" : uncertain \? "结果待核实"/u);
    assert.match(home, /isPending \? "演示快照 · 待回读"/u);
    assert.match(home, /disabled=\{!online \|\| isPending\} pending=\{isPending \|\| uncertain\}/u);
    assert.match(home, /online \? metric\.value : "待核实"/u);
    assert.match(home, /if \(!online\) \{ onNotify\?\.\("网关离线，无法用旧快照调和当前物理状态"\); return; \}/u);
    assert.match(home, /model\.execute\("lock\.front_door", \{ on: false \}\)/u);
  });

  it("keeps the 2x2 landscape height budget including proposal buttons and bottom safe area", () => {
    const home = source("spaces/HomeSpaceView.tsx");
    assert.match(home, /const short = width >= 700 && height < 480 && fontScale < 1\.3/u);
    assert.match(home, /const compact = width < 660/u);
    assert.equal(homeStyles.grid.flexDirection, "row");
    assert.equal(homeStyles.grid.flexWrap, "wrap");
    assert.equal(homeStyles.card.flexBasis, "48%");
    assert.equal(homeStyles.cardCompact.flexBasis, "100%");
    assert.ok(size(homeStyles, "shortCard", "padding") >= 8);
    assert.ok(size(homeStyles, "shortCard", "padding") <= 10);
    assert.equal(size(homeStyles, "shortCard", "gap"), 4);
    assert.match(home, /useSafeAreaInsets\(\)/u);
    assert.match(home, /paddingBottom: short \? Math\.max\(6, insets\.bottom\) : Math\.max\(16, insets\.bottom \+ 6\)/u);
    const cardChrome = 2 * (size(homeStyles, "shortCard", "padding") + size(homeStyles, "card", "borderWidth"));
    const cardGap = size(homeStyles, "shortCard", "gap");
    const sliderHeight = size(sliderStyles, "compactSliderRow", "minHeight") + size(sliderStyles, "compactControl", "gap") + size(sliderStyles, "compactSteps", "minHeight");
    const topRow = cardChrome + size(homeStyles, "deviceHeader", "minHeight") + sliderHeight + size(homeStyles, "shortPresets", "minHeight") + 2 * cardGap;
    const bottomRow = cardChrome + size(homeStyles, "sensorHeader", "minHeight") + cardGap + size(homeStyles, "metricValue", "lineHeight") + 2 * size(homeStyles, "metricPill", "paddingVertical");
    const feedback = size(homeStyles, "confirmAction", "minHeight") + 2 * (size(homeStyles, "feedbackBar", "paddingVertical") + size(homeStyles, "feedbackBar", "borderWidth"));
    assert.ok(topRow <= 184);
    assert.ok(bottomRow <= 96);
    assert.ok(feedback <= 58);
    const defaultTotal = size(homeStyles, "shortStatusBar", "minHeight") + topRow + bottomRow + size(homeStyles, "shortContent", "gap") + size(homeStyles, "shortGrid", "gap") + 21;
    assert.ok(defaultTotal <= 378, `landscape default content needs ${defaultTotal}pt including the 21pt home indicator inset`);
    assert.equal(homeStyles.presets.flexDirection, "row");
    assert.equal(homeStyles.presets.flexWrap, undefined);
    assert.ok(size(homeStyles, "shortPreset", "minHeight") + 8 >= 44);
    assert.ok(size(homeStyles, "shortPresets", "minHeight") >= size(homeStyles, "shortPreset", "minHeight") + 8);
    assert.ok(size(homeStyles, "presets", "paddingVertical") >= 4);
  });

  it("uses horizontal sensor pills, compact airflow, and no verbose filler in either orientation", () => {
    const home = source("spaces/HomeSpaceView.tsx");
    for (const value of ["23.8°C", "48%", "612ppm", "CO₂", "实测采样 · 演示"]) assert.ok(home.includes(value));
    assert.equal(homeStyles.sensorHeader.flexDirection, "row");
    assert.equal(homeStyles.sensorReadings.flexDirection, "row");
    assert.equal(homeStyles.metricPill.flexDirection, "row");
    assert.match(home, /\[0, 1, 2\]\.map/u);
    assert.equal(homeStyles.airflowArtwork.minHeight, undefined);
    assert.ok(home.includes('{snapshotLabel} · {clock(state.updatedAt)} · {state.brightness}/255'));
    for (const filler of ["独立目标控制", "让书房慢慢", "跟随你的节奏", "展示物理传感器通道", "提案不会自动启用", "光的温度", "styles.description"]) {
      assert.ok(!home.includes(filler), `remove filler: ${filler}`);
    }
  });
});
