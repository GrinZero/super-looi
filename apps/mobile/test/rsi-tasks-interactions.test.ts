import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import type { TaskEvent } from "@super-looi/contracts";
import { TasksAndRulesSpaceController } from "../src/ui/tasks-and-rules-space.js";
import { createDemoTaskEvent, createDemoArtifactReadback, requestDemoTaskCancellation, resolveDemoTaskCancellation } from "../src/ui/spaces/space-demo-state.js";

const source = readFileSync(new URL("../src/ui/spaces/TasksSpaceView.tsx", import.meta.url), "utf8");
const tree = ts.createSourceFile("TasksSpaceView.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function nodes(predicate: (node: ts.Node) => boolean): ts.Node[] {
  const found: ts.Node[] = [];
  const visit = (node: ts.Node) => { if (predicate(node)) found.push(node); ts.forEachChild(node, visit); };
  visit(tree);
  return found;
}
function style(name: string) {
  const property = nodes((node) => ts.isPropertyAssignment(node) && node.name.getText(tree) === name && ts.isObjectLiteralExpression(node.initializer)).at(-1);
  assert.ok(property && ts.isPropertyAssignment(property) && ts.isObjectLiteralExpression(property.initializer));
  return Object.fromEntries(property.initializer.properties.filter(ts.isPropertyAssignment).map((entry) => [entry.name.getText(tree), entry.initializer.getText(tree)]));
}

function button(label: string): ts.JsxElement {
  const found = nodes((node) => ts.isJsxElement(node) && node.openingElement.tagName.getText(tree) === "Button" && node.getText(tree).includes(label))[0];
  assert.ok(found && ts.isJsxElement(found), `missing button ${label}`);
  return found;
}
function invoke(element: ts.JsxElement, context: Record<string, unknown>) {
  const handler = element.openingElement.attributes.properties.find((property) => ts.isJsxAttribute(property) && property.name.getText(tree) === "onPress");
  assert.ok(handler && ts.isJsxAttribute(handler) && handler.initializer && ts.isJsxExpression(handler.initializer) && handler.initializer.expression);
  runInNewContext(`(${handler.initializer.expression.getText(tree)})()`, context);
}

describe("RSI task workspace interaction invariants", () => {
  it("has two landscape panes and mounts exactly one independently scrollable pane per portrait tab", () => {
    const panes = nodes((node) => ts.isJsxElement(node) && node.openingElement.tagName.getText(tree) === "ScrollView") as ts.JsxElement[];
    assert.equal(panes.length, 2, "short landscape must not add a third column");
    for (const [index, pane] of panes.entries()) {
      assert.ok(ts.isBinaryExpression(pane.parent));
      assert.equal(pane.parent.left.getText(tree), `(wide || activeTab === "${index === 0 ? "tasks" : "approval"}")`);
      assert.match(pane.openingElement.getText(tree), /keyboardShouldPersistTaps="handled"/u);
      assert.match(pane.openingElement.getText(tree), /paddingBottom: short \? 0 : Math\.max\(16, insets\.bottom \+ 6\)/u);
    }
    assert.equal(style("columns").flexDirection, '"row"');
    assert.equal(style("column").flex, "1");
    assert.match(source, /width >= 700/u);
    assert.match(source, /pendingApproval && <View accessibilityLabel="有待审批的高危指令"/u);
    assert.match(source, /!wide && pendingApproval && <Pressable[^>]+onPress=\{\(\) => setActiveTab\("approval"\)\}/u);
  });

  it("surfaces each pending approval once in portrait while preserving manual tab changes", () => {
    const effect = nodes((node) => ts.isCallExpression(node) && node.expression.getText(tree) === "useEffect"
      && node.arguments[0]?.getText(tree).includes("autoFocusedApproval"))[0];
    assert.ok(effect && ts.isCallExpression(effect));
    assert.equal(effect.arguments[1]?.getText(tree), "[wide, pendingApproval]");
    const autoFocusedApproval = { current: false };
    let activeTab = "tasks";
    const focus = (wide: boolean, pendingApproval: boolean) => runInNewContext(`(${effect.arguments[0]!.getText(tree)})()`, {
      wide, pendingApproval, autoFocusedApproval, setActiveTab: (tab: string) => { activeTab = tab; },
    });

    focus(true, true);
    assert.equal(activeTab, "tasks", "landscape retains its two panes");
    focus(false, true);
    assert.equal(activeTab, "approval", "entering portrait surfaces the pending approval");
    activeTab = "tasks";
    focus(false, true);
    focus(true, true);
    focus(false, true);
    assert.equal(activeTab, "tasks", "manual selection survives rerenders and rotation");
    focus(false, false);
    assert.equal(autoFocusedApproval.current, false, "clearing approval rearms autofocus");
    focus(false, true);
    assert.equal(activeTab, "approval", "a new approval is surfaced once again");
  });

  it("presents exactly four bento cards and keeps the command and single-use scopes above approval", () => {
    const approval = source.indexOf('style={styles.approvalFrame}');
    const command = source.indexOf("rm -rf build/tmp &amp;&amp; ./scripts/deploy.sh", approval);
    const scopes = source.indexOf('style={styles.scopeGrid}', approval);
    const accept = source.indexOf(">批准本次执行</Button>", approval);
    const reject = source.indexOf(">拒绝并请求取消</Button>", approval);
    const commitments = source.indexOf("我们的日常约定", approval);
    assert.ok(approval < command && command < scopes && scopes < accept && accept < reject && reject < commitments);
    assert.equal(style("approvalActions").flexDirection, '"row"');
    assert.equal(style("approvalActions").gap, "8");
    assert.match(source, /读写 · 当前演示工程/u);
    assert.match(source, /仅此命令 · 仅本次执行/u);
    assert.doesNotMatch(source, /styles\.scopeDetails|进行中与最近委托|文件读写限于此工程|本地事件阶段|独立的本地演示样例|本地状态机演示 · 未连接/u);
    const panes = nodes((node) => ts.isJsxElement(node) && node.openingElement.tagName.getText(tree) === "ScrollView") as ts.JsxElement[];
    const paneViews = panes.map((pane) => pane.children.filter(ts.isJsxElement).filter((child) => child.openingElement.tagName.getText(tree) === "View"));
    assert.deepEqual(paneViews.map((views) => views.length), [2, 2]);
    assert.match(paneViews[0]![0]!.getText(tree), /humanizeWorkspaceId\(workspacePath\)/u);
    assert.match(paneViews[0]![1]!.getText(tree), /已回读 \{String\(readback.value.bytes\)\} B/u);
    assert.match(paneViews[0]![1]!.getText(tree), /readback.evidence_ids.join/u);
    assert.match(paneViews[0]![1]!.getText(tree), /readback.observed_at/u);
    assert.equal(style("progressTrack").height, "4");
    assert.equal(style("eventHistory").flexDirection, '"row"');
    assert.equal(style("eventHistory").flexWrap, '"wrap"');
    const eventHistory = nodes((node) => ts.isJsxElement(node) && node.openingElement.getText(tree).includes('style={styles.eventHistory}'))[0];
    assert.ok(eventHistory);
    assert.match(eventHistory.getText(tree), /\{statusLabels\[event\.state\]\}/u);
    assert.doesNotMatch(source, /\beventLabels\b/u);
    assert.equal(style("artifactCard").padding, "10");
    assert.equal(style("artifactCard").gap, "4");
    assert.equal(style("commitment").flexDirection, '"row"');
    assert.equal(style("cancellationPanel").flexDirection, '"row"');
    const header = nodes((node) => ts.isJsxElement(node) && node.openingElement.getText(tree).includes('style={styles.commitmentsHeader}'))[0];
    assert.ok(header);
    assert.match(header.getText(tree), /\{commitments\.length\} 条/u);
    assert.match(header.getText(tree), /\+ 添加整理书桌约定/u);
  });

  it("budgets both two-card columns below 350pt with compact cancellation evidence", () => {
    const n = (name: string, key: string) => Number(style(name)[key]);
    const header = Math.max(n("cardTitle", "lineHeight"), n("badge", "lineHeight") + 2 * n("badge", "paddingVertical") + 1);
    const eventRow = n("eventText", "lineHeight") + 2 * n("eventText", "paddingVertical");
    const banner = Math.max(n("statusIcon", "height"), n("bannerTitle", "lineHeight") + n("body", "lineHeight")) + 2 * n("cancellationBanner", "paddingVertical") + 2;
    assert.equal(style("cancellationStatus").flexDirection, '"row"');
    assert.equal(style("terminationEvidence").flex, "1");
    assert.match(source, /task.state !== "cancelling" && <View style=\{styles.taskActions\}/u, "receipt actions replace the request row");
    const task = 2 * n("card", "padding") + 2 + header + n("body", "lineHeight") + n("progressTrack", "height") + eventRow + banner + n("compactButton", "minHeight") + 5 * n("card", "gap");
    const artifact = 2 * n("artifactCard", "padding") + 2 + n("cardTitle", "lineHeight") + n("monospace", "lineHeight") + n("artifactCard", "gap");
    assert.ok(task + artifact + n("content", "gap") <= 350, `task and artifact budget: ${task + artifact + n("content", "gap")}`);
    const approval = 2 * n("approvalFrame", "padding") + 2 * n("approvalCard", "padding") + header + n("shortCommand", "lineHeight") + 2 * n("shortCommand", "padding") + n("shortScopePill", "lineHeight") + 2 * n("shortScopePill", "paddingVertical") + n("compactButton", "minHeight") + 3 * n("approvalCard", "gap");
    const ruleCopy = n("commitmentTitle", "lineHeight") + 2 * n("small", "lineHeight") + 2 * n("commitmentCopy", "gap");
    const ruleRow = Math.max(ruleCopy, n("compactButton", "minHeight")) + n("commitment", "paddingTop") + 1;
    const commitments = 2 * n("card", "padding") + 2 + n("compactButton", "minHeight") + 2 * ruleRow + 2 * n("card", "gap");
    assert.ok(approval + commitments + n("content", "gap") <= 350, `approval and commitments budget: ${approval + commitments + n("content", "gap")}`);
  });

  it("approves only the current execution and keeps independently verified artifacts separate", () => {
    const approve = button(">批准本次执行<");
    assert.match(approve.openingElement.getText(tree), /disabled=\{!pendingApproval\}/u);
    assert.match(button(">拒绝并请求取消<").openingElement.getText(tree), /disabled=\{!pendingApproval\}/u);
    const initial = createDemoTaskEvent("2026-11-04T10:00:00.000Z");
    const readback = createDemoArtifactReadback("2026-11-04T09:00:00.000Z");
    let approved: TaskEvent | undefined;
    invoke(approve, { task: initial, updateTask: (next: TaskEvent) => { approved = next; } });
    assert.ok(approved);
    assert.equal(approved.state, "running");
    assert.equal(approved.event_seq, initial.event_seq + 1);
    assert.equal(approved.task_id, initial.task_id);
    assert.deepEqual(Array.from(approved.artifact_refs), []);
    assert.deepEqual(Array.from(approved.action_receipt_ids), []);
    assert.match(approved.summary, /等待执行器与回读证据/u);
    assert.equal(readback.value.bytes, 1482);
    assert.deepEqual(readback.evidence_ids, ["demo_probe_report_1"]);
    assert.match(source, /const \[readback\] = useState\(\(\) => createDemoArtifactReadback\(\)\)/u);
  });

  it("requests cancellation before any exit claim and keeps transport loss uncertain without replay", () => {
    let task = createDemoTaskEvent();
    const request = nodes((node) => ts.isVariableDeclaration(node) && node.name.getText(tree) === "requestCancellation")[0];
    assert.ok(request && ts.isVariableDeclaration(request) && request.initializer);
    const requestCancellation = () => runInNewContext(`(${request.initializer!.getText(tree)})()`, {
      task, requestDemoTaskCancellation, updateTask: (next: TaskEvent) => { task = next; },
    });
    const reject = button(">拒绝并请求取消<");
    invoke(reject, { requestCancellation });
    assert.equal(task.state, "cancelling");
    assert.equal(task.cancellation.phase, "pending");
    assert.equal("termination_evidence_ids" in task.cancellation, false);
    invoke(button(">模拟连接中断<"), { task, resolveDemoTaskCancellation, updateTask: (next: TaskEvent) => { task = next; } });
    assert.equal(task.state, "unknown");
    assert.equal(task.uncertainty_reason, "transport_lost");
    assert.equal("termination_evidence_ids" in task.cancellation, false);
    requestCancellation();
    assert.equal(task.state, "cancelling");
    invoke(button(">模拟收到退出回执<"), { task, resolveDemoTaskCancellation, updateTask: (next: TaskEvent) => { task = next; } });
    assert.equal(task.state, "cancelled");
    assert.equal(task.cancellation.phase, "confirmed");
    if (task.cancellation.phase !== "confirmed") assert.fail("expected exit evidence");
    assert.deepEqual(task.cancellation.termination_evidence_ids, ["demo_runner_exit_0"]);
    assert.match(source, /task.cancellation.phase === "confirmed" && <View style=\{styles.terminationEvidence\}/u);
    assert.match(source, /无退出确证 · 不自动重放/u);
    const seq = task.event_seq;
    invoke(button(">重置演示样例<"), { task, createDemoTaskEvent, updateTask: (next: TaskEvent) => { task = next; } });
    assert.equal(task.state, "awaiting_approval");
    assert.equal(task.event_seq, seq + 1);
    assert.equal(task.cancellation.phase, "not_requested");
  });

  it("adds, pauses, resumes and deletes commitments through the existing controller", () => {
    const controller = new TasksAndRulesSpaceController();
    let refreshes = 0;
    const context = { controller, refreshRules: () => { refreshes += 1; }, onChange: () => {}, onNotify: () => {} };
    invoke(button(">+ 添加整理书桌约定<"), context);
    assert.equal(controller.getCommitments().length, 1);
    let item = controller.getCommitments()[0]!;
    assert.equal(item.status, "active");
    const toggle = button('"暂停约定" : "恢复约定"');
    invoke(toggle, { ...context, item });
    item = controller.getCommitments()[0]!;
    assert.equal(item.status, "paused");
    invoke(toggle, { ...context, item });
    item = controller.getCommitments()[0]!;
    assert.equal(item.status, "active");
    invoke(button(">删除<"), { ...context, item });
    assert.equal(controller.getCommitments().length, 0);
    assert.equal(refreshes, 4);
  });

  it("retains physical 44pt targets in compact mode and separates destructive commitment actions", () => {
    for (const name of ["button", "compactButton", "tab", "approvalShortcut"]) {
      assert.ok(Number(style(name).minHeight) >= 44, `${name} must remain at least 44pt tall`);
    }
    assert.equal(style("destructiveAction").marginLeft, '"auto"');
    assert.ok(Number(style("destructiveAction").paddingLeft) >= 8);
    assert.match(source, /style=\{styles\.destructiveAction\}><Button compact icon="trash" danger/u);
  });
});
