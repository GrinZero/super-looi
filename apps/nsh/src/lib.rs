//! App-owned native capabilities, registered in the fixed NSH host.
use nsh_core::prelude::*;
mod audio;
mod ble;
mod compat;
mod credentials;
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
        .class::<MiotLoginBrowser>();
}
