import { expect, open, test } from "nsh/test";

test("keeps the pure face primary with inline ask bar and connection settings", async () => {
  const app = await open("./App.tsx");
  expect(app.texts()).toContain("LIVE 对话");
  expect(app.texts()).toContain("对话");
  expect(app.texts()).toContain("连接");
  await app.press("connection-settings");
  expect(app.texts()).toContain("连接设置");
  expect(app.texts()).toContain("API Key");
  expect(app.texts()).toContain("豆包实时语音 API Key");
  await app.press("关闭");
  expect(app.texts()).toContain("LIVE 对话");
  await app.press("compose");
  await app.type("message-input", "查看当前目录");
  expect(app.texts()).toContain("发送");
  await app.press("compose");
  expect(app.texts()).toContain("LIVE 对话");
});
