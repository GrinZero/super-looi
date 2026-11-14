import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { FaceExpression } from "../../../../packages/looi-runtime/src/ui/robot-face-controller.js";
import type { BodyActionReceipt, BodyControlInput, BodyStatusSnapshot } from "../body.js";
import {
  HOST_PLUGIN_API_VERSION,
  PLUGIN_CATEGORIES,
  PLUGIN_PERMISSIONS,
  type AiTurnDraft,
  type CliReceipt,
  type FaceStagePosture,
  type LocalizedText,
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
  type FaceStagePosture,
  type LocalizedText,
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
}

export interface PluginStageCapability {
  usePresentation(presentation: PluginStagePresentation, scope?: EffectScope): Dispose;
  currentPresentation(): PluginStagePresentation | null;
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
}

export interface DeviceCameraFrame {
  readonly jpeg: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly facing: "front" | "back";
  readonly capturedAtMs: number;
}

export interface PluginVisionCapability {
  permissionStatus(): "granted" | "denied" | "undetermined" | "unavailable";
  requestPermission(): Promise<"granted" | "denied" | "unavailable">;
  captureFrame(options: { facing: "front" | "back"; maxDimension?: 320 | 640 | 1280 }): Promise<DeviceCameraFrame>;
  subscribeFrames(
    options: { facing: "front" | "back"; maxDimension?: 320 | 640 | 1280; maxFps?: number; scope?: EffectScope },
    onFrame: (frame: DeviceCameraFrame) => Promise<void> | void,
  ): Promise<{ readonly previewSessionId: string; close(): void }>;
}

export interface PluginAiCapability {
  useContextSlice(
    slice: { readonly summary: string; readonly priority?: number },
    scope?: EffectScope,
  ): Dispose;
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
  speak(options: {
    spokenText: string;
    contextNote?: string;
    delivery?: "when_idle" | "interrupt";
  }): Promise<{ readonly completed: boolean; readonly interruptedReason?: string }>;
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
