import { randomUUID } from "node:crypto";
import type { DetectedCameraFace, DeviceCameraFrame } from "./plugins/contracts.js";
import type {
  NativeDeviceCameraFrame,
  NativeDeviceCameraPort,
  VisionBrokerAttachOptions,
} from "./plugins/shared-types.js";

export type {
  DetectedCameraFace,
  NativeDeviceCameraFrame,
  NativeDeviceCameraPort,
  VisionBrokerAttachOptions,
};

export type DeviceCameraFacing = "front" | "back";
export type DeviceCameraDimension = 320 | 640 | 1280;
export type DeviceCameraPermission = "granted" | "denied" | "undetermined" | "unavailable";

interface SubscriberRecord {
  readonly id: string;
  readonly maxDimension: DeviceCameraDimension;
  readonly maxFps: number;
  readonly minIntervalMs: number;
  readonly onFrame: (frame: DeviceCameraFrame) => Promise<void> | void;
  lastDispatchedAtMs: number;
  inFlight: boolean;
  closed: boolean;
}

interface FacingSlot {
  readonly facing: DeviceCameraFacing;
  desiredSessionId?: string;
  activeSessionId?: string;
  openingPromise?: Promise<string>;
  appliedDimension: DeviceCameraDimension;
  appliedFps: number;
  pumpToken: number;
  activePumpToken: number | null;
  sleepAbort?: AbortController;
  readonly subscribers: Map<string, SubscriberRecord>;
  readonly oneshotHolders: Map<string, { readonly maxDimension: DeviceCameraDimension }>;
}

const MIN_SUBSCRIBER_FPS = 1;
const MAX_SUBSCRIBER_FPS = 15;
const DEFAULT_SUBSCRIBER_FPS = 5;
const ONESHOT_FALLBACK_FPS = 5;

function createCameraError(
  stage: string,
  code: string,
  reason: string,
  options: { cause?: unknown; staleEpoch?: boolean } = {},
): Error {
  return Object.assign(new Error(`[stage=${stage} code=${code}] ${reason}`), {
    stage,
    code,
    ...(options.cause !== undefined ? { cause: options.cause } : {}),
    ...(options.staleEpoch ? { staleEpoch: true } : {}),
  });
}

function isStaleEpochCameraError(error: unknown): boolean {
  return Boolean(
    error && typeof error === "object" && (error as { staleEpoch?: unknown }).staleEpoch === true,
  );
}

function isTerminalPumpSessionError(error: unknown): boolean {
  const text =
    error && typeof error === "object" && "code" in error
      ? `${String((error as { code?: unknown }).code)} ${String(error)}`
      : String(error);
  return (
    text.includes("ERR_DEVICE_CAMERA_SESSION_MISSING") ||
    text.includes("ERR_DEVICE_CAMERA_CLOSED") ||
    text.includes("ERR_DEVICE_CAMERA_RUNTIME") ||
    text.includes("ERR_DEVICE_CAMERA_BACKGROUNDED")
  );
}

function normalizeDimension(raw: number | undefined): DeviceCameraDimension {
  if (raw === 320 || raw === 640 || raw === 1280) return raw;
  if (raw === undefined) return 640;
  if (raw <= 320) return 320;
  if (raw <= 640) return 640;
  return 1280;
}

function clampFaceMetric(val: number, min: number, max: number): number {
  if (!Number.isFinite(val)) return 0;
  return Math.max(min, Math.min(max, val));
}

function normalizeDetectedFaces(
  raw: readonly DetectedCameraFace[] | undefined,
): readonly DetectedCameraFace[] {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const out: DetectedCameraFace[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const trackId = Number.isFinite(item.trackId) ? Math.max(0, Math.trunc(item.trackId)) : 0;
    out.push({
      trackId,
      offsetX: clampFaceMetric(item.offsetX, -1, 1),
      offsetY: clampFaceMetric(item.offsetY, -1, 1),
      width: clampFaceMetric(item.width, 0, 1),
      height: clampFaceMetric(item.height, 0, 1),
      confidence: clampFaceMetric(item.confidence, 0, 1),
    });
  }
  return out;
}

function clampFps(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return DEFAULT_SUBSCRIBER_FPS;
  return Math.max(MIN_SUBSCRIBER_FPS, Math.min(MAX_SUBSCRIBER_FPS, Math.round(raw)));
}

function hasDemand(slot: FacingSlot): boolean {
  return slot.subscribers.size > 0 || slot.oneshotHolders.size > 0;
}

function computeTargetDimension(slot: FacingSlot): DeviceCameraDimension {
  let maxDim: DeviceCameraDimension = 320;
  let any = false;
  for (const sub of slot.subscribers.values()) {
    any = true;
    if (sub.maxDimension > maxDim) maxDim = sub.maxDimension;
  }
  for (const holder of slot.oneshotHolders.values()) {
    any = true;
    if (holder.maxDimension > maxDim) maxDim = holder.maxDimension;
  }
  return any ? maxDim : 640;
}

function computeMaxSubscriberDimension(slot: FacingSlot): DeviceCameraDimension {
  let maxDim: DeviceCameraDimension = 320;
  let any = false;
  for (const sub of slot.subscribers.values()) {
    any = true;
    if (sub.maxDimension > maxDim) maxDim = sub.maxDimension;
  }
  return any ? maxDim : 640;
}

function computeTargetFps(slot: FacingSlot): number {
  let maxFps = 0;
  for (const sub of slot.subscribers.values()) {
    if (sub.maxFps > maxFps) maxFps = sub.maxFps;
  }
  return maxFps > 0 ? maxFps : ONESHOT_FALLBACK_FPS;
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Multiplexes native front/back phone camera sessions across concurrent plugins:
 * - Ref-counted per-lens hardware sharing (`max(maxDimension)`, `max(maxFps)`)
 * - Per-subscriber rate gating and single-frame-in-flight backpressure
 * - Immediate hardware release on last unsubscribe or app backgrounding, with seamless
 *   `previewSessionId` rebinding when returning to foreground.
 */
export class VisionBroker {
  private port: NativeDeviceCameraPort | null = null;
  private useSampleStream = false;
  private foregroundActive = true;
  private foregroundEpoch = 0;
  private closed = false;

  private readonly slots: Record<DeviceCameraFacing, FacingSlot> = {
    front: {
      facing: "front",
      appliedDimension: 640,
      appliedFps: DEFAULT_SUBSCRIBER_FPS,
      pumpToken: 0,
      activePumpToken: null,
      subscribers: new Map(),
      oneshotHolders: new Map(),
    },
    back: {
      facing: "back",
      appliedDimension: 640,
      appliedFps: DEFAULT_SUBSCRIBER_FPS,
      pumpToken: 0,
      activePumpToken: null,
      subscribers: new Map(),
      oneshotHolders: new Map(),
    },
  };

  attachNativePort(
    port: NativeDeviceCameraPort | null,
    options: VisionBrokerAttachOptions = {},
  ): void {
    if (this.port && this.port !== port) {
      this.teardownActiveSessions(false);
      try {
        this.port.stopAll();
      } catch {}
    }
    this.port = port;
    this.useSampleStream = Boolean(options.useSampleStream);
    if (port && !this.closed) {
      try {
        port.setForeground(this.foregroundActive);
      } catch {}
      if (this.foregroundActive) {
        this.resumeSubscribedSlots();
      }
    }
  }

  setForegroundActive(active: boolean): void {
    if (this.foregroundActive === active) return;
    this.foregroundActive = active;
    this.foregroundEpoch += 1;

    if (!active) {
      this.teardownActiveSessions(false);
      try {
        this.port?.setForeground(false);
        this.port?.stopAll();
      } catch {}
      return;
    }

    if (this.closed || !this.port) return;
    try {
      this.port.setForeground(true);
    } catch {}
    this.resumeSubscribedSlots();
  }

  permissionStatus(): DeviceCameraPermission {
    if (this.closed || !this.port) return "unavailable";
    const raw = this.port.permission();
    if (raw === "granted" || raw === "denied" || raw === "undetermined") {
      return raw;
    }
    if (this.useSampleStream && typeof this.port.openSample === "function") {
      return "granted";
    }
    return "unavailable";
  }

  async requestPermission(): Promise<"granted" | "denied" | "unavailable"> {
    if (this.closed || !this.port) return "unavailable";
    const raw = await this.port.requestPermission();
    if (raw === "granted" || raw === "denied") {
      return raw;
    }
    if (this.useSampleStream && typeof this.port.openSample === "function") {
      return "granted";
    }
    return "unavailable";
  }

  async captureFrame(options: {
    facing: DeviceCameraFacing;
    maxDimension?: DeviceCameraDimension;
  }): Promise<DeviceCameraFrame> {
    const slot = this.resolveAndValidateSlot(options.facing, "vision.captureFrame");
    const maxDimension = normalizeDimension(options.maxDimension);
    const holderId = randomUUID();
    slot.oneshotHolders.set(holderId, { maxDimension });

    try {
      const sessionId = await this.ensureSlotSession(slot, "vision.captureFrame");
      const port = this.requirePort("vision.captureFrame");
      const raw = await port.captureFrame(sessionId, maxDimension, 0);
      return {
        jpeg: new Uint8Array(raw.jpeg),
        width: raw.width,
        height: raw.height,
        facing: slot.facing,
        capturedAtMs: raw.capturedAtMs,
        faces: normalizeDetectedFaces(raw.faces),
      };
    } finally {
      slot.oneshotHolders.delete(holderId);
      this.reconcileOrCloseSlot(slot);
    }
  }

  async subscribeFrames(
    options: {
      facing: DeviceCameraFacing;
      maxDimension?: DeviceCameraDimension;
      maxFps?: number;
    },
    onFrame: (frame: DeviceCameraFrame) => Promise<void> | void,
  ): Promise<{ readonly previewSessionId: string; close(): void }> {
    const slot = this.resolveAndValidateSlot(options.facing, "vision.subscribeFrames");
    const maxDimension = normalizeDimension(options.maxDimension);
    const maxFps = clampFps(options.maxFps);
    const sub: SubscriberRecord = {
      id: randomUUID(),
      maxDimension,
      maxFps,
      minIntervalMs: 1000 / maxFps,
      onFrame,
      lastDispatchedAtMs: 0,
      inFlight: false,
      closed: false,
    };

    slot.subscribers.set(sub.id, sub);
    let sessionId: string;
    try {
      sessionId = await this.ensureSlotSession(slot, "vision.subscribeFrames");
    } catch (error) {
      sub.closed = true;
      slot.subscribers.delete(sub.id);
      this.reconcileOrCloseSlot(slot);
      throw error;
    }

    this.ensurePumpRunning(slot);

    return {
      previewSessionId: sessionId,
      close: () => {
        if (sub.closed) return;
        sub.closed = true;
        slot.subscribers.delete(sub.id);
        this.reconcileOrCloseSlot(slot);
      },
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.foregroundEpoch += 1;
    this.teardownActiveSessions(true);
    if (this.port) {
      try {
        this.port.stopAll();
        this.port.dispose?.();
      } catch {}
      this.port = null;
    }
  }

  private requirePort(stage: string): NativeDeviceCameraPort {
    if (this.closed || !this.port) {
      throw createCameraError(
        stage,
        "ERR_DEVICE_CAMERA_UNAVAILABLE",
        "Native phone camera host is not attached",
      );
    }
    return this.port;
  }

  private resolveAndValidateSlot(facing: DeviceCameraFacing, stage: string): FacingSlot {
    if (facing !== "front" && facing !== "back") {
      throw createCameraError(
        stage,
        "ERR_INVALID_CAMERA_FACING",
        `Unsupported camera facing "${String(facing)}"; expected "front" or "back"`,
      );
    }
    this.requirePort(stage);
    if (!this.foregroundActive) {
      throw createCameraError(
        stage,
        "ERR_DEVICE_CAMERA_BACKGROUNDED",
        "Phone camera cannot be accessed while app is in background",
      );
    }
    const perm = this.permissionStatus();
    if (perm === "denied") {
      throw createCameraError(
        stage,
        "ERR_CAMERA_PERMISSION_DENIED",
        "Camera permission is denied by OS settings",
      );
    }
    if (perm === "undetermined") {
      throw createCameraError(
        stage,
        "ERR_CAMERA_PERMISSION_UNDETERMINED",
        "Camera permission is undetermined; call requestPermission() first",
      );
    }
    if (perm === "unavailable") {
      throw createCameraError(
        stage,
        "ERR_DEVICE_CAMERA_UNAVAILABLE",
        "Phone camera hardware is unavailable on this host",
      );
    }
    return this.slots[facing];
  }

  private async ensureSlotSession(slot: FacingSlot, stage: string): Promise<string> {
    while (true) {
      const port = this.requirePort(stage);
      if (!this.foregroundActive) {
        throw createCameraError(
          stage,
          "ERR_DEVICE_CAMERA_BACKGROUNDED",
          "Phone camera cannot be accessed while app is in background",
        );
      }
      if (!hasDemand(slot)) {
        slot.desiredSessionId = undefined;
        throw createCameraError(
          stage,
          "ERR_DEVICE_CAMERA_CLOSED",
          "Camera session demand ended before opening",
        );
      }

      if (slot.activeSessionId) {
        this.reconcileSlotConfig(slot);
        if (slot.activeSessionId) {
          return slot.activeSessionId;
        }
      }

      if (slot.openingPromise) {
        try {
          const openedId = await slot.openingPromise;
          if (this.closed || !this.foregroundActive) {
            throw createCameraError(
              stage,
              "ERR_DEVICE_CAMERA_BACKGROUNDED",
              "Camera session paused before subscriber attached",
            );
          }
          if (!hasDemand(slot)) {
            throw createCameraError(
              stage,
              "ERR_DEVICE_CAMERA_CLOSED",
              "Camera session demand ended while opening",
            );
          }
          if (!slot.activeSessionId) {
            continue;
          }
          this.reconcileSlotConfig(slot);
          return slot.activeSessionId ?? openedId;
        } catch (error) {
          if (
            isStaleEpochCameraError(error) &&
            !this.closed &&
            this.foregroundActive &&
            hasDemand(slot)
          ) {
            continue;
          }
          throw error;
        }
      }

      const desiredDim = computeTargetDimension(slot);
      const desiredFps = computeTargetFps(slot);
      const requestedSessionId = slot.desiredSessionId ?? (slot.desiredSessionId = randomUUID());
      const epochAtStart = this.foregroundEpoch;
      const openCall =
        this.useSampleStream && typeof port.openSample === "function"
          ? port.openSample.bind(port)
          : port.openSession.bind(port);

      let openTask: Promise<string> | undefined;
      const launchedTask = (async () => {
        let actualId: string;
        try {
          actualId = await openCall(slot.facing, desiredDim, desiredFps, requestedSessionId);
        } catch (error) {
          if (
            this.foregroundEpoch !== epochAtStart &&
            !this.closed &&
            this.foregroundActive &&
            hasDemand(slot)
          ) {
            throw createCameraError(
              stage,
              "ERR_DEVICE_CAMERA_BACKGROUNDED",
              "Foreground epoch advanced while camera session was opening",
              { cause: error, staleEpoch: true },
            );
          }
          throw error;
        }

        if (
          this.closed ||
          !this.foregroundActive ||
          this.foregroundEpoch !== epochAtStart ||
          !hasDemand(slot)
        ) {
          const claimedByCurrentEpoch =
            slot.activeSessionId === actualId ||
            (slot.openingPromise !== undefined &&
              slot.openingPromise !== openTask &&
              slot.desiredSessionId === actualId);
          if (!claimedByCurrentEpoch) {
            try {
              port.closeSession(actualId);
            } catch {}
          }
          if (!hasDemand(slot)) {
            slot.desiredSessionId = undefined;
            throw createCameraError(
              stage,
              "ERR_DEVICE_CAMERA_CLOSED",
              "Camera session demand ended while opening",
            );
          }
          if (this.foregroundEpoch !== epochAtStart && this.foregroundActive && !this.closed) {
            throw createCameraError(
              stage,
              "ERR_DEVICE_CAMERA_BACKGROUNDED",
              "Foreground epoch advanced while camera session was opening",
              { staleEpoch: true },
            );
          }
          throw createCameraError(
            stage,
            "ERR_DEVICE_CAMERA_BACKGROUNDED",
            "App entered background while camera session was opening",
          );
        }

        slot.desiredSessionId = actualId;
        slot.activeSessionId = actualId;
        slot.appliedDimension = desiredDim;
        slot.appliedFps = desiredFps;
        this.reconcileSlotConfig(slot);
        if (slot.subscribers.size > 0) {
          this.ensurePumpRunning(slot);
        }
        return actualId;
      })();

      openTask = launchedTask;
      slot.openingPromise = launchedTask;
      try {
        return await launchedTask;
      } catch (error) {
        if (
          isStaleEpochCameraError(error) &&
          !this.closed &&
          this.foregroundActive &&
          hasDemand(slot)
        ) {
          continue;
        }
        throw error;
      } finally {
        if (slot.openingPromise === launchedTask) {
          slot.openingPromise = undefined;
        }
      }
    }
  }

  private reconcileSlotConfig(slot: FacingSlot): void {
    if (!slot.activeSessionId || !this.port || this.closed || !this.foregroundActive) return;
    const nextDim = computeTargetDimension(slot);
    const nextFps = computeTargetFps(slot);
    if (nextDim === slot.appliedDimension && nextFps === slot.appliedFps) return;
    const currentSessionId = slot.activeSessionId;
    try {
      this.port.reconfigureSession(currentSessionId, nextDim, nextFps);
      slot.appliedDimension = nextDim;
      slot.appliedFps = nextFps;
      // Wake any sleeping pump interval if FPS increased
      slot.sleepAbort?.abort();
    } catch {
      if (slot.activeSessionId === currentSessionId) {
        slot.activeSessionId = undefined;
      }
      slot.sleepAbort?.abort();
      if (slot.subscribers.size > 0 && !this.closed && this.foregroundActive) {
        void this.ensureSlotSession(slot, "vision.reconfigureRecover").catch(() => {});
      }
    }
  }

  private reconcileOrCloseSlot(slot: FacingSlot): void {
    if (slot.subscribers.size === 0) {
      slot.pumpToken += 1;
      slot.activePumpToken = null;
      slot.sleepAbort?.abort();
    }
    if (!hasDemand(slot)) {
      slot.desiredSessionId = undefined;
      if (slot.activeSessionId) {
        const sid = slot.activeSessionId;
        slot.activeSessionId = undefined;
        try {
          this.port?.closeSession(sid);
        } catch {}
      }
      return;
    }
    this.reconcileSlotConfig(slot);
  }

  private teardownActiveSessions(clearSubscribers: boolean): void {
    for (const facing of ["front", "back"] as const) {
      const slot = this.slots[facing];
      slot.pumpToken += 1;
      slot.activePumpToken = null;
      slot.openingPromise = undefined;
      slot.sleepAbort?.abort();
      slot.oneshotHolders.clear();
      if (clearSubscribers) {
        for (const sub of slot.subscribers.values()) {
          sub.closed = true;
        }
        slot.subscribers.clear();
        slot.desiredSessionId = undefined;
      } else if (slot.subscribers.size === 0) {
        slot.desiredSessionId = undefined;
      }
      if (slot.activeSessionId) {
        const sid = slot.activeSessionId;
        slot.activeSessionId = undefined;
        try {
          this.port?.closeSession(sid);
        } catch {}
      }
    }
  }

  private resumeSubscribedSlots(): void {
    if (this.closed || !this.foregroundActive || !this.port) return;
    if (this.permissionStatus() !== "granted") return;
    for (const facing of ["front", "back"] as const) {
      const slot = this.slots[facing];
      if (slot.subscribers.size > 0 && !slot.activeSessionId && !slot.openingPromise) {
        void this.ensureSlotSession(slot, "vision.foregroundResume").catch(() => {});
      }
    }
  }

  private ensurePumpRunning(slot: FacingSlot): void {
    if (
      slot.activePumpToken !== null ||
      !slot.activeSessionId ||
      slot.subscribers.size === 0 ||
      this.closed ||
      !this.foregroundActive
    ) {
      return;
    }
    slot.pumpToken += 1;
    const token = slot.pumpToken;
    slot.activePumpToken = token;
    void this.runPumpLoop(slot, token).finally(() => {
      if (slot.activePumpToken === token) {
        slot.activePumpToken = null;
      }
      if (
        slot.activePumpToken === null &&
        slot.activeSessionId &&
        slot.subscribers.size > 0 &&
        !this.closed &&
        this.foregroundActive
      ) {
        this.ensurePumpRunning(slot);
      }
    });
  }

  private async runPumpLoop(slot: FacingSlot, token: number): Promise<void> {
    let lastSeq = 0;

    while (
      !this.closed &&
      this.foregroundActive &&
      slot.pumpToken === token &&
      slot.subscribers.size > 0 &&
      slot.activeSessionId &&
      this.port
    ) {
      const iterStart = Date.now();
      const sessionId = slot.activeSessionId;
      const port = this.port;
      const pumpDim = computeMaxSubscriberDimension(slot);

      let rawFrame: NativeDeviceCameraFrame;
      try {
        rawFrame = await port.captureFrame(sessionId, pumpDim, lastSeq);
      } catch (err) {
        if (this.closed || !this.foregroundActive || slot.pumpToken !== token) {
          break;
        }
        if (isTerminalPumpSessionError(err)) {
          if (slot.activeSessionId === sessionId) {
            slot.activeSessionId = undefined;
          }
          break;
        }
        const retryAbort = new AbortController();
        slot.sleepAbort = retryAbort;
        await abortableSleep(60, retryAbort.signal);
        continue;
      }

      if (
        this.closed ||
        !this.foregroundActive ||
        slot.pumpToken !== token ||
        slot.subscribers.size === 0
      ) {
        break;
      }

      if (rawFrame.seq > lastSeq) {
        lastSeq = rawFrame.seq;
      }

      const now = Date.now();
      const normalizedFaces = normalizeDetectedFaces(rawFrame.faces);
      const downscaledCache = new Map<DeviceCameraDimension, Promise<NativeDeviceCameraFrame>>();

      const resolveDimensionFrame = (dim: DeviceCameraDimension): Promise<DeviceCameraFrame> => {
        if (dim >= pumpDim) {
          return Promise.resolve({
            jpeg: new Uint8Array(rawFrame.jpeg),
            width: rawFrame.width,
            height: rawFrame.height,
            facing: slot.facing,
            capturedAtMs: rawFrame.capturedAtMs,
            faces: normalizedFaces,
          });
        }
        let cached = downscaledCache.get(dim);
        if (!cached) {
          cached = port.captureFrame(sessionId, dim, 0);
          downscaledCache.set(dim, cached);
        }
        return cached.then((scaled) => ({
          jpeg: new Uint8Array(scaled.jpeg),
          width: scaled.width,
          height: scaled.height,
          facing: slot.facing,
          capturedAtMs: scaled.capturedAtMs,
          faces: scaled.faces !== undefined ? normalizeDetectedFaces(scaled.faces) : normalizedFaces,
        }));
      };

      for (const sub of [...slot.subscribers.values()]) {
        if (sub.closed || sub.inFlight) continue;
        if (sub.lastDispatchedAtMs > 0 && now - sub.lastDispatchedAtMs + 2 < sub.minIntervalMs) {
          continue;
        }
        sub.inFlight = true;
        sub.lastDispatchedAtMs = now;
        void (async () => {
          try {
            const frame = await resolveDimensionFrame(sub.maxDimension);
            if (sub.closed || this.closed || !this.foregroundActive) return;
            await sub.onFrame(frame);
          } catch {
            // Isolate per-plugin frame handler exceptions from the shared pump.
          } finally {
            sub.inFlight = false;
          }
        })();
      }

      const minIntervalMs = Math.max(20, Math.floor(1000 / computeTargetFps(slot)));
      const elapsed = Date.now() - iterStart;
      if (elapsed < minIntervalMs && slot.pumpToken === token && slot.subscribers.size > 0) {
        const paceAbort = new AbortController();
        slot.sleepAbort = paceAbort;
        await abortableSleep(minIntervalMs - elapsed, paceAbort.signal);
      }
    }
  }
}
