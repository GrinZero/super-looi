import { spawn, spawnSync } from "node:child_process";
import { readFile, writeFile, rm, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { buildRuntime } from "./build-runtime.js";

// Test-only entry: never reachable from App.tsx or the shipping runtime.
const root = resolve(import.meta.dirname, "..");
const target = process.argv[2];
if (target !== "ios" && target !== "android")
  throw new Error("Expected ios or android");
const env = parseEnv(await readFile(resolve(root, "../../.env"), "utf8"));
const config = {
  baseUrl: env.LLM_BASE_URL,
  apiKey: env.LLM_API_KEY,
  model: env.LLM_MODEL,
};
if (!config.baseUrl || !config.apiKey || !config.model)
  throw new Error("Missing LLM configuration");
await buildRuntime();
const entry = resolve(root, "LiveProbe.tsx");
// No model credential is written to the production vault. Test host data is ephemeral.
const source = `import {mount,signal,Text,View} from "nsh";
import {NodeCompat} from "super-looi/native";
import {openRuntime} from "./generated/looi-runtime.js";
function Probe(){const status=signal("Testing native model");
void(async()=>{let runtime;const config=${JSON.stringify(config)};try{
runtime=await openRuntime(new NodeCompat(),{get:()=>JSON.stringify(config),set:()=>{},remove:()=>{}});
const now=Date.now();
const result=await runtime.run("Reply with exactly OK. Do not call any tools.",{event_id:"native-live",ui_session_id:runtime.uiSessionId,kind:"tap",captured_at:new Date(now).toISOString(),expires_at:new Date(now+10000).toISOString()},()=>{});
if(!result.runtimeExited || !result.taskId || !result.answer.trim())throw new Error("Incomplete native result");
await runtime.close();runtime=undefined;status.set("Native live verified");
}catch(error){let detail=String(error);for(const value of Object.values(config))detail=detail.split(value).join("[redacted]");console.log("Native live failure: "+detail);status.set("Native live failed");}finally{await runtime?.close();}})();
return <View><Text>{status()}</Text></View>;}mount(Probe);`;
let result;
let interrupted = false;
try {
  await writeFile(entry, source, { mode: 0o600 });
  result = await new Promise<{ status: number | null; diagnostics: string }>(
    (done) => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "scripts/nsh.ts", `live-${target}`],
        {
          cwd: root,
          detached: true,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      let diagnostics = "";
      const capture = (chunk: Buffer) => {
        diagnostics = (diagnostics + chunk.toString()).slice(-1024 * 1024);
      };
      child.stdout.on("data", capture);
      child.stderr.on("data", capture);
      const kill = () => {
        interrupted = true;
        if (child.pid) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {}
        }
      };
      const timer = setTimeout(kill, 240_000);
      process.once("SIGINT", kill);
      process.once("SIGTERM", kill);
      child.on("error", () => {
        diagnostics += "\nFailed to start native test";
      });
      child.on("close", (status) => {
        clearTimeout(timer);
        process.removeListener("SIGINT", kill);
        process.removeListener("SIGTERM", kill);
        for (const value of Object.values(config))
          diagnostics = diagnostics.replaceAll(value, "[redacted]");
        done({ status, diagnostics });
      });
      child.stdin.end();
    },
  );
  if (result.status !== 0)
    await writeFile(
      resolve(root, ".nsh/live-failure.log"),
      result.diagnostics,
      { mode: 0o600 },
    );
  // Never expose raw test diagnostics: upstream errors can contain request data.
  console.log(
    result.status === 0
      ? `PASS ${target}: MobileRuntime native fetch/model/task completion`
      : `FAIL ${target}: native live probe (exit ${result.status ?? "timeout"})`,
  );
} finally {
  if (interrupted) {
    if (target === "ios")
      spawnSync(
        "xcrun",
        ["simctl", "terminate", "booted", "com.longbridge.nsh.host"],
        { stdio: "ignore", timeout: 10000 },
      );
    else
      spawnSync(
        resolve(
          env.ANDROID_HOME ||
            env.ANDROID_SDK_ROOT ||
            resolve(process.env.HOME!, "Library/Android/sdk"),
          "platform-tools/adb",
        ),
        ["shell", "am", "force-stop", "com.longbridge.nsh.host"],
        { stdio: "ignore", timeout: 10000 },
      );
  }
  await rm(entry, { force: true });
  await rm(resolve(root, "generated/.nsh"), { recursive: true, force: true });
  // Only the test compiler cache contains JS source/bytecode; native APKs never do.
  await rm(resolve(root, ".nsh/test/build"), { recursive: true, force: true });
  for (const name of await readdir(resolve(root, ".nsh/test")).catch(
    () => [],
  )) {
    if (name.includes("LiveProbe"))
      await rm(resolve(root, ".nsh/test", name), { force: true });
  }
}
process.exitCode = result?.status === 0 ? 0 : 1;
