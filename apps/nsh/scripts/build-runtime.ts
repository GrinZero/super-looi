import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { nshNodeCompatPlugin } from "../../../packages/nsh-node-compat/src/bundler.js";
import { nshCodemodePlugin } from "../../../packages/nsh-node-compat/src/codemode-bundler.js";
import { nshPiSdkPlugin } from "../../../packages/nsh-node-compat/src/pi-sdk-bundler.js";
import { loadRuntimeVariables } from "./build-env.mjs";

/** Separate from the test probe: no faux provider or acceptance fixtures ship. */
export async function buildRuntime(options: { release?: boolean; debugTelemetry?: boolean } = {}) {
  const root = resolve(import.meta.dirname, "..");
  const variables = loadRuntimeVariables(options);
  await mkdir(resolve(root, "generated"), { recursive: true });
  await build({
    stdin: {
      resolveDir: root,
      contents: `
    import {installNshNativeCompat} from "../../packages/nsh-node-compat/src/native-host.ts";
    export {VoiceRuntime} from "./runtime/voice.ts";
    export {MiotLoginFlow} from "./runtime/miot-login.ts";
    export {RobotFaceController} from "../../packages/looi-runtime/src/ui/robot-face-controller.ts";
    export async function openRuntime(host,vault) {
      const release=installNshNativeCompat(host);
      try {const {MobileRuntime}=await import("./runtime/application.ts");return new MobileRuntime(vault,release);}
      catch(error){release();throw error;}
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
    define: {
      "import.meta.url": JSON.stringify("file:///app/looi-runtime.mjs"),
      ...Object.fromEntries(Object.entries(variables).map(([key, value]) => [`process.env.${key}`, JSON.stringify(value)])),
    },
    plugins: [
      {
        name: "looi-portable-source",
        setup(builder) {
          builder.onResolve({ filter: /^@super-looi\/runtime\// }, (args) => ({
            path: resolve(
              root,
              "../../packages/looi-runtime/src",
              args.path.slice("@super-looi/runtime/".length) + ".ts",
            ),
          }));
        },
      },
      nshPiSdkPlugin(),
      nshCodemodePlugin(),
      nshNodeCompatPlugin(),
    ],
    outfile: resolve(root, "generated/looi-runtime.js"),
  });
  await writeFile(
    resolve(root, "generated/looi-runtime.d.ts"),
    `
export interface VoiceState {phase:"idle"|"standby"|"permission"|"connecting"|"listening"|"speaking"|"error";muted:boolean;wakeEnabled:boolean;transcript:string;error:string}
export class VoiceRuntime {
 constructor(options:{vault:{get(key:string):string;set(key:string,value:string):void;remove(key:string):void};audio:{requestPermission():string;start(capture:boolean):void;stop():void;setCaptureMode(mode:string):void;playReadyCue():void;enqueue(pcm:Uint8Array,rate:number):void;clearPlayback():void;setMuted(muted:boolean):void;drainCapture():Array<{pcm:Uint8Array;timestampMs:number;sampleRate:number}>;status():{state:string;permission:string;error:string;queuedPlaybackMs:number;captureMode:string;wakeWord:string;kwsReady:boolean}};connect:(url:string,options:{headers:Record<string,string>})=>Promise<{read():Promise<string|Uint8Array|null>;write(value:string):Promise<void>;close():Promise<void>}>;onState:(state:VoiceState)=>void;onAudioLevel?:(level:number)=>void;requestTask:(prompt:string,traceContext?:TraceContext)=>Promise<string>;cancelTask:()=>void;tracer?:unknown});
 configuration():{hasKey:boolean;providerId:string;providerLabel:string};refreshCredentials():{hasKey:boolean;providerId:string;providerLabel:string};configure(value:string):void;setWakeEnabled(enabled:boolean):void;snapshot():VoiceState;enterStandby():Promise<void>;start(options?:{fromWakeWord?:boolean}):Promise<void>;endSession():void;mute(value:boolean):void;interrupt():void;stop():void;close():void;
}
export type TraceContext = {traceId:string;parentSpanId?:string;traceName:string;sessionId?:string};
export interface UiAction {event_id:string;ui_session_id:string;kind:"tap"|"gesture"|"voice_command";captured_at:string;expires_at:string}
export interface NativeStep {step:number;phase:string;summary:string;taskId?:string;interaction?:{id:string;kind:"approval"|"question";details:Record<string,unknown>;expiresAt:string}}
export interface NativeTaskSummary {id:string;prompt:string;state:string;updatedAt:string}
export interface NativeTask extends NativeTaskSummary {homeActions:Array<{requestId:string;connectionId:string;command:Record<string,unknown>;simulation:boolean;recordedAt:string;status:string;receipt:unknown}>;sessionId:string;createdAt:string;error?:string;runtimeExited?:boolean;steps:NativeStep[];result?:{answer:string;executions?:Array<{command:string;exitCode:number|null;signal:string|null;timedOut:boolean;aborted:boolean}>;artifacts?:Array<{path:string;sha256:string;size:number}>}}
export interface NativeTaskPage {total:number;offset:number;items:NativeTaskSummary[]}
export interface HomeConfiguration {mode:"disabled"|"simulation"|"external_ha"|"direct_miot";haUrl:string;region:"cn"|"de"|"i2"|"ru"|"sg"|"us";hasToken:boolean;hasMiotAccount:boolean}
export interface HomeConnection {mode:string;simulation:boolean;configured:boolean;healthy:boolean;connectionId:string|null;lastVerifiedAt:string|null;error:string|null;entityCount:number}
export class MiotLoginFlow {
 constructor(options:{runtime:NativeRuntime;browser:()=>{open(authorization:string,redirect:string):void;status():string;takeCallback():string;cancel():void};active:()=>boolean;onRunning:(value:boolean)=>void});
 start(region:HomeConfiguration["region"],action:UiAction):Promise<HomeConnection>;
 cancel():void;
}
export type LlmBrandId = "openai" | "kimi" | "minimax" | "xiaomi" | "zai" | "custom";
export type CompatibleApiProtocol = "openai-completions" | "openai-responses" | "anthropic-messages";
export interface CustomEndpointConfig {api:CompatibleApiProtocol;baseUrl:string;modelId:string}
export interface LlmModelItem {id:string;name:string;reasoning:boolean;contextWindow:number;isCustom:boolean}
export interface LlmChannelStatus {providerId:string;label:string;baseUrl:string;protocolLabel:string;authTypes:Array<"api_key"|"oauth">;defaultModelId:string;hasApiKey:boolean;hasOAuth:boolean;oauthExpiresAt:number|null;models:LlmModelItem[];modelsFetched?:boolean;modelsError?:string}
export interface LlmBrandStatus {brandId:LlmBrandId;label:string;shortLabel:string;configured:boolean;channels:LlmChannelStatus[]}
export interface LlmCatalogSnapshot {brands:LlmBrandStatus[];active:{brandId:LlmBrandId;providerId:string;modelId:string;authType:"api_key"|"oauth"}|null;custom:CustomEndpointConfig}
export type LlmOAuthUiEvent =
 | {kind:"device_code";userCode:string;verificationUri:string;expiresInSeconds?:number}
 | {kind:"auth_url";url:string;instructions?:string}
 | {kind:"awaiting_callback";message:string;placeholder:string}
 | {kind:"progress";message:string};
export interface NativeRuntime {
 readonly tracer:unknown;
 homeConfiguration():HomeConfiguration;
 homeConnection():HomeConnection;
 configureHome(input:{mode:HomeConfiguration["mode"];haUrl?:string;haToken?:string;region?:HomeConfiguration["region"]},action:UiAction):Promise<HomeConfiguration>;
 connectHome():Promise<HomeConnection>;
 beginMiotLogin(region:HomeConfiguration["region"],action:UiAction):Promise<{authorizationUrl:string;redirectUri:string;expiresAt:number;attempt:number}>;
 finishMiotLogin(attempt:number,callback:string,isCurrent:()=>boolean):Promise<HomeConnection>;
 cancelMiotLogin():void;
 logoutMiot(action:UiAction):Promise<void>;
 listHome(query?:string,offset?:number):Promise<Record<string,unknown>>;
 readonly uiSessionId:string;
 configuration():{baseUrl:string;model:string;hasKey:boolean};
 recoveryCount():number;
 taskPage(offset?:number):NativeTaskPage;
 taskDetails(id:string):NativeTask;
 newConversation(action:UiAction):void;
 configure(value:{baseUrl:string;model:string;apiKey:string}):Promise<void>;
 run(prompt:string,action:UiAction,onStep:(event:NativeStep)=>void,options?:{agentOnly?:boolean;mode?:"text"|"voice";traceContext?:TraceContext}):Promise<{answer:string;taskId:string;runtimeExited:boolean}>;
 respond(taskId:string,requestId:string,answer:{outcome:"allowed-once"|"rejected"|"cancelled";userAction?:UiAction}|{answers:Array<{id:string;selected:string[];custom?:string}>}|{cancelled:true}):void;
 cancel():Promise<{state:string;runtimeExited:boolean;confirmed:boolean}>;
 close():Promise<void>;
 llmSnapshot():LlmCatalogSnapshot;
 refreshProviderModels(providerId:string):Promise<LlmCatalogSnapshot>;
 saveProviderApiKey(input:{providerId:string;apiKey?:string;modelId?:string;custom?:CustomEndpointConfig;setActive?:boolean},action:UiAction):Promise<LlmCatalogSnapshot>;
 selectActiveModel(input:{providerId:string;modelId:string;addCustomModel?:boolean},action:UiAction):Promise<LlmCatalogSnapshot>;
 removeProviderCredential(providerId:string,action:UiAction):Promise<LlmCatalogSnapshot>;
 startProviderOAuth(providerId:string,action:UiAction,onEvent:(event:LlmOAuthUiEvent)=>void):Promise<LlmCatalogSnapshot>;
 submitProviderOAuthCallback(callbackUrl:string):void;
 cancelProviderOAuth():void;
}
export interface FaceState {expression:"neutral"|"listening"|"thinking"|"speaking"|"curious"|"sleeping"|"alarmed";gaze:{x:number;y:number};blinkProgress:number;waveformBars:number[]}
export class RobotFaceController {
 constructor(options?:{onStateChange?:()=>void});getState():FaceState;setExpression(value:FaceState["expression"]):void;setGaze(x:number,y:number):void;updateAudioLevel(rms:number):void;triggerBlink():void;dispose():void;
}
export function openRuntime(host:{request(raw:string):string;begin(kind:string,raw:string):string;wait(ticket:string):Promise<string>;close():void},vault:{get(key:string):string;set(key:string,value:string):void;remove(key:string):void}):Promise<NativeRuntime>;
`,
  );
}
