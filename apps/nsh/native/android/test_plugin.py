import os
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
import zipfile
from merge_apk import merge


class AndroidPluginTest(unittest.TestCase):
    def test_preserves_manifest_resources_and_secondary_dex_on_reapplication(self):
        sdk = Path(os.environ.get("NSH_REAL_ANDROID_SDK", Path.home() / "Library/Android/sdk"))
        tools = sdk / "build-tools/36.0.0"
        jar = sdk / "platforms/android-35/android.jar"
        self.assertTrue(jar.exists(), "Android plugin verification requires SDK 35")
        with tempfile.TemporaryDirectory(prefix="looi-plugin-test-") as directory:
            root = Path(directory)
            (root / "res/values").mkdir(parents=True)
            (root / "res/values/strings.xml").write_text('<resources><string name="label">Original label</string></resources>')
            manifest = root / "AndroidManifest.xml"
            manifest.write_text('''<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.superlooi.app">
              <uses-permission android:name="android.permission.RECORD_AUDIO"/>
              <application android:label="@string/label" android:allowBackup="true" android:usesCleartextTraffic="true" android:theme="@android:style/Theme.Material.Light.NoActionBar">
                <meta-data android:name="original.metadata" android:value="retained"/>
                <activity android:name="demo.Main" android:exported="true"><intent-filter><action android:name="android.intent.action.MAIN"/><category android:name="android.intent.category.LAUNCHER"/></intent-filter></activity>
                <service android:name="demo.Service" android:exported="false"/>
              </application></manifest>''')
            compiled = root / "resources.zip"
            subprocess.run([str(tools / "aapt2"), "compile", "--dir", str(root / "res"), "-o", str(compiled)], check=True, capture_output=True)
            original = root / "original.apk"
            subprocess.run([str(tools / "aapt2"), "link", "-o", str(original), "-I", str(jar), "--manifest", str(manifest), str(compiled)], check=True, capture_output=True)
            with zipfile.ZipFile(original, "a") as archive:
                archive.writestr("classes.dex", b"original primary dex")
                archive.writestr("classes2.dex", b"original secondary dex")
                archive.writestr("assets/original.bin", b"original asset")
                archive.writestr("lib/arm64-v8a/libnsh.so", b"native host")
            sherpa = root / "sherpa"
            libraries = sherpa / "android/jniLibs/arm64-v8a"
            libraries.mkdir(parents=True)
            (libraries / "libonnxruntime.so").write_bytes(b"onnx runtime")
            (libraries / "libsherpa-onnx-c-api.so").write_bytes(b"keyword spotter")
            linux = root / "linux"
            linux_libraries = linux / "android/jniLibs/arm64-v8a"
            linux_libraries.mkdir(parents=True)
            for library in ("libproot.so", "libproot-loader.so", "liblooi-codex.so", "liblooi-codex-code-mode-host.so"):
                (linux_libraries / library).write_bytes(library.encode())
            (linux / "alpine-minirootfs.tar.gz").write_bytes(b"linux rootfs")
            dex = root / "plugin.dex"
            dex.write_bytes(b"owned plugin test dex")
            first, second = root / "first.apk", root / "second.apk"
            application = "com.superlooi.nsh.SuperLooiApplication"
            previous_cache = os.environ.get("LOOI_SHERPA_CACHE_DIR")
            previous_linux = os.environ.get("LOOI_LINUX_CACHE_DIR")
            os.environ["LOOI_SHERPA_CACHE_DIR"] = str(sherpa)
            os.environ["LOOI_LINUX_CACHE_DIR"] = str(linux)
            try:
                merge(original, dex, first, application, False, "landscape")
                merge(first, dex, second, application, False, "landscape")
            finally:
                if previous_cache is None:
                    os.environ.pop("LOOI_SHERPA_CACHE_DIR", None)
                else:
                    os.environ["LOOI_SHERPA_CACHE_DIR"] = previous_cache
                if previous_linux is None:
                    os.environ.pop("LOOI_LINUX_CACHE_DIR", None)
                else:
                    os.environ["LOOI_LINUX_CACHE_DIR"] = previous_linux
            def tree(path):
                return subprocess.check_output([str(tools / "aapt2"), "dump", "xmltree", "--file", "AndroidManifest.xml", str(path)], text=True)
            def strip_injected_components(text):
                lines = text.splitlines()
                kept = []
                i = 0
                while i < len(lines):
                    line = lines[i]
                    if line.lstrip().startswith(("E: service ", "E: receiver ")) and i + 1 < len(lines) and (
                        "com.superlooi.nsh.ScheduleKeepAliveService" in lines[i + 1]
                        or "com.superlooi.nsh.ScheduleAlarmReceiver" in lines[i + 1]
                    ):
                        indent = len(line) - len(line.lstrip())
                        i += 1
                        while i < len(lines) and (len(lines[i]) - len(lines[i].lstrip())) > indent:
                            i += 1
                        continue
                    kept.append(line)
                    i += 1
                return "\n".join(kept)
            def unchanged(text):
                return "\n".join(line for line in strip_injected_components(text).splitlines() if "allowBackup" not in line and "usesCleartextTraffic" not in line and "extractNativeLibs" not in line and "screenOrientation" not in line and application not in line)
            second_tree = tree(second)
            self.assertEqual(unchanged(tree(original)), unchanged(second_tree))
            self.assertIn(application, second_tree)
            self.assertIn("allowBackup", second_tree)
            self.assertIn("screenOrientation(0x0101001e)=0", second_tree)
            extracted = next(line for line in second_tree.splitlines() if "extractNativeLibs" in line)
            self.assertRegex(extracted, r"(?:true|0xffffffff)(?:\s|$)")
            cleartext = next(line for line in second_tree.splitlines() if "usesCleartextTraffic" in line)
            self.assertRegex(cleartext, r"(?:false|0x0)(?:\s|$)")
            self.assertEqual(len([line for line in second_tree.splitlines() if '"demo.Service"' in line]), 1)
            self.assertEqual(len([line for line in second_tree.splitlines() if '"com.superlooi.nsh.ScheduleKeepAliveService"' in line]), 1)
            self.assertEqual(len([line for line in second_tree.splitlines() if '"com.superlooi.nsh.ScheduleAlarmReceiver"' in line]), 1)
            svc_idx = next(i for i, line in enumerate(second_tree.splitlines()) if '"com.superlooi.nsh.ScheduleKeepAliveService"' in line)
            svc_block = "\n".join(second_tree.splitlines()[svc_idx:svc_idx + 3])
            self.assertRegex(svc_block, r"exported\(0x01010010\)=(?:false|0x0)")
            self.assertRegex(svc_block, r"foregroundServiceType\(0x01010599\)=0x0*1(?:\s|$)")
            rcv_idx = next(i for i, line in enumerate(second_tree.splitlines()) if '"com.superlooi.nsh.ScheduleAlarmReceiver"' in line)
            rcv_block = "\n".join(second_tree.splitlines()[rcv_idx:rcv_idx + 2])
            self.assertRegex(rcv_block, r"exported\(0x01010010\)=(?:false|0x0)")
            self.assertEqual(tree(first), second_tree)
            with zipfile.ZipFile(original) as src, zipfile.ZipFile(second) as result:
                self.assertEqual(len(result.namelist()), len(set(result.namelist())))
                for name in src.namelist():
                    if name != "AndroidManifest.xml":
                        self.assertEqual(src.read(name), result.read(name), name)
                self.assertEqual(result.read("classes3.dex"), dex.read_bytes())
                self.assertNotIn("classes4.dex", result.namelist())
                marker = json.loads(result.read("assets/super-looi-native-plugin.json"))
                self.assertEqual(len(marker["native_libs"]), 6)
                for library in ("libonnxruntime.so", "libsherpa-onnx-c-api.so"):
                    name = "lib/arm64-v8a/" + library
                    self.assertEqual(result.getinfo(name).compress_type, zipfile.ZIP_STORED)
                    self.assertEqual(result.read(name), (libraries / library).read_bytes())
                self.assertEqual(result.read("assets/alpine-minirootfs.tar.gz"), b"linux rootfs")
                for library in ("libproot.so", "libproot-loader.so", "liblooi-codex.so", "liblooi-codex-code-mode-host.so"):
                    name = "lib/arm64-v8a/" + library
                    self.assertEqual(result.read(name), (linux_libraries / library).read_bytes())
            # Add a missing permission without dropping an unrelated permission,
            # then reapply to prove no duplicate RECORD_AUDIO node appears.
            manifest.write_text(manifest.read_text().replace("android.permission.RECORD_AUDIO", "android.permission.INTERNET"))
            no_mic = root / "no-mic.apk"
            subprocess.run([str(tools / "aapt2"), "link", "-o", str(no_mic), "-I", str(jar), "--manifest", str(manifest), str(compiled)], check=True, capture_output=True)
            added, repeated = root / "added.apk", root / "repeated.apk"
            permissions = json.loads((Path(__file__).parents[1] / "plugins.json").read_text())["android"]["permissions"]
            merge(no_mic, dex, added, application, False, "landscape", permissions)
            merge(added, dex, repeated, application, False, "landscape", permissions)
            permission_tree = tree(repeated)
            self.assertIn("android.permission.INTERNET", permission_tree)
            for required in (
                "android.permission.POST_NOTIFICATIONS",
                "android.permission.FOREGROUND_SERVICE",
                "android.permission.FOREGROUND_SERVICE_DATA_SYNC",
                "android.permission.WAKE_LOCK",
                "android.permission.SCHEDULE_EXACT_ALARM",
            ):
                self.assertIn(required, permissions)
            for permission in permissions:
                self.assertEqual(len([line for line in permission_tree.splitlines() if f'"{permission}"' in line]), 1, permission)
            self.assertEqual(len([line for line in permission_tree.splitlines() if '"com.superlooi.nsh.ScheduleKeepAliveService"' in line]), 1)
            self.assertEqual(len([line for line in permission_tree.splitlines() if '"com.superlooi.nsh.ScheduleAlarmReceiver"' in line]), 1)
            self.assertEqual(tree(added), permission_tree)

    def test_patches_manifest_without_prior_exported_and_updates_stale_service(self):
        sdk = Path(os.environ.get("NSH_REAL_ANDROID_SDK", Path.home() / "Library/Android/sdk"))
        tools = sdk / "build-tools/36.0.0"
        jar = sdk / "platforms/android-35/android.jar"
        with tempfile.TemporaryDirectory(prefix="looi-plugin-edge-") as directory:
            root = Path(directory)
            (root / "res/values").mkdir(parents=True)
            (root / "res/values/strings.xml").write_text('<resources><string name="label">Edge</string></resources>')
            manifest = root / "AndroidManifest.xml"
            manifest.write_text('''<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.superlooi.app">
              <application android:label="@string/label">
                <activity android:name="demo.Main"><intent-filter><action android:name="android.intent.action.MAIN"/><category android:name="android.intent.category.LAUNCHER"/></intent-filter></activity>
                <service android:name="com.superlooi.nsh.ScheduleKeepAliveService" android:exported="true"/>
              </application></manifest>''')
            compiled = root / "resources.zip"
            subprocess.run([str(tools / "aapt2"), "compile", "--dir", str(root / "res"), "-o", str(compiled)], check=True, capture_output=True)
            original = root / "original.apk"
            subprocess.run([str(tools / "aapt2"), "link", "-o", str(original), "-I", str(jar), "--manifest", str(manifest), str(compiled)], check=True, capture_output=True)
            dex = root / "plugin.dex"
            dex.write_bytes(b"owned plugin edge dex")
            first, second = root / "first.apk", root / "second.apk"
            application = "com.superlooi.nsh.SuperLooiApplication"
            permissions = json.loads((Path(__file__).parents[1] / "plugins.json").read_text())["android"]["permissions"]
            merge(original, dex, first, application, False, "landscape", permissions)
            merge(first, dex, second, application, False, "landscape", permissions)
            out_tree = subprocess.check_output([str(tools / "aapt2"), "dump", "xmltree", "--file", "AndroidManifest.xml", str(second)], text=True)
            first_tree = subprocess.check_output([str(tools / "aapt2"), "dump", "xmltree", "--file", "AndroidManifest.xml", str(first)], text=True)
            self.assertEqual(first_tree, out_tree)
            svc_idx = next(i for i, line in enumerate(out_tree.splitlines()) if '"com.superlooi.nsh.ScheduleKeepAliveService"' in line)
            svc_block = "\n".join(out_tree.splitlines()[svc_idx:svc_idx + 3])
            self.assertRegex(svc_block, r"exported\(0x01010010\)=(?:false|0x0)")
            self.assertRegex(svc_block, r"foregroundServiceType\(0x01010599\)=0x0*1(?:\s|$)")
            self.assertEqual(len([line for line in out_tree.splitlines() if '"com.superlooi.nsh.ScheduleAlarmReceiver"' in line]), 1)



if __name__ == "__main__":
    unittest.main()
