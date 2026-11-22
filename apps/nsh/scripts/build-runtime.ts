import { build, context, type BuildOptions } from "esbuild";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { nshNodeCompatPlugin } from "../../../packages/nsh-node-compat/src/bundler.js";
import { nshCodemodePlugin } from "../../../packages/nsh-node-compat/src/codemode-bundler.js";
import { nshPiCodingToolsPlugin } from "../../../packages/nsh-node-compat/src/pi-coding-bundler.js";
import { nshPiSdkPlugin } from "../../../packages/nsh-node-compat/src/pi-sdk-bundler.js";
import { loadRuntimeVariables } from "./build-env.mjs";
import { writeGenerated } from "./write-generated.mjs";

/** Separate from the test probe: no faux provider or acceptance fixtures ship. */
export async function buildRuntime(options: { release?: boolean; debugTelemetry?: boolean; development?: boolean; simulator?: boolean } = {}) {
  const root = resolve(import.meta.dirname, "..");
  const variables = loadRuntimeVariables(options);
  await mkdir(resolve(root, "generated"), { recursive: true });
  const settings: BuildOptions = {
    write: false,
    stdin: {
      resolveDir: root,
      contents: `
    import {installNshNativeCompat} from "../../packages/nsh-node-compat/src/native-host.ts";
    export {utf8Tail} from "../../packages/looi-runtime/src/agent/shell-output.ts";
    export {VoiceRuntime, VoiceTaskCoordinator} from "./runtime/voice.ts";
    export {MiotLoginFlow} from "./runtime/miot-login.ts";
    export {resolveApplianceCardView, packBentoTiles} from "@super-looi/home-devices";
    export {RobotFaceController, FACE_EXPRESSION_IDS, FACE_PRIORITY, isFaceExpression, getFaceExpressionBehavior} from "../../packages/looi-runtime/src/ui/robot-face-controller.ts";
    export {verifyEd25519Signature, verifyNshPackage} from "./runtime/plugins/package-loader.ts";
    export {parseCron, previewCronOccurrences, isWithinQuietHours} from "../../packages/looi-runtime/src/schedule.ts";
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
      "process.env.LOOI_IOS_SIMULATOR": JSON.stringify(options.simulator ? "1" : "0"),
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
          builder.onResolve({ filter: /^@super-looi\/looi-driver$/ }, () => ({
            path: resolve(root, "../../packages/looi-driver/src/index.ts"),
          }));
          builder.onResolve({ filter: /^@super-looi\/contracts$/ }, () => ({
            path: resolve(root, "../../packages/contracts/src/index.ts"),
          }));
          builder.onResolve({ filter: /^@super-looi\/home-assistant$/ }, () => ({
            path: resolve(root, "../../packages/home-assistant/src/index.ts"),
          }));
          builder.onResolve({ filter: /^@super-looi\/search$/ }, () => ({
            path: resolve(root, "../../packages/search/src/index.ts"),
          }));
          builder.onResolve({ filter: /^@super-looi\/home-devices$/ }, () => ({
            path: resolve(root, "../../packages/home-devices/src/index.ts"),
          }));
        },
      },
      nshPiSdkPlugin(),
      nshCodemodePlugin(),
      nshPiCodingToolsPlugin(),
      nshNodeCompatPlugin(),
      {
        name: "write-runtime-output",
        setup(builder) {
          builder.onEnd(async result => {
            for (const output of result.outputFiles || []) await writeGenerated(output.path, output.contents);
          });
        },
      },
    ],
    outfile: resolve(root, options.development ? "generated/looi-runtime.dev.js" : "generated/looi-runtime.js"),
  };
  const compiler = options.development ? await context(settings) : undefined;
  if (compiler) await compiler.rebuild();
  else await build(settings);
  await writeGenerated(
    resolve(root, "generated/looi-runtime.d.ts"),
    `
export interface VoiceState {phase:"idle"|"standby"|"permission"|"connecting"|"listening"|"speaking"|"error";muted:boolean;wakeEnabled:boolean;wakeNeedsConfiguration?:boolean;transcript:string;userTranscript?:string;purpose?:"conversation"|"preview";activeVoiceId?:string;error:string}
export interface VoiceProactiveNotice {id:string;taskId?:string;traceContext?:TraceContext;spokenText:string;contextNote?:string;delivery?:"when_idle"|"interrupt";verbatim?:boolean;respectQuietHours?:boolean;onResult?:(result:{readonly completed:boolean;readonly interruptedReason?:string})=>void}
export type VoiceTaskSubmissionResult = {status:"completed";taskId:string;answer:string}|{status:"running_in_background";taskId:string;latestSummary:string}|{status:"waiting_user_confirmation";taskId:string;interactionKind:"approval"|"question";latestSummary:string}|{status:"busy";taskId:string;latestSummary:string}|{status:"failed";taskId?:string;error:string};
export interface VoiceTaskStatusSnapshot {taskId:string;prompt:string;state:"running"|"waiting_user"|"completed"|"failed"|"cancelled";latestSummary:string;answer?:string;error?:string}
export interface VoiceTaskBridge {submit(prompt:string,traceContext?:TraceContext):Promise<VoiceTaskSubmissionResult>;inspect(taskId?:string):VoiceTaskStatusSnapshot|null;cancel(taskId?:string):Promise<{cancelled:boolean;taskId?:string}>;sendMessage?(message:string,behavior:"steer"|"followUp",taskId?:string):Promise<{status:"queued"|"handled";taskId:string}>}
export class VoiceTaskCoordinator implements VoiceTaskBridge {
 constructor(options:{defaultLanguage?:()=>"zh-CN"|"en-US";isExternalBusy?:()=>boolean;runTask:(prompt:string,hooks:{onStep:(event:NativeStep)=>void},traceContext?:TraceContext)=>Promise<{answer:string;taskId?:string}>;cancelRunningTask:()=>Promise<boolean>;sendRunningTaskMessage?:(taskId:string,message:string,behavior:"steer"|"followUp")=>Promise<"queued"|"handled">;onNotice?:(notice:VoiceProactiveNotice)=>void;onContextNote?:(note:string)=>void});
 readonly hasActiveTask:boolean;
 submit(prompt:string,traceContext?:TraceContext):Promise<VoiceTaskSubmissionResult>;
 inspect(taskId?:string):VoiceTaskStatusSnapshot|null;
 cancel(taskId?:string):Promise<{cancelled:boolean;taskId?:string}>;
 sendMessage(message:string,behavior:"steer"|"followUp",taskId?:string):Promise<{status:"queued"|"handled";taskId:string}>;
 markExternallyCancelled():void;
}
interface VoiceHome {
 list(query?:string,offset?:number):Promise<unknown>;
 control(command:import("@super-looi/contracts").HomeControlCommand,action:{connectionId:string;requestId:string}):Promise<unknown>;
 controlByName(target:{name:string;room?:string},operation:Pick<import("@super-looi/contracts").HomeControlCommand,"service"|"service_data">,requestId:string):Promise<unknown>;
}
export interface VoiceSchedule {
 createRule(input:CreateScheduleRuleInput):{rule:ScheduleRule;merged:boolean};
 listRules(filter?:{state?:ScheduleRuleState;origin?:ScheduleOrigin}):ScheduleRule[];
 updateRule(id:string,patch:UpdateScheduleRuleInput):ScheduleRule;
 cancelRule(id:string):Promise<ScheduleRule>;
 runNow(id:string):Promise<ScheduleRunRecord>;
 getSettings():ScheduleSettings;
 addQuietHoursWindow(input:Omit<QuietHoursWindow,"id">&{id?:string}):ScheduleSettings;
 updateQuietHoursWindow(id:string,patch:Partial<Omit<QuietHoursWindow,"id">>):ScheduleSettings;
 removeQuietHoursWindow(id:string):ScheduleSettings;
 setQuietHoursEnabled(enabled:boolean):ScheduleSettings;
 isQuietHoursNow():boolean;
}
export class VoiceRuntime {
 constructor(options:{home?:()=>VoiceHome|undefined;schedule?:()=>VoiceSchedule|undefined;isQuietHoursNow?:()=>boolean;previewInput?:()=>Promise<Uint8Array>;canAutoStandby?:()=>boolean;conversationId?:()=>string;defaultLanguage?:()=>"zh-CN"|"en-US";vault:{get(key:string):string;set(key:string,value:string):void;remove(key:string):void};audio:{requestPermission():string;start(capture:boolean):void;beginWake():number;startWake(ticket:number,resumeFocus?:boolean):Promise<boolean>;stop():void;setCaptureMode(mode:string):void;playReadyCue():void;playDockCue?(docked:boolean):void;enqueue(pcm:Uint8Array,rate:number):void;clearPlayback():void;setMuted(muted:boolean):void;drainCapture():Array<{pcm:Uint8Array;timestampMs:number;sampleRate:number}>;status():{state:string;permission:string;error:string;queuedPlaybackMs:number;captureMode:string;wakeWord:string;kwsReady:boolean}};connect:(url:string,options:{headers:Record<string,string>})=>Promise<{read():Promise<string|Uint8Array|null>;write(value:string|Uint8Array):Promise<void>;close():Promise<void>}>;onState:(state:VoiceState)=>void;onAudioLevel?:(level:number)=>void;onConversationActivity?:()=>void;requestTask?:(prompt:string,traceContext?:TraceContext)=>Promise<string>;taskBridge?:VoiceTaskBridge;controlBody?:(action:string,durationMs?:number,options?:{headDegrees?:number;brightness?:number;speed?:number;turn?:number})=>Promise<unknown>;stopVoiceMotion?:()=>Promise<unknown>;redactSecrets?:(text:string)=>string;onSessionEnd?:()=>void;cancelTask?:()=>void;tracer?:unknown;initialPluginContext?:()=>string;pluginVoiceTools?:()=>readonly PluginVoiceTool[];evaluateVoiceToolCall?:(call:{toolName:string;arguments:Record<string,unknown>})=>Promise<(Exclude<ToolCallBailResult,undefined>&{readonly pluginId?:string})|undefined>;evaluateVoiceUserTurn?:(text:string)=>Promise<(Exclude<UserTurnBailResult,undefined>&{readonly pluginId?:string})|undefined>;assembleVoiceTurn?:(text:string)=>Promise<AiTurnDraft>});
 configuration():{hasKey:boolean;keyHint?:string;providerId:string;providerLabel:string;voiceId:string;configuredProviders:Record<string,boolean>};selectProvider(providerId:string):{hasKey:boolean;keyHint?:string;providerId:string;providerLabel:string;voiceId:string;configuredProviders:Record<string,boolean>};refreshCredentials(autoStandby?:boolean,modelProviderId?:string):{hasKey:boolean;keyHint?:string;providerId:string;providerLabel:string;voiceId:string;configuredProviders:Record<string,boolean>};configure(value:string):void;configureVoiceId(value:string):void;clearCredentials():void;preview(options?:{voiceId?:string;sampleText?:string}):Promise<void>;restartSession():Promise<void>;setWakeEnabled(enabled:boolean,options?:{autoStandby?:boolean}):void;snapshot():VoiceState;enqueueNotice(notice:VoiceProactiveNotice):void;setContextNote(note:string,syncActiveSession?:boolean):void;setPluginContext(note:string,syncActiveSession?:boolean):void;refreshPluginVoiceTools():void;listenUntil(deadlineMs:number,signal:AbortSignal):Promise<void>;speak(options:{spokenText:string;contextNote?:string;delivery?:"when_idle"|"interrupt";capturePolicy?:"inherit"|"duplex"|"muted_broadcast";verbatim?:boolean;respectQuietHours?:boolean;holdAliveMs?:number;closeToStandbyOnComplete?:boolean;signal?:AbortSignal}):Promise<{readonly completed:boolean;readonly interruptedReason?:string}>;enterStandby():Promise<void>;start(options?:{fromWakeWord?:boolean}):Promise<void>;endSession():void;mute(value:boolean):void;interrupt():void;playDockCue(docked:boolean):void;stopIdleCue():void;stopStandby():void;stop():void;close():void;
}
export type TraceContext = {traceId:string;parentSpanId?:string;traceName:string;sessionId?:string};
export interface UiAction {event_id:string;ui_session_id:string;kind:"tap"|"gesture"|"voice_command";captured_at:string;expires_at:string}
export function utf8Tail(text:string,limit:number):string;
export interface NativeShellOutput {taskId:string;callId:string;command:string;stream:"stdout"|"stderr"|"status";chunk:string}
export interface NativeStep {step:number;phase:string;summary:string;taskId?:string;interaction?:{id:string;kind:"approval"|"question";details:Record<string,unknown>;expiresAt:string}}
export interface NativeTaskSummary {id:string;prompt:string;state:string;updatedAt:string;lane?:"foreground"|"plugin"|"schedule";voiceToolName?:string}
export interface NativeObservation {traceId:string;spanId:string;parentSpanId?:string;name:string;type:"span"|"agent"|"generation"|"tool";startedAt:number;endedAt?:number;attributes:Record<string,unknown>}
export interface NativeTask extends NativeTaskSummary {trace?:{traceId:string;spanId:string};observations?:NativeObservation[];voiceToolCall?:{input:unknown;output:unknown};homeActions:Array<{requestId:string;connectionId:string;command:Record<string,unknown>;simulation:boolean;recordedAt:string;status:string;receipt:unknown}>;bodyActions?:Array<{requestId:string;command:{action:string;durationMs?:number;headDegrees?:number;brightness?:number;speed?:number;turn?:number};simulation:boolean;recordedAt:string;status:string;receipt:unknown}>;sessionId:string;createdAt:string;error?:string;runtimeExited?:boolean;steps:NativeStep[];result?:{answer:string;executions?:Array<{callId:string;stdout?:string;stderr?:string;command:string;exitCode:number|null;signal:string|null;timedOut:boolean;aborted:boolean}>;artifacts?:Array<{path:string;sha256:string;size:number}>}}
export interface NativeTaskPage {total:number;offset:number;items:NativeTaskSummary[]}
export type HomeSourceId = "direct_miot" | "external_ha" | "simulation";
export type TileSpan = "1x1" | "2x1" | "1x2" | "2x2";
export type ApplianceArchetype = "vision_security" | "cycle_appliance" | "climate" | "lighting_power" | "media" | "sensor_pet";
export type ApplianceIconKind = "camera" | "lock" | "bell" | "cooker" | "washer" | "dishwasher" | "microwave" | "vacuum" | "kettle" | "ac" | "fan" | "purifier" | "dehumidifier" | "blanket" | "light" | "desk_lamp" | "switch_gang" | "plug" | "tv" | "speaker" | "feeder" | "waterer" | "sensor" | "router";
export interface HomeSourceStatus {enabled:boolean;configured:boolean;healthy:boolean;entityCount:number;error:string|null}
export interface HomeLayoutPreferences {version:1;appliances:Record<string,{span?:TileSpan;order?:number}>}
export interface HomeConfiguration {mode:"disabled"|"simulation"|"external_ha"|"direct_miot";haUrl:string;region:"cn"|"de"|"i2"|"ru"|"sg"|"us";hasToken:boolean;hasMiotAccount:boolean;enabledSources?:Record<HomeSourceId,boolean>;layout?:HomeLayoutPreferences}
export interface HomeConnection {mode:string;simulation:boolean;configured:boolean;healthy:boolean;connectionId:string|null;lastVerifiedAt:string|null;error:string|null;entityCount:number;sources?:Record<HomeSourceId,HomeSourceStatus>}
export interface MultiGangChannel {id:string;label:string;entityId:string;domain:string;isOn:boolean;controllable:boolean}
export interface ModeOption {value:string;label:string}
export interface ModeBarCapability {entityId:string;domain:string;service:string;parameterKey:string;currentMode:string;currentLabel:string;options:ModeOption[];controllable:boolean}
export interface ApplianceActionTrigger {id:string;label:string;entityId:string;domain:string;service:string;serviceData?:Record<string,unknown>;tone?:"primary"|"default"|"destructive";iconKey?:"play"|"pause"|"stop"|"dock"|"dust"|"wash"|"dry"|"locate"|"dispense"|"refresh"|"power"}
export interface VacuumConsumableMetric {id:string;label:string;percent:number;remainingHours?:number;resetAction?:ApplianceActionTrigger}
export type VacuumStatusCode = "cleaning"|"returning"|"charging"|"docked"|"paused"|"drying"|"washing"|"dust_collecting"|"error"|"idle";
export interface VacuumCapability {statusCode:VacuumStatusCode;statusLabel:string;chargingLabel?:string;batteryPercent?:number;cleaningAreaSqm?:number;cleaningMinutes?:number;totalCleanCount?:number;totalCleanAreaSqm?:number;totalCleanHours?:number;waterBoxInstalled?:boolean;mopModeBar?:ModeBarCapability;consumables:VacuumConsumableMetric[]}
export type ApplianceControlPrimitive =
  | {kind:"toggle";id:string;label:string;entityId:string;domain:string;serviceOn?:string;serviceOff?:string;serviceDataOn?:Record<string,unknown>;serviceDataOff?:Record<string,unknown>;isOn:boolean;controllable:boolean;role?:"primary_power"|"channel"|"swing"|"feature"}
  | {kind:"range";id:string;label:string;entityId:string;domain:string;service:string;parameterKey:string;value:number;min:number;max:number;step:number;unit?:string;controllable:boolean}
  | {kind:"choice";id:string;label:string;entityId:string;domain:string;service:string;parameterKey:string;currentValue:string;currentLabel:string;options:ModeOption[];controllable:boolean}
  | {kind:"action";id:string;label:string;entityId:string;domain:string;service:string;serviceData?:Record<string,unknown>;tone?:"primary"|"default"|"destructive";iconKey?:ApplianceActionTrigger["iconKey"]}
  | {kind:"metric";id:string;label:string;value:string;numericValue?:number;unit?:string;badge?:string};
export interface HomeAppliance {id:string;deviceId:string;source:HomeSourceId;sourceLabel:string;name:string;displayName?:string;room:string;homeName?:string;model?:string;archetype:ApplianceArchetype;icon:ApplianceIconKind;defaultSpan:TileSpan;span:TileSpan;order:number;online:boolean;isActive:boolean;statusBadge:string;conciseSubtitle:string;entityIds:string[];capabilities:{power?:{entityId:string;domain:string;isOn:boolean;controllable:boolean};multiGang?:{channels:MultiGangChannel[]};thermostat?:{entityId:string;domain:string;currentTemp?:number;targetTemp:number;minTemp:number;maxTemp:number;step:number;unit:string;controllable:boolean};modeBar?:ModeBarCapability;fanLevel?:ModeBarCapability;cycleTask?:{stageLabel:string;stages:string[];activeStageIndex:number;remainingMinutes?:number;keepWarmMinutes?:number;progressPercent?:number;temperatureCelsius?:number;targetTempCelsius?:number;recipeLabel?:string;isRunning:boolean;subStatus?:string};vacuum?:VacuumCapability;actions?:ApplianceActionTrigger[];visionStream?:{playbackKind?:"native"|"hls"|"p2p_pending"|"unsupported";cameraOn?:boolean;supportsPtz?:boolean;streamActive:boolean;statusText:string;resolutionBadge?:string;lastMotionText?:string;storageStatusText?:string;storageUsedPercent?:number;streamEntityId?:string;stopEntityId?:string;ptzActions:ApplianceActionTrigger[];featureToggles:Array<{id:string;label:string;entityId:string;domain:string;isOn:boolean;controllable:boolean}>;modeSelectors?:Array<{id:string;label:string;capability:ModeBarCapability}>};securityEvents?:{readOnly:boolean;lockState?:string;doorState?:string;batteryPercent?:number;events:Array<{time:string;label:string}>};dimmer?:{entityId:string;brightnessPercent?:number;colorTempKelvin?:number;colorTempRange?:[number,number];controllable:boolean};auxiliaryToggles?:Array<{id:string;label:string;entityId:string;domain:string;isOn:boolean;controllable:boolean}>;telemetry:Array<{key:string;label:string;value:string;numericValue?:number;unit?:string;badge?:string;sourceDeviceId?:string}>;controls?:ApplianceControlPrimitive[]}}
export interface HomeRoomSection {id:string;name:string;totalCount:number;activeCount:number;navSummary:string;environment:Array<{key:"temperature"|"humidity"|"co2"|"pm25"|"tvoc"|"occupancy"|"power";label:string;value:string;numericValue?:number;badge?:string;sourceDeviceId?:string}>;appliances:HomeAppliance[];roomPowerEntities:{turnOnIds:string[];turnOffIds:string[]}}
export interface HomeDashboardModel {homeName:string;totalAppliances:number;activeAppliances:number;rooms:HomeRoomSection[];allAppliances:HomeAppliance[]}
export interface PackedBentoTile {id:string;colStart:number;colSpan:1|2;rowStart:number;rowSpan:1|2}
export function packBentoTiles(items:ReadonlyArray<{id:string;span:TileSpan}>,columns:number):PackedBentoTile[];
export type CardHeaderTrailing = {kind:"power";entityId:string;domain:string;isOn:boolean;controllable:boolean}|{kind:"badge";label:string;tone:"warning"|"muted"|"offline"}|{kind:"none"};
export interface CycleStageStepView {label:string;state:"completed"|"current"|"upcoming"}
export interface ResolvedCycleCardBody {primaryReadout?:{value:string;caption:string};stages:CycleStageStepView[];actions:ApplianceActionTrigger[]}
export interface ResolvedClimateCardBody {thermostat?:{entityId:string;domain:string;targetTemp:number;minTemp:number;maxTemp:number;step:number;unit:string;controllable:boolean;readoutText:string};modeBar?:ModeBarCapability;fanControl?:Extract<ApplianceControlPrimitive,{kind:"choice"}>;swingToggle?:Extract<ApplianceControlPrimitive,{kind:"toggle"}>;showModeBar:boolean;showFanLevel:boolean;showSwingToggle:boolean}
export interface ResolvedVacuumCardBody {actions:ApplianceActionTrigger[];consumables:VacuumConsumableMetric[];fallbackStages?:CycleStageStepView[]}
export interface ResolvedCameraCardBody {statusPillText:string;resolutionBadge?:string;footnoteText:string;storageBadge?:string;featureToggles:Array<{id:string;label:string;entityId:string;domain:string;isOn:boolean;controllable:boolean}>}
export interface ResolvedLightCardBody {brightnessPercent:number;controllable:boolean;entityId:string;colorTempPresets:number[];activeColorTempKelvin?:number}
export interface ResolvedOfflineCardBody {title:string;subtitle:string;footnote?:string}
export interface ResolvedApplianceCardView {span:TileSpan;isExpanded:boolean;header:{title:string;subtitle:string;trailing:CardHeaderTrailing};offlineBody?:ResolvedOfflineCardBody;cycleBody?:ResolvedCycleCardBody;vacuumBody?:ResolvedVacuumCardBody;climateBody?:ResolvedClimateCardBody;cameraBody?:ResolvedCameraCardBody;lightBody?:ResolvedLightCardBody;multiGangChannels?:MultiGangChannel[];quickActions?:ApplianceActionTrigger[]}
export function resolveApplianceCardView(appliance:HomeAppliance,span?:TileSpan):ResolvedApplianceCardView;
export type BodyConnectionMode = "disabled" | "real_ble" | "simulation";
export interface BodyConfiguration {mode:BodyConnectionMode;savedDeviceId:string;savedDeviceName:string;autoConnect:boolean}
export interface BodyCandidate {id:string;name:string;rssi:number|null}
export interface BodyPowerStatus {batteryPercent:number;externalPower:boolean}
export interface BodyMotionVector {speed:number;turn:number}
export interface BodyStatusSnapshot {mode:BodyConnectionMode;simulation:boolean;permission:"granted"|"denied"|"undetermined"|"unavailable";supervisorState:string;connected:boolean;isDocked:boolean;lightOn:boolean;lightBrightness:number;powerStatus:BodyPowerStatus|null;powerReading:boolean;motion:BodyMotionVector;headPose:"up"|"center"|"down"|"custom";headDegrees:number;deviceId:string|null;deviceName:string;autoConnect:boolean;scanning:boolean;scanCompleted:boolean;connecting:boolean;candidates:BodyCandidate[];lastVerifiedAt:string|null;error:string|null}
export type BodyControlAction = "head_up" | "head_center" | "head_down" | "head_set" | "forward" | "backward" | "turn_left" | "turn_right" | "move" | "light_on" | "light_off" | "light_set" | "read_power" | "stop";
export interface BodyActionReceipt {action:BodyControlAction;status:"verified"|"sent"|"rejected"|"failed";simulation:boolean;isDocked:boolean;headDegrees:number;lightOn:boolean;lightBrightness:number;powerStatus:BodyPowerStatus|null;speed?:number;turn?:number;durationMs:number|null;stopCommandAt:string|null;recordedAt:string;reason?:string}
export interface NativeBlePort {permission():string;requestPermission():string;startScan():void;stopScan():void;scannedDevices():Array<{id:string;name:string;rssi:number}>;connect(deviceId:string):void;disconnect():void;subscribe(characteristic:string):void;write(characteristic:string,hexPayload:string,withResponse:boolean):void;read(characteristic:string):void;drainEvents():Array<{kind:string;characteristic:string;payload:string}>;status():{state:string;permission:string;deviceId:string;deviceName:string;error:string}}
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
export interface ScheduleFailure {stage:string;code?:string|number;reason:string}
export interface ScheduleToolFailure {callId:string;toolName:string;stage:string;code?:string|number;reason:string}
export type ScheduleTrigger = {kind:"once";runAt:string}|{kind:"interval";everySeconds:number}|{kind:"cron";expr:string};
export type ScheduleOrigin = "user"|"agent_inferred";
export type ScheduleExecutionPolicy = "check_only"|"authorized_action";
export type ScheduleRuleState = "active"|"running"|"paused"|"completed"|"expired"|"cancelled"|"unconfirmed";
export type ScheduleRunTriggerReason = "scheduled"|"misfire_catchup"|"manual_now";
export type ScheduleRunStatus = "running"|"succeeded"|"failed"|"awaiting_user"|"result_unconfirmed"|"missed"|"skipped";
export type ScheduleReportSource = "schedule_report"|"fallback_answer";
export type ScheduleImportance = "silent"|"notify";
export interface ScheduleChain {rootRuleId:string;followUpCount:number;maxFollowUps:number}
export interface ScheduleRule {id:string;title:string;prompt:string;origin:ScheduleOrigin;dedupeKey?:string;trigger:ScheduleTrigger;executionPolicy:ScheduleExecutionPolicy;enabled:boolean;state:ScheduleRuleState;activeRunId?:string;nextRunAt:string|null;lastRunAt?:string;lastRunId?:string;sourceSessionId?:string;sourceTaskId?:string;chain:ScheduleChain;misfireGraceSeconds:number;expiresAt?:string;createdAt:string;updatedAt:string}
export interface ScheduleRunRecord {id:string;ruleId:string;ruleTitle:string;taskId?:string;sessionId?:string;triggerReason:ScheduleRunTriggerReason;scheduledFor:string;startedAt:string;finishedAt?:string;status:ScheduleRunStatus;sideEffectDispatched:boolean;reportSource?:ScheduleReportSource;importance?:ScheduleImportance;summary?:string;error?:ScheduleFailure;toolFailures?:ScheduleToolFailure[];followUpRuleId?:string}
export interface QuietHoursWindow {id:string;label?:string;startMinute:number;endMinute:number;daysOfWeek?:number[];enabled:boolean}
export interface ScheduleSettings {autoFollowUpEnabled:boolean;maxActiveInferredRules:number;quietHoursEnabled:boolean;quietHours:QuietHoursWindow[]}
export interface CreateScheduleRuleInput {title:string;prompt:string;origin?:ScheduleOrigin;dedupeKey?:string;trigger:ScheduleTrigger;executionPolicy?:ScheduleExecutionPolicy;enabled?:boolean;sourceSessionId?:string;sourceTaskId?:string;misfireGraceSeconds?:number;maxFollowUps?:number;followUpCount?:number;rootRuleId?:string;expiresAt?:string}
export interface UpdateScheduleRuleInput {title?:string;prompt?:string;trigger?:ScheduleTrigger;executionPolicy?:ScheduleExecutionPolicy;enabled?:boolean;dedupeKey?:string|null;misfireGraceSeconds?:number;maxFollowUps?:number;expiresAt?:string|null}
export type NativeNotificationPermissionStatus = "granted"|"denied"|"undetermined"|"unavailable";
export interface NativePermissionStatusResult {notification:NativeNotificationPermissionStatus;exactAlarmAllowed?:boolean;exactAlarmDegraded?:boolean}
export interface NativeUpcomingAlarm {ruleId:string;title:string;body:string;triggerAtMs:number;silent:boolean}
export interface NativeQuietHoursWindowSnapshot {id:string;startMinute:number;endMinute:number;daysOfWeek?:number[];enabled:boolean}
export interface NativeQuietHoursSnapshot {quietHoursEnabled:boolean;windows:NativeQuietHoursWindowSnapshot[]}
export interface NativeScheduleNotification {id:string;ruleId:string;runId?:string;sessionId?:string;title:string;body:string;silent:boolean}
export type NativeScheduleEvent = {kind:"notification_tapped";ruleId:string;runId?:string;sessionId?:string;timestampMs?:number}|{kind:"alarm_fired";ruleId:string;timestampMs?:number}|{kind:"ios_grace_expiring";handle?:string;timestampMs?:number}|{kind:"keepalive_timeout";timestampMs?:number}|{kind:"permission_changed";status?:NativePermissionStatusResult;timestampMs?:number};
export interface NativeSchedulePort {permissionStatus():Promise<NativePermissionStatusResult>|NativePermissionStatusResult;requestPermission():Promise<NativePermissionStatusResult>|NativePermissionStatusResult;syncUpcomingAlarms(alarms:readonly NativeUpcomingAlarm[]):Promise<void>|void;cancelAlarm(ruleId:string):Promise<void>|void;syncQuietHours(snapshot:NativeQuietHoursSnapshot):Promise<void>|void;postNotification(notification:NativeScheduleNotification):Promise<void>|void;setAndroidKeepAlive(input:{active:boolean;hasRunningCheck:boolean;nextTriggerAtMs:number|null}):Promise<void>|void;beginIosBackgroundGrace(label:string):Promise<string|null>|string|null;endIosBackgroundGrace(handle:string):Promise<void>|void;drainEvents():Promise<NativeScheduleEvent[]>|NativeScheduleEvent[];openExactAlarmSettings?():Promise<void>|void}
export interface NativeScheduleExactAlarmStatus {mode:string;degraded:boolean;canOpenSettings:boolean;reason:string}
export interface NativeScheduleAlarmSyncResult {syncedCount:number;cancelledCount:number;exactAlarmDegraded:boolean;exactAlarmMode:string}
export interface NativeScheduleKeepAliveState {active:boolean;hasRunningCheck:boolean;quotaExhausted:boolean;dailyUsedMs:number;dailyCapMs:number;sessionUsedMs:number;sessionCapMs:number;reason:string}
export interface RawScheduleNativeEvent {kind:string;ruleId:string;notificationId:string;handle:string;payloadJson:string;occurredAtMs:number}
export interface NativeScheduleHost {permissionStatus():string;requestPermission():Promise<string>;exactAlarmStatus():NativeScheduleExactAlarmStatus;openExactAlarmSettings():boolean;syncUpcomingAlarms(alarmsJson:string):NativeScheduleAlarmSyncResult;cancelAlarm(ruleId:string):boolean;syncQuietHours(quietSnapshotJson:string):void;postNotification(payloadJson:string):string;setAndroidKeepAlive(active:boolean,hasRunningCheck:boolean,nextTriggerAtMs?:number|null):NativeScheduleKeepAliveState;beginIosBackgroundGrace(label:string):string;endIosBackgroundGrace(handle:string):void;drainEvents():RawScheduleNativeEvent[];setForeground(active:boolean):void;dispose?():void}
export interface ScheduleSnapshot {rules:ScheduleRule[];recentRuns:ScheduleRunRecord[];settings:ScheduleSettings;isQuietNow:boolean;permissionStatus?:NativePermissionStatusResult}
export interface ScheduleActivityEvent {kind:"rule_created"|"rule_updated"|"rule_deleted"|"run_started"|"run_settled"|"settings_updated";ruleId?:string;runId?:string}
export type ScheduleActivityNotification = ScheduleActivityEvent & {rule?:ScheduleRule;run?:ScheduleRunRecord;merged?:boolean;isQuietHours?:boolean;foregroundActive?:boolean;notificationPosted?:boolean;notificationError?:ScheduleFailure};
export type ScheduleInteractionEvent = {type:"requested";taskId:string;ruleId?:string;ruleTitle?:string;runId?:string;interaction:{id:string;kind:"approval"|"question";details:Record<string,unknown>;expiresAt:string}}|{type:"cleared";taskId:string;interactionId:string;taskState:string};
export interface GitHubFailure {stage:string;code?:string|number;reason:string}
export interface GitHubCredentialStatus {configured:boolean;tokenHint?:string}
export interface GitHubTokenVerificationResult {valid:boolean;configured:boolean;tokenHint?:string;rateLimit?:{limit:number;remaining:number;resetAt:string};failure?:GitHubFailure}
export interface ParsedCronField {readonly values:readonly number[];readonly set:ReadonlySet<number>;readonly restricted:boolean}
export interface ParsedCron {readonly expr:string;readonly minute:ParsedCronField;readonly hour:ParsedCronField;readonly dom:ParsedCronField;readonly month:ParsedCronField;readonly dow:ParsedCronField}
export function parseCron(expr:string):ParsedCron;
export function previewCronOccurrences(expr:string,count?:number,after?:Date,options?:{maxYears?:number}):Date[];
export function isWithinQuietHours(now:Date,settings:Pick<ScheduleSettings,"quietHoursEnabled"|"quietHours">):boolean;
import type {PluginSnapshot,PluginFailure,PluginEvent,PluginCategory,PluginManifest,PluginDependencyStatus,PluginStagePresentation,ResumableStageView,FaceStagePosture,StageDrawerDetent,PluginVoiceTool,ToolCallBailResult,UserTurnBailResult,AiTurnDraft,DetectedCameraFace,NativeDeviceCameraFrame,NativeDeviceCameraFacesFrame,NativeCroppedPortrait,NativeDeviceCameraPort,VisionBrokerAttachOptions,NativeDeviceMotionSample,NativeDeviceMotionPort,MotionBrokerAttachOptions,BodyCliffState,BodySensorPacket,LanHttpRequest,LanHttpResponse,LanRoomSession,NativeLanRoomInfo,NativeLanHttpRequest,NativeLanRoomPort} from "../runtime/plugins/shared-types.js";
export type {PluginSnapshot,PluginFailure,PluginEvent,PluginCategory,PluginManifest,PluginDependencyStatus,PluginStagePresentation,ResumableStageView,FaceStagePosture,StageDrawerDetent,PluginVoiceTool,ToolCallBailResult,UserTurnBailResult,AiTurnDraft,DetectedCameraFace,NativeDeviceCameraFrame,NativeDeviceCameraFacesFrame,NativeCroppedPortrait,NativeDeviceCameraPort,VisionBrokerAttachOptions,NativeDeviceMotionSample,NativeDeviceMotionPort,MotionBrokerAttachOptions,BodyCliffState,BodySensorPacket,LanHttpRequest,LanHttpResponse,LanRoomSession,NativeLanRoomInfo,NativeLanHttpRequest,NativeLanRoomPort} from "../runtime/plugins/shared-types.js";
export interface NativeRuntime {
 pluginsSnapshot():PluginSnapshot[];
 startPlugins():Promise<void>;
 activeStagePresentation():{pluginId:string;revision:number;presentation:PluginStagePresentation}|null;
 resumableStage():ResumableStageView|null;
 resumePluginStage(id?:string):Promise<void>;
 setPluginsForegroundActive(active:boolean):void;
 exitPluginStage(id:string):void;
 reportPluginStageCrash(id:string,slot:"StageCanvas"|"StageCompanion"|"StageCapsule"|"StageDrawer",error:unknown):PluginFailure;
 installMarketplacePlugin(rawArchive:string|Uint8Array|{readonly format:"nshpkg-v1";readonly manifest:PluginManifest;readonly runtimeEntry:string;readonly uiEntry?:string;readonly sha256:string;readonly keyId:string;readonly signature:string},verifyOptions:{readonly trustedKeys:Readonly<Record<string,string|Uint8Array>>;readonly hostApiVersion?:number},createDefinition:(verified:{readonly manifest:PluginManifest;readonly runtimeEntry:string;readonly uiEntry?:string;readonly sha256:string;readonly keyId:string})=>unknown,action:UiAction):Promise<PluginSnapshot>;
 attachFaceController(controller:RobotFaceController|undefined):void;
 attachNativeDeviceCamera(port:NativeDeviceCameraPort|null,options?:VisionBrokerAttachOptions):void;
 setDeviceCameraForegroundActive(active:boolean):void;
 attachNativeDeviceMotion(port:NativeDeviceMotionPort|null,options?:MotionBrokerAttachOptions):void;
 setDeviceMotionForegroundActive(active:boolean):void;
 attachNativeLanRoom(port:NativeLanRoomPort|null):void;
 setLanRoomForegroundActive(active:boolean):void;
 setPluginAiBridge(bridge:{speak?:(options:{pluginId:string;spokenText:string;contextNote?:string;delivery:"when_idle"|"interrupt";capturePolicy?:"inherit"|"duplex"|"muted_broadcast";verbatim?:boolean;holdAliveMs?:number;closeToStandbyOnComplete?:boolean;signal?:AbortSignal})=>Promise<{readonly completed:boolean;readonly interruptedReason?:string}>;listenUntil?:(deadlineMs:number,signal:AbortSignal)=>Promise<void>;runBackgroundTask?:(options:{pluginId:string;prompt:string})=>Promise<{readonly taskId:string;readonly answer:string}>;onVoiceContextUpdated?:(summaryPrompt:string)=>void;onVoiceToolsUpdated?:()=>void}):void;
 pluginAmbientVoiceContext():string;
 pluginVoiceTools():readonly PluginVoiceTool[];
 evaluateVoiceToolCall(call:{toolName:string;arguments:Record<string,unknown>}):Promise<(Exclude<ToolCallBailResult,undefined>&{readonly pluginId:string})|undefined>;
 evaluateVoiceUserTurn(text:string):Promise<(Exclude<UserTurnBailResult,undefined>&{readonly pluginId:string})|undefined>;
 assembleVoiceTurn(text:string):Promise<AiTurnDraft>;
 subscribePlugins(listener:(event:PluginEvent)=>void):()=>void;
 refreshPlugin(id:string):Promise<PluginSnapshot[]>;
 setPluginEnabled(id:string,enabled:boolean,action:UiAction):Promise<PluginSnapshot>;
 configurePlugin(id:string,enabled:boolean,values:Record<string,string>,action:UiAction):Promise<PluginSnapshot>;
 sendPluginCommand<TCommand=unknown,TResult=unknown>(id:string,command:TCommand,action:UiAction):Promise<TResult>;
 beginPluginLogin(id:string,action:UiAction):Promise<{sessionId:string}>;
 cancelPluginLogin(id:string):Promise<void>;
 logoutPlugin(id:string,action:UiAction):Promise<void>;
 readonly tracer:{start(name:string,type:"span"|"agent"|"generation"|"tool",context?:TraceContext,attributes?:Record<string,unknown>):{end(attributes?:Record<string,unknown>):void}};
 subscribeTaskActivity(listener:(historyChanged:boolean)=>void):()=>void;
 homeConfiguration():HomeConfiguration;
 voiceHome():VoiceHome|undefined;
 voiceSchedule():VoiceSchedule;
 homeConnection():HomeConnection;
 configureHome(input:{mode:HomeConfiguration["mode"];haUrl?:string;haToken?:string;region?:HomeConfiguration["region"];enabledSources?:Partial<Record<HomeSourceId,boolean>>},action:UiAction):Promise<HomeConfiguration>;
 connectHome():Promise<HomeConnection>;
 beginMiotLogin(region:HomeConfiguration["region"],action:UiAction):Promise<{authorizationUrl:string;redirectUri:string;expiresAt:number;attempt:number}>;
 finishMiotLogin(attempt:number,callback:string,isCurrent:()=>boolean):Promise<HomeConnection>;
 cancelMiotLogin():void;
 logoutMiot(action:UiAction):Promise<void>;
 listHome(query?:string,offset?:number):Promise<Record<string,unknown>>;
 homeDashboard(lang?:"zh-CN"|"en-US"):Promise<HomeDashboardModel>;
 cachedHomeDashboard(lang?:"zh-CN"|"en-US"):HomeDashboardModel|null;
 setHomeSourceEnabled(source:HomeSourceId,enabled:boolean,action:UiAction):Promise<HomeConnection>;
 startHomeCamera(did:string):Promise<{sessionId:string;protocol:"native"}>;
 attachNativeCamera(camera: import("../runtime/camera.js").NativeCamera):void;
 stopHomeCamera():Promise<void>;
 panTiltHomeCamera(did:string,direction:"left"|"right"|"up"|"down",action:UiAction):Promise<void>;
 setHomeApplianceLayout(applianceId:string,patch:{span?:TileSpan;order?:number}):HomeLayoutPreferences;
 controlHomeAppliance(command:{entity_id:string;domain:string;service:string;service_data?:Record<string,unknown>;timeout_ms?:number},action:UiAction):Promise<{receipt:{status:string;outcome?:string;reason_code?:string|null};simulation:boolean;connectionId:string;instruction:string}>;
 bodyConfiguration():BodyConfiguration;
 bodyStatus():BodyStatusSnapshot;
 attachNativeBle(port:NativeBlePort|null):BodyStatusSnapshot;
 setBodyForegroundActive(active:boolean):BodyStatusSnapshot;
 configureBody(input:Partial<BodyConfiguration>,action:UiAction):Promise<BodyStatusSnapshot>;
 scanBodyDevices(timeoutMs?:number):Promise<BodyStatusSnapshot>;
 connectBodyDevice(target?:{deviceId?:string;deviceName?:string}):Promise<BodyStatusSnapshot>;
 disconnectBody():Promise<BodyStatusSnapshot>;
 forgetSavedDock():Promise<BodyStatusSnapshot>;
 setSimulatedDock(docked:boolean):BodyStatusSnapshot;
 controlBody(input:{action:BodyControlAction;durationMs?:number;headDegrees?:number;brightness?:number;speed?:number;turn?:number},holder?:string):Promise<BodyActionReceipt>;
 stopBody():Promise<BodyStatusSnapshot>;
 stopVoiceMotion():Promise<BodyStatusSnapshot>;
 redactSecrets(text:string):string;
 startBodyDrive(action:"forward"|"backward"|"turn_left"|"turn_right"):Promise<BodyStatusSnapshot>;
 renewBodyDrive():boolean;
 setBodyDriveVector(speed:number,turn:number):Promise<BodyStatusSnapshot>;
 readBodyPower():Promise<BodyStatusSnapshot>;
 readonly uiSessionId:string;
 configuration():{baseUrl:string;model:string;hasKey:boolean};
 taskPage(offset?:number):NativeTaskPage;
 taskDetails(id:string):NativeTask;
 newConversation(action:UiAction):void;
 activeConversationId():string;
 adoptConversationSession(sessionId:string,action:UiAction):{conversationId:string};
 configure(value:{baseUrl:string;model:string;apiKey:string}):Promise<void>;
 voiceConversationId():string;
 touchVoiceConversation():void;
 run(prompt:string,action:UiAction,onStep:(event:NativeStep)=>void,options?:{onShellOutput?:(event:NativeShellOutput)=>void;agentOnly?:boolean;mode?:"text"|"voice";approvalMode?:"ask"|"local_auto"|"yolo";defaultLanguage?:"zh-CN"|"en-US";traceContext?:TraceContext}):Promise<{answer:string;taskId:string;runtimeExited:boolean}>;
 sendTaskMessage(taskId:string,message:string,behavior:"steer"|"followUp",action:UiAction):Promise<"queued"|"handled">;
 respond(taskId:string,requestId:string,answer:{outcome:"allowed-once"|"rejected"|"cancelled";userAction?:UiAction}|{answers:Array<{id:string;selected:string[];custom?:string}>}|{cancelled:true}):void;
 respondTask(taskId:string,requestId:string,answer:{outcome:"allowed-once"|"rejected"|"cancelled";userAction?:UiAction}|{answers:Array<{id:string;selected:string[];custom?:string}>}|{cancelled:true}):void;
 cancelTask(taskId:string):Promise<{state:string;runtimeExited:boolean;confirmed:boolean}>;
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
 attachNativeSchedule(hostOrPort:NativeScheduleHost|NativeSchedulePort|null,options?:{foregroundActive?:boolean}):Promise<void>;
 setScheduleForegroundActive(active:boolean):Promise<void>;
 handleNativeScheduleEvents(events?:readonly NativeScheduleEvent[]):Promise<{tappedRule?:ScheduleRule;tappedRun?:ScheduleRunRecord}>;
 reconcileScheduleDueRules():Promise<ScheduleRunRecord[]>;
 scheduleExactAlarmStatus():NativeScheduleExactAlarmStatus|null;
 openScheduleExactAlarmSettings():Promise<boolean>;
 requestSchedulePermission(action?:UiAction):Promise<NativePermissionStatusResult>;
 scheduleSnapshot():Promise<ScheduleSnapshot>;
 scheduleSnapshotSync():Omit<ScheduleSnapshot,"permissionStatus">;
 subscribeScheduleActivity(listener:(event:ScheduleActivityNotification)=>void):()=>void;
 subscribeScheduleInteractions(listener:(event:ScheduleInteractionEvent)=>void):()=>void;
 pendingScheduleInteractions():Array<ScheduleInteractionEvent&{type:"requested"}>;
 listScheduleRules(filter?:{state?:ScheduleRuleState;origin?:ScheduleOrigin}):ScheduleRule[];
 listScheduleRuns(ruleId?:string,limit?:number):ScheduleRunRecord[];
 createScheduleRule(input:CreateScheduleRuleInput,action?:UiAction):{rule:ScheduleRule;merged:boolean};
 updateScheduleRule(id:string,patch:UpdateScheduleRuleInput,action?:UiAction):ScheduleRule;
 setScheduleRuleEnabled(id:string,enabled:boolean,action?:UiAction):ScheduleRule;
 cancelScheduleRule(id:string,action?:UiAction):Promise<ScheduleRule>;
 deleteScheduleRule(id:string,action?:UiAction):Promise<boolean>;
 runScheduleRuleNow(id:string,action?:UiAction):Promise<ScheduleRunRecord>;
 updateScheduleSettings(patch:Partial<ScheduleSettings>,action?:UiAction):ScheduleSettings;
 addQuietHoursWindow(input:Omit<QuietHoursWindow,"id">&{id?:string},action?:UiAction):ScheduleSettings;
 updateQuietHoursWindow(id:string,patch:Partial<Omit<QuietHoursWindow,"id">>,action?:UiAction):ScheduleSettings;
 removeQuietHoursWindow(id:string,action?:UiAction):ScheduleSettings;
 setQuietHoursEnabled(enabled:boolean,action?:UiAction):ScheduleSettings;
 isQuietHoursNow():boolean;
 githubCredentialStatus():GitHubCredentialStatus;
 saveGitHubToken(token:string,action:UiAction):GitHubCredentialStatus;
 verifyGitHubToken(action:UiAction):Promise<GitHubTokenVerificationResult>;
 clearGitHubToken(action:UiAction):GitHubCredentialStatus;
}
export const FACE_EXPRESSION_IDS: readonly ["neutral","listening","thinking","speaking","curious","sleeping","alarmed","wake_spark","aha_eureka","confused","interrupted","wave_bye","happy_squint","laughing","wink","love_eyes","shy_blush","starry_eyed","smug_proud","kitty_playful","touched_warm","kissy","excited_bounce","zen_content","pouty","sad_droop","teary_cry","grumpy_puff","angry_glare","speechless","side_eye","shocked","dizzy_spiral","nervous_sweat","mischievous","relieved_sigh","sleepy_drowsy","yawning","deep_snore","coffee_sip","munching","sipping_straw","music_vibe","focus_glasses","reading_scan","pomodoro_timer","celebrate_party","bored_sigh","coding_terminal","searching_radar","approval_ask","task_verified","task_warning","memory_recall","memory_saved","sync_pulse","privacy_shield","rate_limited","offline_lost","night_watch","dock_snap","undock_float","drive_forward","turn_peek","head_up_sky","head_down_floor","charging_pulse","low_battery","fill_light_glow","home_command","weather_sunny","weather_rain_chill"];
export type CanonicalFaceExpression = (typeof FACE_EXPRESSION_IDS)[number];
export type PluginFaceExpressionId = \`plugin:\${string}:\${string}\`;
export type FaceExpression = CanonicalFaceExpression | PluginFaceExpressionId;
export const FACE_PRIORITY: {readonly SYSTEM_CRITICAL:0;readonly DOCK_TRANSIENT:1;readonly PLUGIN_FOREGROUND:2;readonly CONVERSATIONAL:3;readonly PLUGIN_BACKGROUND:4;readonly DEFAULT_IDLE:5};
export type FacePriorityLevel = 0|1|2|3|4|5;
export interface FaceLayerLease {setExpression(expression:FaceExpression|null):void;setGaze(gaze:{x:number;y:number}|null):void;triggerBlink():void;release():void}
export function isFaceExpression(value:unknown):value is FaceExpression;
export function getFaceExpressionBehavior(expression:FaceExpression):{closedRest:boolean;allowsBlink:boolean;allowsAudioResonance:boolean};
export interface FaceState {expression:FaceExpression;gaze:{x:number;y:number};blinkProgress:number;waveformBars:number[]}
export class RobotFaceController {
 constructor(options?:{onStateChange?:()=>void});getState():FaceState;attachRecipeSyncBridge(bridge:((id:PluginFaceExpressionId,recipe:Record<string,unknown>|null)=>void)|undefined):void;registerDynamicExpression(id:PluginFaceExpressionId,recipe:Record<string,unknown>,behavior?:Partial<{closedRest:boolean;allowsBlink:boolean;allowsAudioResonance:boolean}>):()=>void;acquireLayerLease(priority:FacePriorityLevel,initial?:{expression?:FaceExpression|null;gaze?:{x:number;y:number}|null}):FaceLayerLease;setHostPresence(presence:{systemCritical?:FaceExpression|null;dockTransient?:FaceExpression|null;conversational?:FaceExpression|null;idle?:FaceExpression}):void;setExpression(value:FaceExpression):void;setGaze(x:number,y:number):void;updateAudioLevel(rms:number):void;triggerBlink():void;dispose():void;
}
export function verifyEd25519Signature(message:Uint8Array,signature:Uint8Array,publicKey32:Uint8Array):boolean;
export function verifyNshPackage(rawArchive:string|Uint8Array|{readonly format:"nshpkg-v1";readonly manifest:PluginManifest;readonly runtimeEntry:string;readonly uiEntry?:string;readonly sha256:string;readonly keyId:string;readonly signature:string},options:{readonly trustedKeys:Readonly<Record<string,string|Uint8Array>>;readonly hostApiVersion?:number}):{readonly manifest:PluginManifest;readonly runtimeEntry:string;readonly uiEntry?:string;readonly sha256:string;readonly keyId:string};
export function openRuntime(host:{request(raw:string):string;begin(kind:string,raw:string):string;wait(ticket:string):Promise<string>;close():void},vault:{get(key:string):string;set(key:string,value:string):void;remove(key:string):void}):Promise<NativeRuntime>;
`,
  );
  if (compiler) await compiler.watch();
  return compiler;
}
