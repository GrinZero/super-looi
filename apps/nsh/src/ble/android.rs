use super::{SharedBle, active_shared, encode_hex};
use jni::{
    JNIEnv, JavaVM,
    objects::{GlobalRef, JByteArray, JClass, JString, JValue},
    sys::{jboolean, jint, jlong},
};
use std::sync::OnceLock;

static JAVA_BLE: OnceLock<(JavaVM, GlobalRef)> = OnceLock::new();

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_superlooi_nsh_LooiBleBridge_registerVm(
    env: JNIEnv<'_>,
    class: JClass<'_>,
) {
    if let (Ok(vm), Ok(class)) = (env.get_java_vm(), env.new_global_ref(class)) {
        let _ = JAVA_BLE.set((vm, class));
    }
}

fn with_java<T>(
    operation: impl FnOnce(&mut JNIEnv<'_>, &JClass<'_>) -> jni::errors::Result<T>,
) -> Result<T, String> {
    let (vm, class) = JAVA_BLE.get().ok_or("Android BLE bridge unavailable")?;
    let mut env = vm
        .attach_current_thread()
        .map_err(|_| "Android BLE bridge thread attach failed")?;
    let result = env.with_local_frame(16, |env| operation(env, class.as_obj().into()));
    if result.is_err() {
        let _ = env.exception_clear();
    }
    result.map_err(|_| "Android BLE operation failed".into())
}

pub(super) fn permission() -> String {
    with_java(|env, class| {
        let obj = env
            .call_static_method(class, "permission", "()Ljava/lang/String;", &[])?
            .l()?;
        let s: String = env.get_string(&JString::from(obj))?.into();
        Ok(s)
    })
    .unwrap_or_else(|_| "unavailable".into())
}

pub(super) fn request_permission() -> String {
    with_java(|env, class| {
        let obj = env
            .call_static_method(class, "requestPermission", "()Ljava/lang/String;", &[])?
            .l()?;
        let s: String = env.get_string(&JString::from(obj))?.into();
        Ok(s)
    })
    .unwrap_or_else(|_| "unavailable".into())
}

pub(super) fn start_scan(_shared: &SharedBle) -> Result<(), String> {
    let ok = with_java(|env, class| {
        env.call_static_method(class, "startScan", "()Z", &[])?.z()
    })?;
    if ok {
        Ok(())
    } else {
        Err("无法启动蓝牙扫描，请检查蓝牙与权限".into())
    }
}

pub(super) fn stop_scan() {
    let _ = with_java(|env, class| {
        env.call_static_method(class, "stopScan", "()V", &[])?;
        Ok(())
    });
}

pub(super) fn connect(_shared: &SharedBle, generation: u64, device_id: &str) -> Result<(), String> {
    let ok = with_java(|env, class| {
        let dev = env.new_string(device_id)?;
        env.call_static_method(
            class,
            "connect",
            "(JLjava/lang/String;)Z",
            &[JValue::Long(generation as jlong), JValue::Object(&dev)],
        )?
        .z()
    })?;
    if ok {
        Ok(())
    } else {
        Err("无法连接到指定 LOOI 底座".into())
    }
}

pub(super) fn disconnect() {
    let _ = with_java(|env, class| {
        env.call_static_method(class, "disconnect", "()V", &[])?;
        Ok(())
    });
}

pub(super) fn write(
    generation: u64,
    characteristic_uuid: &str,
    bytes: &[u8],
    with_response: bool,
) -> Result<(), String> {
    let ok = with_java(|env, class| {
        let uuid = env.new_string(characteristic_uuid)?;
        let payload = env.byte_array_from_slice(bytes)?;
        env.call_static_method(
            class,
            "write",
            "(JLjava/lang/String;[BZ)Z",
            &[
                JValue::Long(generation as jlong),
                JValue::Object(&uuid),
                JValue::Object(&payload),
                JValue::Bool(with_response as jboolean),
            ],
        )?
        .z()
    })?;
    if ok {
        Ok(())
    } else {
        Err("蓝牙特征值写入失败".into())
    }
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_superlooi_nsh_LooiBleBridge_onDeviceFound(
    mut env: JNIEnv<'_>,
    _: JClass<'_>,
    id: JString<'_>,
    name: JString<'_>,
    rssi: jint,
) {
    let Some(shared) = active_shared() else { return };
    let Ok(id) = env.get_string(&id).map(String::from) else {
        let _ = env.exception_clear();
        return;
    };
    let name = env.get_string(&name).map(String::from).unwrap_or_default();
    if let Ok(mut state) = shared.lock() {
        state.upsert_candidate(id, name, rssi);
    }
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_superlooi_nsh_LooiBleBridge_onConnected(
    mut env: JNIEnv<'_>,
    _: JClass<'_>,
    generation: jlong,
    id: JString<'_>,
    name: JString<'_>,
) {
    let Some(shared) = active_shared() else { return };
    let id = env.get_string(&id).map(String::from).unwrap_or_default();
    let name = env.get_string(&name).map(String::from).unwrap_or_default();
    if let Ok(mut state) = shared.lock() {
        state.on_connected(generation as u64, &id, &name);
    }
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_superlooi_nsh_LooiBleBridge_onDisconnected(
    mut env: JNIEnv<'_>,
    _: JClass<'_>,
    generation: jlong,
    reason: JString<'_>,
) {
    let Some(shared) = active_shared() else { return };
    let reason = env.get_string(&reason).map(String::from).unwrap_or_default();
    if let Ok(mut state) = shared.lock() {
        state.on_disconnected(generation as u64, &reason);
    }
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_superlooi_nsh_LooiBleBridge_onNotification(
    mut env: JNIEnv<'_>,
    _: JClass<'_>,
    generation: jlong,
    uuid: JString<'_>,
    bytes: JByteArray<'_>,
) {
    let Some(shared) = active_shared() else { return };
    let Ok(uuid) = env.get_string(&uuid).map(String::from) else {
        let _ = env.exception_clear();
        return;
    };
    let Ok(raw) = env.convert_byte_array(&bytes) else {
        let _ = env.exception_clear();
        return;
    };
    let hex = encode_hex(&raw);
    if let Ok(mut state) = shared.lock() {
        state.on_notification(generation as u64, &uuid, &hex);
    }
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_superlooi_nsh_LooiBleBridge_onWriteAck(
    mut env: JNIEnv<'_>,
    _: JClass<'_>,
    generation: jlong,
    uuid: JString<'_>,
) {
    let Some(shared) = active_shared() else { return };
    let Ok(uuid) = env.get_string(&uuid).map(String::from) else {
        let _ = env.exception_clear();
        return;
    };
    if let Ok(mut state) = shared.lock() {
        state.on_write_ack(generation as u64, &uuid);
    }
}
