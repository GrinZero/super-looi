//! Android AlarmManager, NotificationManager, SharedPreferences quiet snapshot, and dataSync FGS JNI bindings.
use super::{
    ANDROID_DAILY_KEEPALIVE_CAP_MS, ANDROID_SESSION_KEEPALIVE_CAP_MS, PostNotificationInput,
    QuietHoursSnapshotInput, ScheduleAlarmInput, ScheduleAlarmSyncResult, ScheduleExactAlarmStatus,
    ScheduleKeepAliveState, ScheduleNativeEvent, format_backend_error,
};
use jni::{
    JNIEnv, JavaVM,
    objects::{GlobalRef, JClass, JString, JValue},
    sys::{jboolean, jdouble},
};
use std::{
    sync::OnceLock,
    time::{Duration, Instant},
};

static JAVA: OnceLock<(JavaVM, GlobalRef)> = OnceLock::new();

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_superlooi_nsh_ScheduleBridge_registerVm(
    env: JNIEnv<'_>,
    class: JClass<'_>,
) {
    if let (Ok(vm), Ok(class)) = (env.get_java_vm(), env.new_global_ref(class)) {
        let _ = JAVA.set((vm, class));
    }
}

fn extract_java_exception(env: &mut JNIEnv<'_>) -> Option<String> {
    if !env.exception_check().unwrap_or(false) {
        return None;
    }
    let throwable = env.exception_occurred().ok()?;
    let _ = env.exception_clear();
    let msg_obj = env
        .call_method(&throwable, "getMessage", "()Ljava/lang/String;", &[])
        .ok()?
        .l()
        .ok()?;
    if msg_obj.is_null() {
        return Some("ERR_SCHEDULE_ANDROID_EXCEPTION".into());
    }
    env.get_string(&JString::from(msg_obj))
        .ok()
        .map(String::from)
}

fn java<T>(
    stage: &str,
    operation: impl FnOnce(&mut JNIEnv<'_>, &JClass<'_>) -> jni::errors::Result<T>,
) -> Result<T, String> {
    let (vm, class) = JAVA.get().ok_or_else(|| {
        format!(
            "[stage={stage} code=ERR_SCHEDULE_ANDROID_UNAVAILABLE] Android ScheduleBridge VM not registered"
        )
    })?;
    let mut env = vm
        .attach_current_thread()
        .map_err(|err| format!("[stage={stage} code=ERR_SCHEDULE_ANDROID_JNI_ATTACH] {err}"))?;
    let result = env.with_local_frame(32, |env| operation(env, class.as_obj().into()));
    match result {
        Ok(value) => Ok(value),
        Err(jni_err) => {
            let detail = extract_java_exception(&mut env).unwrap_or_else(|| jni_err.to_string());
            let _ = env.exception_clear();
            Err(format_backend_error(
                stage,
                "ERR_SCHEDULE_ANDROID_EXCEPTION",
                &detail,
            ))
        }
    }
}

fn is_permission_pending() -> bool {
    java("schedule_native.android.permissionPending", |env, class| {
        env.call_static_method(class, "isPermissionRequestPending", "()Z", &[])?
            .z()
    })
    .unwrap_or(false)
}

pub fn permission_status() -> String {
    java("schedule_native.android.permission", |env, class| {
        let obj = env
            .call_static_method(class, "permission", "()Ljava/lang/String;", &[])?
            .l()?;
        if obj.is_null() {
            return Ok("unavailable".into());
        }
        Ok(String::from(env.get_string(&JString::from(obj))?))
    })
    .unwrap_or_else(|_| "unavailable".into())
}

pub fn request_permission_blocking() -> Result<String, String> {
    let initial = java("schedule_native.android.requestPermission", |env, class| {
        let obj = env
            .call_static_method(class, "requestPermission", "()Ljava/lang/String;", &[])?
            .l()?;
        if obj.is_null() {
            return Ok("unavailable".into());
        }
        Ok(String::from(env.get_string(&JString::from(obj))?))
    })?;

    if initial != "undetermined" {
        return Ok(initial);
    }
    let deadline = Instant::now() + Duration::from_secs(60);
    while Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(60));
        let current = permission_status();
        if current != "undetermined" || !is_permission_pending() {
            return Ok(current);
        }
    }
    Ok(permission_status())
}

pub fn exact_alarm_status() -> ScheduleExactAlarmStatus {
    match java("schedule_native.android.exactAlarmStatus", |env, class| {
        let obj = env
            .call_static_method(class, "exactAlarmStatusJson", "()Ljava/lang/String;", &[])?
            .l()?;
        if obj.is_null() {
            return Ok(String::new());
        }
        Ok(String::from(env.get_string(&JString::from(obj))?))
    }) {
        Ok(json) if !json.is_empty() => serde_json::from_str(&json).unwrap_or_else(|err| {
            ScheduleExactAlarmStatus {
                mode: "unavailable".into(),
                degraded: true,
                can_open_settings: false,
                reason: format!("Invalid exact-alarm status JSON: {err}"),
            }
        }),
        Ok(_) => ScheduleExactAlarmStatus {
            mode: "unavailable".into(),
            degraded: true,
            can_open_settings: false,
            reason: "ScheduleBridge returned empty exact-alarm status".into(),
        },
        Err(reason) => ScheduleExactAlarmStatus {
            mode: "unavailable".into(),
            degraded: true,
            can_open_settings: false,
            reason,
        },
    }
}

pub fn open_exact_alarm_settings() -> Result<bool, String> {
    java(
        "schedule_native.android.openExactAlarmSettings",
        |env, class| {
            env.call_static_method(class, "openExactAlarmSettings", "()Z", &[])?
                .z()
        },
    )
}

pub fn sync_upcoming_alarms(alarms: &[ScheduleAlarmInput]) -> Result<ScheduleAlarmSyncResult, String> {
    let payload = serde_json::to_string(alarms).map_err(|err| {
        format!(
            "[stage=schedule_native.android.syncUpcomingAlarms code=ERR_SERIALIZE_ALARMS] {err}"
        )
    })?;
    let result_json = java("schedule_native.android.syncUpcomingAlarms", |env, class| {
        let j_payload = env.new_string(&payload)?;
        let obj = env
            .call_static_method(
                class,
                "syncUpcomingAlarms",
                "(Ljava/lang/String;)Ljava/lang/String;",
                &[JValue::Object(&j_payload)],
            )?
            .l()?;
        if obj.is_null() {
            return Ok(String::new());
        }
        Ok(String::from(env.get_string(&JString::from(obj))?))
    })?;
    serde_json::from_str(&result_json).map_err(|err| {
        format!(
            "[stage=schedule_native.android.syncUpcomingAlarms code=ERR_INVALID_SYNC_RESULT] {err}"
        )
    })
}

pub fn cancel_alarm(rule_id: &str) -> Result<bool, String> {
    java("schedule_native.android.cancelAlarm", |env, class| {
        let j_rule = env.new_string(rule_id)?;
        env.call_static_method(
            class,
            "cancelAlarm",
            "(Ljava/lang/String;)Z",
            &[JValue::Object(&j_rule)],
        )?
        .z()
    })
}

pub fn sync_quiet_hours(snapshot: &QuietHoursSnapshotInput) -> Result<(), String> {
    let json = serde_json::to_string(snapshot).map_err(|err| {
        format!("[stage=schedule_native.android.syncQuietHours code=ERR_SERIALIZE_QUIET] {err}")
    })?;
    java("schedule_native.android.syncQuietHours", |env, class| {
        let j_json = env.new_string(&json)?;
        env.call_static_method(
            class,
            "syncQuietHours",
            "(Ljava/lang/String;)V",
            &[JValue::Object(&j_json)],
        )?;
        Ok(())
    })
}

pub fn post_notification(payload: &PostNotificationInput) -> Result<String, String> {
    let json = serde_json::to_string(payload).map_err(|err| {
        format!(
            "[stage=schedule_native.android.postNotification code=ERR_SERIALIZE_NOTIFICATION] {err}"
        )
    })?;
    java("schedule_native.android.postNotification", |env, class| {
        let j_json = env.new_string(&json)?;
        let obj = env
            .call_static_method(
                class,
                "postNotification",
                "(Ljava/lang/String;)Ljava/lang/String;",
                &[JValue::Object(&j_json)],
            )?
            .l()?;
        if obj.is_null() {
            return Ok(String::new());
        }
        Ok(String::from(env.get_string(&JString::from(obj))?))
    })
}

pub fn set_android_keep_alive(
    active: bool,
    has_running_check: bool,
    next_trigger_at_ms: Option<f64>,
) -> Result<ScheduleKeepAliveState, String> {
    let next_ms = next_trigger_at_ms.unwrap_or(0.0);
    let json = java("schedule_native.android.keepAlive", |env, class| {
        let obj = env
            .call_static_method(
                class,
                "setKeepAlive",
                "(ZZD)Ljava/lang/String;",
                &[
                    JValue::Bool(active as jboolean),
                    JValue::Bool(has_running_check as jboolean),
                    JValue::Double(next_ms as jdouble),
                ],
            )?
            .l()?;
        if obj.is_null() {
            return Ok(String::new());
        }
        Ok(String::from(env.get_string(&JString::from(obj))?))
    })?;
    if json.is_empty() {
        return Ok(ScheduleKeepAliveState {
            active: false,
            has_running_check: false,
            quota_exhausted: false,
            daily_used_ms: 0.0,
            daily_cap_ms: ANDROID_DAILY_KEEPALIVE_CAP_MS,
            session_used_ms: 0.0,
            session_cap_ms: ANDROID_SESSION_KEEPALIVE_CAP_MS,
            reason: String::new(),
        });
    }
    serde_json::from_str(&json).map_err(|err| {
        format!("[stage=schedule_native.android.keepAlive code=ERR_INVALID_KEEPALIVE_STATE] {err}")
    })
}

pub fn begin_ios_background_grace(_label: &str) -> Result<String, String> {
    Ok(String::new())
}

pub fn end_ios_background_grace(_handle: &str) {}

pub fn drain_events() -> Vec<ScheduleNativeEvent> {
    let json = java("schedule_native.android.drainEvents", |env, class| {
        let obj = env
            .call_static_method(class, "drainEventsJson", "()Ljava/lang/String;", &[])?
            .l()?;
        if obj.is_null() {
            return Ok(String::new());
        }
        Ok(String::from(env.get_string(&JString::from(obj))?))
    })
    .unwrap_or_default();
    if json.trim().is_empty() {
        return Vec::new();
    }
    serde_json::from_str::<Vec<ScheduleNativeEvent>>(&json).unwrap_or_default()
}

pub fn set_foreground(active: bool) {
    let _ = java("schedule_native.android.setForeground", |env, class| {
        env.call_static_method(
            class,
            "foreground",
            "(Z)V",
            &[JValue::Bool(active as jboolean)],
        )?;
        Ok(())
    });
}
