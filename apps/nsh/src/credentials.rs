use nsh_core::element::Local;
use nsh_core::prelude::*;
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
};

/// Shared by vaults of one emulated VM; never shared with another test or OS store.
#[derive(Default)]
struct EmulatedCredentials(Arc<Mutex<HashMap<String, String>>>);

impl Local for EmulatedCredentials {}

/// App credentials in Apple Keychain, Android Keystore-encrypted private files,
/// or Linux Secret Service. Agent workspace cannot read them.
#[class]
pub struct CredentialVault {
    #[allow(dead_code)]
    directory: PathBuf,
    emulated: Option<Arc<Mutex<HashMap<String, String>>>>,
}

fn validate_key(key: &str) -> Result<(), String> {
    if matches!(
        key,
        "model" | "voice" | "home" | "body" | "camera" | "probe" | "github"
    ) {
        Ok(())
    } else {
        Err("Unsupported credential slot".into())
    }
}

#[class]
impl CredentialVault {
    /// The selected store; emulated platforms keep credentials in their VM only.
    pub fn backend(&self) -> String {
        if self.emulated.is_some() {
            "emulated-memory"
        } else if cfg!(target_os = "ios") {
            "ios-keychain"
        } else if cfg!(target_os = "macos") {
            "macos-keychain"
        } else if cfg!(target_os = "android") {
            "android-keystore"
        } else if cfg!(target_os = "linux") {
            "linux-secret-service"
        } else {
            "desktop"
        }
        .to_owned()
    }
    /// Open only the host's private app directory; JS cannot choose its path.
    pub fn new(sys: System) -> Result<Self, String> {
        let data = sys
            .data_dir
            .as_ref()
            .ok_or("Private app storage unavailable")?;
        for write in [true, false] {
            sys.access
                .authorize_file_with_paths(data, data, &sys.paths, write)
                .map_err(|_| "Credential storage access denied")?;
        }
        let directory = data.join("credentials");
        // Headless tests can emulate another OS. Its private directory does not
        // namespace Keychain/Secret Service, so select a VM-owned store instead.
        let emulated = (sys.os.name() != std::env::consts::OS)
            .then(|| sys.locals.get::<EmulatedCredentials>().0.clone());
        #[cfg(target_os = "android")]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::create_dir_all(&directory).map_err(|_| "Cannot create credential storage")?;
            std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700))
                .map_err(|_| "Cannot protect credential storage")?;
        }
        Ok(Self {
            directory,
            emulated,
        })
    }

    /// Read one slot. Empty means absent; access/decryption errors are failures.
    pub fn get(&self, key: String) -> Result<String, String> {
        validate_key(&key)?;
        if let Some(slots) = &self.emulated {
            return slots
                .lock()
                .map(|slots| slots.get(&key).cloned().unwrap_or_default())
                .map_err(|error| format!("Emulated credential read failed: {error}"));
        }
        platform::get(&self.directory, &key)
    }

    /// Persist a bounded credential. It is never logged or stored in workspace.
    pub fn set(&self, key: String, value: String) -> Result<(), String> {
        validate_key(&key)?;
        if value.is_empty() || value.len() > 32_768 {
            return Err("Invalid credential length".into());
        }
        if let Some(slots) = &self.emulated {
            slots
                .lock()
                .map_err(|error| format!("Emulated credential write failed: {error}"))?
                .insert(key, value);
            return Ok(());
        }
        platform::set(&self.directory, &key, value.as_bytes())
    }

    /// Delete the stored slot; absence is idempotent.
    pub fn remove(&self, key: String) -> Result<(), String> {
        validate_key(&key)?;
        if let Some(slots) = &self.emulated {
            slots
                .lock()
                .map_err(|error| format!("Emulated credential delete failed: {error}"))?
                .remove(&key);
            return Ok(());
        }
        platform::remove(&self.directory, &key)
    }
}

#[cfg(any(target_os = "ios", target_os = "macos"))]
mod platform {
    #[cfg(target_os = "ios")]
    use security_framework::access_control::{ProtectionMode, SecAccessControl};
    use security_framework::passwords::{self, PasswordOptions};
    use std::path::Path;
    const SERVICE: &str = "com.superlooi.app.credentials.v1";
    const NOT_FOUND: i32 = -25300;

    pub fn get(_: &Path, key: &str) -> Result<String, String> {
        match passwords::generic_password(PasswordOptions::new_generic_password(SERVICE, key)) {
            Ok(bytes) => String::from_utf8(bytes)
                .map_err(|error| format!("Keychain decode failed: {}", error.utf8_error())),
            Err(error) if error.code() == NOT_FOUND => Ok(String::new()),
            Err(error) => Err(format!("Keychain read failed ({}): {error}", error.code())),
        }
    }
    pub fn set(_: &Path, key: &str, value: &[u8]) -> Result<(), String> {
        let options = PasswordOptions::new_generic_password(SERVICE, key);
        #[cfg(target_os = "ios")]
        let options = {
            let mut options = options;
            options.set_access_control(
                SecAccessControl::create_with_protection(
                    Some(ProtectionMode::AccessibleWhenUnlockedThisDeviceOnly),
                    0,
                )
                .map_err(|error| {
                    format!("Keychain access control failed ({}): {error}", error.code())
                })?,
            );
            options
        };
        passwords::set_generic_password_options(value, options)
            .map_err(|error| format!("Keychain write failed ({}): {error}", error.code()))
    }
    pub fn remove(_: &Path, key: &str) -> Result<(), String> {
        match passwords::delete_generic_password(SERVICE, key) {
            Ok(()) => Ok(()),
            Err(error) if error.code() == NOT_FOUND => Ok(()),
            Err(error) => Err(format!(
                "Keychain delete failed ({}): {error}",
                error.code()
            )),
        }
    }
}

#[cfg(target_os = "android")]
#[path = "credentials_android.rs"]
mod platform;

#[cfg(target_os = "linux")]
#[path = "credentials_linux.rs"]
mod platform;

#[cfg(not(any(
    target_os = "ios",
    target_os = "macos",
    target_os = "android",
    target_os = "linux"
)))]
mod platform {
    use std::path::Path;
    pub fn get(_: &Path, _: &str) -> Result<String, String> {
        Err("Secure credentials unavailable on this platform".into())
    }
    pub fn set(_: &Path, _: &str, _: &[u8]) -> Result<(), String> {
        Err("Secure credentials unavailable on this platform".into())
    }
    pub fn remove(_: &Path, _: &str) -> Result<(), String> {
        Err("Secure credentials unavailable on this platform".into())
    }
}

#[cfg(all(test, any(target_os = "macos", target_os = "linux")))]
mod tests {
    use super::*;

    fn system(data: &std::path::Path, os: nsh_core::platform::Os) -> System {
        let mut sys = System::default().with_os(os);
        sys.data_dir = Some(data.to_owned());
        let access = Arc::make_mut(&mut sys.access);
        access.declared.fs.read = vec!["${dataDir}".into()];
        access.declared.fs.write = vec!["${dataDir}".into()];
        sys
    }

    #[test]
    fn emulated_mobile_vault_never_selects_the_desktop_keychain() -> Result<(), String> {
        let data = tempfile::tempdir().map_err(|error| error.to_string())?;
        for os in [nsh_core::platform::Os::Ios, nsh_core::platform::Os::Android] {
            let sys = system(data.path(), os);
            let vault = CredentialVault::new(sys.clone())?;
            // Check routing before any I/O so a regression cannot open an auth dialog.
            assert_eq!(vault.backend(), "emulated-memory");
            assert_eq!(vault.get("model".into())?, "");
            vault.set("model".into(), "test credential 你好".into())?;
            let reopened = CredentialVault::new(sys.clone())?;
            assert_eq!(reopened.get("model".into())?, "test credential 你好");
            reopened.set("model".into(), "updated".into())?;
            assert_eq!(vault.get("model".into())?, "updated");

            // Even identical paths must not leak credentials across test VMs.
            let other = CredentialVault::new(system(data.path(), os))?;
            assert_eq!(other.get("model".into())?, "");
            reopened.remove("model".into())?;
            reopened.remove("model".into())?;
            assert_eq!(vault.get("model".into())?, "");
        }
        Ok(())
    }

    #[test]
    fn github_slot_is_supported_and_unknown_slots_are_rejected() -> Result<(), String> {
        let data = tempfile::tempdir().map_err(|error| error.to_string())?;
        for os in [nsh_core::platform::Os::Ios, nsh_core::platform::Os::Android] {
            let sys = system(data.path(), os);
            let vault = CredentialVault::new(sys.clone())?;
            assert_eq!(vault.get("github".into())?, "");
            vault.set("github".into(), "github_pat_test_readonly".into())?;
            let reopened = CredentialVault::new(sys)?;
            assert_eq!(reopened.get("github".into())?, "github_pat_test_readonly");
            reopened.remove("github".into())?;
            assert_eq!(vault.get("github".into())?, "");
            assert_eq!(
                vault.get("unsupported_slot".into()).unwrap_err(),
                "Unsupported credential slot"
            );
        }
        Ok(())
    }

    #[test]
    fn matching_host_keeps_the_native_store() -> Result<(), String> {
        let data = tempfile::tempdir().map_err(|error| error.to_string())?;
        let os = if cfg!(target_os = "macos") {
            nsh_core::platform::Os::MacOs
        } else {
            nsh_core::platform::Os::Linux
        };
        let vault = CredentialVault::new(system(data.path(), os))?;
        assert_eq!(
            vault.backend(),
            if cfg!(target_os = "macos") {
                "macos-keychain"
            } else {
                "linux-secret-service"
            }
        );
        Ok(())
    }

    #[test]
    #[ignore = "requires an unlocked desktop system credential store; uses only the probe slot"]
    fn desktop_system_store_round_trip() -> Result<(), String> {
        let vault = CredentialVault {
            directory: PathBuf::new(),
            emulated: None,
        };
        assert_eq!(
            vault.backend(),
            if cfg!(target_os = "macos") {
                "macos-keychain"
            } else {
                "linux-secret-service"
            }
        );
        let result = (|| {
            vault.remove("probe".into())?;
            vault.remove("probe".into())?;
            assert_eq!(vault.get("probe".into())?, "");
            vault.set("probe".into(), "desktop vault 你好 🔑".into())?;
            let reopened = CredentialVault {
                directory: PathBuf::new(),
                emulated: None,
            };
            assert_eq!(reopened.get("probe".into())?, "desktop vault 你好 🔑");
            reopened.set("probe".into(), "updated desktop credential".into())?;
            assert_eq!(vault.get("probe".into())?, "updated desktop credential");
            vault.remove("probe".into())?;
            assert_eq!(reopened.get("probe".into())?, "");
            Ok(())
        })();
        let cleanup = vault.remove("probe".into());
        result.and(cleanup)
    }
}
