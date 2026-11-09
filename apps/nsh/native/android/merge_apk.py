"""Apply the app's registered manifest and DEX plugin before APK signing."""
import hashlib
import json
import os
import re
import shutil
import sys
import zipfile
from pathlib import Path
from patch_manifest import patch, parse_strings, u16, u32, ANDROID, NO_INDEX


def application_name(manifest):
    chunks, offset = [], 8
    while offset < len(manifest):
        size = u32(manifest, offset + 4)
        chunks.append(manifest[offset:offset + size])
        offset += size
    strings = parse_strings(next(chunk for chunk in chunks if u16(chunk, 0) == 1))
    for chunk in chunks:
        if u16(chunk, 0) != 0x102 or strings[u32(chunk, 20)] != "application":
            continue
        start = 16 + u16(chunk, 24)
        for index in range(u16(chunk, 28)):
            attr = chunk[start + index * 20:start + (index + 1) * 20]
            if u32(attr, 0) != NO_INDEX and strings[u32(attr, 0)] == ANDROID and strings[u32(attr, 4)] == "name":
                return strings[u32(attr, 16)]


def merge(original, dex, out, application, backup, orientation, permissions=()):
    # Android's ZIP implementation accepts ZIP32 through 4 GiB. Python's default
    # switches its central directory to ZIP64 at 2 GiB, breaking large debug APKs.
    zipfile.ZIP64_LIMIT = 0xFFFFFFFF
    marker = "assets/super-looi-native-plugin.json"
    with zipfile.ZipFile(original) as src, zipfile.ZipFile(out, "w", allowZip64=False) as dst:
        names = src.namelist()
        if len(names) != len(set(names)):
            raise ValueError("Duplicate APK entry")
        previous = json.loads(src.read(marker)) if marker in names else None
        owned = previous.get("dex") if previous else None
        if previous:
            match = re.fullmatch(r"classes([1-9][0-9]*)[.]dex", owned or "")
            if previous.get("version") != 1 or not match or int(match[1]) < 2 or owned not in names:
                raise ValueError("Invalid plugin DEX marker")
            if hashlib.sha256(src.read(owned)).hexdigest() != previous.get("sha256"):
                raise ValueError("Plugin DEX integrity mismatch")
            for name, digest in previous.get("native_libs", {}).items():
                if name not in names or hashlib.sha256(src.read(name)).hexdigest() != digest:
                    raise ValueError("Plugin native library integrity mismatch")
        manifest = src.read("AndroidManifest.xml")
        if not previous and application_name(manifest) == application:
            raise ValueError("Existing Application has no plugin DEX marker")
        number = 2
        while f"classes{number}.dex" in names and f"classes{number}.dex" != owned:
            number += 1
        dex_name = f"classes{number}.dex"
        native_libs = {}
        cache = os.environ.get("LOOI_SHERPA_CACHE_DIR")
        if cache:
            for abi in ("arm64-v8a", "armeabi-v7a", "x86_64"):
                if f"lib/{abi}/libnsh.so" not in names:
                    continue
                for library in ("libonnxruntime.so", "libsherpa-onnx-c-api.so"):
                    name = f"lib/{abi}/{library}"
                    source = Path(cache) / "android/jniLibs" / abi / library
                    with source.open("rb") as file:
                        native_libs[name] = hashlib.file_digest(file, "sha256").hexdigest()
        linux = os.environ.get("LOOI_LINUX_CACHE_DIR")
        linux_sources = {}
        if linux and "lib/arm64-v8a/libnsh.so" in names:
            for library in ("libproot.so", "libproot-loader.so"):
                name = f"lib/arm64-v8a/{library}"
                source = Path(linux) / "android/jniLibs/arm64-v8a" / library
                linux_sources[name] = source
                with source.open("rb") as file:
                    native_libs[name] = hashlib.file_digest(file, "sha256").hexdigest()
            linux_sources["assets/alpine-minirootfs.tar.gz"] = Path(linux) / "alpine-minirootfs.tar.gz"
            for license in (Path(__file__).parents[1] / "linux/licenses").iterdir():
                if license.is_file(): linux_sources[f"assets/licenses/linux-shell/{license.name}"] = license
        for item in src.infolist():
            if item.filename.startswith("META-INF/") or item.filename in ("AndroidManifest.xml", marker, owned) or item.filename in native_libs or item.filename in linux_sources:
                continue
            with src.open(item) as reader, dst.open(item, "w") as writer:
                shutil.copyfileobj(reader, writer, 1024 * 1024)
        dst.writestr("AndroidManifest.xml", patch(manifest, application, backup, orientation, permissions), compress_type=zipfile.ZIP_DEFLATED)
        dst.write(dex, dex_name, compress_type=zipfile.ZIP_DEFLATED)
        for name in native_libs:
            if name in linux_sources: continue
            library = Path(cache) / "android/jniLibs" / name.removeprefix("lib/")
            dst.write(library, name, compress_type=zipfile.ZIP_STORED)
        for name, source in linux_sources.items():
            dst.write(source, name, compress_type=zipfile.ZIP_STORED)
        with open(dex, "rb") as file:
            digest = hashlib.file_digest(file, "sha256").hexdigest()
        dst.writestr(marker, json.dumps({"version": 1, "dex": dex_name, "sha256": digest, "native_libs": native_libs}), compress_type=zipfile.ZIP_DEFLATED)


if __name__ == "__main__":
    original, dex, out, application, backup, orientation, *permissions = sys.argv[1:]
    merge(original, dex, out, application, backup == "true", orientation, permissions)
