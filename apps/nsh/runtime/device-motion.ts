import type {
  MotionBrokerAttachOptions,
  NativeDeviceMotionPort,
  NativeDeviceMotionSample,
} from "./plugins/shared-types.js";

export type {
  MotionBrokerAttachOptions,
  NativeDeviceMotionPort,
  NativeDeviceMotionSample,
};

function createMotionError(stage: string, code: string, reason: string): Error {
  const err = new Error(`[stage=${stage} code=${code}] ${reason}`) as Error & {
    stage?: string;
    code?: string;
    reason?: string;
  };
  err.stage = stage;
  err.code = code;
  err.reason = reason;
  return err;
}

function normalizeMotionError(err: unknown, fallbackStage: string, fallbackCode: string): Error {
  if (err instanceof Error && typeof (err as { code?: unknown }).code === "string") {
    return err;
  }
  const msg = err instanceof Error ? err.message : String(err);
  const match = /^\[stage=([^\s\]]+)\s+code=([^\]]+)\]\s*(.*)$/.exec(msg.trim());
  if (match) {
    return createMotionError(match[1]!, match[2]!, match[3] || msg);
  }
  return createMotionError(fallbackStage, fallbackCode, msg);
}

function isTerminalMotionError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes("ERR_DEVICE_MOTION_CLOSED") ||
    msg.includes("ERR_DEVICE_MOTION_BACKGROUNDED") ||
    msg.includes("ERR_DEVICE_MOTION_SESSION_NOT_FOUND") ||
    msg.includes("ERR_DEVICE_MOTION_UNAVAILABLE") ||
    msg.includes("ERR_DEVICE_MOTION_HARDWARE_FAULT")
  );
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

interface MotionSubscriber {
  readonly id: number;
  readonly rateHz: number;
  readonly onSample: (sample: NativeDeviceMotionSample) => Promise<void> | void;
  inFlight: boolean;
  closed: boolean;
}

/**
 * Shared 6-axis gravity-axis IMU broker for plugins and host navigation.
 * Enforces ref-counted hardware sessions (0 subscribers = IMU off) and pauses on background.
 */
export class MotionBroker {
  private port: NativeDeviceMotionPort | null = null;
  private attachOptions: MotionBrokerAttachOptions = {};
  private foregroundActive = true;
  private foregroundEpoch = 0;
  private closed = false;
  private nextSubscriberId = 1;
  private sessionCounter = 1;
  private activeSessionId: string | undefined;
  private openingPromise: Promise<string> | undefined;
  private pumpToken = 0;
  private activePumpToken: number | null = null;
  private pumpAbort: AbortController | undefined;
  private lastSample: NativeDeviceMotionSample | null = null;
  private readonly subscribers = new Map<number, MotionSubscriber>();

  attachNativePort(port: NativeDeviceMotionPort | null, options?: MotionBrokerAttachOptions): void {
    const previous = this.port;
    if (previous === port) {
      this.attachOptions = options ? { ...options } : {};
      try {
        port?.setForeground(this.foregroundActive && !this.closed);
      } catch {}
      return;
    }

    this.teardownActiveSession(false);
    if (previous) {
      try {
        previous.stopAll();
        previous.dispose?.();
      } catch {}
    }

    this.port = port;
    this.attachOptions = options ? { ...options } : {};
    if (this.port) {
      try {
        this.port.setForeground(this.foregroundActive && !this.closed);
      } catch {}
      if (!this.closed && this.foregroundActive && this.subscribers.size > 0) {
        void this.ensureSession("motion.attachResume").catch(() => {});
      }
    }
  }

  setForegroundActive(active: boolean): void {
    if (this.closed) return;
    if (this.foregroundActive === active) return;
    this.foregroundActive = active;
    this.foregroundEpoch += 1;

    try {
      this.port?.setForeground(active);
    } catch {}

    if (!active) {
      this.teardownActiveSession(false);
    } else if (this.subscribers.size > 0) {
      void this.ensureSession("motion.foregroundResume").catch(() => {});
    }
  }

  availability(): "available" | "unavailable" {
    if (this.closed || !this.port) return "unavailable";
    if (this.attachOptions.useSampleStream && this.port.startSample) {
      return "available";
    }
    return this.port.availability() === "available" ? "available" : "unavailable";
  }

  latestSample(): NativeDeviceMotionSample | null {
    if (this.closed || !this.port || !this.activeSessionId) {
      return null;
    }
    try {
      const sample = this.port.latestSample(this.activeSessionId);
      if (sample && sample.seq > 0) {
        this.lastSample = sample;
        return sample;
      }
      return null;
    } catch (error) {
      throw normalizeMotionError(error, "motion.latestSample", "ERR_DEVICE_MOTION_READ_FAILED");
    }
  }

  resetHeading(headingDeg = 0): NativeDeviceMotionSample | null {
    if (this.closed || !this.port || !this.activeSessionId) {
      return null;
    }
    try {
      const updated = this.port.resetHeading(this.activeSessionId, headingDeg);
      if (updated && updated.seq > 0) {
        this.lastSample = updated;
        return updated;
      }
      this.lastSample = null;
      return null;
    } catch (error) {
      throw normalizeMotionError(error, "motion.resetHeading", "ERR_DEVICE_MOTION_RESET_FAILED");
    }
  }

  async subscribeHeading(
    options: { readonly rateHz?: number },
    onSample: (sample: NativeDeviceMotionSample) => Promise<void> | void,
  ): Promise<{ readonly sessionId: string; close(): void }> {
    if (this.closed) {
      throw createMotionError("motion.subscribeHeading", "ERR_DEVICE_MOTION_CLOSED", "MotionBroker is closed");
    }
    if (!this.foregroundActive) {
      throw createMotionError(
        "motion.subscribeHeading",
        "ERR_DEVICE_MOTION_BACKGROUNDED",
        "Cannot subscribe IMU heading while app is in background",
      );
    }
    if (!this.port) {
      throw createMotionError(
        "motion.subscribeHeading",
        "ERR_DEVICE_MOTION_UNAVAILABLE",
        "Native device motion bridge is not attached",
      );
    }

    const rateHz = Math.max(10, Math.min(200, Math.round(options.rateHz ?? this.attachOptions.rateHz ?? 50)));
    const subId = this.nextSubscriberId++;
    const sub: MotionSubscriber = {
      id: subId,
      rateHz,
      onSample,
      inFlight: false,
      closed: false,
    };
    this.subscribers.set(subId, sub);

    let sessionId: string;
    try {
      sessionId = await this.ensureSession("motion.subscribeHeading");
    } catch (error) {
      this.subscribers.delete(subId);
      this.reconcileSession();
      throw error;
    }

    if (sub.closed || this.closed || !this.subscribers.has(subId)) {
      this.subscribers.delete(subId);
      this.reconcileSession();
      throw createMotionError("motion.subscribeHeading", "ERR_DEVICE_MOTION_CLOSED", "Motion subscription closed while starting");
    }

    return {
      sessionId,
      close: () => {
        if (sub.closed) return;
        sub.closed = true;
        this.subscribers.delete(subId);
        this.reconcileSession();
      },
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.teardownActiveSession(true);
    try {
      this.port?.stopAll();
      this.port?.dispose?.();
    } catch {}
    this.port = null;
  }

  private targetRateHz(): number {
    let maxRate = this.attachOptions.rateHz ?? 50;
    for (const sub of this.subscribers.values()) {
      if (sub.rateHz > maxRate) maxRate = sub.rateHz;
    }
    return Math.max(10, Math.min(200, Math.round(maxRate)));
  }

  private async ensureSession(stage: string): Promise<string> {
    while (true) {
      if (this.closed) {
        throw createMotionError(stage, "ERR_DEVICE_MOTION_CLOSED", "MotionBroker is closed");
      }
      if (!this.foregroundActive) {
        throw createMotionError(stage, "ERR_DEVICE_MOTION_BACKGROUNDED", "App is in background");
      }
      if (!this.port) {
        throw createMotionError(stage, "ERR_DEVICE_MOTION_UNAVAILABLE", "Native motion port unavailable");
      }
      if (this.activeSessionId) {
        this.ensurePumpRunning();
        return this.activeSessionId;
      }
      if (this.openingPromise) {
        try {
          await this.openingPromise;
          continue;
        } catch (err) {
          if (
            (err as { staleEpoch?: boolean })?.staleEpoch &&
            !this.closed &&
            this.foregroundActive &&
            this.subscribers.size > 0
          ) {
            continue;
          }
          throw err;
        }
      }

      const epochAtStart = this.foregroundEpoch;
      const port = this.port;
      const requestedId = `looi-imu-${this.sessionCounter++}`;
      const rateHz = this.targetRateHz();
      const useSample = Boolean(this.attachOptions.useSampleStream && port.startSample);

      const openTask = (async () => {
        const startedId = useSample
          ? await port.startSample!(rateHz, requestedId)
          : await port.startSession(rateHz, requestedId);

        if (
          this.closed ||
          !this.foregroundActive ||
          this.foregroundEpoch !== epochAtStart ||
          this.subscribers.size === 0 ||
          this.port !== port
        ) {
          try {
            port.stopSession(startedId);
          } catch {}
          if (
            this.foregroundEpoch !== epochAtStart &&
            !this.closed &&
            this.foregroundActive &&
            this.subscribers.size > 0 &&
            this.port === port
          ) {
            throw Object.assign(
              createMotionError(stage, "ERR_DEVICE_MOTION_BACKGROUNDED", "Foreground epoch advanced during IMU open"),
              { staleEpoch: true },
            );
          }
          throw createMotionError(
            stage,
            !this.foregroundActive ? "ERR_DEVICE_MOTION_BACKGROUNDED" : "ERR_DEVICE_MOTION_CLOSED",
            "IMU session cancelled during startup",
          );
        }

        this.activeSessionId = startedId;
        this.ensurePumpRunning();
        return startedId;
      })();

      this.openingPromise = openTask;
      try {
        return await openTask;
      } catch (error) {
        if (
          (error as { staleEpoch?: boolean })?.staleEpoch &&
          !this.closed &&
          this.foregroundActive &&
          this.subscribers.size > 0
        ) {
          continue;
        }
        throw normalizeMotionError(error, stage, "ERR_DEVICE_MOTION_START_FAILED");
      } finally {
        if (this.openingPromise === openTask) {
          this.openingPromise = undefined;
        }
      }
    }
  }

  private reconcileSession(): void {
    if (this.subscribers.size === 0) {
      this.teardownActiveSession(false);
    }
  }

  private teardownActiveSession(clearSubscribers: boolean): void {
    this.pumpToken += 1;
    this.activePumpToken = null;
    this.pumpAbort?.abort();
    this.pumpAbort = undefined;
    this.openingPromise = undefined;
    this.lastSample = null;
    if (clearSubscribers) {
      for (const sub of this.subscribers.values()) {
        sub.closed = true;
      }
      this.subscribers.clear();
    }
    if (this.activeSessionId) {
      const sid = this.activeSessionId;
      this.activeSessionId = undefined;
      try {
        this.port?.stopSession(sid);
      } catch {}
    }
  }

  private ensurePumpRunning(): void {
    if (
      this.activePumpToken !== null ||
      !this.activeSessionId ||
      this.subscribers.size === 0 ||
      this.closed ||
      !this.foregroundActive
    ) {
      return;
    }
    this.pumpToken += 1;
    const token = this.pumpToken;
    this.activePumpToken = token;
    void this.runPumpLoop(token).finally(() => {
      if (this.activePumpToken === token) {
        this.activePumpToken = null;
      }
      if (
        this.activePumpToken === null &&
        this.activeSessionId &&
        this.subscribers.size > 0 &&
        !this.closed &&
        this.foregroundActive
      ) {
        this.ensurePumpRunning();
      }
    });
  }

  private async runPumpLoop(token: number): Promise<void> {
    let lastSeq = 0;
    while (
      !this.closed &&
      this.foregroundActive &&
      this.pumpToken === token &&
      this.subscribers.size > 0 &&
      this.activeSessionId &&
      this.port
    ) {
      const sessionId = this.activeSessionId;
      const port = this.port;
      let sample: NativeDeviceMotionSample;
      try {
        sample = await port.readNextSample(sessionId, lastSeq);
      } catch (err) {
        if (this.closed || !this.foregroundActive || this.pumpToken !== token) {
          break;
        }
        if (isTerminalMotionError(err)) {
          if (this.activeSessionId === sessionId) {
            this.activeSessionId = undefined;
            try {
              port.stopSession(sessionId);
            } catch {}
          }
          break;
        }
        const abort = new AbortController();
        this.pumpAbort = abort;
        await abortableSleep(50, abort.signal);
        continue;
      }

      if (
        this.closed ||
        !this.foregroundActive ||
        this.pumpToken !== token ||
        this.subscribers.size === 0
      ) {
        break;
      }

      if (sample.seq > lastSeq) {
        lastSeq = sample.seq;
      }
      this.lastSample = sample;

      for (const sub of [...this.subscribers.values()]) {
        if (sub.closed || sub.inFlight) continue;
        sub.inFlight = true;
        void (async () => {
          try {
            await sub.onSample(sample);
          } catch {
            // Isolate per-plugin handler exceptions from the shared IMU stream.
          } finally {
            sub.inFlight = false;
          }
        })();
      }
    }
  }
}
