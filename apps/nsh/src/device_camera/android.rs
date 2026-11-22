//! Android Camera2 JNI bindings for `DeviceCameraHost`.
use super::{
    CroppedPortraitBytes, DetectedCameraNativeFace, EncodedFrame, FacesOnlyFrame,
    NativeSessionStatus, format_backend_error,
};
use jni::{
    JNIEnv, JavaVM,
    objects::{GlobalRef, JByteArray, JClass, JFloatArray, JLongArray, JString, JValue},
    sys::jboolean,
};
use std::{
    sync::OnceLock,
    time::{Duration, Instant},
};

static JAVA: OnceLock<(JavaVM, GlobalRef)> = OnceLock::new();

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_superlooi_nsh_DeviceCameraBridge_registerVm(
    env: JNIEnv<'_>,
    class: JClass<'_>,
) {
    if let (Ok(vm), Ok(class)) = (env.get_java_vm(), env.new_global_ref(class)) {
        let _ = JAVA.set((vm, class));
    }
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_superlooi_nsh_DeviceCameraBridge_foregroundChanged(
    _: JNIEnv<'_>,
    _: JClass<'_>,
    active: jboolean,
) {
    super::handle_platform_foreground_change(active != 0);
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
        return Some("ERR_DEVICE_CAMERA_ANDROID_EXCEPTION".into());
    }
    env.get_string(&JString::from(msg_obj))
        .ok()
        .map(|s| s.into())
}

fn java<T>(
    stage: &str,
    operation: impl FnOnce(&mut JNIEnv<'_>, &JClass<'_>) -> jni::errors::Result<T>,
) -> Result<T, String> {
    let (vm, class) = JAVA
        .get()
        .ok_or_else(|| format!("[stage={stage} code=ERR_DEVICE_CAMERA_UNAVAILABLE] Android DeviceCameraBridge VM not registered"))?;
    let mut env = vm
        .attach_current_thread()
        .map_err(|err| format!("[stage={stage} code=ERR_DEVICE_CAMERA_JNI_ATTACH] {err}"))?;
    let result = env.with_local_frame(32, |env| operation(env, class.as_obj().into()));
    match result {
        Ok(value) => Ok(value),
        Err(jni_err) => {
            let detail = extract_java_exception(&mut env).unwrap_or_else(|| jni_err.to_string());
            let _ = env.exception_clear();
            Err(format_backend_error(
                stage,
                "ERR_DEVICE_CAMERA_ANDROID_EXCEPTION",
                &detail,
            ))
        }
    }
}

fn is_permission_pending() -> bool {
    java("native.android.permissionPending", |env, class| {
        env.call_static_method(class, "isPermissionRequestPending", "()Z", &[])?
            .z()
    })
    .unwrap_or(false)
}

pub fn query_hfov(facing: &str) -> f64 {
    let facing_code = if facing == "back" { 1 } else { 0 };
    java("native.android.hfov", |env, class| {
        env.call_static_method(class, "queryHfovDeg", "(I)F", &[JValue::Int(facing_code)])?
            .f()
    })
    .map(|v| if v.is_finite() && v > 0.0 { v as f64 } else { 0.0 })
    .unwrap_or(0.0)
}

pub fn permission() -> String {
    java("native.android.permission", |env, class| {
        let obj = env
            .call_static_method(class, "permission", "()Ljava/lang/String;", &[])?
            .l()?;
        if obj.is_null() {
            return Ok("unavailable".into());
        }
        Ok(env.get_string(&JString::from(obj))?.into())
    })
    .unwrap_or_else(|_| "unavailable".into())
}

pub fn request_permission_blocking() -> String {
    let initial = java("native.android.requestPermission", |env, class| {
        let obj = env
            .call_static_method(class, "requestPermission", "()Ljava/lang/String;", &[])?
            .l()?;
        if obj.is_null() {
            return Ok("unavailable".into());
        }
        Ok(env.get_string(&JString::from(obj))?.into())
    })
    .unwrap_or_else(|_| "unavailable".into());

    if initial != "undetermined" {
        return initial;
    }
    let deadline = Instant::now() + Duration::from_secs(60);
    while Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(60));
        let current = permission();
        if current != "undetermined" || !is_permission_pending() {
            return current;
        }
    }
    permission()
}

pub struct PlatformSession {
    object: GlobalRef,
}

impl PlatformSession {
    pub fn open(id: &str, facing: &str, max_dimension: i32, max_fps: i32) -> Result<Self, String> {
        let facing_code = if facing == "back" { 1 } else { 0 };
        let object = java("native.android.open", |env, class| {
            let j_id = env.new_string(id)?;
            let obj = env
                .call_static_method(
                    class,
                    "create",
                    "(Ljava/lang/String;III)Lcom/superlooi/nsh/DeviceCameraBridge;",
                    &[
                        JValue::Object(&j_id),
                        JValue::Int(facing_code),
                        JValue::Int(max_dimension),
                        JValue::Int(max_fps),
                    ],
                )?
                .l()?;
            env.new_global_ref(obj)
        })?;
        Ok(Self { object })
    }

    pub fn reconfigure(&self, max_dimension: i32, max_fps: i32) -> Result<(), String> {
        java("native.android.reconfigure", |env, _| {
            env.call_method(
                self.object.as_obj(),
                "reconfigure",
                "(II)V",
                &[JValue::Int(max_dimension), JValue::Int(max_fps)],
            )?;
            Ok(())
        })
    }

    pub fn status(&self) -> NativeSessionStatus {
        java("native.android.status", |env, _| {
            let arr = env
                .call_method(self.object.as_obj(), "status", "()[J", &[])?
                .l()?;
            let mut values = [0i64; 7];
            env.get_long_array_region(JLongArray::from(arr), 0, &mut values)?;
            let failure_obj = env
                .call_method(self.object.as_obj(), "failure", "()Ljava/lang/String;", &[])?
                .l()?;
            let failure = if failure_obj.is_null() {
                None
            } else {
                Some(String::from(env.get_string(&JString::from(failure_obj))?))
            };
            Ok(NativeSessionStatus {
                frames: values[0].max(0) as u64,
                width: values[1] as i32,
                height: values[2] as i32,
                captured_at_ms: values[3],
                error: values[4] as i32,
                displayed: Some(values[5] != 0),
                failure,
            })
        })
        .unwrap_or(NativeSessionStatus {
            error: -1,
            failure: Some("ERR_DEVICE_CAMERA_STATUS_FAILED".into()),
            ..Default::default()
        })
    }

    pub fn jpeg(&self, max_dimension: i32) -> Result<EncodedFrame, String> {
        java("native.android.jpeg", |env, _| {
            let snap = env
                .call_method(
                    self.object.as_obj(),
                    "jpeg",
                    "(I)Lcom/superlooi/nsh/DeviceCameraBridge$Snapshot;",
                    &[JValue::Int(max_dimension)],
                )?
                .l()?;
            if snap.is_null() {
                return Ok(None);
            }
            let bytes = env.get_field(&snap, "data", "[B")?.l()?;
            let faces_obj = env.get_field(&snap, "faces", "[F")?.l()?;
            let faces = if faces_obj.is_null() {
                Vec::new()
            } else {
                let float_arr = JFloatArray::from(faces_obj);
                let len = env.get_array_length(&float_arr)?.max(0) as usize;
                let mut raw = vec![0.0f32; len.min(48)];
                if !raw.is_empty() {
                    env.get_float_array_region(float_arr, 0, &mut raw)?;
                }
                raw.chunks_exact(6)
                    .map(|chunk| DetectedCameraNativeFace {
                        track_id: chunk[0].max(0.0) as u32,
                        offset_x: (chunk[1] as f64).clamp(-1.0, 1.0),
                        offset_y: (chunk[2] as f64).clamp(-1.0, 1.0),
                        width: (chunk[3] as f64).clamp(0.0, 1.0),
                        height: (chunk[4] as f64).clamp(0.0, 1.0),
                        confidence: (chunk[5] as f64).clamp(0.0, 1.0),
                    })
                    .collect()
            };
            Ok(Some(EncodedFrame {
                jpeg: env.convert_byte_array(JByteArray::from(bytes))?,
                width: env.get_field(&snap, "width", "I")?.i()?.max(0) as u32,
                height: env.get_field(&snap, "height", "I")?.i()?.max(0) as u32,
                captured_at_ms: env.get_field(&snap, "capturedAt", "J")?.j()?,
                captured_monotonic_ms: env.get_field(&snap, "capturedMonotonicMs", "J")?.j()?.max(0) as f64,
                faces_monotonic_ms: env.get_field(&snap, "facesMonotonicMs", "J")?.j()?.max(0) as f64,
                hfov_deg: {
                    let v = env.get_field(&snap, "hfovDeg", "F")?.f()? as f64;
                    if v.is_finite() && v > 0.0 { v } else { 0.0 }
                },
                seq: env.get_field(&snap, "seq", "J")?.j()?.max(0) as u64,
                faces,
            }))
        })?
        .ok_or_else(|| {
            "[stage=native.android.jpeg code=ERR_DEVICE_CAMERA_FRAME_UNAVAILABLE] Latest camera frame is not ready".into()
        })
    }

    pub fn faces_only(&self) -> Result<FacesOnlyFrame, String> {
        java("native.android.faces", |env, _| {
            let snap = env
                .call_method(
                    self.object.as_obj(),
                    "facesSnapshot",
                    "()Lcom/superlooi/nsh/DeviceCameraBridge$FacesSnapshot;",
                    &[],
                )?
                .l()?;
            if snap.is_null() {
                return Ok(None);
            }
            let faces_obj = env.get_field(&snap, "faces", "[F")?.l()?;
            let faces = if faces_obj.is_null() {
                Vec::new()
            } else {
                let float_arr = JFloatArray::from(faces_obj);
                let len = env.get_array_length(&float_arr)?.max(0) as usize;
                let mut raw = vec![0.0f32; len.min(48)];
                if !raw.is_empty() {
                    env.get_float_array_region(float_arr, 0, &mut raw)?;
                }
                raw.chunks_exact(6)
                    .map(|chunk| DetectedCameraNativeFace {
                        track_id: chunk[0].max(0.0) as u32,
                        offset_x: (chunk[1] as f64).clamp(-1.0, 1.0),
                        offset_y: (chunk[2] as f64).clamp(-1.0, 1.0),
                        width: (chunk[3] as f64).clamp(0.0, 1.0),
                        height: (chunk[4] as f64).clamp(0.0, 1.0),
                        confidence: (chunk[5] as f64).clamp(0.0, 1.0),
                    })
                    .collect()
            };
            let hfov = env.get_field(&snap, "hfovDeg", "F")?.f()? as f64;
            Ok(Some(FacesOnlyFrame {
                width: env.get_field(&snap, "width", "I")?.i()?.max(0) as u32,
                height: env.get_field(&snap, "height", "I")?.i()?.max(0) as u32,
                captured_at_ms: env.get_field(&snap, "capturedAt", "J")?.j()?,
                captured_monotonic_ms: env.get_field(&snap, "capturedMonotonicMs", "J")?.j()?.max(0) as f64,
                faces_monotonic_ms: env.get_field(&snap, "facesMonotonicMs", "J")?.j()?.max(0) as f64,
                hfov_deg: if hfov.is_finite() && hfov > 0.0 { hfov } else { 0.0 },
                seq: env.get_field(&snap, "seq", "J")?.j()?.max(0) as u64,
                faces,
            }))
        })?
        .ok_or_else(|| {
            "[stage=native.android.faces code=ERR_DEVICE_CAMERA_FRAME_UNAVAILABLE] Latest camera faces snapshot is not ready".into()
        })
    }

    pub fn crop_jpeg(
        &self,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
        max_dimension: i32,
        jpeg_quality: i32,
    ) -> Result<CroppedPortraitBytes, String> {
        java("native.android.crop", |env, _| {
            let res = env
                .call_method(
                    self.object.as_obj(),
                    "cropJpeg",
                    "(FFFFII)Lcom/superlooi/nsh/DeviceCameraBridge$CropResult;",
                    &[
                        JValue::Float(x as f32),
                        JValue::Float(y as f32),
                        JValue::Float(width as f32),
                        JValue::Float(height as f32),
                        JValue::Int(max_dimension),
                        JValue::Int(jpeg_quality),
                    ],
                )?
                .l()?;
            if res.is_null() {
                return Ok(None);
            }
            let bytes = env.get_field(&res, "data", "[B")?.l()?;
            Ok(Some(CroppedPortraitBytes {
                jpeg: env.convert_byte_array(JByteArray::from(bytes))?,
                width: env.get_field(&res, "width", "I")?.i()?.max(0) as u32,
                height: env.get_field(&res, "height", "I")?.i()?.max(0) as u32,
                captured_monotonic_ms: env.get_field(&res, "capturedMonotonicMs", "J")?.j()?.max(0) as f64,
            }))
        })?
        .ok_or_else(|| {
            "[stage=native.android.crop code=ERR_DEVICE_CAMERA_CROP_FAILED] Failed to crop portrait from latest frame".into()
        })
    }

    pub fn close(&self) {
        let _ = java("native.android.close", |env, _| {
            env.call_method(self.object.as_obj(), "close", "()V", &[])?;
            Ok(())
        });
    }
}

impl Drop for PlatformSession {
    fn drop(&mut self) {
        self.close();
    }
}
