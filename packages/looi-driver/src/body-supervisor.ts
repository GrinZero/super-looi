import type {
  BodySupervisorState,
  BodyActionLease,
  BodyStopRequest,
  BodyPrimitive,
  SelfEventWindow,
  MotionObservation,
  Id,
} from "@super-looi/contracts";
import {
  createBodyStopRequest,
  createSelfEventWindow,
} from "@super-looi/contracts";
import {
  MOVE_PAYLOADS,
  MOVE_HEARTBEAT_MS,
  HEAD_PAYLOADS,
  HEAD_MIN_DEGREES,
  HEAD_MAX_DEGREES,
  DEFAULT_LIGHT_BRIGHTNESS,
  brightnessToPayload,
  motionToPayload,
  parsePowerStatus,
  type LooiPowerStatus,
  DOCK_STATUS_HEX,
  headDegreesToPayload,
  createInitTimeHex,
  type HeadPayloadKey,
} from "./constants.js";
import type { LooiBleTransport, LooiConnectTarget } from "./transport.js";

export const HEAD_POSE_DEGREES: Record<HeadPayloadKey, number> = Object.freeze({
  up: 85,
  center: 55,
  down: 25,
});

export interface BodySupervisorSnapshot {
  state: BodySupervisorState;
  isDocked: boolean;
  lightOn: boolean;
  lightBrightness: number;
  powerStatus: LooiPowerStatus | null;
  headPose: HeadPayloadKey | "custom";
  headDegrees: number;
  activeLease: BodyActionLease | null;
  sessionEpoch: Id;
  lastVerifiedAt: string | null;
  lastError: string | null;
}

export interface BodySupervisorEvents {
  onStateChange?: (state: BodySupervisorState, previousState: BodySupervisorState) => void;
  onDockChange?: (docked: boolean) => void;
  onSelfEvent?: (window: SelfEventWindow) => void;
  onStop?: (request: BodyStopRequest) => void;
  onError?: (error: Error) => void;
}

export interface LeaseAcquisitionRequest {
  holder: string;
  primitive: BodyPrimitive;
  durationMs: number;
}

export class BodySupervisor {
  private state: BodySupervisorState = "disconnected";
  private isDocked = false;
  private lightOn = false;
  private lightBrightness = 0;
  private powerStatus: LooiPowerStatus | null = null;
  private headPose: HeadPayloadKey | "custom" = "center";
  private headDegrees = HEAD_POSE_DEGREES.center;
  private lastVerifiedAt: string | null = null;
  private lastError: string | null = null;
  private activationComplete = false;
  private drivePayload: string = MOVE_PAYLOADS.stop;
  private driveHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private readonly inFlightDriveHeartbeats = new Set<Promise<void>>();
  private driveHeartbeatErrorReported = false;
  private gattControlTail: Promise<void> = Promise.resolve();
  private gattControlDepth = 0;
  private unackedWriteTail: Promise<void> = Promise.resolve();
  private unackedWriteDepth = 0;
  private lastUnackedWriteAt = 0;
  private activeStopPromise: Promise<void> | null = null;
  private currentSessionEpoch: Id = "";
  private connectionEpoch = 0;
  private currentLeaseEpoch = 0;
  private activeLease: BodyActionLease | null = null;
  private leaseTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private isTearingDown = false;
  private unsubscribeTransportDisconnect?: () => void;
  private activeSelfWindows: SelfEventWindow[] = [];
  private readonly pulsePreemptRejectMap = new Map<string, (err: Error) => void>();

  constructor(
    private readonly transport: LooiBleTransport,
    private readonly events: BodySupervisorEvents = {}
  ) {
    this.listenForDisconnect();
  }

  private listenForDisconnect(): void {
    if (!this.unsubscribeTransportDisconnect && this.transport.onDisconnected) {
      this.unsubscribeTransportDisconnect = this.transport.onDisconnected(() => {
        this.handleUnexpectedDisconnect();
      });
    }
  }

  public getState(): BodySupervisorState {
    return this.state;
  }

  public getIsDocked(): boolean {
    return this.isDocked;
  }

  public getLightOn(): boolean {
    return this.lightOn;
  }

  public getLightBrightness(): number {
    return this.lightBrightness;
  }

  public getPowerStatus(): LooiPowerStatus | null {
    return this.powerStatus ? { ...this.powerStatus } : null;
  }

  public getHeadPose(): HeadPayloadKey | "custom" {
    return this.headPose;
  }

  public getHeadDegrees(): number {
    return this.headDegrees;
  }

  public getActiveLease(): BodyActionLease | null {
    return this.activeLease;
  }

  public getSessionEpoch(): Id {
    return this.currentSessionEpoch;
  }

  public getSnapshot(): BodySupervisorSnapshot {
    return {
      state: this.state,
      isDocked: this.isDocked,
      lightOn: this.lightOn,
      lightBrightness: this.lightBrightness,
      powerStatus: this.getPowerStatus(),
      headPose: this.headPose,
      headDegrees: this.headDegrees,
      activeLease: this.activeLease ? { ...this.activeLease } : null,
      sessionEpoch: this.currentSessionEpoch,
      lastVerifiedAt: this.lastVerifiedAt,
      lastError: this.lastError,
    };
  }

  /** Connect with the three-write activation sequence verified on this dock. */
  public async connect(
    _initDate: Date = new Date(),
    maxRetries = 2,
    target?: LooiConnectTarget
  ): Promise<void> {
    if (this.state !== "disconnected" && this.state !== "fault") {
      return;
    }
    this.listenForDisconnect();

    this.currentSessionEpoch = `sess_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    this.activationComplete = false;
    this.stopDriveHeartbeat();
    this.drivePayload = MOVE_PAYLOADS.stop;
    this.lastUnackedWriteAt = 0;
    const connectionEpoch = ++this.connectionEpoch;
    this.currentLeaseEpoch = 0;
    const ensureActive = () => {
      if (this.connectionEpoch !== connectionEpoch) throw new Error("BLE connection cancelled");
    };

    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        if (target !== undefined) {
          await this.transport.connect(target);
        } else {
          await this.transport.connect();
        }
        ensureActive();
        this.transitionTo("connected_unarmed");

        await this.transport.startNotifications("dockNotify", (event) => {
          this.handleDockNotification(event.hex);
        });
        ensureActive();
        await this.transport.write("handshakeControl", "03", { response: true, expectedBytes: 1 });
        ensureActive();
        await this.transport.write("handshakeData", createInitTimeHex(_initDate), { response: true, expectedBytes: 20 });
        ensureActive();
        await this.transport.write("handshakeControl", "8101", { response: true, expectedBytes: 2 });
        ensureActive();
        await this.transport.write("drive", MOVE_PAYLOADS.stop, { response: false, expectedBytes: 2 });
        this.lastUnackedWriteAt = Date.now();
        ensureActive();
        this.activationComplete = true;
        this.startDriveHeartbeat();

        // Community initialization under comparison:
        // FEDA 01, subscribe FED5/FED9, FEDA 03, FED0 0000, read FED8.

        this.lastVerifiedAt = new Date().toISOString();
        this.lastError = null;
        if (this.isDocked) {
          this.transitionTo("ready");
        }
        return;
      } catch (err) {
        ensureActive();
        lastError = err instanceof Error ? err : new Error(String(err));
        this.activationComplete = false;
        this.stopDriveHeartbeat();
        if (attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, 25));
          ensureActive();
        }
      }
    }

    this.lastError = lastError?.message ?? "Handshake failed";
    this.transitionTo("fault");
    this.events.onError?.(lastError!);
    throw lastError!;
  }

  /**
   * Handle unexpected BLE transport disconnection.
   */
  public handleUnexpectedDisconnect(): void {
    this.clearLeaseTimer();
    this.stopDriveHeartbeat();
    this.drivePayload = MOVE_PAYLOADS.stop;
    this.lastUnackedWriteAt = 0;
    this.activeLease = null;
    this.activationComplete = false;
    this.isDocked = false;
    this.lightOn = false;
    this.lightBrightness = 0;
    this.powerStatus = null;
    this.headPose = "center";
    this.headDegrees = HEAD_POSE_DEGREES.center;
    this.rejectInFlightPulses(new Error("Unexpected BLE transport disconnect"));
    this.transitionTo("disconnected");
  }

  /**
   * Handle dock notification payloads from fed9.
   * '05' -> docked
   * '06' -> undocked (IMMEDIATELY triggers high-priority stop and revokes lease)
   */
  public handleDockNotification(hex: string): void {
    const cleanHex = hex.trim().toLowerCase();
    if (cleanHex === DOCK_STATUS_HEX.docked) {
      this.isDocked = true;
      this.events.onDockChange?.(true);
      if (this.activationComplete && this.state === "connected_unarmed") {
        this.transitionTo("ready");
      }
    } else if (cleanHex === DOCK_STATUS_HEX.undocked) {
      this.isDocked = false;
      this.events.onDockChange?.(false);
      // Immediately stop physical movement, reject in-flight pulses, and revoke leases!
      this.stopSync("undocked");
      if (this.state !== "disconnected" && this.state !== "fault") {
        this.transitionTo("connected_unarmed");
      }
    }
  }

  /**
   * Acquire single-active lease mutex for a bounded motor/head action.
   */
  public async acquireLease(request: LeaseAcquisitionRequest): Promise<BodyActionLease> {
    if (this.activeStopPromise !== null) {
      await this.activeStopPromise;
    }
    if (!this.activationComplete) {
      throw new Error("LOOI activation is not complete");
    }
    if (this.activeLease !== null) {
      throw new Error(`Cannot acquire BodyActionLease: lease mutex held by '${this.activeLease.holder}'.`);
    }

    if (this.state !== "ready" && this.state !== "connected_unarmed") {
      throw new Error(`Cannot acquire BodyActionLease: supervisor state is '${this.state}', expected a connected state.`);
    }

    const boundedDurationMs = Math.max(50, Math.min(request.durationMs, 5000));
    const now = Date.now();
    this.currentLeaseEpoch += 1;

    const lease: BodyActionLease = {
      lease_id: `lease_${now}_${Math.random().toString(36).substring(2, 6)}`,
      lease_epoch: this.currentLeaseEpoch,
      body_session_epoch: this.currentSessionEpoch,
      holder: request.holder,
      primitive: request.primitive,
      duration_ms: boundedDurationMs,
      granted_at_ms: now,
      expires_at_ms: now + boundedDurationMs,
    };

    this.activeLease = lease;
    this.transitionTo("observing");

    // Watchdog timer: triggers stop if caller fails to complete or release within duration + safety margin
    this.leaseTimeoutTimer = setTimeout(() => {
      this.stopSync("lease_expired");
    }, boundedDurationMs + 100);

    return lease;
  }

  /** Extend the active motor lease while its caller is still holding the control. */
  public renewLease(lease: BodyActionLease, durationMs: number): void {
    if (this.activeLease?.lease_id !== lease.lease_id || this.activeLease?.lease_epoch !== lease.lease_epoch) {
      throw new Error("Cannot renew an inactive BodyActionLease.");
    }
    const boundedDurationMs = Math.max(50, Math.min(durationMs, 5000));
    lease.duration_ms = boundedDurationMs;
    lease.expires_at_ms = Date.now() + boundedDurationMs;
    this.clearLeaseTimer();
    this.leaseTimeoutTimer = setTimeout(() => this.stopSync("lease_expired"), boundedDurationMs + 100);
  }

  /**
   * Execute physical primitive within an active lease.
   */
  public async executePrimitive(lease: BodyActionLease): Promise<void> {
    if (this.activeLease?.lease_id !== lease.lease_id || this.activeLease?.lease_epoch !== lease.lease_epoch) {
      throw new Error("Lease mismatch or lease already expired/revoked.");
    }

    // Emit and record SelfEventWindow to suppress perception inputs during body movement
    const settlingMs = Math.min(lease.duration_ms + 250, 6000);
    const selfWindow = createSelfEventWindow(
      lease.primitive.startsWith("head") ? "head_tilt" : "motor_drive",
      settlingMs,
      ["camera", "microphone", "imu"]
    );
    this.activeSelfWindows.push(selfWindow);
    this.events.onSelfEvent?.(selfWindow);

    const abortIfRevoked = () => this.activeLease?.lease_id !== lease.lease_id;
    try {
      switch (lease.primitive) {
        case "forward":
          this.drivePayload = MOVE_PAYLOADS.forward;
          await this.writePacedUnacked("drive", MOVE_PAYLOADS.forward, abortIfRevoked);
          break;
        case "backward":
          this.drivePayload = MOVE_PAYLOADS.back;
          await this.writePacedUnacked("drive", MOVE_PAYLOADS.back, abortIfRevoked);
          break;
        case "turn_left":
          this.drivePayload = MOVE_PAYLOADS.left;
          await this.writePacedUnacked("drive", MOVE_PAYLOADS.left, abortIfRevoked);
          break;
        case "turn_right":
          this.drivePayload = MOVE_PAYLOADS.right;
          await this.writePacedUnacked("drive", MOVE_PAYLOADS.right, abortIfRevoked);
          break;
        case "head_up":
          await this.writePacedUnacked("head", HEAD_PAYLOADS.up, abortIfRevoked);
          if (!abortIfRevoked()) {
            this.headPose = "up";
            this.headDegrees = HEAD_POSE_DEGREES.up;
          }
          break;
        case "head_center":
          await this.writePacedUnacked("head", HEAD_PAYLOADS.center, abortIfRevoked);
          if (!abortIfRevoked()) {
            this.headPose = "center";
            this.headDegrees = HEAD_POSE_DEGREES.center;
          }
          break;
        case "head_down":
          await this.writePacedUnacked("head", HEAD_PAYLOADS.down, abortIfRevoked);
          if (!abortIfRevoked()) {
            this.headPose = "down";
            this.headDegrees = HEAD_POSE_DEGREES.down;
          }
          break;
        default:
          throw new Error(`Unsupported primitive: ${lease.primitive}`);
      }
      if (!abortIfRevoked()) {
        this.lastVerifiedAt = new Date().toISOString();
      }
    } catch (err) {
      await this.stop("fault");
      throw err;
    }
  }

  /** Write an arbitrary signed FED0 speed/turn vector under the active motor lease. */
  public async setMotion(
    lease: BodyActionLease,
    speed: number,
    turn: number,
    options?: { paceIfBusy?: boolean }
  ): Promise<void> {
    if (this.activeLease?.lease_id !== lease.lease_id || this.activeLease.lease_epoch !== lease.lease_epoch) {
      throw new Error("Lease mismatch or lease already expired/revoked.");
    }
    if (lease.primitive.startsWith("head")) throw new Error("Motor motion requires a motor lease");
    const nowMs = Date.now();
    const settlingMs = Math.min(lease.duration_ms + 250, 6000);
    this.activeSelfWindows = this.activeSelfWindows.filter(
      (w) => w.started_at_ms + w.estimated_settling_ms > nowMs
    );
    let recentMotorWindow: SelfEventWindow | undefined;
    for (let i = this.activeSelfWindows.length - 1; i >= 0; i--) {
      const candidate = this.activeSelfWindows[i]!;
      if (candidate.cause === "motor_drive" && nowMs - candidate.started_at_ms < 200) {
        recentMotorWindow = candidate;
        break;
      }
    }
    if (recentMotorWindow) {
      recentMotorWindow.estimated_settling_ms = Math.max(
        recentMotorWindow.estimated_settling_ms,
        nowMs - recentMotorWindow.started_at_ms + settlingMs
      );
    } else {
      const selfWindow = createSelfEventWindow("motor_drive", settlingMs, ["camera", "microphone", "imu"]);
      this.activeSelfWindows.push(selfWindow);
      this.events.onSelfEvent?.(selfWindow);
    }
    const payload = motionToPayload(speed, turn);
    const prevPayload = this.drivePayload;
    this.drivePayload = payload;
    const isBoundaryTransition =
      (prevPayload === MOVE_PAYLOADS.stop && payload !== MOVE_PAYLOADS.stop) ||
      (prevPayload !== MOVE_PAYLOADS.stop && payload === MOVE_PAYLOADS.stop);
    const abortIfLeaseRevoked = () => this.activeLease?.lease_id !== lease.lease_id;
    try {
      if (
        options?.paceIfBusy ||
        (isBoundaryTransition && this.gattControlDepth === 0)
      ) {
        await this.writePacedUnacked("drive", payload, abortIfLeaseRevoked);
      } else if (this.gattControlDepth > 0 || this.unackedWriteDepth > 0) {
        // Respect quiet window for in-flight FED8/FED2 control operations or queued discrete writes;
        // startDriveHeartbeat() will stream this.drivePayload once those operations finish.
      } else if (payload === prevPayload && this.driveHeartbeatTimer !== null) {
        // Duplicate frame while heartbeat is active.
      } else if (this.lastUnackedWriteAt === 0 || Date.now() - this.lastUnackedWriteAt >= MOVE_HEARTBEAT_MS) {
        await this.writePacedUnacked("drive", payload, abortIfLeaseRevoked);
      } else if (this.driveHeartbeatTimer === null && this.activationComplete && this.transport.isConnected()) {
        this.startDriveHeartbeat();
      }
      this.lastVerifiedAt = new Date().toISOString();
    } catch (error) {
      await this.stop("fault");
      throw error;
    }
  }

  /**
   * Bounded Pulse Execution:
   * Acquires lease, executes primitive (or signed speed/turn vector), holds for durationMs,
   * sends 0000 stop, waits for settling window, and returns MotionObservation evidence.
   */
  public async executePulse(
    request: LeaseAcquisitionRequest,
    settlingMs = 200,
    motion?: { speed: number; turn: number }
  ): Promise<MotionObservation> {
    const lease = await this.acquireLease(request);
    let preemptedBy: Error | null = null;
    let activePreemptHook: ((err: Error) => void) | null = null;
    this.pulsePreemptRejectMap.set(lease.lease_id, (err: Error) => {
      preemptedBy = err;
      activePreemptHook?.(err);
    });

    const waitPreemptible = (ms: number) =>
      new Promise<void>((resolve, reject) => {
        if (preemptedBy !== null) {
          reject(preemptedBy);
          return;
        }
        const timer = setTimeout(() => {
          activePreemptHook = null;
          resolve();
        }, ms);
        activePreemptHook = (err: Error) => {
          clearTimeout(timer);
          activePreemptHook = null;
          reject(err);
        };
      });

    try {
      if (motion) {
        await this.setMotion(lease, motion.speed, motion.turn, { paceIfBusy: true });
      } else {
        await this.executePrimitive(lease);
      }
      if (preemptedBy !== null) throw preemptedBy;

      await waitPreemptible(lease.duration_ms);
      this.clearLeaseTimer();

      const stopCommandAt = new Date().toISOString();
      // Stop wheels/head on pulse completion
      this.drivePayload = MOVE_PAYLOADS.stop;
      await this.writePacedUnacked("drive", MOVE_PAYLOADS.stop, () => preemptedBy !== null);
      if (preemptedBy !== null) throw preemptedBy;

      // Settling delay for stable image capture
      if (settlingMs > 0) {
        await waitPreemptible(settlingMs);
      }
      if (preemptedBy !== null) throw preemptedBy;

      this.pulsePreemptRejectMap.delete(lease.lease_id);
      if (this.activeLease?.lease_id === lease.lease_id) {
        await this.stop("lease_expired");
      }

      return {
        stop_command_at: stopCommandAt,
        // A stop write and elapsed settling time do not prove physical stability.
        verified_motion_end_at: null,
        stable_capture_at: null,
        stability_evidence_ids: [],
      };
    } finally {
      this.pulsePreemptRejectMap.delete(lease.lease_id);
    }
  }

  /**
   * High-priority stop: clears timer, rejects in-flight pulses, revokes active lease,
   * sends 0000 stop payload to drive.
   */
  public async stop(reason: BodyStopRequest["reason"] = "user_stop"): Promise<void> {
    this.clearLeaseTimer();
    this.drivePayload = MOVE_PAYLOADS.stop;
    const revokedEpoch = this.currentLeaseEpoch;
    this.activeLease = null;
    this.rejectInFlightPulses(new Error(`Pulse preempted by stop: ${reason}`));

    const stopRequest = createBodyStopRequest(this.currentSessionEpoch, revokedEpoch, reason);
    this.events.onStop?.(stopRequest);

    if (!this.transport.isConnected()) {
      if (!this.isTearingDown) this.handleUnexpectedDisconnect();
      return;
    }

    const connectionEpoch = this.connectionEpoch;
    const previousStop = this.activeStopPromise;
    this.transitionTo("stopping");

    let runStop!: Promise<void>;
    runStop = (async () => {
      await previousStop;
      if (connectionEpoch !== this.connectionEpoch || !this.transport.isConnected()) {
        if (!this.isTearingDown && connectionEpoch === this.connectionEpoch) {
          this.handleUnexpectedDisconnect();
        }
        return;
      }
      if (this.activeLease !== null || this.currentLeaseEpoch !== revokedEpoch) {
        return;
      }
      try {
        await this.writePacedUnacked(
          "drive",
          MOVE_PAYLOADS.stop,
          () => this.activeLease !== null || this.currentLeaseEpoch !== revokedEpoch
        );
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        this.events.onError?.(error);
      } finally {
        if (!this.isTearingDown && connectionEpoch === this.connectionEpoch) {
          if (!this.transport.isConnected()) {
            this.handleUnexpectedDisconnect();
          } else if (this.activeLease === null && this.currentLeaseEpoch === revokedEpoch) {
            this.transitionTo(this.isDocked ? "ready" : "connected_unarmed");
          }
        }
      }
    })().finally(() => {
      if (this.activeStopPromise === runStop) {
        this.activeStopPromise = null;
      }
    });

    this.activeStopPromise = runStop;
    await runStop;
  }

  public stopSync(reason: BodyStopRequest["reason"]): void {
    void this.stop(reason);
  }

  public async setHead(pose: HeadPayloadKey): Promise<void> {
    await this.setHeadDegrees(HEAD_POSE_DEGREES[pose]);
  }

  public async setHeadDegrees(degrees: number): Promise<void> {
    if (!this.activationComplete) throw new Error("LOOI activation is not complete");
    const connectionEpoch = this.connectionEpoch;
    const angle = Math.round(Math.max(HEAD_MIN_DEGREES, Math.min(HEAD_MAX_DEGREES, degrees)) * 10) / 10;
    const selfWindow = createSelfEventWindow("head_tilt", 350, ["camera", "microphone", "imu"]);
    this.activeSelfWindows.push(selfWindow);
    this.events.onSelfEvent?.(selfWindow);
    await this.writePacedUnacked("head", headDegreesToPayload(angle));
    if (!this.activationComplete || connectionEpoch !== this.connectionEpoch || !this.transport.isConnected()) {
      throw new Error("BLE connection cancelled");
    }
    this.headDegrees = angle;
    this.headPose = angle === 85 ? "up" : angle === 55 ? "center" : angle === 25 ? "down" : "custom";
    this.lastVerifiedAt = new Date().toISOString();
  }

  public async setLight(on: boolean): Promise<void> {
    await this.setLightBrightness(on ? DEFAULT_LIGHT_BRIGHTNESS : 0);
  }

  public async setLightBrightness(brightness: number): Promise<void> {
    if (!this.activationComplete) throw new Error("LOOI activation is not complete");
    const connectionEpoch = this.connectionEpoch;
    const level = Math.max(0, Math.min(255, Math.round(brightness)));
    await this.runGattControlOperation(() => this.transport.write("light", brightnessToPayload(level), { response: true }));
    if (!this.activationComplete || connectionEpoch !== this.connectionEpoch || !this.transport.isConnected()) {
      throw new Error("BLE connection cancelled");
    }
    this.lightBrightness = level;
    this.lightOn = level > 0;
    this.lastVerifiedAt = new Date().toISOString();
  }

  /** Read the two-byte FED8 battery and external-power status on demand. */
  public async readPowerStatus(): Promise<LooiPowerStatus> {
    if (!this.activationComplete) throw new Error("LOOI activation is not complete");
    const connectionEpoch = this.connectionEpoch;
    const status = parsePowerStatus(await this.runGattControlOperation(() => this.transport.read("power")));
    if (!this.activationComplete || connectionEpoch !== this.connectionEpoch || !this.transport.isConnected()) {
      throw new Error("BLE connection cancelled");
    }
    this.powerStatus = status;
    return { ...status };
  }

  public recordExternalSelfEvent(window: SelfEventWindow): void {
    this.activeSelfWindows.push(window);
    this.events.onSelfEvent?.(window);
  }

  public getActiveSelfWindows(): SelfEventWindow[] {
    return [...this.activeSelfWindows];
  }

  public isSensorSuppressed(sensor: "camera" | "microphone" | "imu", nowMs: number = Date.now()): boolean {
    this.activeSelfWindows = this.activeSelfWindows.filter(
      (w) => w.started_at_ms + w.estimated_settling_ms > nowMs
    );
    return this.activeSelfWindows.some((w) => w.suppress_sensors.includes(sensor));
  }

  public async disconnect(): Promise<void> {
    ++this.connectionEpoch;
    this.isTearingDown = true;
    this.stopDriveHeartbeat();
    try {
      await this.stop("disconnected");
      await this.transport.disconnect();
    } finally {
      this.clearLeaseTimer();
      this.activeLease = null;
      this.activationComplete = false;
      this.drivePayload = MOVE_PAYLOADS.stop;
      this.lastUnackedWriteAt = 0;
      this.isDocked = false;
      this.lightOn = false;
      this.lightBrightness = 0;
      this.powerStatus = null;
      this.headPose = "center";
      this.headDegrees = HEAD_POSE_DEGREES.center;
      this.isTearingDown = false;
      this.unsubscribeTransportDisconnect?.();
      this.unsubscribeTransportDisconnect = undefined;
      this.transitionTo("disconnected");
    }
  }

  private rejectInFlightPulses(err: Error): void {
    for (const reject of this.pulsePreemptRejectMap.values()) {
      reject(err);
    }
    this.pulsePreemptRejectMap.clear();
  }

  private clearLeaseTimer(): void {
    if (this.leaseTimeoutTimer !== null) {
      clearTimeout(this.leaseTimeoutTimer);
      this.leaseTimeoutTimer = null;
    }
  }

  private async writeUnacked(characteristic: "drive" | "head", payload: string): Promise<void> {
    const startedAt = Date.now();
    this.lastUnackedWriteAt = startedAt;
    const write = this.transport.write(characteristic, payload, { response: false });
    this.inFlightDriveHeartbeats.add(write);
    try {
      await write;
    } catch (error) {
      if (this.lastUnackedWriteAt === startedAt) {
        this.lastUnackedWriteAt = 0;
      }
      throw error;
    } finally {
      this.inFlightDriveHeartbeats.delete(write);
    }
  }

  /**
   * Pace and FIFO-serialize discrete unacknowledged GATT writes (drive/head/stop)
   * so concurrent calls never wake on the same millisecond (<30ms collision) or
   * pierce an active FED8/FED2 quiet window.
   */
  private async writePacedUnacked(
    characteristic: "drive" | "head",
    payload: string,
    shouldAbort?: () => boolean
  ): Promise<void> {
    const preceding = this.unackedWriteTail;
    let release!: () => void;
    this.unackedWriteTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    const connectionEpoch = this.connectionEpoch;
    this.unackedWriteDepth += 1;
    await preceding;
    try {
      while (true) {
        if (
          connectionEpoch !== this.connectionEpoch ||
          !this.transport.isConnected() ||
          shouldAbort?.()
        ) {
          return;
        }
        if (!this.isTearingDown && this.gattControlDepth > 0) {
          await this.gattControlTail;
          continue;
        }
        this.stopDriveHeartbeat();
        await Promise.allSettled([...this.inFlightDriveHeartbeats]);
        if (
          connectionEpoch !== this.connectionEpoch ||
          !this.transport.isConnected() ||
          shouldAbort?.()
        ) {
          return;
        }
        if (!this.isTearingDown && this.gattControlDepth > 0) {
          continue;
        }
        const remaining = MOVE_HEARTBEAT_MS - (Date.now() - this.lastUnackedWriteAt);
        if (this.lastUnackedWriteAt > 0 && remaining > 0) {
          await new Promise((resolve) => setTimeout(resolve, remaining));
          continue;
        }
        await this.writeUnacked(characteristic, payload);
        return;
      }
    } finally {
      this.unackedWriteDepth = Math.max(0, this.unackedWriteDepth - 1);
      if (
        this.unackedWriteDepth === 0 &&
        this.gattControlDepth === 0 &&
        !this.isTearingDown &&
        this.activationComplete &&
        connectionEpoch === this.connectionEpoch &&
        this.transport.isConnected()
      ) {
        this.startDriveHeartbeat();
      }
      release();
    }
  }

  /** Give read/acknowledged writes an idle GATT slot between continuous drive frames. */
  private async runGattControlOperation<T>(operation: () => Promise<T>): Promise<T> {
    const preceding = this.gattControlTail;
    let release!: () => void;
    this.gattControlTail = new Promise<void>((resolve) => { release = resolve; });
    const connectionEpoch = this.connectionEpoch;
    this.gattControlDepth += 1;
    await preceding;
    const hadHeartbeat = this.driveHeartbeatTimer !== null;
    try {
      if (!this.activationComplete || connectionEpoch !== this.connectionEpoch) {
        throw new Error("LOOI activation is not complete");
      }
      if (hadHeartbeat) {
        this.stopDriveHeartbeat();
      }
      await Promise.allSettled([...this.inFlightDriveHeartbeats]);
      const sinceUnacked = Date.now() - this.lastUnackedWriteAt;
      const quietWaitMs = hadHeartbeat
        ? MOVE_HEARTBEAT_MS * 2
        : this.lastUnackedWriteAt > 0 && sinceUnacked < MOVE_HEARTBEAT_MS * 2
          ? MOVE_HEARTBEAT_MS * 2 - sinceUnacked
          : 0;
      if (quietWaitMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, quietWaitMs));
      }
      if (!this.activationComplete || connectionEpoch !== this.connectionEpoch || !this.transport.isConnected()) {
        throw new Error("BLE connection cancelled");
      }
      const result = await operation();
      if (!this.activationComplete || connectionEpoch !== this.connectionEpoch || !this.transport.isConnected()) {
        throw new Error("BLE connection cancelled");
      }
      return result;
    } finally {
      this.gattControlDepth = Math.max(0, this.gattControlDepth - 1);
      if (
        this.gattControlDepth === 0 &&
        this.unackedWriteDepth === 0 &&
        !this.isTearingDown &&
        this.activationComplete &&
        connectionEpoch === this.connectionEpoch &&
        this.transport.isConnected()
      ) {
        this.startDriveHeartbeat();
      }
      release();
    }
  }

  private startDriveHeartbeat(): void {
    this.stopDriveHeartbeat();
    const timer = setInterval(() => {
      if (
        this.gattControlDepth > 0 ||
        this.unackedWriteDepth > 0 ||
        !this.activationComplete ||
        !this.transport.isConnected()
      ) {
        return;
      }
      void this.writeUnacked("drive", this.drivePayload)
        .then(() => {
          this.driveHeartbeatErrorReported = false;
        })
        .catch((error: unknown) => {
          if (this.driveHeartbeatErrorReported) return;
          this.driveHeartbeatErrorReported = true;
          this.events.onError?.(error instanceof Error ? error : new Error(String(error)));
        });
    }, MOVE_HEARTBEAT_MS);
    (timer as ReturnType<typeof setInterval> & { unref?: () => void }).unref?.();
    this.driveHeartbeatTimer = timer;
  }

  private stopDriveHeartbeat(): void {
    if (this.driveHeartbeatTimer !== null) {
      clearInterval(this.driveHeartbeatTimer);
      this.driveHeartbeatTimer = null;
    }
    this.driveHeartbeatErrorReported = false;
  }

  private transitionTo(newState: BodySupervisorState): void {
    if (this.state === newState) return;
    const previous = this.state;
    this.state = newState;
    this.events.onStateChange?.(newState, previous);
  }
}
