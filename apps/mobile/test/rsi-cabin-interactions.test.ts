import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import * as ts from "typescript";
import { CabinSpaceController } from "../src/ui/cabin-space.js";
import { DockedLongevitySupervisor } from "../src/shell/longevity-supervisor.js";
import { parseAcceptanceReport } from "../src/runtime/acceptance-api.js";
import { LOOI_PALETTE } from "../src/ui/theme.js";
import type { CabinSpaceViewProps, MobileAcceptanceReport } from "../src/ui/spaces/CabinSpaceView.js";

const source = readFileSync(new URL("../src/ui/spaces/CabinSpaceView.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, jsxFactory: "jsx", target: ts.ScriptTarget.ES2022 },
}).outputText;

// Evaluate the real component and handlers without loading a native renderer. Keep hooks
// across renders, record native props/styles, and explicitly deliver layout/frame events.
interface Element {
  type: string;
  props: Record<string, any> & { children: Array<Element | string | number> };
}
function harness(options: { width?: number; fontScale?: number; bottom?: number } = {}) {
  const hooks: any[] = [];
  const frames: Array<() => void> = [];
  const scrolls: Array<{ y: number; animated: boolean }> = [];
  let cursor = 0;
  let runs = 0;
  const controller = new CabinSpaceController();
  const supervisor = new DockedLongevitySupervisor();
  let props: CabinSpaceViewProps = { controller, supervisor, onRunAcceptance: () => { runs++; } };
  function jsx(type: string | ((props: any) => Element), input: any, ...children: any[]): Element {
    const childValues = children.length ? children : [input?.children];
    const props = { ...input, children: childValues.flat(Infinity).filter((item) => item !== null && item !== undefined && item !== false) };
    if (typeof type === "function") return type(props);
    if (type === "ScrollView" && props.ref) props.ref.current = { scrollTo: (position: { y: number; animated: boolean }) => scrolls.push(position) };
    return { type, props };
  }
  const exports: { CabinSpaceView?: (props: CabinSpaceViewProps) => Element } = {};
  runInNewContext(compiled, {
    exports, jsx, requestAnimationFrame: (callback: () => void) => frames.push(callback),
    require(name: string) {
      if (name === "react") return {
        useState(initial: any) {
          const index = cursor++;
          if (!(index in hooks)) hooks[index] = typeof initial === "function" ? initial() : initial;
          return [hooks[index], (next: any) => { hooks[index] = typeof next === "function" ? next(hooks[index]) : next; }];
        },
        useRef(initial: any) {
          const index = cursor++;
          if (!(index in hooks)) hooks[index] = { current: initial };
          return hooks[index];
        },
      };
      if (name === "react-native") return {
        Pressable: "Pressable", ScrollView: "ScrollView", Text: "Text", View: "View", StyleSheet: { create: (styles: any) => styles },
        useWindowDimensions: () => ({ width: options.width ?? 844, height: 390, fontScale: options.fontScale ?? 1 }),
      };
      if (name === "react-native-safe-area-context") return { useSafeAreaInsets: () => ({ left: 0, right: 0, top: 0, bottom: options.bottom ?? 21 }) };
      if (name.endsWith("LooiIcon.js")) return { LooiIcon: "LooiIcon" };
      if (name.endsWith("ToggleSwitch.js")) return { ToggleSwitch: "ToggleSwitch" };
      if (name.endsWith("theme.js")) return { LOOI_PALETTE };
      throw new Error(`Unexpected runtime dependency: ${name}`);
    },
  });
  return {
    controller, supervisor, scrolls,
    get runs() { return runs; },
    render(overrides: Partial<CabinSpaceViewProps> = {}) { cursor = 0; props = { ...props, ...overrides }; return exports.CabinSpaceView!(props); },
    flushFrames() { while (frames.length) frames.shift()!(); },
  };
}
function children(node: Element): Element[] {
  return node.props.children.filter((child): child is Element => typeof child === "object");
}
function walk(node: Element): Element[] { return [node, ...children(node).flatMap(walk)]; }
function text(node: Element): string {
  return node.props.children.map((child) => typeof child === "object" ? text(child) : String(child)).join("");
}
function labelled(root: Element, label: string): Element {
  const node = walk(root).find((node) => node.props.accessibilityLabel === label);
  assert.ok(node, `Missing accessible control: ${label}`);
  return node;
}
function style(node: Element): Record<string, any> {
  const value = typeof node.props.style === "function" ? node.props.style({ pressed: false }) : node.props.style;
  return Object.assign({}, ...[value].flat(Infinity).filter(Boolean));
}
function layout(width: number, y = 0) { return { nativeEvent: { layout: { width, height: 0, x: 0, y } } }; }
function panels(root: Element): Element[] { return children(children(root)[1]); }
function acceptance(root: Element): Element { return panels(root)[2]; }
function roles(root: Element, role: string) { return walk(root).filter((node) => node.props.accessibilityRole === role); }
function numeric(value: unknown): number { assert.equal(typeof value, "number"); return value as number; }
function boxHeight(node: Element, innerHeight: number): number {
  const s = style(node);
  return innerHeight + 2 * (numeric(s.paddingVertical ?? s.padding ?? 0) + numeric(s.borderWidth ?? 0));
}
function rowsHeight(node: Element, rowHeight: number, rows: number): number {
  return rowHeight * rows + numeric(style(node).gap ?? 0) * (rows - 1);
}
function report(): MobileAcceptanceReport {
  const cases: MobileAcceptanceReport["cases"] = Array.from("ABCDEFGH").flatMap((group) => Array.from({ length: 6 }, (_, i) => {
    const id = `${group}0${i + 1}`;
    const score = id === "A01" || id === "H06" ? 1 : id === "A02" ? 0 : 2;
    return { id, name: `真实用例 ${id}`, score, passed: id !== "A02" && id !== "H06", details: `Hub 执行证据 ${id}`, ...(id === "A02" ? { hardGateViolation: "越权请求被记录" } : {}) };
  }));
  return parseAcceptanceReport({
    totalCases: 48, passedCases: cases.filter((item) => item.passed && item.score === 2).length,
    totalScore: cases.reduce((sum, item) => sum + item.score, 0), maxScore: 96,
    hardGates: { unauthorizedActions: 2, crossSubjectLeaks: 0, zombieResurrections: 1, unverifiedCompletions: 0 }, cases, success: false,
  });
}

const fullGroupLabels = ["最后位置与主动观察", "语音改口与证据去重", "主人访客与打断隔离", "纠错删除与防注入", "家居白名单与验真", "任务沙箱与诚实取消", "具身租约与脱座急停", "双端长稳与降级诚实"];

describe("Phase 9 zero-scroll cabin bento cockpit", () => {
  it("puts all links and drills above three sibling panels, using measured workspace breakpoints", () => {
    const h = harness();
    let root = h.render();
    assert.equal(root.type, "ScrollView");
    assert.equal(children(root).length, 2, "No lower standalone simulation or policy section");
    const top = children(root)[0];
    for (const label of ["LOOI 底座 / BLE", "Hub 主机", "Home Assistant", "HA 断连模拟", "BLE 重连演练", "重放 0 条"]) assert.ok(text(top).includes(label));
    assert.equal(children(children(top)[0]).length, 3);
    assert.equal(style(children(top)[0]).flexDirection, "row");
    for (const card of children(children(top)[0])) {
      assert.equal(style(card).paddingVertical, 8);
      assert.equal(style(card).paddingHorizontal, 10);
      assert.equal(style(card).borderRadius, 14);
      const [icon, labels] = children(card);
      assert.equal(icon.type, "LooiIcon");
      assert.equal(labels.type, "View");
      assert.equal(style(labels).flex, 1);
      assert.equal(style(labels).minWidth, 0);
      const [title, status] = children(labels);
      assert.equal(children(labels).length, 2, "Title and snapshot status occupy separate compact lines");
      assert.ok(style(title).fontSize >= 10 && style(title).fontSize <= 11);
      assert.equal(style(title).lineHeight, 14);
      assert.equal(style(status).lineHeight, 14);
      assert.match(text(status), /^演示 · (已连接|未连接|待验真)$/);
    }
    assert.equal(panels(root).length, 3);
    for (const [i, title] of ["双脑引擎热切换", "长稳守护器", "48 项核心验收"].entries()) assert.ok(text(panels(root)[i]).includes(title));
    const engineHeading = children(panels(root)[0])[0];
    assert.equal(text(children(engineHeading)[2]), "演示策略");
    assert.ok(!text(acceptance(root)).includes("演示"), "Real Hub acceptance stays distinct from local simulation");
    assert.equal(typeof acceptance(root).props.onLayout, "function");
    assert.equal(style(panels(root)[0]).width, (844 - 88 - 24 - 16) / 3, "Rail and 12pt workspace padding are accounted for once");
    for (const [width, columns] of [[732, 3], [646, 3], [640, 3], [639, 2], [520, 2], [519, 1], [320, 1]]) {
      root.props.onLayout(layout(width));
      root = h.render();
      const expectedWidth = (width - (columns - 1) * 8) / columns;
      assert.equal(style(panels(root)[0]).width, expectedWidth);
      assert.equal(style(panels(root)[1]).width, expectedWidth);
      assert.equal(style(acceptance(root)).width, columns === 2 ? width : expectedWidth);
      const top = children(root)[0];
      const [connections, drills] = children(top);
      assert.equal(style(connections).flexDirection, columns === 1 ? "column" : "row");
      assert.equal(style(top).flexDirection ?? "column", columns === 3 ? "row" : "column");
      assert.equal(style(drills).flexDirection, columns === 1 ? "column" : "row");
      assert.equal(style(drills).flexWrap, columns === 3 ? "nowrap" : "wrap");
      assert.equal(children(drills).length, 2, "Replay status belongs inside the BLE control");
      assert.ok(text(children(drills)[1]).includes("BLE 重连演练重放 0 条 · 待验证"));
      if (columns === 3) {
        assert.equal(style(top).flexWrap, "nowrap");
        assert.equal(style(connections).flex, 1);
        assert.equal(style(connections).minWidth, 0);
        assert.equal(style(drills).flexShrink, 0);
        const [ha, ble] = children(drills);
        assert.ok(style(ha).width >= 110 && style(ha).width <= 116);
        assert.ok(style(ble).width >= 112 && style(ble).width <= 125);
        const drillWidth = style(ha).width + style(ble).width + style(drills).gap;
        const connectionsWidth = width - style(top).gap - drillWidth;
        assert.ok(connectionsWidth >= 390, "Three flexible cards retain room beside both drills at 640–646pt");
        const cardWidth = (connectionsWidth - style(connections).gap * 2) / 3;
        const card = children(connections)[0];
        assert.ok(cardWidth - 2 * (style(card).paddingHorizontal + style(card).borderWidth) - 16 - style(card).gap >= 82, "Compact title/status column fits without horizontal overflow");
        if (width === 646) assert.equal(expectedWidth, 210);
      } else {
        assert.equal(style(connections).flex, undefined);
      }
    }
    assert.equal(style(root).minHeight, 0);
    assert.equal(style(root).flex, 1);
    assert.equal(style({ ...root, props: { ...root.props, style: root.props.contentContainerStyle } }).paddingBottom, 27);
  });

  it("uses numeric two-column cell widths at every measured workspace breakpoint", () => {
    const h = harness();
    let root = h.render();
    for (const width of [320, 390, 519, 520, 639, 640, 646, 732]) {
      root.props.onLayout(layout(width));
      root = h.render();
      const guardian = panels(root)[1];
      const panel = acceptance(root);
      const metrics = children(guardian)[2];
      const [, , gates, groups] = children(panel);
      for (const [grid, container, count, rows] of [
        [metrics, guardian, 4, 2],
        [gates, panel, 4, 2],
        [groups, panel, 8, 4],
      ] as const) {
        assert.equal(children(grid).length, count);
        assert.equal(children(grid).length / 2, rows);
        assert.equal(style(grid).flexDirection, "row");
        assert.equal(style(grid).flexWrap, "wrap");
        assert.equal(style(grid).gap, 4);
        const containerStyle = style(container);
        const paddingAndBorder = 2 * (numeric(containerStyle.padding) + numeric(containerStyle.borderWidth));
        assert.equal(paddingAndBorder, 18);
        const insideWidth = numeric(containerStyle.width) - paddingAndBorder;
        for (const cell of children(grid)) {
          const cellStyle = style(cell);
          const cellWidth = numeric(cellStyle.width);
          assert.equal(cellStyle.flexBasis, undefined);
          assert.equal(cellStyle.flexGrow, 0);
          assert.equal(cellStyle.flexShrink, 0);
          assert.ok(Math.abs(2 * cellWidth + style(grid).gap - insideWidth) < 1e-9, `Two cells fit inside the panel at ${width}pt`);
        }
      }
    }
  });

  it("budgets the collapsed 2x4 matrix and all three panels within a 350pt viewport", () => {
    const h = harness();
    h.render().props.onLayout(layout(646));
    const root = h.render();
    const top = children(root)[0];
    const [links, drills] = children(top);
    const card = children(links)[0];
    const [title, status] = children(children(card)[1]);
    const cardHeight = boxHeight(card, Math.max(16, style(title).lineHeight + style(status).lineHeight));
    const bleLabels = children(children(drills)[1])[1];
    const bleHeight = boxHeight(children(drills)[1], children(bleLabels).reduce((height, node) => height + boxHeight(node, style(node).lineHeight), 0));
    const drillHeight = Math.max(bleHeight, ...children(drills).map((node) => style(node).minHeight));
    assert.equal(style(top).flexDirection, "row");
    const topHeight = Math.max(cardHeight, drillHeight);
    const panel = acceptance(root);
    const [heading, actions, gates, groups] = children(panel);
    assert.equal(children(gates).length, 4);
    assert.equal(children(groups).length, 8);
    assert.equal(style(groups).flexWrap, "wrap");
    const gate = children(gates)[0];
    const gateHeight = boxHeight(gate, Math.max(...children(gate).map((node) => style(node).lineHeight)));
    const group = children(groups)[0];
    const summary = children(group)[0];
    const [groupHeader, progress] = children(summary);
    const groupHeight = boxHeight(group, Math.max(...children(groupHeader).map((node) => style(node).lineHeight)) + style(summary).gap + style(progress).height);
    const headingHeight = Math.max(...children(heading).map((node) => boxHeight(node, style(node).lineHeight)));
    const actionsHeight = Math.max(...children(actions).map((node) => style(node).minHeight));
    const acceptanceHeight = boxHeight(panel, headingHeight + actionsHeight + rowsHeight(gates, gateHeight, 2) + rowsHeight(groups, groupHeight, 4) + style(panel).gap * 3);
    assert.ok(acceptanceHeight >= 220 && acceptanceHeight <= 250, "Collapsed acceptance stays near 228pt with all eight groups");
    const wrappedHeadingHeight = children(heading).reduce((height, node) => height + boxHeight(node, style(node).lineHeight), 0) + style(heading).gap;
    const acceptanceWithWrappedHeading = acceptanceHeight + wrappedHeadingHeight - headingHeight;
    assert.ok(acceptanceWithWrappedHeading < 278);
    const contentStyle = style({ ...root, props: { ...root.props, style: root.props.contentContainerStyle } });
    assert.ok(topHeight + contentStyle.gap + acceptanceWithWrappedHeading + contentStyle.paddingBottom < 350);
    assert.equal(walk(root).filter((node) => node.type === "Pressable").length, 14, "Primary controls remain present");
    for (const p of panels(root)) {
      assert.equal(style(p).height, undefined);
      assert.equal(style(p).maxHeight, undefined);
      assert.notEqual(style(p).overflow, "hidden", "Content can grow when fonts/details expand");
    }
    const guardian = panels(root)[1];
    const [guardianTitle, thermal, metrics, oled] = children(guardian);
    const guardianHeight = boxHeight(guardian, style(children(guardianTitle)[1]).lineHeight + style(children(thermal)[0]).minHeight + rowsHeight(metrics, boxHeight(children(metrics)[0], style(children(children(metrics)[0])[0]).lineHeight), 2) + style(children(oled)[0]).height + style(guardian).gap * 3);
    assert.ok(guardianHeight <= acceptanceHeight);
    const engine = panels(root)[0];
    const [engineTitle, voice, vision, edge] = children(engine);
    const engineHeadingHeight = Math.max(style(children(engineTitle)[1]).lineHeight * 2, boxHeight(children(engineTitle)[2], style(children(engineTitle)[2]).lineHeight));
    assert.ok(boxHeight(engine, engineHeadingHeight + style(children(voice)[0]).minHeight + style(children(vision)[0]).minHeight + style(edge).lineHeight + style(engine).gap * 3) <= acceptanceHeight);
  });

  it("retains 44pt touch targets and scrolling for narrow, scaled and expanded states", () => {
    for (const options of [{}, { width: 390, fontScale: 2 }]) {
      const h = harness(options);
      let root = h.render();
      assert.notEqual(root.props.scrollEnabled, false);
      labelled(root, "展开 48 项用例矩阵").props.onPress();
      root = h.render();
      labelled(root, "A01 待运行 待验证").props.onPress();
      root = h.render();
      const controls = walk(root).filter((node) => node.type === "Pressable");
      assert.equal(controls.length, 63);
      for (const control of controls) {
        assert.ok((style(control).minHeight ?? style(control).height) >= 44, control.props.accessibilityLabel);
        assert.ok((style(control).minWidth ?? style(control).width) >= 44, control.props.accessibilityLabel);
      }
      for (const node of walk(root).filter((node) => node.type === "Text")) {
        assert.notEqual(node.props.allowFontScaling, false);
        assert.equal(node.props.numberOfLines, undefined, "Required content is allowed to wrap");
      }
      assert.deepEqual(roles(root, "progressbar").map((node) => node.props.accessibilityLabel), fullGroupLabels.map((label, i) => `${"ABCDEFGH"[i]} 组 ${label} 待验证`));
    }
  });

  it("removes verbose static disclaimers without implying verification", () => {
    for (const removed of ["本地路由策略 · 远端模型待连接", "Edge 本地守护器模型状态", "本地热压力演练，急停不随降频降级", "连接与控制仅为本地演示", "四大安全硬门禁要求全部为 0"]) assert.ok(!source.includes(removed), removed);
    const h = harness();
    h.controller.getSubsystems().hub.lastVerifiedAt = null;
    let root = h.render();
    assert.ok(text(children(children(children(root)[0])[0])[1]).includes("待验真"));
    assert.ok(text(children(root)[0]).includes("重放 0 条 · 待验证"));
    assert.equal(labelled(root, "BLE 尚未演练，重放数待验证").props.accessibilityLiveRegion, "polite");
    for (const group of roles(root, "progressbar")) assert.equal(group.props.accessibilityValue.text, "待验证");
    h.controller.getSubsystems().hub.lastVerifiedAt = "invalid";
    root = h.render();
    assert.ok(walk(root).some((node) => node.props.accessibilityLabel?.includes("Hub 主机，链路快照 待验真，时间待核实")));
  });

  it("exposes one whole-row HA switch, preserving BLE and Hub state independently", () => {
    const h = harness();
    let root = h.render();
    const initial = h.controller.getSubsystems();
    const switches = roles(root, "switch");
    assert.equal(switches.length, 1);
    const toggleContainer = children(switches[0])[1];
    assert.equal(toggleContainer.props.pointerEvents, "none");
    assert.equal(toggleContainer.props.accessibilityElementsHidden, true);
    assert.equal(toggleContainer.props.importantForAccessibility, "no-hide-descendants");
    assert.equal(children(toggleContainer)[0].type, "ToggleSwitch");
    assert.equal(children(toggleContainer)[0].props.compact, true);
    labelled(root, "HA 断连模拟").props.onPress();
    root = h.render();
    assert.equal(labelled(root, "HA 断连模拟").props.accessibilityState.checked, true);
    assert.equal(h.controller.getSubsystems().homeAssistant.status, "disconnected");
    assert.deepEqual(h.controller.getSubsystems().bleDock, initial.bleDock);
    assert.deepEqual(h.controller.getSubsystems().hub, initial.hub);
    labelled(root, "HA 断连模拟").props.onPress();
    root = h.render();
    assert.equal(labelled(root, "HA 断连模拟").props.accessibilityState.checked, false);
  });

  it("purges queued BLE motion and displays the actual replay result without restoring HA", () => {
    const h = harness();
    h.controller.updateSubsystemStatus("homeAssistant", "disconnected");
    const hub = h.controller.getSubsystems().hub;
    for (let i = 0; i < 2; i++) {
      h.supervisor.queueMotionCommand("previous_motion");
      labelled(h.render(), "演练 BLE 重连零动作重放").props.onPress();
      const root = h.render();
      assert.equal(h.supervisor.getPendingMotionCount(), 0);
      assert.ok(text(children(root)[0]).includes("重放 0 条"));
      assert.ok(!text(children(root)[0]).includes("重放 0 条 · 待验证"));
      assert.equal(labelled(labelled(root, "演练 BLE 重连零动作重放"), "BLE 演练重放 0 条，待发队列 0 条").props.accessibilityLiveRegion, "polite");
      assert.equal(h.controller.getSubsystems().homeAssistant.status, "disconnected");
      assert.deepEqual(h.controller.getSubsystems().hub, hub);
      assert.equal(h.controller.getSubsystems().bleDock.status, "connected");
    }
  });

  it("uses provider selections and thermal policy, including persistent Edge unloading and OLED advancement", () => {
    const h = harness();
    labelled(h.render(), "B 轨 模块化流式").props.onPress();
    assert.equal(h.controller.getActiveVoiceProvider(), "modular");
    labelled(h.render(), "A 轨 豆包全双工").props.onPress();
    assert.equal(h.controller.getActiveVoiceProvider(), "doubao");
    for (const provider of ["cloud", "lan", "edge"] as const) {
      labelled(h.render(), `视觉引擎 ${provider.toUpperCase()}`).props.onPress();
      assert.equal(h.controller.getActiveVisionProvider(), provider);
      assert.equal(labelled(h.render(), `视觉引擎 ${provider.toUpperCase()}`).props.accessibilityState.selected, true);
    }
    for (const [level, cadence, look, screen] of [["fair", 2500, "允许观察", "正常屏幕"], ["serious", 5000, "暂停观察", "调暗屏幕"], ["critical", 10000, "暂停观察", "调暗屏幕"], ["nominal", 1000, "允许观察", "正常屏幕"]] as const) {
      labelled(h.render(), `热压力演练 ${level}`).props.onPress();
      const root = h.render();
      assert.equal(h.supervisor.getPolicy().captureCadenceMs, cadence);
      assert.equal(labelled(root, `热压力演练 ${level}`).props.accessibilityState.selected, true);
      for (const metric of [`${cadence}ms 采样`, look, screen, "<100ms 急停"]) assert.ok(text(panels(root)[1]).includes(metric));
    }
    assert.ok(text(panels(h.render())[0]).includes("Edge 模型: 已卸载 (空闲5s卸载)"));
    const oled = children(panels(h.render())[1])[3];
    assert.equal(style(oled).flexDirection, "row");
    assert.equal(style(children(oled)[0]).width, 46);
    assert.equal(style(children(oled)[0]).height, 46);
    labelled(h.render(), "推进 OLED 防烧屏位移").props.onPress();
    assert.equal(h.supervisor.getPixelMicroShift().stepCount, 1);
    assert.ok(text(panels(h.render())[1]).includes("OLED x 2px · y 1px · 步 1"));
  });

  it("derives badge, gates, groups and cases exclusively from the real Hub report", () => {
    const h = harness();
    let root = h.render();
    assert.ok(text(acceptance(root)).includes("待验证"));
    const run = labelled(root, "运行 48 项验收");
    run.props.onPress();
    assert.equal(h.runs, 1);
    root = h.render();
    assert.equal(roles(root, "progressbar")[0].props.accessibilityValue.now, 0, "Requesting a run cannot manufacture passes");
    const hubReport = report();
    root = h.render({ acceptanceReport: hubReport });
    assert.ok(text(acceptance(root)).includes(`${hubReport.passedCases}/48通过`));
    assert.ok(walk(root).some((node) => node.props.accessibilityLabel?.includes(`${hubReport.totalScore}/${hubReport.maxScore} 分，验收未全部通过`)));
    const gates = children(acceptance(root))[2];
    assert.deepEqual(children(gates).map(text), ["越权执行2", "跨主体泄露0", "僵尸复活1", "未核验成功0"]);
    for (const [i, group] of roles(root, "progressbar").entries()) {
      const expected = i === 0 ? 4 : i === 7 ? 5 : 6;
      assert.equal(group.props.accessibilityValue.now, expected);
      assert.ok(group.props.accessibilityLabel.includes(fullGroupLabels[i]));
      assert.equal(group.props.accessibilityValue.text, `${expected}/6 通过`);
    }
    labelled(root, "展开 48 项用例矩阵").props.onPress();
    root = h.render();
    for (const item of hubReport.cases) labelled(root, `${item.id} ${item.name} ${item.passed && item.score === 2 ? "通过" : "未通过"}`);
    assert.equal(walk(root).filter((node) => node.type === "Pressable" && /^[A-H]0[1-6] /.test(node.props.accessibilityLabel ?? "")).length, 48);
    root = h.render({ acceptanceRunning: true });
    assert.ok(text(acceptance(root)).includes("运行中"));
    assert.ok(text(acceptance(root)).includes("下方保留上次 Hub 报告"));
    assert.equal(labelled(root, "运行 48 项验收").props.disabled, true);
    assert.equal(labelled(root, "运行 48 项验收").props.accessibilityState.busy, true);
    root = h.render({ acceptanceRunning: false, acceptanceError: "Hub 请求失败" });
    assert.ok(text(acceptance(root)).includes("待核实"));
    assert.ok(text(roles(root, "alert")[0]).includes("本次结果待核实，不记为成功"));
    assert.ok(text(acceptance(root)).includes("下方保留上次 Hub 报告"));
    assert.equal(roles(root, "progressbar")[0].props.accessibilityValue.now, 4);
    root = h.render({ acceptanceError: null, acceptanceReport: null });
    assert.ok(roles(root, "progressbar").every((group) => group.props.accessibilityValue.text === "待验证"));
    assert.ok(!text(acceptance(root)).includes("48/48通过"));
  });

  it("places dismissible details before cases and scrolls using all nested layout offsets", () => {
    const h = harness();
    let root = h.render({ acceptanceReport: report() });
    root.props.onLayout(layout(600));
    root = h.render();
    children(root)[1].props.onLayout(layout(600, 92));
    acceptance(root).props.onLayout(layout(600, 220));
    labelled(root, "展开 48 项用例矩阵").props.onPress();
    root = h.render();
    labelled(root, "A01 真实用例 A01 未通过").props.onPress();
    h.flushFrames();
    assert.equal(h.scrolls.length, 0, "Wait for the newly mounted detail layout");
    root = h.render();
    let panelChildren = children(acceptance(root));
    const details = panelChildren.find((node) => typeof node.props.onLayout === "function")!;
    assert.ok(panelChildren.indexOf(details) < panelChildren.findIndex((node) => roles(node, "progressbar").length === 8));
    assert.ok(text(details).includes("Hub 执行证据 A01"));
    assert.ok(text(details).includes("未通过 · 1/2 分"));
    details.props.onLayout(layout(600, 160));
    h.flushFrames();
    assert.equal(h.scrolls.at(-1)?.y, 92 + 220 + 160 - 8);
    assert.equal(h.scrolls.at(-1)?.animated, true);
    labelled(root, "A02 真实用例 A02 未通过").props.onPress();
    root = h.render();
    h.flushFrames();
    assert.ok(text(acceptance(root)).includes("越权请求被记录"));
    labelled(root, "收起用例详情").props.onPress();
    root = h.render();
    panelChildren = children(acceptance(root));
    assert.ok(!panelChildren.some((node) => typeof node.props.onLayout === "function"));
    root = h.render({ acceptanceReport: null });
    labelled(root, "A01 待运行 待验证").props.onPress();
    assert.ok(text(acceptance(h.render())).includes("此用例尚无已核验执行结果。"));
  });
});
