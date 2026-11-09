import { expect, open, test } from "nsh/test";

test("home shows loading before its first result and keeps rooms during refresh", async () => {
  const app = await open("./HomeLoadingProbe.tsx", { locale: "zh-CN" });
  expect(app.texts()).toContain("正在加载家居设备…");
  expect(app.texts().includes("尚未开启家居设备源")).toBe(false);
  expect(app.texts().includes("前往服务绑定")).toBe(false);
  await app.press("Finish loading");
  await app.waitFor("测试客厅");
  expect(app.texts().includes("正在加载家居设备…")).toBe(false);
  await app.press("Refresh devices");
  expect(app.texts()).toContain("测试客厅");
  expect(app.texts().includes("尚未开启家居设备源")).toBe(false);
  await app.press("Finish empty");
  await app.waitFor("尚未开启家居设备源");
  expect(app.texts().includes("正在加载家居设备…")).toBe(false);
});

test("home loading has English copy", async () => {
  const app = await open("./HomeLoadingProbe.tsx", { locale: "en-US" });
  expect(app.texts()).toContain("Loading home devices…");
  expect(app.texts().includes("No Smart Home Source Active")).toBe(false);
});
