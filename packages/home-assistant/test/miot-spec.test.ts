import assert from "node:assert/strict";
import { it } from "node:test";
import { MiotSpecResolver, brightnessFromMiot, brightnessToMiot, mapMiotDevice, parseMiotSpec, quantizeMiot } from "../src/index.js";
import { PrivateStore, lightSpec, lightUrn, specProperty } from "./miot-fixtures.js";

const device = { did: "lamp.1", name: "灯", model: "test.light.v1", urn: lightUrn, online: true };

it("coalesces spec requests, persists public schemas and isolates callers from cache mutations", async () => {
  let requests = 0;
  let now = 0;
  const cache = new PrivateStore();
  const fetch = (async (input) => {
    requests++; const url = new URL(String(input));
    assert.equal(url.origin, "https://miot-spec.org"); assert.equal(url.searchParams.get("type"), lightUrn);
    return new Response(JSON.stringify(lightSpec()));
  }) as typeof globalThis.fetch;
  const resolver = new MiotSpecResolver({ cache, fetch, now: () => now, ttlMs: 100 });
  const specs = await Promise.all(Array.from({ length: 10 }, () => resolver.resolve(lightUrn)));
  assert.equal(requests, 1);
  specs[0].services[0].properties[0].writable = false;
  assert.equal((await resolver.resolve(lightUrn)).services[0].properties[0].writable, true);
  const restored = new MiotSpecResolver({ cache, fetch, now: () => now, ttlMs: 100 });
  await restored.resolve(lightUrn); assert.equal(requests, 1);
  now = 101;
  await restored.resolve(lightUrn); assert.equal(requests, 2);
  for (const key of cache.values.keys()) cache.values.set(key, "corrupted");
  const corrupt = new MiotSpecResolver({ cache, fetch });
  await corrupt.resolve(lightUrn); assert.equal(requests, 3);
});

it("rejects mismatched schemas, duplicate IDs, invalid URNs and clears failed in-flight resolutions", async () => {
  assert.throws(() => parseMiotSpec({ ...lightSpec(), type: `${lightUrn}other` }, lightUrn), /miot_invalid_spec/);
  const spec = lightSpec(); spec.services[0].properties.push(spec.services[0].properties[0]);
  assert.throws(() => parseMiotSpec(spec, lightUrn), /miot_invalid_spec/);
  let calls = 0;
  const resolver = new MiotSpecResolver({ fetch: (async () => {
    calls++; return new Response(JSON.stringify(calls === 1 ? {} : lightSpec()));
  }) as typeof fetch });
  await assert.rejects(resolver.resolve("https://evil.test"), /miot_invalid_spec_urn/); assert.equal(calls, 0);
  await assert.rejects(resolver.resolve(lightUrn), /miot_invalid_spec/);
  assert.ok(await resolver.resolve(lightUrn)); assert.equal(calls, 2);
});

it("exposes safe power capabilities while restricting hazardous and unfamiliar devices despite wildcard approval", () => {
  const spec = parseMiotSpec(lightSpec(), lightUrn);
  for (const [name, model, deviceType] of [["门锁", "test.lock.v1", "light"], ["热水器", "test.heater.v1", "water-heater"], ["unknown", "test.device.v1", "unknown"]]) {
    const entities = mapMiotDevice({ ...device, name, model }, { ...spec, deviceType }, new Set(["*"]));
    assert.ok(entities.every((binding) => !binding.definition.supported_features.includes("turn_on")));
  }
  const raw = lightSpec(); raw.services[0].properties.push(specProperty(4, "child-lock", "bool", { access: ["read", "write"] }));
  const mappings = mapMiotDevice(device, parseMiotSpec(raw, lightUrn), new Set(["*"]));
  const childLock = mappings.find((binding) => binding.primary.name === "child-lock")!;
  assert.equal(childLock.definition.domain, "binary_sensor"); assert.deepEqual(childLock.definition.supported_features, ["read"]);
});

it("intersects color temperature with the safe range and disables unsupported brightness encodings", () => {
  const raw = lightSpec();
  raw.services[0].properties[1]["value-range"] = [1, 100, 0];
  raw.services[0].properties[2]["value-range"] = [2000, 9000, 300];
  const mapping = mapMiotDevice(device, parseMiotSpec(raw, lightUrn), new Set(["*"]))[0];
  assert.ok(!mapping.definition.supported_features.includes("brightness"));
  assert.deepEqual(mapping.definition.allowed_range?.color_temp_kelvin, [2300, 6500]);
  assert.equal(quantizeMiot(6400, [2000, 9000, 300]), 6500);
  assert.equal(quantizeMiot(100, [1, 100, 10]), 91);
  const brightness = { ...mapping.primary, range: [1, 100, 10] as [number, number, number] };
  assert.equal(brightnessToMiot(255, brightness), 91);
  assert.equal(brightnessFromMiot(91, brightness), 255);
});

it("keeps IDs stable and collision-free and omits arbitrary string telemetry", () => {
  const raw = lightSpec(); raw.services[0].properties.push(specProperty(9, "token", "string"));
  const spec = parseMiotSpec(raw, lightUrn);
  const a = mapMiotDevice({ ...device, did: "lamp.1" }, spec, new Set());
  const b = mapMiotDevice({ ...device, did: "lamp_1" }, spec, new Set());
  assert.notEqual(a[0].definition.entity_id, b[0].definition.entity_id);
  assert.ok(!a.some((binding) => binding.primary.name === "token"));
  assert.ok(a.every((binding) => !binding.definition.is_whitelisted));
});
