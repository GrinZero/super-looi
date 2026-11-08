import { nshPiSdkPlugin } from "../src/pi-sdk-bundler.js";
import { nshCodemodePlugin } from "../src/codemode-bundler.js";
import { build } from "esbuild";
import { spawn, spawnSync } from "node:child_process";
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
        "codemode",
        "pi-coding-agent",
        "pi-sdk",
      ];
async function killAtCheckpoint(bundle: string, state: string) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      join(root, "rust/target/debug/qjs_runner"),
      [bundle, state, "30000"],
      { env: { PATH: process.env.PATH }, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "",
      checkpoint = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("No durable checkpoint before crash deadline"));
    }, 5000);
    child.stdout.on("data", (data) => {
      output += data.toString();
      if (!checkpoint && output.includes("CRASH_READY")) {
        checkpoint = true;
        child.kill("SIGKILL");
      }
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (_code, signal) => {
      clearTimeout(timer);
      if (checkpoint && signal === "SIGKILL") resolve();
      else reject(new Error("Host did not stop at durable checkpoint"));
    });
  });
}
let failures = 0;
for (const name of cases) {
  const temp = await mkdtemp(join(tmpdir(), "looi-quickjs-"));
  try {
    // Source plugin uses .ts paths before build; published plugin uses .js.
    const plugin = nshNodeCompatPlugin();
    const result = await build({
      stdin: {
        contents: `import { installNodeCompatGlobals } from './src/polyfills.ts'; installNodeCompatGlobals(); ${["pi-ai", "pi-ai-live", "pi-sdk", "pi-sdk-live"].includes(name) ? "const { installFixtureHttp } = await import('./test/http-fixture.ts'); installFixtureHttp();" : ""} await import('./test/verify-${name}.ts');`,
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
          ? [nshCodemodePlugin(), nshPiCodingToolsPlugin(), plugin]
          : name === "pi-sdk" || name === "pi-sdk-live"
            ? [
                nshPiSdkPlugin(),
                nshCodemodePlugin(),
                nshPiCodingToolsPlugin(),
                plugin,
              ]
            : [nshCodemodePlugin(), plugin],
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
  const temp = await mkdtemp(join(tmpdir(), "looi-durable-crash-"));
  try {
    for (const phase of [1, 2]) {
      const result = await build({
        stdin: {
          contents: `import {installNodeCompatGlobals} from './src/polyfills.ts'; installNodeCompatGlobals(); globalThis.__crash_phase = ${phase}; await import('./test/verify-durable-crash.ts');`,
          resolveDir: root,
        },
        tsconfig: join(root, "tsconfig.json"),
        bundle: true,
        format: "esm",
        platform: "browser",
        conditions: ["browser", "import"],
        target: "es2022",
        plugins: [nshNodeCompatPlugin()],
        write: false,
      });
      const bundle = join(temp, `phase-${phase}.mjs`);
      await writeFile(bundle, result.outputFiles[0].contents);
      if (phase === 1) await killAtCheckpoint(bundle, join(temp, "state"));
      else {
        const run = spawnSync(
          join(root, "rust/target/debug/qjs_runner"),
          [bundle, join(temp, "state"), "10000"],
          { encoding: "utf8", timeout: 15000, env: { PATH: process.env.PATH } },
        );
        if (run.stdout) process.stdout.write(run.stdout);
        if (run.status !== 0)
          throw new Error(`Durable recovery failed: ${run.stderr}`);
      }
    }
  } catch (error) {
    failures++;
    console.error(error);
  } finally {
    await rm(temp, { recursive: true, force: true });
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
