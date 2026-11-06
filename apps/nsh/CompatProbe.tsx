import { cleanup, effect, mount, platform, signal, Text, View } from "nsh";
import { CredentialVault, NodeCompat } from "super-looi/native";
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
