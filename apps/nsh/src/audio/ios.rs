//! AVAudioEngine ownership stays in the app crate, independent of the NSH host.
use super::{SharedAudio, pcm};
use block2::RcBlock;
use dispatch2::DispatchQueue;
use objc2::{
    MainThreadMarker, msg_send,
    rc::{Allocated, Retained},
    runtime::{AnyClass, AnyObject},
};
use objc2_foundation::NSString;
use std::{
    ptr,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

#[link(name = "AVFoundation", kind = "framework")]
unsafe extern "C" {
    static AVAudioSessionInterruptionNotification: *const NSString;
    static AVAudioSessionRouteChangeNotification: *const NSString;
    static AVAudioEngineConfigurationChangeNotification: *const NSString;
}

#[link(name = "UIKit", kind = "framework")]
unsafe extern "C" {
    static UIApplicationWillResignActiveNotification: *const NSString;
    static UIApplicationDidEnterBackgroundNotification: *const NSString;
}

fn class(name: &std::ffi::CStr) -> Result<&'static AnyClass, String> {
    AnyClass::get(name).ok_or_else(|| "Native audio framework unavailable".into())
}

fn session() -> Result<Retained<AnyObject>, String> {
    // SAFETY: documented AVAudioSession singleton selector.
    unsafe { Ok(msg_send![class(c"AVAudioSession")?, sharedInstance]) }
}

fn application_active() -> bool {
    if MainThreadMarker::new().is_some() {
        return application_active_on_main();
    }
    let mut active = false;
    DispatchQueue::main().exec_sync(|| {
        active = application_active_on_main();
    });
    active
}

fn application_active_on_main() -> bool {
    debug_assert!(MainThreadMarker::new().is_some());
    unsafe {
        let Some(class) = AnyClass::get(c"UIApplication") else {
            return false;
        };
        let application: Retained<AnyObject> = msg_send![class, sharedApplication];
        let state: isize = msg_send![&application, applicationState];
        state == 0 // UIApplicationStateActive
    }
}

pub fn permission() -> String {
    let Ok(session) = session() else {
        return "unavailable".into();
    };
    // AVAudioSessionRecordPermission values are four-character constants.
    let value: usize = unsafe { msg_send![&session, recordPermission] };
    match value {
        0x67726e74 => "granted",
        0x64656e79 => "denied",
        0x756e6474 => "undetermined",
        _ => "unknown",
    }
    .into()
}

pub fn request_permission() -> Result<String, String> {
    if !application_active() {
        return Err("Microphone permission requires an active application".into());
    }
    unsafe {
        let bundle: Retained<AnyObject> = msg_send![class(c"NSBundle")?, mainBundle];
        let key = NSString::from_str("NSMicrophoneUsageDescription");
        let description: Option<Retained<AnyObject>> =
            msg_send![&bundle, objectForInfoDictionaryKey: &*key];
        if description.is_none() {
            return Err("Microphone usage description is missing from the native plugin".into());
        }
        let session = session()?;
        if permission() == "undetermined" {
            let completion = RcBlock::new(move |_granted: objc2::runtime::Bool| {});
            let _: () = msg_send![&session, requestRecordPermission: &*completion];
        }
    }
    Ok(permission())
}

pub struct Audio {
    shared: SharedAudio,
    engine: Retained<AnyObject>,
    player: Retained<AnyObject>,
    input: Option<Retained<AnyObject>>,
    format: Retained<AnyObject>,
    session: Retained<AnyObject>,
    before_category: Retained<NSString>,
    before_mode: Retained<NSString>,
    before_options: usize,
    tap_installed: bool,
    interrupted: Arc<AtomicBool>,
    observers: Vec<Retained<AnyObject>>,
}

impl Audio {
    pub fn start(shared: SharedAudio, capture: bool) -> Result<Self, String> {
        if !application_active() {
            return Err("Voice audio requires an active application".into());
        }
        if capture && permission() != "granted" {
            return Err(format!("Microphone permission is {}", permission()));
        }
        // All selectors and signatures below are AVFAudio's documented API.
        unsafe {
            let session = session()?;
            let before_category = msg_send![&session, category];
            let before_mode = msg_send![&session, mode];
            let before_options = msg_send![&session, categoryOptions];
            let engine: Retained<AnyObject> = msg_send![class(c"AVAudioEngine")?, new];
            let player: Retained<AnyObject> = msg_send![class(c"AVAudioPlayerNode")?, new];
            let alloc: Allocated<AnyObject> = msg_send![class(c"AVAudioFormat")?, alloc];
            let format: Option<Retained<AnyObject>> = msg_send![alloc, initStandardFormatWithSampleRate: pcm::PLAYBACK_RATE as f64, channels: 1u32];
            let format = format.ok_or("Cannot create voice PCM format")?;
            let mut audio = Self {
                shared,
                engine,
                player,
                input: None,
                format,
                session,
                before_category,
                before_mode,
                before_options,
                tap_installed: false,
                interrupted: Arc::new(AtomicBool::new(false)),
                observers: Vec::new(),
            };
            let category = NSString::from_str(if capture {
                "AVAudioSessionCategoryPlayAndRecord"
            } else {
                "AVAudioSessionCategoryPlayback"
            });
            let mode = NSString::from_str(if capture {
                "AVAudioSessionModeVoiceChat"
            } else {
                "AVAudioSessionModeSpokenAudio"
            });
            let mut error: *mut AnyObject = ptr::null_mut();
            let configured: bool = msg_send![&audio.session, setCategory: &*category, mode: &*mode, options: if capture { 12usize } else { 0usize }, error: &mut error];
            if !configured {
                return Err("Cannot configure the voice audio session".into());
            }
            let active: bool = msg_send![&audio.session, setActive: true, error: &mut error];
            if !active {
                return Err("Cannot activate the voice audio session".into());
            }
            let _: () = msg_send![&audio.engine, attachNode: &*audio.player];
            let mixer: Retained<AnyObject> = msg_send![&audio.engine, mainMixerNode];
            let _: () = msg_send![&audio.engine, connect: &*audio.player, to: &*mixer, format: &*audio.format];
            if capture {
                let input: Retained<AnyObject> = msg_send![&audio.engine, inputNode];
                let format: Retained<AnyObject> = msg_send![&input, outputFormatForBus: 0usize];
                let rate: f64 = msg_send![&format, sampleRate];
                let channels: u32 = msg_send![&format, channelCount];
                let common_format: usize = msg_send![&format, commonFormat];
                let interleaved: bool = msg_send![&format, isInterleaved];
                if rate < 8_000.0
                    || rate > 192_000.0
                    || channels == 0
                    || channels > 8
                    || common_format != 1
                    || interleaved
                {
                    return Err("Microphone PCM format unavailable".into());
                }
                let capture_shared = audio.shared.clone();
                let converter = std::sync::Mutex::new(pcm::Resampler::new(rate.round() as u32));
                let tap = RcBlock::new(move |buffer: *mut AnyObject, _time: *mut AnyObject| {
                    let Some(buffer) = buffer.as_ref() else {
                        return;
                    };
                    let length: u32 = msg_send![buffer, frameLength];
                    let data: *const *const f32 = msg_send![buffer, floatChannelData];
                    if data.is_null() || length == 0 || length > 32_768 {
                        return;
                    }
                    let pointers = std::slice::from_raw_parts(data, channels as usize);
                    if pointers.iter().any(|p| p.is_null()) {
                        return;
                    }
                    let mut mono = vec![0.0; length as usize];
                    for &pointer in pointers {
                        for (to, &from) in mono
                            .iter_mut()
                            .zip(std::slice::from_raw_parts(pointer, length as usize))
                        {
                            *to += from / channels as f32;
                        }
                    }
                    let mut bytes = Vec::with_capacity(length as usize * 4);
                    if let Ok(mut converter) = converter.lock() {
                        converter.push(&mono, &mut bytes);
                    }
                    if let Ok(mut state) = capture_shared.lock() {
                        state.captured(&bytes);
                    }
                });
                let _: () = msg_send![&input, installTapOnBus: 0usize, bufferSize: 1024u32, format: &*format, block: &*tap];
                audio.input = Some(input);
                audio.tap_installed = true;
            }
            let _: () = msg_send![&audio.engine, prepare];
            let started: bool = msg_send![&audio.engine, startAndReturnError: &mut error];
            if !started {
                return Err("Native voice audio device unavailable".into());
            }
            let _: () = msg_send![&audio.player, play];
            audio.observe_interruptions()?;
            // Cover a transition that raced the initial foreground check.
            if !application_active() {
                return Err("Application left the foreground while starting voice audio".into());
            }
            Ok(audio)
        }
    }

    pub fn flush(&mut self) -> Result<(), String> {
        if self.interrupted.load(Ordering::Acquire) {
            return Err("Voice audio was interrupted; explicit restart required".into());
        }
        let (samples, generation) = {
            let mut state = self.shared.lock().map_err(|_| "Audio state unavailable")?;
            (
                state.playback.drain(..).collect::<Vec<_>>(),
                state.generation,
            )
        };
        if samples.is_empty() {
            return Ok(());
        }
        unsafe {
            let alloc: Allocated<AnyObject> = msg_send![class(c"AVAudioPCMBuffer")?, alloc];
            let buffer: Option<Retained<AnyObject>> = msg_send![alloc, initWithPCMFormat: &*self.format, frameCapacity: samples.len() as u32];
            let buffer = buffer.ok_or("Cannot allocate voice playback buffer")?;
            let _: () = msg_send![&buffer, setFrameLength: samples.len() as u32];
            let channels: *mut *mut f32 = msg_send![&buffer, floatChannelData];
            if channels.is_null() || (*channels).is_null() {
                return Err("Voice playback PCM unavailable".into());
            }
            for (out, sample) in std::slice::from_raw_parts_mut(*channels, samples.len())
                .iter_mut()
                .zip(&samples)
            {
                *out = *sample as f32 / 32768.0;
            }
            let shared = self.shared.clone();
            let count = samples.len();
            let completion = RcBlock::new(move |_kind: isize| {
                if let Ok(mut state) = shared.lock() {
                    if state.generation == generation {
                        state.pending_samples = state.pending_samples.saturating_sub(count);
                    }
                }
            });
            // AVAudioPlayerNodeCompletionDataPlayedBack (2) keeps backpressure
            // until native output has played, rather than merely consumed data.
            let _: () = msg_send![&self.player, scheduleBuffer: &*buffer, completionCallbackType: 2isize, completionHandler: &*completion];
        }
        Ok(())
    }

    pub fn clear_playback(&mut self) {
        if self.interrupted.load(Ordering::Acquire) {
            return;
        }
        unsafe {
            let _: () = msg_send![&self.player, stop];
            let _: () = msg_send![&self.player, play];
        }
    }

    pub fn refresh(&mut self) {
        let running: bool = unsafe { msg_send![&self.engine, isRunning] };
        if !running || self.interrupted.load(Ordering::Acquire) || !application_active() {
            if let Ok(mut state) = self.shared.lock() {
                state.error = "Voice audio interrupted; restart after returning to the app".into();
            }
        }
    }

    pub fn route(&self) -> String {
        unsafe {
            let route: Retained<AnyObject> = msg_send![&self.session, currentRoute];
            let outputs: Retained<AnyObject> = msg_send![&route, outputs];
            let port: Option<Retained<AnyObject>> = msg_send![&outputs, firstObject];
            port.map(|port| {
                let kind: Retained<NSString> = msg_send![&port, portType];
                kind.to_string()
            })
            .unwrap_or_else(|| "unavailable".into())
        }
    }

    fn observe_interruptions(&mut self) -> Result<(), String> {
        unsafe {
            let center: Retained<AnyObject> =
                msg_send![class(c"NSNotificationCenter")?, defaultCenter];
            for name in [
                UIApplicationWillResignActiveNotification,
                UIApplicationDidEnterBackgroundNotification,
                AVAudioSessionInterruptionNotification,
                AVAudioSessionRouteChangeNotification,
                AVAudioEngineConfigurationChangeNotification,
            ] {
                let name = name
                    .as_ref()
                    .ok_or("Native audio notification unavailable")?;
                let shared = self.shared.clone();
                let interrupted = self.interrupted.clone();
                let engine = self.engine.clone();
                let player = self.player.clone();
                let session = self.session.clone();
                let block = RcBlock::new(move |_notification: *mut AnyObject| {
                    // A one-way latch rejects resumption even when the route or
                    // application becomes active again. This is native-only:
                    // suspended JavaScript cannot keep the microphone running.
                    if interrupted.swap(true, Ordering::AcqRel) {
                        return;
                    }
                    if let Ok(mut state) = shared.lock() {
                        state.error = "Voice audio interrupted; explicit restart required".into();
                        state.capture.clear();
                        state.partial.clear();
                        state.clear_playback();
                    }
                    let _: () = msg_send![&engine, stop];
                    let _: () = msg_send![&player, stop];
                    let mut error: *mut AnyObject = ptr::null_mut();
                    let _: bool = msg_send![&session, setActive: false, withOptions: 1usize, error: &mut error];
                });
                // nil queue delivers synchronously on the native notification
                // posting thread. No JavaScript or NSH callbacks are involved.
                let observer: Retained<AnyObject> = msg_send![&center, addObserverForName: name, object: ptr::null::<AnyObject>(), queue: ptr::null::<AnyObject>(), usingBlock: &*block];
                self.observers.push(observer);
            }
        }
        Ok(())
    }
}

impl Drop for Audio {
    fn drop(&mut self) {
        unsafe {
            self.interrupted.store(true, Ordering::Release);
            if let Ok(center_class) = class(c"NSNotificationCenter") {
                let center: Retained<AnyObject> = msg_send![center_class, defaultCenter];
                for observer in self.observers.drain(..) {
                    let _: () = msg_send![&center, removeObserver: &*observer];
                }
            }
            let _: () = msg_send![&self.player, stop];
            let _: () = msg_send![&self.engine, stop];
            if self.tap_installed {
                if let Some(input) = &self.input {
                    let _: () = msg_send![input, removeTapOnBus: 0usize];
                }
            }
            let mut error: *mut AnyObject = ptr::null_mut();
            let _: bool =
                msg_send![&self.session, setActive: false, withOptions: 1usize, error: &mut error];
            let _: bool = msg_send![&self.session, setCategory: &*self.before_category, mode: &*self.before_mode, options: self.before_options, error: &mut error];
        }
    }
}
