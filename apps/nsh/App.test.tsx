import { expect, open, test } from "nsh/test";

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
