"""Apply the app's registered manifest and DEX plugin before APK signing."""
import hashlib
import json
import re
import shutil
import sys
import zipfile
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


def merge(original, dex, out, application, backup):
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
        manifest = src.read("AndroidManifest.xml")
        if not previous and application_name(manifest) == application:
            raise ValueError("Existing Application has no plugin DEX marker")
        number = 2
        while f"classes{number}.dex" in names and f"classes{number}.dex" != owned:
            number += 1
        dex_name = f"classes{number}.dex"
        for item in src.infolist():
            if item.filename.startswith("META-INF/") or item.filename in ("AndroidManifest.xml", marker, owned):
                continue
            with src.open(item) as reader, dst.open(item, "w") as writer:
                shutil.copyfileobj(reader, writer, 1024 * 1024)
        dst.writestr("AndroidManifest.xml", patch(manifest, application, backup), compress_type=zipfile.ZIP_DEFLATED)
        dst.write(dex, dex_name, compress_type=zipfile.ZIP_DEFLATED)
        with open(dex, "rb") as file:
            digest = hashlib.file_digest(file, "sha256").hexdigest()
        dst.writestr(marker, json.dumps({"version": 1, "dex": dex_name, "sha256": digest}), compress_type=zipfile.ZIP_DEFLATED)


if __name__ == "__main__":
    original, dex, out, application, backup = sys.argv[1:]
    merge(original, dex, out, application, backup == "true")
