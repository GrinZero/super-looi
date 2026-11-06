import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { nshNodeCompatPlugin } from "../../../packages/nsh-node-compat/src/bundler.js";
import { nshCodemodePlugin } from "../../../packages/nsh-node-compat/src/codemode-bundler.js";
import { nshPiCodingToolsPlugin } from "../../../packages/nsh-node-compat/src/pi-coding-bundler.js";
import { nshPiSdkPlugin } from "../../../packages/nsh-node-compat/src/pi-sdk-bundler.js";
import { buildRuntime } from "./build-runtime.js";

const root = resolve(import.meta.dirname, "..");
await buildRuntime();
await mkdir(resolve(root, "generated"), { recursive: true });
await build({
  stdin: {
    resolveDir: root,
    contents: `
    export {installNshNativeCompat} from "../../packages/nsh-node-compat/src/native-host.ts";
    export async function verifyNativePackage() {
      await import("../../packages/nsh-node-compat/test/verify-node-shims.ts");
      await import("../../packages/nsh-node-compat/test/verify-budgets.ts");
      await import("../../packages/nsh-node-compat/test/verify-pi-agent-core.ts");
      await import("../../packages/nsh-node-compat/test/verify-pi-ai.ts");
      await import("../../packages/nsh-node-compat/test/verify-pi-durable.ts");
      await import("../../packages/nsh-node-compat/test/verify-codemode.ts");
      await import("../../packages/nsh-node-compat/test/verify-pi-coding-agent.ts");
      await import("../../packages/nsh-node-compat/test/verify-pi-sdk.ts");
      await import("../../packages/nsh-node-compat/test/verify-looi-runtime.ts");
      await import("../../packages/nsh-node-compat/test/verify-mobile-runtime.ts");
    }
  `,
  },
  tsconfig: resolve(root, "../../packages/nsh-node-compat/tsconfig.json"),
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2022",
  minify: true,
  keepNames: true,
  define: { "import.meta.url": JSON.stringify("file:///app/pi-runtime.mjs") },
  plugins: [
    nshPiSdkPlugin(),
    nshCodemodePlugin(),
    nshPiCodingToolsPlugin(),
    nshNodeCompatPlugin(),
  ],
  outfile: resolve(root, "generated/compat-probe.js"),
});
await writeFile(
  resolve(root, "generated/compat-probe.d.ts"),
  `
export function installNshNativeCompat(host: {request(request:string):string; begin(kind:string,request:string):string; wait(ticket:string):Promise<string>; close():void}): () => void;
export function verifyNativePackage(): Promise<void>;
`,
);
