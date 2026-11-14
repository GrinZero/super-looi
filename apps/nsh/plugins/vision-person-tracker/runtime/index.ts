import type {
  DeviceCameraFrame,
  PluginContext,
  PluginDefinition,
  PluginFailure,
  PluginRuntime,
  PluginStorage,
} from "../../../runtime/plugins/contracts.js";
import {
  PERSON_TRACKER_SERVICE_ID,
  type AcquirePersonTrackingOptions,
  type CapturedPersonPortrait,
  type DetectedCameraFace,
  type PersonTrackerDispose,
  type PersonTrackerScopeLike,
  type PersonTrackerService,
  type PersonTrackingFrame,
  type PersonTrackingSubscription,
  type SmoothedPersonTarget,
  type VisionPersonTrackerCommand,
  type VisionPersonTrackerState,
} from "../contracts.js";
import { visionPersonTrackerManifest } from "../manifest.js";

export { PERSON_TRACKER_SERVICE_ID, visionPersonTrackerManifest };
export type {
  AcquirePersonTrackingOptions,
  CapturedPersonPortrait,
  DetectedCameraFace,
  PersonTrackerService,
  PersonTrackingFrame,
  PersonTrackingSubscription,
  SmoothedPersonTarget,
  VisionPersonTrackerCommand,
  VisionPersonTrackerState,
};

export interface VisionPersonTrackerPluginOptions {
  readonly defaultSmoothingAlpha?: number;
  readonly defaultMaxFps?: number;
}

const DEFAULT_SMOOTHING_ALPHA = 0.45;
const DEFAULT_MAX_FPS = 6;
const MIN_SMOOTHING_ALPHA = 0.1;
const MAX_SMOOTHING_ALPHA = 1.0;
const MIN_TRACKER_FPS = 1;
const MAX_TRACKER_FPS = 15;
const TRACK_CONTINUITY_WINDOW_MS = 1500;
const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function normalizeSmoothingAlpha(raw: unknown, fallback = DEFAULT_SMOOTHING_ALPHA): number {
  const parsed = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(parsed)) return clamp(fallback, MIN_SMOOTHING_ALPHA, MAX_SMOOTHING_ALPHA);
  return Math.round(clamp(parsed, MIN_SMOOTHING_ALPHA, MAX_SMOOTHING_ALPHA) * 100) / 100;
}

function normalizeMaxFps(raw: unknown, fallback = DEFAULT_MAX_FPS): number {
  const parsed = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(parsed)) return Math.round(clamp(fallback, MIN_TRACKER_FPS, MAX_TRACKER_FPS));
  return Math.round(clamp(parsed, MIN_TRACKER_FPS, MAX_TRACKER_FPS));
}

function normalizeMaxDimension(raw: number | undefined): 320 | 640 {
  return raw === 640 ? 640 : 320;
}

function sanitizeFaces(rawFaces: readonly DetectedCameraFace[] | undefined): DetectedCameraFace[] {
  if (!Array.isArray(rawFaces) || rawFaces.length === 0) return [];
  const valid: DetectedCameraFace[] = [];
  for (const item of rawFaces) {
    if (!item || typeof item !== "object") continue;
    if (
      !Number.isFinite(item.offsetX) ||
      !Number.isFinite(item.offsetY) ||
      !Number.isFinite(item.width) ||
      !Number.isFinite(item.height)
    ) {
      continue;
    }
    valid.push({
      trackId: Number.isFinite(item.trackId) ? Math.trunc(item.trackId) : 0,
      offsetX: clamp(item.offsetX, -1, 1),
      offsetY: clamp(item.offsetY, -1, 1),
      width: clamp(item.width, 0, 1),
      height: clamp(item.height, 0, 1),
      confidence: Number.isFinite(item.confidence) ? clamp(item.confidence, 0, 1) : 1,
    });
  }
  return valid;
}

/**
 * Pure RFC 4648 Base64 encoder for memory-only JPEG portrait thumbnails,
 * avoiding `String.fromCharCode(...largeArray)` call-stack limits in QuickJS.
 */
export function encodeJpegDataUri(jpegBytes: Uint8Array): string {
  const len = jpegBytes.length;
  const chunks: string[] = ["data:image/jpeg;base64,"];
  let i = 0;
  while (i + 2 < len) {
    const triple =
      ((jpegBytes[i]! & 0xff) << 16) |
      ((jpegBytes[i + 1]! & 0xff) << 8) |
      (jpegBytes[i + 2]! & 0xff);
    chunks.push(
      BASE64_ALPHABET[(triple >> 18) & 0x3f]! +
        BASE64_ALPHABET[(triple >> 12) & 0x3f]! +
        BASE64_ALPHABET[(triple >> 6) & 0x3f]! +
        BASE64_ALPHABET[triple & 0x3f]!,
    );
    i += 3;
  }
  const rem = len - i;
  if (rem === 1) {
    const byte0 = jpegBytes[i]! & 0xff;
    chunks.push(
      BASE64_ALPHABET[(byte0 >> 2) & 0x3f]! +
        BASE64_ALPHABET[(byte0 & 0x03) << 4]! +
        "==",
    );
  } else if (rem === 2) {
    const pair = ((jpegBytes[i]! & 0xff) << 8) | (jpegBytes[i + 1]! & 0xff);
    chunks.push(
      BASE64_ALPHABET[(pair >> 10) & 0x3f]! +
        BASE64_ALPHABET[(pair >> 4) & 0x3f]! +
        BASE64_ALPHABET[(pair & 0x0f) << 2]! +
        "=",
    );
  }
  return chunks.join("");
}

/**
 * Selects the dominant foreground face by combining bounding-box area,
 * proximity to frame center, confidence, and `trackId` continuity.
 */
export function selectPrimaryFace(
  faces: readonly DetectedCameraFace[],
  previous: { readonly trackId: number; readonly offsetX: number; readonly offsetY: number } | null,
): DetectedCameraFace | null {
  if (faces.length === 0) return null;
  let best: DetectedCameraFace | null = null;
  let bestScore = -Infinity;

  for (const face of faces) {
    const area = Math.max(0.0004, face.width * face.height);
    const centerDist = Math.min(1, Math.hypot(face.offsetX, face.offsetY) / Math.SQRT2);
    const centerWeight = 1 - 0.35 * centerDist;
    const confidenceWeight = 0.5 + 0.5 * clamp(face.confidence, 0, 1);

    let continuityWeight = 1.0;
    if (previous) {
      if (face.trackId > 0 && face.trackId === previous.trackId) {
        continuityWeight = 1.35;
      } else if (
        face.trackId <= 0 &&
        Math.hypot(face.offsetX - previous.offsetX, face.offsetY - previous.offsetY) < 0.35
      ) {
        continuityWeight = 1.2;
      }
    }

    const score = area * centerWeight * confidenceWeight * continuityWeight;
    if (score > bestScore) {
      bestScore = score;
      best = face;
    }
  }

  return best;
}

export class EmaTargetFilter {
  private state: {
    trackId: number;
    offsetX: number;
    offsetY: number;
    width: number;
    height: number;
    updatedAtMs: number;
  } | null = null;

  update(
    faces: readonly DetectedCameraFace[],
    capturedAtMs: number,
    smoothingAlpha: number,
  ): SmoothedPersonTarget | null {
    const alpha = clamp(smoothingAlpha, MIN_SMOOTHING_ALPHA, MAX_SMOOTHING_ALPHA);
    const selected = selectPrimaryFace(faces, this.state);
    if (!selected) {
      this.state = null;
      return null;
    }

    const prev = this.state;
    const withinWindow =
      prev !== null &&
      capturedAtMs - prev.updatedAtMs <= TRACK_CONTINUITY_WINDOW_MS;
    const sameTrackedSubject =
      withinWindow &&
      ((selected.trackId > 0 && selected.trackId === prev.trackId) ||
        (selected.trackId <= 0 &&
          prev.trackId <= 0 &&
          Math.hypot(selected.offsetX - prev.offsetX, selected.offsetY - prev.offsetY) < 0.65));

    if (!sameTrackedSubject || !prev) {
      this.state = {
        trackId: selected.trackId,
        offsetX: selected.offsetX,
        offsetY: selected.offsetY,
        width: selected.width,
        height: selected.height,
        updatedAtMs: capturedAtMs,
      };
    } else {
      this.state = {
        trackId: selected.trackId,
        offsetX: prev.offsetX + alpha * (selected.offsetX - prev.offsetX),
        offsetY: prev.offsetY + alpha * (selected.offsetY - prev.offsetY),
        width: prev.width + alpha * (selected.width - prev.width),
        height: prev.height + alpha * (selected.height - prev.height),
        updatedAtMs: capturedAtMs,
      };
    }

    return {
      trackId: selected.trackId,
      offsetX: Math.round(this.state.offsetX * 10000) / 10000,
      offsetY: Math.round(this.state.offsetY * 10000) / 10000,
      width: Math.round(this.state.width * 10000) / 10000,
      height: Math.round(this.state.height * 10000) / 10000,
      confidence: selected.confidence,
      rawOffsetX: selected.offsetX,
      rawOffsetY: selected.offsetY,
    };
  }

  reset(): void {
    this.state = null;
  }
}

function extractFailure(
  error: unknown,
  fallbackStage: string,
  fallbackCode: string,
): PluginFailure {
  if (error && typeof error === "object") {
    const rawStage = (error as { stage?: unknown }).stage;
    const rawCode = (error as { code?: unknown }).code;
    const rawReason = (error as { reason?: unknown }).reason;
    const message = error instanceof Error ? error.message : String(error);
    return {
      stage: typeof rawStage === "string" && rawStage.length > 0 ? rawStage : fallbackStage,
      code:
        typeof rawCode === "string" || typeof rawCode === "number" ? rawCode : fallbackCode,
      reason: typeof rawReason === "string" && rawReason.length > 0 ? rawReason : message,
    };
  }
  return {
    stage: fallbackStage,
    code: fallbackCode,
    reason: String(error),
  };
}

function formatFailureMessage(failure: PluginFailure): string {
  const codePart = failure.code !== undefined ? ` code=${String(failure.code)}` : "";
  return `[stage=${failure.stage}${codePart}] ${failure.reason}`;
}

function createStructuredError(failure: PluginFailure, cause?: unknown): Error {
  return Object.assign(new Error(formatFailureMessage(failure)), {
    stage: failure.stage,
    code: failure.code,
    reason: failure.reason,
    ...(cause !== undefined ? { cause } : {}),
  });
}

interface ConsumerRecord {
  readonly id: number;
  readonly maxFps: number;
  readonly maxDimension: 320 | 640;
  readonly smoothingAlpha: number | undefined;
  readonly filter: EmaTargetFilter;
  readonly listener: (frame: PersonTrackingFrame) => void;
  released: boolean;
}

interface ActiveStreamRecord {
  readonly previewSessionId: string;
  readonly maxFps: number;
  readonly maxDimension: 320 | 640;
  readonly close: () => void;
}

function readStoredSettings(
  storage: PluginStorage,
  options: VisionPersonTrackerPluginOptions,
): { smoothingAlpha: number; maxFps: number } {
  return {
    smoothingAlpha: normalizeSmoothingAlpha(
      storage.get("smoothingAlpha"),
      options.defaultSmoothingAlpha ?? DEFAULT_SMOOTHING_ALPHA,
    ),
    maxFps: normalizeMaxFps(
      storage.get("maxFps"),
      options.defaultMaxFps ?? DEFAULT_MAX_FPS,
    ),
  };
}

export function visionPersonTrackerDefinition(
  options: VisionPersonTrackerPluginOptions = {},
): PluginDefinition<VisionPersonTrackerState, VisionPersonTrackerCommand> {
  return {
    manifest: visionPersonTrackerManifest,

    initialState(storage): VisionPersonTrackerState {
      const settings = readStoredSettings(storage, options);
      return {
        permission: "undetermined",
        streaming: false,
        activeSubscribers: 0,
        previewSessionId: null,
        calibrationPreviewOpen: false,
        smoothingAlpha: settings.smoothingAlpha,
        maxFps: settings.maxFps,
        faceCount: 0,
        primaryTarget: null,
        lastFrameAtMs: null,
        lastError: null,
      };
    },

    create(
      ctx: PluginContext<VisionPersonTrackerState>,
    ): PluginRuntime<VisionPersonTrackerCommand> {
      const consumers = new Map<number, ConsumerRecord>();
      const primaryFilter = new EmaTargetFilter();
      let nextConsumerId = 1;
      let calibrationOpen = false;
      let activeStream: ActiveStreamRecord | null = null;
      let reconcileInFlight: Promise<ActiveStreamRecord | null> | null = null;
      let latestFrameSnapshot: PersonTrackingFrame | null = null;
      let stopped = false;

      const requireVision = (stage: string) => {
        if (!ctx.vision) {
          throw createStructuredError({
            stage,
            code: "ERR_VISION_CAPABILITY_MISSING",
            reason: "Host did not inject front-camera vision capability",
          });
        }
        return ctx.vision;
      };

      const syncSnapshotState = (patch: Partial<VisionPersonTrackerState> = {}) => {
        const perm = ctx.vision ? ctx.vision.permissionStatus() : "unavailable";
        ctx.setState((prev) => ({
          ...prev,
          permission: perm,
          streaming: activeStream !== null,
          activeSubscribers: consumers.size,
          previewSessionId: activeStream?.previewSessionId ?? null,
          calibrationPreviewOpen: calibrationOpen,
          ...patch,
        }));
      };

      const recordFailure = (
        error: unknown,
        fallbackStage: string,
        fallbackCode: string,
      ): never => {
        const failure = extractFailure(error, fallbackStage, fallbackCode);
        ctx.setLastError(failure);
        syncSnapshotState({ lastError: formatFailureMessage(failure) });
        throw createStructuredError(failure, error);
      };

      const clearError = () => {
        ctx.setLastError(undefined);
      };

      const desiredStreamParameters = (): {
        needed: boolean;
        maxFps: number;
        maxDimension: 320 | 640;
      } => {
        if (stopped || (consumers.size === 0 && !calibrationOpen)) {
          return {
            needed: false,
            maxFps: ctx.getState().maxFps,
            maxDimension: 320,
          };
        }
        const st = ctx.getState();
        let maxFps = calibrationOpen ? st.maxFps : MIN_TRACKER_FPS;
        let maxDimension: 320 | 640 = calibrationOpen ? 640 : 320;
        for (const consumer of consumers.values()) {
          if (consumer.maxFps > maxFps) maxFps = consumer.maxFps;
          if (consumer.maxDimension === 640) maxDimension = 640;
        }
        return {
          needed: true,
          maxFps: normalizeMaxFps(maxFps, st.maxFps),
          maxDimension,
        };
      };

      const closeActiveStreamSync = () => {
        const current = activeStream;
        activeStream = null;
        primaryFilter.reset();
        latestFrameSnapshot = null;
        if (current) {
          try {
            current.close();
          } catch {}
        }
        syncSnapshotState({
          streaming: false,
          previewSessionId: null,
          faceCount: 0,
          primaryTarget: null,
        });
      };

      const handleIncomingCameraFrame = (rawFrame: DeviceCameraFrame) => {
        if (stopped || (consumers.size === 0 && !calibrationOpen)) {
          return;
        }
        const faces = sanitizeFaces(
          (rawFrame as { readonly faces?: readonly DetectedCameraFace[] }).faces,
        );
        const pluginAlpha = ctx.getState().smoothingAlpha;
        const primaryTarget = primaryFilter.update(
          faces,
          rawFrame.capturedAtMs,
          pluginAlpha,
        );
        const trackingFrame: PersonTrackingFrame = {
          capturedAtMs: rawFrame.capturedAtMs,
          width: rawFrame.width,
          height: rawFrame.height,
          faceCount: faces.length,
          primaryTarget,
          faces,
        };
        latestFrameSnapshot = trackingFrame;
        syncSnapshotState({
          faceCount: faces.length,
          primaryTarget,
          lastFrameAtMs: rawFrame.capturedAtMs,
          lastError: null,
        });

        for (const consumer of [...consumers.values()]) {
          if (consumer.released) continue;
          const consumerAlpha =
            consumer.smoothingAlpha !== undefined ? consumer.smoothingAlpha : pluginAlpha;
          const consumerTarget = consumer.filter.update(
            faces,
            rawFrame.capturedAtMs,
            consumerAlpha,
          );
          const projectedFrame: PersonTrackingFrame =
            consumerAlpha === pluginAlpha
              ? trackingFrame
              : {
                  ...trackingFrame,
                  primaryTarget: consumerTarget,
                };
          try {
            consumer.listener(projectedFrame);
          } catch {}
        }
      };

      const ensurePermissionReady = async (stage: string): Promise<void> => {
        const vision = requireVision(stage);
        let perm = vision.permissionStatus();
        if (perm === "undetermined") {
          perm = await vision.requestPermission();
          syncSnapshotState({ permission: perm });
        }
        if (perm === "denied") {
          throw createStructuredError({
            stage,
            code: "ERR_CAMERA_PERMISSION_DENIED",
            reason: "Camera permission is denied by OS settings",
          });
        }
        if (perm !== "granted") {
          throw createStructuredError({
            stage,
            code: "ERR_DEVICE_CAMERA_UNAVAILABLE",
            reason: `Front camera permission is ${perm}`,
          });
        }
      };

      const reconcileStream = (): Promise<ActiveStreamRecord | null> => {
        const desired = desiredStreamParameters();
        if (!desired.needed) {
          closeActiveStreamSync();
          if (!reconcileInFlight) {
            return Promise.resolve(null);
          }
        }

        const run = async (): Promise<ActiveStreamRecord | null> => {
          while (true) {
            const target = desiredStreamParameters();
            if (!target.needed) {
              closeActiveStreamSync();
              return null;
            }
            if (
              activeStream &&
              activeStream.maxFps === target.maxFps &&
              activeStream.maxDimension === target.maxDimension
            ) {
              syncSnapshotState();
              return activeStream;
            }

            await ensurePermissionReady("vision.tracker.subscribe");
            const vision = requireVision("vision.tracker.subscribe");
            const nextSub = await vision.subscribeFrames(
              {
                facing: "front",
                maxDimension: target.maxDimension,
                maxFps: target.maxFps,
              },
              handleIncomingCameraFrame,
            );

            // Re-check after async open in case all holders disposed while awaiting
            const postOpenTarget = desiredStreamParameters();
            if (!postOpenTarget.needed) {
              try {
                nextSub.close();
              } catch {}
              closeActiveStreamSync();
              return null;
            }

            const previous = activeStream;
            activeStream = {
              previewSessionId: nextSub.previewSessionId,
              maxFps: target.maxFps,
              maxDimension: target.maxDimension,
              close: () => nextSub.close(),
            };
            if (previous) {
              try {
                previous.close();
              } catch {}
            }
            clearError();
            syncSnapshotState({ lastError: null });

            if (
              activeStream.maxFps === postOpenTarget.maxFps &&
              activeStream.maxDimension === postOpenTarget.maxDimension
            ) {
              return activeStream;
            }
          }
        };

        const chained = (reconcileInFlight ?? Promise.resolve(null)).then(
          () => run(),
          () => run(),
        );
        const tracked = chained.finally(() => {
          if (reconcileInFlight === tracked) {
            reconcileInFlight = null;
          }
        });
        reconcileInFlight = tracked;
        return tracked;
      };

      const service: PersonTrackerService = {
        permissionStatus() {
          return ctx.vision ? ctx.vision.permissionStatus() : "unavailable";
        },

        async requestPermission() {
          try {
            const vision = requireVision("vision.tracker.permission");
            const perm = await vision.requestPermission();
            if (perm === "granted") clearError();
            syncSnapshotState({
              permission: perm,
              ...(perm === "granted" ? { lastError: null } : {}),
            });
            return perm;
          } catch (error) {
            return recordFailure(
              error,
              "vision.tracker.permission",
              "ERR_CAMERA_PERMISSION_REQUEST_FAILED",
            );
          }
        },

        isStreaming() {
          return activeStream !== null;
        },

        latestFrame() {
          return latestFrameSnapshot;
        },

        async acquireTracking(
          trackOptions: AcquirePersonTrackingOptions,
          listener: (frame: PersonTrackingFrame) => void,
          callerScope?: PersonTrackerScopeLike,
        ): Promise<PersonTrackingSubscription> {
          if (stopped) {
            throw createStructuredError({
              stage: "vision.tracker.acquire",
              code: "ERR_TRACKER_STOPPED",
              reason: "vision-person-tracker plugin is stopped",
            });
          }
          if (callerScope && !callerScope.active) {
            throw createStructuredError({
              stage: "vision.tracker.acquire",
              code: "ERR_TRACKER_SCOPE_DISPOSED",
              reason: `Caller EffectScope "${callerScope.id}" is already disposed`,
            });
          }

          const st = ctx.getState();
          const consumerId = nextConsumerId++;
          const record: ConsumerRecord = {
            id: consumerId,
            maxFps: normalizeMaxFps(trackOptions.maxFps, st.maxFps),
            maxDimension: normalizeMaxDimension(trackOptions.maxDimension),
            smoothingAlpha:
              trackOptions.smoothingAlpha !== undefined
                ? normalizeSmoothingAlpha(trackOptions.smoothingAlpha, st.smoothingAlpha)
                : undefined,
            filter: new EmaTargetFilter(),
            listener,
            released: false,
          };

          let detachScopeCleanup: PersonTrackerDispose | null = null;
          const release: PersonTrackerDispose = () => {
            if (record.released) return;
            record.released = true;
            record.filter.reset();
            consumers.delete(consumerId);
            if (detachScopeCleanup) {
              const fn = detachScopeCleanup;
              detachScopeCleanup = null;
              try {
                void fn();
              } catch {}
            }
            if (consumers.size === 0 && !calibrationOpen) {
              closeActiveStreamSync();
              if (reconcileInFlight) {
                return reconcileStream().then(
                  () => {},
                  () => {},
                );
              }
              return;
            }
            return reconcileStream().then(
              () => {},
              () => {},
            );
          };

          if (callerScope) {
            detachScopeCleanup = callerScope.onDispose(() => release());
          }

          consumers.set(consumerId, record);
          syncSnapshotState();

          try {
            const opened = await reconcileStream();
            if (record.released || !opened) {
              release();
              return {
                previewSessionId: "",
                release,
              };
            }
            return {
              previewSessionId: opened.previewSessionId,
              release,
            };
          } catch (error) {
            release();
            return recordFailure(
              error,
              "vision.tracker.acquire",
              "ERR_TRACKER_STREAM_OPEN_FAILED",
            );
          }
        },

        async capturePortrait(portraitOptions) {
          if (stopped) {
            throw createStructuredError({
              stage: "vision.tracker.portrait",
              code: "ERR_TRACKER_STOPPED",
              reason: "vision-person-tracker plugin is stopped",
            });
          }
          try {
            await ensurePermissionReady("vision.tracker.portrait");
            const vision = requireVision("vision.tracker.portrait");
            const maxDimension = normalizeMaxDimension(portraitOptions?.maxDimension);
            const raw = await vision.captureFrame({
              facing: "front",
              maxDimension,
            });
            const faces = sanitizeFaces(
              (raw as { readonly faces?: readonly DetectedCameraFace[] }).faces,
            );
            const target =
              faces.length > 0
                ? primaryFilter.update(
                    faces,
                    raw.capturedAtMs,
                    ctx.getState().smoothingAlpha,
                  )
                : latestFrameSnapshot?.primaryTarget ?? null;
            clearError();
            syncSnapshotState({ lastError: null });
            return {
              dataUri: encodeJpegDataUri(raw.jpeg),
              width: raw.width,
              height: raw.height,
              primaryTarget: target,
              capturedAtMs: raw.capturedAtMs,
            };
          } catch (error) {
            return recordFailure(
              error,
              "vision.tracker.portrait",
              "ERR_PORTRAIT_CAPTURE_FAILED",
            );
          }
        },
      };

      const applySettingsUpdate = async (input: {
        smoothingAlpha?: unknown;
        maxFps?: unknown;
      }) => {
        const current = ctx.getState();
        const nextAlpha =
          input.smoothingAlpha !== undefined
            ? normalizeSmoothingAlpha(input.smoothingAlpha, current.smoothingAlpha)
            : current.smoothingAlpha;
        const nextFps =
          input.maxFps !== undefined
            ? normalizeMaxFps(input.maxFps, current.maxFps)
            : current.maxFps;

        ctx.storage.set("smoothingAlpha", nextAlpha);
        ctx.storage.set("maxFps", nextFps);
        syncSnapshotState({
          smoothingAlpha: nextAlpha,
          maxFps: nextFps,
        });

        if (activeStream !== null) {
          await reconcileStream();
        }
      };

      return {
        async start() {
          stopped = false;
          calibrationOpen = false;
          consumers.clear();
          primaryFilter.reset();
          latestFrameSnapshot = null;

          ctx.scope.onDispose(() => {
            stopped = true;
            calibrationOpen = false;
            for (const c of consumers.values()) {
              c.released = true;
              c.filter.reset();
            }
            consumers.clear();
            closeActiveStreamSync();
          });

          ctx.services.provide(PERSON_TRACKER_SERVICE_ID, service, ctx.scope);
          syncSnapshotState({
            streaming: false,
            activeSubscribers: 0,
            previewSessionId: null,
            calibrationPreviewOpen: false,
            faceCount: 0,
            primaryTarget: null,
            lastError: null,
          });
        },

        async stop() {
          stopped = true;
          calibrationOpen = false;
          for (const c of consumers.values()) {
            c.released = true;
            c.filter.reset();
          }
          consumers.clear();
          closeActiveStreamSync();
        },

        async configure(values) {
          await applySettingsUpdate({
            smoothingAlpha: values.smoothingAlpha,
            maxFps: values.maxFps,
          });
        },

        async handleCommand(command) {
          switch (command.type) {
            case "request_permission": {
              const permission = await service.requestPermission();
              return { permission };
            }
            case "set_calibration_preview": {
              calibrationOpen = Boolean(command.open);
              syncSnapshotState({ calibrationPreviewOpen: calibrationOpen });
              if (!calibrationOpen && consumers.size === 0) {
                closeActiveStreamSync();
                if (reconcileInFlight) {
                  await reconcileStream().catch(() => {});
                }
                return { streaming: false, previewSessionId: null };
              }
              try {
                const opened = await reconcileStream();
                return {
                  streaming: opened !== null,
                  previewSessionId: opened?.previewSessionId ?? null,
                };
              } catch (error) {
                calibrationOpen = false;
                syncSnapshotState({ calibrationPreviewOpen: false });
                return recordFailure(
                  error,
                  "vision.tracker.calibration",
                  "ERR_CALIBRATION_PREVIEW_FAILED",
                );
              }
            }
            case "update_settings": {
              await applySettingsUpdate({
                smoothingAlpha: command.smoothingAlpha,
                maxFps: command.maxFps,
              });
              return {
                smoothingAlpha: ctx.getState().smoothingAlpha,
                maxFps: ctx.getState().maxFps,
              };
            }
          }
        },
      };
    },
  };
}
