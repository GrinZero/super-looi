//! App-owned native capabilities, registered in the fixed NSH host.
use nsh_core::prelude::*;
mod audio;
mod ble;
mod compat;
mod credentials;
mod camera;
#[cfg(target_os = "ios")]
mod keep_awake;
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
    #[cfg(target_os = "ios")]
    keep_awake::install();
    registry
        .class::<NodeCompat>()
        .class::<CredentialVault>()
        .class::<VoiceAudio>()
        .class::<LooiBle>()
        .class::<MiotLoginBrowser>()
        .class::<camera::XiaomiCameraHost>();
}

#[cfg(target_os = "ios")]
#[native_components(ios)]
fn components(components: &nsh_platform_ios::Components) {
    components.register("looi.CameraVideo", camera::view_ios::factory());
}
