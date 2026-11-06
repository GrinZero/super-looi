import { expect, open, test } from "nsh/test";

test("keeps the face primary and opens connection settings", async () => {
  const app = await open("./App.tsx");
  expect(app.texts()).toContain("LOOI");
  expect(app.texts()).toContain("对话");
  await app.press("connection-settings");
  expect(app.texts()).toContain("连接设置");
  expect(app.texts()).toContain("API Key");
  await app.press("关闭");
  expect(app.texts()).toContain("LOOI");
  await app.press("compose");
  await app.type("message-input", "记住钥匙在书架上");
  expect(app.texts()).toContain("记住、回忆和忘记可以在本机离线使用。");
  await app.press("取消");
  expect(app.texts()).toContain("LOOI");
});
