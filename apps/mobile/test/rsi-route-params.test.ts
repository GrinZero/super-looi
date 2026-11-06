import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import ts from "typescript";

const screen = readFileSync(new URL("../app/index.tsx", import.meta.url), "utf8");
const drawer = readFileSync(new URL("../src/ui/components/QuickDrawerModal.tsx", import.meta.url), "utf8");

function effects(source: string) {
  const tree = ts.createSourceFile("component.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: ts.CallExpression[] = [];
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.getText(tree) === "useEffect") found.push(node);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return { tree, found };
}

function routeHarness() {
  const { tree, found } = effects(screen);
  const effect = found.find((node) => node.arguments[1]?.getText(tree).includes("params.space"));
  assert.ok(effect, "route params must be observed by an effect");
  const factory = effect.arguments[0];
  assert.ok(factory && ts.isArrowFunction(factory));
  let space = "face";
  let quick = false;
  let lab = false;
  const apply = new Function("params", "navigate", "returnToFace", "openDrawer", "setDrawerVisible", "setSimLabVisible", factory.body.getText(tree));
  return {
    apply: (params: Record<string, unknown>) => apply(
      params,
      (destination: string) => { space = destination; quick = false; },
      () => { space = "face"; },
      () => { quick = true; },
      (visible: boolean) => { quick = visible; },
      (visible: boolean) => { lab = visible; },
    ),
    state: () => ({ space, quick, lab }),
  };
}

describe("RSI route parameters and gesture ref synchronization", () => {
  it("uses local router params and navigates to each supported space, including face", () => {
    assert.match(screen, /import \{ useLocalSearchParams \} from "expo-router"/);
    assert.match(screen, /useLocalSearchParams<\{ space\?: string; overlay\?: string \}>\(\)/);
    const routes = routeHarness();
    for (const space of ["memories", "tasks_and_rules", "home", "cabin", "face"]) {
      routes.apply({ overlay: "lab" });
      routes.apply({ space });
      assert.deepEqual(routes.state(), { space, quick: false, lab: false });
    }
  });

  it("opens either overlay exclusively and supports a space plus overlay in one link", () => {
    const routes = routeHarness();
    routes.apply({ space: "memories", overlay: "lab" });
    assert.deepEqual(routes.state(), { space: "memories", quick: false, lab: true });
    routes.apply({ overlay: "quick" });
    assert.deepEqual(routes.state(), { space: "memories", quick: true, lab: false });
    routes.apply({ overlay: "lab" });
    assert.deepEqual(routes.state(), { space: "memories", quick: false, lab: true });
    routes.apply({ space: "face" });
    assert.deepEqual(routes.state(), { space: "face", quick: false, lab: false });
  });

  it("leaves the current UI alone for empty, unknown, or repeated-array params", () => {
    const routes = routeHarness();
    routes.apply({ space: "home", overlay: "quick" });
    for (const params of [{}, { space: "unknown", overlay: "unknown" }, { space: ["home", "cabin"], overlay: ["quick", "lab"] }]) {
      routes.apply(params);
      assert.deepEqual(routes.state(), { space: "home", quick: true, lab: false });
    }
  });

  it("updates mutable gesture callback and guard refs only in effects", () => {
    for (const [source, refs] of [[screen, ["canSwipeOpenDrawerRef", "openDrawerRef"]], [drawer, ["callbacks", "close"]]] as const) {
      const { tree, found } = effects(source);
      for (const ref of refs) {
        const assignment = new RegExp(`${ref}\\.current = `, "g");
        const allWrites = [...source.matchAll(assignment)];
        assert.ok(allWrites.length > 0);
        for (const write of allWrites) {
          assert.ok(found.some((effect) => write.index >= effect.getStart(tree) && write.index < effect.getEnd()), `${ref} write must be inside useEffect`);
        }
      }
    }
  });
});
