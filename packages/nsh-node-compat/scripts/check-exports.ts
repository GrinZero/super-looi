import { access } from "node:fs/promises";
import { installNodeCompatGlobals } from "@super-looi/nsh-node-compat";
import {
  getNshNodeCompatAliases,
  nshNodeCompatPlugin,
} from "@super-looi/nsh-node-compat/bundler";
import { nshPiCodingToolsPlugin } from "@super-looi/nsh-node-compat/pi-coding-bundler";
import { NshExecutionEnv } from "@super-looi/nsh-node-compat/adapters/pi-durable-env";
import { NshSqliteDatabase } from "@super-looi/nsh-node-compat/adapters/chord-sqlite";
import { nshPiSdkPlugin } from "@super-looi/nsh-node-compat/pi-sdk-bundler";
import { nshCodemodePlugin } from "@super-looi/nsh-node-compat/codemode-bundler";
import { build } from "esbuild";
for (const value of [
  installNodeCompatGlobals,
  nshNodeCompatPlugin,
  nshPiCodingToolsPlugin,
  NshExecutionEnv,
  NshSqliteDatabase,
  nshPiSdkPlugin,
  nshCodemodePlugin,
])
  if (typeof value !== "function") throw new Error("Missing public export");
await Promise.all(
  Object.values(getNshNodeCompatAliases()).map((path) => access(path)),
);
await build({
  stdin: {
    contents:
      'import {createNshCodemodeSandbox} from "@super-looi/nsh-node-compat/adapters/codemode";globalThis.__sandbox=createNshCodemodeSandbox;',
    resolveDir: import.meta.dirname,
  },
  bundle: true,
  tsconfig: new URL("../tsconfig.json", import.meta.url).pathname,
  platform: "browser",
  format: "esm",
  write: false,
  plugins: [nshCodemodePlugin(), nshNodeCompatPlugin()],
});
console.log(
  "PASS built package exports and alias files (Node package-consumption check only)",
);
