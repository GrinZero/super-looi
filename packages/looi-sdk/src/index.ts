const DEFAULT_INIT_TIME_HEX = "4132303236203036203234203030203535203432";

const LOOI_SERVICE_UUID = "000000ff-0000-1000-8000-00805f9b34fb" as const;

const INTERNAL_CHARACTERISTICS = Object.freeze({
  drive: "0000fed0-0000-1000-8000-00805f9b34fb",
  head: "0000fed1-0000-1000-8000-00805f9b34fb",
  light: "0000fed2-0000-1000-8000-00805f9b34fb",
  dockNotify: "0000fed9-0000-1000-8000-00805f9b34fb",
  handshakeControl: "0000feda-0000-1000-8000-00805f9b34fb",
  handshakeData: "0000fef0-0000-1000-8000-00805f9b34fb",
  rawFe00: "0000fe00-0000-1000-8000-00805f9b34fb",
});

const RAW_CHARACTERISTIC_ALIASES = Object.freeze({
  fed0: "drive",
  fed1: "head",
  fed2: "light",
  fed9: "dockNotify",
  feda: "handshakeControl",
  fef0: "handshakeData",
  fe00: "rawFe00",
} as const);

const MOVE_PAYLOADS = Object.freeze({
  forward: "7707",
  left: "047a",
  back: "86fc",
  right: "0082",
  stop: "0000",
});

const HEAD_PAYLOADS = Object.freeze({
  up: "00",
  center: "87",
  down: "ff",
});

const LIGHT_PAYLOADS = Object.freeze({
  on: "01",
  off: "00",
});

const DOCK_STATUS_HEX = Object.freeze({
  docked: "05",
  undocked: "06",
});

const HANDSHAKE_SEQUENCE = Object.freeze([
  { characteristic: "handshakeControl", payload: "03", response: true, expectedBytes: 1 },
  { characteristic: "handshakeData", payload: DEFAULT_INIT_TIME_HEX, response: true, expectedBytes: 20 },
  { characteristic: "handshakeControl", payload: "8101", response: true, expectedBytes: 2 },
] as const);

type InternalCharacteristicKey = keyof typeof INTERNAL_CHARACTERISTICS;
type RawCharacteristicAlias = keyof typeof RAW_CHARACTERISTIC_ALIASES;

/** LOOI 支持的高层移动方向。 */
export type LooiMoveDirection = keyof typeof MOVE_PAYLOADS;

/** LOOI 支持的高层头部方向。 */
export type LooiHeadDirection = keyof typeof HEAD_PAYLOADS;

/** 低层写入时可选的写入参数。 */
export type LooiWriteOptions = {
  response?: boolean;
  expectedBytes?: number | null;
};

/** SDK 统一透传的底层通知事件。 */
export type LooiRawNotification = {
  characteristic: RawCharacteristicAlias;
  hex: string;
  bytes: Uint8Array;
};

/** SDK 抽象出的吸附状态事件。 */
export type LooiDockEvent = {
  docked: boolean;
  hex: string;
  bytes: Uint8Array;
};

/** 连接时可注册的回调。 */
export type LooiConnectOptions = {
  initTimeHex?: string;
  onDock?: (event: LooiDockEvent) => void;
  onRawNotify?: (event: LooiRawNotification) => void;
  handshake?: boolean;
  forceHandshake?: boolean;
};

/** 机器人实例的行为参数。 */
export type LooiRobotOptions = {
  driveIntervalMs?: number;
};

/** 适配层需要实现的最小 BLE 能力。 */
export interface LooiTransport {
  connect(): Promise<void>;
  disconnect?(): Promise<void>;
  startNotifications?(
    characteristicKey: InternalCharacteristicKey,
    onValue?: (event: {
      characteristic: InternalCharacteristicKey;
      hex: string;
      bytes: Uint8Array;
    }) => void,
  ): Promise<void>;
  write(
    characteristicKey: InternalCharacteristicKey,
    payloadHex: string,
    options?: LooiWriteOptions,
  ): Promise<void>;
}

/** 将十六进制字符串标准化，并在需要时校验字节长度。 */
export function normalizeHex(raw: string, expectedBytes: number | null = null): string {
  const clean = String(raw).replace(/\s+/g, "").trim().toLowerCase();
  if (!clean || clean.length % 2 !== 0 || /[^0-9a-f]/i.test(clean)) {
    throw new Error(`Invalid hex payload: ${raw}`);
  }
  if (expectedBytes !== null && clean.length !== expectedBytes * 2) {
    throw new Error(`Expected ${expectedBytes} bytes, got ${clean.length / 2}: ${raw}`);
  }
  return clean;
}

/** 将十六进制字符串编码成字节数组。 */
export function hexToBytes(raw: string, expectedBytes: number | null = null): Uint8Array {
  const clean = normalizeHex(raw, expectedBytes);
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < clean.length; i += 2) {
    bytes[i / 2] = Number.parseInt(clean.slice(i, i + 2), 16);
  }
  return bytes;
}

/** 将字节数组编码成小写十六进制字符串。 */
export function bytesToHex(bytes: Uint8Array | ArrayLike<number>): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

/** 生成 LOOI 握手所需的 20 字节时间字符串。 */
export function createInitTimeHex(date: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const ascii = `A${date.getFullYear()} ${pad(date.getMonth() + 1)} ${pad(date.getDate())} ${pad(date.getHours())} ${pad(date.getMinutes())} ${pad(date.getSeconds())}`;
  return Array.from(ascii, (char) => char.charCodeAt(0).toString(16).padStart(2, "0")).join("");
}

function toRawAlias(characteristic: InternalCharacteristicKey): RawCharacteristicAlias {
  const pair = Object.entries(RAW_CHARACTERISTIC_ALIASES).find(([, value]) => value === characteristic);
  if (!pair) {
    throw new Error(`No public alias for characteristic: ${characteristic}`);
  }
  return pair[0] as RawCharacteristicAlias;
}

function toInternalCharacteristic(characteristic: string): InternalCharacteristicKey {
  const normalized = characteristic.trim().toLowerCase();
  const alias = RAW_CHARACTERISTIC_ALIASES[normalized as RawCharacteristicAlias];
  if (!alias) {
    throw new Error(`Unsupported raw characteristic key: ${characteristic}`);
  }
  return alias;
}

function toDockEvent(event: LooiRawNotification): LooiDockEvent | null {
  if (event.characteristic !== "fed9") {
    return null;
  }
  if (event.hex === DOCK_STATUS_HEX.docked) {
    return { docked: true, hex: event.hex, bytes: event.bytes };
  }
  if (event.hex === DOCK_STATUS_HEX.undocked) {
    return { docked: false, hex: event.hex, bytes: event.bytes };
  }
  return null;
}

/** LOOI 机器人的高层控制客户端。 */
export class LooiRobot {
  transport: LooiTransport;
  driveIntervalMs: number;
  driveTimer: ReturnType<typeof setInterval> | null;
  private handshakeComplete: boolean;
  private onDock?: (event: LooiDockEvent) => void;
  private onRawNotify?: (event: LooiRawNotification) => void;

  /** 创建一个基于 transport 的机器人客户端。 */
  constructor(transport: LooiTransport, options: LooiRobotOptions = {}) {
    if (!transport) {
      throw new Error("LooiRobot requires a BLE transport adapter.");
    }
    this.transport = transport;
    this.driveIntervalMs = options.driveIntervalMs ?? 110;
    this.driveTimer = null;
    this.handshakeComplete = false;
    this.onDock = undefined;
    this.onRawNotify = undefined;
  }

  /** 连接机器人，并默认立即执行握手与通知订阅。 */
  async connect(options: LooiConnectOptions = {}): Promise<void> {
    this.onDock = options.onDock;
    this.onRawNotify = options.onRawNotify;
    await this.transport.connect();
    if (options.handshake !== false) {
      await this.handshake(options);
    }
  }

  /** 断开连接，并停止持续移动循环。 */
  async disconnect(): Promise<void> {
    this.stopMoveLoop({ writeStop: false });
    this.handshakeComplete = false;
    await this.transport.disconnect?.();
  }

  /** 手动重放握手流程。 */
  async handshake(options: Pick<LooiConnectOptions, "initTimeHex" | "forceHandshake"> = {}): Promise<void> {
    if (this.handshakeComplete && !options.forceHandshake) {
      return;
    }

    await this.transport.startNotifications?.("dockNotify", (event) => {
      const rawEvent: LooiRawNotification = {
        characteristic: toRawAlias(event.characteristic),
        hex: event.hex,
        bytes: event.bytes,
      };
      this.onRawNotify?.(rawEvent);
      const dockEvent = toDockEvent(rawEvent);
      if (dockEvent) {
        this.onDock?.(dockEvent);
      }
    });

    await this.transport.startNotifications?.("handshakeData", (event) => {
      this.onRawNotify?.({
        characteristic: toRawAlias(event.characteristic),
        hex: event.hex,
        bytes: event.bytes,
      });
    });

    for (const write of HANDSHAKE_SEQUENCE) {
      const payload = write.characteristic === "handshakeData"
        ? options.initTimeHex ?? createInitTimeHex()
        : write.payload;
      await this.transport.write(write.characteristic, payload, {
        response: write.response,
        expectedBytes: write.expectedBytes,
      });
    }

    this.handshakeComplete = true;
  }

  /** 发送一帧高层移动命令。 */
  async move(direction: LooiMoveDirection): Promise<void> {
    const payload = MOVE_PAYLOADS[direction];
    if (!payload) {
      throw new Error(`Unknown move direction: ${direction}`);
    }
    await this.transport.write("drive", payload, { response: false, expectedBytes: 2 });
  }

  /** 开启持续移动循环，适合外部轮盘或长按按钮驱动。 */
  startMoveLoop(direction: LooiMoveDirection): void {
    this.stopMoveLoop({ writeStop: false });
    void this.move(direction);
    this.driveTimer = setInterval(() => {
      void this.move(direction);
    }, this.driveIntervalMs);
  }

  /** 停止持续移动循环，并按需补一帧 stop。 */
  stopMoveLoop(options: { writeStop?: boolean } = {}): void {
    const { writeStop = true } = options;
    if (this.driveTimer) {
      clearInterval(this.driveTimer);
      this.driveTimer = null;
    }
    if (writeStop) {
      void this.stop();
    }
  }

  /** 发送停止移动指令。 */
  async stop(): Promise<void> {
    await this.transport.write("drive", MOVE_PAYLOADS.stop, { response: false, expectedBytes: 2 });
  }

  /** 设置头部方向，支持高层方向名、数值或直接 hex。 */
  async setHead(direction: LooiHeadDirection | number | string): Promise<void> {
    const payload = typeof direction === "string" && direction in HEAD_PAYLOADS
      ? HEAD_PAYLOADS[direction as LooiHeadDirection]
      : typeof direction === "number"
        ? direction.toString(16).padStart(2, "0")
        : direction;
    await this.transport.write("head", payload, { response: false, expectedBytes: 1 });
  }

  /** 控制灯光开关。 */
  async setLight(enabled: boolean): Promise<void> {
    await this.transport.write("light", enabled ? LIGHT_PAYLOADS.on : LIGHT_PAYLOADS.off, {
      response: true,
      expectedBytes: 1,
    });
  }

  /** 向指定低层 characteristic 直接写入 hex 数据。 */
  async writeRaw(characteristic: RawCharacteristicAlias, payloadHex: string, options: LooiWriteOptions = {}): Promise<void> {
    await this.transport.write(toInternalCharacteristic(characteristic), payloadHex, options);
  }
}

type WebBluetoothRequestDeviceOptions = {
  filters: Array<{ name?: string }>;
  optionalServices?: string[];
};

type WebBluetoothLike = {
  requestDevice(options: WebBluetoothRequestDeviceOptions): Promise<WebBluetoothDevice>;
};

type WebBluetoothDevice = {
  gatt?: WebBluetoothRemoteGATT | null;
};

type WebBluetoothRemoteGATT = {
  connected: boolean;
  connect(): Promise<WebBluetoothRemoteGATTServer>;
  disconnect(): void;
};

type WebBluetoothRemoteGATTServer = {
  connected: boolean;
  getPrimaryService(service: string): Promise<WebBluetoothRemoteGATTService>;
};

type WebBluetoothRemoteGATTService = {
  getCharacteristic(characteristic: string): Promise<WebBluetoothRemoteGATTCharacteristic>;
};

type WebBluetoothRemoteGATTCharacteristic = EventTarget & {
  value?: DataView | null;
  startNotifications(): Promise<WebBluetoothRemoteGATTCharacteristic>;
  writeValueWithResponse(value: Uint8Array): Promise<void>;
  writeValueWithoutResponse?(value: Uint8Array): Promise<void>;
};

type WebBluetoothTransportOptions = {
  bluetooth?: WebBluetoothLike;
  device?: WebBluetoothDevice | null;
};

/** 基于 Web Bluetooth 的浏览器适配层。 */
export class WebBluetoothLooiTransport implements LooiTransport {
  bluetooth?: WebBluetoothLike;
  device: WebBluetoothDevice | null;
  server: WebBluetoothRemoteGATTServer | null;
  service: WebBluetoothRemoteGATTService | null;
  characteristics: Map<InternalCharacteristicKey, WebBluetoothRemoteGATTCharacteristic>;
  private notificationHandlers: Map<InternalCharacteristicKey, EventListener>;

  /** 创建浏览器 BLE 适配器。 */
  constructor(options: WebBluetoothTransportOptions = {}) {
    this.bluetooth = options.bluetooth ?? ((globalThis.navigator as Navigator & { bluetooth?: WebBluetoothLike } | undefined)?.bluetooth);
    this.device = options.device ?? null;
    this.server = null;
    this.service = null;
    this.characteristics = new Map();
    this.notificationHandlers = new Map();
  }

  /** 建立 GATT 连接并缓存 SDK 需要的特征值。 */
  async connect(): Promise<void> {
    if (!this.bluetooth) {
      throw new Error("Web Bluetooth is not available in this runtime.");
    }

    if (!this.device) {
      this.device = await this.bluetooth.requestDevice({
        filters: [{ name: "LOOI Robot" }],
        optionalServices: [LOOI_SERVICE_UUID],
      });
    }

    this.server = await this.device.gatt?.connect() ?? null;
    if (!this.server) {
      throw new Error("Failed to open GATT server for LOOI Robot.");
    }

    this.service = await this.server.getPrimaryService(LOOI_SERVICE_UUID);
    await Promise.all(
      (Object.entries(INTERNAL_CHARACTERISTICS) as Array<[InternalCharacteristicKey, string]>).map(async ([key, uuid]) => {
        const characteristic = await this.service?.getCharacteristic(uuid);
        if (!characteristic) {
          throw new Error(`Characteristic lookup failed: ${key}`);
        }
        this.characteristics.set(key, characteristic);
      }),
    );
  }

  /** 断开当前 GATT 连接。 */
  async disconnect(): Promise<void> {
    if (this.device?.gatt?.connected) {
      this.device.gatt.disconnect();
    }
    this.notificationHandlers.clear();
  }

  /** 订阅指定通知通道。 */
  async startNotifications(
    characteristicKey: InternalCharacteristicKey,
    onValue?: (event: {
      characteristic: InternalCharacteristicKey;
      hex: string;
      bytes: Uint8Array;
    }) => void,
  ): Promise<void> {
    const characteristic = this.getCharacteristic(characteristicKey);

    if (onValue) {
      const existingHandler = this.notificationHandlers.get(characteristicKey);
      if (existingHandler) {
        characteristic.removeEventListener("characteristicvaluechanged", existingHandler);
      }

      const handler: EventListener = (event) => {
        const target = event.target as WebBluetoothRemoteGATTCharacteristic | null;
        const value = target?.value;
        if (!value) {
          return;
        }
        const bytes = new Uint8Array(value.buffer.slice(0));
        onValue({ characteristic: characteristicKey, bytes, hex: bytesToHex(bytes) });
      };

      characteristic.addEventListener("characteristicvaluechanged", handler);
      this.notificationHandlers.set(characteristicKey, handler);
    }

    await characteristic.startNotifications();
  }

  /** 写入指定特征值。 */
  async write(characteristicKey: InternalCharacteristicKey, payloadHex: string, options: LooiWriteOptions = {}): Promise<void> {
    const characteristic = this.getCharacteristic(characteristicKey);
    const bytes = hexToBytes(payloadHex, options.expectedBytes ?? null);
    if (options.response === false && characteristic.writeValueWithoutResponse) {
      await characteristic.writeValueWithoutResponse(bytes);
      return;
    }
    await characteristic.writeValueWithResponse(bytes);
  }

  private getCharacteristic(characteristicKey: InternalCharacteristicKey): WebBluetoothRemoteGATTCharacteristic {
    const characteristic = this.characteristics.get(characteristicKey);
    if (!characteristic) {
      throw new Error(`Characteristic is not ready: ${characteristicKey}`);
    }
    return characteristic;
  }
}

export {
  LIGHT_PAYLOADS as LOOI_LIGHT_VALUES,
  HEAD_PAYLOADS as LOOI_HEAD_VALUES,
  MOVE_PAYLOADS as LOOI_MOVE_VALUES,
};
