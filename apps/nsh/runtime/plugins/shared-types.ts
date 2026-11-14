export type PluginCategory =
  | "productivity"
  | "vision_motion"
  | "games_social"
  | "persona_expression"
  | "smart_space"
  | "utilities";

export const PLUGIN_CATEGORIES: readonly PluginCategory[] = [
  "productivity",
  "vision_motion",
  "games_social",
  "persona_expression",
  "smart_space",
  "utilities",
] as const;

export type PluginPermission =
  | "face.control"
  | "face.register"
  | "body.motion"
  | "camera.front"
  | "camera.back"
  | "ai.tools"
  | "ai.context"
  | "ai.intercept"
  | "ai.proactive"
  | "stage.ui"
  | "linux.exec"
  | "network.https";

export type PluginServiceId = `${string}.${string}`;

export interface LocalizedText {
  readonly "zh-CN": string;
  readonly "en-US": string;
}

export interface PluginServiceDescriptor {
  readonly id: PluginServiceId;
  readonly version: string;
  readonly summary?: LocalizedText;
}

export interface PluginServiceDependency {
  readonly service: PluginServiceId;
  readonly versionRange: string;
  readonly optional?: boolean;
}

export const HOST_PLUGIN_API_VERSION = 2;

export interface PluginManifest {
  readonly id: string;
  readonly version: string;
  readonly minHostApiVersion: number;
  readonly category: PluginCategory;
  readonly icon: string;
  readonly name: LocalizedText;
  readonly summary: LocalizedText;
  readonly author: { readonly name: string; readonly verified?: boolean };
  readonly permissions: readonly PluginPermission[];
  readonly provides?: readonly PluginServiceDescriptor[];
  readonly dependencies?: readonly PluginServiceDependency[];
  readonly marketplace?: {
    readonly packageUrl?: string;
    readonly changelog?: LocalizedText;
  };
}

export interface PluginFailure {
  stage: string;
  code?: string | number;
  reason: string;
}

export interface CliReceipt {
  id: string;
  stage: string;
  args: string[];
  state:
    | "not_started"
    | "exited"
    | "start_failed"
    | "execution_failed"
    | "cancelled"
    | "timed_out"
    | "stop_unconfirmed";
  exitCode: number | null;
  signal?: string;
  stdout: string;
  stderr: string;
  outputFiles?: { stdout: string; stderr: string };
  failure?: PluginFailure;
}

export type PluginLifecycleState =
  | "registered"
  | "waiting_dependency"
  | "starting"
  | "active"
  | "stopping"
  | "stopped"
  | "failed";

export interface PluginDependencyStatus {
  readonly service: PluginServiceId;
  readonly versionRange: string;
  readonly optional: boolean;
  readonly providerPluginId?: string;
  readonly providerName?: LocalizedText;
  readonly satisfied: boolean;
  readonly reason?: string;
}

export interface PluginAuthSnapshot {
  state: "signed_out" | "authorizing" | "signed_in" | "reauth_required" | "unavailable";
  sessionId?: string;
  accountLabel?: string;
  url?: string;
}

export type FaceStagePosture =
  | { readonly kind: "full" }
  | {
      readonly kind: "floating_top";
      readonly scale?: number;
      readonly chrome?: "pill" | "frameless";
    }
  | {
      readonly kind: "docked_corner";
      readonly corner: "top_left" | "top_right";
      readonly scale?: number;
    }
  | {
      readonly kind: "split_left";
      readonly widthRatio?: number;
    }
  | { readonly kind: "minimized_pill" };

export type StageDrawerDetent = "closed" | "peek" | "medium" | "large";

export interface PluginStagePresentation {
  readonly active: boolean;
  readonly facePosture: FaceStagePosture;
  readonly drawerDetent: StageDrawerDetent;
  readonly allowUserSwipeCollapse?: boolean;
  readonly hideDefaultDock?: boolean;
}

export interface PluginSnapshot<TState = Record<string, unknown>> {
  id: string;
  manifest: PluginManifest;
  name: string;
  description: string;
  category: PluginCategory;
  /** Strictly the plugin package SemVer from manifest.version */
  version: string;
  enabled: boolean;
  lifecycle: PluginLifecycleState;
  /** Plugin-defined serializable business state projected to Dual-Realm TSX views */
  state: TState;
  /** Key-value string view preserved for lightweight configuration consumers */
  configuration: Record<string, string>;
  dependencies: PluginDependencyStatus[];
  auth?: PluginAuthSnapshot;
  lastExecution?: CliReceipt;
  lastError?: PluginFailure;
  stagePresentation?: PluginStagePresentation;
}

export type PluginEvent =
  | { type: "state_changed"; pluginId: string; snapshot: PluginSnapshot<any> }
  | { type: "auth_challenge"; pluginId: string; sessionId: string; url: string }
  | { type: "execution_output"; pluginId: string; callId: string; stream: "stdout" | "stderr"; text: string }
  | { type: "execution_finished"; pluginId: string; receipt: CliReceipt }
  | { type: "stage_changed"; pluginId: string | null; presentation: PluginStagePresentation | null };
