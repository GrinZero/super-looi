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
  LIGHT_PAYLOADS,
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
  private headPose: HeadPayloadKey | "custom" = "center";
  private headDegrees = HEAD_POSE_DEGREES.center;
  private lastVerifiedAt: string | null = null;
  private lastError: string | null = null;
  private activationComplete = false;
  private drivePayload: string = MOVE_PAYLOADS.stop;
  private driveHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private driveHeartbeatErrorReported = false;
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
    this.activeLease = null;
    this.activationComplete = false;
    this.isDocked = false;
    this.lightOn = false;
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

    try {
      switch (lease.primitive) {
        case "forward":
          await this.writeMotion(MOVE_PAYLOADS.forward);
          break;
        case "backward":
          await this.writeMotion(MOVE_PAYLOADS.back);
          break;
        case "turn_left":
          await this.writeMotion(MOVE_PAYLOADS.left);
          break;
        case "turn_right":
          await this.writeMotion(MOVE_PAYLOADS.right);
          break;
        case "head_up":
          await this.transport.write("head", HEAD_PAYLOADS.up, { response: false });
          this.headPose = "up";
          this.headDegrees = HEAD_POSE_DEGREES.up;
          break;
        case "head_center":
          await this.transport.write("head", HEAD_PAYLOADS.center, { response: false });
          this.headPose = "center";
          this.headDegrees = HEAD_POSE_DEGREES.center;
          break;
        case "head_down":
          await this.transport.write("head", HEAD_PAYLOADS.down, { response: false });
          this.headPose = "down";
          this.headDegrees = HEAD_POSE_DEGREES.down;
          break;
        default:
          throw new Error(`Unsupported primitive: ${lease.primitive}`);
      }
      this.lastVerifiedAt = new Date().toISOString();
    } catch (err) {
      await this.stop("fault");
      throw err;
    }
  }

  /**
   * Bounded Pulse Execution:
   * Acquires lease, executes primitive, holds for durationMs, sends 0000 stop,
   * waits for settling window, and returns MotionObservation evidence.
   */
  public async executePulse(
    request: LeaseAcquisitionRequest,
    settlingMs = 200
  ): Promise<MotionObservation> {
    const lease = await this.acquireLease(request);
    await this.executePrimitive(lease);

    const waitPreemptible = (ms: number) =>
      new Promise<void>((resolve, reject) => {
        this.pulsePreemptRejectMap.set(lease.lease_id, reject);
        setTimeout(resolve, ms);
      });

    try {
      await waitPreemptible(lease.duration_ms);
      this.clearLeaseTimer();

      const stopCommandAt = new Date().toISOString();
      // Stop wheels/head on pulse completion
      await this.writeMotion(MOVE_PAYLOADS.stop);

      // Settling delay for stable image capture
      if (settlingMs > 0) {
        await waitPreemptible(settlingMs);
      }

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

    this.transitionTo("stopping");

    try {
      await this.transport.write("drive", MOVE_PAYLOADS.stop, { response: false });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.events.onError?.(error);
    } finally {
      if (!this.isTearingDown) {
        if (this.transport.isConnected()) {
          this.transitionTo(this.isDocked ? "ready" : "connected_unarmed");
        } else {
          this.handleUnexpectedDisconnect();
        }
      }
    }
  }

  public stopSync(reason: BodyStopRequest["reason"]): void {
    void this.stop(reason);
  }

  public async setHead(pose: HeadPayloadKey): Promise<void> {
    await this.setHeadDegrees(HEAD_POSE_DEGREES[pose]);
  }

  public async setHeadDegrees(degrees: number): Promise<void> {
    if (!this.activationComplete) throw new Error("LOOI activation is not complete");
    const angle = Math.round(Math.max(HEAD_MIN_DEGREES, Math.min(HEAD_MAX_DEGREES, degrees)) * 10) / 10;
    const selfWindow = createSelfEventWindow("head_tilt", 350, ["camera", "microphone", "imu"]);
    this.activeSelfWindows.push(selfWindow);
    this.events.onSelfEvent?.(selfWindow);
    await this.transport.write("head", headDegreesToPayload(angle), { response: false });
    this.headDegrees = angle;
    this.headPose = angle === 85 ? "up" : angle === 55 ? "center" : angle === 25 ? "down" : "custom";
    this.lastVerifiedAt = new Date().toISOString();
  }

  public async setLight(on: boolean): Promise<void> {
    if (!this.activationComplete) throw new Error("LOOI activation is not complete");
    const payload = on ? LIGHT_PAYLOADS.on : LIGHT_PAYLOADS.off;
    await this.transport.write("light", payload, { response: false });
    this.lightOn = on;
    this.lastVerifiedAt = new Date().toISOString();
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
      this.isDocked = false;
      this.lightOn = false;
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

  private async writeMotion(payload: string): Promise<void> {
    this.drivePayload = payload;
    await this.transport.write("drive", payload, { response: false });
  }

  private startDriveHeartbeat(): void {
    this.stopDriveHeartbeat();
    const timer = setInterval(() => {
      if (!this.activationComplete || !this.transport.isConnected()) return;
      void this.transport.write("drive", this.drivePayload, { response: false }).then(() => {
        this.driveHeartbeatErrorReported = false;
      }).catch((error: unknown) => {
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
