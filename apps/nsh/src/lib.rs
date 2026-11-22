//! App-owned native capabilities, registered in the fixed NSH host.
use nsh_core::prelude::*;
mod audio;
mod ble;
mod compat;
mod credentials;
mod camera;
mod device_camera;
mod device_motion;
mod lan_room;
#[cfg(target_os = "ios")]
mod application_lifecycle;
#[cfg(all(any(target_os = "android", target_os = "ios"), target_arch = "aarch64"))]
mod linux_shell;
mod login_browser;
mod schedule_native;
use audio::VoiceAudio;
use ble::LooiBle;
use compat::NodeCompat;
use credentials::CredentialVault;
use login_browser::MiotLoginBrowser;
use schedule_native::ScheduleHost;

/// Returns a monotonic clock timestamp in milliseconds shared across camera and IMU pipelines.
pub(crate) fn host_monotonic_ms() -> f64 {
    #[cfg(any(target_os = "ios", target_os = "android"))]
    {
        let mut ts = libc::timespec {
            tv_sec: 0,
            tv_nsec: 0,
        };
        let rc = unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut ts) };
        if rc == 0 {
            return (ts.tv_sec as f64) * 1000.0 + (ts.tv_nsec as f64) / 1_000_000.0;
        }
    }
    static MONOTONIC_EPOCH: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
    MONOTONIC_EPOCH
        .get_or_init(std::time::Instant::now)
        .elapsed()
        .as_secs_f64()
        * 1000.0
}

/// Private Node-compatible sandbox and OS credential vault for Super LOOI.
#[native_module("super-looi/native")]
fn native(registry: &mut Registry) {
    registry
        .class::<NodeCompat>()
        .class::<CredentialVault>()
        .class::<VoiceAudio>()
        .class::<LooiBle>()
        .class::<MiotLoginBrowser>()
        .class::<camera::XiaomiCameraHost>()
        .class::<device_camera::DeviceCameraHost>()
        .class::<device_motion::DeviceMotionHost>()
        .class::<lan_room::LanRoomHost>()
        .class::<ScheduleHost>();
}

#[cfg(target_os = "ios")]
#[native_components(ios)]
fn components(components: &nsh_platform_ios::Components) {
    application_lifecycle::install(
        objc2::MainThreadMarker::new().expect("iOS components register on the main thread"),
    );
    schedule_native::ios::install();
    components.register("looi.CameraVideo", camera::view_ios::factory());
    components.register("looi.DeviceCameraPreview", device_camera::view_ios::factory());
}
