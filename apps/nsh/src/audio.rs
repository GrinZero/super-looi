//! App-owned raw PCM bridge. Construction never opens a microphone.
use nsh_core::prelude::*;
use std::{
    collections::VecDeque,
    path::PathBuf,
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread::JoinHandle,
};

#[cfg(target_os = "ios")]
#[path = "audio/ios.rs"]
mod ios;
#[path = "audio/kws.rs"]
mod kws;
#[path = "audio/pcm.rs"]
mod pcm;
#[cfg(target_os = "ios")]
use ios as platform;
#[cfg(target_os = "android")]
#[path = "audio/android.rs"]
mod android;
#[cfg(target_os = "android")]
use android as platform;

static AUDIO_OWNER: AtomicBool = AtomicBool::new(false);
type SharedAudio = Arc<Mutex<AudioBuffers>>;
const MAX_KWS_CHUNKS: usize = 50;
#[derive(Clone, Copy, PartialEq, Eq)]
enum CaptureMode {
    KwsStandby,
    RealtimeCapture,
}

struct KwsWorker {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}
impl KwsWorker {
    fn start(shared: SharedAudio, directory: PathBuf) -> Result<Self, String> {
        let mut spotter = kws::KeywordSpotter::new(&directory)?;
        let stop = Arc::new(AtomicBool::new(false));
        let stopping = stop.clone();
        let thread = std::thread::Builder::new()
            .name("looi-kws".into())
            .spawn(move || {
                let mut seen_epoch = u64::MAX;
                while !stopping.load(Ordering::Acquire) {
                    let (epoch, chunks) = {
                        let mut state = shared.lock().unwrap_or_else(|e| e.into_inner());
                        while state.kws_queue.is_empty() && !stopping.load(Ordering::Acquire) {
                            let signal = state.kws_notify.clone();
                            state = signal.wait(state).unwrap_or_else(|e| e.into_inner());
                        }
                        (
                            state.kws_epoch,
                            state.kws_queue.drain(..).collect::<Vec<_>>(),
                        )
                    };
                    if stopping.load(Ordering::Acquire) {
                        break;
                    }
                    if epoch != seen_epoch {
                        spotter.reset();
                        seen_epoch = epoch;
                    }
                    for chunk in chunks {
                        if let Some(word) = spotter.accept_pcm16(&chunk) {
                            let mut state = shared.lock().unwrap_or_else(|e| e.into_inner());
                            if state.kws_epoch == seen_epoch
                                && state.mode == CaptureMode::KwsStandby
                            {
                                state.detected_wake_word = Some(word);
                            }
                            break;
                        }
                    }
                }
            })
            .map_err(|_| "Cannot start local wake worker")?;
        Ok(Self {
            stop,
            thread: Some(thread),
        })
    }
    fn stop(&mut self, shared: &SharedAudio) {
        self.stop.store(true, Ordering::Release);
        if let Ok(state) = shared.lock() {
            state.kws_notify.notify_all();
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

#[cfg_attr(
    not(any(target_os = "ios", target_os = "android", test)),
    allow(dead_code)
)]
pub(super) struct AudioBuffers {
    capture: VecDeque<(Vec<u8>, u64)>,
    partial: Vec<u8>,
    playback: VecDeque<i16>,
    captured_samples: u64,
    dropped_packets: u32,
    pending_samples: usize,
    cue_pending_samples: usize,
    cue_queued_samples: usize,
    generation: u64,
    muted: bool,
    error: String,
    mode: CaptureMode,
    kws_queue: VecDeque<Vec<u8>>,
    kws_epoch: u64,
    kws_notify: Arc<Condvar>,
    detected_wake_word: Option<String>,
    suppress_until_sample: u64,
}

impl Default for AudioBuffers {
    fn default() -> Self {
        Self {
            capture: VecDeque::with_capacity(pcm::MAX_CAPTURE_PACKETS),
            partial: Vec::with_capacity(2048),
            playback: VecDeque::new(),
            captured_samples: 0,
            dropped_packets: 0,
            pending_samples: 0,
            cue_pending_samples: 0,
            cue_queued_samples: 0,
            generation: 0,
            muted: false,
            error: String::new(),
            mode: CaptureMode::RealtimeCapture,
            kws_queue: VecDeque::with_capacity(MAX_KWS_CHUNKS),
            kws_epoch: 0,
            kws_notify: Arc::new(Condvar::new()),
            detected_wake_word: None,
            suppress_until_sample: 0,
        }
    }
}

#[cfg_attr(
    not(any(target_os = "ios", target_os = "android", test)),
    allow(dead_code)
)]
impl AudioBuffers {
    fn switch_mode(&mut self, next: CaptureMode) {
        self.mode = next;
        self.muted = false;
        self.capture.clear();
        self.partial.clear();
        self.kws_queue.clear();
        self.detected_wake_word = None;
        self.kws_epoch = self.kws_epoch.wrapping_add(1);
        self.suppress_until_sample = self.captured_samples + 2400;
        self.kws_notify.notify_one();
    }
    fn captured(&mut self, bytes: &[u8]) {
        if !self.error.is_empty() {
            return;
        }
        if self.muted || self.captured_samples < self.suppress_until_sample {
            self.partial.clear();
            self.kws_queue.clear();
            self.kws_epoch = self.kws_epoch.wrapping_add(1);
            self.captured_samples += (bytes.len() / 2) as u64;
            return;
        }
        if self.mode == CaptureMode::KwsStandby {
            self.captured_samples += (bytes.len() / 2) as u64;
            if self.kws_queue.len() == MAX_KWS_CHUNKS {
                self.kws_queue.clear();
                self.kws_epoch = self.kws_epoch.wrapping_add(1);
            }
            self.kws_queue.push_back(bytes.to_vec());
            self.kws_notify.notify_one();
            return;
        }
        self.partial.extend_from_slice(bytes);
        while self.partial.len() >= pcm::PACKET_SAMPLES * 2 {
            let packet: Vec<u8> = self.partial.drain(..pcm::PACKET_SAMPLES * 2).collect();
            if self.capture.len() == pcm::MAX_CAPTURE_PACKETS {
                self.capture.pop_front();
                self.dropped_packets += 1;
            }
            self.capture.push_back((packet, self.captured_samples));
            self.captured_samples += pcm::PACKET_SAMPLES as u64;
        }
    }
    fn clear_playback(&mut self) {
        self.generation = self.generation.wrapping_add(1);
        self.playback.clear();
        self.pending_samples = 0;
        self.cue_pending_samples = 0;
        self.cue_queued_samples = 0;
    }
}

/// A 20 ms, mono PCM16LE microphone packet. Timestamps are sample based.
#[derive(Clone, JsObject)]
pub struct VoiceCapturePacket {
    /// Exactly 640 bytes at 16 kHz, never written to disk.
    pub pcm: Vec<u8>,
    /// Milliseconds since this capture session began.
    pub timestamp_ms: f64,
    /// Wire sample rate, always 16000.
    pub sample_rate: u32,
}

/// Observable native audio state. AEC effectiveness requires physical hardware.
#[derive(Clone, JsObject)]
pub struct VoiceAudioStatus {
    /// idle, running, or error.
    pub state: String,
    /// granted, denied, undetermined, unavailable, or unknown.
    pub permission: String,
    /// Native output route or unavailable.
    pub route: String,
    /// Whether this explicitly started session captures a microphone.
    pub capture: bool,
    /// Whether captured packets are suppressed.
    pub muted: bool,
    /// Queued playback duration; capped at five seconds.
    pub queued_playback_ms: f64,
    /// Packets discarded because the caller did not drain in time.
    pub dropped_capture_packets: u32,
    /// Sanitized failure, without audio or credentials.
    pub error: String,
    pub capture_mode: String,
    pub wake_word: String,
    pub kws_ready: bool,
}

/// Explicit-lifetime mobile PCM capture/playback. Call stop on background/disconnect.
#[class]
pub struct VoiceAudio {
    shared: SharedAudio,
    native: Option<platform::Audio>,
    capture: bool,
    owns_session: bool,
    kws_worker: Option<KwsWorker>,
    kws_directory: PathBuf,
}

#[class]
impl VoiceAudio {
    /// Create an idle bridge; neither capture nor permission prompts begin here.
    pub fn new(sys: System) -> Result<Self, String> {
        let data = sys
            .data_dir
            .as_ref()
            .ok_or("Private app storage unavailable")?;
        for write in [true, false] {
            sys.access
                .authorize_file_with_paths(data, data, &sys.paths, write)
                .map_err(|_| "Wake model storage access denied")?;
        }
        Ok(Self {
            shared: Arc::new(Mutex::new(AudioBuffers::default())),
            native: None,
            capture: false,
            owns_session: false,
            kws_worker: None,
            kws_directory: data.join("kws"),
        })
    }

    /// Request microphone permission explicitly; poll status for the result.
    pub fn request_permission(&self) -> Result<String, String> {
        platform::request_permission()
    }

    /// Start output and optionally microphone capture after explicit user action.
    pub fn start(&mut self, capture: bool) -> Result<(), String> {
        self.stop();
        if AUDIO_OWNER
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Err("Another voice audio session is active".into());
        }
        self.owns_session = true;
        // Completion handlers from a stopped session retain its old buffers;
        // they can never decrement a subsequent session's playback counters.
        self.shared = Arc::new(Mutex::new(AudioBuffers::default()));
        match platform::Audio::start(self.shared.clone(), capture) {
            Ok(native) => {
                self.native = Some(native);
                self.capture = capture;
                Ok(())
            }
            Err(error) => {
                if let Ok(mut buffers) = self.shared.lock() {
                    buffers.error = error.clone();
                }
                self.release_owner();
                Err(error)
            }
        }
    }

    /// Queue bounded 24 kHz mono PCM16LE. A full queue fails with backpressure.
    pub fn enqueue(&mut self, pcm: Vec<u8>, sample_rate: u32) -> Result<(), String> {
        self.refresh_native();
        if self.native.is_none() {
            return Err("Voice audio is not running".into());
        }
        if sample_rate != pcm::PLAYBACK_RATE
            || pcm.len() % 2 != 0
            || pcm.len() > pcm::MAX_PLAYBACK_SAMPLES * 2
        {
            return Err("Expected bounded 24000 Hz mono PCM16LE".into());
        }
        {
            let mut buffers = self.shared.lock().map_err(|_| "Audio state unavailable")?;
            if !buffers.error.is_empty() {
                return Err(buffers.error.clone());
            }
            if buffers.pending_samples + pcm.len() / 2 > pcm::MAX_PLAYBACK_SAMPLES {
                return Err("Voice playback queue is full".into());
            }
            buffers.playback.extend(
                pcm.chunks_exact(2)
                    .map(|s| i16::from_le_bytes([s[0], s[1]])),
            );
            buffers.pending_samples += pcm.len() / 2;
        }
        let result = self.native.as_mut().unwrap().flush();
        if let Err(error) = &result {
            if let Ok(mut state) = self.shared.lock() {
                state.error = error.clone();
            }
            self.refresh_native();
        }
        result
    }

    /// Stop queued speech immediately when the user interrupts.
    pub fn clear_playback(&mut self) {
        if let Ok(mut buffers) = self.shared.lock() {
            buffers.clear_playback();
        }
        if let Some(native) = self.native.as_mut() {
            native.clear_playback();
        }
    }

    /// Change local wake listening and realtime capture without restarting devices.
    pub fn set_capture_mode(&mut self, mode: String) -> Result<(), String> {
        let next = match mode.as_str() {
            "kws" => CaptureMode::KwsStandby,
            "conversation" => CaptureMode::RealtimeCapture,
            _ => return Err("Unsupported capture mode".into()),
        };
        if self.native.is_none() {
            self.start(true)?;
        }
        if next == CaptureMode::KwsStandby && self.kws_worker.is_none() {
            self.kws_worker = Some(KwsWorker::start(
                self.shared.clone(),
                self.kws_directory.clone(),
            )?);
        }
        let mut state = self.shared.lock().map_err(|_| "Audio state unavailable")?;
        state.switch_mode(next);
        Ok(())
    }

    /// A short two-note cue through the existing 24 kHz output stream.
    pub fn play_ready_cue(&mut self) -> Result<(), String> {
        let mut pcm = Vec::with_capacity(2880 * 2);
        for n in 0..2880 {
            let frequency = if n < 1440 { 880.0 } else { 1320.0 };
            let phase = (n % 1440) as f64 / 1440.0;
            let envelope = (std::f64::consts::PI * phase).sin().powi(2);
            let sample = (envelope
                * 0.19
                * (2.0 * std::f64::consts::PI * frequency * n as f64 / 24000.0).sin()
                * i16::MAX as f64) as i16;
            pcm.extend_from_slice(&sample.to_le_bytes());
        }
        {
            let mut state = self.shared.lock().map_err(|_| "Audio state unavailable")?;
            state.suppress_until_sample = state.captured_samples + 3200;
            state.capture.clear();
            state.partial.clear();
            state.cue_pending_samples += 2880;
            state.cue_queued_samples += 2880;
        }
        let result = self.enqueue(pcm, 24000);
        if result.is_err() {
            if let Ok(mut state) = self.shared.lock() {
                state.cue_pending_samples = state.cue_pending_samples.saturating_sub(2880);
                state.cue_queued_samples = state.cue_queued_samples.saturating_sub(2880);
            }
        }
        result
    }

    /// Suppress capture and discard already queued microphone packets.
    pub fn set_muted(&self, muted: bool) {
        if let Ok(mut buffers) = self.shared.lock() {
            buffers.muted = muted;
            buffers.capture.clear();
            buffers.captured_samples += (buffers.partial.len() / 2) as u64;
            buffers.partial.clear();
        }
    }

    /// Drain at most 500 ms of captured data on the JS/engine thread.
    pub fn drain_capture(&mut self) -> Vec<VoiceCapturePacket> {
        self.refresh_native();
        self.shared
            .lock()
            .map(|mut b| {
                b.capture
                    .drain(..)
                    .map(|(pcm, timestamp)| VoiceCapturePacket {
                        pcm,
                        timestamp_ms: timestamp as f64 / 16.0,
                        sample_rate: pcm::CAPTURE_RATE,
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Poll native state; no audio thread invokes JavaScript callbacks.
    pub fn status(&mut self) -> VoiceAudioStatus {
        self.refresh_native();
        let mut buffers = self.shared.lock().unwrap_or_else(|e| e.into_inner());
        VoiceAudioStatus {
            state: if !buffers.error.is_empty() {
                "error"
            } else if self.native.is_some() {
                "running"
            } else {
                "idle"
            }
            .into(),
            permission: platform::permission(),
            route: self
                .native
                .as_ref()
                .map(|a| a.route())
                .unwrap_or_else(|| "unavailable".into()),
            capture: self.capture && self.native.is_some(),
            muted: buffers.muted,
            queued_playback_ms: buffers
                .pending_samples
                .saturating_sub(buffers.cue_pending_samples) as f64
                / 24.0,
            dropped_capture_packets: buffers.dropped_packets,
            error: buffers.error.clone(),
            capture_mode: if self.native.is_none() {
                "idle"
            } else if buffers.mode == CaptureMode::KwsStandby {
                "kws"
            } else {
                "conversation"
            }
            .into(),
            wake_word: buffers.detected_wake_word.take().unwrap_or_default(),
            kws_ready: self.kws_worker.is_some(),
        }
    }

    /// Idempotently stop devices, release audio focus, and discard all audio.
    pub fn stop(&mut self) {
        if let Some(mut worker) = self.kws_worker.take() {
            worker.stop(&self.shared);
        }
        self.native.take();
        self.capture = false;
        if let Ok(mut buffers) = self.shared.lock() {
            *buffers = AudioBuffers::default();
        }
        self.release_owner();
    }
}

impl VoiceAudio {
    fn refresh_native(&mut self) {
        if let Some(native) = self.native.as_mut() {
            native.refresh();
        }
        let error = self.shared.lock().ok().and_then(|s| {
            if s.error.is_empty() {
                None
            } else {
                Some(s.error.clone())
            }
        });
        if let Some(error) = error {
            self.native.take();
            self.capture = false;
            if let Ok(mut state) = self.shared.lock() {
                *state = AudioBuffers::default();
                state.error = error;
            }
            self.release_owner();
        }
    }
    fn release_owner(&mut self) {
        if self.owns_session {
            AUDIO_OWNER.store(false, Ordering::Release);
            self.owns_session = false;
        }
    }
}
impl Drop for VoiceAudio {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(not(any(target_os = "ios", target_os = "android")))]
mod platform {
    use super::SharedAudio;
    pub struct Audio;
    pub fn permission() -> String {
        "unavailable".into()
    }
    pub fn request_permission() -> Result<String, String> {
        Err("Native voice audio requires iOS or Android".into())
    }
    impl Audio {
        pub fn start(_: SharedAudio, _: bool) -> Result<Self, String> {
            Err("Native voice audio requires iOS or Android".into())
        }
        pub fn flush(&mut self) -> Result<(), String> {
            Ok(())
        }
        pub fn clear_playback(&mut self) {}
        pub fn refresh(&mut self) {}
        pub fn route(&self) -> String {
            "unavailable".into()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn slow_consumers_have_bounded_capture_and_monotonic_timestamps() {
        let mut audio = AudioBuffers::default();
        for _ in 0..100 {
            audio.captured(&[0; 640]);
        }
        assert_eq!(audio.capture.len(), 25);
        assert_eq!(audio.dropped_packets, 75);
        assert_eq!(audio.capture.front().unwrap().1, 75 * 320);
    }
    #[test]
    fn mute_discards_packets_and_clear_invalidates_completions() {
        let mut audio = AudioBuffers::default();
        audio.muted = true;
        audio.captured(&[0; 640]);
        assert!(audio.capture.is_empty());
        assert_eq!(audio.captured_samples, 320);
        audio.playback.push_back(2);
        audio.pending_samples = 1;
        audio.clear_playback();
        assert_eq!(audio.pending_samples, 0);
        assert_eq!(audio.generation, 1);
    }

    #[test]
    fn interrupted_sessions_cannot_repopulate_capture() {
        let mut audio = AudioBuffers::default();
        audio.error = "interrupted".into();
        audio.captured(&[1; 640]);
        assert!(audio.capture.is_empty());
        assert!(audio.partial.is_empty());
    }

    #[test]
    fn kws_mode_keeps_pcm_out_of_js_and_switch_resets_mute() {
        let mut audio = AudioBuffers::default();
        audio.switch_mode(CaptureMode::KwsStandby);
        for _ in 0..58 {
            audio.captured(&[0; 640]);
        }
        let epoch_before_overflow = audio.kws_epoch;
        for _ in 58..70 {
            audio.captured(&[0; 640]);
        }
        assert_eq!(audio.kws_queue.len(), 12);
        assert_eq!(audio.kws_epoch, epoch_before_overflow + 1);
        assert!(audio.capture.is_empty());
        assert_eq!(audio.captured_samples, 70 * 320);
        audio.muted = true;
        let epoch = audio.kws_epoch;
        audio.switch_mode(CaptureMode::RealtimeCapture);
        assert!(!audio.muted);
        assert!(audio.kws_queue.is_empty());
        assert_eq!(audio.kws_epoch, epoch + 1);
        assert_eq!(audio.suppress_until_sample, audio.captured_samples + 2400);
    }

    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    #[test]
    fn construction_is_idle_and_unsupported_start_is_observable() {
        let mut audio = VoiceAudio {
            shared: Arc::new(Mutex::new(AudioBuffers::default())),
            native: None,
            capture: false,
            owns_session: false,
            kws_worker: None,
            kws_directory: PathBuf::new(),
        };
        let idle = audio.status();
        assert_eq!(idle.state, "idle");
        assert!(!idle.capture);
        assert!(audio.start(false).is_err());
        assert_eq!(audio.status().state, "error");
        assert!(audio.drain_capture().is_empty());
        audio.stop();
        assert_eq!(audio.status().state, "idle");
    }
}
