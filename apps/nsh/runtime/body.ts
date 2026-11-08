import type { BodyStopRequest, BodySupervisorState, SelfEventWindow } from "@super-looi/contracts";
import {
  BodySupervisor,
  CrossPlatformBleTransport,
  SimulatedBleTransport,
  type CharacteristicKey,
  type HeadPayloadKey,
  type LooiConnectTarget,
  type LooiDeviceCandidate,
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

export interface BodyStatusSnapshot {
  mode: BodyConnectionMode;
  simulation: boolean;
  permission: "granted" | "denied" | "undetermined" | "unavailable";
  supervisorState: BodySupervisorState;
  connected: boolean;
  isDocked: boolean;
  lightOn: boolean;
  headPose: HeadPayloadKey;
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
  | "forward"
  | "backward"
  | "turn_left"
  | "turn_right"
  | "light_on"
  | "light_off"
  | "stop";

export interface BodyControlInput {
  action: BodyControlAction;
  durationMs?: number;
}

export interface BodyActionReceipt {
  action: BodyControlAction;
  status: "verified" | "rejected" | "failed";
  simulation: boolean;
  isDocked: boolean;
  headDegrees: number;
  lightOn: boolean;
  durationMs: number | null;
  stopCommandAt: string | null;
  recordedAt: string;
  reason?: string;
}

export interface NativeBlePort {
  permission(): string;
  requestPermission(): string;
  startScan(): void;
  stopScan(): void;
  scannedDevices(): Array<{ id: string; name: string; rssi: number }>;
  connect(deviceId: string): void;
  disconnect(): void;
  write(characteristic: string, hexPayload: string, withResponse: boolean): void;
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

  public async scanCandidates(_serviceUuid: string, timeoutMs = 1200): Promise<LooiDeviceCandidate[]> {
    await this.ensurePermission();
    this.port.startScan();
    try {
      await new Promise((resolve) => setTimeout(resolve, Math.max(100, timeoutMs)));
      return this.port.scannedDevices().map((d) => ({
        id: d.id,
        name: d.name || "LOOI 桌面底座",
        rssi: typeof d.rssi === "number" ? d.rssi : null,
      }));
    } finally {
      this.port.stopScan();
    }
  }

  public async scanAndConnect(serviceUuid: string, target?: LooiConnectTarget): Promise<void> {
    await this.ensurePermission();
    let deviceId = target?.deviceId?.trim() ?? "";
    if (!deviceId) {
      const found = await this.scanCandidates(serviceUuid, 1200);
      found.sort((a, b) => (b.rssi ?? -100) - (a.rssi ?? -100));
      deviceId = found[0]?.id ?? "";
    }
    if (!deviceId) {
      throw new Error("附近未发现可用的 LOOI 底座");
    }

    this.port.connect(deviceId);
    this.startPolling();

    const deadline = Date.now() + 4500;
    while (Date.now() < deadline) {
      this.pumpEvents();
      const st = this.port.status();
      if (this.connectedFlag || st.state === "connected") {
        this.connectedFlag = true;
        return;
      }
      if (st.state === "error" || (st.state === "disconnected" && st.error)) {
        this.stopPolling();
        throw new Error(st.error || "无法连接到 LOOI 底座");
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    this.port.disconnect();
    this.stopPolling();
    throw new Error("连接 LOOI 底座超时");
  }

  public async disconnect(): Promise<void> {
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
    this.port.write(charKey, hexPayload, true);
    this.pumpEvents();
  }

  public async writeCharacteristicWithoutResponse(
    charKey: CharacteristicKey,
    hexPayload: string,
  ): Promise<void> {
    this.port.write(charKey, hexPayload, false);
    this.pumpEvents();
  }

  public async monitorCharacteristic(
    charKey: CharacteristicKey,
    onData: (hexPayload: string) => void,
  ): Promise<() => void> {
    let set = this.notificationListeners.get(charKey);
    if (!set) {
      set = new Set();
      this.notificationListeners.set(charKey, set);
    }
    set.add(onData);
    this.startPolling();
    const cached = this.lastNotification.get(charKey);
    if (cached !== undefined) {
      onData(cached);
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
      }
    }
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
  private connectedDeviceId: string | null = null;
  private connectedDeviceName = "LOOI 桌面底座";
  private lastError: string | null = null;
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
        this.simTransport?.simulateDock(true);
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

  private buildSupervisorForMode(mode: BodyConnectionMode): BodySupervisor {
    this.bleTransport?.dispose();
    this.bleTransport = null;
    this.nativeAdapter?.dispose();
    this.nativeAdapter = null;
    this.simTransport = null;

    if (mode === "real_ble" && this.nativePort) {
      this.nativeAdapter = new NshNativeBleAdapter(this.nativePort);
      this.bleTransport = new CrossPlatformBleTransport(this.nativeAdapter);
      return new BodySupervisor(this.bleTransport, {
        onSelfEvent: (win) => {
          for (const listener of this.selfEventListeners) listener(win);
        },
        onError: (err) => {
          this.lastError = err.message;
        },
      });
    }

    const sim = new SimulatedBleTransport();
    sim.candidates = [...DEFAULT_SIM_CANDIDATES];
    this.simTransport = sim;
    return new BodySupervisor(sim, {
      onSelfEvent: (win) => {
        for (const listener of this.selfEventListeners) listener(win);
      },
      onError: (err) => {
        this.lastError = err.message;
      },
    });
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
        this.simTransport?.simulateDock(true);
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

  public async scan(timeoutMs = 1200): Promise<BodyStatusSnapshot> {
    if (this.config.mode === "disabled") {
      return this.status();
    }
    this.lastError = null;
    this.scanning = true;
    this.scanCompleted = false;
    this.candidates = [];
    try {
      if (this.config.mode === "simulation") {
        this.candidates = [...DEFAULT_SIM_CANDIDATES];
        this.scanCompleted = true;
      } else if (!this.nativeAdapter) {
        this.lastError = "当前环境不支持蓝牙扫描，可切换至模拟体验";
      } else {
        this.candidates = await this.nativeAdapter.scanCandidates("", timeoutMs);
        this.scanCompleted = true;
      }
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    } finally {
      this.scanning = false;
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

    if (this.config.mode === "real_ble" && !this.nativeAdapter) {
      this.lastError = "当前设备蓝牙不可用，可切换至模拟体验";
      return this.status();
    }

    this.connecting = true;
    try {
      const snap = this.supervisor.getSnapshot();
      if (snap.state !== "disconnected" && snap.state !== "fault") {
        await this.supervisor.disconnect();
      }
      await this.supervisor.connect(new Date(), 2, {
        deviceId: resolvedId || undefined,
        deviceName: resolvedName,
      });
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
        this.simTransport?.simulateDock(true);
      }
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    } finally {
      this.connecting = false;
    }
    return this.status();
  }

  public async disconnect(): Promise<BodyStatusSnapshot> {
    this.lastError = null;
    try {
      await this.supervisor.disconnect();
    } catch {
      // Ignore disconnect errors during teardown
    }
    this.connectedDeviceId = null;
    return this.status();
  }

  public setSimulatedDock(docked: boolean): BodyStatusSnapshot {
    if (this.config.mode === "simulation" && this.simTransport) {
      this.simTransport.simulateDock(docked);
    }
    return this.status();
  }

  public async stop(reason: BodyStopRequest["reason"] = "user_stop"): Promise<BodyStatusSnapshot> {
    await this.supervisor.stop(reason);
    return this.status();
  }

  public async control(
    input: BodyControlInput,
    holder = "user_panel",
  ): Promise<BodyActionReceipt> {
    this.nativeAdapter?.pumpEvents();
    const recordedAt = new Date().toISOString();
    const simulation = this.config.mode === "simulation";
    const action = input.action;

    if (this.config.mode === "disabled") {
      return {
        action,
        status: "rejected",
        simulation: false,
        isDocked: false,
        headDegrees: this.supervisor.getHeadDegrees(),
        lightOn: this.supervisor.getLightOn(),
        durationMs: null,
        stopCommandAt: null,
        recordedAt,
        reason: "底座处于未启用状态",
      };
    }

    if (action === "stop") {
      await this.supervisor.stop("user_stop");
      return {
        action,
        status: "verified",
        simulation,
        isDocked: this.supervisor.getIsDocked(),
        headDegrees: this.supervisor.getHeadDegrees(),
        lightOn: this.supervisor.getLightOn(),
        durationMs: 0,
        stopCommandAt: new Date().toISOString(),
        recordedAt,
      };
    }

    const snap = this.supervisor.getSnapshot();
    if (snap.state === "disconnected" || snap.state === "fault") {
      return {
        action,
        status: "rejected",
        simulation,
        isDocked: false,
        headDegrees: snap.headDegrees,
        lightOn: snap.lightOn,
        durationMs: null,
        stopCommandAt: null,
        recordedAt,
        reason: "底座尚未连接",
      };
    }

    try {
      if (action === "light_on" || action === "light_off") {
        await this.supervisor.setLight(action === "light_on");
        return {
          action,
          status: "verified",
          simulation,
          isDocked: this.supervisor.getIsDocked(),
          headDegrees: this.supervisor.getHeadDegrees(),
          lightOn: this.supervisor.getLightOn(),
          durationMs: null,
          stopCommandAt: null,
          recordedAt,
        };
      }

      if (!this.supervisor.getIsDocked()) {
        return {
          action,
          status: "rejected",
          simulation,
          isDocked: false,
          headDegrees: this.supervisor.getHeadDegrees(),
          lightOn: this.supervisor.getLightOn(),
          durationMs: null,
          stopCommandAt: null,
          recordedAt,
          reason: "请先将手机放上底座",
        };
      }

      if (action === "head_up" || action === "head_center" || action === "head_down") {
        const pose: HeadPayloadKey =
          action === "head_up" ? "up" : action === "head_down" ? "down" : "center";
        await this.supervisor.setHead(pose);
        return {
          action,
          status: "verified",
          simulation,
          isDocked: this.supervisor.getIsDocked(),
          headDegrees: this.supervisor.getHeadDegrees(),
          lightOn: this.supervisor.getLightOn(),
          durationMs: null,
          stopCommandAt: null,
          recordedAt,
        };
      }

      const boundedDuration = Math.max(
        50,
        Math.min(typeof input.durationMs === "number" ? Math.round(input.durationMs) : 350, 1200),
      );
      const obs = await this.supervisor.executePulse(
        {
          holder,
          primitive: action,
          durationMs: boundedDuration,
        },
        60,
      );
      return {
        action,
        status: "verified",
        simulation,
        isDocked: this.supervisor.getIsDocked(),
        headDegrees: this.supervisor.getHeadDegrees(),
        lightOn: this.supervisor.getLightOn(),
        durationMs: boundedDuration,
        stopCommandAt: obs.stop_command_at,
        recordedAt,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = message;
      return {
        action,
        status: "failed",
        simulation,
        isDocked: this.supervisor.getIsDocked(),
        headDegrees: this.supervisor.getHeadDegrees(),
        lightOn: this.supervisor.getLightOn(),
        durationMs: null,
        stopCommandAt: null,
        recordedAt,
        reason: message,
      };
    }
  }

  public close(): void {
    void this.disconnect();
    this.bleTransport?.dispose();
    this.nativeAdapter?.dispose();
    this.selfEventListeners.clear();
  }
}
