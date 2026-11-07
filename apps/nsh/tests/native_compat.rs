use nsh_engine::EngineConfig;
use nsh_testing::{Headless, compile_tsx};
use std::{path::Path, time::Duration};

#[test]
fn real_nsh_engine_with_private_data_runs_node_codemode_and_sdk() -> Result<(), String> {
    let sets = vec![nsh_base::registry(), nsh_app_nsh::registry()];
    let bundle = compile_tsx(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("CompatProbe.tsx"),
        &sets,
    )?;
    assert!(
        bundle.policy.harden,
        "the probe must exercise release hardening"
    );
    let temp = tempfile::tempdir().map_err(|e| e.to_string())?;
    let mut config = EngineConfig::new(bundle.with_app_id(Some("com.superlooi.compat-test")));
    config.ui_sets = sets;
    config.data_dir = Some(temp.path().to_owned());
    config.limits = nsh_core::js::Limits::default();
    let mut app = Headless::start(config).map_err(|e| e.to_string())?;
    app.wait_for_within("Native bridge verified", Duration::from_secs(20))?;
    Ok(())
}

#[test]
fn real_app_task_and_home_panels() -> Result<(), String> {
    let sets = vec![nsh_base::registry(), nsh_app_nsh::registry()];
    let bundle = compile_tsx(Path::new(env!("CARGO_MANIFEST_DIR")).join("App.tsx"), &sets)?;
    let temp = tempfile::tempdir().map_err(|e| e.to_string())?;
    let mut config = EngineConfig::new(bundle.with_app_id(Some("com.superlooi.ui-test")));
    config.ui_sets = sets;
    config.data_dir = Some(temp.path().to_owned());
    let mut app = Headless::start(config).map_err(|e| e.to_string())?;
    app.wait_for_within("陪伴待机", Duration::from_secs(10))?;
    app.press("compose")?;
    app.wait_for_within("发送", Duration::from_secs(5))?;
    app.press("compose")?;
    app.press("connection-settings")?;
    app.wait_for_within("OpenAI / ChatGPT", Duration::from_secs(5))?;
    app.press("nav-voice")?;
    app.wait_for_within("豆包实时语音 API Key", Duration::from_secs(5))?;
    app.press("back-to-face")?;
    app.wait_for_within("陪伴待机", Duration::from_secs(5))?;
    Ok(())
}
