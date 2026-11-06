import { access } from "node:fs/promises";
import { installNodeCompatGlobals } from "@super-looi/nsh-node-compat";
import {
  getNshNodeCompatAliases,
  nshNodeCompatPlugin,
} from "@super-looi/nsh-node-compat/bundler";
import { nshPiCodingToolsPlugin } from "@super-looi/nsh-node-compat/pi-coding-bundler";
import { NshExecutionEnv } from "@super-looi/nsh-node-compat/adapters/pi-durable-env";
import { NshSqliteDatabase } from "@super-looi/nsh-node-compat/adapters/chord-sqlite";
for (const value of [
  installNodeCompatGlobals,
  nshNodeCompatPlugin,
  nshPiCodingToolsPlugin,
  NshExecutionEnv,
  NshSqliteDatabase,
])
  if (typeof value !== "function") throw new Error("Missing public export");
await Promise.all(
  Object.values(getNshNodeCompatAliases()).map((path) => access(path)),
);
console.log(
  "PASS built package exports and alias files (Node package-consumption check only)",
);
