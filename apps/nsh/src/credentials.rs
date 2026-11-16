use nsh_core::prelude::*;
use std::path::PathBuf;

/// App credentials in Apple Keychain, Android Keystore-encrypted private files,
/// or Linux Secret Service. Agent workspace cannot read them.
#[class]
pub struct CredentialVault {
    #[allow(dead_code)]
    directory: PathBuf,
}

fn validate_key(key: &str) -> Result<(), String> {
    if matches!(
        key,
        "model" | "voice" | "home" | "body" | "camera" | "probe"
    ) {
        Ok(())
    } else {
        Err("Unsupported credential slot".into())
    }
}

#[class]
impl CredentialVault {
    /// The compiled native backend (independent of a test's emulated UI OS).
    pub fn backend(&self) -> String {
        if cfg!(target_os = "ios") {
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
        #[cfg(target_os = "android")]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::create_dir_all(&directory).map_err(|_| "Cannot create credential storage")?;
            std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700))
                .map_err(|_| "Cannot protect credential storage")?;
        }
        Ok(Self { directory })
    }

    /// Read one slot. Empty means absent; access/decryption errors are failures.
    pub fn get(&self, key: String) -> Result<String, String> {
        validate_key(&key)?;
        platform::get(&self.directory, &key)
    }

    /// Persist a bounded credential. It is never logged or stored in workspace.
    pub fn set(&self, key: String, value: String) -> Result<(), String> {
        validate_key(&key)?;
        if value.is_empty() || value.len() > 32_768 {
            return Err("Invalid credential length".into());
        }
        platform::set(&self.directory, &key, value.as_bytes())
    }

    /// Delete the stored slot; absence is idempotent.
    pub fn remove(&self, key: String) -> Result<(), String> {
        validate_key(&key)?;
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

    #[test]
    #[ignore = "requires an unlocked desktop system credential store; uses only the probe slot"]
    fn desktop_system_store_round_trip() -> Result<(), String> {
        let vault = CredentialVault {
            directory: PathBuf::new(),
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
