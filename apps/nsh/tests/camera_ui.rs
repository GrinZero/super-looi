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
            if let MountItem::Create {id,kind:ViewKind::Video} = item { captured.lock().unwrap().push(*id); println!("native Video created: node={id}"); }
        }
    });
    app.wait_for_within("home-camera-video", Duration::from_secs(5))?;
    assert_eq!(app.screen().count("home-camera-video")?, 1);
    let initial_ids = videos.lock().unwrap().clone();
    assert_eq!(initial_ids.len(), 1, "one native video is mounted");
    for _ in 0..3 { app.press("Poll dashboard")?; }
    assert!(app.screen().texts().iter().any(|text| text.contains("Room") && text.contains("Off")),
        "the stable camera detail must still update its device status");
    println!("after 3 dashboard replacements: Video nodes={:?}", *videos.lock().unwrap());
    assert_eq!(*videos.lock().unwrap(), initial_ids, "polling must retain the native player's node ID");
    app.press("home-detail-back")?;
    assert_eq!(app.screen().count("home-camera-video")?, 0);
    println!("after leaving detail: native Video count=0");
    Ok(())
}
