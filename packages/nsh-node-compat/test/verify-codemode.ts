import {
  InlineCodemodeSandbox,
  RemoteCodemodeSandbox,
} from "@earendil-works/pi-codemode/portable";
import { assert } from "./assert.js";
assert(
  InlineCodemodeSandbox && RemoteCodemodeSandbox,
  "portable entry should bundle",
);
if (typeof WebAssembly === "undefined")
  throw new Error(
    "MIGRATION_GATE: InlineCodemodeSandbox requires a supplied WebAssembly QuickJS module; NSH's native QuickJS has no WebAssembly. Implement a native/remote sandbox before enabling codemode.",
  );
throw new Error(
  "MIGRATION_GATE: supply and execute a real CodemodeWasmModule; symbol availability is insufficient",
);
