import test from "node:test";
import assert from "node:assert/strict";
import { acknowledgementLanguage } from "../src/agent/conversation-language.js";

test("acknowledgements retain the answer language rather than quoted words", () => {
  assert.equal(acknowledgementLanguage("嗯", "Grass is green.", "zh-CN"), "en-US");
  assert.equal(acknowledgementLanguage("嗯", 'The Chinese word for hello is “你好”.', "zh-CN"), "en-US");
  assert.equal(acknowledgementLanguage("OK", "太阳从东方升起。", "en-US"), "zh-CN");
  assert.equal(acknowledgementLanguage("thanks", "这个变量叫 `helloWorld`，用于保存问候内容。", "en-US"), "zh-CN");
  assert.equal(acknowledgementLanguage("嗯", "已启用 Home Assistant。", "en-US"), "zh-CN");
  assert.equal(acknowledgementLanguage("嗯", "", "en-US"), "en-US");
  assert.equal(acknowledgementLanguage("Please answer in English", "你好。", "zh-CN"), undefined);
  assert.equal(acknowledgementLanguage("请用中文回答", "Hello.", "en-US"), undefined);
});
