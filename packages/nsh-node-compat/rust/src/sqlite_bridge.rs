use crate::sandbox::Sandbox;
use rusqlite::{
    Connection, params_from_iter,
    types::{Value as SqlValue, ValueRef},
};
use serde_json::{Value, json};
use std::collections::HashMap;
pub struct Databases {
    next: u64,
    connections: HashMap<u64, Connection>,
}
impl Databases {
    pub fn new() -> Self {
        Self {
            next: 0,
            connections: HashMap::new(),
        }
    }
    pub fn call(&mut self, sandbox: &Sandbox, op: &str, v: &Value) -> Result<Value, String> {
        if op == "open" {
            if self.connections.len() >= 32 {
                return Err("EMFILE: database limit".into());
            }
            let path = v["path"].as_str().ok_or("missing database path")?;
            // SQLite uses sidecar files and its own path-based VFS. Keep its paths
            // in a private directory inaccessible to guest FS (see lib.rs).
            let connection = if path == ":memory:" {
                Connection::open_in_memory()
            } else {
                let path = sandbox.path(path).map_err(|e| e.to_string())?;
                if let Some(parent) = path.parent() {
                    sandbox
                        .dir
                        .create_dir_all(parent)
                        .map_err(|e| e.to_string())?;
                }
                let mut options = cap_std::fs::OpenOptions::new();
                options.read(true).write(true).create(true);
                let file = sandbox
                    .dir
                    .open_with(&path, &options)
                    .map_err(|e| e.to_string())?;
                drop(file);
                let real = sandbox.dir.canonicalize(&path).map_err(|e| e.to_string())?;
                // Host privately supplies an ambient root, never returned to JS.
                let root = v["root"].as_str().ok_or("missing private database root")?;
                Connection::open(std::path::Path::new(root).join(real))
            }
            .map_err(|e| e.to_string())?;
            connection
                .busy_timeout(std::time::Duration::from_millis(
                    v["timeout"].as_u64().unwrap_or(100).min(1000),
                ))
                .map_err(|e| e.to_string())?;
            connection
                .execute_batch("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;")
                .map_err(|e| e.to_string())?;
            use rusqlite::limits::Limit;
            connection
                .set_limit(Limit::SQLITE_LIMIT_LENGTH, 16 * 1024 * 1024)
                .map_err(|e| e.to_string())?;
            connection
                .set_limit(Limit::SQLITE_LIMIT_SQL_LENGTH, 1024 * 1024)
                .map_err(|e| e.to_string())?;
            connection
                .set_limit(Limit::SQLITE_LIMIT_ATTACHED, 0)
                .map_err(|e| e.to_string())?;
            connection
                .set_limit(Limit::SQLITE_LIMIT_VARIABLE_NUMBER, 10000)
                .map_err(|e| e.to_string())?;
            connection
                .authorizer(Some(|ctx: rusqlite::hooks::AuthContext<'_>| {
                    use rusqlite::hooks::{AuthAction, Authorization};
                    match ctx.action {
                        AuthAction::Attach { .. } | AuthAction::Detach { .. } => {
                            Authorization::Deny
                        }
                        AuthAction::Pragma { pragma_name, .. }
                            if ["temp_store_directory", "data_store_directory"]
                                .contains(&pragma_name) =>
                        {
                            Authorization::Deny
                        }
                        AuthAction::Function { function_name }
                            if function_name == "load_extension" =>
                        {
                            Authorization::Deny
                        }
                        _ => Authorization::Allow,
                    }
                }))
                .map_err(|e| e.to_string())?;
            self.next += 1;
            self.connections.insert(self.next, connection);
            return Ok(json!(self.next));
        }
        let id = v["id"].as_u64().ok_or("missing database id")?;
        if op == "close" {
            self.connections.remove(&id);
            return Ok(Value::Null);
        }
        let conn = self
            .connections
            .get(&id)
            .ok_or("ERR_INVALID_STATE: database is closed")?;
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(1000);
        conn.progress_handler(1000, Some(move || std::time::Instant::now() >= deadline))
            .map_err(|e| e.to_string())?;
        let sql = v["sql"].as_str().ok_or("missing SQL")?;
        if op == "exec" {
            conn.execute_batch(sql).map_err(|e| e.to_string())?;
            return Ok(Value::Null);
        }
        let args = v["args"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .map(|v| match v {
                Value::Null => SqlValue::Null,
                Value::Bool(b) => SqlValue::Integer(b as i64),
                Value::Number(n) => n
                    .as_i64()
                    .map(SqlValue::Integer)
                    .unwrap_or(SqlValue::Real(n.as_f64().unwrap_or(0.0))),
                Value::String(s) => SqlValue::Text(s),
                Value::Array(a) => SqlValue::Blob(
                    a.iter()
                        .filter_map(|v| v.as_u64().map(|i| i as u8))
                        .collect(),
                ),
                _ => SqlValue::Null,
            })
            .collect::<Vec<_>>();
        let mut statement = conn.prepare(sql).map_err(|e| e.to_string())?;
        if op == "run" {
            let changes = statement
                .execute(params_from_iter(args))
                .map_err(|e| e.to_string())?;
            return Ok(json!({"changes":changes,"lastInsertRowid":conn.last_insert_rowid()}));
        }
        let names = statement
            .column_names()
            .iter()
            .map(|s| s.to_string())
            .collect::<Vec<_>>();
        let rows = statement
            .query_map(params_from_iter(args), |row| {
                let mut obj = serde_json::Map::new();
                for (i, name) in names.iter().enumerate() {
                    let val = match row.get_ref(i)? {
                        ValueRef::Null => Value::Null,
                        ValueRef::Integer(i) => json!(i),
                        ValueRef::Real(f) => json!(f),
                        ValueRef::Text(t) => json!(String::from_utf8_lossy(t)),
                        ValueRef::Blob(b) => json!(b),
                    };
                    obj.insert(name.clone(), val);
                }
                Ok(Value::Object(obj))
            })
            .map_err(|e| e.to_string())?;
        let mut results = Vec::new();
        let mut size = 0;
        for row in rows {
            let row = row.map_err(|e| e.to_string())?;
            size += row.to_string().len();
            if results.len() >= 10000 || size > 16 * 1024 * 1024 {
                return Err("ENOBUFS: SQLite result limit".into());
            }
            results.push(row);
            if op == "get" {
                break;
            }
        }
        Ok(if op == "get" {
            results.into_iter().next().unwrap_or(Value::Null)
        } else {
            json!(results)
        })
    }
}
