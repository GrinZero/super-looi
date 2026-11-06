import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { nshPiCodingToolsPlugin } from "../src/pi-coding-bundler.js";
import { nshNodeCompatPlugin } from "../src/bundler.js";
const root = resolve(import.meta.dirname, "..");
const cargo = spawnSync(
  "cargo",
  [
    "build",
    "--locked",
    "--manifest-path",
    join(root, "rust/Cargo.toml"),
    "--bin",
    "qjs_runner",
  ],
  { stdio: "inherit" },
);
if (cargo.status !== 0) throw new Error("QuickJS host build failed");
const tests = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const cases = process.argv.includes("--live")
  ? ["pi-ai-live"]
  : tests.length
    ? tests
    : [
        "node-shims",
        "budgets",
        "pi-agent-core",
        "pi-ai",
        "pi-durable",
        "pi-coding-agent",
      ];
let failures = 0;
for (const name of cases) {
  const temp = await mkdtemp(join(tmpdir(), "looi-quickjs-"));
  try {
    // Source plugin uses .ts paths before build; published plugin uses .js.
    const plugin = nshNodeCompatPlugin();
    const result = await build({
      stdin: {
        contents: `import { installNodeCompatGlobals } from './src/polyfills.ts'; installNodeCompatGlobals(); ${name === "pi-ai" || name === "pi-ai-live" ? "const { installFixtureHttp } = await import('./test/http-fixture.ts'); installFixtureHttp();" : ""} await import('./test/verify-${name}.ts');`,
        resolveDir: root,
        sourcefile: "verify-entry.ts",
      },
      tsconfig: join(root, "tsconfig.json"),
      bundle: true,
      format: "esm",
      platform: "browser",
      conditions: ["browser", "import"],
      target: "es2022",
      define: { "import.meta.url": JSON.stringify("file:///app/main.mjs") },
      plugins:
        name === "pi-coding-agent"
          ? [nshPiCodingToolsPlugin(), plugin]
          : [plugin],
      write: false,
      metafile: true,
    });
    const bundle = join(temp, "verify.mjs");
    await writeFile(bundle, result.outputFiles[0].contents);
    const runnerEnv: Record<string, string | undefined> = {
      PATH: process.env.PATH,
    };
    if (name === "pi-ai-live") {
      const {
        LLM_BASE_URL: baseUrl,
        LLM_API_KEY: apiKey,
        LLM_MODEL: model,
      } = process.env;
      if (!baseUrl || !apiKey || !model)
        throw new Error(
          "LLM_BASE_URL / LLM_API_KEY / LLM_MODEL required in .env",
        );
      const configPath = join(temp, "gateway.json");
      await writeFile(configPath, JSON.stringify({ baseUrl, apiKey, model }), {
        mode: 0o600,
      });
      runnerEnv.NSH_COMPAT_LIVE_CONFIG = configPath;
    }
    const run = spawnSync(
      join(root, "rust/target/debug/qjs_runner"),
      [bundle, join(temp, "state"), "30000"],
      { encoding: "utf8", timeout: 40000, env: runnerEnv },
    );
    if (run.stdout) process.stdout.write(run.stdout);
    if (run.stderr) process.stderr.write(run.stderr);
    if (run.status !== 0)
      throw new Error(
        `${name}: QuickJS exited ${run.status} ${run.error ?? ""}`,
      );
  } catch (error) {
    failures++;
    console.error(error);
  } finally {
    await rm(temp, { force: true, recursive: true });
  }
}
if (!tests.length && !process.argv.includes("--live")) {
  const temp = await mkdtemp(join(tmpdir(), "looi-deadline-"));
  try {
    for (const source of ["await new Promise(() => {})", "while (true) {};"]) {
      const bundle = join(temp, "deadline.mjs");
      await writeFile(bundle, source);
      const result = spawnSync(
        join(root, "rust/target/debug/qjs_runner"),
        [bundle, join(temp, "state"), "50"],
        { timeout: 2000, encoding: "utf8", env: { PATH: process.env.PATH } },
      );
      if (result.status !== 1 || result.error || result.signal)
        throw new Error("QuickJS native/Promise deadline regression");
    }
    console.log(
      "PASS runner deadlines: pending Promise and infinite JS loop terminate without external kill",
    );
  } catch (error) {
    failures++;
    console.error(error);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
if (failures)
  throw new Error(`${failures}/${cases.length} QuickJS suites failed`);
