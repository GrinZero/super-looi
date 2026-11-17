import { expect, open, test } from "nsh/test";
import {
  computeStageLayout,
  nextCycledDrawerDetent,
  resolveSnapDrawerDetent,
  STAGE_BASE_PILL_HEIGHT,
  STAGE_BASE_PILL_WIDTH,
  STAGE_TOP_BAR_HEIGHT,
} from "./ui/stage/posture-geometry";

test("pure posture geometry preserves landscape invariants, asymmetric cutouts, and top-bar safety", () => {
  const viewport = { width: 844, height: 390 };
  const insets = { top: 0, right: 44, bottom: 21, left: 44 };

  const full = computeStageLayout({
    viewport,
    insets,
    posture: { kind: "full" },
    drawerDetent: "closed",
    hasDrawer: false,
  });
  expect(full.face.scale).toBe(1);
  expect(Math.abs(full.face.translateX)).toBe(0);
  expect(Math.abs(full.face.translateY)).toBe(0);
  expect(full.face.pillOpacity).toBe(0);

  // Asymmetric left notch (left=48, right=0): floating_top clamps to 0.36, centers in safe area, and clears right-side host controls
  const asymInsets = { top: 0, right: 0, bottom: 21, left: 48 };
  const floating = computeStageLayout({
    viewport,
    insets: asymInsets,
    posture: { kind: "floating_top", scale: 0.95, chrome: "pill" },
    drawerDetent: "peek",
    hasDrawer: true,
    hasCapsule: true,
  });
  expect(floating.face.scale).toBe(0.36);
  expect(floating.face.pillOpacity).toBe(1);
  const expectedSafeCenterX = 48 + (844 - 48) / 2;
  expect(Math.abs(floating.face.targetCenterX - expectedSafeCenterX) < 0.01).toBe(true);
  const floatingPillRightEdge =
    floating.face.targetCenterX + (STAGE_BASE_PILL_WIDTH * floating.face.pillScale) / 2;
  expect(floatingPillRightEdge <= viewport.width - asymInsets.right - 280).toBe(true);
  const floatingPillBottom =
    floating.face.targetCenterY + (STAGE_BASE_PILL_HEIGHT * floating.face.pillScale) / 2;
  expect(floating.capsule.top > floatingPillBottom).toBe(true);
  expect(floating.canvas.top > floating.capsule.top).toBe(true);
  // Large drawer top edge stays strictly below floating_top pill bottom with >= 6pt breathing room
  const largeDrawerTopY = viewport.height - floating.drawer.largeHeight;
  expect(largeDrawerTopY >= Math.round(floatingPillBottom) + 6).toBe(true);

  // docked_corner top_right never intrudes into top safety bar (y >= STAGE_TOP_BAR_HEIGHT)
  const dockedRight = computeStageLayout({
    viewport,
    insets,
    posture: { kind: "docked_corner", corner: "top_right", scale: 0.1 },
    drawerDetent: "medium",
    hasDrawer: true,
  });
  expect(dockedRight.face.scale).toBe(0.2);
  expect(dockedRight.face.targetCenterY > STAGE_TOP_BAR_HEIGHT).toBe(true);

  // split_left separates left companion pane and right StageCanvas inset cleanly
  const split = computeStageLayout({
    viewport,
    insets,
    posture: { kind: "split_left", widthRatio: 0.4 },
    drawerDetent: "closed",
    hasDrawer: false,
  });
  expect(split.isSplitLeft).toBe(true);
  expect(split.canvas.left > split.splitLeftBoundaryX).toBe(true);
  expect(split.face.targetCenterX < split.splitLeftBoundaryX).toBe(true);

  // 4-detent snap respects allowUserSwipeCollapse=false
  const snappedLocked = resolveSnapDrawerDetent({
    startDetent: "peek",
    translationY: 160,
    velocityY: 900,
    drawer: dockedRight.drawer,
    allowUserSwipeCollapse: false,
  });
  expect(snappedLocked).toBe("peek");

  const snappedCollapsible = resolveSnapDrawerDetent({
    startDetent: "peek",
    translationY: 160,
    velocityY: 900,
    drawer: dockedRight.drawer,
    allowUserSwipeCollapse: true,
  });
  expect(snappedCollapsible).toBe("closed");

  expect(nextCycledDrawerDetent("large", false)).toBe("medium");
  expect(nextCycledDrawerDetent("large", true)).toBe("peek");
});

test("MorphableStage morphs across all 5 postures without unmounting RobotFace, keeps host controls unblockable, and auto-resets on plugin UI crash", async () => {
  for (const reducedMotion of [false, true]) {
    const app = await open("./StageProbe.tsx", {
      width: 844,
      height: 390,
      reducedMotion,
      clock: {},
    });

    // 1. Default full posture: single persistent looi-face, wake guide shown, no exit pill
    expect(app.count("id:looi-face")).toBe(1);
    expect(app.shows("id:exit-plugin-stage")).toBe(false);
    expect(app.shows("id:morphable-stage")).toBe(true);

    // Stale task response preview AND live voice speech subtitle show in full posture,
    // hide during active stage with hideDefaultDock/drawer, and reappear on exit
    await app.press("probe-toggle-stale-response");
    expect(app.texts()).toContain("历史任务回复：不遮挡插件抽屉");
    await app.press("probe-toggle-live-speech");
    expect(app.shows("id:subtitle-capsule")).toBe(true);
    expect(app.texts()).toContain("法官播报中：今晚请闭眼");

    // 2. Morph to floating_top + peek drawer + StageCapsule + StageCanvas
    await app.press("probe-floating-top");
    await app.wait(250);
    expect(app.count("id:looi-face")).toBe(1);
    expect(app.shows("id:exit-plugin-stage")).toBe(true);
    expect(app.texts()).toContain("阶段：天黑请闭眼");
    expect(app.texts()).toContain("狼人杀控制台 · 档位:peek");
    expect(app.shows("id:subtitle-capsule")).toBe(false);
    expect(app.texts().includes("历史任务回复：不遮挡插件抽屉")).toBe(false);
    expect(app.texts().includes("法官播报中：今晚请闭眼")).toBe(false);

    // Plugin StageCanvas & StageDrawer receive taps cleanly without RobotFace stealing pointer events
    await app.press("seat-pick-3");
    expect(app.texts()).toContain("已选：3");
    await app.press("referee-next-phase");
    expect(app.texts()).toContain("阶段：预言家请睁眼");

    // Cycle drawer detents via grabber tap: peek -> medium -> large
    await app.press("stage-drawer-grabber");
    await app.wait(220);
    expect(app.texts()).toContain("狼人杀控制台 · 档位:medium");
    await app.press("stage-drawer-grabber");
    await app.wait(220);
    expect(app.texts()).toContain("狼人杀控制台 · 档位:large");

    // Cloned activeStage updates with unchanged revision preserve user's manual drawer detent override
    await app.press("referee-next-phase");
    expect(app.texts()).toContain("狼人杀控制台 · 档位:large");

    // Downward drag snaps cleanly from large -> medium -> peek
    await app.drag("stage-drawer-grabber", { y: 50 });
    await app.wait(220);
    expect(app.texts()).toContain("狼人杀控制台 · 档位:medium");
    await app.drag("stage-drawer-grabber", { y: 20 });
    await app.wait(220);
    expect(app.texts()).toContain("狼人杀控制台 · 档位:peek");

    // Collapse drawer via explicit collapse button when allowUserSwipeCollapse=true
    expect(app.shows("id:stage-drawer-collapse")).toBe(true);
    await app.press("stage-drawer-collapse");
    await app.wait(220);

    // Drag gesture on grabber snaps cleanly between detents (gentle drag -> medium, fast upward drag -> large)
    await app.press("probe-floating-top");
    await app.wait(150);
    await app.drag("stage-drawer-grabber", { y: -55 });
    await app.wait(220);
    expect(app.texts()).toContain("狼人杀控制台 · 档位:medium");
    await app.drag("stage-drawer-grabber", { y: -110 });
    await app.wait(220);
    expect(app.texts()).toContain("狼人杀控制台 · 档位:large");

    // 3. Morph through docked_corner -> split_left -> minimized_pill (locked drawer)
    await app.press("probe-docked-right");
    await app.wait(220);
    expect(app.count("id:looi-face")).toBe(1);
    expect(app.texts()).toContain("狼人杀控制台 · 档位:medium");

    await app.press("probe-split-left");
    await app.wait(220);
    expect(app.count("id:looi-face")).toBe(1);

    await app.press("probe-minimized-locked");
    await app.wait(220);
    expect(app.count("id:looi-face")).toBe(1);
    expect(app.texts()).toContain("狼人杀控制台 · 档位:large");
    // allowUserSwipeCollapse=false hides collapse button
    expect(app.shows("id:stage-drawer-collapse")).toBe(false);

    // Even with large StageDrawer + StageCanvas + StageCapsule active, top-right host controls are NEVER covered!
    await app.press("connection-settings");
    expect(app.texts()).toContain("陪伴待机 · 设置点击:1");
    await app.press("compose");
    expect(app.shows("id:message-input")).toBe(true);
    await app.press("compose");
    expect(app.shows("id:message-input")).toBe(false);

    // Host exit-plugin-stage unconditionally exits even when allowUserSwipeCollapse=false, and restores historical response preview & voice subtitle
    await app.press("exit-plugin-stage");
    await app.wait(220);
    expect(app.shows("id:exit-plugin-stage")).toBe(false);
    expect(app.count("id:looi-face")).toBe(1);
    expect(app.shows("id:subtitle-capsule")).toBe(true);
    expect(app.texts()).toContain("法官播报中：今晚请闭眼");
    await app.press("probe-toggle-live-speech");
    expect(app.texts()).toContain("历史任务回复：不遮挡插件抽屉");
    await app.press("probe-toggle-stale-response");

    // System Back exits active plugin stage cleanly
    await app.press("probe-floating-top");
    await app.wait(150);
    expect(app.shows("id:exit-plugin-stage")).toBe(true);
    await app.back();
    await app.wait(150);
    expect(app.shows("id:exit-plugin-stage")).toBe(false);

    // 4. Synchronous StageCanvas render crash -> ErrorBoundary isolates, resets stage to full, keeps looi-face alive
    await app.press("probe-crash-canvas");
    await app.wait(100);
    expect(app.shows("id:exit-plugin-stage")).toBe(false);
    expect(app.count("id:looi-face")).toBe(1);
    expect(app.texts()).toContain(
      "舞台熔断恢复:test.crash-canvas:StageCanvas:boom_in_stage_canvas",
    );

    // 5. Mid-flight reactive StageDrawer crash -> ErrorBoundary isolates, resets stage to full, keeps looi-face alive
    await app.press("probe-mount-drawer-crashable");
    await app.wait(100);
    expect(app.texts()).toContain("抽屉正常运行中");
    expect(app.shows("id:exit-plugin-stage")).toBe(true);

    await app.press("probe-trigger-drawer-crash");
    await app.wait(100);
    expect(app.shows("id:exit-plugin-stage")).toBe(false);
    expect(app.count("id:looi-face")).toBe(1);
    expect(app.texts()).toContain(
      "舞台熔断恢复:test.crash-drawer:StageDrawer:boom_in_stage_drawer_reactive",
    );

    // 6. Re-acquiring stage with the same plugin ID remounts ErrorBoundary cleanly
    await app.press("probe-mount-drawer-crashable");
    await app.wait(100);
    expect(app.texts()).toContain("抽屉正常运行中");
    expect(app.shows("id:exit-plugin-stage")).toBe(true);
    await app.press("exit-plugin-stage");
    await app.wait(150);

    app.dispose();
  }
});
