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

export const PLUGIN_PERMISSIONS = [
  "face.control",
  "face.register",
  "body.motion",
  "camera.front",
  "camera.back",
  "ai.tools",
  "ai.context",
  "ai.intercept",
  "ai.proactive",
  "stage.ui",
  "linux.exec",
  "network.https",
  "network.lan_room",
] as const;

export type PluginPermission = (typeof PLUGIN_PERMISSIONS)[number];

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
  readonly activation?: "startup" | "on_demand";
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
  | {
      type: "stage_changed";
      pluginId: string | null;
      revision?: number;
      presentation: PluginStagePresentation | null;
    };

export type UserTurnBailResult =
  | undefined
  | {
      readonly decision: "block";
      readonly reason: string;
      readonly code?: string;
      readonly stage?: string;
      readonly spokenReply?: string;
      readonly cause?: unknown;
    }
  | {
      readonly decision: "handled";
      readonly spokenReply?: string;
      readonly answer?: string;
    };

export type ToolCallBailResult =
  | undefined
  | { readonly decision: "allow" }
  | { readonly decision: "ask"; readonly promptPayload: Record<string, unknown> }
  | {
      readonly decision: "deny";
      readonly code: string;
      readonly reason: string;
      readonly stage?: string;
      readonly cause?: unknown;
    };

export interface AiTurnDraft {
  readonly channel: "voice" | "task";
  readonly userText: string;
  readonly contextBlocks: Array<{ pluginId: string; priority: number; text: string }>;
  readonly ephemeralImages: Array<{ pluginId: string; mimeType: "image/jpeg"; bytes: Uint8Array }>;
}

export interface PluginVoiceTool<TParams = Record<string, unknown>> {
  readonly name: string;
  readonly description: string;
  readonly parametersJsonSchema: Record<string, unknown>;
  execute(params: TParams, context: { sessionId: string; signal: AbortSignal }): Promise<unknown>;
}

const VALID_FACE_TINTS = new Set(["warm", "ivory", "coral", "amber", "sage", "rose", "mist"]);
const VALID_EYE_SHAPES = new Set([
  "orb",
  "crescent_up",
  "crescent_down",
  "line",
  "chevron",
  "heart",
  "star4",
  "spiral",
]);
const VALID_MOUTH_KINDS = new Set([
  "none",
  "smile",
  "wide_smile",
  "open_d",
  "smirk",
  "flat",
  "dot",
  "circle_o",
  "oval_yawn",
  "pout",
  "pout_puff",
  "wavy",
  "cat_w",
  "caret",
  "kiss_3",
  "mute_x",
  "dots_3",
]);
const VALID_FACE_GLYPHS = new Set([
  "spark_exclaim",
  "star_sparkle",
  "forehead_star",
  "question",
  "blush",
  "heart_float",
  "teardrop",
  "corner_tear",
  "gloom_lines",
  "sweat_drop",
  "sigh_puff",
  "zzz",
  "coffee_cup",
  "chew_cheeks",
  "straw_cup",
  "music_notes",
  "glasses",
  "scan_trails",
  "timer_clock",
  "confetti",
  "terminal_prompt",
  "magnifier",
  "checkmark",
  "warning_bang",
  "memory_dots",
  "hourglass",
  "offline_wave",
  "lightning",
  "wifi_arcs",
  "sun_rays",
  "raindrops",
]);

function isFiniteInRange(value: unknown, min: number, max: number): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

/**
 * Single shared validator for dynamic plugin face recipes across runtime and UI realms.
 * Returns `null` when valid, or a descriptive validation failure reason.
 */
export function validateDynamicFaceRecipeIssue(
  id: string,
  rawRecipe: unknown,
): string | null {
  if (!rawRecipe || typeof rawRecipe !== "object") {
    return `Expression "${id}" recipe must be an object`;
  }
  const recipe = rawRecipe as Record<string, unknown>;
  if (recipe.tint !== undefined && (typeof recipe.tint !== "string" || !VALID_FACE_TINTS.has(recipe.tint))) {
    return `Expression "${id}" uses unsupported tint "${String(recipe.tint)}"`;
  }
  if (recipe.ambientOpacity !== undefined && !isFiniteInRange(recipe.ambientOpacity, 0, 1)) {
    return `Expression "${id}" ambientOpacity must be a finite number in [0, 1]`;
  }
  if (recipe.allowsBreath !== undefined && typeof recipe.allowsBreath !== "boolean") {
    return `Expression "${id}" allowsBreath must be boolean`;
  }
  const eyes = recipe.eyes;
  if (!Array.isArray(eyes) || eyes.length !== 2) {
    return `Expression "${id}" must define exactly 2 eyes`;
  }
  for (const eye of eyes) {
    if (!eye || typeof eye !== "object") {
      return `Expression "${id}" contains an invalid eye spec`;
    }
    const e = eye as Record<string, unknown>;
    if (e.shape !== undefined && (typeof e.shape !== "string" || !VALID_EYE_SHAPES.has(e.shape))) {
      return `Expression "${id}" uses unsupported eye shape "${String(e.shape)}"`;
    }
    if (e.scale !== undefined && !isFiniteInRange(e.scale, 0.1, 3)) {
      return `Expression "${id}" eye.scale must be a finite number in [0.1, 3]`;
    }
    if (e.dx !== undefined && !isFiniteInRange(e.dx, -200, 200)) {
      return `Expression "${id}" eye.dx must be a finite number in [-200, 200]`;
    }
    if (e.dy !== undefined && !isFiniteInRange(e.dy, -200, 200)) {
      return `Expression "${id}" eye.dy must be a finite number in [-200, 200]`;
    }
    if (e.opacity !== undefined && !isFiniteInRange(e.opacity, 0, 1)) {
      return `Expression "${id}" eye.opacity must be a finite number in [0, 1]`;
    }
    if (
      e.rippleRings !== undefined &&
      (typeof e.rippleRings !== "number" ||
        !Number.isInteger(e.rippleRings) ||
        e.rippleRings < 0 ||
        e.rippleRings > 6)
    ) {
      return `Expression "${id}" eye.rippleRings must be an integer in [0, 6]`;
    }
    if (e.eyelid !== undefined) {
      if (!e.eyelid || typeof e.eyelid !== "object") {
        return `Expression "${id}" eye.eyelid must be an object`;
      }
      const lid = e.eyelid as Record<string, unknown>;
      if (lid.top !== undefined && !isFiniteInRange(lid.top, 0, 0.95)) {
        return `Expression "${id}" eye.eyelid.top must be in [0, 0.95]`;
      }
      if (lid.bottom !== undefined && !isFiniteInRange(lid.bottom, 0, 0.95)) {
        return `Expression "${id}" eye.eyelid.bottom must be in [0, 0.95]`;
      }
      if (lid.angleDeg !== undefined && !isFiniteInRange(lid.angleDeg, -360, 360)) {
        return `Expression "${id}" eye.eyelid.angleDeg must be in [-360, 360]`;
      }
    }
    if (e.brow !== undefined) {
      if (!e.brow || typeof e.brow !== "object") {
        return `Expression "${id}" eye.brow must be an object`;
      }
      const brow = e.brow as Record<string, unknown>;
      if (!isFiniteInRange(brow.angleDeg, -360, 360)) {
        return `Expression "${id}" eye.brow.angleDeg must be a finite number in [-360, 360]`;
      }
      if (brow.lift !== undefined && !isFiniteInRange(brow.lift, -100, 100)) {
        return `Expression "${id}" eye.brow.lift must be in [-100, 100]`;
      }
      if (brow.span !== undefined && !isFiniteInRange(brow.span, 0.1, 3)) {
        return `Expression "${id}" eye.brow.span must be in [0.1, 3]`;
      }
    }
  }
  const mouth = recipe.mouth;
  if (!mouth || typeof mouth !== "object") {
    return `Expression "${id}" must define a valid mouth spec`;
  }
  const m = mouth as Record<string, unknown>;
  if (typeof m.kind !== "string" || !VALID_MOUTH_KINDS.has(m.kind)) {
    return `Expression "${id}" must define a valid mouth kind`;
  }
  if (m.dx !== undefined && !isFiniteInRange(m.dx, -200, 200)) {
    return `Expression "${id}" mouth.dx must be in [-200, 200]`;
  }
  if (m.dy !== undefined && !isFiniteInRange(m.dy, -200, 200)) {
    return `Expression "${id}" mouth.dy must be in [-200, 200]`;
  }
  if (m.scale !== undefined && !isFiniteInRange(m.scale, 0.1, 3)) {
    return `Expression "${id}" mouth.scale must be in [0.1, 3]`;
  }
  if (m.tiltDeg !== undefined && !isFiniteInRange(m.tiltDeg, -360, 360)) {
    return `Expression "${id}" mouth.tiltDeg must be in [-360, 360]`;
  }
  if (m.opacity !== undefined && !isFiniteInRange(m.opacity, 0, 1)) {
    return `Expression "${id}" mouth.opacity must be in [0, 1]`;
  }
  if (recipe.glyphs !== undefined) {
    if (!Array.isArray(recipe.glyphs) || recipe.glyphs.length > 8) {
      return `Expression "${id}" glyphs must be an array of at most 8 items`;
    }
    for (const glyph of recipe.glyphs) {
      if (typeof glyph !== "string" || !VALID_FACE_GLYPHS.has(glyph)) {
        return `Expression "${id}" uses unsupported glyph "${String(glyph)}"`;
      }
    }
  }
  return null;
}

export interface DetectedCameraFace {
  readonly trackId: number;
  /** Landscape horizontal center offset: -1.0 (leftmost) .. 0.0 (center) .. +1.0 (rightmost) */
  readonly offsetX: number;
  /** Landscape vertical center offset: -1.0 (topmost) .. 0.0 (center) .. +1.0 (bottommost) */
  readonly offsetY: number;
  readonly width: number;
  readonly height: number;
  readonly confidence: number;
}

export interface NativeDeviceCameraFrame {
  readonly jpeg: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly facing: string;
  readonly capturedAtMs: number;
  readonly seq: number;
  readonly faces?: readonly DetectedCameraFace[];
}

export interface NativeDeviceCameraPort {
  permission(): string;
  requestPermission(): Promise<string>;
  openSession(
    facing: string,
    maxDimension: number,
    maxFps: number,
    sessionId: string,
  ): Promise<string>;
  openSample?(
    facing: string,
    maxDimension: number,
    maxFps: number,
    sessionId: string,
  ): Promise<string>;
  reconfigureSession(sessionId: string, maxDimension: number, maxFps: number): void;
  status(sessionId: string): string;
  captureFrame(
    sessionId: string,
    maxDimension: number,
    afterSeq: number,
  ): Promise<NativeDeviceCameraFrame>;
  closeSession(sessionId: string): void;
  setForeground(active: boolean): void;
  stopAll(): void;
  dispose?(): void;
}

export interface VisionBrokerAttachOptions {
  readonly useSampleStream?: boolean;
}

export interface LanHttpRequest {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly query: Record<string, string>;
  readonly headers: Record<string, string>;
  readonly bodyText: string;
  readonly remoteAddr: string;
}

export interface LanHttpResponse {
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
  readonly cacheControl?: string;
}

export interface LanRoomSession {
  readonly roomId: string;
  readonly port: number;
  /** Reachable LAN root URL, e.g. "http://192.168.31.88:54120" */
  readonly baseUrl: string;
  readonly lanIpv4: string | null;
  /** Broadcasts a state revision bump, immediately waking `/api/wait?sinceRev=` long-polls */
  notifyRevision(revision: number): void;
  refreshAddresses(): { readonly lanIpv4: string | null; readonly baseUrl: string };
  close(): Promise<void>;
}

export interface NativeLanRoomInfo {
  readonly roomId: string;
  readonly port: number;
  readonly lanIpv4: string;
  readonly baseUrl: string;
}

export interface NativeLanHttpRequest {
  readonly requestId: string;
  readonly method: string;
  readonly path: string;
  readonly queryJson: string;
  readonly headersJson: string;
  readonly bodyText: string;
  readonly remoteAddr: string;
}

export interface NativeLanRoomPort {
  openRoom(requestedId: string): Promise<NativeLanRoomInfo>;
  nextRequest(roomId: string): Promise<NativeLanHttpRequest>;
  respondRequest(
    roomId: string,
    requestId: string,
    status: number,
    contentType: string,
    cacheControl: string,
    body: string,
  ): void;
  notifyRevision(roomId: string, revision: number): void;
  refreshAddresses(roomId: string): NativeLanRoomInfo;
  closeRoom(roomId: string): void;
  setForeground(active: boolean): void;
  stopAll(): void;
  dispose?(): void;
}
