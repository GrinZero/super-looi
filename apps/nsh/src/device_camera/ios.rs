//! iOS AVCaptureSession native FFI bindings for `DeviceCameraHost`.
use super::{DetectedCameraNativeFace, EncodedFrame, NativeSessionStatus, format_backend_error};
use std::ffi::{CStr, c_char, c_void};

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct LCDetectedFace {
    track_id: i32,
    offset_x: f32,
    offset_y: f32,
    width: f32,
    height: f32,
    confidence: f32,
}

unsafe extern "C" {
    fn looi_device_camera_permission() -> i32;
    fn looi_device_camera_request_permission() -> i32;
    fn looi_device_camera_create(
        facing: i32,
        max_dimension: i32,
        max_fps: i32,
        error_out: *mut *mut c_char,
    ) -> *mut c_void;
    fn looi_device_camera_reconfigure(handle: *mut c_void, max_dimension: i32, max_fps: i32);
    fn looi_device_camera_close(handle: *mut c_void);
    fn looi_device_camera_release(handle: *mut c_void);
    fn looi_device_camera_status(
        handle: *mut c_void,
        frames: *mut u64,
        width: *mut i32,
        height: *mut i32,
        captured_at_ms: *mut i64,
        error: *mut i32,
        displayed: *mut i32,
        failure_out: *mut *mut c_char,
    );
    fn looi_device_camera_jpeg(
        handle: *mut c_void,
        max_dimension: i32,
        length: *mut usize,
        width: *mut i32,
        height: *mut i32,
        captured_at_ms: *mut i64,
        seq: *mut u64,
    ) -> *mut u8;
    fn looi_device_camera_faces(
        handle: *mut c_void,
        out_faces: *mut LCDetectedFace,
        max_faces: i32,
    ) -> i32;
    fn looi_device_camera_bytes_free(bytes: *mut c_void);
    pub fn looi_device_camera_view_create() -> *mut c_void;
    pub fn looi_device_camera_view_bind(view: *mut c_void, session: *mut c_void);
    pub fn looi_device_camera_view_present_sample(
        view: *mut c_void,
        facing: i32,
        seq: u64,
        offset_x: f32,
        offset_y: f32,
        face_w: f32,
        face_h: f32,
    );
    pub fn looi_device_camera_view_release(view: *mut c_void);
}

fn map_permission(code: i32) -> &'static str {
    match code {
        1 => "granted",
        2 => "denied",
        3 => "unavailable",
        _ => "undetermined",
    }
}

unsafe fn take_c_string(ptr: *mut c_char) -> Option<String> {
    if ptr.is_null() {
        return None;
    }
    let text = unsafe { CStr::from_ptr(ptr).to_string_lossy().into_owned() };
    unsafe { looi_device_camera_bytes_free(ptr.cast()) };
    Some(text)
}

pub fn permission() -> String {
    map_permission(unsafe { looi_device_camera_permission() }).into()
}

pub fn request_permission_blocking() -> String {
    map_permission(unsafe { looi_device_camera_request_permission() }).into()
}

pub struct PlatformSession(pub *mut c_void);

// ObjC serializes session operations on dedicated dispatch queues and guards shared buffers via NSLock.
unsafe impl Send for PlatformSession {}
unsafe impl Sync for PlatformSession {}

impl PlatformSession {
    pub fn open(_id: &str, facing: &str, max_dimension: i32, max_fps: i32) -> Result<Self, String> {
        let facing_code = if facing == "back" { 1 } else { 0 };
        let mut error_ptr: *mut c_char = std::ptr::null_mut();
        let handle = unsafe {
            looi_device_camera_create(facing_code, max_dimension, max_fps, &mut error_ptr)
        };
        if handle.is_null() {
            let reason = unsafe { take_c_string(error_ptr) }
                .unwrap_or_else(|| "ERR_DEVICE_CAMERA_OPEN_FAILED".into());
            return Err(format_backend_error(
                "native.ios.open",
                "ERR_DEVICE_CAMERA_OPEN_FAILED",
                &reason,
            ));
        }
        Ok(Self(handle))
    }

    pub fn reconfigure(&self, max_dimension: i32, max_fps: i32) -> Result<(), String> {
        unsafe {
            looi_device_camera_reconfigure(self.0, max_dimension, max_fps);
        }
        Ok(())
    }

    pub fn status(&self) -> NativeSessionStatus {
        let mut frames = 0u64;
        let mut width = 0i32;
        let mut height = 0i32;
        let mut captured_at_ms = 0i64;
        let mut error = 0i32;
        let mut displayed = -1i32;
        let mut failure_ptr: *mut c_char = std::ptr::null_mut();
        unsafe {
            looi_device_camera_status(
                self.0,
                &mut frames,
                &mut width,
                &mut height,
                &mut captured_at_ms,
                &mut error,
                &mut displayed,
                &mut failure_ptr,
            );
        }
        let failure = unsafe { take_c_string(failure_ptr) };
        NativeSessionStatus {
            frames,
            width,
            height,
            captured_at_ms,
            error,
            displayed: (displayed >= 0).then_some(displayed != 0),
            failure,
        }
    }

    pub fn jpeg(&self, max_dimension: i32) -> Result<EncodedFrame, String> {
        let mut length = 0usize;
        let mut width = 0i32;
        let mut height = 0i32;
        let mut captured_at_ms = 0i64;
        let mut seq = 0u64;
        let bytes = unsafe {
            looi_device_camera_jpeg(
                self.0,
                max_dimension,
                &mut length,
                &mut width,
                &mut height,
                &mut captured_at_ms,
                &mut seq,
            )
        };
        if bytes.is_null() {
            return Err("[stage=native.ios.jpeg code=ERR_DEVICE_CAMERA_FRAME_UNAVAILABLE] Latest pixel buffer is not ready".into());
        }
        let data = unsafe { std::slice::from_raw_parts(bytes, length).to_vec() };
        unsafe {
            looi_device_camera_bytes_free(bytes.cast());
        }
        let mut raw_faces = [LCDetectedFace::default(); 8];
        let face_count = unsafe {
            looi_device_camera_faces(self.0, raw_faces.as_mut_ptr(), raw_faces.len() as i32)
        }
        .clamp(0, raw_faces.len() as i32) as usize;
        let faces = raw_faces[..face_count]
            .iter()
            .map(|face| DetectedCameraNativeFace {
                track_id: face.track_id.max(0) as u32,
                offset_x: (face.offset_x as f64).clamp(-1.0, 1.0),
                offset_y: (face.offset_y as f64).clamp(-1.0, 1.0),
                width: (face.width as f64).clamp(0.0, 1.0),
                height: (face.height as f64).clamp(0.0, 1.0),
                confidence: (face.confidence as f64).clamp(0.0, 1.0),
            })
            .collect();
        Ok(EncodedFrame {
            jpeg: data,
            width: width.max(0) as u32,
            height: height.max(0) as u32,
            captured_at_ms,
            seq,
            faces,
        })
    }

    pub fn close(&self) {
        unsafe {
            looi_device_camera_close(self.0);
        }
    }
}

impl Drop for PlatformSession {
    fn drop(&mut self) {
        unsafe {
            looi_device_camera_release(self.0);
        }
    }
}
