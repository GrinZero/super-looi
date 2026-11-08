use crate::sandbox::Sandbox;
use notify::Watcher;
use serde_json::{Value, json};
use std::io::{Read, Seek, SeekFrom, Write};
const MAX_BYTES: u64 = 16 * 1024 * 1024;
fn text<'a>(v: &'a Value, key: &str) -> Result<&'a str, String> {
    v[key].as_str().ok_or_else(|| format!("missing {key}"))
}
pub fn call(s: &Sandbox, op: &str, v: &Value) -> Result<Value, String> {
    run(s, op, v).map_err(|e| {
        format!(
            "{}: {e}",
            match e.kind() {
                std::io::ErrorKind::NotFound => "ENOENT",
                std::io::ErrorKind::PermissionDenied => "EACCES",
                std::io::ErrorKind::AlreadyExists => "EEXIST",
                _ => "EIO",
            }
        )
    })
}
fn run(s: &Sandbox, op: &str, v: &Value) -> std::io::Result<Value> {
    let path = s.path(text(v, "path").map_err(std::io::Error::other)?)?;
    Ok(match op {
        "read" => {
            let mut file = s.dir.open(&path)?;
            file.seek(SeekFrom::Start(v["offset"].as_u64().unwrap_or(0)))?;
            let limit = v["length"].as_u64().unwrap_or(MAX_BYTES).min(MAX_BYTES);
            let mut data = vec![];
            file.take(if v["length"].is_number() {
                limit
            } else {
                limit + 1
            })
            .read_to_end(&mut data)?;
            if data.len() as u64 > limit {
                return Err(std::io::Error::other("file exceeds read limit"));
            }
            json!(data)
        }
        "write" | "append" => {
            let bytes: Vec<u8> = serde_json::from_value(v["data"].clone())?;
            if bytes.len() as u64 > MAX_BYTES {
                return Err(std::io::Error::other("write limit exceeded"));
            }
            let mut opt = cap_std::fs::OpenOptions::new();
            opt.write(true)
                .create(true)
                .append(op == "append")
                .truncate(op == "write");
            let mut f = s.dir.open_with(&path, &opt)?;
            f.write_all(&bytes)?;
            if v["flush"] == true {
                f.sync_all()?;
            }
            Value::Null
        }
        "mkdir" => {
            if v["recursive"] == true {
                s.dir.create_dir_all(path)?;
            } else {
                s.dir.create_dir(path)?;
            }
            Value::Null
        }
        "stat" | "lstat" => {
            let m = if op == "lstat" {
                s.dir.symlink_metadata(path)?
            } else {
                s.dir.metadata(path)?
            };
            json!({"size":m.len(), "directory":m.is_dir(), "file":m.is_file(), "symlink":m.is_symlink(), "mtimeMs":m.modified().ok().and_then(|t|t.into_std().duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis()).unwrap_or(0)})
        }
        "readdir" => {
            let mut entries = vec![];
            for e in s.dir.read_dir(path)? {
                let e = e?;
                let t = e.file_type()?;
                if entries.len() >= 10000 {
                    return Err(std::io::Error::other("directory entry limit"));
                }
                entries.push(json!({"name":e.file_name().to_string_lossy(),"directory":t.is_dir(),"file":t.is_file(),"symlink":t.is_symlink()}));
            }
            entries.sort_by_key(|e| e["name"].as_str().unwrap_or("").to_owned());
            json!(entries)
        }
        "rm" => {
            let metadata = s.dir.symlink_metadata(&path);
            match metadata {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound && v["force"] == true => (),
                Err(e) => return Err(e),
                Ok(m) => {
                    if m.is_dir() {
                        if v["recursive"] == true {
                            s.dir.remove_dir_all(path)?;
                        } else {
                            s.dir.remove_dir(path)?;
                        }
                    } else {
                        s.dir.remove_file(path)?;
                    }
                }
            }
            Value::Null
        }
        "rename" | "copy" => {
            let dest = s.path(text(v, "dest").map_err(std::io::Error::other)?)?;
            if op == "rename" {
                s.dir.rename(path, &s.dir, dest)?;
            } else {
                s.dir.copy(path, &s.dir, dest)?;
            }
            Value::Null
        }
        "realpath" => {
            let p = s.dir.canonicalize(path)?;
            json!(format!("/{}", p.display()))
        }
        _ => {
            return Err(std::io::Error::new(
                std::io::ErrorKind::Unsupported,
                format!("unsupported fs operation {op}"),
            ));
        }
    })
}

pub struct Handles {
    next: u64,
    files: std::collections::HashMap<u64, cap_std::fs::File>,
    root: std::path::PathBuf,
    watches: std::collections::HashMap<
        u64,
        (
            notify::RecommendedWatcher,
            std::sync::mpsc::Receiver<notify::Result<notify::Event>>,
            std::sync::Arc<std::sync::atomic::AtomicBool>,
        ),
    >,
}
impl Handles {
    pub fn close_all(&mut self) {
        self.files.clear();
        self.watches.clear();
    }
    pub fn new(root: std::path::PathBuf) -> Self {
        Self {
            next: 0,
            files: std::collections::HashMap::new(),
            root,
            watches: std::collections::HashMap::new(),
        }
    }
    pub fn call(&mut self, s: &Sandbox, op: &str, v: &Value) -> Result<Value, String> {
        if op == "watch" {
            if self.watches.len() >= 32 {
                return Err("EMFILE: watch limit".into());
            }
            let path = s
                .path(v["path"].as_str().ok_or("missing watch path")?)
                .map_err(|e| e.to_string())?;
            let path = s.dir.canonicalize(path).map_err(|e| e.to_string())?;
            let (tx, rx) = std::sync::mpsc::sync_channel(1024);
            let overflow = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
            let lost = overflow.clone();
            let mut watcher = notify::RecommendedWatcher::new(
                move |event: notify::Result<notify::Event>| {
                    if event
                        .as_ref()
                        .is_ok_and(|e| matches!(e.kind, notify::EventKind::Access(_)))
                    {
                        return;
                    }
                    if tx.try_send(event).is_err() {
                        lost.store(true, std::sync::atomic::Ordering::Relaxed);
                    }
                },
                notify::Config::default().with_follow_symlinks(false),
            )
            .map_err(|e| e.to_string())?;
            watcher
                .watch(
                    &self.root.join(path),
                    if v["recursive"] == true {
                        notify::RecursiveMode::Recursive
                    } else {
                        notify::RecursiveMode::NonRecursive
                    },
                )
                .map_err(|e| e.to_string())?;
            self.next += 1;
            self.watches.insert(self.next, (watcher, rx, overflow));
            return Ok(json!(self.next));
        }
        if op == "watch.close" {
            if let Some(id) = v["id"].as_u64() {
                self.watches.remove(&id);
            }
            return Ok(Value::Null);
        }
        if op == "watch.poll" {
            let id = v["id"].as_u64().ok_or("missing watcher")?;
            let (_, rx, overflow) = self.watches.get(&id).ok_or("closed watcher")?;
            if overflow.swap(false, std::sync::atomic::Ordering::Relaxed) {
                return Ok(json!([{"error":"ENOBUFS: watcher overflow; rescan required"}]));
            }
            let mut events = vec![];
            for _ in 0..1024 {
                match rx.try_recv() {
                    Ok(Ok(event)) => {
                        if event.need_rescan() || matches!(event.kind, notify::EventKind::Other) {
                            events
                                .push(json!({"error":"watch coverage uncertain; rescan required"}));
                            continue;
                        }
                        for path in event.paths {
                            if let Ok(rel) = path.strip_prefix(&self.root) {
                                events.push(json!({"event":if matches!(event.kind,notify::EventKind::Modify(notify::event::ModifyKind::Data(_))){"change"}else{"rename"},"path":format!("/{}",rel.display())}));
                            }
                        }
                    }
                    Ok(Err(error)) => events.push(json!({"error":error.to_string()})),
                    Err(_) => break,
                }
            }
            return Ok(json!(events));
        }
        let result = (|| -> std::io::Result<Option<Value>> {
            if op == "open" {
                if self.files.len() >= 256 { return Err(std::io::Error::other("EMFILE: too many open files")); }
                let path = s.path(v["path"].as_str().ok_or_else(||std::io::Error::other("missing path"))?)?;
                let flags=v["flags"].as_str().unwrap_or("r"); let mut options=cap_std::fs::OpenOptions::new();
                match flags {"r"=>{options.read(true);},"w"=>{options.write(true).create(true).truncate(true);},"wx"=>{options.write(true).create_new(true);},"a"=>{options.write(true).create(true).append(true);},_=>return Err(std::io::Error::other("unsupported open flag"))};
                let f=s.dir.open_with(path,&options)?;
                if !f.metadata()?.is_file() { return Err(std::io::Error::other("not a regular file")); }
                self.next += 1; self.files.insert(self.next, f); return Ok(Some(json!(self.next)));
            }
            if ["readfd", "writefd", "close", "fstat"].contains(&op) {
                let id = v["fd"].as_u64().ok_or_else(||std::io::Error::other("EBADF"))?;
                if op == "close" { self.files.remove(&id).ok_or_else(||std::io::Error::other("EBADF"))?; return Ok(Some(Value::Null)); }
                let file = self.files.get_mut(&id).ok_or_else(||std::io::Error::other("EBADF"))?;
                if op == "writefd" {let bytes:Vec<u8>=serde_json::from_value(v["data"].clone())?;if bytes.len() as u64>MAX_BYTES{return Err(std::io::Error::other("write limit"));}file.write_all(&bytes)?;return Ok(Some(json!(bytes.len())));}
                if op == "fstat" {let m=file.metadata()?; return Ok(Some(json!({"size":m.len(),"file":m.is_file(),"directory":m.is_dir(),"symlink":false,"mtimeMs":m.modified().ok().and_then(|t|t.into_std().duration_since(std::time::UNIX_EPOCH).ok()).map(|d|d.as_millis()).unwrap_or(0)})));}
                let previous=if v["offset"].is_number(){Some(file.stream_position()?)}else{None};
                if let Some(offset) = v["offset"].as_u64() { file.seek(SeekFrom::Start(offset))?; }
                let length=v["length"].as_u64().unwrap_or(65536).min(MAX_BYTES) as usize;
                let mut bytes=vec![0;length]; let n=file.read(&mut bytes)?; if let Some(previous)=previous{file.seek(SeekFrom::Start(previous))?;} bytes.truncate(n); return Ok(Some(json!(bytes)));
            }
            Ok(None)
        })().map_err(|e|format!("{}: {e}",match e.kind(){std::io::ErrorKind::AlreadyExists=>"EEXIST",std::io::ErrorKind::PermissionDenied=>"EACCES",std::io::ErrorKind::NotFound=>"ENOENT",_=>"EIO"}))?;
        if let Some(result) = result {
            Ok(result)
        } else {
            call(s, op, v)
        }
    }
}
