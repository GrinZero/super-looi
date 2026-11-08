import type { BodyActionLease, BodyPrimitive, BodyStopRequest, BodySupervisorState, SelfEventWindow } from "@super-looi/contracts";
import {
  BodySupervisor,
  CrossPlatformBleTransport,
  SimulatedBleTransport,
  type CharacteristicKey,
  type HeadPayloadKey,
  type LooiConnectTarget,
  type LooiDeviceCandidate,
  type LooiPowerStatus,
  type NativeBleAdapter,
} from "../../../packages/looi-driver/src/index.js";
import type { Vault } from "./application.js";

export type BodyConnectionMode = "disabled" | "real_ble" | "simulation";

export interface BodyConfiguration {
  mode: BodyConnectionMode;
  savedDeviceId: string;
  savedDeviceName: string;
  autoConnect: boolean;
}

export interface BodyMotionVector {
  speed: number;
  turn: number;
}

export interface BodyStatusSnapshot {
  mode: BodyConnectionMode;
  simulation: boolean;
  permission: "granted" | "denied" | "undetermined" | "unavailable";
  supervisorState: BodySupervisorState;
  connected: boolean;
  isDocked: boolean;
  lightOn: boolean;
  lightBrightness: number;
  powerStatus: LooiPowerStatus | null;
  powerReading: boolean;
  motion: BodyMotionVector;
  headPose: HeadPayloadKey | "custom";
  headDegrees: number;
  deviceId: string | null;
  deviceName: string;
  autoConnect: boolean;
  scanning: boolean;
  scanCompleted: boolean;
  connecting: boolean;
  candidates: LooiDeviceCandidate[];
  lastVerifiedAt: string | null;
  error: string | null;
}

export type BodyControlAction =
  | "head_up"
  | "head_center"
  | "head_down"
  | "head_set"
  | "forward"
  | "backward"
  | "turn_left"
  | "turn_right"
  | "move"
  | "light_on"
  | "light_off"
  | "light_set"
  | "read_power"
  | "stop";

export interface BodyControlInput {
  action: BodyControlAction;
  durationMs?: number;
  headDegrees?: number;
  brightness?: number;
  speed?: number;
  turn?: number;
}

export interface BodyActionReceipt {
  action: BodyControlAction;
  status: "verified" | "rejected" | "failed";
  simulation: boolean;
  isDocked: boolean;
  headDegrees: number;
  lightOn: boolean;
  lightBrightness: number;
  powerStatus: LooiPowerStatus | null;
  speed?: number;
  turn?: number;
  durationMs: number | null;
  stopCommandAt: string | null;
  recordedAt: string;
  reason?: string;
}

function clampSignedAxis(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(-127, Math.min(127, Math.round(value)));
}

function dominantPrimitive(speed: number, turn: number): BodyPrimitive {
  if (Math.abs(speed) >= Math.abs(turn)) {
    return speed >= 0 ? "forward" : "backward";
  }
  return turn >= 0 ? "turn_left" : "turn_right";
}

function normalizeBodyErrorMessage(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "@looi:body_connect_failed";
  if (trimmed.startsWith("@looi:") || trimmed.startsWith("body_")) return trimmed;
  if (trimmed.includes("FED8") || trimmed.includes("battery percent")) {
    return "@looi:body_power_invalid";
  }
  if (trimmed.includes("lease mutex held") || trimmed.includes("Lease mismatch")) {
    return "@looi:body_write_busy";
  }
  if (
    trimmed.includes("activation is not complete") ||
    trimmed.includes("expected a connected state")
  ) {
    return "@looi:body_not_connected";
  }
  if (trimmed === "蓝牙特征值写入失败") return "@looi:body_write_failed";
  if (trimmed === "蓝牙特征值读取失败") return "@looi:body_read_failed";
  if (trimmed === "无法启动蓝牙扫描，请检查蓝牙与权限" || trimmed.startsWith("蓝牙扫描失败")) {
    return "@looi:body_scan_failed";
  }
  if (
    trimmed === "无法连接到指定 LOOI 底座" ||
    trimmed === "无法连接到 LOOI 底座" ||
    trimmed === "蓝牙服务发现失败"
  ) {
    return "@looi:body_connect_failed";
  }
  if (trimmed === "底座通知订阅失败") return "@looi:body_subscribe_timeout";
  return trimmed;
}

export interface NativeBlePort {
  permission(): string;
  requestPermission(): string;
  startScan(): void;
  stopScan(): void;
  scannedDevices(): Array<{ id: string; name: string; rssi: number }>;
  connect(deviceId: string): void;
  disconnect(): void;
  subscribe(characteristic: string): void;
  write(characteristic: string, hexPayload: string, withResponse: boolean): void;
  read(characteristic: string): void;
  drainEvents(): Array<{ kind: string; characteristic: string; payload: string }>;
  status(): {
    state: string;
    permission: string;
    deviceId: string;
    deviceName: string;
    error: string;
  };
}

/**
 * Adapts the pollable Rust `LooiBle` native bridge to `@super-looi/looi-driver`'s `NativeBleAdapter`.
 */
export class NshNativeBleAdapter implements NativeBleAdapter {
  private readonly disconnectListeners = new Set<() => void>();
  private readonly notificationListeners = new Map<CharacteristicKey, Set<(hex: string) => void>>();
  private readonly lastNotification = new Map<CharacteristicKey, string>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private connectedFlag = false;
  private scanGeneration = 0;
  private activeScanGeneration: number | null = null;
  private connectionGeneration = 0;
  private pendingWrite: {
    characteristic: CharacteristicKey;
    resolve: () => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  private pendingSubscription: {
    characteristic: CharacteristicKey;
    resolve: () => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  private pendingRead: {
    characteristic: CharacteristicKey;
    resolve: (hex: string) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;

  constructor(private readonly port: NativeBlePort) {}

  public isConnected(): boolean {
    this.pumpEvents();
    return this.connectedFlag && this.port.status().state === "connected";
  }

  private async ensurePermission(): Promise<void> {
    let permission = this.port.permission();
    if (permission !== "granted") {
      permission = this.port.requestPermission();
      while (permission === "undetermined") {
        permission = this.port.permission();
        if (permission === "undetermined") {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      if (permission !== "granted") {
        throw new Error(permission === "denied" ? "body_ble_permission_denied" : "body_ble_unavailable");
      }
    }
  }

  public async scanCandidates(
    _serviceUuid: string,
    timeoutMs = 8000,
    concurrentConnection = false,
  ): Promise<LooiDeviceCandidate[]> {
    const generation = ++this.scanGeneration;
    await this.ensurePermission();
    if (generation !== this.scanGeneration) return [];
    this.port.startScan();
    this.activeScanGeneration = generation;
    try {
      const deadline = Date.now() + Math.max(100, timeoutMs);
      while (Date.now() < deadline && generation === this.scanGeneration) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(100, deadline - Date.now())));
      }
      if (generation !== this.scanGeneration) return [];
      const nativeStatus = this.port.status();
      if (!concurrentConnection && nativeStatus.state === "error") {
        throw new Error(normalizeBodyErrorMessage(nativeStatus.error || "@looi:body_scan_failed"));
      }
      return this.port.scannedDevices().map((d) => ({
        id: d.id,
        name: d.name || "LOOI 桌面底座",
        rssi: typeof d.rssi === "number" ? d.rssi : null,
      }));
    } finally {
      if (this.activeScanGeneration === generation) {
        this.activeScanGeneration = null;
        this.port.stopScan();
      }
    }
  }

  public cancelScan(): void {
    ++this.scanGeneration;
    if (this.activeScanGeneration !== null) {
      this.activeScanGeneration = null;
      this.port.stopScan();
    }
  }

  public async scanAndConnect(serviceUuid: string, target?: LooiConnectTarget): Promise<void> {
    const generation = ++this.connectionGeneration;
    await this.ensurePermission();
    if (generation !== this.connectionGeneration) throw new Error("BLE connection cancelled");
    let deviceId = target?.deviceId?.trim() ?? "";
    if (!deviceId) {
      const found = await this.scanCandidates(serviceUuid, 8000);
      found.sort((a, b) => (b.rssi ?? -100) - (a.rssi ?? -100));
      deviceId = found[0]?.id ?? "";
    }
    if (!deviceId) {
      throw new Error("@looi:body_no_dock_found");
    }

    if (generation !== this.connectionGeneration) throw new Error("BLE connection cancelled");
    this.port.connect(deviceId);
    this.startPolling();

    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      if (generation !== this.connectionGeneration) throw new Error("BLE connection cancelled");
      this.pumpEvents();
      const st = this.port.status();
      if (this.connectedFlag || st.state === "connected") {
        this.connectedFlag = true;
        return;
      }
      if (st.state === "error" || (st.state === "disconnected" && st.error)) {
        this.stopPolling();
        throw new Error(normalizeBodyErrorMessage(st.error || "@looi:body_connect_failed"));
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    this.port.disconnect();
    this.stopPolling();
    throw new Error("@looi:body_connect_timeout");
  }

  public async disconnect(): Promise<void> {
    ++this.connectionGeneration;
    this.finishPendingWrite(new Error("BLE transport disconnected"));
    this.finishPendingRead(new Error("BLE transport disconnected"));
    this.finishPendingSubscription(new Error("BLE transport disconnected"));
    this.connectedFlag = false;
    this.lastNotification.clear();
    this.stopPolling();
    this.port.disconnect();
    this.port.drainEvents();
  }

  public async writeCharacteristicWithResponse(
    charKey: CharacteristicKey,
    hexPayload: string,
  ): Promise<void> {
    this.pumpEvents();
    if (this.pendingWrite) throw new Error("@looi:body_write_busy");
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.finishPendingWrite(new Error("@looi:body_write_timeout"));
      }, 3000);
      this.pendingWrite = { characteristic: charKey, resolve, reject, timer };
      try {
        this.port.write(charKey, hexPayload, true);
        this.pumpEvents();
      } catch (error) {
        this.finishPendingWrite(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  public async writeCharacteristicWithoutResponse(
    charKey: CharacteristicKey,
    hexPayload: string,
  ): Promise<void> {
    this.port.write(charKey, hexPayload, false);
    this.pumpEvents();
  }

  public async readCharacteristic(charKey: CharacteristicKey): Promise<string> {
    this.pumpEvents();
    if (this.pendingRead) throw new Error("@looi:body_read_busy");
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => this.finishPendingRead(new Error("@looi:body_read_timeout")), 3000);
      this.pendingRead = { characteristic: charKey, resolve, reject, timer };
      try {
        this.port.read(charKey);
        this.pumpEvents();
      } catch (error) {
        this.finishPendingRead(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  public async monitorCharacteristic(
    charKey: CharacteristicKey,
    onData: (hexPayload: string) => void,
  ): Promise<() => void> {
    if (this.pendingSubscription) throw new Error("@looi:body_subscribe_busy");
    let set = this.notificationListeners.get(charKey);
    if (!set) {
      set = new Set();
      this.notificationListeners.set(charKey, set);
    }
    set.add(onData);
    try {
      const cached = this.lastNotification.get(charKey);
      if (cached !== undefined) onData(cached);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.finishPendingSubscription(new Error("@looi:body_subscribe_timeout"));
        }, 3000);
        this.pendingSubscription = { characteristic: charKey, resolve, reject, timer };
        try {
          this.port.subscribe(charKey);
          this.pumpEvents();
        } catch (error) {
          this.finishPendingSubscription(error instanceof Error ? error : new Error(String(error)));
        }
      });
      this.startPolling();
    } catch (error) {
      set.delete(onData);
      throw error;
    }
    return () => {
      set?.delete(onData);
    };
  }

  public onDisconnected(callback: () => void): () => void {
    this.disconnectListeners.add(callback);
    return () => {
      this.disconnectListeners.delete(callback);
    };
  }

  public dispose(): void {
    this.finishPendingWrite(new Error("BLE transport disposed"));
    this.finishPendingRead(new Error("BLE transport disposed"));
    this.finishPendingSubscription(new Error("BLE transport disposed"));
    this.stopPolling();
    this.lastNotification.clear();
    this.notificationListeners.clear();
    this.disconnectListeners.clear();
  }

  public pumpEvents(): void {
    const events = this.port.drainEvents();
    for (const ev of events) {
      if (ev.kind === "connected") {
        this.connectedFlag = true;
      } else if (ev.kind === "disconnected") {
        this.finishPendingWrite(new Error(ev.payload || "BLE transport disconnected"));
        this.finishPendingRead(new Error(ev.payload || "BLE transport disconnected"));
        this.finishPendingSubscription(new Error(ev.payload || "BLE transport disconnected"));
        const wasConnected = this.connectedFlag;
        this.connectedFlag = false;
        this.lastNotification.clear();
        this.stopPolling();
        if (wasConnected) {
          for (const listener of this.disconnectListeners) {
            listener();
          }
        }
      } else if (ev.kind === "notification") {
        const key = ev.characteristic as CharacteristicKey;
        this.lastNotification.set(key, ev.payload);
        const listeners = this.notificationListeners.get(key);
        if (listeners) {
          for (const cb of listeners) {
            cb(ev.payload);
          }
        }
      } else if (ev.kind === "write_ack" && ev.characteristic === this.pendingWrite?.characteristic) {
        this.finishPendingWrite();
      } else if (ev.kind === "read_result" && ev.characteristic === this.pendingRead?.characteristic) {
        this.finishPendingRead(undefined, ev.payload);
      } else if (ev.kind === "notify_ack" && ev.characteristic === this.pendingSubscription?.characteristic) {
        this.finishPendingSubscription();
      } else if (ev.kind === "error") {
        const error = new Error(ev.payload || "BLE operation failed");
        this.finishPendingWrite(error);
        this.finishPendingRead(error);
        this.finishPendingSubscription(error);
      }
    }
  }

  private finishPendingWrite(error?: Error): void {
    const pending = this.pendingWrite;
    if (!pending) return;
    this.pendingWrite = null;
    clearTimeout(pending.timer);
    if (error) pending.reject(error);
    else pending.resolve();
  }

  private finishPendingRead(error?: Error, hex = ""): void {
    const pending = this.pendingRead;
    if (!pending) return;
    this.pendingRead = null;
    clearTimeout(pending.timer);
    if (error) pending.reject(error);
    else pending.resolve(hex);
  }

  private finishPendingSubscription(error?: Error): void {
    const pending = this.pendingSubscription;
    if (!pending) return;
    this.pendingSubscription = null;
    clearTimeout(pending.timer);
    if (error) pending.reject(error);
    else pending.resolve();
  }

  private startPolling(): void {
    if (this.pollTimer !== null) return;
    this.pollTimer = setInterval(() => {
      this.pumpEvents();
    }, 30);
  }

  private stopPolling(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}

const DEFAULT_SIM_CANDIDATES: LooiDeviceCandidate[] = [
  { id: "sim-looi-dock-01", name: "LOOI 桌面底座", rssi: -42 },
  { id: "sim-looi-bedroom-02", name: "卧室的 LOOI", rssi: -65 },
];

export class BodyRuntime {
  private config: BodyConfiguration = {
    mode: "real_ble",
    savedDeviceId: "",
    savedDeviceName: "LOOI 桌面底座",
    autoConnect: true,
  };
  private nativePort: NativeBlePort | null = null;
  private nativeAdapter: NshNativeBleAdapter | null = null;
  private bleTransport: CrossPlatformBleTransport | null = null;
  private simTransport: SimulatedBleTransport | null = null;
  private supervisor: BodySupervisor;
  private candidates: LooiDeviceCandidate[] = [];
  private scanning = false;
  private scanCompleted = false;
  private connecting = false;
  private scanRequest = 0;
  private connectionRequest = 0;
  private activeConnect: Promise<void> | null = null;
  private activeDisconnect: Promise<void> | null = null;
  private connectedDeviceId: string | null = null;
  private connectedDeviceName = "LOOI 桌面底座";
  private lastError: string | null = null;
  private heldDrive: BodyActionLease | null = null;
  private heldDriveRenewTimer: ReturnType<typeof setInterval> | null = null;
  private driveGeneration = 0;
  private desiredMotion: BodyMotionVector = { speed: 0, turn: 0 };
  private activeMotion: BodyMotionVector = { speed: 0, turn: 0 };
  private pendingDriveWrite = false;
  private driveFlushPromise: Promise<void> | null = null;
  private activeStop: Promise<void> | null = null;
  private inFlightPowerRead: Promise<LooiPowerStatus> | null = null;
  private readonly selfEventListeners = new Set<(window: SelfEventWindow) => void>();

  constructor(options: { vault: Vault; nativePort?: NativeBlePort | null }) {
    this.vault = options.vault;
    this.loadVault();
    if (options.nativePort) {
      this.nativePort = options.nativePort;
    }
    this.supervisor = this.buildSupervisorForMode(this.config.mode);
    if (this.config.mode === "simulation") {
      this.candidates = [...DEFAULT_SIM_CANDIDATES];
      void this.connect({
        deviceId: this.config.savedDeviceId || DEFAULT_SIM_CANDIDATES[0].id,
        deviceName: this.config.savedDeviceName || DEFAULT_SIM_CANDIDATES[0].name,
      }).then(() => {
        this.setSimulatedDock(true);
      });
    }
  }

  private readonly vault: Vault;

  private loadVault(): void {
    try {
      const raw = this.vault.get("body");
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (
        parsed?.mode === "disabled" ||
        parsed?.mode === "real_ble" ||
        parsed?.mode === "simulation"
      ) {
        this.config.mode = parsed.mode;
      }
      if (typeof parsed?.savedDeviceId === "string") {
        this.config.savedDeviceId = parsed.savedDeviceId.trim();
      }
      if (typeof parsed?.savedDeviceName === "string" && parsed.savedDeviceName.trim()) {
        this.config.savedDeviceName = parsed.savedDeviceName.trim();
        this.connectedDeviceName = this.config.savedDeviceName;
      }
      if (typeof parsed?.autoConnect === "boolean") {
        this.config.autoConnect = parsed.autoConnect;
      }
    } catch {
      // Ignore malformed stored body configuration.
    }
  }

  private saveVault(): void {
    try {
      this.vault.set("body", JSON.stringify(this.config));
    } catch {
      // Ignore vault persistence error when running in restricted environments.
    }
  }

  private stopHeldDriveRenewTimer(): void {
    if (this.heldDriveRenewTimer !== null) {
      clearInterval(this.heldDriveRenewTimer);
      this.heldDriveRenewTimer = null;
    }
  }

  private clearHeldDriveState(): void {
    this.stopHeldDriveRenewTimer();
    this.heldDrive = null;
    this.pendingDriveWrite = false;
    this.desiredMotion = { speed: 0, turn: 0 };
    this.activeMotion = { speed: 0, turn: 0 };
  }

  private ensureHeldDriveRenewTimer(generation: number): void {
    if (this.heldDriveRenewTimer !== null) return;
    const timer = setInterval(() => {
      if (generation !== this.driveGeneration || !this.heldDrive) {
        this.stopHeldDriveRenewTimer();
        return;
      }
      try {
        this.supervisor.renewLease(this.heldDrive, 1500);
      } catch {
        this.clearHeldDriveState();
      }
    }, 450);
    (timer as ReturnType<typeof setInterval> & { unref?: () => void }).unref?.();
    this.heldDriveRenewTimer = timer;
  }

  private buildSupervisorForMode(mode: BodyConnectionMode): BodySupervisor {
    this.clearHeldDriveState();
    this.inFlightPowerRead = null;
    this.bleTransport?.dispose();
    this.bleTransport = null;
    this.nativeAdapter?.dispose();
    this.nativeAdapter = null;
    this.simTransport = null;

    const events = {
      onStateChange: (state: BodySupervisorState) => {
        if (state === "disconnected" || state === "fault") {
          this.clearHeldDriveState();
        }
      },
      onStop: (req: BodyStopRequest) => {
        if (req.reason === "user_stop" || req.reason === "lease_expired") {
          if (this.heldDrive !== null && this.heldDrive.lease_epoch <= req.revoke_through_lease_epoch) {
            this.clearHeldDriveState();
          }
          return;
        }
        ++this.driveGeneration;
        this.driveFlushPromise = null;
        this.clearHeldDriveState();
      },
      onSelfEvent: (win: SelfEventWindow) => {
        for (const listener of this.selfEventListeners) listener(win);
      },
      onError: (err: Error) => {
        this.lastError = normalizeBodyErrorMessage(err.message);
      },
    };

    if (mode === "real_ble" && this.nativePort) {
      this.nativeAdapter = new NshNativeBleAdapter(this.nativePort);
      this.bleTransport = new CrossPlatformBleTransport(this.nativeAdapter);
      return new BodySupervisor(this.bleTransport, events);
    }

    const sim = new SimulatedBleTransport();
    sim.candidates = [...DEFAULT_SIM_CANDIDATES];
    sim.readValues.set("power", "6401");
    this.simTransport = sim;
    return new BodySupervisor(sim, events);
  }

  public attachNativeBle(port: NativeBlePort | null): BodyStatusSnapshot {
    this.nativePort = port;
    if (this.config.mode === "real_ble") {
      this.supervisor = this.buildSupervisorForMode("real_ble");
      if (this.config.autoConnect && this.config.savedDeviceId) {
        void this.connect({
          deviceId: this.config.savedDeviceId,
          deviceName: this.config.savedDeviceName,
        }).catch(() => {});
      }
    }
    return this.status();
  }

  public onSelfEvent(listener: (window: SelfEventWindow) => void): () => void {
    this.selfEventListeners.add(listener);
    return () => {
      this.selfEventListeners.delete(listener);
    };
  }

  public configuration(): BodyConfiguration {
    return { ...this.config };
  }

  public status(): BodyStatusSnapshot {
    this.nativeAdapter?.pumpEvents();
    const snap = this.supervisor.getSnapshot();
    const connected =
      this.config.mode !== "disabled" &&
      !this.connecting &&
      snap.state !== "disconnected" &&
      snap.state !== "fault";
    const permission =
      this.config.mode === "simulation"
        ? "granted"
        : ((this.nativePort?.permission() as BodyStatusSnapshot["permission"]) ?? "unavailable");

    return {
      mode: this.config.mode,
      simulation: this.config.mode === "simulation",
      permission,
      supervisorState: snap.state,
      connected,
      isDocked: connected && snap.isDocked,
      lightOn: connected && snap.lightOn,
      lightBrightness: connected ? snap.lightBrightness : 0,
      powerStatus: connected ? snap.powerStatus : null,
      powerReading: connected && this.inFlightPowerRead !== null,
      motion: connected && this.heldDrive ? { ...this.activeMotion } : { speed: 0, turn: 0 },
      headPose: snap.headPose,
      headDegrees: snap.headDegrees,
      deviceId: connected ? this.connectedDeviceId : (this.config.savedDeviceId || null),
      deviceName: this.connectedDeviceName || this.config.savedDeviceName || "LOOI 桌面底座",
      autoConnect: this.config.autoConnect,
      scanning: this.scanning,
      scanCompleted: this.scanCompleted,
      connecting: this.connecting,
      candidates: [...this.candidates],
      lastVerifiedAt: snap.lastVerifiedAt,
      error: this.scanning || this.connecting ? null : this.lastError,
    };
  }

  public async configure(patch: Partial<BodyConfiguration>): Promise<BodyStatusSnapshot> {
    const modeChanged = patch.mode !== undefined && patch.mode !== this.config.mode;
    if (modeChanged) {
      await this.disconnect();
      this.config.mode = patch.mode!;
    }
    if (patch.savedDeviceId !== undefined) {
      this.config.savedDeviceId = patch.savedDeviceId.trim();
    }
    if (patch.savedDeviceName !== undefined && patch.savedDeviceName.trim()) {
      this.config.savedDeviceName = patch.savedDeviceName.trim();
      this.connectedDeviceName = this.config.savedDeviceName;
    }
    if (patch.autoConnect !== undefined) {
      this.config.autoConnect = Boolean(patch.autoConnect);
    }
    this.saveVault();

    if (
      modeChanged ||
      (this.config.mode === "simulation" && !this.status().connected)
    ) {
      this.lastError = null;
      this.candidates =
        this.config.mode === "simulation" ? [...DEFAULT_SIM_CANDIDATES] : [];
      this.scanCompleted = this.config.mode === "simulation";
      this.supervisor = this.buildSupervisorForMode(this.config.mode);
      if (this.config.mode === "simulation") {
        await this.connect({
          deviceId: DEFAULT_SIM_CANDIDATES[0].id,
          deviceName: DEFAULT_SIM_CANDIDATES[0].name,
        });
        this.setSimulatedDock(true);
      } else if (
        this.config.mode === "real_ble" &&
        this.config.autoConnect &&
        this.config.savedDeviceId &&
        this.nativePort
      ) {
        void this.connect({
          deviceId: this.config.savedDeviceId,
          deviceName: this.config.savedDeviceName,
        }).catch(() => {});
      }
    }
    return this.status();
  }

  public async scan(timeoutMs = 8000): Promise<BodyStatusSnapshot> {
    if (this.config.mode === "disabled") {
      return this.status();
    }
    const request = ++this.scanRequest;
    this.lastError = null;
    this.scanning = true;
    this.scanCompleted = false;
    try {
      if (this.config.mode === "simulation") {
        if (request === this.scanRequest) {
          this.candidates = [...DEFAULT_SIM_CANDIDATES];
          this.scanCompleted = true;
        }
      } else if (!this.nativeAdapter) {
        if (request === this.scanRequest) this.lastError = "@looi:body_scan_unavailable";
      } else {
        const candidates = await this.nativeAdapter.scanCandidates("", timeoutMs, this.connecting);
        if (request === this.scanRequest) {
          this.candidates = candidates;
          this.scanCompleted = true;
        }
      }
    } catch (error) {
      if (request === this.scanRequest) {
        this.lastError = normalizeBodyErrorMessage(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (request === this.scanRequest) this.scanning = false;
    }
    return this.status();
  }

  public async connect(target?: {
    deviceId?: string;
    deviceName?: string;
  }): Promise<BodyStatusSnapshot> {
    if (this.config.mode === "disabled") {
      await this.configure({ mode: "real_ble" });
    }
    this.lastError = null;
    const candidate =
      (target?.deviceId
        ? this.candidates.find((c) => c.id === target.deviceId)
        : undefined) ?? this.candidates[0];
    const resolvedId =
      target?.deviceId?.trim() ||
      this.config.savedDeviceId ||
      candidate?.id ||
      (this.config.mode === "simulation" ? DEFAULT_SIM_CANDIDATES[0].id : "");
    const resolvedName =
      target?.deviceName?.trim() ||
      candidate?.name ||
      this.config.savedDeviceName ||
      "LOOI 桌面底座";

    const request = ++this.connectionRequest;
    const previous = this.activeConnect;
    const pendingDisconnect = this.activeDisconnect;
    this.connecting = true;
    ++this.scanRequest;
    this.scanning = false;
    this.nativeAdapter?.cancelScan();
    const task = (async () => {
      try {
        await pendingDisconnect;
        if (previous) {
          await this.supervisor.disconnect();
          await previous;
        }
        if (request !== this.connectionRequest) return;
        if (this.config.mode === "real_ble" && !this.nativeAdapter) {
          this.lastError = "@looi:body_ble_device_unavailable";
          return;
        }
        const snap = this.supervisor.getSnapshot();
        if (snap.state !== "disconnected" && snap.state !== "fault") {
          await this.supervisor.disconnect();
        }
        if (request !== this.connectionRequest) return;
        await this.supervisor.connect(new Date(), 2, {
          deviceId: resolvedId || undefined,
          deviceName: resolvedName,
        });
        if (request !== this.connectionRequest) return;
        if (this.config.mode === "real_ble") {
          const nativeStatus = this.nativePort?.status();
          this.connectedDeviceId =
            nativeStatus?.deviceId || resolvedId || "looi-dock";
          this.connectedDeviceName =
            nativeStatus?.deviceName || resolvedName || "LOOI 桌面底座";
          this.config.savedDeviceId = this.connectedDeviceId;
          this.config.savedDeviceName = this.connectedDeviceName;
          this.saveVault();
        } else {
          this.connectedDeviceId = resolvedId || DEFAULT_SIM_CANDIDATES[0].id;
          this.connectedDeviceName =
            resolvedName || DEFAULT_SIM_CANDIDATES[0].name;
        }
        if (this.config.mode === "simulation" && !this.supervisor.getIsDocked()) {
          this.simTransport?.readValues.set("power", "6401");
          this.simTransport?.simulateDock(true);
        }
        void this.readPowerStatus().catch(() => {});
      } catch (error) {
        if (request === this.connectionRequest) {
          this.lastError = normalizeBodyErrorMessage(error instanceof Error ? error.message : String(error));
        }
      } finally {
        if (request === this.connectionRequest) this.connecting = false;
      }
    })();
    this.activeConnect = task;
    await task;
    if (this.activeConnect === task) this.activeConnect = null;
    return this.status();
  }

  public async disconnect(): Promise<BodyStatusSnapshot> {
    ++this.driveGeneration;
    this.clearHeldDriveState();
    this.inFlightPowerRead = null;
    const request = ++this.connectionRequest;
    this.lastError = null;
    const previous = this.activeConnect;
    const pendingDisconnect = this.activeDisconnect;
    const task = (async () => {
      try {
        await pendingDisconnect;
        await this.supervisor.disconnect();
        await previous;
      } catch {
        // Ignore disconnect errors during teardown
      }
      if (request === this.connectionRequest) {
        this.connectedDeviceId = null;
        this.connecting = false;
      }
    })();
    this.activeDisconnect = task;
    await task;
    if (this.activeDisconnect === task) this.activeDisconnect = null;
    return this.status();
  }

  public async forgetSavedDock(): Promise<BodyStatusSnapshot> {
    const disconnecting = this.disconnect();
    this.config.savedDeviceId = "";
    this.config.savedDeviceName = "LOOI 桌面底座";
    this.connectedDeviceName = "LOOI 桌面底座";
    this.saveVault();
    return disconnecting;
  }

  public setSimulatedDock(docked: boolean): BodyStatusSnapshot {
    if (this.config.mode === "simulation" && this.simTransport) {
      this.simTransport.readValues.set("power", docked ? "6401" : "6400");
      this.simTransport.simulateDock(docked);
      void this.readPowerStatus().catch(() => {});
    }
    return this.status();
  }

  private performPowerRead(): Promise<LooiPowerStatus> {
    if (this.inFlightPowerRead) return this.inFlightPowerRead;
    const task = this.supervisor.readPowerStatus().finally(() => {
      if (this.inFlightPowerRead === task) {
        this.inFlightPowerRead = null;
      }
    });
    this.inFlightPowerRead = task;
    return task;
  }

  public async readPowerStatus(): Promise<BodyStatusSnapshot> {
    if (this.config.mode === "disabled") return this.status();
    const snap = this.supervisor.getSnapshot();
    if (snap.state === "disconnected" || snap.state === "fault") {
      return this.status();
    }
    try {
      await this.performPowerRead();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        !message.includes("cancelled") &&
        !message.includes("disconnected") &&
        !message.includes("not complete")
      ) {
        this.lastError = normalizeBodyErrorMessage(message);
      }
    }
    return this.status();
  }

  public async stop(reason: BodyStopRequest["reason"] = "user_stop"): Promise<BodyStatusSnapshot> {
    const stopGeneration = ++this.driveGeneration;
    this.driveFlushPromise = null;
    this.clearHeldDriveState();
    const previousStop = this.activeStop;
    let task!: Promise<void>;
    const rawStop =
      previousStop === null
        ? this.supervisor.stop(reason)
        : previousStop.then(async () => {
            if (stopGeneration === this.driveGeneration) {
              await this.supervisor.stop(reason);
            }
          });
    task = rawStop.finally(() => {
      if (this.activeStop === task) {
        this.activeStop = null;
      }
    });
    this.activeStop = task;
    await task;
    return this.status();
  }

  /**
   * Stepless 2D continuous drive session: acquires/renews a single motor lease,
   * coalesces high-frequency joystick updates to the latest signed `(speed, turn)`,
   * and maintains lease renewal while the thumb holds a non-zero vector.
   */
  public async setDriveVector(speed: number, turn: number): Promise<BodyStatusSnapshot> {
    const nextSpeed = clampSignedAxis(speed);
    const nextTurn = clampSignedAxis(turn);

    if (nextSpeed === 0 && nextTurn === 0 && !this.heldDrive && !this.driveFlushPromise) {
      this.desiredMotion = { speed: 0, turn: 0 };
      return this.status();
    }

    if (this.activeStop !== null && !this.driveFlushPromise) {
      ++this.driveGeneration;
    }

    this.desiredMotion = { speed: nextSpeed, turn: nextTurn };
    const generation = this.driveGeneration;
    this.pendingDriveWrite = true;

    if (!this.driveFlushPromise) {
      let run!: Promise<void>;
      run = (async () => {
        try {
          while (this.pendingDriveWrite && generation === this.driveGeneration) {
            if (this.activeStop) {
              await this.activeStop;
              if (generation !== this.driveGeneration) return;
            }
            this.pendingDriveWrite = false;
            const target = { ...this.desiredMotion };
            const snap = this.supervisor.getSnapshot();
            if (
              this.config.mode === "disabled" ||
              snap.state === "disconnected" ||
              snap.state === "fault"
            ) {
              this.clearHeldDriveState();
              throw new Error("@looi:body_not_connected");
            }

            const activeLease = this.supervisor.getActiveLease();
            const hasValidHeldLease =
              this.heldDrive !== null &&
              activeLease !== null &&
              activeLease.lease_id === this.heldDrive.lease_id &&
              activeLease.lease_epoch === this.heldDrive.lease_epoch;

            if (!hasValidHeldLease) {
              this.stopHeldDriveRenewTimer();
              this.heldDrive = null;
              if (target.speed === 0 && target.turn === 0) {
                this.activeMotion = { speed: 0, turn: 0 };
                break;
              }
              const lease = await this.supervisor.acquireLease({
                holder: "user_panel",
                primitive: dominantPrimitive(target.speed, target.turn),
                durationMs: 1500,
              });
              if (generation !== this.driveGeneration) {
                if (this.supervisor.getActiveLease()?.lease_id === lease.lease_id) {
                  await this.supervisor.stop("user_stop");
                }
                return;
              }
              this.heldDrive = lease;
            } else {
              this.supervisor.renewLease(this.heldDrive!, 1500);
            }

            await this.supervisor.setMotion(this.heldDrive!, target.speed, target.turn);
            if (generation !== this.driveGeneration) return;
            this.activeMotion = target;
            if (target.speed === 0 && target.turn === 0) {
              this.stopHeldDriveRenewTimer();
            } else {
              this.ensureHeldDriveRenewTimer(generation);
            }
          }
        } catch (error) {
          if (generation === this.driveGeneration) {
            this.clearHeldDriveState();
          }
          const rawMessage = error instanceof Error ? error.message : String(error);
          const normalized = normalizeBodyErrorMessage(rawMessage);
          if (
            !rawMessage.includes("cancelled") &&
            !rawMessage.includes("disconnected")
          ) {
            this.lastError = normalized;
          }
          throw new Error(normalized);
        } finally {
          if (this.driveFlushPromise === run) {
            this.driveFlushPromise = null;
          }
        }
      })();
      this.driveFlushPromise = run;
    }

    await this.driveFlushPromise;
    return this.status();
  }

  public async startDrive(action: "forward" | "backward" | "turn_left" | "turn_right"): Promise<BodyStatusSnapshot> {
    switch (action) {
      case "forward":
        return this.setDriveVector(127, 0);
      case "backward":
        return this.setDriveVector(-127, 0);
      case "turn_left":
        return this.setDriveVector(0, 127);
      case "turn_right":
        return this.setDriveVector(0, -127);
    }
  }

  public renewDrive(): boolean {
    if (!this.heldDrive) return false;
    try {
      this.supervisor.renewLease(this.heldDrive, 1500);
      return true;
    } catch {
      this.clearHeldDriveState();
      return false;
    }
  }

  private buildReceipt(
    action: BodyControlAction,
    status: BodyActionReceipt["status"],
    recordedAt: string,
    extra: {
      simulation?: boolean;
      isDocked?: boolean;
      durationMs?: number | null;
      stopCommandAt?: string | null;
      speed?: number;
      turn?: number;
      reason?: string;
    } = {},
  ): BodyActionReceipt {
    const snap = this.supervisor.getSnapshot();
    return {
      action,
      status,
      simulation: extra.simulation ?? (this.config.mode === "simulation"),
      isDocked: extra.isDocked ?? snap.isDocked,
      headDegrees: snap.headDegrees,
      lightOn: snap.lightOn,
      lightBrightness: snap.lightBrightness,
      powerStatus: snap.powerStatus,
      ...(extra.speed !== undefined ? { speed: extra.speed } : {}),
      ...(extra.turn !== undefined ? { turn: extra.turn } : {}),
      durationMs: extra.durationMs ?? null,
      stopCommandAt: extra.stopCommandAt ?? null,
      recordedAt,
      ...(extra.reason !== undefined ? { reason: extra.reason } : {}),
    };
  }

  public async control(
    input: BodyControlInput,
    holder = "user_panel",
  ): Promise<BodyActionReceipt> {
    this.nativeAdapter?.pumpEvents();
    const recordedAt = new Date().toISOString();
    const action = input.action;

    if (this.config.mode === "disabled") {
      return this.buildReceipt(action, "rejected", recordedAt, {
        simulation: false,
        isDocked: false,
        reason: "@looi:body_disabled",
      });
    }

    if (action === "stop") {
      await this.stop("user_stop");
      return this.buildReceipt(action, "verified", recordedAt, {
        durationMs: 0,
        stopCommandAt: new Date().toISOString(),
      });
    }

    if (this.activeStop) {
      await this.activeStop;
    }

    const snap = this.supervisor.getSnapshot();
    if (snap.state === "disconnected" || snap.state === "fault") {
      return this.buildReceipt(action, "rejected", recordedAt, {
        isDocked: false,
        reason: "@looi:body_not_connected",
      });
    }

    try {
      if (action === "read_power") {
        await this.performPowerRead();
        return this.buildReceipt(action, "verified", recordedAt);
      }

      if (action === "light_on") {
        if (typeof input.brightness === "number" && Number.isFinite(input.brightness)) {
          await this.supervisor.setLightBrightness(Math.max(1, Math.min(255, Math.round(input.brightness))));
        } else {
          await this.supervisor.setLight(true);
        }
        return this.buildReceipt(action, "verified", recordedAt);
      }

      if (action === "light_off") {
        await this.supervisor.setLight(false);
        return this.buildReceipt(action, "verified", recordedAt);
      }

      if (action === "light_set") {
        if (typeof input.brightness !== "number" || !Number.isFinite(input.brightness)) {
          throw new Error("@looi:body_light_invalid");
        }
        await this.supervisor.setLightBrightness(input.brightness);
        return this.buildReceipt(action, "verified", recordedAt);
      }

      if (action === "head_up" || action === "head_center" || action === "head_down") {
        const pose: HeadPayloadKey =
          action === "head_up" ? "up" : action === "head_down" ? "down" : "center";
        await this.supervisor.setHead(pose);
        return this.buildReceipt(action, "verified", recordedAt);
      }

      if (action === "head_set") {
        if (typeof input.headDegrees !== "number" || !Number.isFinite(input.headDegrees)) {
          throw new Error("@looi:body_head_invalid");
        }
        await this.supervisor.setHeadDegrees(input.headDegrees);
        return this.buildReceipt(action, "verified", recordedAt);
      }

      const boundedDuration = Math.max(
        50,
        Math.min(typeof input.durationMs === "number" ? Math.round(input.durationMs) : 350, 1200),
      );

      if (action === "move") {
        const speed = clampSignedAxis(input.speed);
        const turn = clampSignedAxis(input.turn);
        if (speed === 0 && turn === 0) {
          await this.stop("user_stop");
          return this.buildReceipt(action, "verified", recordedAt, {
            speed: 0,
            turn: 0,
            durationMs: 0,
            stopCommandAt: new Date().toISOString(),
          });
        }
        const obs = await this.supervisor.executePulse(
          {
            holder,
            primitive: dominantPrimitive(speed, turn),
            durationMs: boundedDuration,
          },
          60,
          { speed, turn },
        );
        return this.buildReceipt(action, "verified", recordedAt, {
          speed,
          turn,
          durationMs: boundedDuration,
          stopCommandAt: obs.stop_command_at,
        });
      }

      const obs = await this.supervisor.executePulse(
        {
          holder,
          primitive: action,
          durationMs: boundedDuration,
        },
        60,
      );
      return this.buildReceipt(action, "verified", recordedAt, {
        durationMs: boundedDuration,
        stopCommandAt: obs.stop_command_at,
      });
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : String(error);
      const message = normalizeBodyErrorMessage(rawMessage);
      if (rawMessage !== "Pulse preempted by stop: user_stop") this.lastError = message;
      return this.buildReceipt(action, "failed", recordedAt, { reason: message });
    }
  }

  public close(): void {
    ++this.driveGeneration;
    this.clearHeldDriveState();
    void this.disconnect();
    this.bleTransport?.dispose();
    this.nativeAdapter?.dispose();
    this.selfEventListeners.clear();
  }
}
