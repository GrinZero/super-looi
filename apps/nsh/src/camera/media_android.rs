use super::media::{Jpeg, Status};
use super::video::{VideoFormat, VideoPacket};
use jni::{
    JNIEnv, JavaVM,
    objects::{GlobalRef, JByteArray, JClass, JLongArray, JObject, JValue},
    sys::jboolean,
};
use std::sync::{Mutex, OnceLock};
static JAVA: OnceLock<(JavaVM, GlobalRef)> = OnceLock::new();
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_superlooi_nsh_CameraMedia_registerVm(
    env: JNIEnv<'_>,
    class: JClass<'_>,
) {
    if let (Ok(vm), Ok(class)) = (env.get_java_vm(), env.new_global_ref(class)) {
        let _ = JAVA.set((vm, class));
    }
}
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_superlooi_nsh_CameraMedia_foregroundChanged(
    _: JNIEnv<'_>,
    _: JClass<'_>,
    active: jboolean,
) {
    super::APP_ACTIVE.store(active != 0, std::sync::atomic::Ordering::Release);
    if active == 0 {
        super::APP_EPOCH.fetch_add(1, std::sync::atomic::Ordering::AcqRel);
        let sessions: Vec<_> = super::sessions()
            .lock()
            .unwrap()
            .values()
            .filter_map(std::sync::Weak::upgrade)
            .collect();
        for session in sessions {
            session.close();
        }
    }
}
fn java<T>(
    operation: impl FnOnce(&mut JNIEnv<'_>, &JClass<'_>) -> jni::errors::Result<T>,
) -> Result<T, String> {
    let (vm, class) = JAVA.get().ok_or("camera_decoder_unavailable")?;
    let mut env = vm
        .attach_current_thread()
        .map_err(|_| "camera_jni_attach_failed")?;
    let result = env.with_local_frame(32, |env| operation(env, class.as_obj().into()));
    if result.is_err() {
        let _ = env.exception_clear();
    }
    result.map_err(|_| "camera_android_media_failed".into())
}
pub struct Decoder {
    object: GlobalRef,
    format: Mutex<VideoFormat>,
}
impl Decoder {
    pub fn new(id: &str) -> Result<Self, String> {
        let object = java(|env, class| {
            let id = env.new_string(id)?;
            let object = env
                .call_static_method(
                    class,
                    "create",
                    "(Ljava/lang/String;)Lcom/superlooi/nsh/CameraMedia;",
                    &[JValue::Object(&id)],
                )?
                .l()?;
            env.new_global_ref(object)
        })?;
        Ok(Self {
            object,
            format: Mutex::new(VideoFormat::default()),
        })
    }
    pub fn close(&self) {
        let _ = java(|env, _| {
            env.call_method(self.object.as_obj(), "close", "()V", &[])?;
            Ok(())
        });
    }
    pub fn feed(&self, packet: &VideoPacket) -> Result<(), String> {
        let mut format = self.format.lock().unwrap();
        format.update(packet)?;
        if !format.ready() {
            return Ok(());
        }
        java(|env, _| {
            let bytes = env.byte_array_from_slice(&packet.data)?;
            let csd = env.byte_array_from_slice(&format.csd())?;
            env.call_method(
                self.object.as_obj(),
                "feed",
                "([BIII[BJJ)V",
                &[
                    JValue::Object(&bytes),
                    JValue::Int(packet.codec as i32),
                    JValue::Int(format.width as i32),
                    JValue::Int(format.height as i32),
                    JValue::Object(&csd),
                    JValue::Long(format.revision as i64),
                    JValue::Long(packet.timestamp_ms as i64),
                ],
            )?;
            Ok(())
        })
    }
    pub fn status(&self) -> Status {
        java(|env, _| {
            let value = env
                .call_method(self.object.as_obj(), "status", "()[J", &[])?
                .l()?;
            let mut values = [0i64; 6];
            env.get_long_array_region(JLongArray::from(value), 0, &mut values)?;
            Ok(Status {
                frames: values[0] as u64,
                width: values[1] as i32,
                height: values[2] as i32,
                timestamp_ms: values[3],
                error: values[4] as i32,
                displayed: Some(values[5] != 0),
            })
        })
        .unwrap_or_else(|_| Status {
            error: -1,
            ..Default::default()
        })
    }
    pub fn jpeg(&self) -> Result<Jpeg, String> {
        java(|env, _| {
            let snapshot = env
                .call_method(
                    self.object.as_obj(),
                    "jpeg",
                    "()Lcom/superlooi/nsh/CameraMedia$Snapshot;",
                    &[],
                )?
                .l()?;
            if snapshot.is_null() {
                return Ok(None);
            }
            let bytes = env.get_field(&snapshot, "data", "[B")?.l()?;
            Ok(Some(Jpeg {
                data: env.convert_byte_array(JByteArray::from(bytes))?,
                width: env.get_field(&snapshot, "width", "I")?.i()?,
                height: env.get_field(&snapshot, "height", "I")?.i()?,
                received_at: env.get_field(&snapshot, "receivedAt", "J")?.j()?,
            }))
        })?
        .ok_or("camera_frame_unavailable".into())
    }
}
impl Drop for Decoder {
    fn drop(&mut self) {
        self.close();
    }
}
