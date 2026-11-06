import { cleanup, effect, mount, signal, Text, View } from "nsh";
import { NodeCompat } from "super-looi/native";
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
    void verifyNativePackage().then(
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
