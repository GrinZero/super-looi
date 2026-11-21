use nsh_core::{Points, geometry::size};
use nsh_engine::EngineConfig;
use nsh_testing::{Headless, compile_tsx};
use std::path::Path;

#[test]
fn trace_inspector_expands_context_and_updates_the_same_tool_row() -> Result<(), String> {
    let sets = vec![nsh_base::registry()];
    let bundle = compile_tsx(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/TaskTraceFixture.tsx"),
        &sets,
    )?;
    let mut config = EngineConfig::new(bundle);
    config.ui_sets = sets;
    let mut app = Headless::start(config).map_err(|error| error.to_string())?;
    app.set_viewport(size(Points(844.0), Points(390.0)))?;
    app.wait_for("task-tab-overview")?;
    assert!(app.screen().selected("task-fixture-task")?);
    assert!(app.screen().selected("task-tab-overview")?);
    app.press("task-tab-activity")?;
    app.wait_for("实际执行链路")?;
    app.wait_for("实时命令输出")?;
    app.wait_for("本轮载入 1 条历史消息")?;
    app.press("trace-context")?;
    app.wait_for("获取当前准确的具体时间，精确到时分秒")?;
    app.wait_for("真实系统指令")?;
    app.press("trace-context")?;
    app.press("trace-search")?;
    app.press("finish-search")?;
    app.wait_for("真实搜索词")?;
    assert!(app.screen().selected("task-tab-activity")?);
    assert!(!app.shows("实时命令输出"));
    assert_eq!(
        app.screen()
            .texts()
            .iter()
            .filter(|text| text.contains("web_search"))
            .count(),
        1
    );
    app.press("task-tab-overview")?;
    app.wait_for("这是最终回答。")?;
    app.press("task-tab-receipts")?;
    app.wait_for("退出码 0")?;
    app.press("receipt-command-command")?;
    app.wait_for("/fixture/project")?;
    app.press("task-tab-activity")?;
    app.wait_for("搜索动作与状态")?;

    app.press("tasks-next")?;
    app.wait_for("第 2 / 2 页")?;
    assert!(app.screen().selected("task-legacy")?);
    assert!(app.screen().selected("task-tab-overview")?);
    app.wait_for("[stage=write code=EIO] 写入失败")?;
    app.press("task-tab-activity")?;
    app.wait_for("旧版步骤甲")?;
    app.wait_for("旧版步骤乙")?;
    app.wait_for("此任务未保存完整链路。以下仅为旧版状态摘要，未记录模型输入和工具回执。")?;
    app.press("tasks-prev")?;
    app.wait_for("第 1 / 2 页")?;
    assert!(app.screen().selected("task-fixture-task")?);

    app.press("task-voice_tool_brightness-failed")?;
    app.wait_for("语音控制家居 · 大厅台灯")?;
    app.wait_for("tool.control_home_device · INVALID_ARGUMENT · expected integer, got string")?;
    app.press("task-tab-activity")?;
    app.press("trace-brightness-failed")?;
    app.wait_for("返回内容")?;
    assert!(app.screen().texts().iter().any(|text| text.contains("INVALID_ARGUMENT")));
    app.press("task-voice_tool_brightness-applied")?;
    app.press("task-tab-receipts")?;
    app.wait_for("返回内容")?;
    assert!(app.screen().texts().iter().any(|text| text.contains("\"brightness\": 255")));
    app.press("task-fixture-task")?;

    app.set_viewport(size(Points(568.0), Points(320.0)))?;
    app.press("task-detail-close")?;
    app.wait_for("task-fixture-task")?;
    app.press("task-fixture-task")?;
    app.wait_for("task-tab-overview")?;
    Ok(())
}
