import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import type { MemoryClaim } from "@super-looi/contracts";
import { MemoriesConformalSpaceController } from "../src/ui/memories-space.js";
import { resolveMemorySceneTarget, humanizeEpistemicStatus, humanizeMemorySource } from "../src/ui/humanize.js";
import { correctDemoMemory, createDemoMemoryClaims, removeDemoMemoryItem } from "../src/ui/spaces/space-demo-state.js";

const now = "2026-11-04T12:00:00.000Z";

describe("Presence memory scene evidence integration", () => {
  it("shows four distinct demo zones while retaining uncertainty and expired-source boundaries", () => {
    const controller = new MemoriesConformalSpaceController();
    const claims = createDemoMemoryClaims(Date.parse(now));
    assert.deepEqual(claims.map((claim) => resolveMemorySceneTarget(controller.formatClaimCard(claim).whereText).zone), ["keyboard_left", "monitor_right", "bookshelf", "drawer_right"]);
    const cup = claims[2]!;
    assert.equal(cup.status, "inferred");
    assert.equal(humanizeEpistemicStatus(cup.status).label, "模型推测");
    assert.equal(controller.formatClaimCard(cup).heroImageUri, undefined);
    assert.deepEqual(cup.evidence_ids, []);
  });

  it("location correction moves the selected scene independently of the object's old title and preserves evidence expiration", () => {
    const controller = new MemoriesConformalSpaceController();
    const cup = createDemoMemoryClaims(Date.parse(now))[2]!;
    const originalCard = controller.formatClaimCard(cup);
    const corrected = correctDemoMemory(cup, "  右侧抽屉里  ", now);
    const newCard = controller.formatClaimCard(corrected);
    controller.selectMemoryCard(newCard);
    assert.equal(newCard.whereText, "右侧抽屉里");
    assert.equal(resolveMemorySceneTarget(originalCard.whereText, "保温杯").zone, "bookshelf");
    assert.deepEqual(resolveMemorySceneTarget(newCard.whereText, "保温杯"), { zone: "drawer_right", xPercent: 87, yPercent: 81 });
    assert.equal(humanizeMemorySource(corrected.source_kind), "主人亲口确认");
    assert.equal(newCard.heroImageUri, undefined);
    assert.equal(corrected.revision, cup.revision + 1);
    assert.equal(controller.getSelectedClaimId(), cup.claim_id);
    assert.equal(correctDemoMemory(corrected, "  ", now), corrected);
  });

  it("removal retracts the selected fact; clearing the last forgotten or filtered claim releases avatar focus", () => {
    const controller = new MemoriesConformalSpaceController();
    const claim = createDemoMemoryClaims(Date.parse(now))[0]!;
    const removed = removeDemoMemoryItem(claim, now);
    controller.selectMemoryCard(controller.formatClaimCard(removed));
    assert.equal(removed.status, "retracted");
    assert.equal(removed.valid_to, now);
    assert.match(humanizeEpistemicStatus(removed.status).description, /不再作为当前事实/u);
    controller.triggerForgetMemory(removed.claim_id);
    controller.clearMemorySelection();
    assert.equal(controller.getSelectedClaimId(), null);
    assert.deepEqual(controller.getMiniRobotAvatar(), { gazeVector: { x: 0, y: 0 }, gazeTargetCardId: null, expression: "neutral" });
  });

  it("runs compact inspector correction, removal and forget handlers without restoring expired evidence", () => {
    const view = readFileSync(new URL("../src/ui/spaces/MemoriesSpaceView.tsx", import.meta.url), "utf8");
    const file = ts.createSourceFile("MemoriesSpaceView.tsx", view, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const handlers = new Map<string, string>();
    const visit = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && node.name.getText(file) === "correctLocation" && node.initializer) handlers.set("correctLocation", node.initializer.getText(file));
      if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(file) === "MemoryAction") {
        const attrs = node.attributes.properties.filter(ts.isJsxAttribute);
        const icon = attrs.find((attr) => attr.name.getText(file) === "icon")?.initializer;
        const handler = attrs.find((attr) => attr.name.getText(file) === "onPress")?.initializer;
        if (icon && ts.isStringLiteral(icon) && handler && ts.isJsxExpression(handler) && handler.expression) handlers.set(icon.text, handler.expression.getText(file));
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    let claims = createDemoMemoryClaims(Date.parse(now));
    let selected = claims[2]!;
    const original = selected;
    const actions: unknown[][] = [];
    const controller = new MemoriesConformalSpaceController({ onClaimActionTriggered: (...args) => { actions.push(args); } });
    let choosingLocation = true;
    let selectedId: string | null = selected.claim_id;
    let keyboardDismissed = false;
    const invoke = (key: string, ...args: unknown[]) => {
      const handler = handlers.get(key);
      assert.ok(handler, `missing handler ${key}`);
      const js = ts.transpile(`(${handler})`, { target: ts.ScriptTarget.ES2022 });
      const fn = runInNewContext(js, {
        selected, claims, controller, correctDemoMemory, removeDemoMemoryItem, onCorrect: undefined, onForget: undefined,
        updateClaims: (next: MemoryClaim[]) => { claims = next; },
        setChoosingLocation: (value: boolean) => { choosingLocation = value; },
        setSelectedId: (id: string | null) => { selectedId = id; },
        Keyboard: { dismiss: () => { keyboardDismissed = true; } }, onNotify: () => {},
      }) as (...args: unknown[]) => void;
      fn(...args);
    };
    invoke("correctLocation", "   ");
    assert.equal(claims[2], original);
    assert.equal(actions.length, 0);
    invoke("correctLocation", "  右侧抽屉里  ");
    selected = claims[2]!;
    assert.equal(selected.status, "confirmed");
    assert.equal(selected.revision, original.revision + 1);
    assert.equal(controller.formatClaimCard(selected).whereText, "右侧抽屉里");
    assert.equal(resolveMemorySceneTarget(controller.formatClaimCard(selected).whereText).zone, "drawer_right");
    assert.equal(selected.source_availability, "source_expired");
    assert.deepEqual(Array.from(selected.evidence_ids), []);
    assert.equal(controller.formatClaimCard(selected).heroImageUri, undefined);
    assert.equal(choosingLocation, false);
    assert.equal(keyboardDismissed, true);
    assert.equal(actions[0]![0], "location_correction");
    assert.equal(actions[0]![1], original.claim_id);
    assert.equal((actions[0]![2] as { newLocation: string }).newLocation, "右侧抽屉里");
    assert.match(view, /selected.source_availability === "source_expired" \? " · 原图已过期"/u, "portrait evidence must also expose expiration");
    invoke("box");
    selected = claims[2]!;
    assert.equal(selected.status, "retracted");
    assert.equal(selected.revision, original.revision + 2);
    assert.equal(selected.source_availability, "source_expired");
    assert.equal(humanizeEpistemicStatus(selected.status).label, "已撤回");
    assert.equal(actions[1]![0], "item_removed");
    invoke("trash");
    assert.equal(claims.length, 3);
    assert.equal(claims.some((claim) => claim.claim_id === selected.claim_id), false);
    assert.equal(selectedId, null);
    assert.equal(actions[2]![0], "forget_memory");
    assert.ok(claims.every((claim) => claim.revision === 1), "other records remain unchanged");
  });
});
