//! Native implementation of Pi's portable CodemodeRemote protocol. Each actor
//! owns a fresh QuickJS runtime on its own thread; no Node compat, OS I/O,
//! module loader, network or ambient app globals are installed in that runtime.
use rquickjs::{
    Context, Ctx, Function, Object, Persistent, Runtime, Value as JsValue, function::This,
};
use serde_json::{Value, json};
use std::{
    cell::RefCell,
    collections::{BTreeMap, HashMap},
    rc::Rc,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
    },
    time::Instant,
};
use tokio::sync::{mpsc, oneshot};
const MAX_VMS: usize = 4;
const MAX_MESSAGES: usize = 4096;
const MAX_MESSAGE_BYTES: usize = 16 * 1024 * 1024;
const MAX_FRAME_BYTES: usize = 4 * 1024 * 1024;
const MAX_PENDING_BYTES: usize = 8 * 1024 * 1024;
const MAX_EARLY_BYTES: usize = 8 * 1024 * 1024;
struct Lease {
    counter: Arc<AtomicUsize>,
    bytes: usize,
}
impl Drop for Lease {
    fn drop(&mut self) {
        self.counter.fetch_sub(self.bytes, Ordering::AcqRel);
    }
}
struct Command {
    request: Value,
    reply: oneshot::Sender<Value>,
    _lease: Option<Lease>,
}
struct Job {
    sender: mpsc::Sender<Command>,
    cancelled: Arc<AtomicBool>,
    closing: AtomicBool,
    pending: Arc<AtomicUsize>,
}
impl Drop for Job {
    fn drop(&mut self) {
        self.cancelled.store(true, Ordering::Relaxed);
    }
}
type Jobs = Arc<Mutex<HashMap<String, Job>>>;
fn stop_job(jobs: &Jobs, id: &str) {
    if let Ok(jobs) = jobs.lock() {
        if let Some(job) = jobs.get(id) {
            job.cancelled.store(true, Ordering::Relaxed);
            if !job.closing.swap(true, Ordering::AcqRel) {
                let (reply, _) = oneshot::channel();
                let _ = job.sender.try_send(Command {
                    request: json!({"action":"stop"}),
                    reply,
                    _lease: None,
                });
            }
        }
    }
}
struct ActorSlot {
    jobs: Jobs,
    id: String,
}
impl ActorSlot {
    fn release(&self) {
        if let Ok(mut jobs) = self.jobs.lock() {
            jobs.remove(&self.id);
        }
    }
}
impl Drop for ActorSlot {
    fn drop(&mut self) {
        self.release();
    }
}
/// Owns an already-enqueued operation, not raw input waiting to be scheduled.
/// Dropping an unfinished data operation cancels and stops its actor.
pub struct Admission {
    receive: Option<oneshot::Receiver<Value>>,
    jobs: Jobs,
    id: String,
    stop: bool,
    finished: bool,
    _permit: Option<tokio::sync::OwnedSemaphorePermit>,
}
impl Drop for Admission {
    fn drop(&mut self) {
        if !self.finished && !self.stop {
            stop_job(&self.jobs, &self.id);
        }
    }
}
pub struct Manager {
    jobs: Jobs,
    ingress: Arc<tokio::sync::Semaphore>,
}
impl Default for Manager {
    fn default() -> Self {
        Self {
            jobs: Arc::default(),
            ingress: Arc::new(tokio::sync::Semaphore::new(4)),
        }
    }
}
impl Manager {
    pub fn create(&self) -> Result<Value, String> {
        let mut jobs = self.jobs.lock().map_err(|e| e.to_string())?;
        if jobs.len() >= MAX_VMS {
            return Err("ENOBUFS: codemode VM capacity".into());
        }
        let (sender, mut receiver) = mpsc::channel::<Command>(64);
        let cancelled = Arc::new(AtomicBool::new(false));
        let token = cancelled.clone();
        let id = uuid::Uuid::new_v4().to_string();
        let actor_jobs = self.jobs.clone();
        let actor_id = id.clone();
        std::thread::Builder::new().name("nsh-codemode".into()).stack_size(4*1024*1024).spawn(move||{
            let slot=ActorSlot{jobs:actor_jobs,id:actor_id};
            let mut vm:Option<NativeVm>=None;
            while let Some(command)=receiver.blocking_recv() {
                let operation=command.request["action"].as_str().unwrap_or("");
                if operation=="stop" {drop(vm.take());slot.release();let _=command.reply.send(json!([]));break;}
                let result=match operation {
                    "start" if vm.is_none()=>NativeVm::new(&command.request,token.clone()).and_then(|mut created|{let output=created.start(&command.request);vm=Some(created);output}),
                    "deliver"=>vm.as_mut().ok_or("codemode not started".into()).and_then(|vm|vm.deliver(&command.request["message"])),
                    _=>Err("invalid codemode action/state".into()),
                };
                let output=result.unwrap_or_else(|message|json!([{"type":"failure","error":{"kind":if token.load(Ordering::Relaxed){"aborted"}else if message.starts_with("TIMEOUT:"){"timeout"}else{"sandbox"},"message":message}}]));
                let _=command.reply.send(output);
            }
        }).map_err(|e|e.to_string())?;
        jobs.insert(
            id.clone(),
            Job {
                sender,
                cancelled,
                closing: AtomicBool::new(false),
                pending: Arc::new(AtomicUsize::new(0)),
            },
        );
        Ok(json!(id))
    }
    pub fn cancel(&self, id: &str) -> Result<Value, String> {
        if let Some(job) = self.jobs.lock().map_err(|e| e.to_string())?.get(id) {
            job.cancelled.store(true, Ordering::Relaxed);
        }
        Ok(Value::Null)
    }
    /// Parsing, byte admission and enqueue all finish before a future exists.
    /// Tiny stop frames have reserved control admission and are enqueued now,
    /// so an executor dropping their wait future cannot strand a closing VM.
    pub fn admit(&self, raw: String) -> Result<Admission, String> {
        let bytes = raw.len();
        if bytes > MAX_FRAME_BYTES {
            return Err("ENOBUFS: codemode input frame limit".into());
        }
        let control = if bytes <= 256 {
            serde_json::from_str::<Value>(&raw)
                .ok()
                .filter(|v| v["action"] == "stop")
        } else {
            None
        };
        let _permit = if control.is_none() {
            Some(
                self.ingress
                    .clone()
                    .try_acquire_owned()
                    .map_err(|_| "ENOBUFS: codemode input admission")?,
            )
        } else {
            None
        };
        let reserved_stop = control.is_some();
        let request = match control {
            Some(value) => value,
            None => serde_json::from_str(&raw).map_err(|e| e.to_string())?,
        };
        drop(raw);
        let id = request["id"]
            .as_str()
            .ok_or("missing codemode id")?
            .to_owned();
        let stop = request["action"] == "stop";
        if stop && !reserved_stop {
            return Err("invalid codemode stop control frame".into());
        }
        let (reply, receive) = oneshot::channel();
        {
            let jobs = self.jobs.lock().map_err(|e| e.to_string())?;
            let job = jobs.get(&id).ok_or("unknown codemode VM")?;
            if job.closing.load(Ordering::Acquire) {
                return Err("codemode is stopping".into());
            }
            let lease = if stop {
                job.closing.store(true, Ordering::Release);
                job.cancelled.store(true, Ordering::Relaxed);
                None
            } else {
                job.pending
                    .fetch_update(Ordering::AcqRel, Ordering::Acquire, |used| {
                        used.checked_add(bytes).filter(|n| *n <= MAX_PENDING_BYTES)
                    })
                    .map_err(|_| "ENOBUFS: codemode pending input limit")?;
                Some(Lease {
                    counter: job.pending.clone(),
                    bytes,
                })
            };
            // Four data permits and a single stop fit into each 64-slot queue.
            job.sender
                .try_send(Command {
                    request,
                    reply,
                    _lease: lease,
                })
                .map_err(|_| "ENOBUFS: codemode input queue")?;
        }
        Ok(Admission {
            receive: Some(receive),
            jobs: self.jobs.clone(),
            id,
            stop,
            finished: false,
            _permit,
        })
    }
    pub async fn step(&self, mut input: Admission) -> Result<Value, String> {
        let result = input.receive.take().unwrap().await;
        input.finished = true;
        if result.is_err() {
            stop_job(&self.jobs, &input.id);
        }
        result.map_err(|_| "codemode actor failed".into())
    }
    pub fn shutdown(&self) {
        let ids = self
            .jobs
            .lock()
            .map(|jobs| jobs.keys().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        for id in ids {
            stop_job(&self.jobs, &id);
        }
    }
}
impl Drop for Manager {
    fn drop(&mut self) {
        self.shutdown();
    }
}
struct Guard {
    started: Instant,
    deadline_us: Arc<AtomicU64>,
    polls: Arc<AtomicUsize>,
    limit: usize,
    cancelled: Arc<AtomicBool>,
}
impl Guard {
    fn arm(&self) {
        self.polls.store(0, Ordering::Relaxed);
        self.deadline_us.store(
            self.started.elapsed().as_micros() as u64 + 250_000,
            Ordering::Relaxed,
        );
    }
    fn exceeded(&self) -> bool {
        self.cancelled.load(Ordering::Relaxed)
            || self.polls.load(Ordering::Relaxed) > self.limit
            || self.started.elapsed().as_micros() as u64 > self.deadline_us.load(Ordering::Relaxed)
    }
}
struct Messages {
    values: Vec<Value>,
    bytes: usize,
    issued: usize,
    current: u64,
    deterministic: bool,
}
impl Messages {
    fn push(&mut self, value: Value) -> Result<(), String> {
        self.bytes += value.to_string().len();
        if self.values.len() >= MAX_MESSAGES || self.bytes > MAX_MESSAGE_BYTES {
            return Err("ENOBUFS: codemode bridge output limit".into());
        }
        self.values.push(value);
        Ok(())
    }
    fn bridge(&mut self, raw: &str) -> Result<(), String> {
        let args: Vec<Value> = serde_json::from_str(raw).map_err(|e| e.to_string())?;
        let arg = |i: usize| args.get(i).cloned().unwrap_or(Value::Null);
        let value = match args.first().and_then(Value::as_str).unwrap_or("") {
            "call" | "global" => {
                self.issued += 1;
                json!({"type":"call","id":arg(1),"target":if args[0]=="call"{"tool"}else{"global"},"name":arg(2),"args":arg(3)})
            }
            "output" => {
                json!({"type":"output","item":if args[1]=="image"{json!({"type":"image","data":arg(2),"mimeType":arg(3)})}else if args[1]=="console"{json!({"type":"text","text":arg(2),"console":true})}else{json!({"type":"text","text":arg(2)})}})
            }
            "done" => {
                let mut out = if args[1] == true {
                    json!({"type":"done","ok":true,"value":arg(2),"writes":arg(3)})
                } else {
                    json!({"type":"done","ok":false,"error":arg(2)})
                };
                if self.deterministic {
                    out["during"] = json!({"seq":self.current,"issued":self.issued});
                }
                out
            }
            _ => return Err("invalid codemode prelude bridge operation".into()),
        };
        self.push(value)
    }
}
// Persistent handles must be dropped before Context and Runtime (field order).
struct NativeVm {
    api: Option<Persistent<Object<'static>>>,
    context: Context,
    runtime: Runtime,
    guard: Guard,
    messages: Rc<RefCell<Messages>>,
    deterministic: bool,
    next_seq: u64,
    early: BTreeMap<u64, (Value, usize)>,
    early_bytes: usize,
    now: f64,
    clock: Arc<AtomicU64>,
    memory_limit: usize,
}
fn exception(ctx: &Ctx<'_>, error: rquickjs::Error) -> String {
    let value = ctx.catch();
    if let Some(obj) = value.as_object() {
        let message = obj
            .get::<_, String>("message")
            .unwrap_or_else(|_| error.to_string());
        let name = obj
            .get::<_, String>("name")
            .unwrap_or_else(|_| "Error".into());
        let stack = obj.get::<_, String>("stack").unwrap_or_default();
        json!({"name":name,"message":message,"stack":stack}).to_string()
    } else {
        json!({"name":"Error","message":error.to_string()}).to_string()
    }
}
fn js_string<'js>(ctx: &Ctx<'js>, value: Option<&str>) -> rquickjs::Result<JsValue<'js>> {
    match value {
        Some(value) => Ok(rquickjs::String::from_str(ctx.clone(), value)?.into_value()),
        None => Ok(JsValue::new_undefined(ctx.clone())),
    }
}
impl NativeVm {
    fn js_error(&self, ctx: &Ctx<'_>, error: rquickjs::Error) -> String {
        if self.guard.cancelled.load(Ordering::Relaxed) {
            ctx.catch();
            return "ABORT_ERR: codemode cancelled".into();
        }
        if self.guard.exceeded() {
            ctx.catch();
            return "TIMEOUT: codemode execution budget".into();
        }
        exception(ctx, error)
    }

    fn new(request: &Value, cancelled: Arc<AtomicBool>) -> Result<Self, String> {
        let runtime = Runtime::new().map_err(|e| e.to_string())?;
        let limit = request["data"]["memoryLimitBytes"]
            .as_u64()
            .unwrap_or(32 * 1024 * 1024)
            .clamp(1024 * 1024, 64 * 1024 * 1024);
        if request["data"]["memoryLimitBytes"]
            .as_u64()
            .is_some_and(|n| n < 1024 * 1024)
        {
            return Err("codemode memory limit must be at least 1 MiB".into());
        }
        runtime.set_memory_limit(limit as usize);
        runtime.set_max_stack_size(256 * 1024);
        let polls = Arc::new(AtomicUsize::new(0));
        let deadline_us = Arc::new(AtomicU64::new(250_000));
        let started = Instant::now();
        let budget = request["interruptBudget"]
            .as_u64()
            .unwrap_or(10000)
            .clamp(1, 10000) as usize;
        let guard = Guard {
            started,
            deadline_us: deadline_us.clone(),
            polls: polls.clone(),
            limit: budget,
            cancelled: cancelled.clone(),
        };
        runtime.set_interrupt_handler(Some(Box::new(move || {
            cancelled.load(Ordering::Relaxed)
                || polls.fetch_add(1, Ordering::Relaxed) >= budget
                || started.elapsed().as_micros() as u64 > deadline_us.load(Ordering::Relaxed)
        })));
        let context = Context::full(&runtime).map_err(|e| e.to_string())?;
        let deterministic = request["data"]["deterministic"].is_object();
        let now = request["data"]["deterministic"]["startedAt"]
            .as_f64()
            .unwrap_or(0.0);
        let messages = Rc::new(RefCell::new(Messages {
            values: vec![],
            bytes: 0,
            issued: 0,
            current: 0,
            deterministic,
        }));
        Ok(Self {
            api: None,
            context,
            runtime,
            guard,
            messages,
            deterministic,
            next_seq: 1,
            early: BTreeMap::new(),
            early_bytes: 0,
            now,
            clock: Arc::new(AtomicU64::new(now.to_bits())),
            memory_limit: limit as usize,
        })
    }
    fn start(&mut self, request: &Value) -> Result<Value, String> {
        self.guard.arm();
        let prelude = request["prelude"]
            .as_str()
            .ok_or("missing upstream prelude")?;
        if prelude.len() > 256 * 1024 {
            return Err("prelude size limit".into());
        }
        let code = request["data"]["code"].as_str().ok_or("missing code")?;
        if code.len() > 1024 * 1024 {
            return Err("code size limit".into());
        }
        let sink = self.messages.clone();
        let setup = self.context.with(|ctx| -> Result<_, String> {
            if self.deterministic {
                let config = &request["data"]["deterministic"];
                let install: Function = ctx
                    .eval(include_str!("codemode_determinism.js"))
                    .map_err(|e| self.js_error(&ctx, e))?;
                {
                    let clock = self.clock.clone();
                    let now = Function::new(ctx.clone(), move || {
                        f64::from_bits(clock.load(Ordering::Relaxed))
                    })
                    .map_err(|e| e.to_string())?;
                    install.call::<_, ()>((now, config["seed"].as_u64().unwrap_or(0) as u32))
                }
                .map_err(|e| self.js_error(&ctx, e))?;
            }
            let bridge = Function::new(
                ctx.clone(),
                move |ctx: Ctx<'_>, raw: String| -> rquickjs::Result<()> {
                    sink.borrow_mut()
                        .bridge(&raw)
                        .map_err(|e| rquickjs::Exception::throw_message(&ctx, &e))
                },
            )
            .map_err(|e| e.to_string())?;
            let wrap: Function = ctx
                .eval("(bridge) => (kind,a,b,c) => bridge(JSON.stringify([kind,a,b,c]))")
                .map_err(|e| self.js_error(&ctx, e))?;
            let bridge: Function = wrap.call((bridge,)).map_err(|e| self.js_error(&ctx, e))?;
            let factory: Function = ctx.eval(prelude).map_err(|e| self.js_error(&ctx, e))?;
            let api: Object = factory
                .call((
                    bridge,
                    request["data"]["tools"].to_string(),
                    request["data"]["globals"].to_string(),
                    request["data"]["store"].to_string(),
                ))
                .map_err(|e| self.js_error(&ctx, e))?;
            Ok(Persistent::save(&ctx, api))
        })?;
        self.api = Some(setup);
        if self.deterministic {
            let mut hash = 0x811c9dc5u32;
            for ch in prelude.encode_utf16() {
                hash = (hash ^ ch as u32).wrapping_mul(0x01000193);
            }
            self.messages.borrow_mut().push(json!({"type":"started","fingerprint":format!("nsh-quickjs-jit 0.14.1, {} {}, prelude {hash:08x}, determinism {:08x}, native protocol 1, heap {}, budget {}, stack 262144",std::env::consts::OS,std::env::consts::ARCH,include_str!("codemode_determinism.js").encode_utf16().fold(0x811c9dc5u32,|h,ch|(h^ch as u32).wrapping_mul(0x01000193)),self.memory_limit,self.guard.limit)}))?;
        }
        let run_result = self.context.with(|ctx| -> Result<(), String> {
            let api = self
                .api
                .as_ref()
                .unwrap()
                .clone()
                .restore(&ctx)
                .map_err(|e| e.to_string())?;
            let script =
                ctx.eval::<Function, _>(format!("(async (tools, console) => {{{code}\n}})"));
            match script {
                Ok(script) => {
                    let run: Function = api.get("run").map_err(|e| e.to_string())?;
                    run.call::<_, ()>((This(api), script))
                        .map_err(|e| self.js_error(&ctx, e))
                }
                Err(e) => {
                    self.messages
                        .borrow_mut()
                        .push(json!({"type":"done","ok":false,"error":self.js_error(&ctx,e)}))?;
                    Ok(())
                }
            }
        });
        if let Err(error) = run_result {
            return Err(if self.guard.exceeded() {
                "TIMEOUT: codemode execution budget".into()
            } else {
                error
            });
        }
        self.drain()?;
        self.idle(0)?;
        Ok(self.take())
    }
    fn drain(&mut self) -> Result<(), String> {
        let mut jobs = 0;
        while self.runtime.is_job_pending() {
            self.runtime.execute_pending_job().map_err(|e| {
                e.0.with(|ctx| self.js_error(&ctx, rquickjs::Error::Exception))
            })?;
            jobs += 1;
            if jobs % 50 == 0 && self.guard.exceeded() {
                return Err("TIMEOUT: codemode execution budget".into());
            }
        }
        if self.guard.exceeded() {
            return Err(if self.guard.cancelled.load(Ordering::Relaxed) {
                "ABORT_ERR: codemode cancelled"
            } else {
                "TIMEOUT: codemode execution budget"
            }
            .into());
        }
        self.context.with(|ctx| {
            let api = self
                .api
                .as_ref()
                .unwrap()
                .clone()
                .restore(&ctx)
                .map_err(|e| e.to_string())?;
            let stalled: Function = api.get("stalled").map_err(|e| e.to_string())?;
            stalled
                .call::<_, ()>((This(api),))
                .map_err(|e| self.js_error(&ctx, e))
        })
    }
    fn idle(&self, seq: u64) -> Result<(), String> {
        if self.deterministic {
            let mut sink = self.messages.borrow_mut();
            if !sink
                .values
                .iter()
                .any(|m| m["type"] == "done" || m["type"] == "crash")
            {
                let issued = sink.issued;
                sink.push(json!({"type":"idle","seq":seq,"issued":issued}))?;
            }
        }
        Ok(())
    }
    fn apply(&mut self, message: &Value) -> Result<(), String> {
        self.guard.arm();
        if self.deterministic {
            if let Some(now) = message["now"].as_f64() {
                self.now = self.now.max(now);
            }
            self.messages.borrow_mut().current = message["seq"].as_u64().unwrap_or(0);
        }
        self.clock.store(self.now.to_bits(), Ordering::Relaxed);
        self.context.with(|ctx| {
            let api = self
                .api
                .as_ref()
                .unwrap()
                .clone()
                .restore(&ctx)
                .map_err(|e| e.to_string())?;
            let settle: Function = api.get("settle").map_err(|e| e.to_string())?;
            settle
                .call::<_, ()>((
                    This(api),
                    message["id"].as_i64().unwrap_or(0),
                    message["ok"] == true,
                    js_string(&ctx, message["payload"].as_str()).map_err(|e| e.to_string())?,
                    js_string(&ctx, message["properties"].as_str()).map_err(|e| e.to_string())?,
                ))
                .map_err(|e| self.js_error(&ctx, e))
        })?;
        self.drain()
    }
    fn deliver(&mut self, message: &Value) -> Result<Value, String> {
        if !self.deterministic {
            self.apply(message)?;
            return Ok(self.take());
        }
        let seq = message["seq"]
            .as_u64()
            .ok_or("deterministic result needs seq")?;
        if seq < self.next_seq || self.early.contains_key(&seq) || self.early.len() >= 1000 {
            return Err("invalid deterministic sequence".into());
        }
        let bytes = message.to_string().len();
        if self.early_bytes.saturating_add(bytes) > MAX_EARLY_BYTES {
            return Err("ENOBUFS: codemode early result limit".into());
        }
        self.early_bytes += bytes;
        self.early.insert(seq, (message.clone(), bytes));
        while let Some((next, bytes)) = self.early.remove(&self.next_seq) {
            self.early_bytes -= bytes;
            self.apply(&next)?;
            self.idle(self.next_seq)?;
            self.next_seq += 1;
        }
        Ok(self.take())
    }
    fn take(&self) -> Value {
        let mut sink = self.messages.borrow_mut();
        sink.bytes = 0;
        json!(std::mem::take(&mut sink.values))
    }
}
