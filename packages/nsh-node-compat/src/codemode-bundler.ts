import type { Plugin } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
export function nshCodemodePlugin(): Plugin {
  const entry = fileURLToPath(
    import.meta.resolve("@earendil-works/pi-codemode/portable"),
  );
  return {
    name: "nsh-codemode-native-1.5.0",
    setup(build) {
      build.onResolve({ filter: /^pi-codemode-native\/prelude$/ }, () => ({
        path: join(dirname(entry), "runtime/prelude-source.js"),
      }));
    },
  };
}
