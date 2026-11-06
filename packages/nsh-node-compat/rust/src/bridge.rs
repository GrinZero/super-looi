use crate::{codemode_bridge, fs_bridge, sandbox, segment_bridge, shell_bridge, sqlite_bridge};
use serde_json::{Value, json};
use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

pub type Task = Pin<Box<dyn Future<Output = String>>>;
struct ShellJob {
    cancelled: Arc<AtomicBool>,
    started: bool,
}
struct ShellLease {
    jobs: Arc<Mutex<HashMap<String, ShellJob>>>,
    id: String,
}
impl Drop for ShellLease {
    fn drop(&mut self) {
        if let Ok(mut jobs) = self.jobs.lock() {
            if let Some(job) = jobs.remove(&self.id) {
                job.cancelled.store(true, Ordering::Relaxed);
            }
        }
    }
}
struct ShellConsumer {
    _lease: Arc<ShellLease>,
    cancelled: Arc<AtomicBool>,
}
impl Drop for ShellConsumer {
    fn drop(&mut self) {
        self.cancelled.store(true, Ordering::Relaxed);
    }
}
pub(crate) fn response(result: Result<Value, String>) -> String {
    match result {
        Ok(value) => json!({"value":value}),
        Err(error) => json!({"error":error}),
    }
    .to_string()
}

/// Runtime-independent native host shared by the Ctx installer and NSH classes.
pub struct Bridge {
    fs: Arc<sandbox::Sandbox>,
    db_root: PathBuf,
    db_sandbox: sandbox::Sandbox,
    files: RefCell<fs_bridge::Handles>,
    databases: RefCell<sqlite_bridge::Databases>,
    jobs: Arc<Mutex<HashMap<String, ShellJob>>>,
    codemode: Arc<codemode_bridge::Manager>,
    tasks: RefCell<HashMap<String, Task>>,
    closed: Cell<bool>,
    #[cfg(test)]
    shell_gate: RefCell<Option<Arc<std::sync::Barrier>>>,
}
impl Bridge {
    /// The trusted native app chooses a root inside its own sandbox.
    pub fn new(data_root: &Path) -> Result<Self, String> {
        let fs =
            Arc::new(sandbox::Sandbox::new(&data_root.join("files")).map_err(|e| e.to_string())?);
        let db_root = data_root.join("sqlite");
        let db_sandbox = sandbox::Sandbox::new(&db_root).map_err(|e| e.to_string())?;
        let files = fs_bridge::Handles::new(
            std::fs::canonicalize(data_root.join("files")).map_err(|e| e.to_string())?,
        );
        Ok(Self {
            fs,
            db_root,
            db_sandbox,
            files: RefCell::new(files),
            databases: RefCell::new(sqlite_bridge::Databases::new()),
            jobs: Arc::new(Mutex::new(HashMap::new())),
            codemode: Arc::default(),
            tasks: RefCell::new(HashMap::new()),
            closed: Cell::new(false),
            #[cfg(test)]
            shell_gate: RefCell::new(None),
        })
    }
    /// Synchronous JSON request/response protocol used by node:* shims.
    pub fn request(&self, request: &str) -> String {
        response(self.call(request))
    }
    fn call(&self, request: &str) -> Result<Value, String> {
        if self.closed.get() {
            return Err("ERR_CLOSED: native compatibility host".into());
        }
        let mut v: Value = serde_json::from_str(request).map_err(|e| e.to_string())?;
        let op = v["op"].as_str().ok_or("missing operation")?.to_owned();
        if let Some(op) = op.strip_prefix("fs.") {
            return self.files.borrow_mut().call(&self.fs, op, &v);
        }
        if let Some(op) = op.strip_prefix("sqlite.") {
            v["root"] = json!(self.db_root);
            return self.databases.borrow_mut().call(&self.db_sandbox, op, &v);
        }
        match op.as_str() {
            "segment" => segment_bridge::segment(&v),
            "codemode.create" => self.codemode.create(),
            "codemode.cancel" => self
                .codemode
                .cancel(v["id"].as_str().ok_or("missing codemode id")?),
            "shell.create" => {
                let mut jobs = self.jobs.lock().map_err(|e| e.to_string())?;
                if jobs.len() >= 16 {
                    return Err("ENOBUFS: too many shell jobs".into());
                }
                let id = uuid::Uuid::new_v4().to_string();
                jobs.insert(
                    id.clone(),
                    ShellJob {
                        cancelled: Arc::new(AtomicBool::new(false)),
                        started: false,
                    },
                );
                Ok(json!(id))
            }
            "shell.cancel" => {
                if let Some(job) = self
                    .jobs
                    .lock()
                    .map_err(|e| e.to_string())?
                    .get(v["id"].as_str().ok_or("missing shell id")?)
                {
                    job.cancelled.store(true, Ordering::Relaxed);
                }
                Ok(Value::Null)
            }
            "shell" => shell_bridge::execute(&self.fs, &v),
            "crc32" => {
                let data: Vec<u8> =
                    serde_json::from_value(v["data"].clone()).map_err(|e| e.to_string())?;
                let mut hash =
                    crc32fast::Hasher::new_with_initial(v["seed"].as_u64().unwrap_or(0) as u32);
                hash.update(&data);
                Ok(json!(hash.finalize()))
            }
            "uuid" => Ok(json!(uuid::Uuid::new_v4().to_string())),
            _ => Err(format!("ERR_NOT_SUPPORTED: {op}")),
        }
    }
    /// Admit before an NSH async call retains its input. Tickets are single-use.
    pub fn begin(&self, kind: &str, request: String) -> Result<String, String> {
        if self.closed.get() {
            return Err("ERR_CLOSED: native compatibility host".into());
        }
        if self.tasks.borrow().len() >= 32 {
            return Err("ENOBUFS: native task tickets".into());
        }
        let task: Task = match kind {
            "codemode" => {
                let input = self.codemode.admit(request)?;
                let manager = self.codemode.clone();
                Box::pin(async move { response(manager.step(input).await) })
            }
            "shell" => {
                if request.len() > 128 * 1024 {
                    return Err("ENOBUFS: shell input frame".into());
                }
                let v: Value = serde_json::from_str(&request).map_err(|e| e.to_string())?;
                let id = v["id"].as_str().ok_or("missing shell id")?.to_owned();
                let token = {
                    let mut jobs = self.jobs.lock().map_err(|e| e.to_string())?;
                    let job = jobs.get_mut(&id).ok_or("unknown shell job")?;
                    if job.started {
                        return Err("shell job already started".into());
                    }
                    job.started = true;
                    job.cancelled.clone()
                };
                let fs = self.fs.clone();
                let lease = Arc::new(ShellLease {
                    jobs: self.jobs.clone(),
                    id: id.clone(),
                });
                let worker_lease = lease.clone();
                let consumer = ShellConsumer {
                    _lease: lease,
                    cancelled: token.clone(),
                };
                #[cfg(test)]
                let gate = self.shell_gate.borrow().clone();
                let cleanup_id = id.clone();
                let (send, receive) = tokio::sync::oneshot::channel();
                if let Err(error) = std::thread::Builder::new()
                    .name("nsh-shell".into())
                    .stack_size(2 * 1024 * 1024)
                    .spawn(move || {
                        let _lease = worker_lease;
                        #[cfg(test)]
                        if let Some(gate) = gate {
                            gate.wait();
                        }
                        let result = shell_bridge::execute_cancelable(&fs, &v, token);
                        let _ = send.send(result);
                    })
                {
                    self.jobs
                        .lock()
                        .map_err(|e| e.to_string())?
                        .remove(&cleanup_id);
                    return Err(error.to_string());
                }
                Box::pin(async move {
                    let _consumer = consumer;
                    response(
                        receive
                            .await
                            .map_err(|_| "shell actor failed".into())
                            .and_then(|result| result),
                    )
                })
            }
            _ => return Err("invalid native task kind".into()),
        };
        let ticket = uuid::Uuid::new_v4().to_string();
        self.tasks.borrow_mut().insert(ticket.clone(), task);
        Ok(ticket)
    }
    /// Detach a task for NSH's executor. Polling needs no ambient Tokio runtime.
    pub fn wait(&self, ticket: &str) -> Task {
        self.tasks.borrow_mut().remove(ticket).unwrap_or_else(|| {
            Box::pin(async { response(Err("unknown or consumed native task ticket".into())) })
        })
    }
    /// App teardown cancels actors. Normal sandbox.close() awaits VM receipts
    /// before this final disposal; teardown itself cannot wait on the engine.
    pub fn close(&self) {
        if self.closed.replace(true) {
            return;
        }
        if let Ok(mut jobs) = self.jobs.lock() {
            for job in jobs.values() {
                job.cancelled.store(true, Ordering::Relaxed);
            }
            jobs.clear();
        }
        self.codemode.shutdown();
        self.tasks.borrow_mut().clear();
        self.files.borrow_mut().close_all();
        *self.databases.borrow_mut() = sqlite_bridge::Databases::new();
    }
}
impl Drop for Bridge {
    fn drop(&mut self) {
        self.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::task::{Context, Poll, Wake, Waker};
    struct Notify(std::thread::Thread);
    impl Wake for Notify {
        fn wake(self: Arc<Self>) {
            self.0.unpark();
        }
        fn wake_by_ref(self: &Arc<Self>) {
            self.0.unpark();
        }
    }
    fn await_on_engine(mut task: Task) -> Value {
        // NSH has its own executor. No Tokio runtime is entered in this test.
        let waker = Waker::from(Arc::new(Notify(std::thread::current())));
        let mut cx = Context::from_waker(&waker);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        loop {
            if let Poll::Ready(value) = task.as_mut().poll(&mut cx) {
                return serde_json::from_str(&value).unwrap();
            }
            assert!(std::time::Instant::now() < deadline, "engine task deadline");
            std::thread::park_timeout(std::time::Duration::from_millis(5));
        }
    }
    #[test]
    fn task_tickets_work_without_tokio_and_are_consumed_once() {
        let temp = tempfile::tempdir().unwrap();
        let host = Bridge::new(temp.path()).unwrap();
        let id: Value = serde_json::from_str(&host.request(r#"{"op":"shell.create"}"#)).unwrap();
        let request = json!({"id":id["value"],"command":"echo native-engine"}).to_string();
        let ticket = host.begin("shell", request.clone()).unwrap();
        assert!(
            host.begin("shell", request)
                .unwrap_err()
                .contains("already started")
        );
        let result = await_on_engine(host.wait(&ticket));
        assert_eq!(result["value"]["stdout"], "native-engine\n");
        assert!(
            await_on_engine(host.wait(&ticket))["error"]
                .as_str()
                .unwrap()
                .contains("consumed")
        );
        host.close();
        assert!(host.request(r#"{"op":"uuid"}"#).contains("ERR_CLOSED"));
    }
    #[test]
    fn completed_unconsumed_shell_outputs_still_hold_capacity() {
        let temp = tempfile::tempdir().unwrap();
        let host = Bridge::new(temp.path()).unwrap();
        let mut tickets = vec![];
        for _ in 0..16 {
            let id: Value =
                serde_json::from_str(&host.request(r#"{"op":"shell.create"}"#)).unwrap();
            tickets.push(
                host.begin(
                    "shell",
                    json!({"id":id["value"],"command":"echo bounded"}).to_string(),
                )
                .unwrap(),
            );
        }
        assert!(host.request(r#"{"op":"shell.create"}"#).contains("ENOBUFS"));
        for ticket in tickets {
            assert_eq!(await_on_engine(host.wait(&ticket))["value"]["status"], 0);
        }
        assert!(!host.request(r#"{"op":"shell.create"}"#).contains("error"));
    }
    #[test]
    fn dropping_waits_keeps_shell_slots_until_workers_stop() {
        let temp = tempfile::tempdir().unwrap();
        let host = Bridge::new(temp.path()).unwrap();
        let gate = Arc::new(std::sync::Barrier::new(17));
        *host.shell_gate.borrow_mut() = Some(gate.clone());
        for _ in 0..16 {
            let id: Value =
                serde_json::from_str(&host.request(r#"{"op":"shell.create"}"#)).unwrap();
            let ticket = host
                .begin(
                    "shell",
                    json!({"id":id["value"],"command":"echo cancelled"}).to_string(),
                )
                .unwrap();
            drop(host.wait(&ticket));
        }
        assert!(
            host.request(r#"{"op":"shell.create"}"#).contains("ENOBUFS"),
            "abandoned consumers must not free live workers' slots"
        );
        gate.wait();
        host.shell_gate.borrow_mut().take();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while !host.jobs.lock().unwrap().is_empty() {
            assert!(std::time::Instant::now() < deadline);
            std::thread::park_timeout(std::time::Duration::from_millis(1));
        }
        assert!(!host.request(r#"{"op":"shell.create"}"#).contains("error"));
    }
    #[test]
    fn dropping_codemode_stop_waits_does_not_strand_slots() {
        let temp = tempfile::tempdir().unwrap();
        let host = Bridge::new(temp.path()).unwrap();
        for _ in 0..20 {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
            let id = loop {
                let response: Value =
                    serde_json::from_str(&host.request(r#"{"op":"codemode.create"}"#)).unwrap();
                if response.get("value").is_some() {
                    break response["value"].clone();
                }
                assert!(
                    std::time::Instant::now() < deadline,
                    "abandoned stop leaked VM capacity: {response}"
                );
                std::thread::park_timeout(std::time::Duration::from_millis(1));
            };
            let ticket = host
                .begin("codemode", json!({"id":id,"action":"stop"}).to_string())
                .unwrap();
            drop(host.wait(&ticket));
        }
    }
}
