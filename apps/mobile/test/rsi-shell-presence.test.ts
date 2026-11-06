import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const screen = readFileSync(new URL("../app/index.tsx", import.meta.url), "utf8");
const shell = readFileSync(new URL("../src/ui/components/ConformalDeviceShell.tsx", import.meta.url), "utf8");
const drawer = readFileSync(new URL("../src/ui/components/QuickDrawerModal.tsx", import.meta.url), "utf8");

function styleBody(source: string, name: string) {
  const body = source.match(new RegExp(`\\b${name}: \\{([^}]+)\\}`))?.[1];
  assert.ok(body, `${name} style must exist`);
  return body;
}

function styleNumber(source: string, name: string, property: string) {
  const value = styleBody(source, name).match(new RegExp(`\\b${property}: (\\d+)`))?.[1];
  assert.ok(value, `${name}.${property} must be an explicit dimension`);
  return Number(value);
}
type Gesture = { dx: number; dy: number; vy: number };
type Responder = {
  onMoveShouldSetPanResponder: (_: unknown, gesture: Gesture) => boolean;
  onPanResponderRelease: (_: unknown, gesture: Gesture) => void;
  onPanResponderTerminationRequest: () => boolean;
};

function swipeHarness() {
  const canSwipeOpenDrawerRef = { current: true };
  let opens = 0;
  const openDrawerRef = { current: () => { opens += 1; } };
  const config = screen.slice(screen.indexOf("  const gestures = useMemo"), screen.indexOf("  const selectDrawer ="));
  // Execute the production responder config without importing the native renderer.
  const responder = new Function("useMemo", "PanResponder", "canSwipeOpenDrawerRef", "openDrawerRef", `${config}; return gestures;`)(
    (factory: () => unknown) => factory(), { create: (handlers: Responder) => handlers }, canSwipeOpenDrawerRef, openDrawerRef,
  ) as Responder;
  return { responder, canSwipeOpenDrawerRef, openDrawerRef, opens: () => opens };
}

describe("RSI shell and presence interaction invariants", () => {
  it("never captures an emergency, privacy, or overlay gesture and reads the live guard at release", () => {
    const { responder, canSwipeOpenDrawerRef, opens } = swipeHarness();
    const swipe = { dx: 4, dy: -50, vy: -0.5 };
    assert.equal(responder.onMoveShouldSetPanResponder(null, swipe), true);
    canSwipeOpenDrawerRef.current = false;
    assert.equal(responder.onMoveShouldSetPanResponder(null, swipe), false);
    assert.equal(responder.onPanResponderTerminationRequest(), true);
    responder.onPanResponderRelease(null, swipe);
    assert.equal(opens(), 0);
    assert.match(screen, /canSwipeOpenDrawerRef\.current = !faceState\.isEmergencyStopAvailable && !privacyPaused && !overlayOpen/);
    assert.match(screen, /<View style={StyleSheet\.absoluteFill} \{\.\.\.gestures\.panHandlers\}>\s*<RobotFaceView[^]*?\/>\s*<\/View>/);
  });

  it("opens for a short deliberate vertical swipe or upward flick, but never captures horizontal movement", () => {
    const { responder, opens, openDrawerRef } = swipeHarness();
    assert.equal(responder.onMoveShouldSetPanResponder(null, { dx: 40, dy: -30, vy: 0 }), false);
    const shortSwipe = { dx: 1, dy: -21, vy: 0 };
    assert.equal(responder.onMoveShouldSetPanResponder(null, shortSwipe), true);
    responder.onPanResponderRelease(null, shortSwipe);
    responder.onPanResponderRelease(null, { dx: 1, dy: -19, vy: -0.3 });
    assert.equal(opens(), 2);
    let freshCallback = false;
    openDrawerRef.current = () => { freshCallback = true; };
    responder.onPanResponderRelease(null, shortSwipe);
    assert.equal(freshCallback, true);
  });

  it("puts the live avatar inside the rail return button without a header or decorative avatar", () => {
    assert.match(shell, /title\?: string;\s*subtitle\?: string;/);
    assert.doesNotMatch(shell, /\b(?:header|compactHeader|shortHeader|narrowHeader|avatarBackdrop|avatarGlow|backdropDot|shortMain)\b/);
    assert.doesNotMatch(screen, /SPACE_COPY|沿着证据，找回一起记住的日常|看见进度，也看见权限与认识边界|设备回读与物理传感器各自表达真值|独立连接状态、双脑引擎与长稳守护/);
    const button = shell.match(/<Pressable\s+accessibilityRole="button"\s+accessibilityLabel="LOOI 返回全屏大脸"([^]*?)<\/Pressable>/)?.[1];
    assert.ok(button);
    assert.match(button, /onPress=\{onReturnToFace\}/);
    assert.match(button, /styles\.brandButton/);
    assert.match(button, /pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants"/);
    assert.match(button, /scale: compact \? 0\.42 : shortLandscape \? 0\.44 : 0\.48/);
    const avatar = button.match(/<RobotFaceView([^]*?)\/>/)?.[1];
    assert.ok(avatar);
    assert.match(avatar, /mode="avatar"/);
    assert.match(avatar, /expression=\{faceState\.expression\}/);
    assert.match(avatar, /gaze=\{\{ x: miniGaze\.x, y: -miniGaze\.y \}\}/);
    assert.match(avatar, /blinkProgress=\{faceState\.blinkProgress\}/);
    assert.match(avatar, /waveformBars=\{faceState\.waveformBars\}/);
    assert.match(avatar, /microShift=\{microShift\}/);
    assert.doesNotMatch(avatar, /onPress/);
    assert.equal((shell.match(/<RobotFaceView/g) ?? []).length, 1);
    for (const name of ["brandButton", "compactBrandButton", "shortBrandButton"]) {
      assert.ok(styleNumber(shell, name, "minHeight") >= 52);
      assert.ok(styleNumber(shell, name, "minHeight") <= 60);
    }
  });

  it("gives main the full viewport and floats freshness and toast feedback outside content flow", () => {
    const main = styleBody(shell, "main");
    assert.match(main, /flex: 1, minWidth: 0/);
    assert.equal(styleNumber(shell, "main", "paddingVertical"), 6);
    assert.equal(styleNumber(shell, "main", "paddingHorizontal"), 12);
    assert.equal(styleNumber(shell, "main", "gap"), 6);
    assert.match(shell, /<View style=\{styles\.main\}>/);
    const toastStyle = styleBody(shell, "toastPosition");
    for (const rule of ['position: "absolute"', "top: 8", "left: 16", "right: 16", "zIndex: 40", 'alignItems: "center"']) {
      assert.ok(toastStyle.includes(rule));
    }
    assert.match(shell, /pointerEvents="none" style=\{styles\.toastPosition\}/);
    const freshness = styleBody(shell, "freshnessBanner");
    for (const rule of ['position: "absolute"', "top: 6", "right: 12", "zIndex: 35", "borderRadius:"]) {
      assert.ok(freshness.includes(rule));
    }
    assert.match(shell, /!isDocked && \(\s*<View pointerEvents="none" style=\{styles\.freshnessBanner\}/);
    assert.match(shell, /已离座 · 桌面停留在最后观察/);
    const stage = shell.slice(shell.indexOf("<View style={[styles.stage"), shell.indexOf('<View pointerEvents="none" style={styles.ambientLight}'));
    assert.doesNotMatch(stage, /paddingBottom/);
    for (const edge of ["top", "left", "right"]) assert.ok(stage.includes(`insets.${edge}`));
    assert.match(shell, /paddingBottom: compact \|\| shortLandscape \? 0 : insets\.bottom/);
  });

  it("fits the landscape rail above the home indicator and points selection toward the workspace", () => {
    assert.equal(styleNumber(shell, "shortRail", "paddingTop"), 6);
    const railWidth = styleNumber(shell, "shortRail", "width");
    const scrollWidth = styleNumber(shell, "shortRailScroll", "width");
    const navWidth = styleNumber(shell, "shortNavButton", "width");
    assert.equal(railWidth, 80);
    assert.equal(scrollWidth, railWidth);
    assert.equal(styleNumber(shell, "shortBrandButton", "width"), railWidth);
    assert.equal(styleNumber(shell, "brandAvatar", "width"), 76);
    assert.ok(styleNumber(shell, "brandAvatar", "width") <= railWidth);
    assert.equal(navWidth, 64);
    assert.equal(styleNumber(shell, "shortNavButton", "minWidth"), 48);
    assert.equal(styleNumber(shell, "shortNavButton", "minHeight"), 48);
    assert.match(shell, /style=\{\[compact \? styles\.compactScroll : styles\.railScroll, !compact && shortLandscape && styles\.shortRailScroll\]\}/);
    const contentWidth = 844 - 2 * 47 - railWidth - 2 * styleNumber(shell, "main", "paddingHorizontal");
    assert.equal(contentWidth, 646);
    assert.ok(contentWidth >= 640, "safe-area content must retain Cabin's three-column layout");
    assert.match(shell, /paddingBottom: Math\.max\(8, insets\.bottom\)/);
    assert.match(shell, /navigation: \{[^\n]+paddingHorizontal: 4/);
    assert.match(shell, /selectionConnector: \{ position: "absolute", right: -8/);
    assert.match(shell, /selectionMark: \{ position: "absolute", right: -7/);
    assert.match(shell, /compactSelectionMark: \{ right: undefined, top: 2/);
    const destinations = shell.slice(shell.indexOf("const DESTINATIONS"), shell.indexOf("export interface LightToastCapsuleProps"));
    for (const title of ["记忆", "任务", "家居", "维修"]) assert.ok(destinations.includes(`title: "${title}"`));
    assert.equal((destinations.match(/space:/g) ?? []).length - 1, 4);
    for (const name of ["navButton", "compactNavButton", "shortNavButton", "narrowNavButton"]) {
      assert.ok(styleNumber(shell, name, "minHeight") >= 44);
      assert.ok(styleNumber(shell, name, name === "navButton" || name === "compactNavButton" ? "width" : "minWidth") >= 44);
    }
    // Include every item: top padding, brand, both navigation paddings,
    // four targets, three gaps, rail foot, and the 21pt home indicator inset.
    const budget = styleNumber(shell, "shortRail", "paddingTop")
      + styleNumber(shell, "shortBrandButton", "minHeight")
      + 2 * styleNumber(shell, "shortNavigation", "paddingVertical")
      + 4 * styleNumber(shell, "shortNavButton", "minHeight")
      + 3 * styleNumber(shell, "shortNavigation", "gap")
      + styleNumber(shell, "shortRailFoot", "height") + 21;
    assert.equal(budget, 6 + 52 + 8 + 4 * 48 + 3 * 4 + 8 + 21);
    assert.ok(budget <= 390);
    assert.match(shell, /deviceCompact: \{ flexDirection: "column-reverse" \}/);
    assert.match(shell, /horizontal=\{compact\}/);
    // Centered short nav targets leave room for the connector inside the scroll viewport.
    const connectorRight = Number(styleBody(shell, "selectionConnector").match(/\bright: (-?\d+)/)?.[1]);
    assert.equal((scrollWidth - navWidth) / 2 + navWidth - connectorRight, railWidth);
  });

  it("settled gaze exits before repaint while toast expiry and blink remain explicitly scheduled", () => {
    const settled = screen.match(/if \(Math\.hypot\(dx, dy\) <= 0\.004\) \{([^}]+)\}/)?.[1] ?? "";
    assert.match(settled, /smoothGaze\.current = target/);
    assert.match(settled, /return;/);
    assert.doesNotMatch(settled, /refresh\(/);
    assert.match(screen, /if \(!activeToast\) return;/);
    assert.match(screen, /if \(toasts\.getActiveToast\(\)\?\.id !== toastId\) refresh\(\)/);
    assert.match(screen, /blinkFrames\.forEach\(clearTimeout\)/);
    assert.match(screen, /if \(face\.getState\(\)\.expression !== snapshot\.faceExpression\) face\.setExpression\(snapshot\.faceExpression\)/);
  });

  it("keeps drawer copy optional and renders compact entries with live badges instead of filler", () => {
    assert.match(drawer, /interface Entry \{[^]*?detail\?: string;/);
    assert.match(drawer, /interface GlassSheetProps \{[^]*?description\?: string;/);
    assert.match(drawer, /!!description\?\.trim\(\) && <Text[^]*?>\{description\}<\/Text>/);
    assert.match(drawer, /!!entry\.detail\?\.trim\(\) && <Text[^]*?>\{entry\.detail\}<\/Text>/);
    const quick = drawer.slice(drawer.indexOf("export function QuickDrawerOverlay"), drawer.indexOf("export function SimLabSheet"));
    const sim = drawer.slice(drawer.indexOf("export function SimLabSheet"), drawer.indexOf("const keepPrivacyPaused"));
    assert.doesNotMatch(quick + sim, /description=|detail:/);
    assert.doesNotMatch(drawer, /记住日常，照顾书房，继续未完成的事/);

    const entries = quick.match(/const entries: Entry\[\] = (\[[^]*?\n  \]);/)?.[1];
    assert.ok(entries);
    const selections: string[] = [];
    const makeEntries = new Function("memoryCount", "taskCount", "pendingApprovalCount", "homeStatus", "verifiedCount", "verificationStatus", "select", `return ${entries};`);
    const select = (key: string) => () => { selections.push(key); };
    const cards = makeEntries(4, 2, 1, "演示网关已连接", undefined, "unverified", select) as { key: string; label: string; badge: string; onPress: () => void }[];
    assert.deepEqual(cards.map(({ label, badge }) => [label, badge]), [
      ["回忆册", "4 条记忆"], ["约定任务", "1 项待批授权"], ["书房家居", "演示网关已连接"], ["维修舱", "尚未核验"],
    ]);
    cards.forEach((card) => card.onPress());
    assert.deepEqual(selections, ["memories", "tasks_and_rules", "home", "cabin"]);
    assert.equal(makeEntries(0, 3, 0, "网关离线", 48, "unverified", select)[3].badge, "48 项核验通过");
    assert.equal(makeEntries(0, 3, 0, "网关离线", undefined, "running", select)[3].badge, "正在核验");
    assert.equal(makeEntries(0, 3, 0, "网关离线", undefined, "failed", select)[3].badge, "核验未完成");
    assert.match(quick, /label: "隐私暂停"/);
    assert.match(quick, /label: "仿真演练台"/);
    assert.match(quick, /entry\.key === "sim_lab" && <Text style=\{styles\.labTag\}>LAB<\/Text>/);
    assert.match(quick, /onClose\(\);\s*onSelect\(destination\);/);
    assert.match(screen, /destination === "privacy_pause"[^]*?presence\.pausePrivacy\(\)/);
  });

  it("fits four space cards and six lab buttons in landscape with a single utility row", () => {
    const expression = drawer.match(/const columns = ([^;\n]+);/)?.[1];
    assert.ok(expression);
    const columns = new Function("width", "landscape", "fontScale", "spaces", `return ${expression};`);
    for (const [width, height] of [[844, 390], [667, 375], [568, 320], [1024, 768]]) {
      assert.equal(columns(width, width > height, 1, true), 4);
      assert.equal(columns(width, width > height, 1, false), 3);
      assert.equal(columns(width, width > height, 1.4, true), 1);
      assert.equal(columns(width, width > height, 1.4, false), 1);
    }
    assert.equal(columns(390, false, 1, true), 2);
    assert.equal(columns(390, false, 1, false), 1);
    assert.equal(styleNumber(drawer, "shortSpaceCard", "minHeight"), 72);
    assert.equal(styleNumber(drawer, "shortLabTile", "minHeight"), 54);
    const utilities = styleBody(drawer, "utilities");
    assert.match(utilities, /flexDirection: "row"/);
    assert.doesNotMatch(utilities, /flexWrap: "wrap"/);
    assert.equal(styleNumber(drawer, "utility", "minHeight"), 44);
    assert.ok(styleNumber(drawer, "utility", "minWidth") >= 44);
    assert.match(styleBody(drawer, "utility"), /flex: 1/);
    assert.match(styleBody(drawer, "shortSheet"), /maxHeight: "100%"/);
    // The compact 3x2 grid, draggable header, sheet padding and safe areas fit
    // even a 320pt-tall landscape viewport without requiring a scroll.
    const labHeight = 2 * styleNumber(drawer, "shortLabTile", "minHeight")
      + styleNumber(drawer, "entryGrid", "rowGap")
      + styleNumber(drawer, "handleTouchArea", "minHeight")
      + styleNumber(drawer, "shortSheetHeader", "minHeight")
      + styleNumber(drawer, "shortSheetHeader", "paddingBottom")
      + styleNumber(drawer, "shortSheet", "paddingTop")
      + styleNumber(drawer, "shortSheet", "paddingBottom") + 2;
    assert.ok(labHeight <= 320 - 21 - 2 * styleNumber(drawer, "sheetSafeArea", "padding"));
    const sim = drawer.slice(drawer.indexOf("export function SimLabSheet"), drawer.indexOf("const keepPrivacyPaused"));
    assert.equal((sim.match(/\{ key:/g) ?? []).length, 6);
    assert.match(sim, /disabled: acceptanceRunning/);
  });

  it("keeps drawer dismissal on the header, guards stale completions, and uses comfortable physical targets", () => {
    assert.match(drawer, /<View \{\.\.\.drag\.panHandlers\}>\s*<View style=\{styles\.handleTouchArea\}/);
    assert.doesNotMatch(drawer, /!shortLandscape && <View[^]*?styles\.handle/);
    assert.match(drawer, /gesture\.dy > 56 \|\| gesture\.vy > 0\.55/);
    assert.match(drawer, /generation === animationGeneration\.current && callbacks\.current\.visible/);
    assert.match(drawer, /visible && !interacting\.current/);
    assert.match(drawer, /7_500/);
    assert.match(drawer, /closeTouchTarget: \{ width: 44, minHeight: 44/);
    assert.match(drawer, /utility: \{ minHeight: 44/);
    assert.match(drawer, /shortLabTile: \{ minHeight: 54/);
    const sim = drawer.slice(drawer.indexOf("export function SimLabSheet"), drawer.indexOf("const keepPrivacyPaused"));
    assert.doesNotMatch(sim, /useDrawerIdleClose|onInteractionStateChange/);
  });
});
