//! Platform decoder. Encoded video and pixels stay outside the JS engine.
use super::video::VideoPacket;

#[derive(Default, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub frames: u64,
    pub width: i32,
    pub height: i32,
    pub timestamp_ms: i64,
    pub error: i32,
    pub displayed: Option<bool>,
}
pub struct Jpeg {
    pub data: Vec<u8>,
    pub width: i32,
    pub height: i32,
    pub received_at: i64,
}

#[cfg(target_os = "android")]
pub use super::media_android::Decoder;
#[cfg(target_os = "ios")]
pub use ios::Decoder;
#[cfg(target_os = "ios")]
pub mod ios {
    use super::*;
    use std::ffi::c_void;
    unsafe extern "C" {
        fn looi_camera_media_create() -> *mut c_void;
        fn looi_camera_media_release(handle: *mut c_void);
        fn looi_camera_media_close(handle: *mut c_void);
        fn looi_camera_media_feed(
            handle: *mut c_void,
            codec: u32,
            bytes: *const u8,
            length: usize,
            timestamp: i64,
        ) -> i32;
        fn looi_camera_media_status(
            handle: *mut c_void,
            frames: *mut u64,
            width: *mut i32,
            height: *mut i32,
            pts: *mut i64,
            error: *mut i32,
            displayed: *mut i32,
        );
        fn looi_camera_media_jpeg(
            handle: *mut c_void,
            length: *mut usize,
            width: *mut i32,
            height: *mut i32,
            received_at: *mut i64,
        ) -> *mut u8;
        fn looi_camera_bytes_free(bytes: *mut c_void);
        pub fn looi_camera_view_create() -> *mut c_void;
        pub fn looi_camera_view_bind(view: *mut c_void, decoder: *mut c_void);
        pub fn looi_camera_view_release(view: *mut c_void);
    }
    pub struct Decoder(pub *mut c_void);
    // ObjC serializes feed/teardown and locks shared pixels/status. View binding is main-thread only.
    unsafe impl Send for Decoder {}
    unsafe impl Sync for Decoder {}
    impl Decoder {
        pub fn new(_: &str) -> Result<Self, String> {
            Ok(Self(unsafe { looi_camera_media_create() }))
        }
        pub fn close(&self) {
            unsafe {
                looi_camera_media_close(self.0);
            }
        }
        pub fn feed(&self, packet: &VideoPacket) -> Result<(), String> {
            let error = unsafe {
                looi_camera_media_feed(
                    self.0,
                    packet.codec,
                    packet.data.as_ptr(),
                    packet.data.len(),
                    packet.timestamp_ms as i64,
                )
            };
            if error == 0 {
                Ok(())
            } else {
                Err(format!("camera_decode_{error}"))
            }
        }
        pub fn status(&self) -> Status {
            let mut s = Status::default();
            let mut displayed = 0;
            unsafe {
                looi_camera_media_status(
                    self.0,
                    &mut s.frames,
                    &mut s.width,
                    &mut s.height,
                    &mut s.timestamp_ms,
                    &mut s.error,
                    &mut displayed,
                );
            }
            s.displayed = (displayed >= 0).then_some(displayed != 0);
            s
        }
        pub fn jpeg(&self) -> Result<Jpeg, String> {
            let (mut length, mut width, mut height, mut received_at) = (0, 0, 0, 0);
            let bytes = unsafe {
                looi_camera_media_jpeg(
                    self.0,
                    &mut length,
                    &mut width,
                    &mut height,
                    &mut received_at,
                )
            };
            if bytes.is_null() {
                return Err("camera_frame_unavailable".into());
            }
            let data = unsafe { std::slice::from_raw_parts(bytes, length).to_vec() };
            unsafe {
                looi_camera_bytes_free(bytes.cast());
            }
            Ok(Jpeg {
                data,
                width,
                height,
                received_at,
            })
        }
    }
    impl Drop for Decoder {
        fn drop(&mut self) {
            unsafe {
                looi_camera_media_release(self.0);
            }
        }
    }
}

#[cfg(not(any(target_os = "ios", target_os = "android")))]
pub struct Decoder;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
impl Decoder {
    pub fn new(_: &str) -> Result<Self, String> {
        Err("camera_decoder_unavailable".into())
    }
    pub fn close(&self) {}
    pub fn feed(&self, _: &VideoPacket) -> Result<(), String> {
        Err("camera_decoder_unavailable".into())
    }
    pub fn status(&self) -> Status {
        Status::default()
    }
    pub fn jpeg(&self) -> Result<Jpeg, String> {
        Err("camera_decoder_unavailable".into())
    }
}
