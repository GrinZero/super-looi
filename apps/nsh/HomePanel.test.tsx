import { expect, open, test } from "nsh/test";

test("saved MIoT account actions stay scoped to the displayed region", async () => {
  const app = await open("./HomePanelProbe.tsx");
  expect(app.texts()).toContain("连接已保存的米家账号");
  expect(app.texts().includes("退出米家账号")).toBe(false);
  await app.press("米家服务区域");
  await app.press("新加坡");
  expect(app.texts().includes("连接已保存的米家账号")).toBe(false);
  expect(app.texts().includes("退出米家账号")).toBe(false);
  await app.press("米家服务区域");
  await app.press("中国大陆");
  await app.press("home-miot-refresh");
  await app.waitFor("Read devices: direct_miot/cn");
  expect(app.texts()).toContain("退出米家账号");
  await app.press("home-miot-logout");
  await app.waitFor("Logged out: cn");
  expect(app.texts().includes("退出米家账号")).toBe(false);
});
