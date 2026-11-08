use std::{env, path::PathBuf};

fn main() {
    println!("cargo:rerun-if-env-changed=LOOI_SHERPA_CACHE_DIR");
    let target = env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    if target != "ios" && target != "android" {
        return;
    }
    let cache = PathBuf::from(
        env::var("LOOI_SHERPA_CACHE_DIR").expect("Prepare sherpa-onnx before mobile build"),
    );
    let model = cache.join("model/sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20");
    for name in [
        "encoder-epoch-13-avg-2-chunk-16-left-64.int8.onnx",
        "decoder-epoch-13-avg-2-chunk-16-left-64.onnx",
        "joiner-epoch-13-avg-2-chunk-16-left-64.int8.onnx",
        "tokens.txt",
    ] {
        let path = model.join(name);
        assert!(path.is_file(), "Missing KWS model: {}", path.display());
        println!("cargo:rerun-if-changed={}", path.display());
    }
    println!("cargo:rustc-env=LOOI_KWS_MODEL_DIR={}", model.display());
    if target == "ios" {
        let triple = env::var("TARGET").unwrap_or_default();
        let simulator = env::var("CARGO_CFG_TARGET_ABI").unwrap_or_default() == "sim"
            || triple.contains("-sim")
            || triple == "x86_64-apple-ios";
        let base = cache.join("ios/build-ios-no-tts");
        let arch = env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default();
        let derived = cache.join("ios/derived").join(format!(
            "{}-sim",
            if arch == "x86_64" { "x86_64" } else { "arm64" }
        ));
        println!(
            "cargo:rustc-link-search=native={}",
            if simulator {
                derived.clone()
            } else {
                base.join("sherpa-onnx.xcframework/ios-arm64")
            }
            .display()
        );
        println!("cargo:rustc-link-lib=static=sherpa-onnx");
        println!(
            "cargo:rustc-link-search=native={}",
            if simulator {
                derived
            } else {
                base.join("ios-onnxruntime/1.17.1/onnxruntime.xcframework/ios-arm64")
            }
            .display()
        );
        println!("cargo:rustc-link-lib=static=onnxruntime");
        println!("cargo:rustc-link-lib=c++");
        println!("cargo:rustc-link-lib=framework=Foundation");
        println!("cargo:rustc-link-lib=framework=Accelerate");
    } else {
        let abi = match env::var("CARGO_CFG_TARGET_ARCH")
            .unwrap_or_default()
            .as_str()
        {
            "aarch64" => "arm64-v8a",
            "arm" => "armeabi-v7a",
            "x86_64" => "x86_64",
            _ => panic!("Unsupported Android architecture"),
        };
        println!(
            "cargo:rustc-link-search=native={}",
            cache.join("android/jniLibs").join(abi).display()
        );
        println!("cargo:rustc-link-lib=dylib=sherpa-onnx-c-api");
        println!("cargo:rustc-link-lib=dylib=onnxruntime");
    }
}
