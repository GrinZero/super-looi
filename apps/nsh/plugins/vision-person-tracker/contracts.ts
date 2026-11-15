import type { DetectedCameraFace } from "../../runtime/plugins/shared-types.js";

export type { DetectedCameraFace };

export const PERSON_TRACKER_SERVICE_ID = "vision.person-tracker" as const;

export type PersonTrackerDispose = () => void | Promise<void>;

export interface PersonTrackerScopeLike {
  readonly id: string;
  readonly active: boolean;
  onDispose(cleanup: PersonTrackerDispose): PersonTrackerDispose;
}

export interface SmoothedPersonTarget {
  readonly trackId: number;
  /** Smoothed horizontal center offset in landscape: -1.0 (left) .. 0.0 (center) .. +1.0 (right) */
  readonly offsetX: number;
  /** Smoothed vertical center offset in landscape: -1.0 (top) .. 0.0 (center) .. +1.0 (bottom) */
  readonly offsetY: number;
  readonly width: number;
  readonly height: number;
  readonly confidence: number;
  readonly rawOffsetX: number;
  readonly rawOffsetY: number;
}

export interface PersonTrackingFrame {
  readonly capturedAtMs: number;
  readonly width: number;
  readonly height: number;
  readonly faceCount: number;
  readonly primaryTarget: SmoothedPersonTarget | null;
  readonly faces: readonly DetectedCameraFace[];
}

export interface AcquirePersonTrackingOptions {
  readonly maxFps?: number;
  readonly smoothingAlpha?: number;
  readonly maxDimension?: 320 | 640;
}

export interface PersonTrackingSubscription {
  readonly previewSessionId: string;
  readonly release: PersonTrackerDispose;
}

export interface CapturedPersonPortrait {
  /** Memory-only JPEG thumbnail (`data:image/jpeg;base64,...`), never written to disk */
  readonly dataUri: string;
  readonly width: number;
  readonly height: number;
  readonly primaryTarget: SmoothedPersonTarget | null;
  readonly capturedAtMs: number;
}

export interface PersonTrackerService {
  permissionStatus(): "granted" | "denied" | "undetermined" | "unavailable";
  requestPermission(): Promise<"granted" | "denied" | "unavailable">;
  isStreaming(): boolean;
  latestFrame(): PersonTrackingFrame | null;
  acquireTracking(
    options: AcquirePersonTrackingOptions,
    listener: (frame: PersonTrackingFrame) => void,
    scope?: PersonTrackerScopeLike,
  ): Promise<PersonTrackingSubscription>;
  capturePortrait(options?: { readonly maxDimension?: 320 | 640 }): Promise<CapturedPersonPortrait>;
}

export type CompanionTrackingStatus =
  | "idle"
  | "searching"
  | "centered"
  | "turning_left"
  | "turning_right"
  | "preempted"
  | "yielded_to_consumer";

export type CompanionActuatorMode =
  | "idle"
  | "gaze_only"
  | "servo_and_gaze"
  | "preempted"
  | "yielded_to_consumer";

export interface VisionPersonTrackerState {
  readonly permission: "granted" | "denied" | "undetermined" | "unavailable";
  readonly streaming: boolean;
  readonly activeSubscribers: number;
  readonly previewSessionId: string | null;
  readonly calibrationPreviewOpen: boolean;
  readonly companionFollowEnabled: boolean;
  readonly trackingStatus: CompanionTrackingStatus;
  readonly actuatorMode: CompanionActuatorMode;
  readonly commandedTurn: number;
  readonly commandedPitchDegrees: number | null;
  readonly smoothingAlpha: number;
  readonly maxFps: number;
  readonly faceCount: number;
  readonly primaryTarget: SmoothedPersonTarget | null;
  readonly lastFrameAtMs: number | null;
  readonly lastPortrait: CapturedPersonPortrait | null;
  readonly lastError: string | null;
}

export type VisionPersonTrackerCommand =
  | { readonly type: "request_permission" }
  | { readonly type: "set_calibration_preview"; readonly open: boolean }
  | { readonly type: "set_companion_follow"; readonly enabled: boolean }
  | { readonly type: "capture_portrait" }
  | {
      readonly type: "update_settings";
      readonly smoothingAlpha?: number;
      readonly maxFps?: number;
    };
