import type { CredentialStore } from "../src/index.js";

export const redirectUri = "http://homeassistant.local:8123/api/webhook/super_looi_test";
export const uuid = "12345678-1234-4234-9234-123456789abc";
export class PrivateStore implements CredentialStore {
  readonly values = new Map<string, string>();
  async get(key: string) { return this.values.get(key) ?? null; }
  async set(key: string, value: string) { this.values.set(key, value); }
  async delete(key: string) { this.values.delete(key); }
}
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
export const lightUrn = "urn:miot-spec-v2:device:light:0000A001:test-lamp:1";
export const specProperty = (iid: number, name: string, format = "float", extra: Record<string, unknown> = {}) => ({
  iid, type: `urn:miot-spec-v2:property:${name}:00000001:test:1`, description: name, format, access: ["read"], ...extra,
});
export const lightSpec = () => ({ type: lightUrn, services: [{ iid: 2, type: "urn:miot-spec-v2:service:light:00007802:test:1", description: "灯",
  properties: [specProperty(1, "on", "bool", { access: ["read", "write"] }),
    specProperty(2, "brightness", "uint8", { access: ["read", "write"], "value-range": [1, 100, 1] }),
    specProperty(3, "color-temperature", "uint16", { access: ["read", "write"], "value-range": [2700, 6500, 100], unit: "kelvin" })] }] });
export const jsonResponse = (result: unknown) => new Response(JSON.stringify({ code: 0, result }));
