#![allow(non_camel_case_types, non_snake_case)]
//! Pure-Rust Android NDK `libandroid.so` (`ASensorManager`) 6-axis IMU backend without magnetometers or extra Java glue.

use super::{MotionSessionSink, format_motion_error};
use crate::host_monotonic_ms;
use std::{
    ffi::{CStr, c_char, c_int, c_void},
    ptr,
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread::{self, JoinHandle},
    time::Duration,
};

const ASENSOR_TYPE_ACCELEROMETER: c_int = 1;
const ASENSOR_TYPE_GYROSCOPE: c_int = 4;
const ASENSOR_TYPE_GRAVITY: c_int = 9;
const ASENSOR_TYPE_GAME_ROTATION_VECTOR: c_int = 15;
const ALOOPER_PREPARE_ALLOW_NON_CALLBACKS: c_int = 1;

#[repr(C)]
struct ASensorManager {
    _private: [u8; 0],
}

#[repr(C)]
struct ASensor {
    _private: [u8; 0],
}

#[repr(C)]
struct ASensorEventQueue {
    _private: [u8; 0],
}

#[repr(C)]
struct ALooper {
    _private: [u8; 0],
}

#[repr(C)]
#[derive(Clone, Copy)]
struct ASensorEvent {
    version: i32,
    sensor: i32,
    sensor_type: i32,
    reserved0: i32,
    timestamp: i64,
    data: [f32; 16],
    flags: u32,
    reserved1: [i32; 3],
}

const _: () = assert!(std::mem::size_of::<ASensorEvent>() == 104);

struct NdkSensorApi {
    _lib_handle: *mut c_void,
    get_instance: unsafe extern "C" fn() -> *mut ASensorManager,
    get_instance_for_package: Option<unsafe extern "C" fn(*const c_char) -> *mut ASensorManager>,
    get_default_sensor: unsafe extern "C" fn(*mut ASensorManager, c_int) -> *const ASensor,
    get_min_delay: Option<unsafe extern "C" fn(*const ASensor) -> c_int>,
    create_event_queue: unsafe extern "C" fn(
        *mut ASensorManager,
        *mut ALooper,
        c_int,
        *const c_void,
        *mut c_void,
    ) -> *mut ASensorEventQueue,
    destroy_event_queue: unsafe extern "C" fn(*mut ASensorManager, *mut ASensorEventQueue) -> c_int,
    enable_sensor: unsafe extern "C" fn(*mut ASensorEventQueue, *const ASensor) -> c_int,
    disable_sensor: unsafe extern "C" fn(*mut ASensorEventQueue, *const ASensor) -> c_int,
    set_event_rate: unsafe extern "C" fn(*mut ASensorEventQueue, *const ASensor, i32) -> c_int,
    get_events: unsafe extern "C" fn(*mut ASensorEventQueue, *mut ASensorEvent, usize) -> isize,
    looper_prepare: unsafe extern "C" fn(c_int) -> *mut ALooper,
    looper_poll_once: unsafe extern "C" fn(c_int, *mut c_int, *mut c_int, *mut *mut c_void) -> c_int,
    looper_wake: Option<unsafe extern "C" fn(*mut ALooper)>,
}

unsafe impl Send for NdkSensorApi {}
unsafe impl Sync for NdkSensorApi {}

unsafe fn resolve_symbol<T: Copy>(
    handle: *mut c_void,
    name: &'static CStr,
) -> Result<T, String> {
    let sym = unsafe { libc::dlsym(handle, name.as_ptr()) };
    if sym.is_null() {
        return Err(format!(
            "[stage=native.android.motion.dlsym code=ERR_DEVICE_MOTION_UNAVAILABLE] Missing libandroid symbol {}",
            name.to_string_lossy()
        ));
    }
    Ok(unsafe { std::mem::transmute_copy::<*mut c_void, T>(&sym) })
}

unsafe fn resolve_optional_symbol<T: Copy>(handle: *mut c_void, name: &'static CStr) -> Option<T> {
    let sym = unsafe { libc::dlsym(handle, name.as_ptr()) };
    if sym.is_null() {
        None
    } else {
        Some(unsafe { std::mem::transmute_copy::<*mut c_void, T>(&sym) })
    }
}

fn load_ndk_sensor_api() -> Result<&'static NdkSensorApi, String> {
    static API: OnceLock<Result<NdkSensorApi, String>> = OnceLock::new();
    let res = API.get_or_init(|| unsafe {
        let handle = libc::dlopen(c"libandroid.so".as_ptr(), libc::RTLD_NOW);
        if handle.is_null() {
            let err_ptr = libc::dlerror();
            let detail = if err_ptr.is_null() {
                "dlopen(libandroid.so) returned null".to_string()
            } else {
                CStr::from_ptr(err_ptr).to_string_lossy().into_owned()
            };
            return Err(format!(
                "[stage=native.android.motion.dlopen code=ERR_DEVICE_MOTION_UNAVAILABLE] {detail}"
            ));
        }

        Ok(NdkSensorApi {
            _lib_handle: handle,
            get_instance: resolve_symbol(handle, c"ASensorManager_getInstance")?,
            get_instance_for_package: resolve_optional_symbol(
                handle,
                c"ASensorManager_getInstanceForPackage",
            ),
            get_default_sensor: resolve_symbol(handle, c"ASensorManager_getDefaultSensor")?,
            get_min_delay: resolve_optional_symbol(handle, c"ASensor_getMinDelay"),
            create_event_queue: resolve_symbol(handle, c"ASensorManager_createEventQueue")?,
            destroy_event_queue: resolve_symbol(handle, c"ASensorManager_destroyEventQueue")?,
            enable_sensor: resolve_symbol(handle, c"ASensorEventQueue_enableSensor")?,
            disable_sensor: resolve_symbol(handle, c"ASensorEventQueue_disableSensor")?,
            set_event_rate: resolve_symbol(handle, c"ASensorEventQueue_setEventRate")?,
            get_events: resolve_symbol(handle, c"ASensorEventQueue_getEvents")?,
            looper_prepare: resolve_symbol(handle, c"ALooper_prepare")?,
            looper_poll_once: resolve_symbol(handle, c"ALooper_pollOnce")?,
            looper_wake: resolve_optional_symbol(handle, c"ALooper_wake"),
        })
    });
    res.as_ref().map_err(Clone::clone)
}

fn read_runtime_package_cstr() -> Option<std::ffi::CString> {
    let bytes = std::fs::read("/proc/self/cmdline").ok()?;
    let end = bytes.iter().position(|&b| b == 0).unwrap_or(bytes.len());
    let name = std::str::from_utf8(&bytes[..end]).ok()?.trim();
    if name.is_empty() {
        None
    } else {
        std::ffi::CString::new(name).ok()
    }
}

unsafe fn acquire_sensor_manager(api: &NdkSensorApi) -> Result<*mut ASensorManager, String> {
    let mut mgr = unsafe { (api.get_instance)() };
    if mgr.is_null() {
        if let Some(for_pkg) = api.get_instance_for_package {
            if let Some(pkg_cstr) = read_runtime_package_cstr() {
                mgr = unsafe { for_pkg(pkg_cstr.as_ptr()) };
            }
        }
    }
    if mgr.is_null() {
        return Err(
            "[stage=native.android.motion.open code=ERR_DEVICE_MOTION_UNAVAILABLE] ASensorManager singleton unavailable"
                .into(),
        );
    }
    Ok(mgr)
}

pub fn availability() -> String {
    let Ok(api) = load_ndk_sensor_api() else {
        return "unavailable".to_string();
    };
    unsafe {
        let Ok(mgr) = acquire_sensor_manager(api) else {
            return "unavailable".to_string();
        };
        let game_rv = (api.get_default_sensor)(mgr, ASENSOR_TYPE_GAME_ROTATION_VECTOR);
        let gyro = (api.get_default_sensor)(mgr, ASENSOR_TYPE_GYROSCOPE);
        if !game_rv.is_null() || !gyro.is_null() {
            "available".to_string()
        } else {
            "unavailable".to_string()
        }
    }
}

pub struct PlatformSession {
    api: &'static NdkSensorApi,
    stop_flag: Arc<AtomicBool>,
    looper_ptr: Arc<Mutex<Option<usize>>>,
    worker: Option<JoinHandle<()>>,
}

enum SensorMode {
    GameRotationVector(*const ASensor),
    GyroGravity {
        gyro: *const ASensor,
        gravity: *const ASensor,
        is_accel_fallback: bool,
    },
}

unsafe impl Send for SensorMode {}

impl PlatformSession {
    pub fn start(rate_hz: i32, sink: MotionSessionSink) -> Result<Self, String> {
        let api = load_ndk_sensor_api()?;
        let clamped_hz = rate_hz.clamp(10, 200);
        let period_us = (1_000_000 / clamped_hz).max(5_000);
        let stop_flag = Arc::new(AtomicBool::new(false));
        let looper_ptr = Arc::new(Mutex::new(None));

        let stop_clone = stop_flag.clone();
        let looper_clone = looper_ptr.clone();
        let (ready_tx, ready_rx) = mpsc::sync_channel::<Result<(), String>>(1);

        let worker = thread::Builder::new()
            .name("looi-android-imu".to_string())
            .spawn(move || unsafe {
                let mgr = match acquire_sensor_manager(api) {
                    Ok(m) => m,
                    Err(e) => {
                        let _ = ready_tx.send(Err(e));
                        return;
                    }
                };

                let game_rv = (api.get_default_sensor)(mgr, ASENSOR_TYPE_GAME_ROTATION_VECTOR);
                let mode = if !game_rv.is_null() {
                    SensorMode::GameRotationVector(game_rv)
                } else {
                    let gyro = (api.get_default_sensor)(mgr, ASENSOR_TYPE_GYROSCOPE);
                    if gyro.is_null() {
                        let _ = ready_tx.send(Err(
                            "[stage=native.android.motion.open code=ERR_DEVICE_MOTION_UNAVAILABLE] Neither GAME_ROTATION_VECTOR nor GYROSCOPE sensor is available".into(),
                        ));
                        return;
                    }
                    let gravity = (api.get_default_sensor)(mgr, ASENSOR_TYPE_GRAVITY);
                    if !gravity.is_null() {
                        SensorMode::GyroGravity {
                            gyro,
                            gravity,
                            is_accel_fallback: false,
                        }
                    } else {
                        let accel = (api.get_default_sensor)(mgr, ASENSOR_TYPE_ACCELEROMETER);
                        if accel.is_null() {
                            let _ = ready_tx.send(Err(
                                "[stage=native.android.motion.open code=ERR_DEVICE_MOTION_UNAVAILABLE] GYROSCOPE available but neither GRAVITY nor ACCELEROMETER sensor exists".into(),
                            ));
                            return;
                        }
                        SensorMode::GyroGravity {
                            gyro,
                            gravity: accel,
                            is_accel_fallback: true,
                        }
                    }
                };

                let looper = (api.looper_prepare)(ALOOPER_PREPARE_ALLOW_NON_CALLBACKS);
                if looper.is_null() {
                    let _ = ready_tx.send(Err(
                        "[stage=native.android.motion.open code=ERR_DEVICE_MOTION_HARDWARE_FAULT] ALooper_prepare returned null".into(),
                    ));
                    return;
                }
                *looper_clone.lock().unwrap() = Some(looper as usize);

                let queue = (api.create_event_queue)(mgr, looper, 1, ptr::null(), ptr::null_mut());
                if queue.is_null() {
                    *looper_clone.lock().unwrap() = None;
                    let _ = ready_tx.send(Err(
                        "[stage=native.android.motion.open code=ERR_DEVICE_MOTION_HARDWARE_FAULT] ASensorManager_createEventQueue returned null".into(),
                    ));
                    return;
                }

                let enable_one = |sensor: *const ASensor, name: &str| -> Result<(), String> {
                    let rc = (api.enable_sensor)(queue, sensor);
                    if rc < 0 {
                        return Err(format!(
                            "[stage=native.android.motion.open code=ERR_DEVICE_MOTION_HARDWARE_FAULT] ASensorEventQueue_enableSensor({name}) failed rc={rc}"
                        ));
                    }
                    let mut effective_period_us = period_us;
                    if let Some(get_min_delay) = api.get_min_delay {
                        let min_delay = get_min_delay(sensor);
                        if min_delay > 0 {
                            effective_period_us = effective_period_us.max(min_delay);
                        }
                    }
                    let rate_rc = (api.set_event_rate)(queue, sensor, effective_period_us);
                    if rate_rc < 0 {
                        return Err(format!(
                            "[stage=native.android.motion.open code=ERR_DEVICE_MOTION_HARDWARE_FAULT] ASensorEventQueue_setEventRate({name}) failed rc={rate_rc}"
                        ));
                    }
                    Ok(())
                };

                let init_result = match mode {
                    SensorMode::GameRotationVector(s) => enable_one(s, "GAME_ROTATION_VECTOR"),
                    SensorMode::GyroGravity {
                        gyro,
                        gravity,
                        is_accel_fallback,
                    } => {
                        let g_name = if is_accel_fallback {
                            "ACCELEROMETER"
                        } else {
                            "GRAVITY"
                        };
                        enable_one(gravity, g_name).and_then(|_| enable_one(gyro, "GYROSCOPE"))
                    }
                };
                if let Err(err) = init_result {
                    (api.destroy_event_queue)(mgr, queue);
                    *looper_clone.lock().unwrap() = None;
                    let _ = ready_tx.send(Err(err));
                    return;
                }

                let _ = ready_tx.send(Ok(()));

                let mut events: [ASensorEvent; 16] = [std::mem::zeroed(); 16];
                let mut gravity_vec: Option<[f64; 3]> = None;
                let mut prev_gyro_ns: Option<i64> = None;

                let mut fatal_read_error = false;
                while !stop_clone.load(Ordering::Acquire) && !fatal_read_error {
                    (api.looper_poll_once)(50, ptr::null_mut(), ptr::null_mut(), ptr::null_mut());
                    if stop_clone.load(Ordering::Acquire) {
                        break;
                    }
                    loop {
                        let count = (api.get_events)(queue, events.as_mut_ptr(), events.len());
                        if count == 0 || count == -(libc::EAGAIN as isize) {
                            break;
                        }
                        if count < 0 {
                            sink.fail(
                                "native.android.motion.read",
                                "ERR_DEVICE_MOTION_HARDWARE_FAULT",
                                &format!(
                                    "ASensorEventQueue_getEvents failed rc={count} (errno={})",
                                    -count
                                ),
                            );
                            fatal_read_error = true;
                            break;
                        }
                        let n = (count as usize).min(events.len());
                        let mono_ms = host_monotonic_ms();
                        for ev in &events[..n] {
                            match (&mode, ev.sensor_type) {
                                (SensorMode::GameRotationVector(_), ASENSOR_TYPE_GAME_ROTATION_VECTOR) => {
                                    let x = ev.data[0] as f64;
                                    let y = ev.data[1] as f64;
                                    let z = ev.data[2] as f64;
                                    let w_raw = ev.data[3] as f64;
                                    let vec_sq = x * x + y * y + z * z;
                                    let w = if w_raw.abs() < 1e-6 && vec_sq < 0.999 {
                                        (1.0 - vec_sq).max(0.0).sqrt()
                                    } else {
                                        w_raw
                                    };
                                    sink.push_quaternion(
                                        [w, x, y, z],
                                        mono_ms,
                                        "game_rotation_vector",
                                        3,
                                    );
                                }
                                (
                                    SensorMode::GyroGravity { is_accel_fallback, .. },
                                    ASENSOR_TYPE_GRAVITY | ASENSOR_TYPE_ACCELEROMETER,
                                ) => {
                                    let sample_g = [
                                        ev.data[0] as f64,
                                        ev.data[1] as f64,
                                        ev.data[2] as f64,
                                    ];
                                    gravity_vec = Some(match gravity_vec {
                                        Some(prev) if *is_accel_fallback => [
                                            prev[0] * 0.8 + sample_g[0] * 0.2,
                                            prev[1] * 0.8 + sample_g[1] * 0.2,
                                            prev[2] * 0.8 + sample_g[2] * 0.2,
                                        ],
                                        _ => sample_g,
                                    });
                                }
                                (SensorMode::GyroGravity { .. }, ASENSOR_TYPE_GYROSCOPE) => {
                                    if let Some(prev_ns) = prev_gyro_ns {
                                        let dt_sec = (ev.timestamp - prev_ns) as f64 / 1e9;
                                        if dt_sec > 0.0 && dt_sec <= 0.25 {
                                            if let Some(g) = gravity_vec {
                                                sink.push_gyro_step(
                                                    [ev.data[0] as f64, ev.data[1] as f64, ev.data[2] as f64],
                                                    g,
                                                    dt_sec,
                                                    mono_ms,
                                                    "gyro_gravity_fallback",
                                                    2,
                                                );
                                            }
                                        }
                                    }
                                    prev_gyro_ns = Some(ev.timestamp);
                                }
                                _ => {}
                            }
                        }
                    }
                }

                match mode {
                    SensorMode::GameRotationVector(s) => {
                        (api.disable_sensor)(queue, s);
                    }
                    SensorMode::GyroGravity { gyro, gravity, .. } => {
                        (api.disable_sensor)(queue, gyro);
                        (api.disable_sensor)(queue, gravity);
                    }
                }
                (api.destroy_event_queue)(mgr, queue);
                *looper_clone.lock().unwrap() = None;
            })
            .map_err(|err| {
                format_motion_error(
                    "native.android.motion.thread",
                    "ERR_DEVICE_MOTION_HARDWARE_FAULT",
                    &err.to_string(),
                )
            })?;

        match ready_rx.recv_timeout(Duration::from_secs(3)) {
            Ok(Ok(())) => Ok(Self {
                api,
                stop_flag,
                looper_ptr,
                worker: Some(worker),
            }),
            Ok(Err(err)) => {
                stop_flag.store(true, Ordering::Release);
                let _ = worker.join();
                Err(err)
            }
            Err(_) => {
                stop_flag.store(true, Ordering::Release);
                if let Some(ptr) = *looper_ptr.lock().unwrap() {
                    if let Some(wake) = api.looper_wake {
                        unsafe { wake(ptr as *mut ALooper) };
                    }
                }
                let _ = worker.join();
                Err(
                    "[stage=native.android.motion.open code=ERR_DEVICE_MOTION_OPEN_TIMEOUT] Timed out initializing Android NDK sensor thread"
                        .into(),
                )
            }
        }
    }

    pub fn close(&mut self) {
        self.stop_flag.store(true, Ordering::Release);
        {
            let guard = self.looper_ptr.lock().unwrap();
            if let Some(ptr) = *guard {
                if let Some(wake) = self.api.looper_wake {
                    unsafe { wake(ptr as *mut ALooper) };
                }
            }
        }
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

impl Drop for PlatformSession {
    fn drop(&mut self) {
        self.close();
    }
}
