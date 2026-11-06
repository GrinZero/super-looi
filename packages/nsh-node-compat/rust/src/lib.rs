mod fs_bridge;
pub mod sandbox;
mod shell_bridge;
mod sqlite_bridge;
use rquickjs::{Ctx, Function};
use serde_json::{Value, json};
use std::{
    cell::RefCell,
    path::Path,
    rc::Rc,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

/// Call on the NSH-owned context before loading the bundled app. Uses the exact
/// NSH v0.4.0 VM type; no second VM and no ambient Node/OS process capabilities.
pub fn install(ctx: &Ctx<'_>, data_root: &Path) -> rquickjs::Result<()> {
    let fs = Arc::new(
        sandbox::Sandbox::new(&data_root.join("files"))
            .map_err(|e| rquickjs::Error::new_from_js_message("io", "sandbox", e.to_string()))?,
    );
    let db_root = data_root.join("sqlite");
    let db_sandbox = sandbox::Sandbox::new(&db_root)
        .map_err(|e| rquickjs::Error::new_from_js_message("io", "sqlite", e.to_string()))?;
    let files = RefCell::new(fs_bridge::Handles::new(
        std::fs::canonicalize(data_root.join("files"))
            .map_err(|e| rquickjs::Error::new_from_js_message("io", "watch root", e.to_string()))?,
    ));
    let databases = Rc::new(RefCell::new(sqlite_bridge::Databases::new()));
    let jobs: Arc<Mutex<std::collections::HashMap<String, Arc<AtomicBool>>>> =
        Arc::new(Mutex::new(std::collections::HashMap::new()));
    let async_fs = fs.clone();
    let async_jobs = jobs.clone();
    ctx.globals().set(
        "__nsh_shell_wait",
        Function::new(
            ctx.clone(),
            rquickjs::prelude::Async(move |request: String| {
                let fs = async_fs.clone();
                let jobs = async_jobs.clone();
                async move {
                    let result = (|| -> Result<(Value, String, Arc<AtomicBool>), String> {
                        let v: Value = serde_json::from_str(&request).map_err(|e| e.to_string())?;
                        let id = v["id"].as_str().ok_or("missing job")?.to_owned();
                        let token = jobs
                            .lock()
                            .map_err(|e| e.to_string())?
                            .get(&id)
                            .cloned()
                            .ok_or("unknown job")?;
                        Ok((v, id, token))
                    })();
                    let result = match result {
                        Ok((v, id, token)) => {
                            let result = tokio::task::spawn_blocking(move || {
                                shell_bridge::execute_cancelable(&fs, &v, token)
                            })
                            .await
                            .map_err(|e| e.to_string())
                            .and_then(|r| r);
                            jobs.lock().unwrap().remove(&id);
                            result
                        }
                        Err(e) => Err(e),
                    };
                    match result {
                        Ok(value) => json!({"value":value}).to_string(),
                        Err(error) => json!({"error":error}).to_string(),
                    }
                }
            }),
        )?,
    )?;
    let bridge = Function::new(ctx.clone(), move |request: String| -> String {
        let result = (|| -> Result<Value, String> {
            let mut v: Value = serde_json::from_str(&request).map_err(|e| e.to_string())?;
            let op = v["op"].as_str().ok_or("missing operation")?.to_owned();
            if let Some(op) = op.strip_prefix("fs.") {
                return files.borrow_mut().call(&fs, op, &v);
            }
            if let Some(op) = op.strip_prefix("sqlite.") {
                v["root"] = json!(db_root);
                return databases.borrow_mut().call(&db_sandbox, op, &v);
            }
            if op == "shell.create" {
                let mut jobs = jobs.lock().map_err(|e| e.to_string())?;
                if jobs.len() >= 16 {
                    return Err("too many shell jobs".into());
                }
                let id = uuid::Uuid::new_v4().to_string();
                jobs.insert(id.clone(), Arc::new(AtomicBool::new(false)));
                return Ok(json!(id));
            }
            if op == "shell.cancel" {
                if let Some(id) = v["id"].as_str() {
                    if let Some(token) = jobs.lock().map_err(|e| e.to_string())?.get(id) {
                        token.store(true, Ordering::Relaxed);
                    }
                }
                return Ok(Value::Null);
            }
            if op == "shell" {
                return shell_bridge::execute(&fs, &v);
            }
            if op == "crc32" {
                let data: Vec<u8> =
                    serde_json::from_value(v["data"].clone()).map_err(|e| e.to_string())?;
                let mut hasher =
                    crc32fast::Hasher::new_with_initial(v["seed"].as_u64().unwrap_or(0) as u32);
                hasher.update(&data);
                return Ok(json!(hasher.finalize()));
            }
            if op == "uuid" {
                return Ok(json!(uuid::Uuid::new_v4().to_string()));
            }
            Err(format!("ERR_NOT_SUPPORTED: {op}"))
        })();
        match result {
            Ok(value) => json!({"value":value}).to_string(),
            Err(error) => json!({"error":error}).to_string(),
        }
    })?;
    ctx.globals().set("__nsh_compat", bridge)?;
    Ok(())
}
