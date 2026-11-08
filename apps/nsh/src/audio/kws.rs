#[cfg(any(target_os = "ios", target_os = "android"))]
mod mobile {
    use std::{
        ffi::{CStr, CString, c_char, c_void},
        fs,
        path::{Path, PathBuf},
        ptr,
    };

    const MODEL: &str = "sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20";
    const ENCODER: &str = "encoder-epoch-13-avg-2-chunk-16-left-64.int8.onnx";
    const DECODER: &str = "decoder-epoch-13-avg-2-chunk-16-left-64.onnx";
    const JOINER: &str = "joiner-epoch-13-avg-2-chunk-16-left-64.int8.onnx";
    const KEYWORDS: &str = "HH EY1 L UW1 IY0 @Hey_LOOI :1.5 #0.25\nh ēi l ù y ī @嘿露伊 :1.5 #0.25\nn ǐ h ǎo l ù y ī @你好露伊 :1.5 #0.25\n";

    #[repr(C)]
    struct Transducer {
        encoder: *const c_char,
        decoder: *const c_char,
        joiner: *const c_char,
    }
    #[repr(C)]
    struct Paraformer {
        encoder: *const c_char,
        decoder: *const c_char,
    }
    #[repr(C)]
    struct ZipformerCtc {
        model: *const c_char,
    }
    #[repr(C)]
    struct ModelConfig {
        transducer: Transducer,
        paraformer: Paraformer,
        zipformer2_ctc: ZipformerCtc,
        tokens: *const c_char,
        num_threads: i32,
        provider: *const c_char,
        debug: i32,
        model_type: *const c_char,
        modeling_unit: *const c_char,
        bpe_vocab: *const c_char,
        tokens_buf: *const c_char,
        tokens_buf_size: i32,
        nemo_ctc: ZipformerCtc,
        t_one_ctc: ZipformerCtc,
    }
    #[repr(C)]
    struct FeatureConfig {
        sample_rate: i32,
        feature_dim: i32,
    }
    #[repr(C)]
    struct SpotterConfig {
        feat_config: FeatureConfig,
        model_config: ModelConfig,
        max_active_paths: i32,
        num_trailing_blanks: i32,
        keywords_score: f32,
        keywords_threshold: f32,
        keywords_file: *const c_char,
        keywords_buf: *const c_char,
        keywords_buf_size: i32,
    }
    #[repr(C)]
    struct KeywordResult {
        keyword: *const c_char,
    }
    unsafe extern "C" {
        fn SherpaOnnxCreateKeywordSpotter(config: *const SpotterConfig) -> *const c_void;
        fn SherpaOnnxDestroyKeywordSpotter(spotter: *const c_void);
        fn SherpaOnnxCreateKeywordStream(spotter: *const c_void) -> *const c_void;
        fn SherpaOnnxDestroyOnlineStream(stream: *const c_void);
        fn SherpaOnnxOnlineStreamAcceptWaveform(
            stream: *const c_void,
            sample_rate: i32,
            samples: *const f32,
            n: i32,
        );
        fn SherpaOnnxIsKeywordStreamReady(spotter: *const c_void, stream: *const c_void) -> i32;
        fn SherpaOnnxDecodeKeywordStream(spotter: *const c_void, stream: *const c_void);
        fn SherpaOnnxGetKeywordResult(
            spotter: *const c_void,
            stream: *const c_void,
        ) -> *const KeywordResult;
        fn SherpaOnnxDestroyKeywordResult(result: *const KeywordResult);
        fn SherpaOnnxResetKeywordStream(spotter: *const c_void, stream: *const c_void);
    }

    fn install(base: &Path, name: &str, bytes: &[u8]) -> Result<PathBuf, String> {
        let path = base.join(name);
        if fs::metadata(&path)
            .map(|m| m.len() == bytes.len() as u64)
            .unwrap_or(false)
        {
            return Ok(path);
        }
        let temporary = base.join(format!("{name}.tmp"));
        fs::write(&temporary, bytes).map_err(|_| "Cannot install local wake model")?;
        fs::rename(&temporary, &path).map_err(|_| "Cannot install local wake model")?;
        Ok(path)
    }
    pub struct KeywordSpotter {
        spotter: *const c_void,
        stream: *const c_void,
    }
    unsafe impl Send for KeywordSpotter {}
    impl KeywordSpotter {
        pub fn new(directory: &Path) -> Result<Self, String> {
            let base = directory.join(MODEL);
            fs::create_dir_all(&base).map_err(|_| "Cannot create local wake model directory")?;
            let encoder = install(
                &base,
                ENCODER,
                include_bytes!(concat!(
                    env!("LOOI_KWS_MODEL_DIR"),
                    "/encoder-epoch-13-avg-2-chunk-16-left-64.int8.onnx"
                )),
            )?;
            let decoder = install(
                &base,
                DECODER,
                include_bytes!(concat!(
                    env!("LOOI_KWS_MODEL_DIR"),
                    "/decoder-epoch-13-avg-2-chunk-16-left-64.onnx"
                )),
            )?;
            let joiner = install(
                &base,
                JOINER,
                include_bytes!(concat!(
                    env!("LOOI_KWS_MODEL_DIR"),
                    "/joiner-epoch-13-avg-2-chunk-16-left-64.int8.onnx"
                )),
            )?;
            let tokens = install(
                &base,
                "tokens.txt",
                include_bytes!(concat!(env!("LOOI_KWS_MODEL_DIR"), "/tokens.txt")),
            )?;
            let keywords = install(&base, "keywords.txt", KEYWORDS.as_bytes())?;
            let strings = [encoder, decoder, joiner, tokens, keywords]
                .into_iter()
                .map(|p| {
                    CString::new(p.to_string_lossy().as_bytes())
                        .map_err(|_| "Invalid model path".to_string())
                })
                .collect::<Result<Vec<_>, _>>()?;
            let config = SpotterConfig {
                feat_config: FeatureConfig {
                    sample_rate: 16000,
                    feature_dim: 80,
                },
                model_config: ModelConfig {
                    transducer: Transducer {
                        encoder: strings[0].as_ptr(),
                        decoder: strings[1].as_ptr(),
                        joiner: strings[2].as_ptr(),
                    },
                    paraformer: Paraformer {
                        encoder: ptr::null(),
                        decoder: ptr::null(),
                    },
                    zipformer2_ctc: ZipformerCtc { model: ptr::null() },
                    tokens: strings[3].as_ptr(),
                    num_threads: 1,
                    provider: c"cpu".as_ptr(),
                    debug: 0,
                    model_type: ptr::null(),
                    modeling_unit: ptr::null(),
                    bpe_vocab: ptr::null(),
                    tokens_buf: ptr::null(),
                    tokens_buf_size: 0,
                    nemo_ctc: ZipformerCtc { model: ptr::null() },
                    t_one_ctc: ZipformerCtc { model: ptr::null() },
                },
                max_active_paths: 16,
                num_trailing_blanks: 1,
                keywords_score: 1.5,
                keywords_threshold: 0.25,
                keywords_file: strings[4].as_ptr(),
                keywords_buf: ptr::null(),
                keywords_buf_size: 0,
            };
            let spotter = unsafe { SherpaOnnxCreateKeywordSpotter(&config) };
            if spotter.is_null() {
                return Err("Cannot load local wake model".into());
            }
            let stream = unsafe { SherpaOnnxCreateKeywordStream(spotter) };
            if stream.is_null() {
                unsafe { SherpaOnnxDestroyKeywordSpotter(spotter) };
                return Err("Cannot initialize local wake stream".into());
            }
            Ok(Self { spotter, stream })
        }
        pub fn reset(&mut self) {
            unsafe { SherpaOnnxResetKeywordStream(self.spotter, self.stream) };
        }
        pub fn accept_pcm16(&mut self, bytes: &[u8]) -> Option<String> {
            let samples = bytes
                .chunks_exact(2)
                .map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0)
                .collect::<Vec<_>>();
            unsafe {
                SherpaOnnxOnlineStreamAcceptWaveform(
                    self.stream,
                    16000,
                    samples.as_ptr(),
                    samples.len() as i32,
                );
                while SherpaOnnxIsKeywordStreamReady(self.spotter, self.stream) != 0 {
                    SherpaOnnxDecodeKeywordStream(self.spotter, self.stream);
                    let result = SherpaOnnxGetKeywordResult(self.spotter, self.stream);
                    if !result.is_null() {
                        let word = if (*result).keyword.is_null() {
                            None
                        } else {
                            CStr::from_ptr((*result).keyword)
                                .to_str()
                                .ok()
                                .filter(|s| !s.is_empty())
                                .map(str::to_owned)
                        };
                        SherpaOnnxDestroyKeywordResult(result);
                        if let Some(word) = word {
                            self.reset();
                            return Some(word);
                        }
                    }
                }
            }
            None
        }
    }
    impl Drop for KeywordSpotter {
        fn drop(&mut self) {
            unsafe {
                SherpaOnnxDestroyOnlineStream(self.stream);
                SherpaOnnxDestroyKeywordSpotter(self.spotter);
            }
        }
    }
}
#[cfg(any(target_os = "ios", target_os = "android"))]
pub use mobile::KeywordSpotter;

#[cfg(not(any(target_os = "ios", target_os = "android")))]
pub struct KeywordSpotter;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
impl KeywordSpotter {
    pub fn new(_: &std::path::Path) -> Result<Self, String> {
        Err("Local wake requires iOS or Android".into())
    }
    pub fn reset(&mut self) {}
    pub fn accept_pcm16(&mut self, _: &[u8]) -> Option<String> {
        None
    }
}
