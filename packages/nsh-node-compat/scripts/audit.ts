import { nshPiSdkPlugin } from "../src/pi-sdk-bundler.js";
import { nshPiCodingToolsPlugin } from "../src/pi-coding-bundler.js";
import { nshCodemodePlugin } from "../src/codemode-bundler.js";
import { build } from "esbuild";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { nshNodeCompatPlugin } from "../src/bundler.js";
const root = resolve(import.meta.dirname, "..");
const repo = resolve(root, "../..");
const upstream = JSON.parse(
  await readFile(
    new URL(
      "../node_modules/@earendil-works/pi-coding-agent/package.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
if (upstream.version !== "1.5.0")
  throw new Error("Reaudit required for a different Pi version");
let errors: string[] = [];
const sdkProfile = process.argv.includes("--sdk");
try {
  await build({
    stdin: {
      contents:
        'import { createAgentSession } from "@earendil-works/pi-coding-agent"; globalThis.__sdk = createAgentSession;',
      resolveDir: root,
    },
    tsconfig: resolve(root, "tsconfig.json"),
    bundle: true,
    format: "esm",
    platform: "browser",
    conditions: ["browser", "import"],
    target: "es2022",
    write: false,
    logLevel: "silent",
    plugins: sdkProfile
      ? [
          nshPiSdkPlugin(),
          nshCodemodePlugin(),
          nshPiCodingToolsPlugin(),
          nshNodeCompatPlugin(),
        ]
      : [nshNodeCompatPlugin()],
  });
} catch (error) {
  errors = (error as { errors: Array<{ text: string }> }).errors.map((entry) =>
    entry.text.replaceAll(repo + "/", ""),
  );
}
const report = {
  nshVersion: "0.5.0",
  nshCommit: "f4d68f7f9f31eb7b3ecc8a4cbc31096d5c6238a1",
  quickjsVersion: "0.14.2",
  piVersion: "1.5.0",
  target: sdkProfile
    ? "pi-coding-agent actual programmatic SDK with explicit mobile platform adapters"
    : "pi-coding-agent createAgentSession root entry (transparent aliases only)",
  passed: errors.length === 0,
  errorCount: errors.length,
  errors: [...new Set(errors)].sort(),
  migrationAllowed: false,
  note: "This report records bundling only. The mobile SDK profile selects real upstream programmatic exports, native codemode, precompiled extensions and explicit unsupported image/TCP/desktop facilities. Runtime tests, mobile/media/UI migration and Hub responsibility replacement remain separate gates.",
};
if (process.argv.includes("--record")) {
  const folder = resolve(repo, "docs/artifacts/nsh-node-compat");
  await mkdir(folder, { recursive: true });
  await writeFile(
    resolve(
      folder,
      sdkProfile ? "mobile-sdk-audit.json" : "full-sdk-audit.json",
    ),
    JSON.stringify(report, null, 2) + "\n",
  );
}
if (process.argv.includes("--sdk"))
  console.log([...new Set(errors)].join("\n"));
console.log(
  `Full SDK bundle gate: ${report.passed ? "bundle passed (runtime still required)" : `FAILED (${report.errorCount} build errors)`}`,
);
if (!report.passed) process.exitCode = 1;
