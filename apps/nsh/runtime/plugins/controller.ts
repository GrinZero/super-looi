import type { DatabaseSync } from "node:sqlite";
import type { UserActionRef } from "@super-looi/contracts";
import type { LangfuseTracer, TraceContext } from "../../../../packages/looi-runtime/src/telemetry/langfuse.js";
import type { RobotFaceController } from "../../../../packages/looi-runtime/src/ui/robot-face-controller.js";
import { createBuiltinPluginDefinitions } from "../../plugins/registry.js";
import type { BodyRuntime } from "../body.js";
import {
  VisionBroker,
  type NativeDeviceCameraPort,
  type VisionBrokerAttachOptions,
} from "../device-camera.js";
import {
  MotionBroker,
  type MotionBrokerAttachOptions,
  type NativeDeviceMotionPort,
} from "../device-motion.js";
import {
  LanRoomBroker,
  createLanRoomCapability,
  type NativeLanRoomPort,
} from "../lan-room.js";
import type { DualLoopAiBusBridge } from "./ai-bus.js";
import type { PluginDefinition, PluginEvent, PluginTaskContext } from "./contracts.js";
import {
  FaceDriverHub,
  createBodyCapability,
  createMotionCapability,
  createVisionCapability,
} from "./embodied-drivers.js";
import { PluginHost } from "./host.js";
import type {
  NshPackageEnvelope,
  VerifiedNshPackage,
  VerifyNshPackageOptions,
} from "./package-loader.js";
import type { UiActionGuard } from "../vault.js";

/**
 * Coordinates the plugin microkernel (`PluginHost`) and the embodied hardware brokers
 * (`FaceDriverHub`, `VisionBroker`, `MotionBroker`, `LanRoomBroker`) that serve plugin capabilities.
 */
export class PluginController {
  readonly host: PluginHost;
  private readonly faceHub = new FaceDriverHub();
  private readonly visionBroker = new VisionBroker();
  private readonly motionBroker = new MotionBroker();
  private readonly lanRoomBroker = new LanRoomBroker();

  constructor(
    private readonly options: {
      database: DatabaseSync;
      body: BodyRuntime;
      tracer: LangfuseTracer;
      traceContext: () => TraceContext | undefined;
      runBackgroundTask: (options: {
        pluginId: string;
        prompt: string;
      }) => Promise<{ readonly taskId: string; readonly answer: string }>;
      assertUiAction: UiActionGuard;
      isClosed: () => boolean;
    },
  ) {
    this.host = new PluginHost(
      options.database,
      createBuiltinPluginDefinitions({
        codex: {
          tracer: options.tracer,
          traceContext: options.traceContext,
        },
      }),
      {
        createFaceCapability: (manifest, scope) =>
          this.faceHub.createCapability(manifest, scope),
        createBodyCapability: (manifest, scope) =>
          createBodyCapability(manifest, scope, options.body),
        createVisionCapability: (manifest, scope) =>
          createVisionCapability(manifest, scope, this.visionBroker),
        createMotionCapability: (manifest, scope) =>
          createMotionCapability(manifest, scope, this.motionBroker),
        createLanCapability: (manifest, scope) =>
          createLanRoomCapability(manifest, scope, this.lanRoomBroker),
        aiBridge: {
          runBackgroundTask: options.runBackgroundTask,
        },
      },
    );
  }

  get ai() {
    return this.host.ai;
  }

  contribution(context: PluginTaskContext) {
    return this.host.contribution(context);
  }

  snapshots() {
    return this.host.snapshots();
  }

  startStartupPlugins() {
    return this.host.startStartupPlugins();
  }

  activeStagePresentation() {
    return this.host.stage.activePresentation();
  }

  resumableStage() {
    return this.host.resumableStage();
  }

  resumeStage(id?: string) {
    return this.host.resumePluginStage(id);
  }

  setForegroundActive(active: boolean) {
    this.host.setForegroundActive(active);
  }

  exitStage(id: string) {
    this.host.stage.exitPluginStage(id);
  }

  reportStageCrash(
    id: string,
    slot: "StageCanvas" | "StageCompanion" | "StageCapsule" | "StageDrawer",
    error: unknown,
  ) {
    return this.host.reportStageCrash(id, slot, error);
  }

  installMarketplacePackage(
    rawArchive: string | Uint8Array | NshPackageEnvelope,
    verifyOptions: VerifyNshPackageOptions,
    createDefinition: (verified: VerifiedNshPackage) => PluginDefinition<any, any>,
    action: UserActionRef,
  ) {
    if (this.options.isClosed()) {
      throw new Error("@looi:runtimeLocalRuntimeIsNotReady");
    }
    this.options.assertUiAction(action);
    return this.host.installMarketplacePackage(
      rawArchive,
      verifyOptions,
      createDefinition,
    );
  }

  attachFaceController(controller: RobotFaceController | undefined) {
    this.faceHub.attachController(controller);
  }

  attachNativeDeviceCamera(
    port: NativeDeviceCameraPort | null,
    options?: VisionBrokerAttachOptions,
  ) {
    const effectiveOptions =
      options ??
      (process.env.LOOI_IOS_SIMULATOR === "1"
        ? { useSampleStream: true }
        : undefined);
    this.visionBroker.attachNativePort(port, effectiveOptions);
  }

  setDeviceCameraForegroundActive(active: boolean) {
    this.visionBroker.setForegroundActive(active);
  }

  attachNativeDeviceMotion(
    port: NativeDeviceMotionPort | null,
    options?: MotionBrokerAttachOptions,
  ) {
    const effectiveOptions =
      options ??
      (process.env.LOOI_IOS_SIMULATOR === "1"
        ? { useSampleStream: true }
        : undefined);
    this.motionBroker.attachNativePort(port, effectiveOptions);
  }

  setDeviceMotionForegroundActive(active: boolean) {
    this.motionBroker.setForegroundActive(active);
  }

  attachNativeLanRoom(port: NativeLanRoomPort | null) {
    this.lanRoomBroker.attachNativePort(port);
  }

  setLanRoomForegroundActive(active: boolean) {
    this.lanRoomBroker.setForegroundActive(active);
  }

  setAiBridge(bridge: DualLoopAiBusBridge) {
    this.host.ai.setBridge(bridge);
  }

  ambientVoiceContext() {
    return this.host.ai.renderAmbientInstructions();
  }

  voiceTools() {
    return this.host.ai.voiceTools();
  }

  evaluateVoiceToolCall(call: {
    toolName: string;
    arguments: Record<string, unknown>;
  }) {
    return this.host.ai.evaluateToolCall({
      channel: "voice",
      toolName: call.toolName,
      approvalMode: "ask",
      arguments: call.arguments,
    });
  }

  evaluateVoiceUserTurn(text: string) {
    return this.host.ai.evaluateUserTurn({ channel: "voice", text });
  }

  assembleVoiceTurn(text: string) {
    return this.host.ai.assembleTurn({ channel: "voice", userText: text });
  }

  subscribe(listener: (event: PluginEvent) => void) {
    return this.host.subscribe(listener);
  }

  async refresh(id: string) {
    await this.host.get(id).auth?.refresh();
    return this.host.snapshots();
  }

  async setEnabled(id: string, enabled: boolean, action: UserActionRef) {
    this.options.assertUiAction(action);
    return this.host.setEnabled(id, enabled);
  }

  async configure(
    id: string,
    enabled: boolean,
    values: Record<string, string>,
    action: UserActionRef,
  ) {
    this.options.assertUiAction(action);
    return this.host.configure(id, enabled, values);
  }

  async sendCommand<TCommand = unknown, TResult = unknown>(
    id: string,
    command: TCommand,
    action: UserActionRef,
  ): Promise<TResult> {
    this.options.assertUiAction(action);
    return this.host.sendCommand<TCommand, TResult>(id, command);
  }

  async beginLogin(id: string, action: UserActionRef) {
    this.options.assertUiAction(action);
    const auth = this.host.get(id).auth;
    if (!auth) throw new Error(`Plugin has no login: ${id}`);
    return auth.begin();
  }

  async cancelLogin(id: string) {
    await this.host.get(id).auth?.cancel();
  }

  async logout(id: string, action: UserActionRef) {
    this.options.assertUiAction(action);
    await this.host.get(id).auth?.logout();
  }

  deactivateBrokers(): void {
    this.faceHub.attachController(undefined);
    this.visionBroker.setForegroundActive(false);
    this.motionBroker.setForegroundActive(false);
    this.lanRoomBroker.setForegroundActive(false);
  }

  async close(): Promise<void> {
    try {
      await this.host.close();
    } finally {
      this.lanRoomBroker.close();
      this.visionBroker.close();
      this.motionBroker.close();
    }
  }
}
