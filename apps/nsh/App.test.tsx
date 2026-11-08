import { expect, open, test } from "nsh/test";

test("keeps the pure face primary with inline ask bar and Structure 3 management shell", async () => {
  const app = await open("./App.tsx", { locale: "zh-CN" });

  // 1. Initial screen has LIVE 对话, 对话, 连接
  expect(app.texts()).toContain("LIVE 对话");
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

  // Verify space navigation buttons
  expect(app.texts()).toContain("模型");
  expect(app.texts()).toContain("语音");
  expect(app.texts()).toContain("家居");
  expect(app.texts()).toContain("任务");

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
  expect(app.texts()).toContain("开启 Hey LOOI 自动唤醒");
  expect(app.texts()).toContain("待机（未占用麦克风）");

  await app.press("nav-home");
  expect(app.texts()).toContain("米家直连");

  await app.press("nav-tasks");
  expect(app.texts()).toContain("任务与审计记录");

  // 5. Click appearance-cycle to cycle appearance modes (system -> light -> dark)
  expect(app.texts()).toContain("外观: 自动");
  await app.press("appearance-cycle");
  expect(app.texts()).toContain("外观: 日间");
  await app.press("appearance-cycle");
  expect(app.texts()).toContain("外观: 夜间");

  // 6. Return to robot face
  await app.press("back-to-face");
  expect(app.texts()).toContain("LIVE 对话");

  // 7. Test inline ask bar
  await app.press("compose");
  await app.type("message-input", "查看当前目录");
  expect(app.texts()).toContain("发送");
  await app.press("compose");
  expect(app.texts()).toContain("LIVE 对话");
});

test("language follows the system and a manual choice survives reopening", async () => {
  const app = await open("./App.tsx", { locale: "en-GB" });
  expect(app.texts()).toContain("Chat");
  await app.press("connection-settings");
  expect(app.texts()).toContain("Models");
  await app.press("language-zh");
  expect(app.texts()).toContain("模型");
  await app.waitUntil(() => app.storage()["language-preference"] === "zh-CN");
  const saved = app.storage();
  app.dispose();
  const restored = await open("./App.tsx", { locale: "en-US", storage: saved });
  expect(restored.texts()).toContain("对话");
  await restored.press("connection-settings");
  await restored.press("language-system");
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
