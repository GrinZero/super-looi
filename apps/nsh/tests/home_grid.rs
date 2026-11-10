use nsh_core::{
    Command, Points,
    geometry::{point, size},
    platform::Locale,
};
use nsh_engine::EngineConfig;
use nsh_testing::{Headless, MemoryStorage, compile_tsx};
use std::{path::Path, time::Duration};

#[test]
fn overview_collapses_and_resize_handles_keep_the_touch_from_scrolling() -> Result<(), String> {
    let data = tempfile::tempdir().map_err(|error| error.to_string())?;
    let sets = vec![nsh_base::registry(), nsh_app_nsh::registry()];
    let bundle = compile_tsx(Path::new(env!("CARGO_MANIFEST_DIR")).join("App.tsx"), &sets)?;
    let mut config = EngineConfig::new(bundle.with_app_id(Some("com.superlooi.home-grid-test")));
    config.ui_sets = sets;
    config.data_dir = Some(data.path().to_owned());
    config.storage = Some(MemoryStorage::new([]));
    config.environment.locale = Locale::parse("zh-CN").unwrap();
    let mut app = Headless::start(config).map_err(|error| error.to_string())?;
    app.set_viewport(size(Points(1000.0), Points(700.0)))?;
    app.wait_until("app ready", Duration::from_secs(10), |screen| {
        screen.enabled("voice-toggle") == Ok(true)
    })?;
    app.press("connection-settings")?;
    app.press("nav-home")?;
    app.press("home-empty-enable-sim")?;
    app.wait_for("home-room-nav-all")?;

    app.press("home-overview-collapse")?;
    assert!(!app.shows("home-room-nav-all"));
    app.wait_for("home-room-rail-all")?;
    app.press("home-room-rail-大厅")?;
    assert!(app.screen().selected("home-room-rail-大厅")?);
    app.press("home-room-rail-all")?;
    assert!(app.screen().selected("home-room-rail-all")?);
    app.wait_for("id:home-card-simulation:sim_hall_camera")?;
    app.wait_for("home-overview-collapse")?;
    app.set_viewport(size(Points(390.0), Points(844.0)))?;
    assert!(!app.shows("home-room-pill-all"));
    app.press("home-overview-collapse")?;
    app.wait_for("home-room-pill-all")?;
    app.set_viewport(size(Points(1000.0), Points(700.0)))?;
    app.wait_for("home-room-nav-all")?;
    app.press("home-room-nav-大厅")?;
    app.press("home-overview-collapse")?;
    app.press("home-overview-collapse")?;
    assert!(app.screen().selected("home-room-nav-大厅")?);

    app.press("home-room-edit-大厅")?;
    for hidden in ["1x1", "2x1", "1x2", "2x2"] {
        assert!(!app.shows(hidden));
    }
    for (edge, delta) in [
        ("right", point(Points(-110.0), Points(-30.0))),
        ("bottom", point(Points(0.0), Points(-80.0))),
        ("corner", point(Points(110.0), Points(80.0))),
    ] {
        let selector = format!("id:home-resize-{edge}-simulation:sim_hall_camera");
        let responder = app
            .screen()
            .press_target(&selector)?
            .ok_or("resize target missing")?;
        let commands_before_drag = app.screen().commands().len();
        app.drag_and_hold(&selector, delta)?;
        assert!(
            app.screen().commands()[commands_before_drag..]
                .iter()
                .any(|(id, command)| {
                    *id == responder && matches!(command, Command::SetJsResponder { block: true })
                }),
            "{edge} resize must own the touch and block native scrolling"
        );
        let commands_before_release = app.screen().commands().len();
        app.drop_held()?;
        assert!(
            app.screen().commands()[commands_before_release..]
                .iter()
                .any(|(_, command)| { matches!(command, Command::ClearJsResponder) })
        );
    }
    app.press("home-room-edit-大厅")?;
    app.scroll("home-device-grid-scroll", Points(160.0))?;
    app.press("home-overview-collapse")?;
    app.wait_for("id:home-card-simulation:sim_hall_camera")?;
    Ok(())
}
