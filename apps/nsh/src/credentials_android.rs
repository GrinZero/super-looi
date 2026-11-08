use jni::{
    JNIEnv, JavaVM,
    objects::{JByteArray, JObject, JValue},
};
use std::{
    io::Write,
    os::unix::fs::OpenOptionsExt,
    path::Path,
    sync::{Mutex, OnceLock},
};

const ALIAS: &str = "com.superlooi.app.credentials.v1";

static VM: OnceLock<JavaVM> = OnceLock::new();
static VAULT_LOCK: Mutex<()> = Mutex::new(());

/// The app's registered Android Application calls this after loading NSH.
/// NSH retains its own JNI_OnLoad; no private Android runtime symbols are used.
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_superlooi_nsh_SuperLooiApplication_registerVm(
    env: JNIEnv<'_>,
    _: jni::objects::JClass<'_>,
) {
    if let Ok(vm) = env.get_java_vm() {
        let _ = VM.set(vm);
    }
}

fn with_env<T>(
    operation: impl FnOnce(&mut JNIEnv<'_>) -> jni::errors::Result<T>,
) -> Result<T, String> {
    let vm = VM
        .get()
        .ok_or("Android application plugin is not initialized")?;
    let mut env = vm
        .attach_current_thread()
        .map_err(|_| "Android VM attachment failed")?;
    let result = env.with_local_frame(128, operation);
    if result.is_err() {
        let _ = env.exception_clear();
    }
    result.map_err(|_| "Android Keystore operation failed".into())
}

fn key<'a>(env: &mut JNIEnv<'a>, create: bool) -> jni::errors::Result<JObject<'a>> {
    let provider = env.new_string("AndroidKeyStore")?;
    let store = env
        .call_static_method(
            "java/security/KeyStore",
            "getInstance",
            "(Ljava/lang/String;)Ljava/security/KeyStore;",
            &[JValue::Object(&provider)],
        )?
        .l()?;
    env.call_method(
        &store,
        "load",
        "(Ljava/io/InputStream;[C)V",
        &[
            JValue::Object(&JObject::null()),
            JValue::Object(&JObject::null()),
        ],
    )?;
    let alias = env.new_string(ALIAS)?;
    let existing = env
        .call_method(
            &store,
            "getKey",
            "(Ljava/lang/String;[C)Ljava/security/Key;",
            &[JValue::Object(&alias), JValue::Object(&JObject::null())],
        )?
        .l()?;
    if !existing.is_null() || !create {
        return Ok(existing);
    }
    let algorithm = env.new_string("AES")?;
    let generator = env
        .call_static_method(
            "javax/crypto/KeyGenerator",
            "getInstance",
            "(Ljava/lang/String;Ljava/lang/String;)Ljavax/crypto/KeyGenerator;",
            &[JValue::Object(&algorithm), JValue::Object(&provider)],
        )?
        .l()?;
    let builder = env.new_object(
        "android/security/keystore/KeyGenParameterSpec$Builder",
        "(Ljava/lang/String;I)V",
        &[JValue::Object(&alias), JValue::Int(3)],
    )?;
    let modes = env.new_object_array(1, "java/lang/String", JObject::null())?;
    let gcm = env.new_string("GCM")?;
    env.set_object_array_element(&modes, 0, &gcm)?;
    env.call_method(
        &builder,
        "setBlockModes",
        "([Ljava/lang/String;)Landroid/security/keystore/KeyGenParameterSpec$Builder;",
        &[JValue::Object(&modes)],
    )?;
    let paddings = env.new_object_array(1, "java/lang/String", JObject::null())?;
    let padding = env.new_string("NoPadding")?;
    env.set_object_array_element(&paddings, 0, &padding)?;
    env.call_method(
        &builder,
        "setEncryptionPaddings",
        "([Ljava/lang/String;)Landroid/security/keystore/KeyGenParameterSpec$Builder;",
        &[JValue::Object(&paddings)],
    )?;
    env.call_method(
        &builder,
        "setKeySize",
        "(I)Landroid/security/keystore/KeyGenParameterSpec$Builder;",
        &[JValue::Int(256)],
    )?;
    let spec = env
        .call_method(
            &builder,
            "build",
            "()Landroid/security/keystore/KeyGenParameterSpec;",
            &[],
        )?
        .l()?;
    env.call_method(
        &generator,
        "init",
        "(Ljava/security/spec/AlgorithmParameterSpec;)V",
        &[JValue::Object(&spec)],
    )?;
    env.call_method(&generator, "generateKey", "()Ljavax/crypto/SecretKey;", &[])?
        .l()
}

fn crypt(slot: &str, input: &[u8], encrypt: bool) -> Result<Vec<u8>, String> {
    with_env(|env| {
        let key = key(env, encrypt)?;
        if key.is_null() {
            return Err(jni::errors::Error::NullPtr("credential key"));
        }
        let algorithm = env.new_string("AES/GCM/NoPadding")?;
        let cipher = env
            .call_static_method(
                "javax/crypto/Cipher",
                "getInstance",
                "(Ljava/lang/String;)Ljavax/crypto/Cipher;",
                &[JValue::Object(&algorithm)],
            )?
            .l()?;
        let payload = if encrypt {
            env.call_method(
                &cipher,
                "init",
                "(ILjava/security/Key;)V",
                &[JValue::Int(1), JValue::Object(&key)],
            )?;
            input
        } else {
            let iv = env.byte_array_from_slice(&input[1..13])?;
            let spec = env.new_object(
                "javax/crypto/spec/GCMParameterSpec",
                "(I[B)V",
                &[JValue::Int(128), JValue::Object(&iv)],
            )?;
            env.call_method(
                &cipher,
                "init",
                "(ILjava/security/Key;Ljava/security/spec/AlgorithmParameterSpec;)V",
                &[JValue::Int(2), JValue::Object(&key), JValue::Object(&spec)],
            )?;
            &input[13..]
        };
        let aad = env.byte_array_from_slice(slot.as_bytes())?;
        env.call_method(&cipher, "updateAAD", "([B)V", &[JValue::Object(&aad)])?;
        let bytes = env.byte_array_from_slice(payload)?;
        let result = env
            .call_method(&cipher, "doFinal", "([B)[B", &[JValue::Object(&bytes)])?
            .l()?;
        let result = env.convert_byte_array(JByteArray::from(result))?;
        if !encrypt {
            return Ok(result);
        }
        let iv = env.call_method(&cipher, "getIV", "()[B", &[])?.l()?;
        let iv = env.convert_byte_array(JByteArray::from(iv))?;
        if iv.len() != 12 {
            return Err(jni::errors::Error::NullPtr("credential IV"));
        }
        let mut blob = Vec::with_capacity(13 + result.len());
        blob.push(1);
        blob.extend(iv);
        blob.extend(result);
        Ok(blob)
    })
}

pub fn get(directory: &Path, slot: &str) -> Result<String, String> {
    let _guard = VAULT_LOCK
        .lock()
        .map_err(|_| "Credential store lock failed")?;
    let path = directory.join(slot);
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()),
        Err(_) => return Err("Credential read failed".into()),
    };
    if bytes.len() < 29 || bytes.len() > 32_768 + 29 || bytes[0] != 1 {
        return Err("Invalid encrypted credential".into());
    }
    String::from_utf8(crypt(slot, &bytes, false)?).map_err(|_| "Invalid credential encoding".into())
}
pub fn set(directory: &Path, slot: &str, value: &[u8]) -> Result<(), String> {
    let _guard = VAULT_LOCK
        .lock()
        .map_err(|_| "Credential store lock failed")?;
    let bytes = crypt(slot, value, true)?;
    let temporary = directory.join(format!("{slot}.tmp"));
    let write = || -> std::io::Result<()> {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        std::fs::rename(&temporary, directory.join(slot))?;
        std::fs::File::open(directory)?.sync_all()
    };
    write().map_err(|_| "Credential write failed".into())
}
pub fn remove(directory: &Path, slot: &str) -> Result<(), String> {
    let _guard = VAULT_LOCK
        .lock()
        .map_err(|_| "Credential store lock failed")?;
    match std::fs::remove_file(directory.join(slot)) {
        Ok(()) => std::fs::File::open(directory)
            .and_then(|f| f.sync_all())
            .map_err(|_| "Credential delete failed".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("Credential delete failed".into()),
    }
}
