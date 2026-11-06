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
    plugins: [nshNodeCompatPlugin()],
  });
} catch (error) {
  errors = (error as { errors: Array<{ text: string }> }).errors.map((entry) =>
    entry.text.replaceAll(repo + "/", ""),
  );
}
const report = {
  nshVersion: "0.4.0",
  nshCommit: "e626a8dd8f8d8b277b9507cfd5ac74d0e67020f3",
  quickjsVersion: "0.14.1",
  piVersion: "1.5.0",
  target:
    "pi-coding-agent createAgentSession root entry (transparent aliases only)",
  passed: errors.length === 0,
  errorCount: errors.length,
  errors: [...new Set(errors)].sort(),
  migrationAllowed: false,
  note: "Headless session/tools verification does not satisfy this gate. Bundle success must additionally be followed by a real SDK run, codemode, native mobile/media/UI migration, and Hub responsibility replacement.",
};
if (process.argv.includes("--record")) {
  const folder = resolve(repo, "docs/artifacts/nsh-node-compat");
  await mkdir(folder, { recursive: true });
  await writeFile(
    resolve(folder, "full-sdk-audit.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
}
console.log(
  `Full SDK bundle gate: ${report.passed ? "bundle passed (runtime still required)" : `FAILED (${report.errorCount} build errors)`}`,
);
if (!report.passed) process.exitCode = 1;
