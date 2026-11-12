use nsh_core::{Points, geometry::size, platform::Locale};
use nsh_engine::EngineConfig;
use nsh_node_compat::Bridge;
use nsh_testing::{Headless, MemoryStorage, compile_tsx};
use serde_json::{Value, json};
use std::{path::Path, time::Duration};

fn request(bridge: &Bridge, input: Value) -> Result<Value, String> {
    let response: Value = serde_json::from_str(&bridge.request(&input.to_string()))
        .map_err(|error| error.to_string())?;
    if let Some(error) = response.get("error") {
        return Err(error.to_string());
    }
    Ok(response["value"].clone())
}

fn open_app(data: &Path, locale: &str) -> Result<Headless, String> {
    let sets = vec![nsh_base::registry(), nsh_app_nsh::registry()];
    let bundle = compile_tsx(Path::new(env!("CARGO_MANIFEST_DIR")).join("App.tsx"), &sets)?;
    let mut config = EngineConfig::new(bundle.with_app_id(Some("com.superlooi.task-recovery-test")));
    config.ui_sets = sets;
    config.data_dir = Some(data.to_owned());
    config.storage = Some(MemoryStorage::new([]));
    config.environment.locale = Locale::parse(locale).ok_or("Invalid locale")?;
    let mut app = Headless::start(config).map_err(|error| error.to_string())?;
    app.set_viewport(size(Points(844.0), Points(390.0)))?;
    app.wait_until("runtime ready", Duration::from_secs(10), |screen| {
        screen.enabled("voice-toggle") == Ok(true)
    })?;
    Ok(app)
}

#[test]
fn past_task_errors_do_not_require_review_or_show_startup_reminders() -> Result<(), String> {
    for locale in ["zh-CN", "en-US"] {
        let data = tempfile::tempdir().map_err(|error| error.to_string())?;
        let original = json!({
            "id": "interrupted", "sessionId": "shared", "workspaceRoot": "/home/work",
            "prompt": "Inspect interrupted execution", "state": "unknown",
            "createdAt": "2026-11-12T03:00:00.000Z", "updatedAt": "2026-11-12T03:00:00.000Z",
            "runtimeExited": false, "error": "write: MIOT_ERROR_503", "steps": []
        });
        let home_task = json!({
            "id": "home", "sessionId": "shared", "workspaceRoot": "/home/work",
            "prompt": "Inspect home receipt", "state": "succeeded",
            "createdAt": "2026-11-12T02:00:00.000Z", "updatedAt": "2026-11-12T02:00:00.000Z",
            "runtimeExited": true, "steps": []
        });
        let evidence = json!({"requestId":"home-action", "status":"unknown", "receipt":{"code":503}});
        {
            let bridge = Bridge::new(&data.path().join("com.superlooi.task-recovery-test/node-compat"))?;
            let id = request(&bridge, json!({"op":"sqlite.open", "path":"/home/looi.sqlite"}))?;
            request(&bridge, json!({"op":"sqlite.exec", "id":id, "sql":
                "CREATE TABLE runtime_tasks(id TEXT PRIMARY KEY,snapshot TEXT NOT NULL); CREATE TABLE home_action_evidence(request_id TEXT PRIMARY KEY,task_id TEXT NOT NULL,evidence TEXT NOT NULL);"}))?;
            for task in [&original, &home_task] {
                request(&bridge, json!({"op":"sqlite.run", "id":id, "sql":"INSERT INTO runtime_tasks VALUES(?,?)", "args":[task["id"], task.to_string()]}))?;
            }
            request(&bridge, json!({"op":"sqlite.run", "id":id, "sql":"INSERT INTO home_action_evidence VALUES(?,?,?)", "args":["home-action", "home", evidence.to_string()]}))?;
        }
        let chinese = locale == "zh-CN";
        let standing_by = if chinese { "陪伴待机" } else { "Standing by" };
        let mut app = open_app(data.path(), locale)?;
        app.wait_for(standing_by)?;
        assert!(!app.shows("subtitle-capsule"));
        app.press("connection-settings")?;
        app.press("nav-tasks")?;
        app.wait_for("Inspect interrupted execution")?;
        assert!(!app.shows("review-task-btn"));
        app.press("task-interrupted")?;
        app.wait_for("text:write: MIOT_ERROR_503")?;
        app.press("back-to-face")?;
        app.wait_for(standing_by)?;
        assert!(!app.shows("subtitle-capsule"));
        drop(app);
        let mut restored = open_app(data.path(), locale)?;
        restored.wait_for(standing_by)?;
        assert!(!restored.shows("subtitle-capsule"));
        drop(restored);
        let bridge = Bridge::new(&data.path().join("com.superlooi.task-recovery-test/node-compat"))?;
        let id = request(&bridge, json!({"op":"sqlite.open", "path":"/home/looi.sqlite"}))?;
        for task in [&original, &home_task] {
            let row = request(&bridge, json!({"op":"sqlite.get", "id":id, "sql":"SELECT snapshot FROM runtime_tasks WHERE id=?", "args":[task["id"]]}))?;
            let saved: Value = serde_json::from_str(row["snapshot"].as_str().unwrap()).unwrap();
            assert_eq!(saved, *task);
        }
        let row = request(&bridge, json!({"op":"sqlite.get", "id":id, "sql":"SELECT evidence FROM home_action_evidence WHERE request_id='home-action'"}))?;
        assert_eq!(row["evidence"], evidence.to_string());
    }
    Ok(())
}
