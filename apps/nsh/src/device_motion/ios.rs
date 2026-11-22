//! iOS CoreMotion FFI bridge (`CMAttitudeReferenceFrameXArbitraryZVertical`) for `DeviceMotionHost`.

use super::{MotionSessionSink, format_motion_error};
use std::{
    ffi::{CStr, c_char, c_void},
    ptr,
    sync::Arc,
};

type SampleCallback = unsafe extern "C" fn(
    ctx: *mut c_void,
    qx: f64,
    qy: f64,
    qz: f64,
    qw: f64,
    monotonic_ms: f64,
    accuracy: i32,
);

type ErrorCallback = unsafe extern "C" fn(
    ctx: *mut c_void,
    stage: *const c_char,
    code: *const c_char,
    reason: *const c_char,
);

unsafe extern "C" {
    fn looi_device_motion_availability() -> i32;
    fn looi_device_motion_start(
        rate_hz: i32,
        ctx: *mut c_void,
        on_sample: SampleCallback,
        on_error: ErrorCallback,
        error_out: *mut *mut c_char,
    ) -> *mut c_void;
    fn looi_device_motion_stop(handle: *mut c_void);
    fn looi_device_motion_string_free(ptr: *mut c_char);
}

struct MotionCallbackContext {
    sink: MotionSessionSink,
}

unsafe extern "C" fn handle_sample(
    ctx: *mut c_void,
    qx: f64,
    qy: f64,
    qz: f64,
    qw: f64,
    monotonic_ms: f64,
    accuracy: i32,
) {
    if ctx.is_null() {
        return;
    }
    let callback_ctx = unsafe { &*(ctx as *const MotionCallbackContext) };
    callback_ctx.sink.push_quaternion(
        [qw, qx, qy, qz],
        monotonic_ms,
        "core_motion_gravity_z",
        accuracy,
    );
}

unsafe extern "C" fn handle_error(
    ctx: *mut c_void,
    stage: *const c_char,
    code: *const c_char,
    reason: *const c_char,
) {
    if ctx.is_null() {
        return;
    }
    let callback_ctx = unsafe { &*(ctx as *const MotionCallbackContext) };
    let stage_s = if stage.is_null() {
        "native.ios.motion.stream"
    } else {
        unsafe { CStr::from_ptr(stage) }.to_str().unwrap_or("native.ios.motion.stream")
    };
    let code_s = if code.is_null() {
        "ERR_DEVICE_MOTION_HARDWARE_FAULT"
    } else {
        unsafe { CStr::from_ptr(code) }.to_str().unwrap_or("ERR_DEVICE_MOTION_HARDWARE_FAULT")
    };
    let reason_s = if reason.is_null() {
        "CoreMotion hardware fault"
    } else {
        unsafe { CStr::from_ptr(reason) }.to_str().unwrap_or("CoreMotion hardware fault")
    };
    callback_ctx.sink.fail(stage_s, code_s, reason_s);
}

pub fn availability() -> String {
    if unsafe { looi_device_motion_availability() } != 0 {
        "available".to_string()
    } else {
        "unavailable".to_string()
    }
}

pub struct PlatformSession {
    handle: *mut c_void,
    ctx_ptr: *const MotionCallbackContext,
}

unsafe impl Send for PlatformSession {}

impl PlatformSession {
    pub fn start(rate_hz: i32, sink: MotionSessionSink) -> Result<Self, String> {
        let ctx = Arc::new(MotionCallbackContext { sink });
        let ctx_ptr = Arc::into_raw(ctx);
        let mut error_ptr: *mut c_char = ptr::null_mut();
        let handle = unsafe {
            looi_device_motion_start(
                rate_hz.clamp(10, 200),
                ctx_ptr.cast_mut().cast(),
                handle_sample,
                handle_error,
                &mut error_ptr,
            )
        };
        if handle.is_null() {
            drop(unsafe { Arc::from_raw(ctx_ptr) });
            let msg = if error_ptr.is_null() {
                "ERR_DEVICE_MOTION_UNAVAILABLE: Failed to start CoreMotion session".to_string()
            } else {
                let s = unsafe { CStr::from_ptr(error_ptr) }.to_string_lossy().into_owned();
                unsafe { looi_device_motion_string_free(error_ptr) };
                s
            };
            return Err(format_motion_error(
                "native.ios.motion.open",
                "ERR_DEVICE_MOTION_UNAVAILABLE",
                &msg,
            ));
        }
        Ok(Self { handle, ctx_ptr })
    }

    pub fn close(&mut self) {
        if !self.handle.is_null() {
            unsafe { looi_device_motion_stop(self.handle) };
            self.handle = ptr::null_mut();
        }
        if !self.ctx_ptr.is_null() {
            drop(unsafe { Arc::from_raw(self.ctx_ptr) });
            self.ctx_ptr = ptr::null();
        }
    }
}

impl Drop for PlatformSession {
    fn drop(&mut self) {
        self.close();
    }
}
