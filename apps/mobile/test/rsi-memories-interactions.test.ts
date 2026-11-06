import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const memories = readFileSync(new URL("../src/ui/spaces/MemoriesSpaceView.tsx", import.meta.url), "utf8");
function stylesOf(text: string) {
  const file = ts.createSourceFile("styles.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const styles: Record<string, Record<string, string>> = {};
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node) && ts.isObjectLiteralExpression(node.initializer)) {
      styles[node.name.getText(file)] = Object.fromEntries(node.initializer.properties.filter(ts.isPropertyAssignment).map((entry) => [entry.name.getText(file), entry.initializer.getText(file)]));
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return styles;
}
const diagram = readFileSync(new URL("../src/ui/components/DesktopEvidenceDiagram.tsx", import.meta.url), "utf8");
const source = ts.createSourceFile("MemoriesSpaceView.tsx", memories, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const elements: (ts.JsxOpeningElement | ts.JsxSelfClosingElement)[] = [];
function visit(node: ts.Node) {
  if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) elements.push(node);
  ts.forEachChild(node, visit);
}
visit(source);
function attr(node: ts.JsxOpeningElement | ts.JsxSelfClosingElement, name: string) {
  return node.attributes.properties.find((property) => ts.isJsxAttribute(property) && property.name.getText(source) === name);
}

describe("RSI memories interaction contracts", () => {
  it("mounts a single portrait scroll pane and offers a direct evidence action", () => {
    const vertical = elements.filter((node) => node.tagName.getText(source) === "ScrollView" && !attr(node, "horizontal"));
    assert.equal(vertical.length, 2);
    for (const [index, node] of vertical.entries()) {
      const condition = node.parent.parent;
      assert.ok(ts.isBinaryExpression(condition), "each vertical pane must be conditionally mounted");
      assert.equal(condition.operatorToken.kind, ts.SyntaxKind.AmpersandAmpersandToken);
      assert.equal(condition.left.getText(source), `(wide || activePane === "${index === 0 ? "timeline" : "evidence"}")`);
    }
    assert.match(memories, /查看证据与纠错 →/u);
    assert.match(memories, /accessibilityRole="tablist"/u);
    assert.match(memories, /accessibilityRole="tab" accessibilityState=\{\{ selected: activePane === "evidence" \}\}/u);
  });

  it("keeps taps usable with the keyboard in every scroll container and focuses correction", () => {
    for (const node of elements.filter((node) => node.tagName.getText(source) === "ScrollView")) {
      assert.equal(attr(node, "keyboardShouldPersistTaps")?.getText(source), 'keyboardShouldPersistTaps="handled"');
      assert.equal(attr(node, "keyboardDismissMode")?.getText(source), 'keyboardDismissMode="on-drag"');
    }
    assert.match(memories, /<KeyboardAvoidingView behavior=\{Platform.OS === "ios" \? "padding" : undefined\}/u);
    assert.match(memories, /<TextInput autoFocus accessibilityLabel="编辑记忆位置"/u);
    assert.match(memories, /requestAnimationFrame\(\(\) => inspectorScroll.current\?\.scrollTo\(\{ y: 0, animated: true \}\)\)/u);
    assert.match(memories, /query.length > 0 && <Pressable accessibilityRole="button" accessibilityLabel="清空记忆搜索"/u);
    assert.match(memories, /clearSearch: \{ width: 44, height: 44/u);
    assert.match(memories, /compactAction: \{ flex: 1, minHeight: 44/u, "compact correction buttons need physical height even when parent clips hitSlop");
  });

  it("uses a noninteractive search wrapper and only allocates a clear button for a query", () => {
    const search = elements.find((node) => attr(node, "style")?.getText(source) === "style={[styles.search, wide && styles.wideSearch]}");
    assert.ok(search);
    assert.equal(search.tagName.getText(source), "View");
    assert.equal(attr(search, "onPress"), undefined);
    const clear = elements.find((node) => attr(node, "accessibilityLabel")?.getText(source) === 'accessibilityLabel="清空记忆搜索"');
    assert.ok(clear);
    const condition = clear.parent.parent;
    assert.ok(ts.isBinaryExpression(condition));
    assert.equal(condition.left.getText(source), "query.length > 0");
    assert.equal(condition.parent.parent, search.parent, "the conditional clear button must have no permanent spacer wrapper");
    assert.match(memories, /wideSearchInput: \{ minHeight: 44/u);
  });

  it("drills into evidence with one portrait card tap and returns in one tap", () => {
    const card = elements.find((node) => attr(node, "style")?.getText(source).includes("styles.memoryCard"));
    const back = elements.find((node) => attr(node, "style")?.getText(source) === "style={styles.backToTimeline}");
    assert.ok(card && back);
    const handler = (node: ts.JsxOpeningElement | ts.JsxSelfClosingElement) => {
      const property = attr(node, "onPress");
      assert.ok(property && ts.isJsxAttribute(property) && property.initializer && ts.isJsxExpression(property.initializer) && property.initializer.expression);
      return property.initializer.expression.getText(source);
    };
    for (const wide of [false, true]) {
      const state = { selectedId: "old", choosingLocation: true, activePane: "timeline", keyboardDismissed: false };
      const context = {
        wide, claim: { claim_id: "memory-2" },
        setSelectedId: (id: string) => { state.selectedId = id; },
        setChoosingLocation: (value: boolean) => { state.choosingLocation = value; },
        setActivePane: (pane: string) => { state.activePane = pane; },
        Keyboard: { dismiss: () => { state.keyboardDismissed = true; } },
      };
      runInNewContext(`(${handler(card)})()`, context);
      assert.equal(state.selectedId, "memory-2");
      assert.equal(state.choosingLocation, false);
      assert.equal(state.activePane, wide ? "timeline" : "evidence");
      if (!wide) {
        runInNewContext(`(${handler(back)})()`, context);
        assert.equal(state.activePane, "timeline");
        assert.equal(state.keyboardDismissed, true);
      }
    }
    assert.match(memories, /!wide && <Pressable[^\n]*styles.backToTimeline/u);
    assert.match(memories, /backToTimeline: \{ minHeight: 44/u);
  });

  it("removes short toolbar padding and clears the home indicator in both scroll panes", () => {
    assert.match(memories, /short && styles.shortToolbar/u);
    assert.match(memories, /shortToolbar: \{ paddingVertical: 0, paddingHorizontal: 0, backgroundColor: "transparent", gap: 8 \}/u);
    assert.match(memories, /const insets = useSafeAreaInsets\(\)/u);
    for (const style of ["listContent", "inspectorContent"]) {
      assert.ok(memories.includes(`contentContainerStyle={[styles.${style}, { paddingBottom: short ? 0 : Math.max(16, insets.bottom + 6) }]}`));
    }
  });

  it("fits the location editor above a landscape keyboard within the nested shell", () => {
    assert.match(memories, /rootFrame.current\?\.measureInWindow\(\(_x, y\) => setKeyboardOffset\(Math.max\(0, y\)\)\)/u);
    assert.match(memories, /keyboardVerticalOffset=\{keyboardOffset\}/u);
    assert.match(memories, /focusedEditor && styles.hiddenToolbar/u);
    assert.match(memories, /choosingLocation && \(wide \|\| activePane === "evidence"\) && \(short \|\| keyboardVisible\)/u, "an unmounted editor must not hide the timeline search when its keyboard opens");
    assert.match(memories, /compactLocationEntry: \{ flexDirection: "row"/u);
    assert.match(memories, /compactLocationPicker: \{ padding: 4, gap: 8 \}/u);
    assert.match(memories, /compactConfirm: \{ width: 136 \}/u, "confirmation label must fit without increasing the 44pt row height");
    assert.match(memories, /editingInspector: \{ padding: 0 \}/u);
    assert.match(memories, /Keyboard.dismiss\(\)/u);
  });

  it("cancels location editing beside confirmation without saving a correction", () => {
    const cancel = elements.find((node) => attr(node, "accessibilityLabel")?.getText(source) === 'accessibilityLabel="取消位置修改"');
    assert.ok(cancel);
    assert.equal(attr(cancel, "accessibilityRole")?.getText(source), 'accessibilityRole="button"');
    const actions = cancel.parent.parent;
    assert.ok(ts.isJsxElement(actions));
    assert.equal(attr(actions.openingElement, "style")?.getText(source), "style={styles.locationEditorActions}");
    assert.match(actions.getText(source), /label="确认新位置"/u);
    const onPress = attr(cancel, "onPress");
    assert.ok(onPress && ts.isJsxAttribute(onPress) && onPress.initializer && ts.isJsxExpression(onPress.initializer) && onPress.initializer.expression);
    let choosingLocation = true;
    runInNewContext(`(${onPress.initializer.expression.getText(source)})()`, {
      setChoosingLocation: (value: boolean) => { choosingLocation = value; },
      correctLocation: () => { assert.fail("cancel must not save the location draft"); },
    });
    assert.equal(choosingLocation, false);
    assert.match(memories, /choosingLocation \? "取消修改" : "不是这里"/u);
    assert.match(memories, /cancelLocationBtn: \{ minHeight: 44, minWidth: 44, paddingHorizontal: 14/u);
  });

  it("uses two-line timeline cards and a four-cell evidence inspector within the cockpit budget", () => {
    const styles = stylesOf(memories);
    assert.equal(styles.timelineColumn!.flex, "0.92");
    assert.equal(styles.evidenceColumn!.flex, "1.08");
    assert.equal(styles.timeline!.gap, "6");
    assert.equal(styles.memoryCard!.paddingVertical, "8");
    assert.equal(styles.memoryCard!.paddingHorizontal, "10");
    assert.equal(styles.memoryCard!.borderRadius, "12");
    assert.equal(styles.memoryCard!.gap, "3");
    const card = elements.find((node) => attr(node, "style")?.getText(source).includes("styles.memoryCard"));
    assert.ok(card && ts.isJsxElement(card.parent));
    const cardChildren = card.parent.children.filter(ts.isJsxElement);
    assert.deepEqual(cardChildren.map((child) => child.openingElement.tagName.getText(source)), ["View", "Text"]);
    assert.match(cardChildren[0]!.getText(source), /claim.status === "retracted" \? "原记录："/u);
    assert.match(cardChildren[0]!.getText(source), /badge.label/u);
    assert.match(cardChildren[1]!.getText(source), /humanizeMemorySource\(claim.source_kind\)/u);
    assert.match(cardChildren[1]!.getText(source), /formatted.whenText/u);
    assert.match(cardChildren[1]!.getText(source), /source_expired.*原图已过期/u);
    assert.doesNotMatch(memories, /MemorySceneArtwork|本地演示修改仅作用|styles\.boundary|styles\.footer|styles\.timelineHeader/u);
    assert.match(memories, /v\{selected.revision\} · \{selected.evidence_ids\[0\] \|\| "摘要"\}/u);
    assert.match(memories, /\["认识边界", humanizeEpistemicStatus\(selected.status\).label, "shield"\]/u);
    assert.match(memories, /selected.status === "retracted" \? "已拿走 · 旧位置失效"/u);
    assert.equal(styles.question!.flexBasis, '"48%"');
    assert.equal(styles.question!.paddingVertical, "5");
    assert.equal(styles.question!.paddingHorizontal, "8");
    assert.equal(styles.question!.borderRadius, "9");
    // Four two-line cards plus three gaps fit without a list scrollbar.
    const cardHeight = 2 + 2 * Number(styles.memoryCard!.paddingVertical) + Number(styles.memoryQuote!.lineHeight) + Number(styles.sourceText!.lineHeight) + Number(styles.memoryCard!.gap);
    assert.ok(4 * cardHeight + 3 * Number(styles.timeline!.gap) < 300);
    // Header + physical actions + drawing/bar + two rows of facts + gaps/border/padding.
    const factHeight = 2 * (2 * Number(styles.question!.paddingVertical) + Number(styles.questionLabel!.lineHeight) + Number(styles.question!.gap) + Number(styles.shortQuestionValue!.lineHeight)) + Number(styles.dimensions!.gap);
    const inspectorHeight = 2 + 2 * Number(styles.shortInspector!.padding) + Number(styles.inspectorHeader!.minHeight) + Number(styles.compactAction!.minHeight) + 84 + 4 + 14 + factHeight + 3 * Number(styles.shortInspector!.gap);
    assert.ok(inspectorHeight < 310, `inspector budget: ${inspectorHeight}`);
    assert.ok(44 + 6 + inspectorHeight <= 378);
  });

  it("keeps all correction actions inline and gives every filter a 44pt effective target", () => {
    const styles = stylesOf(memories);
    assert.equal(styles.memoryActions!.flexDirection, '"row"');
    const actions = elements.filter((node) => node.tagName.getText(source) === "MemoryAction" && ["edit", "box", "trash"].some((icon) => attr(node, "icon")?.getText(source) === `icon="${icon}"`));
    assert.equal(actions.length, 3);
    assert.equal(Number(styles.compactAction!.minHeight), 44);
    const filter = elements.find((node) => attr(node, "style")?.getText(source).includes("styles.filter,"));
    assert.ok(filter);
    assert.equal(attr(filter, "hitSlop")?.getText(source), "hitSlop={{ top: 4, bottom: 4 }}");
    assert.equal(Number(styles.filter!.minHeight) + 8, 44);
  });

  it("reserves fixed diagram height and combines zones and selected-location legend outside its clipped plane", () => {
    const styles = stylesOf(diagram);
    assert.equal(styles.compactDiagram!.height, "84");
    assert.equal(styles.compactDiagram!.minHeight, "84");
    assert.equal(styles.compactDiagram!.aspectRatio, "undefined");
    assert.equal(styles.diagram!.height, "108");
    assert.equal(styles.diagram!.aspectRatio, "undefined");
    assert.equal(styles.diagram!.overflow, '"hidden"');
    assert.equal(styles.diagramBar!.flexDirection, '"row"');
    const drawingEnd = diagram.indexOf('</View>\n    <View style={s.diagramBar}>');
    assert.ok(drawingEnd > diagram.indexOf('testID="memory-scene-target"'));
    assert.ok(diagram.indexOf('当前标注') > drawingEnd);
    assert.match(diagram, /物品已拿走 · 不再标注旧位置/u);
    assert.doesNotMatch(diagram, /空间示意 · 非原始画面|diagramCaption/u);
    assert.match(diagram, /!removed && <View testID="memory-scene-target"/u);
    assert.match(diagram, /if \(reduceMotion \|\| removed\) return/u);
    for (const zone of ["键盘左侧", "显示器右侧", "书架", "右侧抽屉"]) assert.ok(diagram.includes(`"${zone}"`));
  });
});
