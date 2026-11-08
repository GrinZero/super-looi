use super::{ACTIVE, Navigation, Shared};
use jni::{
    JNIEnv, JavaVM,
    objects::{GlobalRef, JClass, JString, JValue},
    sys::{jboolean, jint, jlong},
};
use std::sync::OnceLock;
static JAVA: OnceLock<(JavaVM, GlobalRef)> = OnceLock::new();

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_superlooi_nsh_MiotLoginDialog_registerVm(
    env: JNIEnv<'_>,
    class: JClass<'_>,
) {
    if let (Ok(vm), Ok(class)) = (env.get_java_vm(), env.new_global_ref(class)) {
        let _ = JAVA.set((vm, class));
    }
}
fn with_java<T>(
    operation: impl FnOnce(&mut JNIEnv<'_>, &JClass<'_>) -> jni::errors::Result<T>,
) -> Result<T, String> {
    let (vm, class) = JAVA.get().ok_or("miot_browser_unavailable")?;
    let mut env = vm
        .attach_current_thread()
        .map_err(|_| "miot_browser_unavailable")?;
    let result = env.with_local_frame(16, |env| operation(env, class.as_obj().into()));
    if result.is_err() {
        let _ = env.exception_clear();
    }
    result.map_err(|_| "miot_browser_failed".into())
}
pub(super) fn open(session: &Shared, url: &str, english: bool) -> Result<(), String> {
    let id = session.lock().unwrap().id as jlong;
    let accepted = with_java(|env, class| {
        let url = env.new_string(url)?;
        env.call_static_method(
            class,
            "open",
            "(JLjava/lang/String;Z)Z",
            &[JValue::Long(id), JValue::Object(&url), JValue::Bool(english as u8)],
        )?
        .z()
    })?;
    if accepted {
        Ok(())
    } else {
        Err("miot_browser_unavailable".into())
    }
}
pub(super) fn close(id: u64) {
    let _ = with_java(|env, class| {
        env.call_static_method(class, "close", "(J)V", &[JValue::Long(id as jlong)])?;
        Ok(())
    });
}
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_superlooi_nsh_MiotLoginDialog_decide(
    mut env: JNIEnv<'_>,
    _: JClass<'_>,
    id: jlong,
    value: JString<'_>,
    main_frame: jboolean,
) -> jint {
    let Some(session) = ACTIVE.get().and_then(|slot| slot.lock().ok()?.upgrade()) else {
        return 0;
    };
    let Ok(value) = env.get_string(&value) else {
        let _ = env.exception_clear();
        return 0;
    };
    let value: String = value.into();
    let Ok(mut session) = session.lock() else {
        return 0;
    };
    if session.id != id as u64 {
        return 0;
    }
    match session.navigation(&value, main_frame != 0) {
        Navigation::Allow => 1,
        Navigation::Callback => 2,
        Navigation::Block => 0,
    }
}
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_superlooi_nsh_MiotLoginDialog_end(
    _: JNIEnv<'_>,
    _: JClass<'_>,
    id: jlong,
    reason: jint,
) {
    let Some(session) = ACTIVE.get().and_then(|slot| slot.lock().ok()?.upgrade()) else {
        return;
    };
    if let Ok(mut session) = session.lock() {
        if session.id == id as u64 {
            session.presented = false;
        }
        if session.id == id as u64 && reason != 2 {
            session.cancel();
            if reason == 1 {
                session.status = "failed";
            }
        }
    }
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_superlooi_nsh_MiotLoginDialog_shown(
    _: JNIEnv<'_>,
    _: JClass<'_>,
    id: jlong,
) {
    let Some(session) = ACTIVE.get().and_then(|slot| slot.lock().ok()?.upgrade()) else {
        return;
    };
    if let Ok(mut session) = session.lock() {
        if session.id == id as u64 && session.status == "loading" {
            session.presented = true;
        }
    }
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_superlooi_nsh_MiotLoginDialog_backgroundAll(
    _: JNIEnv<'_>,
    _: JClass<'_>,
) {
    let Some(session) = ACTIVE.get().and_then(|slot| slot.lock().ok()?.upgrade()) else {
        return;
    };
    if let Ok(mut session) = session.lock() {
        session.cancel();
    }
}
