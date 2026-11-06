import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { nshNodeCompatPlugin } from "../../../packages/nsh-node-compat/src/bundler.js";
import { nshCodemodePlugin } from "../../../packages/nsh-node-compat/src/codemode-bundler.js";
import { nshPiSdkPlugin } from "../../../packages/nsh-node-compat/src/pi-sdk-bundler.js";

/** Separate from the test probe: no faux provider or acceptance fixtures ship. */
export async function buildRuntime() {
  const root = resolve(import.meta.dirname, "..");
  await mkdir(resolve(root, "generated"), { recursive: true });
  await build({
    stdin: {
      resolveDir: root,
      contents: `
    import {installNshNativeCompat} from "../../packages/nsh-node-compat/src/native-host.ts";
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
export interface UiAction {event_id:string;ui_session_id:string;kind:"tap"|"gesture"|"voice_command";captured_at:string;expires_at:string}
export interface NativeStep {phase:string;summary:string;taskId?:string;interaction?:{id:string;kind:"approval"|"question";details:Record<string,unknown>;expiresAt:string}}
export interface NativeRuntime {
 readonly uiSessionId:string;
 configuration():{baseUrl:string;model:string;hasKey:boolean};
 recoveryCount():number;
 configure(value:{baseUrl:string;model:string;apiKey:string}):Promise<void>;
 run(prompt:string,action:UiAction,onStep:(event:NativeStep)=>void):Promise<{answer:string;taskId:string;runtimeExited:boolean}>;
 respond(taskId:string,requestId:string,answer:{outcome:"allowed-once"|"rejected"|"cancelled";userAction?:UiAction}|{answers:Array<{id:string;selected:string[];custom?:string}>}|{cancelled:true}):void;
 cancel():Promise<{state:string;runtimeExited:boolean;confirmed:boolean}>;
 close():Promise<void>;
}
export interface FaceState {expression:"neutral"|"listening"|"thinking"|"speaking"|"curious"|"sleeping"|"alarmed";gaze:{x:number;y:number};blinkProgress:number;waveformBars:number[]}
export class RobotFaceController {
 constructor(options?:{onStateChange?:()=>void});getState():FaceState;setExpression(value:FaceState["expression"]):void;triggerBlink():void;dispose():void;
}
export function openRuntime(host:{request(raw:string):string;begin(kind:string,raw:string):string;wait(ticket:string):Promise<string>;close():void},vault:{get(key:string):string;set(key:string,value:string):void;remove(key:string):void}):Promise<NativeRuntime>;
`,
  );
}
