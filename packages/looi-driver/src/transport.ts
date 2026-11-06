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

export interface LooiBleTransport {
  isConnected(): boolean;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  write(
    characteristic: CharacteristicKey,
    payloadHex: string,
    options?: LooiTransportWriteOptions
  ): Promise<void>;
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
  scanAndConnect(serviceUuid: string): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  writeCharacteristicWithResponse(charKey: CharacteristicKey, hexPayload: string): Promise<void>;
  writeCharacteristicWithoutResponse(charKey: CharacteristicKey, hexPayload: string): Promise<void>;
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

  constructor(private readonly adapter: NativeBleAdapter) {
    this.adapterUnsubscribeDisconnect = this.adapter.onDisconnected(() => {
      for (const listener of this.disconnectListeners) {
        listener();
      }
    });
  }

  public isConnected(): boolean {
    return this.adapter.isConnected();
  }

  public async connect(): Promise<void> {
    await this.adapter.scanAndConnect(LOOI_SERVICE_UUID);
  }

  public async disconnect(): Promise<void> {
    await this.adapter.disconnect();
  }

  public async write(
    characteristic: CharacteristicKey,
    payloadHex: string,
    options: LooiTransportWriteOptions = {}
  ): Promise<void> {
    if (options.response === false) {
      await this.adapter.writeCharacteristicWithoutResponse(characteristic, payloadHex);
    } else {
      await this.adapter.writeCharacteristicWithResponse(characteristic, payloadHex);
    }
  }

  public async startNotifications(
    characteristic: CharacteristicKey,
    onValue: (event: LooiNotificationEvent) => void
  ): Promise<void> {
    await this.adapter.monitorCharacteristic(characteristic, (hex) => {
      onValue({
        characteristic,
        hex,
        bytes: hexToBytes(hex),
      });
    });
  }

  public onDisconnected(callback: () => void): () => void {
    this.disconnectListeners.add(callback);
    return () => {
      this.disconnectListeners.delete(callback);
    };
  }

  public dispose(): void {
    this.adapterUnsubscribeDisconnect?.();
    this.disconnectListeners.clear();
  }
}

/**
 * Simulated in-memory BLE transport for tests and simulator environments.
 */
export class SimulatedBleTransport implements LooiBleTransport {
  public connected = false;
  public writtenCommands: Array<{
    characteristic: CharacteristicKey;
    payload: string;
    options?: LooiTransportWriteOptions;
  }> = [];
  public notificationListeners = new Map<CharacteristicKey, (event: LooiNotificationEvent) => void>();
  private readonly disconnectListeners = new Set<() => void>();
  private failNextWritesCount = 0;

  public isConnected(): boolean {
    return this.connected;
  }

  public async connect(): Promise<void> {
    this.connected = true;
  }

  public async disconnect(): Promise<void> {
    this.connected = false;
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

  public emitUnexpectedDisconnect(): void {
    this.connected = false;
    for (const listener of this.disconnectListeners) {
      listener();
    }
  }
}
