import { createRequire } from "node:module";
import { copyFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { nshNodeCompatPlugin } from "../../../packages/nsh-node-compat/src/bundler.ts";
// Run from the repository with tsx; SDK dependencies live only in the supplied
// temporary directory. Selecting react-native uses the SDK's portable emitter.
const root = fileURLToPath(new URL("../../..", import.meta.url));
const directory = resolve(process.argv[2]);
const condition = process.argv[3] ?? "react-native";
const requireFromApp = createRequire(resolve(root, "apps/nsh/package.json"));
const { build } = requireFromApp("esbuild");
await copyFile(new URL("./probe.ts", import.meta.url), resolve(directory, "probe.ts"));
const result = await build({
    stdin: {
        contents: `import { installNodeCompatGlobals } from ${JSON.stringify(resolve(root, "packages/nsh-node-compat/src/polyfills.ts"))}; installNodeCompatGlobals(); await import('./probe.ts');`,
        resolveDir: directory,
    },
    bundle: true,
    platform: "browser",
    conditions: [condition, "import"],
    format: "esm",
    target: "es2022",
    minify: true,
    keepNames: true,
    define: { "import.meta.url": JSON.stringify("file:///app/agents-research.mjs") },
    plugins: [nshNodeCompatPlugin()],
    write: false,
    metafile: true,
});
await writeFile(resolve(directory, `probe-${condition}.mjs`), result.outputFiles[0].contents);
await writeFile(resolve(directory, `metafile-${condition}.json`), JSON.stringify(result.metafile, null, 2));
console.log(JSON.stringify({
    conditions: [condition, "import"],
    bytes: result.outputFiles[0].contents.length,
    inputs: Object.keys(result.metafile.inputs).length,
}));
