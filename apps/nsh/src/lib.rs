//! App-owned native capabilities, registered in the fixed NSH host.
use nsh_core::prelude::*;
mod audio;
mod compat;
mod credentials;
use audio::VoiceAudio;
use compat::NodeCompat;
use credentials::CredentialVault;

/// Private Node-compatible sandbox and OS credential vault for Super LOOI.
#[native_module("super-looi/native")]
fn native(registry: &mut Registry) {
    registry.class::<NodeCompat>().class::<CredentialVault>().class::<VoiceAudio>();
}
