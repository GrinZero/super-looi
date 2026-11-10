import assert from "node:assert/strict";
import { test } from "node:test";
import { createAppStore } from "../store.js";

// Minimal mock runtime for store instantiation in Node test environment
function createMockRuntime() {
  let mode: "direct_miot" | "external_ha" | "simulation" | "disabled" = "direct_miot";
  let enabledSources = {
    direct_miot: true,
    external_ha: false,
    simulation: false,
  };
  return {
    homeConfiguration() {
      return {
        mode,
        region: "cn" as const,
        haUrl: "",
        hasToken: false,
        hasMiotAccount: true,
        enabledSources,
      };
    },
    homeConnection() {
      return {
        healthy: true,
        connectionId: "mock-conn-1",
        configured: true,
        mode,
        error: undefined,
      };
    },
    async homeDashboard() {
      return {
        homeName: "测试家庭",
        totalAppliances: 6,
        activeAppliances: 2,
        rooms: [],
        allAppliances: [],
      };
    },
    async listHome() {
      return {};
    },
    async configureHome(next: any) {
      if (next.mode) mode = next.mode;
      if (next.enabledSources) enabledSources = { ...next.enabledSources };
      return this.homeConfiguration();
    },
    async connectHome() {
      return this.homeConnection();
    },
    async setHomeSourceEnabled(source: "direct_miot" | "external_ha" | "simulation", enabled: boolean) {
      enabledSources[source] = enabled;
      return this.homeConnection();
    },
    async logoutMiot() {
      enabledSources.direct_miot = false;
    },
  };
}

test("Xiaomi video login flow state transitions and authorization completion", async () => {
  const store = createAppStore({
    runtime: createMockRuntime() as any,
  });

  // 1. Initial State
  assert.equal(store.homeSubView(), "devices");
  assert.equal(store.xiaomiVideoAuth().authorized, false);

  // Switch to services
  store.setHomeSubView("services");
  assert.equal(store.homeSubView(), "services");

  // 2. Start Video Login Flow
  store.startXiaomiVideoLogin();
  assert.equal(store.homeSubView(), "video_login");
  const initialLogin = store.xiaomiVideoLogin();
  assert.equal(initialLogin.step, "credentials");
  assert.equal(initialLogin.error, null);

  // 3. Credentials submission validation
  store.submitVideoCredentials({ account: "   ", password: "123" });
  assert.match(store.xiaomiVideoLogin().error ?? "", /米家账号/);
  assert.equal(store.xiaomiVideoLogin().step, "credentials");

  // Valid credentials step -> moves to captcha
  store.submitVideoCredentials({ account: "13800138000", password: "password123", region: "cn" });
  assert.equal(store.xiaomiVideoLogin().step, "captcha");
  assert.equal(store.xiaomiVideoLogin().error, null);

  // 4. Captcha verification
  const hintBefore = store.xiaomiVideoLogin().captchaHint;
  store.refreshVideoCaptcha();
  const hintAfter = store.xiaomiVideoLogin().captchaHint;
  assert.ok(hintAfter.length > 0);

  // Wrong captcha
  store.submitVideoCaptcha("WRONG");
  assert.match(store.xiaomiVideoLogin().error ?? "", /验证码不正确/);
  assert.equal(store.xiaomiVideoLogin().step, "captcha");

  // Correct captcha -> moves to two_factor
  store.submitVideoCaptcha(hintAfter);
  assert.equal(store.xiaomiVideoLogin().step, "two_factor");
  assert.equal(store.xiaomiVideoLogin().error, null);
  assert.ok(store.xiaomiVideoLogin().smsCountdown > 0);

  // 5. Two-factor submission
  store.submitVideoTwoFactor("12"); // too short
  assert.match(store.xiaomiVideoLogin().error ?? "", /有效的验证码/);

  store.submitVideoTwoFactor("886622");
  // Successfully authorized!
  assert.equal(store.xiaomiVideoAuth().authorized, true);
  assert.equal(store.xiaomiVideoAuth().cameraCount, 3);
  assert.equal(store.xiaomiVideoAuth().account, "138****8000");

  // Automatically returns to services
  assert.equal(store.homeSubView(), "services");

  // 6. Disconnect video auth
  store.disconnectXiaomiVideo();
  assert.equal(store.xiaomiVideoAuth().authorized, false);
});

test("goBack correctly handles video_login -> services -> devices navigation", () => {
  const store = createAppStore({
    runtime: createMockRuntime() as any,
  });

  store.openSpace("home");
  store.setHomeSubView("services");
  store.startXiaomiVideoLogin();
  assert.equal(store.homeSubView(), "video_login");

  // First goBack from video_login -> returns to services
  const back1 = store.goBack();
  assert.equal(back1, true);
  assert.equal(store.homeSubView(), "services");

  // Second goBack from services -> returns to devices
  const back2 = store.goBack();
  assert.equal(back2, true);
  assert.equal(store.homeSubView(), "devices");
});
