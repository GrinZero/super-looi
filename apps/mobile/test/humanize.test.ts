import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  humanizeArtifactId, humanizeCommitment, humanizeCommitmentRule, humanizeDesiredState, humanizeEntityId,
  humanizeEpistemicStatus, humanizeMemorySource, humanizeRuleCondition,
  humanizeSmartHomeRule, humanizeTaskSummary, humanizeWorkspaceId, resolveMemorySceneTarget,
} from "../src/ui/humanize.js";
import { correctDemoMemory, createDemoMemoryClaims } from "../src/ui/spaces/space-demo-state.js";

describe("humanized evidence retains epistemic boundaries", () => {
  it("translates source kinds without promoting observations to confirmation", () => {
    assert.equal(humanizeMemorySource("authenticated_user_statement"), "主人亲口确认");
    assert.equal(humanizeMemorySource("active_look_capture"), "视觉抓拍 + 语音");
    assert.equal(humanizeMemorySource("passive_observation"), "桌面视觉观察");
    assert.equal(humanizeMemorySource("pattern_inference"), "近期习惯推断");
    assert.equal(humanizeMemorySource("camera_frame"), "桌面视觉观察");
    assert.equal(humanizeMemorySource("unrecognized_source"), "来源待核实");
  });
  it("distinguishes facts, observations, guesses and revoked records", () => {
    assert.equal(humanizeEpistemicStatus("confirmed").color, "#4ADE80");
    assert.equal(humanizeEpistemicStatus("observed").color, "#28D5FF");
    assert.equal(humanizeEpistemicStatus("inferred").label, "模型推测");
    assert.equal(humanizeEpistemicStatus("inferred").color, "#F3C56B");
    assert.match(humanizeEpistemicStatus("inferred").description, /待主人确认/u);
    assert.match(humanizeEpistemicStatus("observed").description, /之后已被移动/u);
    assert.match(humanizeEpistemicStatus("retracted").description, /不再作为当前事实/u);
    assert.match(humanizeEpistemicStatus("superseded").description, /以新记录为准/u);
    assert.match(humanizeEpistemicStatus("candidate").description, /暂不作为事实/u);
    assert.equal(humanizeEpistemicStatus("future_status").label, "状态待核实");
  });
});

describe("natural home rules and commitments", () => {
  it("explains the target, condition and requested temperature without mutating the rule", () => {
    const rule = { entity_id: "light.study_ceiling", condition: 'context == "web_study"', desired_state: '{"service":"turn_on","color_temp_kelvin":4000}' };
    const original = structuredClone(rule);
    const formatted = humanizeSmartHomeRule(rule);
    assert.equal(formatted.title, "书房吸顶灯 · 进入书房学习时自动开启并调至 4000K 自然白光");
    assert.equal(formatted.description, "当进入书房学习时 → 自动开启并调至 4000K 自然白光");
    assert.deepEqual(rule, original);
    assert.deepEqual(humanizeCommitment(rule), formatted);
    assert.deepEqual(humanizeCommitmentRule(rule), formatted);
    assert.equal(humanizeRuleCondition("context == 'web_study'"), "进入书房学习时");
  });
  it("names devices and sensor channels with safe unknown fallbacks", () => {
    assert.equal(humanizeEntityId("light.study_desk"), "书房台灯");
    assert.equal(humanizeEntityId("fan.study_fresh_air"), "书房新风系统");
    assert.equal(humanizeEntityId("sensor.study_co2"), "书房二氧化碳");
    assert.equal(humanizeEntityId("sensor.study_temperature"), "书房温度");
    assert.equal(humanizeEntityId("sensor.study_humidity"), "书房湿度");
    assert.equal(humanizeEntityId("sensor.study_future"), "书房环境传感器");
    assert.equal(humanizeEntityId("unknown.device"), "家居设备");
  });
  it("handles off, brightness, malformed and unsupported payloads honestly", () => {
    assert.equal(humanizeDesiredState({ service: "turn_off", color_temp_kelvin: 4000 }), "自动关闭");
    assert.equal(humanizeDesiredState({ service: "turn_on", brightness: 128 }), "自动开启并调至 亮度 50%");
    assert.equal(humanizeDesiredState({ service: "toggle", color_temp_kelvin: 4000 }), "执行已约定的设备动作");
    for (const value of [null, [], "{invalid", '{"service":"turn_on","备注":"学习"', { color_temp_kelvin: Infinity }]) {
      assert.equal(humanizeDesiredState(value), "执行已约定的设备动作");
    }
    assert.equal(humanizeCommitment({ title: '{"service":"turn_on","备注":"学习"' }).title, "日常约定");
    assert.equal(humanizeRuleCondition('context == "unknown"'), "满足已设定的条件时");
  });
  it("preserves existing prose commitments and translates JSON-only actions", () => {
    assert.deepEqual(humanizeCommitment({ title: "每天提醒整理书桌", conditionDescription: "每天 18:00" }), { title: "每天提醒整理书桌", description: "每天 18:00" });
    assert.deepEqual(humanizeCommitment({ title: '{"service":"turn_on"}', conditionDescription: 'context == "web_study"' }), { title: "自动开启", description: "进入书房学习时" });
  });
});

describe("natural productivity descriptions", () => {
  it("names workspaces and artifacts", () => {
    assert.equal(humanizeWorkspaceId("ws_godot_island"), "Godot 海岛工程");
    assert.equal(humanizeWorkspaceId("ws_unknown"), "项目工作区");
    assert.equal(humanizeArtifactId("art_checklist"), "道路与阶梯核查清单");
    assert.equal(humanizeArtifactId("art_app"), "Godot 构建产物包");
    assert.equal(humanizeArtifactId("art_unknown"), "任务产物");
  });
  it("only reports verified success when the source explicitly says so", () => {
    assert.equal(humanizeTaskSummary("Task succeeded with 2 verified artifacts"), "任务已完成 · 2 项产物已回读核验");
    assert.equal(humanizeTaskSummary("Task succeeded with 1 verified artifact."), "任务已完成 · 1 项产物已回读核验");
    assert.equal(humanizeTaskSummary("High-risk command requires user approval: git push --force"), "检测到高危命令，等待主人单次授权");
    assert.doesNotMatch(humanizeTaskSummary("Task failed with 2 verified artifacts"), /已完成|已回读核验/u);
    assert.equal(humanizeTaskSummary("连接中断，结果待核实"), "连接中断，结果待核实");
    assert.equal(humanizeTaskSummary("unrecognized summary"), "任务详情已记录，可查看当前执行阶段");
  });
});

describe("memory scene anchors follow the recorded location", () => {
  it("has distinct two-dimensional anchors for all four regions", () => {
    const targets = ["书桌键盘左侧", "显示器右侧", "书房书架", "右侧抽屉里"].map((location) => resolveMemorySceneTarget(location, "钥匙"));
    assert.deepEqual(targets.map((target) => target.zone), ["keyboard_left", "monitor_right", "bookshelf", "drawer_right"]);
    assert.equal(new Set(targets.map((target) => target.xPercent)).size, 4);
    assert.equal(new Set(targets.map((target) => target.yPercent)).size, 4);
    for (const target of targets) {
      assert.ok(target.xPercent > 0 && target.xPercent < 100);
      assert.ok(target.yPercent > 0 && target.yPercent < 100);
    }
  });
  it("prioritizes explicit locations over titles and handles coaster and monitor depth", () => {
    assert.equal(resolveMemorySceneTarget("右侧抽屉里", "书本").zone, "drawer_right");
    assert.equal(resolveMemorySceneTarget("键盘左侧", "水杯").zone, "keyboard_left");
    assert.equal(resolveMemorySceneTarget("", "笔记本").zone, "bookshelf");
    assert.notDeepEqual(resolveMemorySceneTarget("杯垫上", "水杯"), resolveMemorySceneTarget("显示器右侧", "水杯"));
    assert.ok(resolveMemorySceneTarget("显示器后面", "耳机").yPercent < resolveMemorySceneTarget("显示器右侧", "耳机").yPercent);
  });
  it("moves the same item's anchor after a user location correction", () => {
    const keys = createDemoMemoryClaims()[0]!;
    const corrected = correctDemoMemory(keys, "右侧抽屉里");
    const before = keys.object as Record<string, string>;
    const after = corrected.object as Record<string, string>;
    assert.notDeepEqual(resolveMemorySceneTarget(before.location!, before.target!), resolveMemorySceneTarget(after.location!, after.target!));
    assert.equal(keys.revision + 1, corrected.revision);
    assert.equal(corrected.status, "confirmed");
  });
});

describe("Presence v3 task presentation and scene fallbacks", () => {
  it("keeps machine summaries and statuses out of primary prose without inventing verified success", () => {
    assert.equal(humanizeTaskSummary("awaiting_approval"), "等待单次授权");
    assert.equal(humanizeTaskSummary("本地演示已进入 running，等待回读"), "本地演示已进入 执行中，等待回读");
    assert.doesNotMatch(humanizeTaskSummary("succeeded"), /已回读核验/u);
    for (const summary of ['{"service":"turn_on","备注":"学习"}', 'context == "web_study"', "Unrecognized runner status"]) {
      assert.equal(humanizeTaskSummary(summary), "任务详情已记录，可查看当前执行阶段");
    }
    assert.equal(humanizeWorkspaceId("/workspaces/super-looi-demo"), "LOOI 演示工程");
    assert.equal(humanizeArtifactId("reports/collision-review.md"), "楼梯碰撞核查报告");
  });

  it("uses object fallbacks only after considering a recorded location", () => {
    assert.equal(resolveMemorySceneTarget("", "充电线").zone, "drawer_right");
    assert.equal(resolveMemorySceneTarget("", "AirPods").zone, "monitor_right");
    assert.equal(resolveMemorySceneTarget("键盘左侧", "充电线").zone, "keyboard_left");
    assert.equal(resolveMemorySceneTarget("书架第二层", "AirPods").zone, "bookshelf");
    assert.equal(resolveMemorySceneTarget("右侧抽屉", "耳机盒").zone, "drawer_right");
  });
});
