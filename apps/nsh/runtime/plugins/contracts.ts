import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { FaceExpression } from "@super-looi/runtime/face";
import type { BodyActionReceipt, BodyControlInput, BodyStatusSnapshot } from "../body.js";
import type {
  BodyCliffState,
  BodySensorPacket,
  NativeDeviceMotionSample,
} from "./shared-types.js";
export type {
  BodyCliffState,
  BodySensorPacket,
  NativeCroppedPortrait,
  NativeDeviceCameraFacesFrame,
  NativeDeviceMotionPort,
  NativeDeviceMotionSample,
  MotionBrokerAttachOptions,
} from "./shared-types.js";
import {
  HOST_PLUGIN_API_VERSION,
  PLUGIN_CATEGORIES,
  PLUGIN_PERMISSIONS,
  type AiTurnDraft,
  type CliReceipt,
  type DetectedCameraFace,
  type FaceStagePosture,
  type LanHttpRequest,
  type LanHttpResponse,
  type LanRoomSession,
  type LocalizedText,
  type NativeLanHttpRequest,
  type NativeLanRoomInfo,
  type NativeLanRoomPort,
  type PluginAuthSnapshot,
  type PluginCategory,
  type PluginDependencyStatus,
  type PluginEvent,
  type PluginFailure,
  type PluginLifecycleState,
  type PluginManifest,
  type PluginPermission,
  type PluginServiceDependency,
  type PluginServiceDescriptor,
  type PluginServiceId,
  type PluginSnapshot,
  type PluginStagePresentation,
  type PluginVoiceTool,
  type ResumableStageView,
  type StageDrawerDetent,
  type ToolCallBailResult,
  type UserTurnBailResult,
} from "./shared-types.js";

export {
  HOST_PLUGIN_API_VERSION,
  PLUGIN_CATEGORIES,
  PLUGIN_PERMISSIONS,
  type AiTurnDraft,
  type CliReceipt,
  type DetectedCameraFace,
  type FaceStagePosture,
  type LanHttpRequest,
  type LanHttpResponse,
  type LanRoomSession,
  type LocalizedText,
  type NativeLanHttpRequest,
  type NativeLanRoomInfo,
  type NativeLanRoomPort,
  type PluginAuthSnapshot,
  type PluginCategory,
  type PluginDependencyStatus,
  type PluginEvent,
  type PluginFailure,
  type PluginLifecycleState,
  type PluginManifest,
  type PluginPermission,
  type PluginServiceDependency,
  type PluginServiceDescriptor,
  type PluginServiceId,
  type PluginSnapshot,
  type PluginStagePresentation,
  type PluginVoiceTool,
  type ResumableStageView,
  type StageDrawerDetent,
  type ToolCallBailResult,
  type UserTurnBailResult,
};

export type Dispose = () => void | Promise<void>;

export interface EffectScope {
  readonly id: string;
  readonly active: boolean;
  onDispose(cleanup: Dispose): Dispose;
  fork(label?: string): EffectScope;
  dispose(): Promise<void>;
}

export interface PluginServiceRegistry {
  provide<TService extends object>(
    serviceId: PluginServiceId,
    implementation: TService,
    scope?: EffectScope,
  ): Dispose;
  get<TService extends object>(serviceId: PluginServiceId): TService;
  whenAvailable<TService extends object>(
    serviceId: PluginServiceId,
    callback: (service: TService, depScope: EffectScope) => void | Promise<void>,
    scope?: EffectScope,
  ): Dispose;
}

export interface PluginStorage {
  get<T = unknown>(key: string): T | undefined;
  set<T = unknown>(key: string, value: T): void;
  delete(key: string): void;
  entries(): Record<string, unknown>;
}

export interface PluginTaskContext {
  taskId: string;
  workspaceRoot: string;
  approvalMode: "ask" | "local_auto" | "yolo";
  commandTimeoutMs: number;
  scheduleExecutionPolicy?: "check_only" | "authorized_action";
}

export interface ResumableStageSessionInput {
  readonly title: string;
  readonly subtitle?: string;
  readonly badgeText?: string;
  readonly onResume: () => Promise<void> | void;
}

export interface PluginStageCapability {
  usePresentation(presentation: PluginStagePresentation, scope?: EffectScope): Dispose;
  currentPresentation(): PluginStagePresentation | null;
  onHostExit(listener: () => void, scope?: EffectScope): Dispose;
  setResumableSession(session: ResumableStageSessionInput | null): void;
}

export type ScopedExpressionId = `plugin:${string}:${string}`;

export type FacePriorityLayer = "foreground_stage" | "background_ambient";

export interface FaceLease {
  setExpression(expression: FaceExpression | ScopedExpressionId | null): void;
  setGaze(gaze: { x: number; y: number } | null): void;
  triggerBlink(): void;
  release(): void;
}

export interface PluginFaceCapability {
  registerExpression(
    localId: string,
    recipe: Record<string, unknown>,
    options?: {
      closedRest?: boolean;
      allowsBlink?: boolean;
      allowsAudioResonance?: boolean;
      scope?: EffectScope;
    },
  ): ScopedExpressionId;
  acquireLease(layer: FacePriorityLayer, scope?: EffectScope): FaceLease;
}

export interface BodyServoLease {
  setDriveVector(speed: number, turn: number): Promise<void>;
  setHeadDegrees(degrees: number): Promise<void>;
  setLight(on: boolean, brightness?: number): Promise<void>;
  onPreempted(
    listener: (reason: "user_stop" | "user_panel" | "voice_command" | "undocked" | "higher_plugin") => void,
  ): Dispose;
  release(): Promise<void>;
}

export interface PluginBodyCapability {
  status(): BodyStatusSnapshot;
  subscribeStatus(listener: (status: BodyStatusSnapshot) => void, scope?: EffectScope): Dispose;
  pulse(input: BodyControlInput): Promise<BodyActionReceipt>;
  acquireServo(
    priority: "foreground_stage" | "background_companion",
    scope?: EffectScope,
  ): Promise<BodyServoLease>;
  latestCliffState?(): BodyCliffState | null;
  recentSensorPackets?(): readonly BodySensorPacket[];
  subscribeSensorPackets?(
    listener: (packet: BodySensorPacket) => void,
    scope?: EffectScope,
  ): Dispose;
}

export interface DeviceCameraFrame {
  readonly jpeg: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly facing: "front" | "back";
  readonly capturedAtMs: number;
  readonly capturedMonotonicMs?: number;
  readonly facesMonotonicMs?: number;
  readonly hfovDeg?: number;
  readonly faces: readonly DetectedCameraFace[];
}

export interface DeviceCameraFacesFrame {
  readonly width: number;
  readonly height: number;
  readonly facing: "front" | "back";
  readonly capturedAtMs: number;
  readonly capturedMonotonicMs?: number;
  readonly facesMonotonicMs?: number;
  readonly hfovDeg?: number;
  readonly faces: readonly DetectedCameraFace[];
}

export interface CroppedPortraitOptions {
  readonly facing: "front" | "back";
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly portraitId?: string;
  readonly maxDimension?: number;
  readonly jpegQuality?: number;
}

export interface CroppedPortraitResult {
  readonly uri: string;
  readonly portraitId: string;
  readonly width: number;
  readonly height: number;
  readonly byteLength: number;
  readonly capturedMonotonicMs?: number;
}

export interface PluginLanRoomCapability {
  openRoom(options: {
    scope?: EffectScope;
    preferredPort?: number;
    onRequest: (req: LanHttpRequest) => Promise<LanHttpResponse> | LanHttpResponse;
  }): Promise<LanRoomSession>;
}

export interface PluginVisionCapability {
  permissionStatus(): "granted" | "denied" | "undetermined" | "unavailable";
  requestPermission(): Promise<"granted" | "denied" | "unavailable">;
  captureFrame(options: { facing: "front" | "back"; maxDimension?: 320 | 640 | 1280 }): Promise<DeviceCameraFrame>;
  captureFaces?(options: { facing: "front" | "back"; maxDimension?: 320 | 640 | 1280 }): Promise<DeviceCameraFacesFrame>;
  subscribeFrames(
    options: { facing: "front" | "back"; maxDimension?: 320 | 640 | 1280; maxFps?: number; includeJpeg?: true; scope?: EffectScope },
    onFrame: (frame: DeviceCameraFrame) => Promise<void> | void,
  ): Promise<{ readonly previewSessionId: string; close(): void }>;
  subscribeFrames(
    options: { facing: "front" | "back"; maxDimension?: 320 | 640 | 1280; maxFps?: number; includeJpeg: false; scope?: EffectScope },
    onFrame: (frame: DeviceCameraFacesFrame) => Promise<void> | void,
  ): Promise<{ readonly previewSessionId: string; close(): void }>;
  captureCroppedPortrait?(options: CroppedPortraitOptions): Promise<CroppedPortraitResult>;
  deletePortrait?(portraitIdOrUri: string): boolean;
  cameraHfovDeg?(facing: "front" | "back"): number | null;
}

export type DeviceMotionSample = NativeDeviceMotionSample;

export interface PluginMotionCapability {
  availability(): "available" | "unavailable";
  latestSample(): DeviceMotionSample | null;
  resetHeading(headingDeg?: number): DeviceMotionSample | null;
  subscribeHeading(
    options: { rateHz?: number; scope?: EffectScope },
    onSample: (sample: DeviceMotionSample) => Promise<void> | void,
  ): Promise<{ readonly sessionId: string; close(): void }>;
}

export interface PluginSpeakOptions {
  readonly spokenText: string;
  readonly contextNote?: string;
  readonly delivery?: "when_idle" | "interrupt";
  readonly capturePolicy?: "duplex" | "muted_broadcast";
  readonly verbatim?: boolean;
  readonly holdAliveMs?: number;
  readonly closeToStandbyOnComplete?: boolean;
  readonly signal?: AbortSignal;
}

export type PluginContextSlice = Dispose & {
  updateSummary(summary: string): void;
};

export interface PluginAiCapability {
  useContextSlice(
    slice: { readonly summary: string; readonly priority?: number },
    scope?: EffectScope,
  ): PluginContextSlice;
  usePersonaOverlay(
    overlay: { readonly mode: "append_rules" | "stage_persona"; readonly instructions: string },
    scope?: EffectScope,
  ): Dispose;
  useTurnAssembler(
    middleware: (
      draft: AiTurnDraft,
      signal: AbortSignal,
      next: (draft: AiTurnDraft) => Promise<AiTurnDraft>,
    ) => Promise<AiTurnDraft>,
    scope?: EffectScope,
  ): Dispose;
  interceptUserTurn(
    guard: (input: { channel: "voice" | "task"; text: string }) => Promise<UserTurnBailResult> | UserTurnBailResult,
    scope?: EffectScope,
  ): Dispose;
  interceptToolCall(
    guard: (call: {
      channel: "voice" | "task";
      toolName: string;
      approvalMode: string;
      arguments: Record<string, unknown>;
      scheduleExecutionPolicy?: "check_only" | "authorized_action";
    }) => Promise<ToolCallBailResult> | ToolCallBailResult,
    scope?: EffectScope,
  ): Dispose;
  useContribution(
    contribution: {
      voiceTools?: readonly PluginVoiceTool[];
      taskTools?: (context: PluginTaskContext) => readonly AgentTool<any>[];
      skillPaths?: readonly string[];
    },
    scope?: EffectScope,
  ): Dispose;
  speak(options: PluginSpeakOptions): Promise<{ readonly completed: boolean; readonly interruptedReason?: string }>;
  listenUntil(deadlineMs: number, signal: AbortSignal): Promise<void>;
  runBackgroundTask(prompt: string): Promise<{ readonly taskId: string; readonly answer: string }>;
}

export interface PluginContext<TState = Record<string, unknown>> {
  readonly manifest: PluginManifest;
  readonly scope: EffectScope;
  forkScope(label?: string): EffectScope;
  readonly services: PluginServiceRegistry;
  readonly storage: PluginStorage;

  enabled(): boolean;
  lifecycle(): PluginLifecycleState;
  ensureStarted(): Promise<void>;
  onAppForegroundChange(listener: (active: boolean) => void, scope?: EffectScope): Dispose;
  getState(): TState;
  setState(updater: TState | ((prev: TState) => TState)): void;

  getAuth(): PluginAuthSnapshot | undefined;
  setAuth(auth: PluginAuthSnapshot | undefined): void;
  getLastError(): PluginFailure | undefined;
  setLastExecution(receipt: CliReceipt | undefined): void;
  setLastError(failure: PluginFailure | undefined): void;
  markFailed(failure: PluginFailure): void;
  publish(event: Exclude<PluginEvent, { type: "state_changed" | "stage_changed" }>): void;

  readonly face?: PluginFaceCapability;
  readonly body?: PluginBodyCapability;
  readonly vision?: PluginVisionCapability;
  readonly motion?: PluginMotionCapability;
  readonly lan?: PluginLanRoomCapability;
  readonly ai?: PluginAiCapability;
  readonly stage?: PluginStageCapability;
}

export interface PluginRuntime<TCommand = unknown, TResult = unknown> {
  start(): Promise<void>;
  stop?(reason: "disabled" | "dependency_lost" | "app_shutdown"): Promise<void>;
  configure?(values: Record<string, string>): Promise<void>;
  handleCommand?(command: TCommand): Promise<TResult>;
  readonly auth?: {
    begin(): Promise<{ sessionId: string }>;
    cancel(): Promise<void>;
    logout(): Promise<void>;
    refresh(): Promise<void>;
  };
}

export interface PluginDefinition<TState = any, TCommand = any> {
  readonly manifest: PluginManifest;
  initialState(storage: PluginStorage): TState;
  migrate?(fromVersion: string, toVersion: string, storage: PluginStorage): Promise<void> | void;
  create(context: PluginContext<TState>): PluginRuntime<TCommand>;
}
