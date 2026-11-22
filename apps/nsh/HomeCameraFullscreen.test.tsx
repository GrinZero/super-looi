import { expect, open, test } from "nsh/test";

test("camera fullscreen works in landscape light/dark and reducedMotion, survives 250ms frame heartbeats for 4s auto-hide, and exits via Escape", async () => {
  const cases: Array<{ colorScheme: "light" | "dark"; reducedMotion: boolean }> = [
    { colorScheme: "light", reducedMotion: false },
    { colorScheme: "dark", reducedMotion: true },
  ];

  for (const cfg of cases) {
    const app = await open("./HomeCameraProbe.tsx", {
      width: 844,
      height: 390,
      locale: "zh-CN",
      colorScheme: cfg.colorScheme,
      reducedMotion: cfg.reducedMotion,
      clock: {},
    });

    await app.waitFor("id:home-camera-video");
    expect(app.count("id:home-camera-video")).toBe(1);
    expect(app.count("id:home-camera-fullscreen-video")).toBe(0);

    // Start playing state with 250ms periodic homeCameraState heartbeats.
    await app.press("Set playing");
    expect(app.texts()).toContain("1920 × 1080");

    // Open fullscreen viewer by tapping the video trigger.
    await app.press("id:home-camera-fullscreen-trigger");
    await app.waitFor("id:home-camera-fullscreen-video");
    expect(app.count("id:home-camera-fullscreen-video")).toBe(1);
    expect(app.count("id:home-camera-video")).toBe(0);
    expect(app.shows("id:home-camera-fullscreen-close")).toBe(true);
    expect(app.shows("id:home-camera-fullscreen-retry")).toBe(true);
    expect(app.texts()).toContain("Camera");
    expect(app.texts().some((txt) => txt.includes("1920 × 1080"))).toBe(true);

    // Trigger fullscreen retry and PTZ directional control.
    await app.press("id:home-camera-fullscreen-retry");
    await app.press("id:fullscreen-cam-ptz-up");
    expect(app.texts()).toContain("云台转动中…");
    await app.wait(200);
    expect(app.texts().includes("云台转动中…")).toBe(false);

    // Tapping the canvas hides the HUD; tapping again brings it back.
    await app.press("id:home-camera-fullscreen-canvas");
    await app.wait(220);
    expect(app.shows("id:home-camera-fullscreen-close")).toBe(false);
    await app.press("id:home-camera-fullscreen-canvas");
    await app.wait(220);
    expect(app.shows("id:home-camera-fullscreen-close")).toBe(true);

    // Under continuous 250ms frame state heartbeats, HUD still auto-hides after 4s of inactivity.
    await app.wait(4250);
    expect(app.shows("id:home-camera-fullscreen-close")).toBe(false);

    // Tap canvas to restore HUD, then dismiss via Escape key back to inline view.
    await app.press("id:home-camera-fullscreen-canvas");
    await app.wait(220);
    expect(app.shows("id:home-camera-fullscreen-close")).toBe(true);
    await app.keyboard.press("escape");
    await app.waitFor("id:home-camera-video");
    expect(app.count("id:home-camera-fullscreen-video")).toBe(0);
    expect(app.count("id:home-camera-video")).toBe(1);

    const metrics = app.texts().find((txt) => txt.startsWith("retry=1 ptz=up hb="));
    expect(metrics).toBeTruthy();
    const hb = Number(metrics?.split("hb=")[1] ?? "0");
    expect(hb >= 16).toBe(true);
  }
});

test("camera fullscreen adapts to English compact landscape, disables PTZ when camera power is off, and closes on space switch", async () => {
  const app = await open("./HomeCameraProbe.tsx", {
    width: 500,
    height: 320,
    locale: "en-US",
    colorScheme: "light",
    clock: {},
  });

  await app.waitFor("id:home-camera-video");
  // Toggle power off via Poll dashboard so PTZ becomes disabled.
  await app.press("Poll dashboard");
  await app.press("Set playing");

  await app.press("id:home-camera-fullscreen-trigger");
  await app.waitFor("id:home-camera-fullscreen-video");
  // Compact width (<520) hides button text labels while keeping accessible icon controls.
  expect(app.shows("id:home-camera-fullscreen-close")).toBe(true);
  expect(app.shows("label:Exit fullscreen")).toBe(true);
  expect(app.shows("label:Reconnect")).toBe(true);
  expect(app.texts().includes("Exit fullscreen")).toBe(false);
  expect(app.texts().some((txt) => txt.includes("Playing · 1920 × 1080"))).toBe(true);
  await expect(app.press("id:fullscreen-cam-ptz-up")).rejects.toMatchObject({
    code: "ERR_NSH_TEST_DISABLED",
  });
  await app.press("id:home-camera-fullscreen-close");
  await app.waitFor("id:home-camera-video");

  // Switching parent activeSpace while RetainedPage remains mounted auto-closes fullscreen.
  await app.press("Queue space switch");
  await app.press("id:home-camera-fullscreen-trigger");
  await app.waitFor("id:home-camera-fullscreen-video");
  await app.wait(220);
  await app.waitFor("id:home-camera-video");
  expect(app.count("id:home-camera-fullscreen-video")).toBe(0);
  expect(app.count("id:home-camera-video")).toBe(1);
});

test("camera fullscreen blocks empty launch on error and surfaces recovery when stream drops mid-fullscreen", async () => {
  const app = await open("./HomeCameraProbe.tsx", {
    width: 844,
    height: 390,
    locale: "zh-CN",
    colorScheme: "dark",
    clock: {},
  });

  await app.waitFor("id:home-camera-video");

  // Queue mid-fullscreen disconnect, then enter fullscreen while session is still active.
  await app.press("Queue disconnect");
  await app.press("id:home-camera-fullscreen-trigger");
  await app.waitFor("id:home-camera-fullscreen-video");

  // Advance clock so disconnect occurs inside fullscreen; modal stays open with recovery card.
  await app.wait(220);
  await app.waitFor("id:home-camera-fullscreen-error");
  expect(app.shows("id:home-camera-fullscreen-center-retry")).toBe(true);
  expect(app.shows("id:home-camera-fullscreen-close")).toBe(true);
  await app.press("id:home-camera-fullscreen-center-retry");
  await app.press("id:home-camera-fullscreen-close");

  // While inline in error/no-session state, fullscreen trigger is absent and cannot open blank modal.
  await app.waitFor("id:home-camera-retry");
  expect(app.shows("id:home-camera-fullscreen-trigger")).toBe(false);
  expect(app.count("id:home-camera-video")).toBe(0);
  expect(app.texts()).toContain("retry=1 ptz=none hb=0");
});
