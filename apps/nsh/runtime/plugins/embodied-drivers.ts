import {
  FACE_PRIORITY,
  isFaceExpression,
  type FaceExpression,
  type FaceExpressionBehavior,
  type FaceLayerLease,
  type FacePriorityLevel,
  type PluginFaceExpressionId,
  type RobotFaceController,
} from "@super-looi/runtime/face";
import type { BodyRuntime } from "../body.js";
import type { MotionBroker } from "../device-motion.js";
import type { VisionBroker } from "../device-camera.js";
import type {
  BodyServoLease,
  EffectScope,
  FaceLease,
  FacePriorityLayer,
  PluginBodyCapability,
  PluginFaceCapability,
  PluginManifest,
  PluginMotionCapability,
  PluginPermission,
  PluginVisionCapability,
  ScopedExpressionId,
} from "./contracts.js";
import { extractPluginFailure, PluginKernelError } from "./errors.js";
import { validateDynamicFaceRecipeIssue } from "./shared-types.js";

function assertPluginPermission(
  manifest: PluginManifest,
  permission: PluginPermission,
  stage: string,
): void {
  if (!manifest.permissions.includes(permission)) {
    throw new PluginKernelError({
      stage,
      code: "ERR_PLUGIN_PERMISSION_DENIED",
      pluginId: manifest.id,
      reason: `Plugin "${manifest.id}" has not declared required permission "${permission}"`,
    });
  }
}

export function validatePluginFaceRecipe(
  pluginId: string,
  scopedId: ScopedExpressionId,
  recipe: Record<string, unknown>,
): void {
  const issue = validateDynamicFaceRecipeIssue(scopedId, recipe);
  if (issue) {
    throw new PluginKernelError({
      stage: "face.registerExpression",
      code: "ERR_INVALID_FACE_RECIPE",
      pluginId,
      reason: issue,
    });
  }
}

interface ManagedDynamicExpression {
  readonly id: PluginFaceExpressionId;
  readonly recipe: Record<string, unknown>;
  readonly behavior?: Partial<FaceExpressionBehavior>;
  controllerUnregister?: () => void;
}

interface ManagedPluginFaceLease {
  readonly priority: FacePriorityLevel;
  expression: FaceExpression | null;
  gaze: { x: number; y: number } | null;
  released: boolean;
  controllerLease?: FaceLayerLease;
}

/**
 * Decouples plugin face registrations & leases from UI boot timing:
 * if plugins mount and register recipes/leases during `openRuntime()` before `store.ts`
 * calls `attachFaceController(driver)`, all state is replayed atomically on attachment.
 */
export class FaceDriverHub {
  private controller?: RobotFaceController;
  private readonly expressions = new Map<PluginFaceExpressionId, ManagedDynamicExpression>();
  private readonly leases = new Set<ManagedPluginFaceLease>();

  attachController(controller: RobotFaceController | undefined): void {
    if (this.controller === controller) return;
    if (this.controller) {
      for (const lease of this.leases) {
        lease.controllerLease?.release();
        lease.controllerLease = undefined;
      }
      for (const expr of this.expressions.values()) {
        expr.controllerUnregister?.();
        expr.controllerUnregister = undefined;
      }
    }
    this.controller = controller;
    if (!controller) return;

    for (const expr of this.expressions.values()) {
      expr.controllerUnregister = controller.registerDynamicExpression(
        expr.id,
        expr.recipe,
        expr.behavior,
      );
    }
    for (const lease of this.leases) {
      if (lease.released) continue;
      lease.controllerLease = controller.acquireLayerLease(lease.priority, {
        expression: lease.expression,
        gaze: lease.gaze,
      });
    }
  }

  createCapability(manifest: PluginManifest, pluginScope: EffectScope): PluginFaceCapability | undefined {
    const canControl = manifest.permissions.includes("face.control");
    const canRegister = manifest.permissions.includes("face.register");
    if (!canControl && !canRegister) return undefined;

    return {
      registerExpression: (localId, recipe, options) => {
        assertPluginPermission(manifest, "face.register", "face.registerExpression");
        const trimmed = localId.trim();
        if (!/^[a-z0-9][a-z0-9_-]{0,47}$/.test(trimmed)) {
          throw new PluginKernelError({
            stage: "face.registerExpression",
            code: "ERR_INVALID_FACE_EXPRESSION_ID",
            pluginId: manifest.id,
            reason: `Invalid local expression id "${localId}"; expected lowercase alphanumeric/underscore/hyphen`,
          });
        }
        const scopedId: ScopedExpressionId = `plugin:${manifest.id}:${trimmed}`;
        validatePluginFaceRecipe(manifest.id, scopedId, recipe);

        const existing = this.expressions.get(scopedId);
        if (existing) {
          existing.controllerUnregister?.();
          this.expressions.delete(scopedId);
        }

        const behavior: Partial<FaceExpressionBehavior> = {
          ...(options?.closedRest !== undefined ? { closedRest: options.closedRest } : {}),
          ...(options?.allowsBlink !== undefined ? { allowsBlink: options.allowsBlink } : {}),
          ...(options?.allowsAudioResonance !== undefined
            ? { allowsAudioResonance: options.allowsAudioResonance }
            : {}),
        };
        const record: ManagedDynamicExpression = {
          id: scopedId,
          recipe: structuredClone(recipe),
          behavior,
          controllerUnregister: this.controller?.registerDynamicExpression(scopedId, recipe, behavior),
        };
        this.expressions.set(scopedId, record);

        const targetScope = options?.scope ?? pluginScope;
        targetScope.onDispose(() => {
          const current = this.expressions.get(scopedId);
          if (current !== record) return;
          this.expressions.delete(scopedId);
          for (const lease of this.leases) {
            if (lease.expression === scopedId) {
              lease.expression = null;
            }
          }
          record.controllerUnregister?.();
          record.controllerUnregister = undefined;
        });

        return scopedId;
      },

      acquireLease: (layer: FacePriorityLayer, scope?: EffectScope): FaceLease => {
        assertPluginPermission(manifest, "face.control", "face.acquireLease");
        if (layer === "foreground_stage" && !manifest.permissions.includes("stage.ui")) {
          throw new PluginKernelError({
            stage: "face.acquireLease",
            code: "ERR_PLUGIN_PERMISSION_DENIED",
            pluginId: manifest.id,
            reason: `Plugin "${manifest.id}" requires "stage.ui" permission to acquire "foreground_stage" face lease`,
          });
        }

        const priority =
          layer === "foreground_stage"
            ? FACE_PRIORITY.PLUGIN_FOREGROUND
            : FACE_PRIORITY.PLUGIN_BACKGROUND;

        const record: ManagedPluginFaceLease = {
          priority,
          expression: null,
          gaze: null,
          released: false,
          controllerLease: this.controller?.acquireLayerLease(priority),
        };
        this.leases.add(record);

        const release = () => {
          if (record.released) return;
          record.released = true;
          this.leases.delete(record);
          record.controllerLease?.release();
          record.controllerLease = undefined;
        };

        (scope ?? pluginScope).onDispose(release);

        return {
          setExpression: (expression) => {
            if (record.released) return;
            if (
              expression !== null &&
              !isFaceExpression(expression) &&
              !this.expressions.has(expression as PluginFaceExpressionId)
            ) {
              throw new PluginKernelError({
                stage: `plugin:${manifest.id}:face.setExpression`,
                code: "ERR_FACE_UNKNOWN_EXPRESSION",
                pluginId: manifest.id,
                reason: `Unknown face expression "${String(expression)}"`,
              });
            }
            record.expression = expression;
            record.controllerLease?.setExpression(expression);
          },
          setGaze: (gaze) => {
            if (record.released) return;
            record.gaze = gaze ? { x: gaze.x, y: gaze.y } : null;
            record.controllerLease?.setGaze(record.gaze);
          },
          triggerBlink: () => {
            if (record.released) return;
            record.controllerLease?.triggerBlink();
          },
          release,
        };
      },
    };
  }
}

function wrapServoMethod<TArgs extends unknown[], TResult>(
  pluginId: string,
  method: string,
  fn: (...args: TArgs) => Promise<TResult>,
): (...args: TArgs) => Promise<TResult> {
  return async (...args: TArgs) => {
    try {
      return await fn(...args);
    } catch (error) {
      if (error instanceof PluginKernelError) throw error;
      const stage = `plugin:${pluginId}:body.servo.${method}`;
      const failure = extractPluginFailure(error, stage, "ERR_BODY_SERVO_EXECUTION_FAILED");
      throw new PluginKernelError({
        stage: failure.stage,
        code: failure.code !== undefined ? String(failure.code) : "ERR_BODY_SERVO_EXECUTION_FAILED",
        pluginId,
        reason: failure.reason,
        cause: error,
      });
    }
  };
}

export function createBodyCapability(
  manifest: PluginManifest,
  pluginScope: EffectScope,
  body: BodyRuntime,
): PluginBodyCapability | undefined {
  if (!manifest.permissions.includes("body.motion")) {
    return undefined;
  }

  return {
    status: () => body.status(),
    subscribeStatus: (listener, scope) => {
      const unsub = body.subscribeStatus(listener);
      const dispose = (scope ?? pluginScope).onDispose(unsub);
      return () => {
        unsub();
        dispose();
      };
    },
    latestCliffState: () => body.latestCliffState(),
    recentSensorPackets: () => body.recentSensorPackets(),
    subscribeSensorPackets: (listener, scope) => {
      const unsub = body.subscribeSensorPackets(listener);
      const dispose = (scope ?? pluginScope).onDispose(unsub);
      return () => {
        unsub();
        dispose();
      };
    },
    pulse: (input) => body.control(input, `plugin:${manifest.id}`),
    acquireServo: async (priority, scope) => {
      if (priority === "foreground_stage" && !manifest.permissions.includes("stage.ui")) {
        throw new PluginKernelError({
          stage: "body.acquireServo",
          code: "ERR_PLUGIN_PERMISSION_DENIED",
          pluginId: manifest.id,
          reason: `Plugin "${manifest.id}" requires "stage.ui" permission to acquire "foreground_stage" body servo`,
        });
      }
      const rawLease: BodyServoLease = await body.acquireServo({
        pluginId: manifest.id,
        priority,
        scope: scope ?? pluginScope,
      });
      return {
        setDriveVector: wrapServoMethod(manifest.id, "setDriveVector", rawLease.setDriveVector),
        setHeadDegrees: wrapServoMethod(manifest.id, "setHeadDegrees", rawLease.setHeadDegrees),
        setLight: wrapServoMethod(manifest.id, "setLight", rawLease.setLight),
        onPreempted: rawLease.onPreempted,
        release: wrapServoMethod(manifest.id, "release", rawLease.release),
      };
    },
  };
}

function assertCameraFacingPermission(
  manifest: PluginManifest,
  facing: "front" | "back",
  stage: string,
): void {
  if (facing !== "front" && facing !== "back") {
    throw new PluginKernelError({
      stage,
      code: "ERR_INVALID_CAMERA_FACING",
      pluginId: manifest.id,
      reason: `Unsupported camera facing "${String(facing)}"; expected "front" or "back"`,
    });
  }
  const required: PluginPermission = facing === "front" ? "camera.front" : "camera.back";
  assertPluginPermission(manifest, required, stage);
}

function rethrowAsVisionKernelError(
  pluginId: string,
  method: string,
  error: unknown,
): never {
  if (error instanceof PluginKernelError) throw error;
  const fallbackStage = `plugin:${pluginId}:vision.${method}`;
  const failure = extractPluginFailure(error, fallbackStage, "ERR_VISION_EXECUTION_FAILED");
  throw new PluginKernelError({
    stage: failure.stage,
    code: failure.code !== undefined ? String(failure.code) : "ERR_VISION_EXECUTION_FAILED",
    pluginId,
    reason: failure.reason,
    cause: error,
  });
}

export function createVisionCapability(
  manifest: PluginManifest,
  pluginScope: EffectScope,
  vision: VisionBroker,
): PluginVisionCapability | undefined {
  const canFront = manifest.permissions.includes("camera.front");
  const canBack = manifest.permissions.includes("camera.back");
  if (!canFront && !canBack) {
    return undefined;
  }

  return {
    permissionStatus: () => vision.permissionStatus(),
    requestPermission: async () => {
      try {
        return await vision.requestPermission();
      } catch (error) {
        rethrowAsVisionKernelError(manifest.id, "requestPermission", error);
      }
    },
    captureFrame: async (options) => {
      assertCameraFacingPermission(manifest, options.facing, "vision.captureFrame");
      if (!pluginScope.active) {
        throw new PluginKernelError({
          stage: "vision.captureFrame",
          code: "ERR_PLUGIN_SCOPE_DISPOSED",
          pluginId: manifest.id,
          reason: `Plugin "${manifest.id}" scope is already disposed`,
        });
      }
      try {
        return await vision.captureFrame(options);
      } catch (error) {
        rethrowAsVisionKernelError(manifest.id, "captureFrame", error);
      }
    },
    captureFaces: async (options) => {
      assertCameraFacingPermission(manifest, options.facing, "vision.captureFaces");
      if (!pluginScope.active) {
        throw new PluginKernelError({
          stage: "vision.captureFaces",
          code: "ERR_PLUGIN_SCOPE_DISPOSED",
          pluginId: manifest.id,
          reason: `Plugin "${manifest.id}" scope is already disposed`,
        });
      }
      try {
        return await vision.captureFaces(options);
      } catch (error) {
        rethrowAsVisionKernelError(manifest.id, "captureFaces", error);
      }
    },
    captureCroppedPortrait: async (options) => {
      assertCameraFacingPermission(manifest, options.facing, "vision.captureCroppedPortrait");
      if (!pluginScope.active) {
        throw new PluginKernelError({
          stage: "vision.captureCroppedPortrait",
          code: "ERR_PLUGIN_SCOPE_DISPOSED",
          pluginId: manifest.id,
          reason: `Plugin "${manifest.id}" scope is already disposed`,
        });
      }
      try {
        return await vision.captureCroppedPortrait(options);
      } catch (error) {
        rethrowAsVisionKernelError(manifest.id, "captureCroppedPortrait", error);
      }
    },
    deletePortrait: (portraitIdOrUri) => {
      if (!pluginScope.active) {
        throw new PluginKernelError({
          stage: "vision.deletePortrait",
          code: "ERR_PLUGIN_SCOPE_DISPOSED",
          pluginId: manifest.id,
          reason: `Plugin "${manifest.id}" scope is already disposed`,
        });
      }
      try {
        return vision.deletePortrait(portraitIdOrUri);
      } catch (error) {
        rethrowAsVisionKernelError(manifest.id, "deletePortrait", error);
      }
    },
    cameraHfovDeg: (facing) => {
      assertCameraFacingPermission(manifest, facing, "vision.cameraHfovDeg");
      if (!pluginScope.active) {
        throw new PluginKernelError({
          stage: "vision.cameraHfovDeg",
          code: "ERR_PLUGIN_SCOPE_DISPOSED",
          pluginId: manifest.id,
          reason: `Plugin "${manifest.id}" scope is already disposed`,
        });
      }
      return vision.cameraHfovDeg(facing);
    },
    subscribeFrames: (async (options: any, onFrame: any) => {
      assertCameraFacingPermission(manifest, options.facing, "vision.subscribeFrames");
      const targetScope = options.scope ?? pluginScope;
      if (!targetScope.active) {
        throw new PluginKernelError({
          stage: "vision.subscribeFrames",
          code: "ERR_PLUGIN_SCOPE_DISPOSED",
          pluginId: manifest.id,
          reason: `Target EffectScope "${targetScope.id}" is already disposed`,
        });
      }
      let handle: { readonly previewSessionId: string; close(): void };
      try {
        handle = await vision.subscribeFrames(
          {
            facing: options.facing,
            maxDimension: options.maxDimension,
            maxFps: options.maxFps,
            includeJpeg: options.includeJpeg,
          },
          onFrame,
        );
      } catch (error) {
        rethrowAsVisionKernelError(manifest.id, "subscribeFrames", error);
      }
      if (!targetScope.active) {
        handle.close();
        throw new PluginKernelError({
          stage: "vision.subscribeFrames",
          code: "ERR_PLUGIN_SCOPE_DISPOSED",
          pluginId: manifest.id,
          reason: `Target EffectScope "${targetScope.id}" disposed while camera session was opening`,
        });
      }
      const unregisterDispose = targetScope.onDispose(() => {
        handle.close();
      });
      return {
        previewSessionId: handle.previewSessionId,
        close: () => {
          handle.close();
          unregisterDispose();
        },
      };
    }) as PluginVisionCapability["subscribeFrames"],
  };
}

function rethrowAsMotionKernelError(
  pluginId: string,
  method: string,
  error: unknown,
): never {
  if (error instanceof PluginKernelError) throw error;
  const fallbackStage = `plugin:${pluginId}:motion.${method}`;
  const failure = extractPluginFailure(error, fallbackStage, "ERR_MOTION_EXECUTION_FAILED");
  throw new PluginKernelError({
    stage: failure.stage,
    code: failure.code !== undefined ? String(failure.code) : "ERR_MOTION_EXECUTION_FAILED",
    pluginId,
    reason: failure.reason,
    cause: error,
  });
}

export function createMotionCapability(
  manifest: PluginManifest,
  pluginScope: EffectScope,
  motion: MotionBroker,
): PluginMotionCapability | undefined {
  if (!manifest.permissions.includes("sensor.motion")) {
    return undefined;
  }

  return {
    availability: () => motion.availability(),
    latestSample: () => motion.latestSample(),
    resetHeading: (headingDeg) => {
      try {
        return motion.resetHeading(headingDeg);
      } catch (error) {
        rethrowAsMotionKernelError(manifest.id, "resetHeading", error);
      }
    },
    subscribeHeading: async (options, onSample) => {
      const targetScope = options.scope ?? pluginScope;
      if (!targetScope.active) {
        throw new PluginKernelError({
          stage: "motion.subscribeHeading",
          code: "ERR_PLUGIN_SCOPE_DISPOSED",
          pluginId: manifest.id,
          reason: `Target EffectScope "${targetScope.id}" is already disposed`,
        });
      }
      let handle: { readonly sessionId: string; close(): void };
      try {
        handle = await motion.subscribeHeading({ rateHz: options.rateHz }, onSample);
      } catch (error) {
        rethrowAsMotionKernelError(manifest.id, "subscribeHeading", error);
      }
      if (!targetScope.active) {
        handle.close();
        throw new PluginKernelError({
          stage: "motion.subscribeHeading",
          code: "ERR_PLUGIN_SCOPE_DISPOSED",
          pluginId: manifest.id,
          reason: `Target EffectScope "${targetScope.id}" disposed while IMU session was starting`,
        });
      }
      const unregisterDispose = targetScope.onDispose(() => {
        handle.close();
      });
      return {
        sessionId: handle.sessionId,
        close: () => {
          handle.close();
          unregisterDispose();
        },
      };
    },
  };
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function uint8ArrayToBase64(bytes: Uint8Array): string {
  let out = "";
  const len = bytes.length;
  let i = 0;
  for (; i + 2 < len; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out +=
      BASE64_ALPHABET[(n >> 18) & 63]! +
      BASE64_ALPHABET[(n >> 12) & 63]! +
      BASE64_ALPHABET[(n >> 6) & 63]! +
      BASE64_ALPHABET[n & 63]!;
  }
  const rem = len - i;
  if (rem === 1) {
    const n = bytes[i]! << 16;
    out += BASE64_ALPHABET[(n >> 18) & 63]! + BASE64_ALPHABET[(n >> 12) & 63]! + "==";
  } else if (rem === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out +=
      BASE64_ALPHABET[(n >> 18) & 63]! +
      BASE64_ALPHABET[(n >> 12) & 63]! +
      BASE64_ALPHABET[(n >> 6) & 63]! +
      "=";
  }
  return out;
}
