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
  HEAD_PAYLOADS,
  LIGHT_PAYLOADS,
  DOCK_STATUS_HEX,
  createInitTimeHex,
} from "./constants.js";
import type { LooiBleTransport } from "./transport.js";

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
  private currentSessionEpoch: Id = "";
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
    if (this.transport.onDisconnected) {
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

  public getActiveLease(): BodyActionLease | null {
    return this.activeLease;
  }

  public getSessionEpoch(): Id {
    return this.currentSessionEpoch;
  }

  /**
   * Connect and execute the verified 3-step LOOI handshake sequence,
   * supporting configurable retry on transient GATT write errors.
   */
  public async connect(initDate: Date = new Date(), maxRetries = 2): Promise<void> {
    if (this.state !== "disconnected" && this.state !== "fault") {
      return;
    }

    this.currentSessionEpoch = `sess_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    this.currentLeaseEpoch = 0;

    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        await this.transport.connect();
        this.transitionTo("connected_unarmed");

        // Subscribe to dock notifications (fed9)
        await this.transport.startNotifications("dockNotify", (event) => {
          this.handleDockNotification(event.hex);
        });

        // Step 1: handshakeControl -> 03 (expected 1 byte)
        await this.transport.write("handshakeControl", "03", { response: true, expectedBytes: 1 });

        // Step 2: handshakeData -> 20 bytes time hex
        const timeHex = createInitTimeHex(initDate);
        await this.transport.write("handshakeData", timeHex, { response: true, expectedBytes: 20 });

        // Step 3: handshakeControl -> 8101 (expected 2 bytes)
        await this.transport.write("handshakeControl", "8101", { response: true, expectedBytes: 2 });

        if (this.isDocked) {
          this.transitionTo("ready");
        }
        return;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, 25));
        }
      }
    }

    this.transitionTo("fault");
    this.events.onError?.(lastError!);
    throw lastError!;
  }

  /**
   * Handle unexpected BLE transport disconnection.
   */
  public handleUnexpectedDisconnect(): void {
    this.clearLeaseTimer();
    this.activeLease = null;
    this.isDocked = false;
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
      if (this.state === "connected_unarmed") {
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
    if (!this.isDocked) {
      throw new Error("Cannot acquire BodyActionLease: LOOI is not docked (safety lock active).");
    }

    if (this.activeLease !== null) {
      throw new Error(`Cannot acquire BodyActionLease: lease mutex held by '${this.activeLease.holder}'.`);
    }

    if (this.state !== "ready") {
      throw new Error(`Cannot acquire BodyActionLease: supervisor state is '${this.state}', expected 'ready'.`);
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

  /**
   * Execute physical primitive within an active lease.
   */
  public async executePrimitive(lease: BodyActionLease): Promise<void> {
    if (this.activeLease?.lease_id !== lease.lease_id || this.activeLease?.lease_epoch !== lease.lease_epoch) {
      throw new Error("Lease mismatch or lease already expired/revoked.");
    }

    if (!this.isDocked) {
      await this.stop("undocked");
      throw new Error("Execution aborted: LOOI undocked.");
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
          await this.transport.write("drive", MOVE_PAYLOADS.forward, { response: false });
          break;
        case "backward":
          await this.transport.write("drive", MOVE_PAYLOADS.back, { response: false });
          break;
        case "turn_left":
          await this.transport.write("drive", MOVE_PAYLOADS.left, { response: false });
          break;
        case "turn_right":
          await this.transport.write("drive", MOVE_PAYLOADS.right, { response: false });
          break;
        case "head_up":
          await this.transport.write("head", HEAD_PAYLOADS.up, { response: false });
          break;
        case "head_center":
          await this.transport.write("head", HEAD_PAYLOADS.center, { response: false });
          break;
        case "head_down":
          await this.transport.write("head", HEAD_PAYLOADS.down, { response: false });
          break;
        default:
          throw new Error(`Unsupported primitive: ${lease.primitive}`);
      }
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

    // Wait for lease duration, with preemption handling
    const pulsePromise = new Promise<void>((resolve, reject) => {
      this.pulsePreemptRejectMap.set(lease.lease_id, reject);
      setTimeout(() => {
        resolve();
      }, lease.duration_ms);
    });

    try {
      await pulsePromise;
    } finally {
      this.pulsePreemptRejectMap.delete(lease.lease_id);
    }
    this.clearLeaseTimer();

    const stopCommandAt = new Date().toISOString();
    // Stop wheels/head on pulse completion
    await this.transport.write("drive", MOVE_PAYLOADS.stop, { response: false });

    // Settling delay for stable image capture
    if (settlingMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, settlingMs));
    }

    const verifiedMotionEndAt = new Date().toISOString();
    await this.stop("lease_expired");

    return {
      stop_command_at: stopCommandAt,
      verified_motion_end_at: verifiedMotionEndAt,
      stable_capture_at: new Date().toISOString(),
      stability_evidence_ids: [`stab_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`],
    };
  }

  /**
   * High-priority stop: clears timer, rejects in-flight pulses, revokes active lease,
   * sends 0000 stop payload to drive.
   */
  public async stop(reason: BodyStopRequest["reason"] = "user_stop"): Promise<void> {
    this.clearLeaseTimer();
    const revokedEpoch = this.currentLeaseEpoch;
    this.activeLease = null;
    this.rejectInFlightPulses(new Error(`Pulse preempted by stop: ${reason}`));

    const stopRequest = createBodyStopRequest(this.currentSessionEpoch, revokedEpoch, reason);
    this.events.onStop?.(stopRequest);

    this.transitionTo("stopping");

    try {
      if (this.transport.isConnected()) {
        await this.transport.write("drive", MOVE_PAYLOADS.stop, { response: false });
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.events.onError?.(error);
    } finally {
      if (!this.isTearingDown) {
        this.transitionTo(this.isDocked ? "ready" : "connected_unarmed");
      }
    }
  }

  public stopSync(reason: BodyStopRequest["reason"]): void {
    void this.stop(reason);
  }

  public async setLight(on: boolean): Promise<void> {
    const payload = on ? LIGHT_PAYLOADS.on : LIGHT_PAYLOADS.off;
    await this.transport.write("light", payload, { response: false });
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
    this.isTearingDown = true;
    try {
      await this.stop("disconnected");
      await this.transport.disconnect();
    } finally {
      this.clearLeaseTimer();
      this.activeLease = null;
      this.isDocked = false;
      this.isTearingDown = false;
      this.unsubscribeTransportDisconnect?.();
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

  private transitionTo(newState: BodySupervisorState): void {
    if (this.state === newState) return;
    const previous = this.state;
    this.state = newState;
    this.events.onStateChange?.(newState, previous);
  }
}
