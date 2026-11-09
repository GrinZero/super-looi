import {
  type CharacteristicKey,
  LOOI_SERVICE_UUID,
  hexToBytes,
} from "./constants.js";

export interface LooiTransportWriteOptions {
  response?: boolean;
  expectedBytes?: number | null;
}

export interface LooiNotificationEvent {
  characteristic: CharacteristicKey;
  hex: string;
  bytes: Uint8Array;
}

export interface LooiDeviceCandidate {
  id: string;
  name: string;
  rssi: number | null;
}

export interface LooiConnectTarget {
  deviceId?: string;
  deviceName?: string;
  timeoutMs?: number;
  silent?: boolean;
}

export interface LooiBleTransport {
  isConnected(): boolean;
  connect(target?: LooiConnectTarget): Promise<void>;
  disconnect(): Promise<void>;
  scanCandidates?(timeoutMs?: number): Promise<LooiDeviceCandidate[]>;
  write(
    characteristic: CharacteristicKey,
    payloadHex: string,
    options?: LooiTransportWriteOptions
  ): Promise<void>;
  read(characteristic: CharacteristicKey): Promise<Uint8Array>;
  startNotifications(
    characteristic: CharacteristicKey,
    onValue: (event: LooiNotificationEvent) => void
  ): Promise<void>;
  onDisconnected?(callback: () => void): () => void;
}

/**
 * Adapter interface matching native BLE libraries across Android BLE and iOS CoreBluetooth.
 */
export interface NativeBleAdapter {
  scanCandidates?(serviceUuid: string, timeoutMs?: number): Promise<LooiDeviceCandidate[]>;
  scanAndConnect(serviceUuid: string, target?: LooiConnectTarget): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  writeCharacteristicWithResponse(charKey: CharacteristicKey, hexPayload: string): Promise<void>;
  writeCharacteristicWithoutResponse(charKey: CharacteristicKey, hexPayload: string): Promise<void>;
  readCharacteristic(charKey: CharacteristicKey): Promise<string>;
  monitorCharacteristic(
    charKey: CharacteristicKey,
    onData: (hexPayload: string) => void
  ): Promise<() => void>;
  onDisconnected(callback: () => void): () => void;
}

/**
 * Concrete CrossPlatformBleTransport wrapping any NativeBleAdapter.
 */
export class CrossPlatformBleTransport implements LooiBleTransport {
  private readonly disconnectListeners = new Set<() => void>();
  private adapterUnsubscribeDisconnect?: () => void;
  private readonly notifications = new Map<CharacteristicKey, () => void>();
  private readonly notificationTickets = new Map<CharacteristicKey, number>();
  private nextTicket = 0;
  private disposed = false;
  private disconnecting = false;
  private connecting = false;
  private connectionGeneration = 0;
  private disconnectPromise?: Promise<void>;

  constructor(private readonly adapter: NativeBleAdapter) {
    this.adapterUnsubscribeDisconnect = this.adapter.onDisconnected(() => {
      ++this.connectionGeneration;
      this.clearNotifications();
      for (const listener of this.disconnectListeners) {
        listener();
      }
    });
  }

  public isConnected(): boolean {
    return !this.disposed && !this.disconnecting && this.adapter.isConnected();
  }

  public async scanCandidates(timeoutMs = 3500): Promise<LooiDeviceCandidate[]> {
    if (this.disposed) throw new Error("BLE transport disposed");
    if (!this.adapter.scanCandidates) return [];
    return this.adapter.scanCandidates(LOOI_SERVICE_UUID, timeoutMs);
  }

  public async connect(target?: LooiConnectTarget): Promise<void> {
    if (this.disposed) throw new Error("BLE transport disposed");
    if (this.disconnecting || this.connecting) throw new Error("BLE connection transition in progress");
    const generation = ++this.connectionGeneration;
    this.connecting = true;
    try {
      await this.adapter.scanAndConnect(LOOI_SERVICE_UUID, target);
      if (this.disposed || this.disconnecting || generation !== this.connectionGeneration) {
        await this.adapter.disconnect();
        throw new Error("BLE connection cancelled");
      }
    } finally { this.connecting = false; }
  }

  public async disconnect(): Promise<void> {
    if (this.disconnectPromise) return this.disconnectPromise;
    ++this.connectionGeneration;
    this.disconnecting = true;
    this.clearNotifications();
    this.disconnectPromise = Promise.resolve().then(() => this.adapter.disconnect()).finally(() => {
      this.clearNotifications(); this.disconnecting = false; this.disconnectPromise = undefined;
    });
    return this.disconnectPromise;
  }

  public async write(
    characteristic: CharacteristicKey,
    payloadHex: string,
    options: LooiTransportWriteOptions = {}
  ): Promise<void> {
    if (!this.isConnected()) throw new Error("BLE transport disconnected");
    if (options.response === false) {
      await this.adapter.writeCharacteristicWithoutResponse(characteristic, payloadHex);
    } else {
      await this.adapter.writeCharacteristicWithResponse(characteristic, payloadHex);
    }
  }

  public async read(characteristic: CharacteristicKey): Promise<Uint8Array> {
    if (!this.isConnected()) throw new Error("BLE transport disconnected");
    return hexToBytes(await this.adapter.readCharacteristic(characteristic));
  }

  public async startNotifications(
    characteristic: CharacteristicKey,
    onValue: (event: LooiNotificationEvent) => void
  ): Promise<void> {
    if (this.disposed || !this.isConnected()) throw new Error("BLE transport disconnected");
    const ticket = ++this.nextTicket;
    this.notificationTickets.set(characteristic, ticket);
    this.notifications.get(characteristic)?.();
    this.notifications.delete(characteristic);
    try {
    const unsubscribe = await this.adapter.monitorCharacteristic(characteristic, (hex) => {
      if (this.disposed || !this.isConnected() || this.notificationTickets.get(characteristic) !== ticket) return;
      onValue({
        characteristic,
        hex,
        bytes: hexToBytes(hex),
      });
    });
    if (this.disposed || !this.isConnected() || this.notificationTickets.get(characteristic) !== ticket) unsubscribe();
    else this.notifications.set(characteristic, unsubscribe);
    } catch (error) {
      if (this.notificationTickets.get(characteristic) === ticket) this.notificationTickets.delete(characteristic);
      throw error;
    }
  }

  public onDisconnected(callback: () => void): () => void {
    this.disconnectListeners.add(callback);
    return () => {
      this.disconnectListeners.delete(callback);
    };
  }

  public dispose(): void {
    this.disposed = true;
    ++this.connectionGeneration;
    this.clearNotifications();
    this.adapterUnsubscribeDisconnect?.();
    this.disconnectListeners.clear();
  }
  private clearNotifications(): void {
    this.notificationTickets.clear();
    for (const unsubscribe of this.notifications.values()) {
      try { unsubscribe(); } catch { /* Finish invalidating every old callback. */ }
    }
    this.notifications.clear();
  }
}

/**
 * Simulated in-memory BLE transport for tests and simulator environments.
 */
export class SimulatedBleTransport implements LooiBleTransport {
  public connected = false;
  public connectedTarget: LooiConnectTarget | null = null;
  public candidates: LooiDeviceCandidate[] = [
    { id: "sim-looi-dock-01", name: "LOOI 桌面底座", rssi: -42 },
  ];
  public writtenCommands: Array<{
    characteristic: CharacteristicKey;
    payload: string;
    options?: LooiTransportWriteOptions;
  }> = [];
  public notificationListeners = new Map<CharacteristicKey, (event: LooiNotificationEvent) => void>();
  public readValues = new Map<CharacteristicKey, string>([["power", "6400"]]);
  private readonly disconnectListeners = new Set<() => void>();
  private failNextWritesCount = 0;

  public isConnected(): boolean {
    return this.connected;
  }

  public async scanCandidates(): Promise<LooiDeviceCandidate[]> {
    return [...this.candidates];
  }

  public async connect(target?: LooiConnectTarget): Promise<void> {
    this.connected = true;
    const defaultCandidate = this.candidates[0];
    this.connectedTarget = target ?? {
      deviceId: defaultCandidate?.id ?? "sim-looi-dock-01",
      deviceName: defaultCandidate?.name ?? "LOOI 桌面底座",
    };
  }

  public async disconnect(): Promise<void> {
    this.connected = false;
    this.connectedTarget = null;
  }

  public async write(
    characteristic: CharacteristicKey,
    payloadHex: string,
    options?: LooiTransportWriteOptions
  ): Promise<void> {
    if (!this.connected) {
      throw new Error("GATT Error: device not connected");
    }

    if (this.failNextWritesCount > 0) {
      this.failNextWritesCount--;
      throw new Error("Simulated transient GATT write failure");
    }

    this.writtenCommands.push({ characteristic, payload: payloadHex, options });
  }

  public async read(characteristic: CharacteristicKey): Promise<Uint8Array> {
    if (!this.connected) throw new Error("GATT Error: device not connected");
    const hex = this.readValues.get(characteristic);
    if (hex === undefined) throw new Error(`No simulated value for ${characteristic}`);
    return hexToBytes(hex);
  }

  public async startNotifications(
    characteristic: CharacteristicKey,
    onValue: (event: LooiNotificationEvent) => void
  ): Promise<void> {
    this.notificationListeners.set(characteristic, onValue);
  }

  public onDisconnected(callback: () => void): () => void {
    this.disconnectListeners.add(callback);
    return () => {
      this.disconnectListeners.delete(callback);
    };
  }

  public simulateGattErrorNext(nTimes: number): void {
    this.failNextWritesCount = nTimes;
  }

  public emitNotification(characteristic: CharacteristicKey, hex: string): void {
    const listener = this.notificationListeners.get(characteristic);
    if (listener) {
      listener({ characteristic, hex, bytes: hexToBytes(hex) });
    }
  }

  public simulateDock(docked: boolean): void {
    this.emitNotification("dockNotify", docked ? "05" : "06");
  }

  public emitUnexpectedDisconnect(): void {
    this.connected = false;
    this.connectedTarget = null;
    for (const listener of this.disconnectListeners) {
      listener();
    }
  }
}
