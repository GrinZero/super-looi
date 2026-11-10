use nsh_core::prelude::*;
use std::path::PathBuf;

/// App credentials. Apple uses Keychain; Android encrypts private files with a
/// non-exportable AndroidKeyStore AES-GCM key. Agent workspace cannot read them.
#[class]
pub struct CredentialVault {
    #[allow(dead_code)]
    directory: PathBuf,
}

fn validate_key(key: &str) -> Result<(), String> {
    if matches!(key, "model" | "voice" | "home" | "body" | "camera" | "probe") {
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
        } else if cfg!(target_os = "android") {
            "android-keystore"
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
    use security_framework::{
        access_control::{ProtectionMode, SecAccessControl},
        passwords::{self, PasswordOptions},
    };
    use std::path::Path;
    const SERVICE: &str = "com.superlooi.app.credentials.v1";
    const NOT_FOUND: i32 = -25300;

    pub fn get(_: &Path, key: &str) -> Result<String, String> {
        match passwords::generic_password(PasswordOptions::new_generic_password(SERVICE, key)) {
            Ok(bytes) => String::from_utf8(bytes).map_err(|_| "Invalid credential encoding".into()),
            Err(error) if error.code() == NOT_FOUND => Ok(String::new()),
            Err(error) => Err(format!("Keychain read unavailable ({})", error.code())),
        }
    }
    pub fn set(_: &Path, key: &str, value: &[u8]) -> Result<(), String> {
        let mut options = PasswordOptions::new_generic_password(SERVICE, key);
        options.set_access_control(
            SecAccessControl::create_with_protection(
                Some(ProtectionMode::AccessibleWhenUnlockedThisDeviceOnly),
                0,
            )
            .map_err(|_| "Cannot protect Keychain entry")?,
        );
        passwords::set_generic_password_options(value, options)
            .map_err(|error| format!("Keychain write unavailable ({})", error.code()))
    }
    pub fn remove(_: &Path, key: &str) -> Result<(), String> {
        match passwords::delete_generic_password(SERVICE, key) {
            Ok(()) => Ok(()),
            Err(error) if error.code() == NOT_FOUND => Ok(()),
            Err(error) => Err(format!("Keychain delete unavailable ({})", error.code())),
        }
    }
}

#[cfg(target_os = "android")]
#[path = "credentials_android.rs"]
mod platform;

#[cfg(not(any(target_os = "ios", target_os = "macos", target_os = "android")))]
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
