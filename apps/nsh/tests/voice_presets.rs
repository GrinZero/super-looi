use nsh_core::platform::Locale;
use nsh_engine::EngineConfig;
use nsh_testing::{Headless, compile_tsx};
use std::{path::Path, time::Duration};

fn open_voice_page(data: &Path, locale: &str) -> Result<Headless, String> {
    let sets = vec![nsh_base::registry(), nsh_app_nsh::registry()];
    let bundle = compile_tsx(Path::new(env!("CARGO_MANIFEST_DIR")).join("App.tsx"), &sets)?;
    let mut config = EngineConfig::new(bundle.with_app_id(Some("com.superlooi.voice-presets-test")));
    config.ui_sets = sets;
    config.data_dir = Some(data.to_owned());
    config.environment.locale = Locale::parse(locale).ok_or("Invalid test locale")?;
    let mut app = Headless::start(config).map_err(|error| error.to_string())?;
    app.wait_until("app ready", Duration::from_secs(10), |screen| {
        screen.enabled("voice-toggle") == Ok(true)
    })?;
    app.press("connection-settings")?;
    app.press("nav-voice")?;
    app.wait_for("edit-voice-id")?;
    Ok(app)
}

#[test]
fn voice_picker_selects_named_presets_and_keeps_custom_ids_optional() -> Result<(), String> {
    for (locale, recommended, preset, custom, width, height) in [
        ("zh-CN", "推荐音色", "小何 2.0", "使用专属音色 ID…", 844.0, 390.0),
        ("en-US", "Recommended voices", "Xiaohe 2.0", "Use a custom voice ID…", 390.0, 844.0),
    ] {
        let data = tempfile::tempdir().map_err(|error| error.to_string())?;
        let mut app = open_voice_page(data.path(), locale)?;
        app.set_viewport(nsh_core::geometry::size(nsh_core::Points(width), nsh_core::Points(height)))?;
        app.press("edit-voice-id")?;
        app.wait_for("voice-preset-select")?;
        app.press("voice-preset-select")?;
        app.wait_for(recommended)?;
        app.press(preset)?;
        app.wait_for(preset)?;
        assert!(!app.shows("voice-id"));
        app.press("voice-preset-select")?;
        app.press_key("End")?;
        app.wait_for(custom)?;
        app.press(custom)?;
        app.wait_for("voice-id")?;
        app.type_text("voice-id", "S_LooiWarm")?;
        app.press("cancel-voice-id")?;
        app.wait_for_gone("voice-preset-select", Duration::from_secs(3))?;
        assert!(!app.shows("voice-id"));
    }
    Ok(())
}
