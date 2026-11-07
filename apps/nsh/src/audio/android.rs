//! AAudio is loaded on demand, so Android <26 can still load the application.
use super::{SharedAudio, pcm};
use jni::{
    JNIEnv, JavaVM,
    objects::{GlobalRef, JClass, JString, JValue},
};
use std::{
    ffi::{CStr, c_char, c_void},
    ptr,
    sync::{
        Arc, OnceLock,
        atomic::{AtomicBool, AtomicI32, Ordering},
    },
    thread::{self, JoinHandle},
};

static JAVA: OnceLock<(JavaVM, GlobalRef)> = OnceLock::new();

/// Registered by the app-owned Application plugin, independent of JNI_OnLoad.
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_superlooi_nsh_SuperLooiApplication_registerAudioVm(
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
    let (vm, class) = JAVA
        .get()
        .ok_or("Android audio application plugin is not initialized")?;
    let mut env = vm
        .attach_current_thread()
        .map_err(|_| "Android audio VM attachment failed")?;
    let result = env.with_local_frame(16, |env| operation(env, class.as_obj().into()));
    if result.is_err() {
        let _ = env.exception_clear();
    }
    result.map_err(|_| "Android audio application plugin call failed".into())
}

fn java_string(method: &str) -> Result<String, String> {
    with_java(|env, class| {
        let value = env
            .call_static_method(class, method, "()Ljava/lang/String;", &[])?
            .l()?;
        let value = JString::from(value);
        Ok(env.get_string(&value)?.into())
    })
}

pub fn permission() -> String {
    java_string("voicePermission").unwrap_or_else(|_| "unknown".into())
}
pub fn request_permission() -> Result<String, String> {
    java_string("requestVoicePermission")
}

type Handle = *mut c_void;
type SetInt = unsafe extern "C" fn(Handle, i32);
type ResultCall = unsafe extern "C" fn(Handle) -> i32;
type GetInt = unsafe extern "C" fn(Handle) -> i32;
type Transfer = unsafe extern "C" fn(Handle, *mut c_void, i32, i64) -> i32;

#[link(name = "dl")]
unsafe extern "C" {
    fn dlopen(name: *const c_char, flags: i32) -> Handle;
    fn dlsym(handle: Handle, name: *const c_char) -> Handle;
}

struct Api {
    create: unsafe extern "C" fn(*mut Handle) -> i32,
    delete: ResultCall,
    set_direction: SetInt,
    set_rate: SetInt,
    set_channels: SetInt,
    set_format: SetInt,
    set_usage: Option<SetInt>,
    set_input_preset: Option<SetInt>,
    open: unsafe extern "C" fn(Handle, *mut Handle) -> i32,
    close: ResultCall,
    start: ResultCall,
    stop: ResultCall,
    pause: ResultCall,
    flush: ResultCall,
    state: GetInt,
    wait: unsafe extern "C" fn(Handle, i32, *mut i32, i64) -> i32,
    rate: GetInt,
    channels: GetInt,
    format: GetInt,
    device: GetInt,
    read: Transfer,
    write: Transfer,
}

static API: OnceLock<Result<Api, String>> = OnceLock::new();

impl Api {
    fn await_state(
        &self,
        handle: Handle,
        expected: i32,
        running: &AtomicBool,
    ) -> Result<(), String> {
        for _ in 0..10 {
            if !running.load(Ordering::Acquire) {
                return Err("Voice audio was stopped".into());
            }
            let current = unsafe { (self.state)(handle) };
            if current == expected {
                return Ok(());
            }
            let mut next = current;
            let result = unsafe { (self.wait)(handle, current, &mut next, 20_000_000) };
            if result != 0 {
                return Err("Native audio state transition failed or timed out".into());
            }
        }
        Err("Native audio state transition did not complete".into())
    }

    fn clear_output(&self, handle: Handle, running: &AtomicBool) -> Result<(), String> {
        if unsafe { (self.pause)(handle) } != 0 {
            return Err("Native speaker could not pause safely".into());
        }
        self.await_state(handle, 6, running)?; // PAUSED
        if unsafe { (self.flush)(handle) } != 0 {
            return Err("Native speaker could not clear queued speech".into());
        }
        self.await_state(handle, 8, running)?; // FLUSHED
        if unsafe { (self.start)(handle) } != 0 {
            return Err("Native speaker could not resume".into());
        }
        self.await_state(handle, 4, running) // STARTED
    }

    fn get() -> Result<&'static Self, String> {
        API.get_or_init(Self::load).as_ref().map_err(Clone::clone)
    }
    fn load() -> Result<Self, String> {
        // The handle deliberately lives for the process lifetime. Function
        // pointers must remain valid until the last audio worker exits.
        unsafe {
            let library = dlopen(c"libaaudio.so".as_ptr(), 2);
            if library.is_null() {
                return Err("Native voice audio requires Android API 26 or later".into());
            }
            fn symbol(library: Handle, name: &CStr) -> Result<Handle, String> {
                let pointer = unsafe { dlsym(library, name.as_ptr()) };
                if pointer.is_null() {
                    Err("Native AAudio API unavailable on this Android version".into())
                } else {
                    Ok(pointer)
                }
            }
            macro_rules! required {
                ($name:literal, $ty:ty) => {
                    std::mem::transmute::<Handle, $ty>(symbol(library, $name)?)
                };
            }
            macro_rules! optional {
                ($name:literal) => {{
                    let p = dlsym(library, $name.as_ptr());
                    if p.is_null() {
                        None
                    } else {
                        Some(std::mem::transmute::<Handle, SetInt>(p))
                    }
                }};
            }
            Ok(Self {
                create: required!(
                    c"AAudio_createStreamBuilder",
                    unsafe extern "C" fn(*mut Handle) -> i32
                ),
                delete: required!(c"AAudioStreamBuilder_delete", ResultCall),
                set_direction: required!(c"AAudioStreamBuilder_setDirection", SetInt),
                set_rate: required!(c"AAudioStreamBuilder_setSampleRate", SetInt),
                set_channels: required!(c"AAudioStreamBuilder_setChannelCount", SetInt),
                set_format: required!(c"AAudioStreamBuilder_setFormat", SetInt),
                set_usage: optional!(c"AAudioStreamBuilder_setUsage"),
                set_input_preset: optional!(c"AAudioStreamBuilder_setInputPreset"),
                open: required!(
                    c"AAudioStreamBuilder_openStream",
                    unsafe extern "C" fn(Handle, *mut Handle) -> i32
                ),
                close: required!(c"AAudioStream_close", ResultCall),
                start: required!(c"AAudioStream_requestStart", ResultCall),
                stop: required!(c"AAudioStream_requestStop", ResultCall),
                pause: required!(c"AAudioStream_requestPause", ResultCall),
                flush: required!(c"AAudioStream_requestFlush", ResultCall),
                state: required!(c"AAudioStream_getState", GetInt),
                wait: required!(
                    c"AAudioStream_waitForStateChange",
                    unsafe extern "C" fn(Handle, i32, *mut i32, i64) -> i32
                ),
                rate: required!(c"AAudioStream_getSampleRate", GetInt),
                channels: required!(c"AAudioStream_getChannelCount", GetInt),
                format: required!(c"AAudioStream_getFormat", GetInt),
                device: required!(c"AAudioStream_getDeviceId", GetInt),
                read: required!(c"AAudioStream_read", Transfer),
                write: required!(c"AAudioStream_write", Transfer),
            })
        }
    }

    fn stream(&'static self, input: bool) -> Result<Stream, String> {
        unsafe {
            let mut builder = ptr::null_mut();
            if (self.create)(&mut builder) != 0 || builder.is_null() {
                return Err("Cannot create native voice audio stream".into());
            }
            (self.set_direction)(builder, if input { 1 } else { 0 });
            (self.set_rate)(
                builder,
                if input {
                    pcm::CAPTURE_RATE
                } else {
                    pcm::PLAYBACK_RATE
                } as i32,
            );
            (self.set_channels)(builder, 1);
            (self.set_format)(builder, 1); // AAUDIO_FORMAT_PCM_I16
            if input {
                if let Some(set) = self.set_input_preset {
                    set(builder, 7);
                }
            } else if let Some(set) = self.set_usage {
                set(builder, 2);
            }
            let mut handle = ptr::null_mut();
            let result = (self.open)(builder, &mut handle);
            (self.delete)(builder);
            if result != 0 || handle.is_null() {
                return Err(format!(
                    "Native {} device unavailable ({result}); check permission and route",
                    if input { "microphone" } else { "speaker" }
                ));
            }
            let stream = Stream {
                handle: handle as usize,
                api: self,
            };
            let expected_rate = if input {
                pcm::CAPTURE_RATE
            } else {
                pcm::PLAYBACK_RATE
            } as i32;
            if (self.rate)(handle) != expected_rate
                || (self.channels)(handle) != 1
                || (self.format)(handle) != 1
            {
                return Err("Native device cannot provide the required mono PCM format".into());
            }
            if (self.start)(handle) != 0 {
                return Err("Native voice audio stream did not start".into());
            }
            Ok(stream)
        }
    }
}

struct Stream {
    handle: usize,
    api: &'static Api,
}
impl Drop for Stream {
    fn drop(&mut self) {
        unsafe {
            (self.api.stop)(self.handle as Handle);
            (self.api.close)(self.handle as Handle);
        }
    }
}

pub struct Audio {
    shared: SharedAudio,
    running: Arc<AtomicBool>,
    workers: Vec<JoinHandle<()>>,
    device: Arc<AtomicI32>,
}

impl Audio {
    pub fn start(shared: SharedAudio, capture: bool) -> Result<Self, String> {
        let api = Api::get()?;
        if capture && permission() != "granted" {
            return Err(format!("Microphone permission is {}", permission()));
        }
        let focus_result = with_java(|env, class| {
            env.call_static_method(
                class,
                "beginVoiceAudio",
                "(Z)Z",
                &[JValue::Bool(capture as u8)],
            )?
            .z()
        });
        if !matches!(focus_result, Ok(true)) {
            let _ = with_java(|env, class| {
                env.call_static_method(class, "endVoiceAudio", "()V", &[])
                    .map(|_| ())
            });
        }
        let focused = focus_result?;
        if !focused {
            return Err("Voice audio focus was denied".into());
        }
        let mut audio = Self {
            shared,
            running: Arc::new(AtomicBool::new(true)),
            workers: Vec::new(),
            device: Arc::new(AtomicI32::new(0)),
        };
        let output = api.stream(false)?;
        audio.device.store(
            unsafe { (api.device)(output.handle as Handle) },
            Ordering::Release,
        );
        let input = if capture {
            Some(api.stream(true)?)
        } else {
            None
        };
        if let Some(input) = input {
            let shared = audio.shared.clone();
            let running = audio.running.clone();
            audio.workers.push(thread::spawn(move || {
                let mut buffer = [0i16; 320];
                while running.load(Ordering::Acquire) {
                    let count = unsafe {
                        (api.read)(
                            input.handle as Handle,
                            buffer.as_mut_ptr().cast(),
                            320,
                            20_000_000,
                        )
                    };
                    if count < 0 {
                        fail(&shared, "Native microphone interrupted");
                        running.store(false, Ordering::Release);
                        break;
                    }
                    if count > 0 && running.load(Ordering::Acquire) {
                        let mut bytes = Vec::with_capacity(count as usize * 2);
                        for sample in &buffer[..count as usize] {
                            bytes.extend_from_slice(&sample.to_le_bytes());
                        }
                        if let Ok(mut state) = shared.lock() {
                            state.captured(&bytes);
                        }
                    }
                }
                drop(input);
            }));
        }
        let shared = audio.shared.clone();
        let running = audio.running.clone();
        let device = audio.device.clone();
        audio.workers.push(thread::spawn(move || {
            let mut seen_generation = 0;
            let mut focus_tick = 0u32;
            while running.load(Ordering::Acquire) {
                // The application marks focus lost when it backgrounds. This
                // native check also runs while JS is suspended or disconnected.
                focus_tick = focus_tick.wrapping_add(1);
                if focus_tick % 5 == 0 {
                    device.store(
                        unsafe { (api.device)(output.handle as Handle) },
                        Ordering::Release,
                    );
                }
                if focus_tick % 5 == 0
                    && !matches!(java_string("voiceAudioFocus").as_deref(), Ok("granted"))
                {
                    fail(
                        &shared,
                        "Voice audio focus interrupted; restart after returning to the app",
                    );
                    running.store(false, Ordering::Release);
                    break;
                }
                let mut buffer = [0i16; 480];
                let (count, generation) = match shared.lock() {
                    Ok(mut state) => {
                        let count = state.playback.len().min(buffer.len());
                        for sample in &mut buffer[..count] {
                            *sample = state.playback.pop_front().unwrap();
                        }
                        (count, state.generation)
                    }
                    Err(_) => {
                        running.store(false, Ordering::Release);
                        break;
                    }
                };
                if generation != seen_generation {
                    if let Err(error) = api.clear_output(output.handle as Handle, &running) {
                        fail(&shared, &error);
                        running.store(false, Ordering::Release);
                        break;
                    }
                    seen_generation = generation;
                }
                let current = shared
                    .lock()
                    .map(|s| s.generation == generation)
                    .unwrap_or(false);
                if !current {
                    continue;
                }
                let written = unsafe {
                    (api.write)(
                        output.handle as Handle,
                        buffer.as_mut_ptr().cast(),
                        480,
                        20_000_000,
                    )
                };
                if written < 0 {
                    fail(&shared, "Native speaker interrupted");
                    running.store(false, Ordering::Release);
                    break;
                }
                if let Ok(mut state) = shared.lock() {
                    if state.generation == generation {
                        let consumed = count.min(written as usize);
                        state.pending_samples = state.pending_samples.saturating_sub(consumed);
                        state.cue_pending_samples =
                            state.cue_pending_samples.saturating_sub(consumed);
                        // A partial timed write must keep speech that has not
                        // reached the device, in order, before the next chunk.
                        for &sample in buffer[consumed..count].iter().rev() {
                            state.playback.push_front(sample);
                        }
                    }
                }
            }
            drop(output);
            let _ = with_java(|env, class| {
                env.call_static_method(class, "endVoiceAudio", "()V", &[])
                    .map(|_| ())
            });
        }));
        Ok(audio)
    }

    pub fn flush(&mut self) -> Result<(), String> {
        Ok(())
    }
    pub fn clear_playback(&mut self) { /* Worker observes generation and flushes native output. */
    }
    pub fn refresh(&mut self) {
        match java_string("voiceAudioFocus").as_deref() {
            Ok("granted") => {}
            _ => {
                self.running.store(false, Ordering::Release);
                fail(
                    &self.shared,
                    "Voice audio focus interrupted; restart after returning to the app",
                );
            }
        }
    }
    pub fn route(&self) -> String {
        format!("android-device-{}", self.device.load(Ordering::Acquire))
    }
}

fn fail(shared: &SharedAudio, error: &str) {
    if let Ok(mut state) = shared.lock() {
        state.error = error.into();
        state.capture.clear();
        state.partial.clear();
        state.clear_playback();
    }
}

impl Drop for Audio {
    fn drop(&mut self) {
        self.running.store(false, Ordering::Release);
        for worker in self.workers.drain(..) {
            let _ = worker.join();
        }
        let _ = with_java(|env, class| {
            env.call_static_method(class, "endVoiceAudio", "()V", &[])
                .map(|_| ())
        });
    }
}
