import { cleanup, effect, mount, platform, signal, Text, View } from "nsh";
import { CredentialVault, NodeCompat, VoiceAudio } from "super-looi/native";
import {
  installNshNativeCompat,
  verifyNativePackage,
} from "./generated/compat-probe.js";

function CompatProbe() {
  const status = signal("Testing native compatibility");
  const native = new NodeCompat();
  const close = installNshNativeCompat(native);
  cleanup(close);
  effect(() => {
    void verifyNativePackage()
      .then(() => {
        if (platform.os !== "ios" && platform.os !== "android") return;
        const vault = new CredentialVault();
        if (vault.backend() === "desktop") return;
        const audio = new VoiceAudio();
        try {
          if (audio.status().state !== "idle")
            throw new Error("Audio unexpectedly active at creation");
          const permission = audio.status().permission;
          if (permission !== "granted") {
            let denied = false;
            try { audio.start(true); } catch { denied = true; }
            if (!denied || audio.status().permission !== permission)
              throw new Error("Native capture bypassed the explicit permission boundary");
            audio.stop();
            console.log("PASS native microphone permission gate: ungranted capture rejected without prompt");
          }
          audio.start(false);
          audio.enqueue(new Uint8Array(960), 24000);
          if (audio.status().state !== "running")
            throw new Error("Native output failed to start");
          audio.clearPlayback();
          audio.stop();
          if (audio.status().state !== "idle")
            throw new Error("Native output failed to stop");
          console.log(
            "PASS native PCM output: silent enqueue, clear, stop; no microphone capture",
          );
        } finally {
          audio.stop();
        }
        try {
          vault.set("probe", "non-secret native vault 你好");
          if (
            new CredentialVault().get("probe") !==
            "non-secret native vault 你好"
          )
            throw new Error("Vault reopen mismatch");
          vault.set("probe", "updated test entry");
          if (vault.get("probe") !== "updated test entry")
            throw new Error("Vault update mismatch");
          vault.remove("probe");
          if (vault.get("probe") !== "")
            throw new Error("Vault delete mismatch");
          console.log(
            "PASS secure credentials: native OS store write/reopen/update/delete (test slot only)",
          );
        } finally {
          try {
            vault.remove("probe");
          } catch {}
        }
      })
      .then(
        () => status.set("Native bridge verified"),
        (error) => status.set(`Native bridge failed: ${String(error)}`),
      );
  });
  return (
    <View class="flex-1">
      <Text>{status()}</Text>
    </View>
  );
}
mount(CompatProbe);
