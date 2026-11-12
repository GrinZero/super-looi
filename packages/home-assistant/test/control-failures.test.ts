import assert from "node:assert/strict";
import { it } from "node:test";
import { DirectMiotTransportAdapter, HomeAssistantGateway, HomeTransportError, MiotHttpClient, MiotSpecResolver, transportErrorDetails } from "../src/index.js";
import { jsonResponse, lightSpec, lightUrn } from "./miot-fixtures.js";

async function fixture(options: {
  ack?: number;
  failedProperty?: number;
  missingProperty?: number;
  httpStatus?: number;
  apiCode?: number;
  readCode?: number;
  readProperty?: number;
  readHttpStatus?: number;
  reflect?: boolean;
  networkError?: Error;
} = {}) {
  const values = new Map<number, boolean | number>([[1, false], [2, 1], [3, 2700]]);
  let writes = 0;
  const network: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "miot-spec.org") return new Response(JSON.stringify(lightSpec()));
    if (url.pathname.endsWith("/gethome")) return jsonResponse({ homelist: [] });
    if (url.pathname.endsWith("/device_list_page")) return jsonResponse({ list: [
      { did: "lamp", name: "大厅台灯", model: "test.light", spec_type: lightUrn, isOnline: true },
    ] });
    const { params } = JSON.parse(String(init?.body)) as { params: Array<{ did: string; siid: number; piid: number; value?: number | boolean }> };
    if (url.pathname.endsWith("/prop/set")) {
      writes++;
      if (options.networkError) throw options.networkError;
      if (options.httpStatus) return new Response("private-access-token", { status: options.httpStatus });
      if (options.apiCode) return new Response(JSON.stringify({ code: options.apiCode, message: "private-access-token" }));
      if (options.reflect !== false) for (const p of params) values.set(p.piid, p.value!);
      return jsonResponse(params.filter(p => p.piid !== options.missingProperty).map(({ did, siid, piid }) => ({
        did, siid, piid, code: piid === options.failedProperty ? -704042011 : (options.ack ?? 0),
      })));
    }
    if (writes && options.readHttpStatus) return new Response("private-access-token", { status: options.readHttpStatus });
    return jsonResponse(params.map(({ did, siid, piid }) => ({
      did, siid, piid, code: writes && piid === (options.readProperty ?? 2) ? (options.readCode ?? 0) : 0, value: values.get(piid),
    })));
  };
  const transport = new DirectMiotTransportAdapter({
    client: new MiotHttpClient({ fetch: network, getAccessToken: async () => "private-access-token" }),
    specs: new MiotSpecResolver({ fetch: network }), allowedEntities: ["*"],
  });
  const entities = await transport.discover();
  const gateway = new HomeAssistantGateway({ transport, initialEntities: entities });
  const run = () => gateway.executeCommand({ entity_id: entities[0].entity_id, domain: "light", service: "turn_on", service_data: { brightness: 255 }, timeout_ms: 5 });
  return { run, writes: () => writes };
}

it("accepts Xiaomi code 1 then verifies physical state, but never treats the acknowledgement as completion", async () => {
  const applied = await fixture({ ack: 1 });
  assert.equal((await applied.run()).status, "verified");
  const unchanged = await fixture({ ack: 1, reflect: false });
  const receipt = await unchanged.run();
  assert.equal(receipt.status, "unverified");
  assert.equal(receipt.reason_code, "readback_mismatch");
  assert.equal(receipt.readbacks[0]?.value.state, "off");
  assert.equal(unchanged.writes(), 1);
});

it("exposes a partial write with the exact failed property and Xiaomi return code", async () => {
  const test = await fixture({ failedProperty: 2 });
  const receipt = await test.run();
  assert.equal(receipt.reason_code, "miot_property_write_failed");
  assert.deepEqual(receipt.diagnostics, {
    stage: "write", write_acknowledged: false,
    error: { code: "miot_property_write_failed", operation: "miotspec/prop/set", properties: [
      { did: "lamp", siid: 2, piid: 1, code: 0 }, { did: "lamp", siid: 2, piid: 2, code: -704042011 },
    ] },
  });
  assert.equal(test.writes(), 1);
});

it("identifies a missing property acknowledgement separately from a rejected property", async () => {
  const test = await fixture({ missingProperty: 2 });
  const receipt = await test.run();
  assert.equal(receipt.reason_code, "miot_property_write_failed");
  assert.match(JSON.stringify(receipt.diagnostics), /"piid":2,"code":null/);
});

it("preserves HTTP status and Xiaomi envelope errors instead of reporting readback timeout", async () => {
  for (const options of [{ httpStatus: 403 }, { apiCode: -10001 }]) {
    const test = await fixture(options);
    const receipt = await test.run();
    assert.equal(receipt.reason_code, options.httpStatus ? "miot_http_failed" : "miot_api_rejected");
    assert.deepEqual(receipt.diagnostics, {
      stage: "write", write_acknowledged: false,
      error: { code: receipt.reason_code, operation: "miotspec/prop/set",
        ...(options.httpStatus ? { http_status: 403 } : { upstream_code: -10001, upstream_message: "[redacted]" }) },
    });
    assert.ok(!JSON.stringify(receipt).includes("private-access-token"));
    assert.equal(test.writes(), 1);
  }
});

it("preserves the network cause while redacting the actual access token", async () => {
  const networkError = new TypeError("TLS handshake failed for private-access-token", { cause: Object.assign(new Error("certificate expired"), { code: "CERT_HAS_EXPIRED" }) });
  const test = await fixture({ networkError });
  const receipt = await test.run();
  assert.equal(receipt.reason_code, "miot_request_failed");
  assert.match(JSON.stringify(receipt.diagnostics), /TLS handshake failed/);
  assert.match(JSON.stringify(receipt.diagnostics), /CERT_HAS_EXPIRED/);
  assert.ok(!JSON.stringify(receipt).includes("private-access-token"));
});

it("distinguishes readback HTTP and property failures after an acknowledged write", async () => {
  for (const options of [{ readCode: -704042011 }, { readHttpStatus: 503 }]) {
    const test = await fixture(options);
    const receipt = await test.run();
    assert.equal(receipt.reason_code, options.readCode ? "miot_property_read_failed" : "miot_http_failed");
    assert.equal(receipt.diagnostics?.stage, "readback");
    assert.equal(receipt.diagnostics?.write_acknowledged, true);
    assert.match(JSON.stringify(receipt.diagnostics), options.readCode ? /-704042011/ : /503/);
    assert.equal(test.writes(), 1);
  }
});

it("keeps unrelated attribute errors visible without failing a verified brightness command", async () => {
  const test = await fixture({ readProperty: 3, readCode: -704042011 });
  const receipt = await test.run();
  assert.equal(receipt.status, "verified");
  assert.match(JSON.stringify(receipt.readbacks), /"piid":3,"code":-704042011/);
});

it("reports timeout only after the readback window expires, and exposes early disconnection separately", async () => {
  for (const healthy of [true, false]) {
    let writes = 0;
    const gateway = new HomeAssistantGateway({ transport: {
      fetchState: async () => null,
      callService: async () => { writes++; return { success: true }; },
      isHealthy: () => healthy, getLastVerifiedAt: () => null,
    } });
    const receipt = await gateway.executeCommand({ entity_id: "light.study_ceiling", service: "turn_on", service_data: {}, timeout_ms: 10 });
    assert.equal(receipt.reason_code, healthy ? "readback_timeout" : "readback_unavailable");
    assert.equal(receipt.diagnostics?.write_acknowledged, true);
    assert.equal(writes, 1);
  }
});

it("retains thrown write errors and pre-write read failures without replaying a command", async () => {
  let writes = 0;
  const gateway = new HomeAssistantGateway({ transport: {
    fetchState: async () => { throw new HomeTransportError("ha_http_503", { http_status: 503 }); },
    callService: async () => { writes++; throw new HomeTransportError("ha_http_403", { http_status: 403 }); },
    isHealthy: () => false, getLastVerifiedAt: () => null,
  } });
  const receipt = await gateway.executeCommand({ entity_id: "light.study_ceiling", service: "turn_on", service_data: {} });
  assert.equal(receipt.reason_code, "ha_http_403");
  assert.deepEqual(receipt.diagnostics?.before_write_error, { code: "ha_http_503", http_status: 503 });
  assert.equal(writes, 1);
  const details = transportErrorDetails(new HomeTransportError("miot_api_rejected", { upstream_code: -1, upstream_message: "token-a forbidden" }), undefined, ["token-a"]);
  assert.deepEqual(details, { code: "miot_api_rejected", upstream_code: -1, upstream_message: "[redacted] forbidden" });
});
