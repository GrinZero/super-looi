use nsh_core::{MountItem, ViewKind};
use nsh_engine::EngineConfig;
use nsh_testing::{Headless, compile_tsx};
use std::{path::Path, sync::{Arc, Mutex}, time::Duration};

#[test]
fn camera_native_node_survives_dashboard_poll_and_unmounts_on_exit() -> Result<(), String> {
    let sets = vec![nsh_base::registry(), nsh_app_nsh::registry()];
    let bundle = compile_tsx(Path::new(env!("CARGO_MANIFEST_DIR")).join("HomeCameraProbe.tsx"), &sets)?;
    let mut config = EngineConfig::new(bundle);
    config.ui_sets = sets;
    let mut app = Headless::start(config).map_err(|error|error.to_string())?;
    let videos = Arc::new(Mutex::new(Vec::new()));
    let captured = videos.clone();
    app.observe(move |_step, batch| {
        for item in &batch.items {
            if let MountItem::Create {id,kind:ViewKind::Native} = item { captured.lock().unwrap().push(*id); println!("native camera created: node={id}"); }
        }
    });
    app.wait_for_within("home-camera-video", Duration::from_secs(5))?;
    assert_eq!(app.screen().count("home-camera-video")?, 1);
    let initial_ids = videos.lock().unwrap().clone();
    assert_eq!(initial_ids.len(), 1, "one native video is mounted");
    for _ in 0..3 { app.press("Poll dashboard")?; }
    assert!(app.screen().texts().iter().any(|text| text.contains("Room") && text.contains("Off")),
        "the stable camera detail must still update its device status");
    println!("after 3 dashboard replacements: Camera nodes={:?}", *videos.lock().unwrap());
    assert_eq!(*videos.lock().unwrap(), initial_ids, "polling must retain the native player's node ID");
    app.press("home-detail-back")?;
    assert_eq!(app.screen().count("home-camera-video")?, 0);
    println!("after leaving detail: native camera count=0");
    Ok(())
}

#[test]
fn camera_fullscreen_hands_off_single_native_node_and_restores_inline() -> Result<(), String> {
    let sets = vec![nsh_base::registry(), nsh_app_nsh::registry()];
    let bundle = compile_tsx(Path::new(env!("CARGO_MANIFEST_DIR")).join("HomeCameraProbe.tsx"), &sets)?;
    let mut config = EngineConfig::new(bundle);
    config.ui_sets = sets;
    let mut app = Headless::start(config).map_err(|error| error.to_string())?;
    let videos = Arc::new(Mutex::new(Vec::new()));
    let captured = videos.clone();
    app.observe(move |_step, batch| {
        for item in &batch.items {
            if let MountItem::Create { id, kind: ViewKind::Native } = item {
                captured.lock().unwrap().push(*id);
            }
        }
    });

    app.wait_for_within("home-camera-video", Duration::from_secs(5))?;
    assert_eq!(app.screen().count("home-camera-video")?, 1);
    assert_eq!(app.screen().count("home-camera-fullscreen-video")?, 0);
    assert_eq!(videos.lock().unwrap().len(), 1);

    // Schedule a background dashboard replacement and enter fullscreen immediately.
    app.press("Queue poll")?;
    app.press("home-camera-fullscreen-trigger")?;
    app.wait_for_within("home-camera-fullscreen-video", Duration::from_secs(5))?;
    assert_eq!(app.screen().count("home-camera-fullscreen-video")?, 1);
    assert_eq!(app.screen().count("home-camera-video")?, 0);
    let fullscreen_ids = videos.lock().unwrap().clone();
    assert_eq!(fullscreen_ids.len(), 2, "entering fullscreen swaps to one modal native node");

    // Verify the scheduled dashboard update lands inside fullscreen without recreating the player.
    app.wait_for_within("Polled", Duration::from_secs(5))?;
    assert_eq!(*videos.lock().unwrap(), fullscreen_ids, "polling must retain the fullscreen native node ID");

    // Close via explicit fullscreen close button and verify inline stream restores without leaking nodes.
    app.press("home-camera-fullscreen-close")?;
    app.wait_for_within("home-camera-video", Duration::from_secs(5))?;
    assert_eq!(app.screen().count("home-camera-fullscreen-video")?, 0);
    assert_eq!(app.screen().count("home-camera-video")?, 1);
    assert_eq!(videos.lock().unwrap().len(), 3, "restoring inline must create exactly one inline node");

    // Re-enter fullscreen and dismiss via back/Escape, staying on the camera detail view.
    app.press("home-camera-fullscreen-trigger")?;
    app.wait_for_within("home-camera-fullscreen-video", Duration::from_secs(5))?;
    assert_eq!(videos.lock().unwrap().len(), 4, "re-entering fullscreen must create exactly one modal node");
    app.back()?;
    app.wait_for_within("home-camera-video", Duration::from_secs(5))?;
    assert_eq!(app.screen().count("home-camera-fullscreen-video")?, 0);
    assert_eq!(app.screen().count("home-camera-video")?, 1);
    assert_eq!(app.screen().count("home-detail-back")?, 1);
    assert_eq!(videos.lock().unwrap().len(), 5, "returning from fullscreen must restore exactly one inline node");
    Ok(())
}
