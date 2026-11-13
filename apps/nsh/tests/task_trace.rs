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
    app.wait_for("实际执行链路")?;
    assert!(app.screen().selected("task-fixture-task")?);
    app.wait_for("本轮载入 1 条历史消息")?;
    app.press("trace-context")?;
    app.wait_for("获取当前准确的具体时间，精确到时分秒")?;
    app.wait_for("真实系统指令")?;
    app.press("trace-context")?;
    app.press("trace-search")?;
    app.press("finish-search")?;
    app.wait_for("真实搜索词")?;
    assert_eq!(
        app.screen()
            .texts()
            .iter()
            .filter(|text| text.contains("web_search"))
            .count(),
        1
    );
    app.press("legacy-task")?;
    app.wait_for("旧版步骤甲")?;
    app.wait_for("旧版步骤乙")?;
    app.wait_for("此任务未保存完整链路。以下仅为旧版状态摘要，未记录模型输入和工具回执。")?;
    Ok(())
}
