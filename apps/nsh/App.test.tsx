import { expect, open, test } from "nsh/test";

test("keeps the pure face primary with inline ask bar and Structure 3 management shell", async () => {
  const app = await open("./App.tsx", { locale: "zh-CN" });

  // 1. Initial screen has lightweight icon-only voice-toggle plus 对话, 连接
  expect(app.texts()).not.toContain("LIVE 对话");
  expect(app.texts()).toContain("对话");
  expect(app.texts()).toContain("连接");

  // 2. Click connection-settings into Structure 3 backstage
  await app.press("connection-settings");

  // Verify 6 brands in models space
  expect(app.texts()).toContain("OpenAI / ChatGPT");
  expect(app.texts()).toContain("Kimi");
  expect(app.texts()).toContain("MiniMax");
  expect(app.texts()).toContain("小米 MiMo");
  expect(app.texts()).toContain("智谱 / Z.AI");
  expect(app.texts()).toContain("+ 兼容 API");
  expect(app.texts()).toContain("连接成功后加载可用模型");
  expect(app.texts()).not.toContain("gpt-5.4");

  // Verify space navigation buttons and clean top bar
  expect(app.texts()).toContain("模型");
  expect(app.texts()).toContain("语音");
  expect(app.texts()).toContain("底座");
  expect(app.texts()).toContain("家居");
  expect(app.texts()).toContain("任务");
  expect(app.texts()).toContain("设置");
  expect(app.texts()).not.toContain("外观: 自动");
  expect(app.texts()).not.toContain("EN");

  // 3. Switch to brand-zai, see standard BigModel and coding plan channels, and switch channel cleanly
  await app.press("brand-zai");
  expect(app.texts()).toContain("标准 API (国内 BigModel)");
  expect(app.texts()).toContain("Coding Plan 专属 (国内)");
  await app.press("Coding Plan 专属 (国内)");
  expect(
    app.texts().some((t) => t.includes("api/coding/paas/v4")),
  ).toBe(true);

  // 3b. Switch to + 兼容 API and verify 3 protocol options
  await app.press("brand-custom");
  expect(app.texts()).toContain("OpenAI Completions");
  expect(app.texts()).toContain("OpenAI Responses");
  expect(app.texts()).toContain("Anthropic Messages");

  // 4. Switch spaces
  await app.press("nav-voice");
  expect(app.texts()).toContain("豆包实时语音凭证");
  expect(app.texts()).toContain("豆包输出音色");
  expect(app.texts()).toContain("关闭 Hey LOOI 自动唤醒");
  expect(app.texts()).not.toContain("当前状态");
  expect(app.texts()).not.toContain("待机监听唤醒词（本地离线 KWS）");
  expect(app.texts()).not.toContain("待机（未占用麦克风）");
  await app.press("wake-toggle");
  expect(app.texts()).toContain("开启 Hey LOOI 自动唤醒");
  await app.press("wake-toggle");
  expect(app.texts()).toContain("关闭 Hey LOOI 自动唤醒");

  // 4b. Verify LOOI Dock (底座) space with classic wheel, vertical head pitch slider, and fill light pill
  await app.press("nav-body");
  expect(app.texts()).toContain("蓝牙底座");
  expect(app.texts()).toContain("模拟体验");
  expect(app.texts()).toContain("扫描附近底座");
  expect(app.texts()).toContain("方向轮盘");
  expect(app.texts()).toContain("抬头");
  expect(app.texts()).toContain("低头");
  expect(app.texts()).toContain("55°");
  expect(app.texts()).toContain("补光灯 · 已关闭");
  await app.press("body-mode-sim");
  await app.waitUntil(() => app.texts().includes("已吸合就绪"));
  expect(app.texts()).toContain("LOOI 桌面底座");
  expect(app.texts()).toContain("其他可用底座");
  expect(app.texts()).toContain("卧室的 LOOI");
  await app.press("body-head-up");
  await app.waitUntil(() => app.texts().includes("85°"));
  await app.press("body-head-down");
  await app.waitUntil(() => app.texts().includes("25°"));
  await app.press("body-light-toggle");
  await app.waitUntil(() => app.texts().includes("补光灯 · 已开启"));
  await app.press("body-wheel-forward");
  await app.press("body-wheel-stop");

  await app.press("nav-home");
  expect(app.texts()).toContain("米家直连");
  await app.press("home-miot-region");
  await app.press("新加坡");
  expect(app.texts()).toContain("新加坡");

  await app.press("nav-tasks");
  expect(app.texts()).toContain("任务与审计记录");

  // 5. Open dedicated Settings space and switch appearance modes
  await app.press("nav-settings");
  expect(app.texts()).toContain("通用设置");
  expect(app.texts()).toContain("外观");
  expect(app.texts()).toContain("语言");
  await app.press("appearance-light");
  expect(app.texts()).toContain("当前生效：浅色");
  await app.press("appearance-dark");
  expect(app.texts()).toContain("当前生效：深色");
  await app.press("appearance-system");
  expect(app.texts()).toContain("当前生效：浅色");

  // 6. Return to robot face
  await app.press("back-to-face");
  expect(app.texts()).toContain("对话");
  expect(app.texts()).not.toContain("LIVE 对话");

  // 7. Test inline ask bar
  await app.press("compose");
  await app.type("message-input", "查看当前目录");
  expect(app.texts()).toContain("发送");
  await app.press("compose");
  expect(app.texts()).not.toContain("发送");
});

test("language dropdown and appearance settings follow system or persist across reopening", async () => {
  const app = await open("./App.tsx", { locale: "en-GB" });
  expect(app.texts()).toContain("Chat");
  await app.press("connection-settings");
  expect(app.texts()).toContain("Models");
  expect(app.texts()).toContain("Settings");
  await app.press("nav-settings");
  expect(app.texts()).toContain("General settings");
  await app.press("appearance-dark");
  expect(app.texts()).toContain("Active: Dark");
  await app.press("language-select");
  await app.press("简体中文");
  expect(app.texts()).toContain("通用设置");
  expect(app.texts()).toContain("模型");
  expect(app.texts()).toContain("当前生效：简体中文");
  await app.waitUntil(
    () =>
      app.storage()["language-preference"] === "zh-CN" &&
      app.storage()["appearance-preference"] === "dark",
  );
  const saved = app.storage();
  app.dispose();
  const restored = await open("./App.tsx", { locale: "en-US", storage: saved });
  expect(restored.texts()).toContain("对话");
  await restored.press("connection-settings");
  await restored.press("nav-settings");
  expect(restored.texts()).toContain("当前生效：深色");
  await restored.press("language-select");
  await restored.press("跟随系统");
  expect(restored.texts()).toContain("General settings");
  expect(restored.texts()).toContain("Models");
  await restored.press("nav-voice");
  expect(restored.texts()).toContain("Doubao live voice credentials");
  await restored.press("nav-home");
  expect(restored.texts()).toContain("Connect your Xiaomi Home account");
  await restored.press("nav-tasks");
  expect(restored.texts()).toContain("Tasks");
});

test("QuickJS formats English plurals and localized dates", async () => {
  const en = await open("./I18nProbe.tsx", { locale: "en-US" });
  expect(en.texts()).toContain("1 past action and Agent record");
  expect(en.texts()).toContain("2 past actions and Agent records");
  expect(en.texts()).toContain("November 8, 2026");
  expect(en.texts()).toContain("12,345");
  const zh = await open("./I18nProbe.tsx", { locale: "zh-Hans-CN" });
  expect(zh.texts()).toContain("共 2 条历史操作与 Agent 审计记录");
  expect(zh.texts()).toContain("2026年11月8日");
});
