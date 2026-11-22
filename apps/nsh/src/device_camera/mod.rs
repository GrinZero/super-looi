//! App-owned phone front/back camera sessions (`DeviceCameraHost`) and preview state registry.
//! Enforces explicit OS camera authorization, bounded frame rates/resolutions, and immediate teardown on app backgrounding.
use nsh_core::prelude::*;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, OnceLock, Weak,
        atomic::{AtomicBool, AtomicI32, AtomicU64, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

#[cfg(target_os = "android")]
mod android;
#[cfg(target_os = "ios")]
pub mod ios;
mod sample_jpeg;
#[cfg(target_os = "ios")]
pub mod view_ios;

#[cfg(target_os = "android")]
use android as platform;
#[cfg(target_os = "ios")]
use ios as platform;

#[cfg(not(any(target_os = "ios", target_os = "android")))]
mod platform {
    use super::{CroppedPortraitBytes, EncodedFrame, FacesOnlyFrame, NativeSessionStatus};

    pub fn permission() -> String {
        "unavailable".into()
    }

    pub fn request_permission_blocking() -> String {
        "unavailable".into()
    }

    pub fn query_hfov(_facing: &str) -> f64 {
        0.0
    }

    pub struct PlatformSession;

    impl PlatformSession {
        pub fn open(
            _id: &str,
            facing: &str,
            _max_dimension: i32,
            _max_fps: i32,
        ) -> Result<Self, String> {
            Err(format!(
                "[stage=native.desktop.open code=ERR_DEVICE_CAMERA_UNAVAILABLE] Native phone camera ({facing}) requires iOS or Android"
            ))
        }

        pub fn reconfigure(&self, _max_dimension: i32, _max_fps: i32) -> Result<(), String> {
            Ok(())
        }

        pub fn status(&self) -> NativeSessionStatus {
            NativeSessionStatus::default()
        }

        pub fn jpeg(&self, _max_dimension: i32) -> Result<EncodedFrame, String> {
            Err("[stage=native.desktop.jpeg code=ERR_DEVICE_CAMERA_UNAVAILABLE] Native phone camera requires iOS or Android".into())
        }

        pub fn faces_only(&self) -> Result<FacesOnlyFrame, String> {
            Err("[stage=native.desktop.faces code=ERR_DEVICE_CAMERA_UNAVAILABLE] Native phone camera requires iOS or Android".into())
        }

        pub fn crop_jpeg(
            &self,
            _x: f64,
            _y: f64,
            _width: f64,
            _height: f64,
            _max_dimension: i32,
            _jpeg_quality: i32,
        ) -> Result<CroppedPortraitBytes, String> {
            Err("[stage=native.desktop.crop code=ERR_DEVICE_CAMERA_UNAVAILABLE] Native phone camera requires iOS or Android".into())
        }

        pub fn close(&self) {}
    }
}

static APP_ACTIVE: AtomicBool = AtomicBool::new(true);
static APP_EPOCH: AtomicU64 = AtomicU64::new(0);
static SESSIONS: OnceLock<Mutex<HashMap<String, Weak<Session>>>> = OnceLock::new();
static TOKIO_HANDLE: OnceLock<tokio::runtime::Handle> = OnceLock::new();

pub(super) fn sessions() -> &'static Mutex<HashMap<String, Weak<Session>>> {
    SESSIONS.get_or_init(Default::default)
}

#[cfg_attr(not(any(target_os = "ios", test)), allow(dead_code))]
pub(super) fn lookup_session(session_id: &str) -> Option<Arc<Session>> {
    sessions()
        .lock()
        .unwrap()
        .get(session_id)
        .and_then(Weak::upgrade)
}

#[cfg_attr(not(target_os = "ios"), allow(dead_code))]
pub(super) fn tokio_handle() -> Option<tokio::runtime::Handle> {
    TOKIO_HANDLE
        .get()
        .cloned()
        .or_else(|| tokio::runtime::Handle::try_current().ok())
}

fn remember_tokio_handle(handle: &tokio::runtime::Handle) {
    let _ = TOKIO_HANDLE.set(handle.clone());
}

pub(super) fn format_backend_error(stage: &str, default_code: &str, detail: &str) -> String {
    let trimmed = detail.trim();
    if trimmed.starts_with("[stage=") {
        return trimmed.to_owned();
    }
    if let Some(rest) = trimmed.strip_prefix("ERR_") {
        let split_at = rest
            .find(|c: char| !(c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_'))
            .unwrap_or(rest.len());
        let code = &trimmed[..4 + split_at];
        let message = trimmed[4 + split_at..]
            .trim_start_matches(':')
            .trim();
        let reason = if message.is_empty() { code } else { message };
        return format!("[stage={stage} code={code}] {reason}");
    }
    format!("[stage={stage} code={default_code}] {trimmed}")
}

pub(super) fn handle_platform_foreground_change(active: bool) {
    APP_ACTIVE.store(active, Ordering::Release);
    if !active {
        APP_EPOCH.fetch_add(1, Ordering::AcqRel);
        let active_sessions: Vec<_> = sessions()
            .lock()
            .unwrap()
            .values()
            .filter_map(Weak::upgrade)
            .collect();
        for session in active_sessions {
            session.close();
        }
    }
}

#[derive(Default, Clone)]
pub(super) struct NativeSessionStatus {
    pub frames: u64,
    pub width: i32,
    pub height: i32,
    pub captured_at_ms: i64,
    pub error: i32,
    pub displayed: Option<bool>,
    pub failure: Option<String>,
}

pub(super) struct EncodedFrame {
    pub jpeg: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub captured_at_ms: i64,
    pub captured_monotonic_ms: f64,
    pub faces_monotonic_ms: f64,
    pub hfov_deg: f64,
    pub seq: u64,
    pub faces: Vec<DetectedCameraNativeFace>,
}

pub(super) struct FacesOnlyFrame {
    pub width: u32,
    pub height: u32,
    pub captured_at_ms: i64,
    pub captured_monotonic_ms: f64,
    pub faces_monotonic_ms: f64,
    pub hfov_deg: f64,
    pub seq: u64,
    pub faces: Vec<DetectedCameraNativeFace>,
}

pub(super) struct CroppedPortraitBytes {
    pub jpeg: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub captured_monotonic_ms: f64,
}

/// Hardware ISP detected face normalized to landscape `[-1, 1]` center offsets.
#[derive(Clone, Debug, JsObject)]
pub struct DetectedCameraNativeFace {
    /// Stable hardware face tracking identifier (`0` when untracked).
    pub track_id: u32,
    /// Horizontal center offset in landscape space: `-1.0` (left) .. `0.0` (center) .. `+1.0` (right).
    pub offset_x: f64,
    /// Vertical center offset in landscape space: `-1.0` (top) .. `0.0` (center) .. `+1.0` (bottom).
    pub offset_y: f64,
    /// Normalized face bounding-box width in `[0.0, 1.0]`.
    pub width: f64,
    /// Normalized face bounding-box height in `[0.0, 1.0]`.
    pub height: f64,
    /// Normalized detector confidence in `[0.0, 1.0]`.
    pub confidence: f64,
}

/// One downscaled JPEG frame captured from the device front or back camera.
#[derive(Clone, JsObject)]
pub struct DeviceCameraNativeFrame {
    /// Raw JPEG bytes mapped directly to a JS `Uint8Array` without disk writes.
    pub jpeg: Vec<u8>,
    /// Encoded JPEG width in pixels.
    pub width: u32,
    /// Encoded JPEG height in pixels.
    pub height: u32,
    /// Camera lens facing: `"front"` or `"back"`.
    pub facing: String,
    /// Capture timestamp in milliseconds since Unix epoch.
    pub captured_at_ms: f64,
    /// Unified `CLOCK_MONOTONIC` capture timestamp in milliseconds.
    pub captured_monotonic_ms: f64,
    /// Unified `CLOCK_MONOTONIC` timestamp of the latest hardware face detection result (`0` when unseen).
    pub faces_monotonic_ms: f64,
    /// Camera landscape horizontal field of view in degrees (`0` when unknown).
    pub hfov_deg: f64,
    /// Monotonic frame sequence number within this session.
    pub seq: f64,
    /// Hardware ISP detected faces normalized to landscape `[-1, 1]` center offsets.
    pub faces: Vec<DetectedCameraNativeFace>,
}

/// Lightweight metadata + hardware face array sampled without JPEG encoding overhead.
#[derive(Clone, JsObject)]
pub struct DeviceCameraNativeFacesFrame {
    pub width: u32,
    pub height: u32,
    pub facing: String,
    pub captured_at_ms: f64,
    pub captured_monotonic_ms: f64,
    pub faces_monotonic_ms: f64,
    pub hfov_deg: f64,
    pub seq: f64,
    pub faces: Vec<DetectedCameraNativeFace>,
}

/// Native single-person cropped portrait cached on private app disk (`file://...`).
#[derive(Clone, JsObject)]
pub struct DeviceCameraNativePortrait {
    pub uri: String,
    pub portrait_id: String,
    pub width: u32,
    pub height: u32,
    pub byte_length: u32,
    pub captured_monotonic_ms: f64,
}

pub(super) fn build_sample_faces(facing: &str, seq: u64) -> Vec<DetectedCameraNativeFace> {
    if facing != "front" {
        return Vec::new();
    }
    let (offset_x, offset_y) = if seq <= 3 {
        let phase = seq as f64 * 0.35;
        let ox = ((phase.sin() * 0.08) * 10_000.0).round() / 10_000.0;
        let oy = (((phase * 0.7).cos() * 0.05 - 0.02) * 10_000.0).round() / 10_000.0;
        (ox, oy)
    } else {
        let phase = (seq - 3) as f64 * 0.18;
        let ox = ((phase.sin() * 0.42) * 10_000.0).round() / 10_000.0;
        let oy = (((phase * 0.65).cos() * 0.16 - 0.02) * 10_000.0).round() / 10_000.0;
        (ox, oy)
    };
    vec![DetectedCameraNativeFace {
        track_id: 1,
        offset_x,
        offset_y,
        width: 0.24,
        height: 0.36,
        confidence: 0.96,
    }]
}

pub(super) struct SampleStreamState {
    max_dimension: AtomicI32,
    max_fps: AtomicI32,
    frames: AtomicU64,
    captured_at_ms: AtomicU64,
    worker: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

pub(super) enum SessionBackend {
    Platform(platform::PlatformSession),
    Sample(SampleStreamState),
}

pub(super) struct Session {
    pub id: String,
    pub facing: String,
    pub backend: SessionBackend,
    #[cfg_attr(not(target_os = "ios"), allow(dead_code))]
    pub runtime: tokio::runtime::Handle,
    pub closed: AtomicBool,
}

impl Drop for Session {
    fn drop(&mut self) {
        let mut map = sessions().lock().unwrap();
        if let Some(existing) = map.get(&self.id)
            && std::ptr::eq(existing.as_ptr(), self as *const Session)
        {
            map.remove(&self.id);
        }
    }
}

fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn normalize_facing(facing: &str) -> Result<&'static str, String> {
    match facing {
        "front" => Ok("front"),
        "back" => Ok("back"),
        other => Err(format!(
            "[stage=device_camera.validate code=ERR_INVALID_CAMERA_FACING] Unsupported camera facing \"{other}\"; expected \"front\" or \"back\""
        )),
    }
}

impl Session {
    fn open_platform(
        runtime: tokio::runtime::Handle,
        requested_id: Option<&str>,
        facing: &str,
        max_dimension: i32,
        max_fps: i32,
    ) -> Result<Arc<Self>, String> {
        let normalized_facing = normalize_facing(facing)?;
        let clamped_dim = max_dimension.clamp(160, 1920);
        let clamped_fps = max_fps.clamp(1, 30);
        let id = requested_id
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let backend = platform::PlatformSession::open(&id, normalized_facing, clamped_dim, clamped_fps)?;
        let session = Arc::new(Self {
            id: id.clone(),
            facing: normalized_facing.into(),
            backend: SessionBackend::Platform(backend),
            runtime,
            closed: AtomicBool::new(false),
        });
        sessions()
            .lock()
            .unwrap()
            .insert(id, Arc::downgrade(&session));
        Ok(session)
    }

    fn open_sample(
        requested_id: Option<&str>,
        facing: &str,
        max_dimension: i32,
        max_fps: i32,
    ) -> Result<Arc<Self>, String> {
        let normalized_facing = normalize_facing(facing)?;
        let clamped_dim = max_dimension.clamp(160, 1920);
        let clamped_fps = max_fps.clamp(1, 30);
        let id = requested_id
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

        let state = SampleStreamState {
            max_dimension: AtomicI32::new(clamped_dim),
            max_fps: AtomicI32::new(clamped_fps),
            frames: AtomicU64::new(1),
            captured_at_ms: AtomicU64::new(now_unix_ms()),
            worker: Mutex::new(None),
        };
        let session = Arc::new(Self {
            id: id.clone(),
            facing: normalized_facing.into(),
            backend: SessionBackend::Sample(state),
            runtime: tokio::runtime::Handle::current(),
            closed: AtomicBool::new(false),
        });
        let weak = Arc::downgrade(&session);
        let worker = tokio::spawn(async move {
            loop {
                let interval_ms = {
                    let Some(s) = weak.upgrade() else { return };
                    if s.closed.load(Ordering::Acquire) {
                        return;
                    }
                    match &s.backend {
                        SessionBackend::Sample(st) => {
                            (1000 / st.max_fps.load(Ordering::Acquire).max(1)) as u64
                        }
                        SessionBackend::Platform(_) => return,
                    }
                };
                tokio::time::sleep(Duration::from_millis(interval_ms.max(20))).await;
                let Some(s) = weak.upgrade() else { return };
                if s.closed.load(Ordering::Acquire) {
                    return;
                }
                if let SessionBackend::Sample(st) = &s.backend {
                    st.captured_at_ms.store(now_unix_ms(), Ordering::Release);
                    st.frames.fetch_add(1, Ordering::AcqRel);
                }
            }
        });
        if let SessionBackend::Sample(st) = &session.backend {
            *st.worker.lock().unwrap() = Some(worker);
        }
        sessions()
            .lock()
            .unwrap()
            .insert(id, Arc::downgrade(&session));
        Ok(session)
    }

    fn reconfigure(&self, max_dimension: i32, max_fps: i32) -> Result<(), String> {
        if self.closed.load(Ordering::Acquire) {
            return Err("[stage=device_camera.reconfigure code=ERR_DEVICE_CAMERA_CLOSED] Camera session is closed".into());
        }
        let clamped_dim = max_dimension.clamp(160, 1920);
        let clamped_fps = max_fps.clamp(1, 30);
        match &self.backend {
            SessionBackend::Platform(p) => p.reconfigure(clamped_dim, clamped_fps),
            SessionBackend::Sample(st) => {
                st.max_dimension.store(clamped_dim, Ordering::Release);
                st.max_fps.store(clamped_fps, Ordering::Release);
                Ok(())
            }
        }
    }

    fn native_status(&self) -> NativeSessionStatus {
        match &self.backend {
            SessionBackend::Platform(p) => p.status(),
            SessionBackend::Sample(st) => {
                let (w, h) = sample_jpeg::sample_dimensions(st.max_dimension.load(Ordering::Acquire));
                NativeSessionStatus {
                    frames: st.frames.load(Ordering::Acquire),
                    width: w as i32,
                    height: h as i32,
                    captured_at_ms: st.captured_at_ms.load(Ordering::Acquire) as i64,
                    error: 0,
                    displayed: Some(st.frames.load(Ordering::Acquire) > 0),
                    failure: None,
                }
            }
        }
    }

    pub(super) fn status_json(&self) -> Value {
        let s = self.native_status();
        json!({
            "sessionId": self.id,
            "facing": self.facing,
            "frames": s.frames,
            "width": s.width,
            "height": s.height,
            "capturedAtMs": s.captured_at_ms,
            "error": s.error,
            "displayed": s.displayed,
            "closed": self.closed.load(Ordering::Acquire),
            "failure": s.failure,
        })
    }

    #[cfg_attr(not(target_os = "ios"), allow(dead_code))]
    pub(super) fn sample_preview_snapshot(
        &self,
    ) -> Option<(i32, u64, Option<DetectedCameraNativeFace>)> {
        let SessionBackend::Sample(st) = &self.backend else {
            return None;
        };
        if self.closed.load(Ordering::Acquire) {
            return None;
        }
        let seq = st.frames.load(Ordering::Acquire);
        let facing_code = if self.facing == "back" { 1 } else { 0 };
        let face = build_sample_faces(&self.facing, seq).into_iter().next();
        Some((facing_code, seq, face))
    }

    fn close(&self) {
        if self.closed.swap(true, Ordering::AcqRel) {
            return;
        }
        match &self.backend {
            SessionBackend::Platform(p) => p.close(),
            SessionBackend::Sample(st) => {
                if let Some(worker) = st.worker.lock().unwrap().take() {
                    worker.abort();
                }
            }
        }
    }

    async fn capture_frame(
        self: Arc<Self>,
        max_dimension: i32,
        after_seq: u64,
    ) -> Result<DeviceCameraNativeFrame, String> {
        let clamped_dim = if max_dimension > 0 {
            max_dimension.clamp(160, 1920)
        } else {
            640
        };
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        loop {
            if self.closed.load(Ordering::Acquire) {
                return Err("[stage=device_camera.capture code=ERR_DEVICE_CAMERA_CLOSED] Camera session closed".into());
            }
            if !APP_ACTIVE.load(Ordering::Acquire) {
                return Err("[stage=device_camera.capture code=ERR_DEVICE_CAMERA_BACKGROUNDED] Camera paused while app is in background".into());
            }
            let status = self.native_status();
            if let Some(failure) = status.failure {
                return Err(format_backend_error(
                    "device_camera.capture",
                    "ERR_DEVICE_CAMERA_RUNTIME",
                    &failure,
                ));
            }
            if status.frames > after_seq {
                let s = self.clone();
                let facing = self.facing.clone();
                let encoded = tokio::task::spawn_blocking(move || match &s.backend {
                    SessionBackend::Platform(p) => p.jpeg(clamped_dim),
                    SessionBackend::Sample(st) => {
                        let seq = st.frames.load(Ordering::Acquire);
                        let ts = st.captured_at_ms.load(Ordering::Acquire) as i64;
                        let mono_ms = crate::host_monotonic_ms();
                        let effective_dim = clamped_dim.min(st.max_dimension.load(Ordering::Acquire));
                        let (jpeg, width, height) =
                            sample_jpeg::encode_sample_jpeg(&s.facing, effective_dim, seq);
                        let faces = build_sample_faces(&s.facing, seq);
                        Ok(EncodedFrame {
                            jpeg,
                            width,
                            height,
                            captured_at_ms: ts,
                            captured_monotonic_ms: mono_ms,
                            faces_monotonic_ms: if faces.is_empty() { 0.0 } else { mono_ms },
                            hfov_deg: 68.0,
                            seq,
                            faces,
                        })
                    }
                })
                .await
                .map_err(|err| format!("[stage=device_camera.capture code=ERR_DEVICE_CAMERA_TASK_JOIN] {err}"))??;

                return Ok(DeviceCameraNativeFrame {
                    jpeg: encoded.jpeg,
                    width: encoded.width,
                    height: encoded.height,
                    facing,
                    captured_at_ms: encoded.captured_at_ms as f64,
                    captured_monotonic_ms: encoded.captured_monotonic_ms,
                    faces_monotonic_ms: encoded.faces_monotonic_ms,
                    hfov_deg: encoded.hfov_deg,
                    seq: encoded.seq as f64,
                    faces: encoded.faces,
                });
            }
            if tokio::time::Instant::now() >= deadline {
                return Err("[stage=device_camera.capture code=ERR_DEVICE_CAMERA_FRAME_TIMEOUT] Timed out waiting for next camera frame".into());
            }
            tokio::time::sleep(Duration::from_millis(15)).await;
        }
    }

    async fn capture_faces(
        self: Arc<Self>,
        after_seq: u64,
    ) -> Result<DeviceCameraNativeFacesFrame, String> {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        loop {
            if self.closed.load(Ordering::Acquire) {
                return Err("[stage=device_camera.captureFaces code=ERR_DEVICE_CAMERA_CLOSED] Camera session closed".into());
            }
            if !APP_ACTIVE.load(Ordering::Acquire) {
                return Err("[stage=device_camera.captureFaces code=ERR_DEVICE_CAMERA_BACKGROUNDED] Camera paused while app is in background".into());
            }
            let status = self.native_status();
            if let Some(failure) = status.failure {
                return Err(format_backend_error(
                    "device_camera.captureFaces",
                    "ERR_DEVICE_CAMERA_RUNTIME",
                    &failure,
                ));
            }
            if status.frames > after_seq {
                let s = self.clone();
                let facing = self.facing.clone();
                let faces_frame = tokio::task::spawn_blocking(move || match &s.backend {
                    SessionBackend::Platform(p) => p.faces_only(),
                    SessionBackend::Sample(st) => {
                        let seq = st.frames.load(Ordering::Acquire);
                        let ts = st.captured_at_ms.load(Ordering::Acquire) as i64;
                        let mono_ms = crate::host_monotonic_ms();
                        let (w, h) = sample_jpeg::sample_dimensions(st.max_dimension.load(Ordering::Acquire));
                        let faces = build_sample_faces(&s.facing, seq);
                        Ok(FacesOnlyFrame {
                            width: w,
                            height: h,
                            captured_at_ms: ts,
                            captured_monotonic_ms: mono_ms,
                            faces_monotonic_ms: if faces.is_empty() { 0.0 } else { mono_ms },
                            hfov_deg: 68.0,
                            seq,
                            faces,
                        })
                    }
                })
                .await
                .map_err(|err| format!("[stage=device_camera.captureFaces code=ERR_DEVICE_CAMERA_TASK_JOIN] {err}"))??;

                return Ok(DeviceCameraNativeFacesFrame {
                    width: faces_frame.width,
                    height: faces_frame.height,
                    facing,
                    captured_at_ms: faces_frame.captured_at_ms as f64,
                    captured_monotonic_ms: faces_frame.captured_monotonic_ms,
                    faces_monotonic_ms: faces_frame.faces_monotonic_ms,
                    hfov_deg: faces_frame.hfov_deg,
                    seq: faces_frame.seq as f64,
                    faces: faces_frame.faces,
                });
            }
            if tokio::time::Instant::now() >= deadline {
                return Err("[stage=device_camera.captureFaces code=ERR_DEVICE_CAMERA_FRAME_TIMEOUT] Timed out waiting for next camera frame".into());
            }
            tokio::time::sleep(Duration::from_millis(15)).await;
        }
    }

    async fn capture_cropped_portrait(
        self: Arc<Self>,
        portraits_dir: PathBuf,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
        portrait_id: String,
        max_dimension: i32,
        jpeg_quality: i32,
    ) -> Result<DeviceCameraNativePortrait, String> {
        if self.closed.load(Ordering::Acquire) {
            return Err("[stage=device_camera.captureCroppedPortrait code=ERR_DEVICE_CAMERA_CLOSED] Camera session closed".into());
        }
        if !APP_ACTIVE.load(Ordering::Acquire) {
            return Err("[stage=device_camera.captureCroppedPortrait code=ERR_DEVICE_CAMERA_BACKGROUNDED] Camera paused while app is in background".into());
        }
        let status = self.native_status();
        if let Some(failure) = status.failure {
            return Err(format_backend_error(
                "device_camera.captureCroppedPortrait",
                "ERR_DEVICE_CAMERA_RUNTIME",
                &failure,
            ));
        }
        let s = self.clone();
        let clamped_dim = if max_dimension > 0 { max_dimension.clamp(64, 1024) } else { 320 };
        let clamped_quality = if jpeg_quality > 0 { jpeg_quality.clamp(40, 95) } else { 84 };
        let cropped = tokio::task::spawn_blocking(move || match &s.backend {
            SessionBackend::Platform(p) => p.crop_jpeg(x, y, width, height, clamped_dim, clamped_quality),
            SessionBackend::Sample(st) => {
                let mut seq = st.frames.load(Ordering::Acquire);
                if seq == 0 {
                    seq = 1;
                }
                let (jpeg, w, h) = sample_jpeg::encode_sample_jpeg(&s.facing, clamped_dim, seq);
                Ok(CroppedPortraitBytes {
                    jpeg,
                    width: w,
                    height: h,
                    captured_monotonic_ms: crate::host_monotonic_ms(),
                })
            }
        })
        .await
        .map_err(|err| format!("[stage=device_camera.captureCroppedPortrait code=ERR_DEVICE_CAMERA_TASK_JOIN] {err}"))??;

        static NEXT_PORTRAIT_TMP_SEQ: AtomicU64 = AtomicU64::new(1);
        let tmp_seq = NEXT_PORTRAIT_TMP_SEQ.fetch_add(1, Ordering::Relaxed);
        let final_dir = portraits_dir.clone();
        let pid = portrait_id.clone();
        let tmp_name = format!("{pid}.{tmp_seq}.jpg.tmp");
        let final_name = format!("{pid}.jpg");
        let tmp_path = final_dir.join(&tmp_name);
        let final_path = final_dir.join(&final_name);
        let byte_len = cropped.jpeg.len() as u32;
        let jpeg_bytes = cropped.jpeg;

        tokio::task::spawn_blocking(move || -> Result<(), String> {
            fs::create_dir_all(&final_dir).map_err(|err| {
                format!("[stage=device_camera.captureCroppedPortrait code=ERR_PORTRAIT_IO_FAILED] Failed to create portraits dir: {err}")
            })?;
            fs::write(&tmp_path, &jpeg_bytes).map_err(|err| {
                format!("[stage=device_camera.captureCroppedPortrait code=ERR_PORTRAIT_IO_FAILED] Failed to write portrait temp file: {err}")
            })?;
            fs::rename(&tmp_path, &final_path).map_err(|err| {
                let _ = fs::remove_file(&tmp_path);
                format!("[stage=device_camera.captureCroppedPortrait code=ERR_PORTRAIT_IO_FAILED] Failed to finalize portrait file: {err}")
            })?;
            Ok(())
        })
        .await
        .map_err(|err| format!("[stage=device_camera.captureCroppedPortrait code=ERR_DEVICE_CAMERA_TASK_JOIN] {err}"))??;

        let final_uri = format!("file://{}", portraits_dir.join(final_name).display());
        Ok(DeviceCameraNativePortrait {
            uri: final_uri,
            portrait_id: pid,
            width: cropped.width,
            height: cropped.height,
            byte_length: byte_len,
            captured_monotonic_ms: cropped.captured_monotonic_ms,
        })
    }
}

fn validate_portrait_id(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        static NEXT_PORTRAIT_ID: AtomicU64 = AtomicU64::new(1);
        let n = NEXT_PORTRAIT_ID.fetch_add(1, Ordering::Relaxed);
        return Ok(format!("portrait-{}-{}", crate::host_monotonic_ms() as u64, n));
    }
    if trimmed.len() > 64
        || !trimmed
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err(format!(
            "[stage=device_camera.portrait code=ERR_PORTRAIT_INVALID_ID] Invalid portraitId \"{trimmed}\""
        ));
    }
    Ok(trimmed.to_string())
}

fn resolve_portrait_path(portraits_dir: &Path, id_or_uri: &str) -> Result<PathBuf, String> {
    let trimmed = id_or_uri.trim();
    if let Some(raw_path) = trimmed.strip_prefix("file://") {
        let candidate = Path::new(raw_path);
        let Some(parent) = candidate.parent() else {
            return Err(format!(
                "[stage=device_camera.deletePortrait code=ERR_PORTRAIT_INVALID_ID] Invalid portrait URI \"{trimmed}\""
            ));
        };
        if parent != portraits_dir {
            return Err(format!(
                "[stage=device_camera.deletePortrait code=ERR_PORTRAIT_INVALID_ID] Portrait URI outside portraits dir: \"{trimmed}\""
            ));
        }
        let Some(file_name) = candidate.file_name().and_then(|n| n.to_str()) else {
            return Err(format!(
                "[stage=device_camera.deletePortrait code=ERR_PORTRAIT_INVALID_ID] Missing portrait filename: \"{trimmed}\""
            ));
        };
        let Some(stem) = file_name.strip_suffix(".jpg") else {
            return Err(format!(
                "[stage=device_camera.deletePortrait code=ERR_PORTRAIT_INVALID_ID] Portrait URI must end with .jpg: \"{trimmed}\""
            ));
        };
        if stem.is_empty()
            || stem.len() > 64
            || !stem
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        {
            return Err(format!(
                "[stage=device_camera.deletePortrait code=ERR_PORTRAIT_INVALID_ID] Invalid portrait stem \"{stem}\""
            ));
        }
        return Ok(portraits_dir.join(file_name));
    }
    if trimmed.is_empty()
        || trimmed.len() > 64
        || !trimmed
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err(format!(
            "[stage=device_camera.deletePortrait code=ERR_PORTRAIT_INVALID_ID] Invalid portraitId \"{trimmed}\""
        ));
    }
    Ok(portraits_dir.join(format!("{trimmed}.jpg")))
}

struct HostInner {
    owned: Mutex<HashMap<String, Arc<Session>>>,
    portraits_dir: Option<PathBuf>,
    host_epoch: AtomicU64,
    closed: AtomicBool,
}

impl HostInner {
    fn close_all(&self, mark_closed: bool) {
        let all: Vec<_> = {
            let mut guard = self.owned.lock().unwrap();
            if mark_closed {
                self.closed.store(true, Ordering::Release);
            }
            self.host_epoch.fetch_add(1, Ordering::AcqRel);
            guard.drain().map(|(_, s)| s).collect()
        };
        for session in all {
            session.close();
        }
    }
}

/// Owns phone front/back camera sessions (`AVCaptureSession` / `Camera2`), portrait cache, and frame capture.
#[class]
pub struct DeviceCameraHost {
    inner: Arc<HostInner>,
}

impl DeviceCameraHost {
    #[cfg(test)]
    fn new_with_portraits_dir(portraits_dir: PathBuf) -> Self {
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            remember_tokio_handle(&handle);
        }
        Self {
            inner: Arc::new(HostInner {
                owned: Mutex::new(HashMap::new()),
                portraits_dir: Some(portraits_dir),
                host_epoch: AtomicU64::new(0),
                closed: AtomicBool::new(false),
            }),
        }
    }
}

#[class]
impl DeviceCameraHost {
    /// Construct an idle host without opening hardware or prompting for camera permission.
    pub fn new(sys: System) -> Self {
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            remember_tokio_handle(&handle);
        }
        Self {
            inner: Arc::new(HostInner {
                owned: Mutex::new(HashMap::new()),
                portraits_dir: sys.data_dir.map(|dir| dir.join("portraits")),
                host_epoch: AtomicU64::new(0),
                closed: AtomicBool::new(false),
            }),
        }
    }

    /// Query OS camera authorization: `"granted" | "denied" | "undetermined" | "unavailable"`.
    pub fn permission(&self) -> String {
        platform::permission()
    }

    /// Explicitly request OS camera authorization off the JS engine thread.
    pub async fn request_permission(this: Instance<Self>) -> Result<String, String> {
        let _ = &this;
        background(async move {
            remember_tokio_handle(&tokio::runtime::Handle::current());
            tokio::task::spawn_blocking(platform::request_permission_blocking)
                .await
                .map_err(|err| format!("[stage=device_camera.requestPermission code=ERR_CAMERA_PERMISSION_JOIN] {err}"))
        })
        .await
        .map_err(|_| "[stage=device_camera.requestPermission code=ERR_CAMERA_PERMISSION_BACKGROUND] Background permission task cancelled".to_string())?
    }

    /// Open a hardware front/back camera session; optional `session_id` rebinds an existing preview slot on foreground resume.
    pub async fn open_session(
        this: Instance<Self>,
        facing: String,
        max_dimension: i32,
        max_fps: i32,
        session_id: String,
    ) -> Result<String, String> {
        let inner = this.with(|s| s.inner.clone());
        let epoch_before = APP_EPOCH.load(Ordering::Acquire);
        let host_epoch = inner.host_epoch.load(Ordering::Acquire);
        if inner.closed.load(Ordering::Acquire) {
            return Err("[stage=device_camera.open code=ERR_DEVICE_CAMERA_CLOSED] DeviceCameraHost is disposed".into());
        }
        if !APP_ACTIVE.load(Ordering::Acquire) {
            return Err("[stage=device_camera.open code=ERR_DEVICE_CAMERA_BACKGROUNDED] Cannot open phone camera while app is in background".into());
        }
        background(async move {
            let runtime = tokio::runtime::Handle::current();
            remember_tokio_handle(&runtime);
            let requested = (!session_id.trim().is_empty()).then_some(session_id);
            let session = tokio::task::spawn_blocking(move || {
                Session::open_platform(runtime, requested.as_deref(), &facing, max_dimension, max_fps)
            })
            .await
            .map_err(|err| format!("[stage=device_camera.open code=ERR_DEVICE_CAMERA_OPEN_JOIN] {err}"))??;

            let id = session.id.clone();
            let prev_session = {
                let mut guard = inner.owned.lock().unwrap();
                if !APP_ACTIVE.load(Ordering::Acquire)
                    || APP_EPOCH.load(Ordering::Acquire) != epoch_before
                {
                    drop(guard);
                    session.close();
                    return Err("[stage=device_camera.open code=ERR_DEVICE_CAMERA_BACKGROUNDED] App entered background during camera open".into());
                }
                if inner.closed.load(Ordering::Acquire)
                    || inner.host_epoch.load(Ordering::Acquire) != host_epoch
                {
                    drop(guard);
                    session.close();
                    return Err("[stage=device_camera.open code=ERR_DEVICE_CAMERA_CLOSED] DeviceCameraHost stopped during camera open".into());
                }
                guard.insert(id.clone(), session)
            };
            if let Some(prev) = prev_session {
                prev.close();
            }
            Ok(id)
        })
        .await
        .map_err(|_| "[stage=device_camera.open code=ERR_DEVICE_CAMERA_OPEN_CANCELLED] Camera open task cancelled".to_string())?
    }

    /// Open a deterministic baseline-JPEG diagnostic stream using the identical session & `Uint8Array` bridge.
    pub async fn open_sample(
        this: Instance<Self>,
        facing: String,
        max_dimension: i32,
        max_fps: i32,
        session_id: String,
    ) -> Result<String, String> {
        let inner = this.with(|s| s.inner.clone());
        if !APP_ACTIVE.load(Ordering::Acquire) {
            return Err("[stage=device_camera.openSample code=ERR_DEVICE_CAMERA_BACKGROUNDED] Cannot open camera sample in background".into());
        }
        background(async move {
            remember_tokio_handle(&tokio::runtime::Handle::current());
            let requested = (!session_id.trim().is_empty()).then_some(session_id);
            let session = Session::open_sample(requested.as_deref(), &facing, max_dimension, max_fps)?;
            let id = session.id.clone();
            if let Some(prev) = inner.owned.lock().unwrap().insert(id.clone(), session) {
                prev.close();
            }
            Ok(id)
        })
        .await
        .map_err(|_| "[stage=device_camera.openSample code=ERR_DEVICE_CAMERA_OPEN_CANCELLED] Sample open cancelled".to_string())?
    }

    /// Dynamically adjust hardware resolution ceiling and frame-rate cap on an active session.
    pub fn reconfigure_session(
        &self,
        session_id: String,
        max_dimension: i32,
        max_fps: i32,
    ) -> Result<(), String> {
        let session = self
            .inner
            .owned
            .lock()
            .unwrap()
            .get(&session_id)
            .cloned()
            .ok_or_else(|| format!("[stage=device_camera.reconfigure code=ERR_DEVICE_CAMERA_SESSION_MISSING] Unknown session \"{session_id}\""))?;
        session.reconfigure(max_dimension, max_fps)
    }

    /// Read current JSON status for a session (`frames`, `width`, `height`, `displayed`, `closed`, `failure`).
    pub fn status(&self, session_id: String) -> Result<String, String> {
        self.inner
            .owned
            .lock()
            .unwrap()
            .get(&session_id)
            .map(|s| s.status_json().to_string())
            .ok_or_else(|| format!("[stage=device_camera.status code=ERR_DEVICE_CAMERA_SESSION_MISSING] Unknown session \"{session_id}\""))
    }

    /// Capture the latest (or next after `after_seq`) downscaled JPEG frame as a JS `Uint8Array`.
    pub async fn capture_frame(
        this: Instance<Self>,
        session_id: String,
        max_dimension: i32,
        after_seq: f64,
    ) -> Result<DeviceCameraNativeFrame, String> {
        let session = {
            let inner = this.with(|s| s.inner.clone());
            let guard = inner.owned.lock().unwrap();
            guard
                .get(&session_id)
                .cloned()
                .ok_or_else(|| format!("[stage=device_camera.capture code=ERR_DEVICE_CAMERA_SESSION_MISSING] Unknown session \"{session_id}\""))?
        };
        let min_seq = if after_seq.is_finite() && after_seq > 0.0 {
            after_seq as u64
        } else {
            0
        };
        background(async move { session.capture_frame(max_dimension, min_seq).await })
            .await
            .map_err(|_| "[stage=device_camera.capture code=ERR_DEVICE_CAMERA_CAPTURE_CANCELLED] Frame capture cancelled".to_string())?
    }

    /// Capture lightweight metadata + hardware face bounds without JPEG encoding overhead.
    pub async fn capture_faces(
        this: Instance<Self>,
        session_id: String,
        after_seq: f64,
    ) -> Result<DeviceCameraNativeFacesFrame, String> {
        let session = {
            let inner = this.with(|s| s.inner.clone());
            let guard = inner.owned.lock().unwrap();
            guard
                .get(&session_id)
                .cloned()
                .ok_or_else(|| format!("[stage=device_camera.captureFaces code=ERR_DEVICE_CAMERA_SESSION_MISSING] Unknown session \"{session_id}\""))?
        };
        let min_seq = if after_seq.is_finite() && after_seq > 0.0 {
            after_seq as u64
        } else {
            0
        };
        background(async move { session.capture_faces(min_seq).await })
            .await
            .map_err(|_| "[stage=device_camera.captureFaces code=ERR_DEVICE_CAMERA_CAPTURE_CANCELLED] Faces capture cancelled".to_string())?
    }

    /// Crop a normalized `[0, 1]` top-left box from the active frame and persist JPEG to `<sys.data_dir>/portraits/*.jpg`.
    pub async fn capture_cropped_portrait(
        this: Instance<Self>,
        session_id: String,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
        portrait_id: String,
        max_dimension: i32,
        jpeg_quality: i32,
    ) -> Result<DeviceCameraNativePortrait, String> {
        if !x.is_finite()
            || !y.is_finite()
            || !width.is_finite()
            || !height.is_finite()
            || width <= 0.0
            || height <= 0.0
        {
            return Err("[stage=device_camera.captureCroppedPortrait code=ERR_PORTRAIT_INVALID_RECT] Crop rect requires positive finite width and height".into());
        }
        let validated_id = validate_portrait_id(&portrait_id)?;
        let (session, portraits_dir) = this.with(|s| {
            let dir = s.inner.portraits_dir.clone().ok_or_else(|| {
                "[stage=device_camera.captureCroppedPortrait code=ERR_PORTRAIT_STORAGE_UNAVAILABLE] Private app data directory is unavailable"
                    .to_string()
            })?;
            let guard = s.inner.owned.lock().unwrap();
            let sess = guard
                .get(&session_id)
                .cloned()
                .ok_or_else(|| format!("[stage=device_camera.captureCroppedPortrait code=ERR_DEVICE_CAMERA_SESSION_MISSING] Unknown session \"{session_id}\""))?;
            Ok::<_, String>((sess, dir))
        })?;
        background(async move {
            session
                .capture_cropped_portrait(
                    portraits_dir,
                    x,
                    y,
                    width,
                    height,
                    validated_id,
                    max_dimension,
                    jpeg_quality,
                )
                .await
        })
        .await
        .map_err(|_| "[stage=device_camera.captureCroppedPortrait code=ERR_DEVICE_CAMERA_CAPTURE_CANCELLED] Portrait crop cancelled".to_string())?
    }

    /// Delete a cached portrait JPEG inside `<sys.data_dir>/portraits/` by `portraitId` or `file://` URI.
    pub fn delete_portrait(&self, portrait_id_or_uri: String) -> Result<bool, String> {
        let Some(ref dir) = self.inner.portraits_dir else {
            return Err("[stage=device_camera.deletePortrait code=ERR_PORTRAIT_STORAGE_UNAVAILABLE] Private app data directory is unavailable".into());
        };
        let target = resolve_portrait_path(dir, &portrait_id_or_uri)?;
        match fs::remove_file(&target) {
            Ok(()) => Ok(true),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(err) => Err(format!(
                "[stage=device_camera.deletePortrait code=ERR_PORTRAIT_IO_FAILED] Failed to delete portrait: {err}"
            )),
        }
    }

    /// Query camera landscape horizontal field-of-view in degrees (`0.0` when unavailable).
    pub fn camera_hfov_deg(&self, facing: String) -> f64 {
        platform::query_hfov(&facing)
    }

    /// Close a specific camera session immediately.
    pub fn close_session(&self, session_id: String) {
        if let Some(session) = self.inner.owned.lock().unwrap().remove(&session_id) {
            session.close();
        }
    }

    /// Synchronize app foreground/background state; backgrounding immediately closes all active camera sessions.
    pub fn set_foreground(&self, active: bool) {
        handle_platform_foreground_change(active);
        if !active {
            self.inner.close_all(false);
        }
    }

    /// Force-close all owned camera sessions.
    pub fn stop_all(&self) {
        self.inner.close_all(false);
    }
}

impl Drop for DeviceCameraHost {
    fn drop(&mut self) {
        self.inner.close_all(true);
    }
}

#[cfg(target_os = "ios")]
#[unsafe(no_mangle)]
pub extern "C" fn looi_device_camera_background() {
    handle_platform_foreground_change(false);
}

#[cfg(target_os = "ios")]
#[unsafe(no_mangle)]
pub extern "C" fn looi_device_camera_foreground() {
    handle_platform_foreground_change(true);
}

#[cfg(test)]
mod tests {
    use super::*;

    static FOREGROUND_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    #[tokio::test]
    async fn sample_session_streams_downscaled_jpegs_and_tears_down_on_background() {
        let _guard = FOREGROUND_TEST_LOCK.lock().await;
        handle_platform_foreground_change(true);
        let session = Session::open_sample(Some("cam-test-1"), "front", 640, 25).unwrap();
        assert_eq!(session.id, "cam-test-1");

        let frame1 = session.clone().capture_frame(640, 0).await.unwrap();
        assert_eq!(frame1.facing, "front");
        assert_eq!(frame1.width, 640);
        assert_eq!(frame1.height, 360);
        assert_eq!(&frame1.jpeg[0..2], &[0xFF, 0xD8]);
        assert_eq!(&frame1.jpeg[frame1.jpeg.len() - 2..], &[0xFF, 0xD9]);
        assert_eq!(frame1.faces.len(), 1);
        assert_eq!(frame1.faces[0].track_id, 1);
        assert!((-1.0..=1.0).contains(&frame1.faces[0].offset_x));
        assert!((-1.0..=1.0).contains(&frame1.faces[0].offset_y));
        assert!((0.0..=1.0).contains(&frame1.faces[0].width));
        assert!((0.0..=1.0).contains(&frame1.faces[0].height));

        let back_session = Session::open_sample(Some("cam-test-back"), "back", 640, 25).unwrap();
        let back_frame = back_session.clone().capture_frame(640, 0).await.unwrap();
        assert!(back_frame.faces.is_empty());
        back_session.close();

        // Downscaled request on the same session respects smaller max_dimension
        let thumb = session.clone().capture_frame(320, 0).await.unwrap();
        assert_eq!(thumb.width, 320);
        assert_eq!(thumb.height, 184);

        // Waiting for next frame sequence advances monotonically
        let frame2 = session
            .clone()
            .capture_frame(640, frame1.seq as u64)
            .await
            .unwrap();
        assert!(frame2.seq > frame1.seq);

        // App backgrounding immediately closes active sessions
        handle_platform_foreground_change(false);
        assert!(session.closed.load(Ordering::Acquire));
        let bg_err = session.clone().capture_frame(640, 0).await.err().unwrap();
        assert!(bg_err.contains("ERR_DEVICE_CAMERA_CLOSED"));
        handle_platform_foreground_change(true);
    }

    #[tokio::test]
    async fn reopening_same_session_id_after_background_preserves_registry_across_late_drop() {
        let _guard = FOREGROUND_TEST_LOCK.lock().await;
        handle_platform_foreground_change(true);
        let stale_session = Session::open_sample(Some("preview-rebind-1"), "front", 640, 20).unwrap();
        assert!(Arc::ptr_eq(
            &lookup_session("preview-rebind-1").unwrap(),
            &stale_session
        ));

        // Background closes stale_session, then foreground opens a new Session with the SAME id
        // while `stale_session` is still held by an in-flight observer/capture task.
        handle_platform_foreground_change(false);
        assert!(stale_session.closed.load(Ordering::Acquire));
        handle_platform_foreground_change(true);

        let resumed_session =
            Session::open_sample(Some("preview-rebind-1"), "front", 640, 20).unwrap();
        assert!(!Arc::ptr_eq(&stale_session, &resumed_session));

        // Dropping the stale Arc<Session> MUST NOT clobber the newly registered session in `sessions()`.
        drop(stale_session);

        let resolved = lookup_session("preview-rebind-1")
            .expect("resumed session must remain registered in sessions() after late stale drop");
        assert!(Arc::ptr_eq(&resolved, &resumed_session));
        assert!(!resolved.closed.load(Ordering::Acquire));
        resumed_session.close();
    }

    #[test]
    fn format_backend_error_preserves_stage_and_err_code_prefix() {
        let formatted = format_backend_error(
            "native.ios.open",
            "ERR_DEVICE_CAMERA_OPEN_FAILED",
            "ERR_DEVICE_CAMERA_NO_DEVICE: Camera lens (front) unavailable",
        );
        assert_eq!(
            formatted,
            "[stage=native.ios.open code=ERR_DEVICE_CAMERA_NO_DEVICE] Camera lens (front) unavailable"
        );
    }

    #[tokio::test]
    async fn capture_faces_portrait_disk_cache_and_delete_portrait_work() {
        let _guard = FOREGROUND_TEST_LOCK.lock().await;
        handle_platform_foreground_change(true);
        let temp_root = std::env::temp_dir().join(format!(
            "looi-portrait-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        let portraits_dir = temp_root.join("portraits");
        let host = DeviceCameraHost::new_with_portraits_dir(portraits_dir.clone());

        let session_id = "cam-portrait-test-1".to_string();
        let session = Session::open_sample(Some(&session_id), "front", 640, 25).unwrap();
        host.inner
            .owned
            .lock()
            .unwrap()
            .insert(session_id.clone(), session.clone());

        let faces_frame = session.clone().capture_faces(0).await.unwrap();
        assert_eq!(faces_frame.facing, "front");
        assert_eq!(faces_frame.faces.len(), 1);
        assert!(faces_frame.hfov_deg > 0.0);
        assert!(faces_frame.captured_monotonic_ms > 0.0);
        assert!(faces_frame.faces_monotonic_ms > 0.0);

        let portrait = session
            .clone()
            .capture_cropped_portrait(
                portraits_dir.clone(),
                0.15,
                0.1,
                0.7,
                0.8,
                "seat_1".to_string(),
                320,
                84,
            )
            .await
            .unwrap();
        let expected_path = portraits_dir.join("seat_1.jpg");
        assert!(portrait.uri.starts_with("file://"));
        assert!(portrait.uri.ends_with("seat_1.jpg"));
        assert!(expected_path.is_file());
        let saved_bytes = fs::read(&expected_path).unwrap();
        assert_eq!(saved_bytes.len() as u32, portrait.byte_length);
        assert_eq!(&saved_bytes[0..2], &[0xFF, 0xD8]);

        // Path traversal must be rejected cleanly
        let bad_id = validate_portrait_id("../escape").err().unwrap();
        assert!(bad_id.contains("ERR_PORTRAIT_INVALID_ID"));
        let bad_del = host
            .delete_portrait(format!("file://{}/../escape.jpg", portraits_dir.display()))
            .err()
            .unwrap();
        assert!(bad_del.contains("ERR_PORTRAIT_INVALID_ID"));

        assert_eq!(host.delete_portrait(portrait.uri.clone()).unwrap(), true);
        assert!(!expected_path.exists());
        assert_eq!(host.delete_portrait("seat_1".to_string()).unwrap(), false);

        host.stop_all();
        let _ = fs::remove_dir_all(&temp_root);
    }
}
