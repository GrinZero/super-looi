use nsh_engine::EngineConfig;
use nsh_testing::{Headless, MemoryStorage, compile_tsx};
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
    let storage = MemoryStorage::new([]);
    let mut config = EngineConfig::new(bundle.with_app_id(Some("com.superlooi.ui-test")));
    config.ui_sets = sets;
    config.data_dir = Some(temp.path().to_owned());
    config.storage = Some(storage.clone());
    let mut app = Headless::start(config).map_err(|e| e.to_string())?;
    app.wait_for_within("Standing by", Duration::from_secs(10))?;
    app.set_environment("system Chinese", |environment| {
        environment.locale = nsh_core::platform::Locale::parse("zh-CN").unwrap();
    })?;
    app.wait_for("陪伴待机")?;
    app.set_environment("system English", |environment| {
        environment.locale = nsh_core::platform::Locale::parse("en-US").unwrap();
    })?;
    app.wait_for("Standing by")?;
    app.press("compose")?;
    app.wait_for_within("Send", Duration::from_secs(5))?;
    app.press("compose")?;
    app.press("connection-settings")?;
    app.wait_for_within("OpenAI / ChatGPT", Duration::from_secs(5))?;
    app.press("nav-voice")?;
    app.wait_for_within("Doubao live voice credentials", Duration::from_secs(5))?;
    app.press("nav-settings")?;
    app.wait_for_within("Task approval mode", Duration::from_secs(5))?;
    app.press("task-approval-yolo")?;
    app.wait_until("YOLO setting saved", Duration::from_secs(5), |_| {
        storage.entries().get("task-approval-mode").map(String::as_str) == Some("yolo")
    })?;
    app.press("back-to-face")?;
    app.wait_for_within("Standing by", Duration::from_secs(5))?;
    Ok(())
}

#[test]
fn wake_guide_stays_hidden_after_first_press_and_relaunch() -> Result<(), String> {
    let temp = tempfile::tempdir().map_err(|e| e.to_string())?;
    let storage = MemoryStorage::new([]);
    let start = || -> Result<Headless, String> {
        let sets = vec![nsh_base::registry(), nsh_app_nsh::registry()];
        let bundle = compile_tsx(Path::new(env!("CARGO_MANIFEST_DIR")).join("App.tsx"), &sets)?;
        let mut config =
            EngineConfig::new(bundle.with_app_id(Some("com.superlooi.wake-guide-test")));
        config.ui_sets = sets;
        config.data_dir = Some(temp.path().to_owned());
        config.storage = Some(storage.clone());
        Headless::start(config).map_err(|e| e.to_string())
    };

    let mut app = start()?;
    app.wait_for("wake-guide")?;
    app.wait_until("voice ready", Duration::from_secs(10), |screen| {
        screen.enabled("voice-toggle") == Ok(true)
    })?;
    app.press("wake-guide")?;
    app.wait_for("back-to-face")?;
    app.press("back-to-face")?;
    app.wait_for_gone("wake-guide", Duration::from_secs(5))?;
    assert_eq!(
        storage
            .entries()
            .get("wake-guide-dismissed")
            .map(String::as_str),
        Some("true")
    );
    drop(app);

    let mut relaunched = start()?;
    relaunched.wait_until("voice ready", Duration::from_secs(10), |screen| {
        screen.enabled("voice-toggle") == Ok(true)
    })?;
    relaunched.wait_for_gone("wake-guide", Duration::from_secs(5))?;
    Ok(())
}
