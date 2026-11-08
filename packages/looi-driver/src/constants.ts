/**
 * LOOI Robot BLE protocol constants and reverse-engineered payloads.
 */

export const LOOI_SERVICE_UUID = "000000ff-0000-1000-8000-00805f9b34fb" as const;

export const INTERNAL_CHARACTERISTICS = Object.freeze({
  drive: "0000fed0-0000-1000-8000-00805f9b34fb",
  head: "0000fed1-0000-1000-8000-00805f9b34fb",
  light: "0000fed2-0000-1000-8000-00805f9b34fb",
  sensorNotify: "0000fed5-0000-1000-8000-00805f9b34fb",
  dockNotify: "0000fed9-0000-1000-8000-00805f9b34fb",
  handshakeControl: "0000feda-0000-1000-8000-00805f9b34fb",
  handshakeData: "0000fef0-0000-1000-8000-00805f9b34fb",
  rawFe00: "0000fe00-0000-1000-8000-00805f9b34fb",
} as const);

export type CharacteristicKey = keyof typeof INTERNAL_CHARACTERISTICS;

export const MOVE_PAYLOADS = Object.freeze({
  forward: "7707",
  left: "047a",
  back: "86fc",
  right: "0082",
  stop: "0000",
} as const);

export const MOVE_HEARTBEAT_MS = 30;

export type MovePayloadKey = keyof typeof MOVE_PAYLOADS;

export const HEAD_PAYLOADS = Object.freeze({
  up: "00",
  center: "87",
  down: "ff",
} as const);

export type HeadPayloadKey = keyof typeof HEAD_PAYLOADS;

export const HEAD_MIN_DEGREES = 25;
export const HEAD_MAX_DEGREES = 85;

/** Preserve the three known device payloads while interpolating all angles between them. */
export function headDegreesToPayload(degrees: number): string {
  const angle = Math.max(HEAD_MIN_DEGREES, Math.min(HEAD_MAX_DEGREES, degrees));
  const byte = angle >= 55
    ? Math.round((HEAD_MAX_DEGREES - angle) * 0x87 / 30)
    : 0x87 + Math.round((55 - angle) * (0xff - 0x87) / 30);
  return byte.toString(16).padStart(2, "0");
}

export const LIGHT_PAYLOADS = Object.freeze({
  on: "01",
  off: "00",
} as const);

export type LightPayloadKey = keyof typeof LIGHT_PAYLOADS;

export const DOCK_STATUS_HEX = Object.freeze({
  docked: "05",
  undocked: "06",
} as const);

export const DEFAULT_INIT_TIME_HEX = "4132303236203036203234203030203535203432";

export const HANDSHAKE_SEQUENCE = Object.freeze([
  { characteristic: "handshakeControl" as const, payload: "03", response: true, expectedBytes: 1 },
  { characteristic: "handshakeData" as const, payload: DEFAULT_INIT_TIME_HEX, response: true, expectedBytes: 20 },
  { characteristic: "handshakeControl" as const, payload: "8101", response: true, expectedBytes: 2 },
] as const);

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

export function hexToBytes(raw: string, expectedBytes: number | null = null): Uint8Array {
  const clean = normalizeHex(raw, expectedBytes);
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < clean.length; i += 2) {
    bytes[i / 2] = Number.parseInt(clean.slice(i, i + 2), 16);
  }
  return bytes;
}

export function bytesToHex(bytes: Uint8Array | ArrayLike<number>): string {
  return Array.from(bytes, (val) => val.toString(16).padStart(2, "0")).join("");
}

export function createInitTimeHex(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const ascii = `A${date.getFullYear()} ${pad(date.getMonth() + 1)} ${pad(date.getDate())} ${pad(date.getHours())} ${pad(date.getMinutes())} ${pad(date.getSeconds())}`;
  return Array.from(ascii, (char) => char.charCodeAt(0).toString(16).padStart(2, "0")).join("");
}
