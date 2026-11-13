//! Native camera sessions own transport and decoding; views only borrow display access.
use base64::{Engine, engine::general_purpose::STANDARD};
use nsh_core::prelude::*;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex, OnceLock, Weak,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};
mod cloud;
mod crypto;
mod media;
#[cfg(target_os = "android")]
mod media_android;
mod transport;
mod video;
#[cfg(target_os = "ios")]
pub mod view_ios;

static APP_ACTIVE: AtomicBool = AtomicBool::new(true);
static APP_EPOCH: AtomicU64 = AtomicU64::new(0);
static SESSIONS: OnceLock<Mutex<HashMap<String, Weak<Session>>>> = OnceLock::new();
fn sessions() -> &'static Mutex<HashMap<String, Weak<Session>>> {
    SESSIONS.get_or_init(Default::default)
}

#[derive(Default)]
struct Consumers {
    preview: bool,
    captures: usize,
}
struct Session {
    id: String,
    did: String,
    decoder: media::Decoder,
    runtime: tokio::runtime::Handle,
    cancelled: AtomicBool,
    error: Mutex<Option<String>>,
    consumers: Mutex<Consumers>,
    command: Mutex<Option<transport::CommandHandle>>,
    worker: Mutex<Option<tokio::task::JoinHandle<()>>>,
}
impl Drop for Session {
    fn drop(&mut self) {
        sessions().lock().unwrap().remove(&self.id);
    }
}
impl Session {
    fn close(&self) {
        self.cancelled.store(true, Ordering::Release);
        *self.command.lock().unwrap() = None;
        if let Some(worker) = self.worker.lock().unwrap().take() {
            worker.abort();
        }
        self.decoder.close();
    }
    fn create(did: String) -> Result<Arc<Self>, String> {
        let id = uuid::Uuid::new_v4().to_string();
        let decoder = media::Decoder::new(&id)?;
        let session = Arc::new(Self {
            id,
            did,
            decoder,
            runtime: tokio::runtime::Handle::current(),
            cancelled: AtomicBool::new(false),
            error: Mutex::new(None),
            consumers: Mutex::new(Consumers::default()),
            command: Mutex::new(None),
            worker: Mutex::new(None),
        });
        sessions()
            .lock()
            .unwrap()
            .insert(session.id.clone(), Arc::downgrade(&session));
        Ok(session)
    }
    fn status(&self) -> Value {
        let mut value = serde_json::to_value(self.decoder.status()).unwrap();
        value["sessionId"] = self.id.clone().into();
        value["closed"] = self.cancelled.load(Ordering::Acquire).into();
        value["failure"] = self.error.lock().unwrap().clone().into();
        value
    }
    async fn capture(
        self: Arc<Self>,
        request: Option<Arc<CaptureRequest>>,
    ) -> Result<CameraFrame, String> {
        let after = self.decoder.status().frames;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        loop {
            if self.cancelled.load(Ordering::Acquire)
                || request
                    .as_ref()
                    .is_some_and(|r| r.cancelled.load(Ordering::Acquire))
            {
                return Err("camera_request_cancelled".into());
            }
            if let Some(error) = self.error.lock().unwrap().clone() {
                return Err(error);
            }
            if self.decoder.status().frames > after {
                let session = self.clone();
                let jpeg = tokio::task::spawn_blocking(move || session.decoder.jpeg())
                    .await
                    .map_err(|_| "camera_frame_failed")??;
                if self.cancelled.load(Ordering::Acquire)
                    || request
                        .as_ref()
                        .is_some_and(|r| r.cancelled.load(Ordering::Acquire))
                {
                    return Err("camera_request_cancelled".into());
                }
                return Ok(CameraFrame {
                    data: STANDARD.encode(jpeg.data),
                    mime_type: "image/jpeg".into(),
                    width: jpeg.width,
                    height: jpeg.height,
                    received_at: jpeg.received_at.to_string(),
                });
            }
            if tokio::time::Instant::now() >= deadline {
                return Err("camera_frame_timeout".into());
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
}
struct Host {
    owned: Mutex<HashMap<String, Arc<Session>>>,
    cloud: tokio::sync::Mutex<Option<cloud::Cloud>>,
    vault: crate::credentials::CredentialVault,
    requests: Mutex<HashMap<String, Arc<CaptureRequest>>>,
    epoch: AtomicU64,
    account_generation: AtomicU64,
    ready: AtomicBool,
    ptz_busy: AtomicBool,
}
struct PtzBusyGuard<'a>(&'a AtomicBool);
impl Drop for PtzBusyGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}
impl Host {
    fn close_all(&self) {
        self.epoch.fetch_add(1, Ordering::AcqRel);
        for request in std::mem::take(&mut *self.requests.lock().unwrap()).values() {
            request.cancelled.store(true, Ordering::Release);
        }
        let owned = std::mem::take(&mut *self.owned.lock().unwrap());
        for session in owned.values() {
            session.close();
        }
    }
    fn release(&self, session: &Arc<Session>, preview: bool) {
        let mut owned = self.owned.lock().unwrap();
        let mut consumers = session.consumers.lock().unwrap();
        if preview {
            consumers.preview = false;
        } else {
            consumers.captures -= 1;
        }
        if !consumers.preview && consumers.captures == 0 {
            session.close();
            owned.remove(&session.id);
        }
    }
    fn current(&self, token: (u64, u64)) -> Result<(), String> {
        if !APP_ACTIVE.load(Ordering::Acquire)
            || token
                != (
                    self.epoch.load(Ordering::Acquire),
                    APP_EPOCH.load(Ordering::Acquire),
                )
        {
            return Err("camera_request_cancelled".into());
        }
        if !self.ready.load(Ordering::Acquire) {
            return Err("camera_login_required".into());
        }
        Ok(())
    }
    fn token(&self) -> (u64, u64) {
        (
            self.epoch.load(Ordering::Acquire),
            APP_EPOCH.load(Ordering::Acquire),
        )
    }
    async fn provision_device(
        &self,
        did: &str,
        token: (u64, u64),
    ) -> Result<(cloud::Device, cloud::Provision), String> {
        self.current(token)?;
        let mut cloud = self.cloud.lock().await;
        self.current(token)?;
        let cloud = cloud.as_mut().ok_or("camera_login_required")?;
        let devices: Vec<cloud::Device> = serde_json::from_value(cloud.state["devices"].clone())
            .map_err(|_| "camera_login_required")?;
        let device = devices
            .into_iter()
            .find(|d| d.did == did)
            .ok_or("camera_device_not_in_account")?;
        let provision = match cloud.provision(did).await {
            Err(error) if error == "camera_account_expired" => {
                cloud.refresh().await?;
                self.persist(cloud)?;
                cloud.provision(did).await?
            }
            other => other?,
        };
        Ok((device, provision))
    }
    async fn pan_tilt(
        self: &Arc<Self>,
        did: &str,
        direction: &str,
        token: (u64, u64),
    ) -> Result<(), String> {
        if !matches!(direction, "left" | "right" | "up" | "down") {
            return Err("camera_ptz_direction_invalid".into());
        }
        self.current(token)?;
        if self
            .ptz_busy
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Err("camera_ptz_busy".into());
        }
        let _busy = PtzBusyGuard(&self.ptz_busy);

        let active_session = {
            let owned = self.owned.lock().unwrap();
            owned
                .values()
                .find(|s| {
                    s.did == did
                        && !s.cancelled.load(Ordering::Acquire)
                        && s.error.lock().unwrap().is_none()
                })
                .cloned()
        };

        if let Some(session) = active_session {
            let deadline = tokio::time::Instant::now() + Duration::from_secs(6);
            loop {
                self.current(token)?;
                if session.cancelled.load(Ordering::Acquire) {
                    return Err("camera_session_closed".into());
                }
                if let Some(err) = session.error.lock().unwrap().clone() {
                    return Err(err);
                }
                let handle = session.command.lock().unwrap().clone();
                if let Some(handle) = handle {
                    handle.pan_tilt(direction).await?;
                    tokio::time::sleep(Duration::from_millis(350)).await;
                    return Ok(());
                }
                if tokio::time::Instant::now() >= deadline {
                    return Err("camera_cs2_handshake_timeout".into());
                }
                tokio::time::sleep(Duration::from_millis(30)).await;
            }
        }

        let (device, provision) = self.provision_device(did, token).await?;
        self.current(token)?;
        let miss =
            transport::Miss::connect_with_options(&device.host, provision, &device.model, false)
                .await?;
        miss.command_handle().pan_tilt(direction).await?;
        tokio::time::sleep(Duration::from_millis(350)).await;
        Ok(())
    }
    fn acquire(
        self: &Arc<Self>,
        did: &str,
        preview: bool,
        token: (u64, u64),
    ) -> Result<Arc<Session>, String> {
        let mut owned = self.owned.lock().unwrap();
        self.current(token)?;
        let existing = owned
            .values()
            .find(|s| {
                s.did == did
                    && !s.cancelled.load(Ordering::Acquire)
                    && s.error.lock().unwrap().is_none()
            })
            .cloned();
        let session = if let Some(session) = existing {
            session
        } else {
            let session = Session::create(did.into())?;
            self.current(token)?;
            owned.insert(session.id.clone(), session.clone());
            let weak = Arc::downgrade(&session);
            let host = Arc::downgrade(self);
            let did = did.to_owned();
            *session.worker.lock().unwrap() = Some(tokio::spawn(async move {
                let result: Result<(), String> = async {
                    let (device, provision) = {
                        let host = host.upgrade().ok_or("camera_host_closed")?;
                        host.provision_device(&did, token).await?
                    };
                    host.upgrade().ok_or("camera_host_closed")?.current(token)?;
                    let mut miss =
                        transport::Miss::connect(&device.host, provision, &device.model).await?;
                    if let Some(session) = weak.upgrade() {
                        *session.command.lock().unwrap() = Some(miss.command_handle());
                    }
                    loop {
                        let packet = miss.video().await?;
                        let session = weak.upgrade().ok_or("camera_session_closed")?;
                        if session.cancelled.load(Ordering::Acquire) {
                            return Ok(());
                        }
                        tokio::task::spawn_blocking(move || session.decoder.feed(&packet))
                            .await
                            .map_err(|_| "camera_decode_failed")??;
                    }
                }
                .await;
                if let Some(session) = weak.upgrade() {
                    *session.command.lock().unwrap() = None;
                    if let Err(error) = result {
                        *session.error.lock().unwrap() = Some(error);
                        session.decoder.close();
                    }
                }
            }));
            session
        };
        let mut consumers = session.consumers.lock().unwrap();
        if preview {
            consumers.preview = true;
        } else {
            consumers.captures += 1;
        }
        drop(consumers);
        Ok(session)
    }
    fn persist(&self, cloud: &cloud::Cloud) -> Result<(), String> {
        if cloud.state["state"] == "ready" {
            self.vault.set(
                "camera".into(),
                serde_json::to_string(&cloud.credentials).unwrap(),
            )?;
        }
        Ok(())
    }
    async fn account(&self, action: AccountAction, generation: u64) -> Result<String, String> {
        let mut slot = self.cloud.lock().await;
        if generation != self.account_generation.load(Ordering::Acquire) {
            return Err("camera_request_cancelled".into());
        }
        if let Some(cloud) = slot.as_mut() {
            cloud.state.as_object_mut().unwrap().remove("error");
        }
        let result: Result<(), String> = match action {
            AccountAction::Restore => {
                let saved = self.vault.get("camera".into())?;
                if saved.is_empty() {
                    return Ok(json!({"state":"signed_out"}).to_string());
                }
                let credentials: cloud::Credentials =
                    serde_json::from_str(&saved).map_err(|_| "camera_saved_account_invalid")?;
                let mut cloud = cloud::Cloud::new(&credentials.region)?;
                let result = cloud.restore(credentials).await;
                *slot = Some(cloud);
                result
            }
            AccountAction::Password(user, password, region) => {
                let mut cloud = cloud::Cloud::new(&region)?;
                let result = cloud.password(user, password).await;
                *slot = Some(cloud);
                result
            }
            AccountAction::Submit(answer) => {
                slot.as_mut()
                    .ok_or("camera_challenge_missing")?
                    .submit(answer)
                    .await
            }
            AccountAction::RefreshCaptcha => {
                slot.as_mut()
                    .ok_or("camera_challenge_missing")?
                    .refresh_captcha()
                    .await
            }
            AccountAction::ResendTicket => {
                slot.as_mut()
                    .ok_or("camera_challenge_missing")?
                    .resend_ticket()
                    .await
            }
            AccountAction::Resume => {
                slot.as_mut()
                    .ok_or("camera_login_continuation_missing")?
                    .resume()
                    .await
            }
        };
        if generation != self.account_generation.load(Ordering::Acquire) {
            return Err("camera_request_cancelled".into());
        }
        let cloud = slot.as_mut().unwrap();
        let result = result.and_then(|()| self.persist(cloud));
        match result {
            Ok(()) => {
                self.ready
                    .store(cloud.state["state"] == "ready", Ordering::Release);
            }
            Err(error) => {
                self.ready.store(false, Ordering::Release);
                let mut state = cloud.state.clone();
                if state["state"] == "ready" {
                    state["state"] = "continuing".into();
                }
                state["error"] = error.into();
                return Ok(state.to_string());
            }
        }
        Ok(cloud.state.to_string())
    }
}
enum AccountAction {
    Restore,
    Password(String, String, String),
    Submit(String),
    Resume,
    RefreshCaptcha,
    ResendTicket,
}
struct CaptureRequest {
    did: String,
    token: (u64, u64),
    cancelled: AtomicBool,
}
struct CaptureLease {
    host: Arc<Host>,
    session: Arc<Session>,
    request_id: Option<String>,
}
impl Drop for CaptureLease {
    fn drop(&mut self) {
        self.host.release(&self.session, false);
        if let Some(id) = &self.request_id {
            self.host.requests.lock().unwrap().remove(id);
        }
    }
}

/// One JPEG from the native camera, acquired after the capture request.
#[derive(JsObject)]
pub struct CameraFrame {
    /// Base64-encoded JPEG bytes.
    pub data: String,
    /// Image content type.
    pub mime_type: String,
    /// JPEG width in pixels.
    pub width: i32,
    /// JPEG height in pixels.
    pub height: i32,
    /// Time of frame reception, in milliseconds since the Unix epoch.
    pub received_at: String,
}

/// Owns the video account and shared per-device camera sessions.
#[class]
pub struct XiaomiCameraHost {
    host: Arc<Host>,
}
#[class]
impl XiaomiCameraHost {
    /// Open the existing native credential vault without starting network I/O.
    pub fn new(sys: System) -> Result<Self, String> {
        Ok(Self {
            host: Arc::new(Host {
                owned: Mutex::new(HashMap::new()),
                cloud: tokio::sync::Mutex::new(None),
                requests: Mutex::new(HashMap::new()),
                epoch: AtomicU64::new(0),
                account_generation: AtomicU64::new(0),
                ready: AtomicBool::new(false),
                ptz_busy: AtomicBool::new(false),
                vault: crate::credentials::CredentialVault::new(sys)?,
            }),
        })
    }
    /// Restore and verify the saved xiaomiio account.
    pub async fn initialize(this: Instance<Self>) -> Result<String, String> {
        let host = this.with(|s| s.host.clone());
        let generation = host.account_generation.load(Ordering::Acquire);
        background(async move { host.account(AccountAction::Restore, generation).await })
            .await
            .map_err(|_| "camera_login_failed")?
    }
    /// Start password login. Returns ready, CAPTCHA or SMS/email challenge.
    pub async fn login(
        this: Instance<Self>,
        username: String,
        password: String,
        region: String,
    ) -> Result<String, String> {
        let host = this.with(|s| s.host.clone());
        host.ready.store(false, Ordering::Release);
        host.close_all();
        let generation = host.account_generation.fetch_add(1, Ordering::AcqRel) + 1;
        background(async move {
            host.account(
                AccountAction::Password(username, password, region),
                generation,
            )
            .await
        })
        .await
        .map_err(|_| "camera_login_failed")?
    }
    /// Answer the current CAPTCHA or verification challenge.
    pub async fn submit(this: Instance<Self>, answer: String) -> Result<String, String> {
        let host = this.with(|s| s.host.clone());
        let generation = host.account_generation.load(Ordering::Acquire);
        background(async move {
            host.account(AccountAction::Submit(answer), generation)
                .await
        })
        .await
        .map_err(|_| "camera_login_failed")?
    }
    /// Resume the pending redirect without resending the verification code.
    pub async fn resume_login(this: Instance<Self>) -> Result<String, String> {
        let host = this.with(|s| s.host.clone());
        let generation = host.account_generation.load(Ordering::Acquire);
        background(async move { host.account(AccountAction::Resume, generation).await })
            .await
            .map_err(|_| "camera_login_failed")?
    }
    /// Fetch a new image for the current CAPTCHA challenge.
    pub async fn refresh_captcha(this: Instance<Self>) -> Result<String, String> {
        let host = this.with(|s| s.host.clone());
        let generation = host.account_generation.load(Ordering::Acquire);
        background(async move {
            host.account(AccountAction::RefreshCaptcha, generation)
                .await
        })
        .await
        .map_err(|_| "camera_login_failed")?
    }
    /// Send another real SMS or email ticket for the current identity challenge.
    pub async fn resend_ticket(this: Instance<Self>) -> Result<String, String> {
        let host = this.with(|s| s.host.clone());
        let generation = host.account_generation.load(Ordering::Acquire);
        background(async move { host.account(AccountAction::ResendTicket, generation).await })
            .await
            .map_err(|_| "camera_login_failed")?
    }
    /// Invalidate a pending sign-in before it can commit credentials.
    pub fn cancel_login(&self) {
        self.host.account_generation.fetch_add(1, Ordering::AcqRel);
    }
    /// Delete video credentials and close all native video sessions.
    pub async fn logout(this: Instance<Self>) -> Result<(), String> {
        let host = this.with(|s| s.host.clone());
        host.ready.store(false, Ordering::Release);
        host.close_all();
        host.account_generation.fetch_add(1, Ordering::AcqRel);
        background(async move {
            *host.cloud.lock().await = None;
            host.ready.store(false, Ordering::Release);
            host.vault.remove("camera".into())
        })
        .await
        .map_err(|_| "camera_logout_failed")?
    }
    /// Attach one preview consumer; the returned ID refers to a shared decoder.
    pub async fn open_preview(this: Instance<Self>, did: String) -> Result<String, String> {
        let host = this.with(|s| s.host.clone());
        let token = host.token();
        background(async move { host.acquire(&did, true, token).map(|s| s.id.clone()) })
            .await
            .map_err(|_| "camera_start_failed")?
    }
    /// Detach preview without interrupting an in-flight Agent capture.
    pub fn close_preview(&self, session_id: String) {
        let session = self.host.owned.lock().unwrap().get(&session_id).cloned();
        if let Some(session) = session {
            self.host.release(&session, true);
        }
    }
    /// Step pan/tilt motor (`"left" | "right" | "up" | "down"`) over the active MISS TCP session.
    pub async fn pan_tilt(
        this: Instance<Self>,
        did: String,
        direction: String,
    ) -> Result<(), String> {
        let host = this.with(|s| s.host.clone());
        let token = host.token();
        background(async move { host.pan_tilt(&did, &direction, token).await })
            .await
            .map_err(|_| "camera_ptz_failed")?
    }
    /// Reserve a cancellable capture before its async task is polled.
    pub fn begin_capture(&self, did: String) -> Result<String, String> {
        let token = self.host.token();
        self.host.current(token)?;
        let id = uuid::Uuid::new_v4().to_string();
        self.host.requests.lock().unwrap().insert(
            id.clone(),
            Arc::new(CaptureRequest {
                did,
                token,
                cancelled: AtomicBool::new(false),
            }),
        );
        Ok(id)
    }
    /// Cancel just this capture, preserving a shared preview or other captures.
    pub fn cancel_capture(&self, request_id: String) {
        if let Some(request) = self.host.requests.lock().unwrap().remove(&request_id) {
            request.cancelled.store(true, Ordering::Release);
        }
    }
    /// Capture without requiring a view. A different DID gets its own short session.
    pub async fn capture_device(
        this: Instance<Self>,
        request_id: String,
    ) -> Result<CameraFrame, String> {
        let host = this.with(|s| s.host.clone());
        let request = host
            .requests
            .lock()
            .unwrap()
            .get(&request_id)
            .cloned()
            .ok_or("camera_request_cancelled")?;
        background(async move {
            if request.cancelled.load(Ordering::Acquire) {
                return Err("camera_request_cancelled".into());
            }
            let session = match host.acquire(&request.did, false, request.token) {
                Ok(session) => session,
                Err(error) => {
                    host.requests.lock().unwrap().remove(&request_id);
                    return Err(error);
                }
            };
            let _lease = CaptureLease {
                host,
                session: session.clone(),
                request_id: Some(request_id),
            };
            session.capture(Some(request)).await
        })
        .await
        .map_err(|_| "camera_frame_failed")?
    }
    /// A diagnostic source uses the same decoder and capture path as live transport.
    #[cfg(debug_assertions)]
    pub async fn open_sample(this: Instance<Self>, data: String) -> Result<String, String> {
        let host = this.with(|s| s.host.clone());
        background(async move {
            let data = STANDARD.decode(data).map_err(|_| "camera_sample_invalid")?;
            let packets = video::sample_packets(&data);
            if packets.is_empty() {
                return Err("camera_sample_empty".into());
            }
            let session = Session::create(uuid::Uuid::new_v4().to_string())?;
            session.consumers.lock().unwrap().preview = true;
            let weak = Arc::downgrade(&session);
            *session.worker.lock().unwrap() = Some(tokio::spawn(async move {
                let mut timestamp = 0;
                loop {
                    for data in &packets {
                        let Some(session) = weak.upgrade() else {
                            return;
                        };
                        if session.cancelled.load(Ordering::Acquire) {
                            return;
                        }
                        let packet = video::VideoPacket {
                            codec: 5,
                            timestamp_ms: timestamp,
                            data: data.clone(),
                        };
                        let decode = session.clone();
                        if !matches!(
                            tokio::task::spawn_blocking(move || decode.decoder.feed(&packet)).await,
                            Ok(Ok(()))
                        ) {
                            *session.error.lock().unwrap() =
                                Some("camera_sample_decode_failed".into());
                            return;
                        }
                        drop(session);
                        timestamp += 50;
                        tokio::time::sleep(Duration::from_millis(50)).await;
                    }
                }
            }));
            let id = session.id.clone();
            host.owned.lock().unwrap().insert(id.clone(), session);
            Ok(id)
        })
        .await
        .map_err(|_| "camera_start_failed")?
    }
    /// Current decoded dimensions, frame count and optional display readiness.
    pub fn status(&self, session_id: String) -> Result<String, String> {
        self.host
            .owned
            .lock()
            .unwrap()
            .get(&session_id)
            .map(|s| s.status().to_string())
            .ok_or("camera_session_missing".into())
    }
    /// Capture the next frame from a known session.
    pub async fn capture(this: Instance<Self>, session_id: String) -> Result<CameraFrame, String> {
        let host = this.with(|s| s.host.clone());
        let session = {
            let owned = host.owned.lock().unwrap();
            let session = owned
                .get(&session_id)
                .cloned()
                .ok_or("camera_session_missing")?;
            session.consumers.lock().unwrap().captures += 1;
            session
        };
        background(async move {
            let _lease = CaptureLease {
                host,
                session: session.clone(),
                request_id: None,
            };
            session.capture(None).await
        })
        .await
        .map_err(|_| "camera_frame_failed")?
    }
    /// Force-close a session, including a still-mounted view.
    pub fn close(&self, session_id: String) {
        if let Some(session) = self.host.owned.lock().unwrap().remove(&session_id) {
            session.close();
        }
    }
    /// Release all transports and decoders on App background.
    pub fn stop_all(&self) {
        self.host.close_all();
    }
}
impl Drop for XiaomiCameraHost {
    fn drop(&mut self) {
        self.host.close_all();
    }
}

#[cfg(target_os = "ios")]
#[unsafe(no_mangle)]
pub extern "C" fn looi_camera_background() {
    APP_ACTIVE.store(false, Ordering::Release);
    APP_EPOCH.fetch_add(1, Ordering::AcqRel);
    let active: Vec<_> = sessions()
        .lock()
        .unwrap()
        .values()
        .filter_map(Weak::upgrade)
        .collect();
    for session in active {
        session.close();
    }
}

#[cfg(target_os = "ios")]
#[unsafe(no_mangle)]
pub extern "C" fn looi_camera_foreground() {
    APP_ACTIVE.store(true, Ordering::Release);
}
