//! App-owned native capabilities, registered in the fixed NSH host.
use nsh_core::prelude::*;
mod audio;
mod ble;
mod compat;
mod credentials;
mod camera;
mod device_camera;
mod lan_room;
#[cfg(target_os = "ios")]
mod application_lifecycle;
#[cfg(all(any(target_os = "android", target_os = "ios"), target_arch = "aarch64"))]
mod linux_shell;
mod login_browser;
use audio::VoiceAudio;
use ble::LooiBle;
use compat::NodeCompat;
use credentials::CredentialVault;
use login_browser::MiotLoginBrowser;

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
        .class::<lan_room::LanRoomHost>();
}

#[cfg(target_os = "ios")]
#[native_components(ios)]
fn components(components: &nsh_platform_ios::Components) {
    application_lifecycle::install(
        objc2::MainThreadMarker::new().expect("iOS components register on the main thread"),
    );
    components.register("looi.CameraVideo", camera::view_ios::factory());
    components.register("looi.DeviceCameraPreview", device_camera::view_ios::factory());
}
