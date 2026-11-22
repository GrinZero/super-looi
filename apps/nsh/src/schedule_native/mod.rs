//! App-owned native scheduling, local notification, quiet-hours snapshot, and background-grace bridge (`ScheduleHost`).
use nsh_core::prelude::*;
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashMap, HashSet, VecDeque},
    sync::{Arc, Mutex},
};

#[cfg(target_os = "android")]
mod android;
#[cfg(target_os = "ios")]
pub mod ios;

#[cfg(target_os = "android")]
use android as platform;
#[cfg(target_os = "ios")]
use ios as platform;

pub(super) const MAX_UPCOMING_ALARMS: usize = 32;
pub(super) const MAX_NATIVE_EVENTS: usize = 256;
pub(super) const ANDROID_DAILY_KEEPALIVE_CAP_MS: f64 = 18_000_000.0; // 5 hours
pub(super) const ANDROID_SESSION_KEEPALIVE_CAP_MS: f64 = 3_600_000.0; // 60 minutes

fn default_empty_json_obj() -> String {
    "{}".to_owned()
}

fn default_true() -> bool {
    true
}

#[cfg_attr(not(any(target_os = "ios", target_os = "android", test)), allow(dead_code))]
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
    let reason = if trimmed.is_empty() {
        default_code
    } else {
        trimmed
    };
    format!("[stage={stage} code={default_code}] {reason}")
}

/// One pollable native schedule, notification, or background-lifecycle event.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize, JsObject)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleNativeEvent {
    /// `"notification_tapped" | "ios_grace_expiring" | "keepalive_timeout" | "alarm_fired"`
    pub kind: String,
    /// Rule identifier associated with this event, or empty when system-wide.
    #[serde(default)]
    pub rule_id: String,
    /// Notification identifier (`"looi.sched.<ruleId>"` or `"looi.sched.post.<id>"`), or empty.
    #[serde(default)]
    pub notification_id: String,
    /// Background-grace handle or run identifier when supplied.
    #[serde(default)]
    pub handle: String,
    /// JSON object metadata string (defaults to `"{}"`).
    #[serde(default = "default_empty_json_obj")]
    pub payload_json: String,
    /// Event timestamp in milliseconds since Unix epoch.
    #[serde(default)]
    pub occurred_at_ms: f64,
}

/// Native exact-alarm capability and Android 12+ degradation state.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize, JsObject)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleExactAlarmStatus {
    /// `"exact" | "inexact" | "unavailable"`
    pub mode: String,
    /// `true` on Android 12+ when exact alarm access is missing and `AlarmManager` degrades to `setAndAllowWhileIdle`.
    pub degraded: bool,
    /// `true` when the platform provides an OS exact-alarm settings screen (`ACTION_REQUEST_SCHEDULE_EXACT_ALARM`).
    pub can_open_settings: bool,
    /// Native status detail or failure reason when degraded/unavailable.
    #[serde(default)]
    pub reason: String,
}

/// Result returned by `ScheduleHost.syncUpcomingAlarms`.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize, JsObject)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleAlarmSyncResult {
    /// Number of upcoming alarms currently registered with the OS (`<= 32`).
    pub synced_count: u32,
    /// Number of stale `looi.sched.*` alarms removed during reconciliation.
    pub cancelled_count: u32,
    /// `true` when Android could not schedule exact alarms and degraded to `setAndAllowWhileIdle`.
    pub exact_alarm_degraded: bool,
    /// `"exact" | "inexact" | "unavailable"`
    pub exact_alarm_mode: String,
}

/// Current Android short-window `dataSync` keepalive service and quota status.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize, JsObject)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleKeepAliveState {
    /// Whether `ScheduleKeepAliveService` is actively running.
    pub active: bool,
    /// Whether a scheduled check is currently holding the bounded partial `WakeLock`.
    pub has_running_check: bool,
    /// `true` when the 24h rolling `dataSync` cap (5h) or per-background cap (60m) prevented/stopped keepalive.
    pub quota_exhausted: bool,
    /// Accumulated `dataSync` foreground service duration in the rolling 24h window (ms).
    pub daily_used_ms: f64,
    /// Conservative daily `dataSync` cap in milliseconds (`18_000_000`).
    pub daily_cap_ms: f64,
    /// Elapsed background keepalive duration since last foreground return (ms).
    pub session_used_ms: f64,
    /// Per-background-session keepalive cap in milliseconds (`3_600_000`).
    pub session_cap_ms: f64,
    /// Human-readable status or quota stop reason.
    #[serde(default)]
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ScheduleAlarmInput {
    pub rule_id: String,
    pub trigger_at_ms: f64,
    pub title: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub silent: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct QuietHoursWindowInput {
    #[serde(default)]
    pub id: String,
    pub start_minute: u16,
    pub end_minute: u16,
    #[serde(default)]
    pub days_of_week: Option<Vec<u8>>,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct QuietHoursSnapshotInput {
    #[serde(default)]
    pub quiet_hours_enabled: bool,
    #[serde(default, alias = "quietHours")]
    pub windows: Vec<QuietHoursWindowInput>,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PostNotificationInput {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub rule_id: String,
    #[serde(default)]
    pub run_id: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
    pub title: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub silent: bool,
}

pub(super) fn parse_and_validate_alarms(
    alarms_json: &str,
) -> Result<Vec<ScheduleAlarmInput>, String> {
    let raw: Vec<ScheduleAlarmInput> = serde_json::from_str(alarms_json).map_err(|err| {
        format!(
            "[stage=schedule_native.syncUpcomingAlarms code=ERR_INVALID_ALARMS_JSON] Invalid alarms JSON: {err}"
        )
    })?;
    let mut deduped: HashMap<String, ScheduleAlarmInput> = HashMap::with_capacity(raw.len());
    for mut item in raw {
        let rule_id = item.rule_id.trim().to_owned();
        if rule_id.is_empty() {
            return Err(
                "[stage=schedule_native.syncUpcomingAlarms code=ERR_INVALID_ALARM_ENTRY] Alarm entry requires non-empty ruleId"
                    .into(),
            );
        }
        if !item.trigger_at_ms.is_finite() || item.trigger_at_ms <= 0.0 {
            return Err(format!(
                "[stage=schedule_native.syncUpcomingAlarms code=ERR_INVALID_ALARM_ENTRY] Alarm \"{rule_id}\" has invalid triggerAtMs"
            ));
        }
        let title = item.title.trim().to_owned();
        if title.is_empty() {
            return Err(format!(
                "[stage=schedule_native.syncUpcomingAlarms code=ERR_INVALID_ALARM_ENTRY] Alarm \"{rule_id}\" requires non-empty title"
            ));
        }
        item.rule_id = rule_id.clone();
        item.title = title;
        match deduped.get(&rule_id) {
            Some(existing) if existing.trigger_at_ms <= item.trigger_at_ms => {}
            _ => {
                deduped.insert(rule_id, item);
            }
        }
    }
    let mut normalized: Vec<ScheduleAlarmInput> = deduped.into_values().collect();
    normalized.sort_by(|a, b| {
        a.trigger_at_ms
            .total_cmp(&b.trigger_at_ms)
            .then_with(|| a.rule_id.cmp(&b.rule_id))
    });
    if normalized.len() > MAX_UPCOMING_ALARMS {
        normalized.truncate(MAX_UPCOMING_ALARMS);
    }
    Ok(normalized)
}

pub(super) fn parse_and_normalize_quiet_snapshot(
    quiet_snapshot_json: &str,
) -> Result<QuietHoursSnapshotInput, String> {
    let mut snapshot: QuietHoursSnapshotInput =
        serde_json::from_str(quiet_snapshot_json).map_err(|err| {
            format!(
                "[stage=schedule_native.syncQuietHours code=ERR_INVALID_QUIET_SNAPSHOT] Invalid quiet-hours snapshot JSON: {err}"
            )
        })?;
    for window in &mut snapshot.windows {
        if window.start_minute > 1439 || window.end_minute > 1439 {
            return Err(format!(
                "[stage=schedule_native.syncQuietHours code=ERR_INVALID_QUIET_SNAPSHOT] Quiet window \"{}\" minute out of range 0..1439",
                window.id
            ));
        }
        if let Some(days) = &mut window.days_of_week {
            let mut seen = HashSet::new();
            let mut normalized_days = Vec::with_capacity(days.len());
            for &day in days.iter() {
                if day > 7 {
                    return Err(format!(
                        "[stage=schedule_native.syncQuietHours code=ERR_INVALID_QUIET_SNAPSHOT] Quiet window \"{}\" weekday {day} out of range 0..7",
                        window.id
                    ));
                }
                let normalized = if day == 7 { 0 } else { day };
                if seen.insert(normalized) {
                    normalized_days.push(normalized);
                }
            }
            *days = normalized_days;
        }
    }
    Ok(snapshot)
}

pub(super) fn parse_and_validate_notification(
    payload_json: &str,
    next_seq: u64,
) -> Result<PostNotificationInput, String> {
    let mut payload: PostNotificationInput = serde_json::from_str(payload_json).map_err(|err| {
        format!(
            "[stage=schedule_native.postNotification code=ERR_INVALID_NOTIFICATION_PAYLOAD] Invalid notification payload JSON: {err}"
        )
    })?;
    payload.rule_id = payload.rule_id.trim().to_owned();
    payload.title = payload.title.trim().to_owned();
    if payload.title.is_empty() {
        return Err(
            "[stage=schedule_native.postNotification code=ERR_INVALID_NOTIFICATION_PAYLOAD] Notification payload requires non-empty title"
                .into(),
        );
    }
    let resolved_id = payload
        .id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| {
            if payload.rule_id.is_empty() {
                format!("msg.{next_seq}")
            } else {
                format!("{}.{next_seq}", payload.rule_id)
            }
        });
    payload.id = Some(resolved_id);
    Ok(payload)
}

#[derive(Debug, Clone)]
struct DesktopSimState {
    target_os: String,
    permission: String,
    exact_alarm_degraded: bool,
    exact_alarm_settings_opened: u32,
    foreground: bool,
    alarms: BTreeMap<String, ScheduleAlarmInput>,
    quiet_snapshot: QuietHoursSnapshotInput,
    posted_notifications: Vec<PostNotificationInput>,
    keepalive_active: bool,
    keepalive_has_running_check: bool,
    keepalive_next_trigger_at_ms: Option<f64>,
    keepalive_daily_used_ms: f64,
    keepalive_session_used_ms: f64,
    grace_handles: HashMap<String, String>,
    next_seq: u64,
    events: VecDeque<ScheduleNativeEvent>,
}

impl DesktopSimState {
    fn new(target_os: String) -> Self {
        Self {
            target_os,
            permission: "granted".into(),
            exact_alarm_degraded: false,
            exact_alarm_settings_opened: 0,
            foreground: true,
            alarms: BTreeMap::new(),
            quiet_snapshot: QuietHoursSnapshotInput::default(),
            posted_notifications: Vec::new(),
            keepalive_active: false,
            keepalive_has_running_check: false,
            keepalive_next_trigger_at_ms: None,
            keepalive_daily_used_ms: 0.0,
            keepalive_session_used_ms: 0.0,
            grace_handles: HashMap::new(),
            next_seq: 1,
            events: VecDeque::with_capacity(MAX_NATIVE_EVENTS),
        }
    }

    fn next_id(&mut self) -> u64 {
        let id = self.next_seq;
        self.next_seq += 1;
        id
    }

    #[cfg_attr(not(test), allow(dead_code))]
    fn push_event(&mut self, event: ScheduleNativeEvent) {
        if self.events.len() >= MAX_NATIVE_EVENTS {
            self.events.pop_front();
        }
        self.events.push_back(event);
    }

    fn exact_alarm_status(&self) -> ScheduleExactAlarmStatus {
        let can_open = self.target_os == "android";
        if self.exact_alarm_degraded {
            ScheduleExactAlarmStatus {
                mode: "inexact".into(),
                degraded: true,
                can_open_settings: can_open,
                reason: "SCHEDULE_EXACT_ALARM disabled in simulation".into(),
            }
        } else {
            ScheduleExactAlarmStatus {
                mode: "exact".into(),
                degraded: false,
                can_open_settings: can_open,
                reason: String::new(),
            }
        }
    }

    fn keepalive_state(&self, quota_exhausted: bool, reason: String) -> ScheduleKeepAliveState {
        ScheduleKeepAliveState {
            active: self.keepalive_active,
            has_running_check: self.keepalive_has_running_check,
            quota_exhausted,
            daily_used_ms: self.keepalive_daily_used_ms,
            daily_cap_ms: ANDROID_DAILY_KEEPALIVE_CAP_MS,
            session_used_ms: self.keepalive_session_used_ms,
            session_cap_ms: ANDROID_SESSION_KEEPALIVE_CAP_MS,
            reason,
        }
    }
}

enum Backend {
    Desktop(Arc<Mutex<DesktopSimState>>),
    #[cfg(any(target_os = "ios", target_os = "android"))]
    Platform,
}

/// Unified native scheduling, notification, quiet-hours snapshot, and background-grace host.
#[class]
pub struct ScheduleHost {
    backend: Backend,
}

#[class]
impl ScheduleHost {
    /// Construct an idle `ScheduleHost` without prompting for OS permissions.
    pub fn new(sys: System) -> Self {
        let os_name = sys.os.name().to_owned();
        let use_platform = cfg!(any(target_os = "ios", target_os = "android"))
            && os_name == std::env::consts::OS;
        if use_platform {
            #[cfg(any(target_os = "ios", target_os = "android"))]
            {
                #[cfg(target_os = "ios")]
                ios::install();
                return Self {
                    backend: Backend::Platform,
                };
            }
        }
        Self {
            backend: Backend::Desktop(Arc::new(Mutex::new(DesktopSimState::new(os_name)))),
        }
    }

    /// Query OS notification authorization: `"granted" | "denied" | "undetermined" | "unavailable"`.
    pub fn permission_status(&self) -> String {
        match &self.backend {
            Backend::Desktop(sim) => sim.lock().unwrap().permission.clone(),
            #[cfg(any(target_os = "ios", target_os = "android"))]
            Backend::Platform => platform::permission_status(),
        }
    }

    /// Request OS notification authorization off the JS engine thread.
    pub async fn request_permission(this: Instance<Self>) -> Result<String, String> {
        let is_desktop = this.with(|host| match &host.backend {
            Backend::Desktop(sim) => Some(sim.clone()),
            #[cfg(any(target_os = "ios", target_os = "android"))]
            Backend::Platform => None,
        });
        if let Some(sim) = is_desktop {
            let mut guard = sim.lock().unwrap();
            if guard.permission == "undetermined" {
                guard.permission = "granted".into();
            }
            return Ok(guard.permission.clone());
        }
        #[cfg(any(target_os = "ios", target_os = "android"))]
        {
            background(async move {
                tokio::task::spawn_blocking(platform::request_permission_blocking)
                    .await
                    .map_err(|err| {
                        format!(
                            "[stage=schedule_native.requestPermission code=ERR_SCHEDULE_PERMISSION_JOIN] {err}"
                        )
                    })?
            })
            .await
            .map_err(|_| {
                "[stage=schedule_native.requestPermission code=ERR_SCHEDULE_PERMISSION_CANCELLED] Permission request task cancelled"
                    .to_string()
            })?
        }
        #[cfg(not(any(target_os = "ios", target_os = "android")))]
        unreachable!()
    }

    /// Query native exact-alarm availability (`"exact" | "inexact" | "unavailable"`) and Android 12+ degradation state.
    pub fn exact_alarm_status(&self) -> ScheduleExactAlarmStatus {
        match &self.backend {
            Backend::Desktop(sim) => sim.lock().unwrap().exact_alarm_status(),
            #[cfg(any(target_os = "ios", target_os = "android"))]
            Backend::Platform => platform::exact_alarm_status(),
        }
    }

    /// Open the OS exact-alarm permission settings page on Android 12+ (`false` where not applicable).
    pub fn open_exact_alarm_settings(&self) -> Result<bool, String> {
        match &self.backend {
            Backend::Desktop(sim) => {
                let mut guard = sim.lock().unwrap();
                if guard.target_os == "android" {
                    guard.exact_alarm_settings_opened += 1;
                    Ok(true)
                } else {
                    Ok(false)
                }
            }
            #[cfg(any(target_os = "ios", target_os = "android"))]
            Backend::Platform => platform::open_exact_alarm_settings(),
        }
    }

    /// Synchronize up to 32 upcoming scheduled alarms (`[{ ruleId, triggerAtMs, title, body, silent }]`).
    pub fn sync_upcoming_alarms(&self, alarms_json: String) -> Result<ScheduleAlarmSyncResult, String> {
        let alarms = parse_and_validate_alarms(&alarms_json)?;
        match &self.backend {
            Backend::Desktop(sim) => {
                let mut guard = sim.lock().unwrap();
                let incoming_ids: HashSet<&str> =
                    alarms.iter().map(|a| a.rule_id.as_str()).collect();
                let stale_count = guard
                    .alarms
                    .keys()
                    .filter(|id| !incoming_ids.contains(id.as_str()))
                    .count() as u32;
                guard.alarms.clear();
                for alarm in alarms {
                    guard.alarms.insert(alarm.rule_id.clone(), alarm);
                }
                let exact = guard.exact_alarm_status();
                Ok(ScheduleAlarmSyncResult {
                    synced_count: guard.alarms.len() as u32,
                    cancelled_count: stale_count,
                    exact_alarm_degraded: exact.degraded,
                    exact_alarm_mode: exact.mode,
                })
            }
            #[cfg(any(target_os = "ios", target_os = "android"))]
            Backend::Platform => platform::sync_upcoming_alarms(&alarms),
        }
    }

    /// Cancel one scheduled alarm by `ruleId` (`looi.sched.<ruleId>`).
    pub fn cancel_alarm(&self, rule_id: String) -> Result<bool, String> {
        let trimmed = rule_id.trim();
        if trimmed.is_empty() {
            return Err(
                "[stage=schedule_native.cancelAlarm code=ERR_INVALID_RULE_ID] ruleId cannot be empty"
                    .into(),
            );
        }
        match &self.backend {
            Backend::Desktop(sim) => Ok(sim.lock().unwrap().alarms.remove(trimmed).is_some()),
            #[cfg(any(target_os = "ios", target_os = "android"))]
            Backend::Platform => platform::cancel_alarm(trimmed),
        }
    }

    /// Persist a compact quiet-hours snapshot (`{ quietHoursEnabled, windows }`) for offline/background evaluation.
    pub fn sync_quiet_hours(&self, quiet_snapshot_json: String) -> Result<(), String> {
        let snapshot = parse_and_normalize_quiet_snapshot(&quiet_snapshot_json)?;
        match &self.backend {
            Backend::Desktop(sim) => {
                sim.lock().unwrap().quiet_snapshot = snapshot;
                Ok(())
            }
            #[cfg(any(target_os = "ios", target_os = "android"))]
            Backend::Platform => platform::sync_quiet_hours(&snapshot),
        }
    }

    /// Post an immediate local notification (`{ id?, ruleId?, runId?, title, body?, silent? }`).
    pub fn post_notification(&self, payload_json: String) -> Result<String, String> {
        let seq = match &self.backend {
            Backend::Desktop(sim) => sim.lock().unwrap().next_id(),
            #[cfg(any(target_os = "ios", target_os = "android"))]
            Backend::Platform => {
                static NEXT_POST_SEQ: std::sync::atomic::AtomicU64 =
                    std::sync::atomic::AtomicU64::new(1);
                NEXT_POST_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            }
        };
        let payload = parse_and_validate_notification(&payload_json, seq)?;
        match &self.backend {
            Backend::Desktop(sim) => {
                let mut guard = sim.lock().unwrap();
                if guard.permission != "granted" {
                    return Err(format!(
                        "[stage=schedule_native.desktop.postNotification code=ERR_NOTIFICATION_PERMISSION_DENIED] Notification permission is {}",
                        guard.permission
                    ));
                }
                let notif_id = format!(
                    "looi.sched.post.{}",
                    payload.id.as_deref().unwrap_or("msg")
                );
                guard.posted_notifications.push(payload);
                Ok(notif_id)
            }
            #[cfg(any(target_os = "ios", target_os = "android"))]
            Backend::Platform => platform::post_notification(&payload),
        }
    }

    /// Control Android short-window `dataSync` keepalive foreground service and `WakeLock`.
    pub fn set_android_keep_alive(
        &self,
        active: bool,
        has_running_check: bool,
        next_trigger_at_ms: Option<f64>,
    ) -> Result<ScheduleKeepAliveState, String> {
        let next_ms = next_trigger_at_ms.filter(|v| v.is_finite() && *v > 0.0);
        match &self.backend {
            Backend::Desktop(sim) => {
                let mut guard = sim.lock().unwrap();
                if !active {
                    guard.keepalive_active = false;
                    guard.keepalive_has_running_check = false;
                    guard.keepalive_next_trigger_at_ms = next_ms;
                    return Ok(guard.keepalive_state(false, String::new()));
                }
                if guard.keepalive_daily_used_ms >= ANDROID_DAILY_KEEPALIVE_CAP_MS {
                    guard.keepalive_active = false;
                    guard.keepalive_has_running_check = false;
                    return Ok(guard.keepalive_state(
                        true,
                        "24h dataSync keepalive cap (5h) reached".into(),
                    ));
                }
                if !guard.foreground
                    && guard.keepalive_session_used_ms >= ANDROID_SESSION_KEEPALIVE_CAP_MS
                {
                    guard.keepalive_active = false;
                    guard.keepalive_has_running_check = false;
                    return Ok(guard.keepalive_state(
                        true,
                        "60min per-background keepalive cap reached".into(),
                    ));
                }
                guard.keepalive_active = true;
                guard.keepalive_has_running_check = has_running_check;
                guard.keepalive_next_trigger_at_ms = next_ms;
                Ok(guard.keepalive_state(false, String::new()))
            }
            #[cfg(any(target_os = "ios", target_os = "android"))]
            Backend::Platform => {
                platform::set_android_keep_alive(active, has_running_check, next_ms)
            }
        }
    }

    /// Begin a short iOS `UIApplication.beginBackgroundTask` grace window, returning its opaque handle.
    pub fn begin_ios_background_grace(&self, label: String) -> Result<String, String> {
        let clean_label = if label.trim().is_empty() {
            "looi.schedule.grace".to_owned()
        } else {
            label.trim().to_owned()
        };
        match &self.backend {
            Backend::Desktop(sim) => {
                let mut guard = sim.lock().unwrap();
                let id = guard.next_id();
                let handle = format!("sim_bg_{id}");
                guard.grace_handles.insert(handle.clone(), clean_label);
                Ok(handle)
            }
            #[cfg(any(target_os = "ios", target_os = "android"))]
            Backend::Platform => platform::begin_ios_background_grace(&clean_label),
        }
    }

    /// End a previously started iOS background-grace task handle (idempotent).
    pub fn end_ios_background_grace(&self, handle: String) {
        let trimmed = handle.trim();
        if trimmed.is_empty() {
            return;
        }
        match &self.backend {
            Backend::Desktop(sim) => {
                sim.lock().unwrap().grace_handles.remove(trimmed);
            }
            #[cfg(any(target_os = "ios", target_os = "android"))]
            Backend::Platform => platform::end_ios_background_grace(trimmed),
        }
    }

    /// Drain all queued native schedule, notification-tap, and lifecycle events in chronological order.
    pub fn drain_events(&self) -> Vec<ScheduleNativeEvent> {
        match &self.backend {
            Backend::Desktop(sim) => sim.lock().unwrap().events.drain(..).collect(),
            #[cfg(any(target_os = "ios", target_os = "android"))]
            Backend::Platform => platform::drain_events(),
        }
    }

    /// Synchronize app foreground/background state (resets Android 60-minute background keepalive cap on foreground).
    pub fn set_foreground(&self, active: bool) {
        match &self.backend {
            Backend::Desktop(sim) => {
                let mut guard = sim.lock().unwrap();
                guard.foreground = active;
                if active {
                    guard.keepalive_session_used_ms = 0.0;
                }
            }
            #[cfg(any(target_os = "ios", target_os = "android"))]
            Backend::Platform => platform::set_foreground(active),
        }
    }
}

#[cfg(test)]
impl ScheduleHost {
    fn sim(&self) -> Option<&Arc<Mutex<DesktopSimState>>> {
        match &self.backend {
            Backend::Desktop(sim) => Some(sim),
            #[cfg(any(target_os = "ios", target_os = "android"))]
            Backend::Platform => None,
        }
    }

    fn push_sim_event(&self, event: ScheduleNativeEvent) {
        if let Some(sim) = self.sim() {
            sim.lock().unwrap().push_event(event);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nsh_core::platform::Os;

    fn host_with_os(os: Os) -> ScheduleHost {
        let sys = System::default().with_os(os);
        ScheduleHost::new(sys)
    }

    #[tokio::test]
    async fn permission_and_exact_alarm_lifecycle_on_desktop_sim() {
        let host = host_with_os(Os::Android);
        assert_eq!(host.permission_status(), "granted");
        host.sim().unwrap().lock().unwrap().permission = "undetermined".into();
        assert_eq!(host.permission_status(), "undetermined");
        {
            let sim = host.sim().unwrap();
            let mut guard = sim.lock().unwrap();
            if guard.permission == "undetermined" {
                guard.permission = "granted".into();
            }
        }
        assert_eq!(host.permission_status(), "granted");
        let status = host.exact_alarm_status();
        assert_eq!(status.mode, "exact");
        assert!(!status.degraded);
        assert!(status.can_open_settings);
        assert_eq!(host.open_exact_alarm_settings().unwrap(), true);
        assert_eq!(host.sim().unwrap().lock().unwrap().exact_alarm_settings_opened, 1);

        let ios_host = host_with_os(Os::Ios);
        assert_eq!(ios_host.open_exact_alarm_settings().unwrap(), false);
        assert!(!ios_host.exact_alarm_status().can_open_settings);
    }

    #[test]
    fn alarm_sync_sorts_dedupes_caps_at_32_and_cancels_stale() {
        let host = host_with_os(Os::Ios);
        let mut items = Vec::new();
        for idx in (1..=40).rev() {
            items.push(serde_json::json!({
                "ruleId": format!("rule-{idx}"),
                "triggerAtMs": 1_700_000_000_000.0 + (idx as f64) * 1000.0,
                "title": format!("Check #{idx}"),
                "body": "Body",
                "silent": idx % 2 == 0,
            }));
        }
        // Duplicate rule-1 with later timestamp should lose to earlier timestamp
        items.push(serde_json::json!({
            "ruleId": "rule-1",
            "triggerAtMs": 1_700_000_999_000.0,
            "title": "Later dup",
            "body": "",
            "silent": true,
        }));
        let res = host
            .sync_upcoming_alarms(serde_json::Value::Array(items).to_string())
            .unwrap();
        assert_eq!(res.synced_count, 32);
        assert_eq!(res.cancelled_count, 0);

        {
            let sim = host.sim().unwrap();
            let guard = sim.lock().unwrap();
            assert_eq!(guard.alarms.len(), 32);
            assert!(guard.alarms.contains_key("rule-1"));
            assert!(!guard.alarms.contains_key("rule-33"));
            assert_eq!(guard.alarms["rule-1"].title, "Check #1");
        }

        // Re-sync with only rule-2 -> 31 stale cancelled
        let res2 = host
            .sync_upcoming_alarms(
                serde_json::json!([{
                    "ruleId": "rule-2",
                    "triggerAtMs": 1_700_000_005_000.0,
                    "title": "Check #2",
                    "body": "",
                    "silent": true,
                }])
                .to_string(),
            )
            .unwrap();
        assert_eq!(res2.synced_count, 1);
        assert_eq!(res2.cancelled_count, 31);
        assert_eq!(host.cancel_alarm("rule-2".into()).unwrap(), true);
        assert_eq!(host.cancel_alarm("rule-2".into()).unwrap(), false);
    }

    #[test]
    fn alarm_and_notification_and_quiet_validation_preserve_stage_and_code() {
        let host = host_with_os(Os::MacOs);
        let bad_json = host.sync_upcoming_alarms("not-json".into()).unwrap_err();
        assert!(bad_json.contains("[stage=schedule_native.syncUpcomingAlarms code=ERR_INVALID_ALARMS_JSON]"));

        let bad_entry = host
            .sync_upcoming_alarms(r#"[{"ruleId":"","triggerAtMs":1000,"title":"x"}]"#.into())
            .unwrap_err();
        assert!(bad_entry.contains("[stage=schedule_native.syncUpcomingAlarms code=ERR_INVALID_ALARM_ENTRY]"));

        let bad_cancel = host.cancel_alarm("   ".into()).unwrap_err();
        assert!(bad_cancel.contains("[stage=schedule_native.cancelAlarm code=ERR_INVALID_RULE_ID]"));

        let bad_quiet = host
            .sync_quiet_hours(r#"{"quietHoursEnabled":true,"windows":[{"id":"w1","startMinute":1500,"endMinute":60}]}"#.into())
            .unwrap_err();
        assert!(bad_quiet.contains("[stage=schedule_native.syncQuietHours code=ERR_INVALID_QUIET_SNAPSHOT]"));

        // Normalize weekday 7 -> 0 and accept alias `quietHours`
        host.sync_quiet_hours(
            r#"{"quietHoursEnabled":true,"quietHours":[{"id":"night","startMinute":1380,"endMinute":480,"daysOfWeek":[7,0,5],"enabled":true}]}"#
                .into(),
        )
        .unwrap();
        {
            let sim = host.sim().unwrap();
            let guard = sim.lock().unwrap();
            assert!(guard.quiet_snapshot.quiet_hours_enabled);
            assert_eq!(guard.quiet_snapshot.windows.len(), 1);
            assert_eq!(
                guard.quiet_snapshot.windows[0].days_of_week.as_deref(),
                Some(&[0u8, 5][..])
            );
        }

        let bad_notif = host
            .post_notification(r#"{"ruleId":"r1","title":"   "}"#.into())
            .unwrap_err();
        assert!(bad_notif.contains("[stage=schedule_native.postNotification code=ERR_INVALID_NOTIFICATION_PAYLOAD]"));

        host.sim().unwrap().lock().unwrap().permission = "denied".into();
        let denied_notif = host
            .post_notification(r#"{"ruleId":"r1","title":"PR merged"}"#.into())
            .unwrap_err();
        assert!(denied_notif.contains("[stage=schedule_native.desktop.postNotification code=ERR_NOTIFICATION_PERMISSION_DENIED]"));

        assert_eq!(
            format_backend_error(
                "schedule_native.android.keepAlive",
                "ERR_SCHEDULE_ANDROID_EXCEPTION",
                "ERR_KEEPALIVE_START_NOT_ALLOWED: Background start rejected"
            ),
            "[stage=schedule_native.android.keepAlive code=ERR_KEEPALIVE_START_NOT_ALLOWED] Background start rejected"
        );
    }

    #[test]
    fn event_queue_keepalive_caps_and_background_grace_behave_deterministically() {
        let host = host_with_os(Os::Android);
        let id = host
            .post_notification(r#"{"ruleId":"r1","runId":"run-9","title":"Done","body":"OK","silent":false}"#.into())
            .unwrap();
        assert!(id.starts_with("looi.sched.post."));
        assert_eq!(host.sim().unwrap().lock().unwrap().posted_notifications.len(), 1);

        for i in 0..300 {
            host.push_sim_event(ScheduleNativeEvent {
                kind: "alarm_fired".into(),
                rule_id: format!("r-{i}"),
                notification_id: String::new(),
                handle: String::new(),
                payload_json: "{}".into(),
                occurred_at_ms: i as f64,
            });
        }
        let drained = host.drain_events();
        assert_eq!(drained.len(), MAX_NATIVE_EVENTS);
        assert_eq!(drained.first().unwrap().rule_id, "r-44");
        assert_eq!(drained.last().unwrap().rule_id, "r-299");
        assert!(host.drain_events().is_empty());

        let ka = host
            .set_android_keep_alive(true, true, Some(1_700_000_000_000.0))
            .unwrap();
        assert!(ka.active);
        assert!(ka.has_running_check);
        assert!(!ka.quota_exhausted);
        assert_eq!(
            host.sim().unwrap().lock().unwrap().keepalive_next_trigger_at_ms,
            Some(1_700_000_000_000.0)
        );

        // Exceed 60min background cap when backgrounded
        {
            let sim = host.sim().unwrap();
            let mut guard = sim.lock().unwrap();
            guard.foreground = false;
            guard.keepalive_session_used_ms = ANDROID_SESSION_KEEPALIVE_CAP_MS;
        }
        let ka_capped = host
            .set_android_keep_alive(true, false, Some(1_700_000_000_000.0))
            .unwrap();
        assert!(!ka_capped.active);
        assert!(ka_capped.quota_exhausted);

        // Returning to foreground resets the 60-minute per-background cap
        host.set_foreground(true);
        let ka_resumed = host
            .set_android_keep_alive(true, false, Some(1_700_000_000_000.0))
            .unwrap();
        assert!(ka_resumed.active);
        assert!(!ka_resumed.quota_exhausted);

        let grace = host.begin_ios_background_grace("check-pr".into()).unwrap();
        assert!(grace.starts_with("sim_bg_"));
        host.end_ios_background_grace(grace.clone());
        host.end_ios_background_grace(grace);
    }
}
