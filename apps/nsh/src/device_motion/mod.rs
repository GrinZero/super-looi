//! App-owned magnetometer-free 6-axis IMU heading host (`DeviceMotionHost`) and gravity-axis twist integrator.

use crate::host_monotonic_ms;
use nsh_core::prelude::*;
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::sync::Notify;

#[cfg(target_os = "android")]
mod android;
#[cfg(target_os = "ios")]
mod ios;

#[cfg(target_os = "android")]
use android as platform;
#[cfg(target_os = "ios")]
use ios as platform;

#[cfg(not(any(target_os = "ios", target_os = "android")))]
mod platform {
    use super::MotionSessionSink;

    pub fn availability() -> String {
        "unavailable".to_string()
    }

    pub struct PlatformSession;

    impl PlatformSession {
        pub fn start(_rate_hz: i32, _sink: MotionSessionSink) -> Result<Self, String> {
            Err("[stage=native.desktop.motion.open code=ERR_DEVICE_MOTION_UNAVAILABLE] Hardware IMU requires iOS or Android".into())
        }

        pub fn close(&mut self) {}
    }
}

static APP_ACTIVE: AtomicBool = AtomicBool::new(true);
static APP_EPOCH: AtomicU64 = AtomicU64::new(0);

#[allow(dead_code)]
pub(super) fn format_motion_error(stage: &str, default_code: &str, detail: &str) -> String {
    let trimmed = detail.trim();
    if trimmed.starts_with("[stage=") {
        return trimmed.to_owned();
    }
    if let Some(rest) = trimmed.strip_prefix("ERR_") {
        let split_at = rest
            .find(|c: char| !(c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_'))
            .unwrap_or(rest.len());
        let code = format!("ERR_{}", &rest[..split_at]);
        let reason = rest[split_at..].trim_start_matches([':', ' ']).trim();
        return format!(
            "[stage={stage} code={code}] {}",
            if reason.is_empty() { trimmed } else { reason }
        );
    }
    format!("[stage={stage} code={default_code}] {trimmed}")
}

/// Wraps an arbitrary angle in degrees into `[-180.0, 180.0)`.
pub fn wrap_signed_deg(deg: f64) -> f64 {
    if !deg.is_finite() {
        return 0.0;
    }
    let mut wrapped = (deg + 180.0).rem_euclid(360.0) - 180.0;
    if wrapped == 180.0 {
        wrapped = -180.0;
    }
    wrapped
}

/// Computes world-vertical (+Z) angular rate and device pitch/roll from calibrated gyroscope and gravity vectors.
pub fn integrate_gyro_gravity_delta(
    gyro_rad_s: [f64; 3],
    gravity_up: [f64; 3],
    dt_sec: f64,
) -> Option<(f64, f64, f64)> {
    if !dt_sec.is_finite()
        || dt_sec <= 0.0
        || gyro_rad_s.iter().any(|v| !v.is_finite())
        || gravity_up.iter().any(|v| !v.is_finite())
    {
        return None;
    }
    let norm_sq = gravity_up[0] * gravity_up[0]
        + gravity_up[1] * gravity_up[1]
        + gravity_up[2] * gravity_up[2];
    if norm_sq <= 1e-6 {
        return None;
    }
    let inv = 1.0 / norm_sq.sqrt();
    let ux = gravity_up[0] * inv;
    let uy = gravity_up[1] * inv;
    let uz = gravity_up[2] * inv;

    let omega_ccw = gyro_rad_s[0] * ux + gyro_rad_s[1] * uy + gyro_rad_s[2] * uz;
    let delta_deg = -(omega_ccw * dt_sec).to_degrees();
    let pitch_deg = uy.clamp(-1.0, 1.0).asin().to_degrees();
    let roll_deg = (-ux).atan2(uz).to_degrees();
    Some((delta_deg, pitch_deg, roll_deg))
}

/// Accumulates clockwise horizontal rotation around World +Z (gravity axis) from unit quaternions `[w, x, y, z]`.
#[derive(Debug, Clone)]
pub struct HeadingAccumulator {
    prev_q: Option<[f64; 4]>,
    heading_deg: f64,
}

impl Default for HeadingAccumulator {
    fn default() -> Self {
        Self::new()
    }
}

impl HeadingAccumulator {
    pub fn new() -> Self {
        Self {
            prev_q: None,
            heading_deg: 0.0,
        }
    }

    pub fn heading_deg(&self) -> f64 {
        self.heading_deg
    }

    /// Re-anchors the accumulated heading to `anchor_heading_deg` while keeping `prev_q` continuous.
    pub fn reset(&mut self, anchor_heading_deg: f64) {
        self.heading_deg = if anchor_heading_deg.is_finite() {
            anchor_heading_deg
        } else {
            0.0
        };
    }

    /// Push a world-frame `[w, x, y, z]` quaternion; returns `(heading_deg, delta_deg, unit_q, pitch_deg, roll_deg)`.
    pub fn update(&mut self, raw_q: [f64; 4]) -> Option<(f64, f64, [f64; 4], f64, f64)> {
        if raw_q.iter().any(|v| !v.is_finite()) {
            return None;
        }
        let norm_sq =
            raw_q[0] * raw_q[0] + raw_q[1] * raw_q[1] + raw_q[2] * raw_q[2] + raw_q[3] * raw_q[3];
        if norm_sq <= 1e-12 {
            return None;
        }
        let inv = 1.0 / norm_sq.sqrt();
        let q = [
            raw_q[0] * inv,
            raw_q[1] * inv,
            raw_q[2] * inv,
            raw_q[3] * inv,
        ];
        let [w2, x2, y2, z2] = q;

        let mut delta_deg = 0.0;
        if let Some([w1, x1, y1, z1]) = self.prev_q {
            // World-frame delta quaternion: dq = q * prev_q^-1
            let mut dw = w2 * w1 + x2 * x1 + y2 * y1 + z2 * z1;
            let mut dz = -w2 * z1 + w1 * z2 - x2 * y1 + y2 * x1;
            if dw < 0.0 {
                dw = -dw;
                dz = -dz;
            }
            if dw != 0.0 || dz != 0.0 {
                let ccw_rad = 2.0 * dz.atan2(dw);
                delta_deg = -ccw_rad.to_degrees();
                self.heading_deg += delta_deg;
            }
        }
        self.prev_q = Some(q);

        // Rotate World +Z into device frame via q^-1 * (0, 0, 1) * q
        let ux = 2.0 * (x2 * z2 - w2 * y2);
        let uy = 2.0 * (y2 * z2 + w2 * x2);
        let uz = 1.0 - 2.0 * (x2 * x2 + y2 * y2);
        let pitch_deg = uy.clamp(-1.0, 1.0).asin().to_degrees();
        let roll_deg = (-ux).atan2(uz).to_degrees();

        Some((self.heading_deg, delta_deg, q, pitch_deg, roll_deg))
    }
}

#[derive(Clone, Debug, JsObject)]
pub struct DeviceMotionNativeSample {
    pub seq: f64,
    pub heading_deg: f64,
    pub delta_deg: f64,
    pub yaw_deg: f64,
    pub pitch_deg: f64,
    pub roll_deg: f64,
    pub qw: f64,
    pub qx: f64,
    pub qy: f64,
    pub qz: f64,
    pub monotonic_ms: f64,
    pub sensor_kind: String,
    pub accuracy: i32,
}

impl Default for DeviceMotionNativeSample {
    fn default() -> Self {
        Self {
            seq: 0.0,
            heading_deg: 0.0,
            delta_deg: 0.0,
            yaw_deg: 0.0,
            pitch_deg: 0.0,
            roll_deg: 0.0,
            qw: 1.0,
            qx: 0.0,
            qy: 0.0,
            qz: 0.0,
            monotonic_ms: 0.0,
            sensor_kind: String::new(),
            accuracy: 0,
        }
    }
}

struct SessionState {
    status: String,
    acc: HeadingAccumulator,
    latest: Option<DeviceMotionNativeSample>,
    seq: u64,
    failure: Option<String>,
    closed: bool,
}

pub struct MotionSessionSink {
    inner: Arc<SessionInner>,
}

struct SessionInner {
    #[allow(dead_code)]
    id: String,
    state: Mutex<SessionState>,
    notify: Notify,
    backend: Mutex<Option<platform::PlatformSession>>,
}

impl MotionSessionSink {
    pub fn push_quaternion(
        &self,
        raw_q: [f64; 4],
        monotonic_ms: f64,
        sensor_kind: &str,
        accuracy: i32,
    ) -> Option<DeviceMotionNativeSample> {
        let mut st = self.inner.state.lock().unwrap();
        if st.closed {
            return None;
        }
        let (heading_deg, delta_deg, q, pitch_deg, roll_deg) = st.acc.update(raw_q)?;
        st.seq += 1;
        st.status = "streaming".to_string();
        let sample = DeviceMotionNativeSample {
            seq: st.seq as f64,
            heading_deg,
            delta_deg,
            yaw_deg: wrap_signed_deg(heading_deg),
            pitch_deg,
            roll_deg,
            qw: q[0],
            qx: q[1],
            qy: q[2],
            qz: q[3],
            monotonic_ms,
            sensor_kind: sensor_kind.to_string(),
            accuracy,
        };
        st.latest = Some(sample.clone());
        drop(st);
        self.inner.notify.notify_waiters();
        Some(sample)
    }

    #[allow(dead_code)]
    pub fn push_gyro_step(
        &self,
        gyro_rad_s: [f64; 3],
        gravity_up: [f64; 3],
        dt_sec: f64,
        monotonic_ms: f64,
        sensor_kind: &str,
        accuracy: i32,
    ) -> Option<DeviceMotionNativeSample> {
        let (delta_deg, pitch_deg, roll_deg) =
            integrate_gyro_gravity_delta(gyro_rad_s, gravity_up, dt_sec)?;
        let mut st = self.inner.state.lock().unwrap();
        if st.closed {
            return None;
        }
        let next_heading = st.acc.heading_deg() + delta_deg;
        st.acc.reset(next_heading);
        st.seq += 1;
        st.status = "streaming".to_string();
        let half_rad = (-next_heading.to_radians()) * 0.5;
        let sample = DeviceMotionNativeSample {
            seq: st.seq as f64,
            heading_deg: next_heading,
            delta_deg,
            yaw_deg: wrap_signed_deg(next_heading),
            pitch_deg,
            roll_deg,
            qw: half_rad.cos(),
            qx: 0.0,
            qy: 0.0,
            qz: half_rad.sin(),
            monotonic_ms,
            sensor_kind: sensor_kind.to_string(),
            accuracy,
        };
        st.latest = Some(sample.clone());
        drop(st);
        self.inner.notify.notify_waiters();
        Some(sample)
    }

    #[allow(dead_code)]
    pub fn fail(&self, stage: &str, code: &str, reason: &str) {
        let mut st = self.inner.state.lock().unwrap();
        st.status = "error".to_string();
        st.failure = Some(format_motion_error(stage, code, reason));
        drop(st);
        self.inner.notify.notify_waiters();
    }
}

impl SessionInner {
    fn new(id: String, initial_status: &str) -> Arc<Self> {
        Arc::new(Self {
            id,
            state: Mutex::new(SessionState {
                status: initial_status.to_string(),
                acc: HeadingAccumulator::new(),
                latest: None,
                seq: 0,
                failure: None,
                closed: false,
            }),
            notify: Notify::new(),
            backend: Mutex::new(None),
        })
    }

    fn close_with_status(&self, status: &str) {
        {
            let mut st = self.state.lock().unwrap();
            st.closed = true;
            st.status = status.to_string();
        }
        if let Some(mut backend) = self.backend.lock().unwrap().take() {
            backend.close();
        }
        self.notify.notify_waiters();
    }
}

struct HostInner {
    owned: Mutex<HashMap<String, Arc<SessionInner>>>,
    host_epoch: AtomicU64,
    closed: AtomicBool,
}

impl HostInner {
    fn close_all_with_status(&self, status: &str, mark_closed: bool) {
        let all: Vec<_> = {
            let mut guard = self.owned.lock().unwrap();
            if mark_closed {
                self.closed.store(true, Ordering::Release);
            }
            self.host_epoch.fetch_add(1, Ordering::AcqRel);
            guard.drain().map(|(_, s)| s).collect()
        };
        for session in all {
            session.close_with_status(status);
        }
    }
}

/// App-owned IMU heading tracker (`ASENSOR_TYPE_GAME_ROTATION_VECTOR` / `CMMotionManager`) exposed to QuickJS.
#[class]
pub struct DeviceMotionHost {
    inner: Arc<HostInner>,
}

#[class]
impl DeviceMotionHost {
    /// Construct an idle host without starting hardware sensors.
    pub fn new() -> Self {
        Self {
            inner: Arc::new(HostInner {
                owned: Mutex::new(HashMap::new()),
                host_epoch: AtomicU64::new(0),
                closed: AtomicBool::new(false),
            }),
        }
    }

    /// Returns `"available"` when a 6-axis magnetometer-free IMU is accessible, otherwise `"unavailable"`.
    pub fn availability(&self) -> String {
        platform::availability()
    }

    /// Start a live IMU heading stream at `rate_hz` (clamped to `[10, 200]`) under `session_id`.
    pub async fn start_session(
        this: Instance<Self>,
        rate_hz: i32,
        session_id: String,
    ) -> Result<String, String> {
        let inner = this.with(|s| s.inner.clone());
        let app_epoch = APP_EPOCH.load(Ordering::Acquire);
        let host_epoch = inner.host_epoch.load(Ordering::Acquire);
        if inner.closed.load(Ordering::Acquire) {
            return Err("[stage=device_motion.start code=ERR_DEVICE_MOTION_CLOSED] DeviceMotionHost is disposed".into());
        }
        if !APP_ACTIVE.load(Ordering::Acquire) {
            return Err("[stage=device_motion.start code=ERR_DEVICE_MOTION_BACKGROUNDED] Cannot start IMU session while app is in background".into());
        }
        let id = if session_id.trim().is_empty() {
            format!("motion-{}", host_monotonic_ms() as u64)
        } else {
            session_id
        };
        let session = SessionInner::new(id.clone(), "starting");
        let sink = MotionSessionSink {
            inner: session.clone(),
        };
        background(async move {
            let mut backend = tokio::task::spawn_blocking(move || platform::PlatformSession::start(rate_hz, sink))
                .await
                .map_err(|err| format!("[stage=device_motion.start code=ERR_DEVICE_MOTION_JOIN] {err}"))??;

            let prev_session = {
                let mut guard = inner.owned.lock().unwrap();
                if !APP_ACTIVE.load(Ordering::Acquire) || APP_EPOCH.load(Ordering::Acquire) != app_epoch {
                    drop(guard);
                    backend.close();
                    return Err("[stage=device_motion.start code=ERR_DEVICE_MOTION_BACKGROUNDED] App entered background during IMU startup".into());
                }
                if inner.closed.load(Ordering::Acquire) || inner.host_epoch.load(Ordering::Acquire) != host_epoch {
                    drop(guard);
                    backend.close();
                    return Err("[stage=device_motion.start code=ERR_DEVICE_MOTION_CLOSED] DeviceMotionHost stopped during IMU startup".into());
                }
                *session.backend.lock().unwrap() = Some(backend);
                {
                    let mut st = session.state.lock().unwrap();
                    if !st.closed && st.status == "starting" {
                        st.status = "streaming".to_string();
                    }
                }
                guard.insert(id.clone(), session)
            };
            if let Some(prev) = prev_session {
                prev.close_with_status("stopped");
            }
            Ok(id)
        })
        .await
        .map_err(|_| "[stage=device_motion.start code=ERR_DEVICE_MOTION_CANCELLED] IMU start cancelled".to_string())?
    }

    /// Opens an isolated sample IMU session for headless tests without hardware sensors.
    pub async fn start_sample(
        this: Instance<Self>,
        _rate_hz: i32,
        session_id: String,
    ) -> Result<String, String> {
        if !APP_ACTIVE.load(Ordering::Acquire) {
            return Err("[stage=device_motion.startSample code=ERR_DEVICE_MOTION_BACKGROUNDED] Cannot start sample IMU session while app is in background".into());
        }
        let inner = this.with(|s| s.inner.clone());
        let id = if session_id.trim().is_empty() {
            format!("motion-sample-{}", host_monotonic_ms() as u64)
        } else {
            session_id
        };
        let session = SessionInner::new(id.clone(), "streaming");
        let sink = MotionSessionSink {
            inner: session.clone(),
        };
        sink.push_quaternion([1.0, 0.0, 0.0, 0.0], host_monotonic_ms(), "sample", 3);
        if let Some(prev) = inner.owned.lock().unwrap().insert(id.clone(), session) {
            prev.close_with_status("stopped");
        }
        Ok(id)
    }

    /// Read current IMU session lifecycle state (`"idle" | "starting" | "streaming" | "paused_background" | "stopped" | "error"`).
    pub fn status(&self, session_id: String) -> Result<String, String> {
        let guard = self.inner.owned.lock().unwrap();
        let Some(session) = guard.get(&session_id) else {
            return Ok("idle".to_string());
        };
        Ok(session.state.lock().unwrap().status.clone())
    }

    /// Returns the latest sample (`seq == 0.0` sentinel if no hardware sample has arrived yet).
    pub fn latest_sample(&self, session_id: String) -> Result<DeviceMotionNativeSample, String> {
        let session = self
            .inner
            .owned
            .lock()
            .unwrap()
            .get(&session_id)
            .cloned()
            .ok_or_else(|| format!("[stage=device_motion.latest code=ERR_DEVICE_MOTION_SESSION_NOT_FOUND] Unknown IMU session \"{session_id}\""))?;
        let st = session.state.lock().unwrap();
        if let Some(err) = &st.failure {
            return Err(err.clone());
        }
        Ok(st.latest.clone().unwrap_or_default())
    }

    /// Wait asynchronously for the next IMU sample with `seq > after_seq`.
    pub async fn read_next_sample(
        this: Instance<Self>,
        session_id: String,
        after_seq: f64,
    ) -> Result<DeviceMotionNativeSample, String> {
        let session = {
            let inner = this.with(|s| s.inner.clone());
            let guard = inner.owned.lock().unwrap();
            guard
                .get(&session_id)
                .cloned()
                .ok_or_else(|| format!("[stage=device_motion.read code=ERR_DEVICE_MOTION_SESSION_NOT_FOUND] Unknown IMU session \"{session_id}\""))?
        };
        let min_seq = if after_seq.is_finite() && after_seq > 0.0 {
            after_seq as u64
        } else {
            0
        };
        background(async move {
            let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
            loop {
                if !APP_ACTIVE.load(Ordering::Acquire) {
                    return Err("[stage=device_motion.read code=ERR_DEVICE_MOTION_BACKGROUNDED] IMU paused while app is in background".into());
                }
                {
                    let st = session.state.lock().unwrap();
                    if let Some(err) = &st.failure {
                        return Err(err.clone());
                    }
                    if st.closed {
                        return Err("[stage=device_motion.read code=ERR_DEVICE_MOTION_CLOSED] IMU session stopped".into());
                    }
                    if st.seq > min_seq {
                        if let Some(sample) = &st.latest {
                            return Ok(sample.clone());
                        }
                    }
                }
                let now = tokio::time::Instant::now();
                if now >= deadline {
                    return Err("[stage=device_motion.read code=ERR_DEVICE_MOTION_TIMEOUT] Timed out waiting for next IMU sample".into());
                }
                let remaining = (deadline - now).min(Duration::from_millis(100));
                let _ = tokio::time::timeout(remaining, session.notify.notified()).await;
            }
        })
        .await
        .map_err(|_| "[stage=device_motion.read code=ERR_DEVICE_MOTION_CANCELLED] IMU read cancelled".to_string())?
    }

    /// Re-anchor accumulated heading degrees to `heading_deg` while keeping quaternion tracking continuous.
    pub fn reset_heading(
        &self,
        session_id: String,
        heading_deg: f64,
    ) -> Result<DeviceMotionNativeSample, String> {
        let session = self
            .inner
            .owned
            .lock()
            .unwrap()
            .get(&session_id)
            .cloned()
            .ok_or_else(|| format!("[stage=device_motion.resetHeading code=ERR_DEVICE_MOTION_SESSION_NOT_FOUND] Unknown IMU session \"{session_id}\""))?;
        let anchor = if heading_deg.is_finite() { heading_deg } else { 0.0 };
        let mut st = session.state.lock().unwrap();
        st.acc.reset(anchor);
        let updated = if let Some(ref mut latest) = st.latest {
            latest.heading_deg = anchor;
            latest.delta_deg = 0.0;
            latest.yaw_deg = wrap_signed_deg(anchor);
            latest.clone()
        } else {
            DeviceMotionNativeSample {
                heading_deg: anchor,
                yaw_deg: wrap_signed_deg(anchor),
                ..Default::default()
            }
        };
        Ok(updated)
    }

    /// Inject a unit world-frame quaternion `[qw, qx, qy, qz]` into an active sample IMU session.
    pub fn push_sample_quaternion(
        &self,
        session_id: String,
        qw: f64,
        qx: f64,
        qy: f64,
        qz: f64,
        monotonic_ms: f64,
    ) -> Result<DeviceMotionNativeSample, String> {
        let session = self
            .inner
            .owned
            .lock()
            .unwrap()
            .get(&session_id)
            .cloned()
            .ok_or_else(|| format!("[stage=device_motion.pushSample code=ERR_DEVICE_MOTION_SESSION_NOT_FOUND] Unknown IMU session \"{session_id}\""))?;
        let ts = if monotonic_ms.is_finite() && monotonic_ms > 0.0 {
            monotonic_ms
        } else {
            host_monotonic_ms()
        };
        let sink = MotionSessionSink { inner: session };
        sink.push_quaternion([qw, qx, qy, qz], ts, "sample", 3).ok_or_else(|| {
            "[stage=device_motion.pushSample code=ERR_DEVICE_MOTION_INVALID_SAMPLE] Rejected invalid quaternion sample or closed session"
                .into()
        })
    }

    /// Stop and release a specific IMU session immediately.
    pub fn stop_session(&self, session_id: String) {
        if let Some(session) = self.inner.owned.lock().unwrap().remove(&session_id) {
            session.close_with_status("stopped");
        }
    }

    /// Synchronize foreground/background lifecycle state; backgrounding stops active IMU polling threads.
    pub fn set_foreground(&self, active: bool) {
        let prev = APP_ACTIVE.swap(active, Ordering::AcqRel);
        if prev != active || !active {
            APP_EPOCH.fetch_add(1, Ordering::AcqRel);
        }
        if !active {
            self.inner.close_all_with_status("paused_background", false);
        }
    }

    /// Stop all active IMU sessions owned by this host.
    pub fn stop_all(&self) {
        self.inner.close_all_with_status("stopped", false);
    }
}

impl Drop for DeviceMotionHost {
    fn drop(&mut self) {
        self.inner.close_all_with_status("stopped", true);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f64::consts::PI;

    fn q_mul(a: [f64; 4], b: [f64; 4]) -> [f64; 4] {
        [
            a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
            a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
            a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
            a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
        ]
    }

    fn q_axis_angle(axis: [f64; 3], deg: f64) -> [f64; 4] {
        let half = (deg * PI / 180.0) * 0.5;
        let s = half.sin();
        [half.cos(), axis[0] * s, axis[1] * s, axis[2] * s]
    }

    #[test]
    fn accumulates_pure_cw_and_ccw_yaw_across_full_turns() {
        let mut acc = HeadingAccumulator::new();
        let mut angle_cw = 0.0_f64;
        // Rotate 720 deg CW around World +Z (CCW angle = -angle_cw) in 30 deg steps
        for step in 0..=24 {
            angle_cw = (step as f64) * 30.0;
            let q = q_axis_angle([0.0, 0.0, 1.0], -angle_cw);
            let res = acc.update(q).unwrap();
            assert!((res.0 - angle_cw).abs() < 1e-6, "step {step}: got {}", res.0);
        }
        assert!((acc.heading_deg() - 720.0).abs() < 1e-6);

        // Rotate back CCW by 150 deg (across 180 boundary & dw < 0 branch)
        let q_back = q_axis_angle([0.0, 0.0, 1.0], -(angle_cw - 150.0));
        let res = acc.update(q_back).unwrap();
        assert!((res.0 - 570.0).abs() < 1e-6, "got {}", res.0);
    }

    #[test]
    fn tilted_landscape_phone_isolates_head_pitch_and_extracts_exact_world_yaw() {
        for pitch in [25.0_f64, 60.0, 85.0] {
            let mut acc = HeadingAccumulator::new();
            let q_pitch0 = q_axis_angle([1.0, 0.0, 0.0], pitch);
            acc.update(q_pitch0).unwrap();

            // Sweep head pitch wildly (25 -> 85 -> 30) while base stays stationary
            for tilt in [85.0_f64, 30.0, pitch] {
                let q_tilt = q_axis_angle([1.0, 0.0, 0.0], tilt);
                let (_, delta, _, _, _) = acc.update(q_tilt).unwrap();
                assert!(delta.abs() < 1e-6, "pitch-only delta leaked: {delta}");
            }

            // Now rotate base 45 deg clockwise around World +Z while pitching head +20 deg simultaneously
            let q_yaw = q_axis_angle([0.0, 0.0, 1.0], -45.0);
            let q_new_pitch = q_axis_angle([1.0, 0.0, 0.0], (pitch + 20.0).min(89.0));
            let q_combined = q_mul(q_yaw, q_new_pitch);
            let (heading, delta, _, pitch_out, _) = acc.update(q_combined).unwrap();
            assert!((heading - 45.0).abs() < 1e-6, "pitch={pitch} got heading={heading}");
            assert!((delta - 45.0).abs() < 1e-6, "pitch={pitch} got delta={delta}");
            assert!((pitch_out - (pitch + 20.0).min(89.0)).abs() < 1e-5);
        }
    }

    #[test]
    fn reset_heading_preserves_quaternion_continuity() {
        let mut acc = HeadingAccumulator::new();
        acc.update(q_axis_angle([0.0, 0.0, 1.0], -35.0)).unwrap();
        acc.update(q_axis_angle([0.0, 0.0, 1.0], -75.0)).unwrap();
        assert!((acc.heading_deg() - 40.0).abs() < 1e-6);

        acc.reset(0.0);
        let (heading, delta, _, _, _) = acc.update(q_axis_angle([0.0, 0.0, 1.0], -100.0)).unwrap();
        assert!((delta - 25.0).abs() < 1e-6);
        assert!((heading - 25.0).abs() < 1e-6);
    }

    #[test]
    fn gyro_gravity_fallback_projects_onto_world_up_at_tilt() {
        // Phone pitched 60 deg back: gravity_up in device frame = [0, sin(60), cos(60)]
        let pitch_rad = 60.0_f64.to_radians();
        let gravity_up = [0.0, pitch_rad.sin(), pitch_rad.cos()];
        // Pure World +Z CCW angular velocity omega = 1.0 rad/s seen in tilted device frame
        let gyro_rad_s = [0.0, pitch_rad.sin(), pitch_rad.cos()];
        let dt = 0.5;
        let (delta_deg, pitch_deg, roll_deg) =
            integrate_gyro_gravity_delta(gyro_rad_s, gravity_up, dt).unwrap();
        // Should extract -0.5 rad = -28.64789 deg CW (since positive CCW around +Z is negative CW)
        assert!((delta_deg + (0.5_f64).to_degrees()).abs() < 1e-6);
        assert!((pitch_deg - 60.0).abs() < 1e-6);
        assert!(roll_deg.abs() < 1e-6);
    }

    #[test]
    fn session_sink_streams_resets_and_tears_down_cleanly() {
        let session = SessionInner::new("test-imu".to_string(), "streaming");
        let sink = MotionSessionSink {
            inner: session.clone(),
        };

        let s1 = sink
            .push_quaternion(q_axis_angle([1.0, 0.0, 0.0], 50.0), 100.0, "sample", 3)
            .unwrap();
        assert_eq!(s1.seq, 1.0);
        assert!((s1.heading_deg - 0.0).abs() < 1e-6);
        assert!((s1.pitch_deg - 50.0).abs() < 1e-5);

        let q2 = q_mul(
            q_axis_angle([0.0, 0.0, 1.0], -42.5),
            q_axis_angle([1.0, 0.0, 0.0], 50.0),
        );
        let s2 = sink.push_quaternion(q2, 120.0, "sample", 3).unwrap();
        assert_eq!(s2.seq, 2.0);
        assert!((s2.heading_deg - 42.5).abs() < 1e-5);
        assert!((s2.yaw_deg - 42.5).abs() < 1e-5);

        session.close_with_status("paused_background");
        assert!(sink.push_quaternion([1.0, 0.0, 0.0, 0.0], 140.0, "sample", 3).is_none());
        assert_eq!(session.state.lock().unwrap().status, "paused_background");
    }
}
