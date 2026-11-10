//! Xiaomi wire cryptography, adapted from Xiaomi Camera Native / go2rtc (MIT).
use base64::{Engine, engine::general_purpose::STANDARD};
use chacha20::cipher::{KeyInit, KeyIvInit, StreamCipher};
use sha2::{Digest, Sha256};

pub fn random<const N: usize>() -> [u8; N] {
    let mut bytes = [0; N];
    getrandom::fill(&mut bytes).expect("OS random source");
    bytes
}
pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
pub fn unhex32(value: &str) -> Result<[u8; 32], String> {
    if value.len() != 64 {
        return Err("camera_invalid_session_key".into());
    }
    let mut out = [0; 32];
    for (i, b) in out.iter_mut().enumerate() {
        *b = u8::from_str_radix(&value[i * 2..i * 2 + 2], 16)
            .map_err(|_| "camera_invalid_session_key")?;
    }
    Ok(out)
}
pub fn keypair() -> ([u8; 32], [u8; 32]) {
    let private = random();
    (
        x25519_dalek::x25519(private, x25519_dalek::X25519_BASEPOINT_BYTES),
        private,
    )
}
pub fn shared(public: [u8; 32], private: [u8; 32]) -> Result<[u8; 32], String> {
    let secret = x25519_dalek::x25519(private, public);
    if secret == [0; 32] {
        return Err("camera_invalid_session_key".into());
    }
    Ok(salsa20::hsalsa::<salsa20::cipher::consts::U10>(&secret.into(), &[0; 16].into()).into())
}
pub fn media(key: &[u8; 32], nonce: &[u8], data: &[u8]) -> Vec<u8> {
    let mut out = data.to_vec();
    let mut iv = [0; 12];
    iv[4..].copy_from_slice(nonce);
    chacha20::ChaCha20::new(key.into(), (&iv).into()).apply_keystream(&mut out);
    out
}
pub fn encrypt_media(key: &[u8; 32], data: &[u8]) -> Vec<u8> {
    let nonce: [u8; 8] = random();
    let mut out = nonce.to_vec();
    out.extend(media(key, &nonce, data));
    out
}
pub fn decrypt_media(key: &[u8; 32], data: &[u8]) -> Result<Vec<u8>, String> {
    if data.len() < 8 {
        return Err("camera_truncated_ciphertext".into());
    }
    Ok(media(key, &data[..8], &data[8..]))
}
pub fn rc4(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut cipher = rc4::Rc4::new_from_slice(key).expect("RC4 SHA256 key");
    cipher.apply_keystream(&mut [0; 1024]);
    let mut out = data.to_vec();
    cipher.apply_keystream(&mut out);
    out
}
fn signature(path: &str, data: &str, hash: Option<&str>, signed: &[u8]) -> String {
    let mut input = format!("POST&{path}&data={data}");
    if let Some(hash) = hash {
        input.push_str(&format!("&rc4_hash__={hash}"));
    }
    input.push('&');
    input.push_str(&STANDARD.encode(signed));
    STANDARD.encode(sha1::Sha1::digest(input.as_bytes()))
}
pub fn cloud_request(
    security: &[u8],
    path: &str,
    data: &str,
) -> (Vec<(&'static str, String)>, Vec<u8>) {
    let mut nonce = random::<8>().to_vec();
    let minutes = (std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
        / 60) as u32;
    nonce.extend(minutes.to_be_bytes());
    cloud_with_nonce(security, path, data, &nonce)
}
fn cloud_with_nonce(
    security: &[u8],
    path: &str,
    data: &str,
    nonce: &[u8],
) -> (Vec<(&'static str, String)>, Vec<u8>) {
    let signed = Sha256::digest([security, nonce].concat()).to_vec();
    let hash = signature(path, data, None, &signed);
    let data = STANDARD.encode(rc4(&signed, data.as_bytes()));
    let hash = STANDARD.encode(rc4(&signed, hash.as_bytes()));
    (
        vec![
            ("signature", signature(path, &data, Some(&hash), &signed)),
            ("data", data),
            ("rc4_hash__", hash),
            ("_nonce", STANDARD.encode(nonce)),
        ],
        signed,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn wire_matches_independent_python_camera_protocol_vectors() {
        let key = shared(
            unhex32("de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f").unwrap(),
            std::array::from_fn(|i| i as u8),
        )
        .unwrap();
        assert_eq!(
            hex(&key),
            "529720b0be4ccf101706faa7494712a4c2ba72377d7f80818371981a1d6295ac"
        );
        assert_eq!(
            hex(&media(
                &key,
                &[0, 1, 2, 3, 4, 5, 6, 7],
                &(0..64).collect::<Vec<u8>>()
            )),
            "b3efa9941fd3ecadba18ea74acceeb95232811136dc284e1bfc72636770ba131ecb74122ac1604ab06a28e90c7f782c01d6c3403ec4fb9fb5cdfd45657a7a031"
        );
        let (form, signed) = cloud_with_nonce(
            &(0..16).collect::<Vec<u8>>(),
            "/v2/device/miss_get_vendor",
            "{\"did\":\"123\"}",
            &(0..12).collect::<Vec<u8>>(),
        );
        assert_eq!(
            hex(&signed),
            "373e9830eef49fbe484c97974d6a62c975cba7a201674c93d3f844241d050ce8"
        );
        let form: std::collections::HashMap<_, _> = form.into_iter().collect();
        assert_eq!(form["data"], "Gjc90s2TFXrIE6edrw==");
        assert_eq!(
            form["rc4_hash__"],
            "GyENzv7oFhWpGe3pvFiLV5guMMMviBCpIpkPQA=="
        );
        assert_eq!(form["signature"], "JMaRjc+RLK5kVCQKa3xxMDE60qc=");
    }
}
