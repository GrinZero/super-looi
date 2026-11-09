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
        if env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default() == "aarch64" {
            let linux = PathBuf::from(
                env::var("LOOI_LINUX_CACHE_DIR").expect("Prepare Linux Shell before mobile build"),
            );
            let ish = linux.join("openminis/deps/ish");
            let build = ish.join(if simulator {
                "build-ios-sim"
            } else {
                "build-ios"
            });
            println!("cargo:rerun-if-env-changed=LOOI_LINUX_CACHE_DIR");
            println!("cargo:rerun-if-changed=native/linux/ish_host.m");
            for library in ["ish", "ish_emu", "fakefs"] {
                println!("cargo:rustc-link-search=native={}", build.display());
                println!("cargo:rustc-link-lib=static={library}");
            }
            cc::Build::new()
                .file("native/linux/ish_host.m")
                .include(&ish)
                .include(&build)
                .define("ISH_INTERNAL", "1")
                .define("GUEST_ARM64", "1")
                .define("ENGINE_ASBESTOS", "1")
                .define("ISH_JIT", "1")
                .define("ISH_JIT_NO_EMIT", "1")
                .flag("-fblocks")
                .flag("-fobjc-arc")
                .compile("looi_ish_host");
        }
        // ONNX's device archive references compiler-rt's stack probe.
        let clang = std::process::Command::new("xcrun")
            .args([
                "--sdk",
                if simulator {
                    "iphonesimulator"
                } else {
                    "iphoneos"
                },
                "clang",
                "--print-resource-dir",
            ])
            .output()
            .expect("Xcode clang resource directory");
        let resources = PathBuf::from(String::from_utf8(clang.stdout).unwrap().trim());
        let runtime = if simulator {
            "clang_rt.iossim"
        } else {
            "clang_rt.ios"
        };
        let output = PathBuf::from(env::var("OUT_DIR").unwrap());
        let arch = env::var("CARGO_CFG_TARGET_ARCH").unwrap();
        let arch = if arch == "aarch64" { "arm64" } else { &arch };
        let status = std::process::Command::new("xcrun")
            .args(["lipo", "-thin", arch])
            .arg(resources.join(format!("lib/darwin/lib{runtime}.a")))
            .arg("-output")
            .arg(output.join(format!("lib{runtime}.a")))
            .status()
            .unwrap();
        assert!(status.success(), "Cannot thin Clang builtins");
        println!("cargo:rustc-link-search=native={}", output.display());
        println!("cargo:rustc-link-lib=static={runtime}");
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
