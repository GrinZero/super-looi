//! iOS UNUserNotificationCenter + UIApplication background-grace FFI bindings for `ScheduleHost`.
use super::{
    ANDROID_DAILY_KEEPALIVE_CAP_MS, ANDROID_SESSION_KEEPALIVE_CAP_MS, PostNotificationInput,
    QuietHoursSnapshotInput, ScheduleAlarmInput, ScheduleAlarmSyncResult, ScheduleExactAlarmStatus,
    ScheduleKeepAliveState, ScheduleNativeEvent, format_backend_error,
};
use std::ffi::{CStr, CString, c_char};

unsafe extern "C" {
    fn looi_schedule_install();
    fn looi_schedule_permission_status() -> i32;
    fn looi_schedule_request_permission(error_out: *mut *mut c_char) -> i32;
    fn looi_schedule_sync_alarms(
        alarms_json: *const c_char,
        synced_out: *mut i32,
        cancelled_out: *mut i32,
        error_out: *mut *mut c_char,
    ) -> i32;
    fn looi_schedule_cancel_alarm(rule_id: *const c_char) -> i32;
    fn looi_schedule_post_notification(
        payload_json: *const c_char,
        id_out: *mut *mut c_char,
        error_out: *mut *mut c_char,
    ) -> i32;
    fn looi_schedule_begin_background_grace(
        label: *const c_char,
        handle_out: *mut *mut c_char,
        error_out: *mut *mut c_char,
    ) -> i32;
    fn looi_schedule_end_background_grace(handle: *const c_char);
    fn looi_schedule_drain_events() -> *mut c_char;
    fn looi_schedule_free_string(ptr: *mut c_char);
}

unsafe fn take_c_string(ptr: *mut c_char) -> Option<String> {
    if ptr.is_null() {
        return None;
    }
    let text = unsafe { CStr::from_ptr(ptr).to_string_lossy().into_owned() };
    unsafe { looi_schedule_free_string(ptr) };
    Some(text)
}

fn map_permission(code: i32) -> &'static str {
    match code {
        1 => "granted",
        2 => "denied",
        3 => "unavailable",
        _ => "undetermined",
    }
}

pub fn install() {
    unsafe { looi_schedule_install() };
}

pub fn permission_status() -> String {
    map_permission(unsafe { looi_schedule_permission_status() }).into()
}

pub fn request_permission_blocking() -> Result<String, String> {
    let mut err_ptr: *mut c_char = std::ptr::null_mut();
    let code = unsafe { looi_schedule_request_permission(&mut err_ptr) };
    if code < 0 {
        let detail = unsafe { take_c_string(err_ptr) }
            .unwrap_or_else(|| "ERR_IOS_NOTIFICATION_PERMISSION: Authorization failed".into());
        return Err(format_backend_error(
            "schedule_native.ios.requestPermission",
            "ERR_IOS_NOTIFICATION_PERMISSION",
            &detail,
        ));
    }
    let _ = unsafe { take_c_string(err_ptr) };
    Ok(map_permission(code).into())
}

pub fn exact_alarm_status() -> ScheduleExactAlarmStatus {
    ScheduleExactAlarmStatus {
        mode: "exact".into(),
        degraded: false,
        can_open_settings: false,
        reason: String::new(),
    }
}

pub fn open_exact_alarm_settings() -> Result<bool, String> {
    Ok(false)
}

pub fn sync_upcoming_alarms(alarms: &[ScheduleAlarmInput]) -> Result<ScheduleAlarmSyncResult, String> {
    let json = serde_json::to_string(alarms).map_err(|err| {
        format!("[stage=schedule_native.ios.syncUpcomingAlarms code=ERR_SERIALIZE_ALARMS] {err}")
    })?;
    let c_json = CString::new(json).map_err(|err| {
        format!("[stage=schedule_native.ios.syncUpcomingAlarms code=ERR_INVALID_ALARMS_JSON] {err}")
    })?;
    let mut synced = 0i32;
    let mut cancelled = 0i32;
    let mut err_ptr: *mut c_char = std::ptr::null_mut();
    let ok = unsafe {
        looi_schedule_sync_alarms(c_json.as_ptr(), &mut synced, &mut cancelled, &mut err_ptr)
    };
    if ok == 0 {
        let detail = unsafe { take_c_string(err_ptr) }
            .unwrap_or_else(|| "ERR_IOS_NOTIFICATION_SCHEDULE_FAILED".into());
        return Err(format_backend_error(
            "schedule_native.ios.syncUpcomingAlarms",
            "ERR_IOS_NOTIFICATION_SCHEDULE_FAILED",
            &detail,
        ));
    }
    let _ = unsafe { take_c_string(err_ptr) };
    Ok(ScheduleAlarmSyncResult {
        synced_count: synced.max(0) as u32,
        cancelled_count: cancelled.max(0) as u32,
        exact_alarm_degraded: false,
        exact_alarm_mode: "exact".into(),
    })
}

pub fn cancel_alarm(rule_id: &str) -> Result<bool, String> {
    let c_rule = CString::new(rule_id).map_err(|err| {
        format!("[stage=schedule_native.ios.cancelAlarm code=ERR_INVALID_RULE_ID] {err}")
    })?;
    let removed = unsafe { looi_schedule_cancel_alarm(c_rule.as_ptr()) };
    Ok(removed != 0)
}

pub fn sync_quiet_hours(_snapshot: &QuietHoursSnapshotInput) -> Result<(), String> {
    // iOS alarm sound/nil policy is baked into each synced UNNotificationRequest when quiet hours change.
    Ok(())
}

pub fn post_notification(payload: &PostNotificationInput) -> Result<String, String> {
    let json = serde_json::to_string(payload).map_err(|err| {
        format!(
            "[stage=schedule_native.ios.postNotification code=ERR_SERIALIZE_NOTIFICATION] {err}"
        )
    })?;
    let c_json = CString::new(json).map_err(|err| {
        format!(
            "[stage=schedule_native.ios.postNotification code=ERR_INVALID_NOTIFICATION_PAYLOAD] {err}"
        )
    })?;
    let mut id_ptr: *mut c_char = std::ptr::null_mut();
    let mut err_ptr: *mut c_char = std::ptr::null_mut();
    let ok = unsafe { looi_schedule_post_notification(c_json.as_ptr(), &mut id_ptr, &mut err_ptr) };
    if ok == 0 {
        let _ = unsafe { take_c_string(id_ptr) };
        let detail = unsafe { take_c_string(err_ptr) }
            .unwrap_or_else(|| "ERR_IOS_NOTIFICATION_POST_FAILED".into());
        return Err(format_backend_error(
            "schedule_native.ios.postNotification",
            "ERR_IOS_NOTIFICATION_POST_FAILED",
            &detail,
        ));
    }
    let _ = unsafe { take_c_string(err_ptr) };
    Ok(unsafe { take_c_string(id_ptr) }.unwrap_or_default())
}

pub fn set_android_keep_alive(
    _active: bool,
    _has_running_check: bool,
    _next_trigger_at_ms: Option<f64>,
) -> Result<ScheduleKeepAliveState, String> {
    Ok(ScheduleKeepAliveState {
        active: false,
        has_running_check: false,
        quota_exhausted: false,
        daily_used_ms: 0.0,
        daily_cap_ms: ANDROID_DAILY_KEEPALIVE_CAP_MS,
        session_used_ms: 0.0,
        session_cap_ms: ANDROID_SESSION_KEEPALIVE_CAP_MS,
        reason: String::new(),
    })
}

pub fn begin_ios_background_grace(label: &str) -> Result<String, String> {
    let c_label = CString::new(label).map_err(|err| {
        format!(
            "[stage=schedule_native.ios.beginBackgroundGrace code=ERR_INVALID_GRACE_LABEL] {err}"
        )
    })?;
    let mut handle_ptr: *mut c_char = std::ptr::null_mut();
    let mut err_ptr: *mut c_char = std::ptr::null_mut();
    let ok = unsafe {
        looi_schedule_begin_background_grace(c_label.as_ptr(), &mut handle_ptr, &mut err_ptr)
    };
    if ok == 0 {
        let _ = unsafe { take_c_string(handle_ptr) };
        let detail = unsafe { take_c_string(err_ptr) }
            .unwrap_or_else(|| "ERR_IOS_BACKGROUND_TASK_INVALID".into());
        return Err(format_backend_error(
            "schedule_native.ios.beginBackgroundGrace",
            "ERR_IOS_BACKGROUND_TASK_INVALID",
            &detail,
        ));
    }
    let _ = unsafe { take_c_string(err_ptr) };
    Ok(unsafe { take_c_string(handle_ptr) }.unwrap_or_default())
}

pub fn end_ios_background_grace(handle: &str) {
    if let Ok(c_handle) = CString::new(handle) {
        unsafe { looi_schedule_end_background_grace(c_handle.as_ptr()) };
    }
}

pub fn drain_events() -> Vec<ScheduleNativeEvent> {
    let raw = unsafe { take_c_string(looi_schedule_drain_events()) };
    match raw {
        Some(json) if !json.trim().is_empty() => {
            serde_json::from_str::<Vec<ScheduleNativeEvent>>(&json).unwrap_or_default()
        }
        _ => Vec::new(),
    }
}

pub fn set_foreground(_active: bool) {}
