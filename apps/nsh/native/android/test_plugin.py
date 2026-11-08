import os
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
            dex = root / "plugin.dex"
            dex.write_bytes(b"owned plugin test dex")
            first, second = root / "first.apk", root / "second.apk"
            application = "com.superlooi.nsh.SuperLooiApplication"
            merge(original, dex, first, application, False)
            merge(first, dex, second, application, False)
            def tree(path):
                return subprocess.check_output([str(tools / "aapt2"), "dump", "xmltree", "--file", "AndroidManifest.xml", str(path)], text=True)
            def unchanged(text):
                return "\n".join(line for line in text.splitlines() if "allowBackup" not in line and "usesCleartextTraffic" not in line and application not in line)
            self.assertEqual(unchanged(tree(original)), unchanged(tree(second)))
            self.assertIn(application, tree(second))
            self.assertIn("allowBackup", tree(second))
            cleartext = next(line for line in tree(second).splitlines() if "usesCleartextTraffic" in line)
            self.assertRegex(cleartext, r"(?:false|0x0)(?:\s|$)")
            self.assertEqual(tree(first), tree(second))
            with zipfile.ZipFile(original) as src, zipfile.ZipFile(second) as result:
                self.assertEqual(len(result.namelist()), len(set(result.namelist())))
                for name in src.namelist():
                    if name != "AndroidManifest.xml":
                        self.assertEqual(src.read(name), result.read(name), name)
                self.assertEqual(result.read("classes3.dex"), dex.read_bytes())
                self.assertNotIn("classes4.dex", result.namelist())
            # Add a missing permission without dropping an unrelated permission,
            # then reapply to prove no duplicate RECORD_AUDIO node appears.
            manifest.write_text(manifest.read_text().replace("android.permission.RECORD_AUDIO", "android.permission.INTERNET"))
            no_mic = root / "no-mic.apk"
            subprocess.run([str(tools / "aapt2"), "link", "-o", str(no_mic), "-I", str(jar), "--manifest", str(manifest), str(compiled)], check=True, capture_output=True)
            added, repeated = root / "added.apk", root / "repeated.apk"
            merge(no_mic, dex, added, application, False, ("android.permission.RECORD_AUDIO", "android.permission.MODIFY_AUDIO_SETTINGS"))
            merge(added, dex, repeated, application, False, ("android.permission.RECORD_AUDIO", "android.permission.MODIFY_AUDIO_SETTINGS"))
            permission_tree = tree(repeated)
            self.assertIn("android.permission.INTERNET", permission_tree)
            self.assertEqual(len([line for line in permission_tree.splitlines() if "android.permission.RECORD_AUDIO" in line]), 1)
            self.assertEqual(len([line for line in permission_tree.splitlines() if "android.permission.MODIFY_AUDIO_SETTINGS" in line]), 1)
            self.assertEqual(tree(added), permission_tree)



if __name__ == "__main__":
    unittest.main()
