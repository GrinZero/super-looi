import { spawn, spawnSync } from "node:child_process";
import { readFile, writeFile, rm, readdir, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { buildRuntime } from "./build-runtime.js";
import { build } from "esbuild";
import { nshNodeCompatPlugin } from "../../../packages/nsh-node-compat/src/bundler.js";
import { nshPiSdkPlugin } from "../../../packages/nsh-node-compat/src/pi-sdk-bundler.js";
import { nshCodemodePlugin } from "../../../packages/nsh-node-compat/src/codemode-bundler.js";
import { nshPiCodingToolsPlugin } from "../../../packages/nsh-node-compat/src/pi-coding-bundler.js";

// Test-only entry: never reachable from App.tsx or the shipping runtime.
const root = resolve(import.meta.dirname, "..");
const target = process.argv[2];
const sdk = process.argv.includes("--sdk");
const voice = process.argv.includes("--voice");
const pipeline = process.argv.includes("--voice-pipeline");
if (target !== "ios" && target !== "android")
  throw new Error("Expected ios or android");
const env = parseEnv(await readFile(resolve(root, "../../.env"), "utf8"));
const config = voice
  ? {
      apiKey: env.DOUBAO_API_KEY,
      baseUrl: "voice-native-probe",
      model: "1.2.6.1",
    }
  : {
      baseUrl: env.LLM_BASE_URL,
      apiKey: env.LLM_API_KEY,
      model: env.LLM_MODEL,
    };
if (!config.baseUrl || !config.apiKey || !config.model)
  throw new Error("Missing LLM configuration");
await buildRuntime();
if (sdk)
  await build({
    stdin: {
      resolveDir: root,
      contents: `import {installNshNativeCompat} from "../../packages/nsh-node-compat/src/native-host.ts";
  export async function verifySdk(host,config){const release=installNshNativeCompat(host);try{const {verifySdkLive}=await import("../../packages/nsh-node-compat/test/native-sdk-live.ts");await verifySdkLive(config);}finally{release();}}`,
    },
    tsconfig: resolve(root, "../../packages/nsh-node-compat/tsconfig.json"),
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    minify: true,
    define: {
      "import.meta.url": JSON.stringify("file:///app/native-sdk-live.mjs"),
    },
    plugins: [
      nshPiSdkPlugin(),
      nshCodemodePlugin(),
      nshPiCodingToolsPlugin(),
      nshNodeCompatPlugin(),
    ],
    outfile: resolve(root, "generated/sdk-live.js"),
  });
if (pipeline)
  await build({
    tsconfig: resolve(root, "tsconfig.runtime.json"),
    entryPoints: [resolve(root, "tests/native-voice-pipeline.ts")],
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    minify: true,
    plugins: [nshNodeCompatPlugin()],
    outfile: resolve(root, "generated/voice-live.js"),
  });
const pipelinePcm = pipeline
  ? (
      await readFile(resolve(root, "tests/fixtures/voice-recall-16k.pcm"))
    ).toString("base64")
  : "";
const entry = resolve(root, "LiveProbe.tsx");
// No model credential is written to the production vault. Test host data is ephemeral.
const source = pipeline
  ? `import {mount,signal,Text,View} from "nsh";
import {NodeCompat,VoiceAudio} from "super-looi/native";
import {connect} from "websocket";
import {Buffer} from "buffer";
import {openRuntime} from "./generated/looi-runtime.js";
import {verifyVoicePipeline} from "./generated/voice-live.js";
function Probe(){const status=signal("Testing synthetic voice pipeline");void(async()=>{let runtime;const config=${JSON.stringify(config)};try{
 runtime=await openRuntime(new NodeCompat(),{get:key=>key==="model"?JSON.stringify(config):"",set:()=>{},remove:()=>{}});
 const result=await verifyVoicePipeline({runtime,audio:new VoiceAudio(),connect,pcm:Buffer.from(${JSON.stringify(pipelinePcm)},"base64"),voiceKey:${JSON.stringify(env.DOUBAO_API_KEY)}});
 console.log("VOICE_PIPELINE "+JSON.stringify(result));status.set("Native live verified");
}catch(error){console.log("Native pipeline failure: "+String(error).split(config.apiKey).join("[redacted]"));status.set("Native live failed");}finally{await runtime?.close();}})();return <View><Text>{status()}</Text></View>;}mount(Probe);`
  : voice
    ? `import {mount,signal,Text,View} from "nsh";
import {VoiceAudio} from "super-looi/native";
import {connect} from "websocket";
import {Buffer} from "buffer";
function Probe(){const status=signal("Testing native voice");
void(async()=>{let socket,timer;const audio=new VoiceAudio();const key=${JSON.stringify(config.apiKey)};
let bytes=0,cancelled=false,ack=false;const types=[];
try{
 socket=await connect("wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue",{headers:{"X-Api-Key":key}});
 timer=setTimeout(()=>{void socket.close().catch(()=>{});},45000);
 await socket.write(JSON.stringify({type:"session.create",session:{model:"1.2.6.1",instructions:"你是软件验收语音助手。",tools:[],audio:{input:{format:{type:"pcm",rate:16000}},output:{format:{type:"pcm_s16le",rate:24000},voice:"zh_female_vv_jupiter_bigtts"}}}}));
 for(;;){const raw=await socket.read();if(raw===null)break;if(typeof raw!=="string")continue;const event=JSON.parse(raw);const type=String(event.type);if(!types.includes(type)&&types.length<30)types.push(type);
 if(type==="session.created"){audio.start(false);await socket.write(JSON.stringify({type:"speech_text_buffer.commit",text:"这是本机语音软件验收。正在验证原生网络、音频播放和语音打断。整个测试只使用合成语音，不采集麦克风。"}));}
 else if(type==="response.output_audio.delta") {const pcm=Buffer.from(String(event.delta),"base64");bytes+=pcm.length;if(!cancelled){audio.enqueue(pcm,24000);audio.clearPlayback();await socket.write(JSON.stringify({type:"response.cancel"}));cancelled=true;clearTimeout(timer);timer=setTimeout(()=>{void socket.close().catch(()=>{});},5000);}}
 else if(type==="response.canceled" || type==="response.cancelled" || (type==="response.done" && event.response?.status==="cancelled")){ack=true;break;}
 else if(type==="error" || type==="session.error"){if(!bytes)throw new Error("provider refused voice probe");break;}
 }
 if(!bytes)throw new Error("No voice PCM received");
 console.log("VOICE_PROBE "+JSON.stringify({bytes,cancelAck:ack,eventTypes:types}));status.set("Native live verified");
}catch(error){console.log("Native voice probe failed (details omitted)");status.set("Native live failed");}finally{if(timer)clearTimeout(timer);audio.stop();await socket?.close().catch(()=>{});}})();
return <View><Text>{status()}</Text></View>;}mount(Probe);`
    : `import {mount,signal,Text,View} from "nsh";
import {NodeCompat} from "super-looi/native";
import {openRuntime} from "./generated/looi-runtime.js";
${sdk ? 'import {verifySdk} from "./generated/sdk-live.js";' : ""}
function Probe(){const status=signal("Testing native model");
void(async()=>{let runtime;const config=${JSON.stringify(config)};try{
runtime=await openRuntime(new NodeCompat(),{get:(key)=>key==="model"?JSON.stringify(config):"",set:()=>{},remove:()=>{}});
const now=Date.now();
const result=await runtime.run("Reply with exactly OK. Do not call any tools.",{event_id:"native-live",ui_session_id:runtime.uiSessionId,kind:"tap",captured_at:new Date(now).toISOString(),expires_at:new Date(now+10000).toISOString()},()=>{});
if(!result.runtimeExited || !result.taskId || !result.answer.trim())throw new Error("Incomplete native result");
await runtime.close();runtime=undefined;
${sdk ? "await verifySdk(new NodeCompat(),config);" : ""}
status.set("Native live verified");
}catch(error){let detail=String(error);for(const value of Object.values(config))detail=detail.split(value).join("[redacted]");console.log("Native live failure: "+detail);status.set("Native live failed");}finally{await runtime?.close();}})();
return <View><Text>{status()}</Text></View>;}mount(Probe);`;
let result;
let interrupted = false;
try {
  await writeFile(entry, source, { mode: 0o600 });
  await mkdir(resolve(root, ".nsh"), { recursive: true });
  await writeFile(
    resolve(root, ".nsh/LiveProbe.test.tsx"),
    'import {open,test} from "nsh/test";test("native live model and SDK",async()=>{const app=await open("../LiveProbe.tsx",{network:"live"});await app.waitFor("Native live verified",{timeout:150000});},180000);',
  );
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
        for (const value of [
          ...Object.values(config),
          env.DOUBAO_API_KEY,
        ].filter(Boolean))
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
  if ((voice || pipeline) && result.status === 0) {
    const report = result.diagnostics
      .split("\n")
      .find((line) =>
        line.startsWith(pipeline ? "VOICE_PIPELINE " : "VOICE_PROBE "),
      );
    if (report) console.log(report);
  }
  if (result.status === 0)
    await rm(resolve(root, ".nsh/live-failure.log"), { force: true });
  // Never expose raw test diagnostics: upstream errors can contain request data.
  console.log(
    result.status === 0
      ? pipeline
        ? `PASS ${target}: synthetic speech → shared local task → native voice reply`
        : voice
          ? `PASS ${target}: native voice WebSocket, synthetic PCM and interruption probe`
          : `PASS ${target}: MobileRuntime native fetch/model/task completion${sdk ? " + actual coding SDK native tools/session" : ""}`
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
  await rm(resolve(root, ".nsh/LiveProbe.test.tsx"), { force: true });
  await rm(resolve(root, "generated/sdk-live.js"), { force: true });
  await rm(resolve(root, "generated/voice-live.js"), { force: true });
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
