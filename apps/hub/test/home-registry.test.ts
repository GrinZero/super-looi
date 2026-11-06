import { readHomeRegistry as readSharedHomeRegistry } from "@super-looi/home-assistant";
import { it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import fastify from "fastify";
import { WebSocketServer } from "ws";
import { readHomeRegistry } from "../src/home/registry.js";
import { createHomeConnection } from "../src/home/connection.js";
import { HomeAssistantGateway } from "../src/home/gateway.js";
import { executeHomeVoiceTool } from "../src/home/voice-tools.js";

it("filters to the requested integration, joins device/room metadata and excludes disabled entities", async () => {
  const server = createServer((_req, response) => {
    const now = new Date().toISOString();
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(["light.actual", "sensor.sun", "light.disabled", "switch.power", "switch.protection", "switch.lock_power"].map((entity_id) => ({
      entity_id, state: "off", attributes: { friendly_name: entity_id }, last_updated: now, last_changed: now,
    }))));
  });
  const ws = new WebSocketServer({ server });
  let registryRequests = 0;
  ws.on("connection", (client) => {
    client.send(JSON.stringify({ type: "auth_required" }));
    client.on("message", (data) => {
      const message = JSON.parse(data.toString());
      if (message.type === "auth") {
        assert.equal(message.access_token, "fixture-token");
        client.send(JSON.stringify({ type: "auth_ok" })); return;
      }
      registryRequests++;
      const result = message.id === 1 ? [
        { entity_id: "light.actual", platform: "xiaomi_home", device_id: "d1" },
        { entity_id: "sensor.sun", platform: "sun" },
        { entity_id: "light.disabled", platform: "xiaomi_home", device_id: "d1", disabled_by: "user" },
        { entity_id: "switch.power", platform: "xiaomi_home", device_id: "d1", original_name: "开关 设备状态" },
        { entity_id: "switch.protection", platform: "xiaomi_home", device_id: "d1", original_name: "童锁 开关" },
        { entity_id: "switch.burn_protection", platform: "xiaomi_home", device_id: "d1", original_name: "防烫伤保护 电源" },
        { entity_id: "switch.lock_power", platform: "xiaomi_home", device_id: "d2", original_name: "开关 开关" },
      ] : message.id === 2 ? [{ id: "d1", name: "灯", name_by_user: "阅读灯", area_id: "study", connections: [["mac", "private-mac"]] }, { id: "d2", name: "门锁", model: "vendor.lock.test" }]
        : [{ area_id: "study", name: "书房" }];
      client.send(JSON.stringify({ type: "result", id: message.id, success: true, result }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const registry = await readHomeRegistry(url, "fixture-token", "xiaomi_home");
    assert.equal(registry.size, 5);
    assert.equal(registry.get("switch.protection")?.power_control, false);
    assert.equal(registry.get("switch.burn_protection")?.power_control, false);
    assert.deepEqual(registry.get("light.actual"), { device_id: "d1", device_name: "阅读灯", room: "书房" });
    assert.ok(!JSON.stringify([...registry]).includes("private-mac"));
    const connection = createHomeConnection({ HA_URL: url, HA_TOKEN: "fixture-token", HA_INTEGRATION: "xiaomi_home", HA_ALLOWED_ENTITIES: "*" });
    await connection.refresh();
    const definitions = await connection.gateway.listEntities();
    assert.deepEqual(definitions.map((entity) => entity.entity_id), ["light.actual", "switch.power", "switch.protection", "switch.lock_power"]);
    assert.deepEqual(definitions.find((entity) => entity.entity_id === "switch.power")?.supported_features, ["turn_on", "turn_off"]);
    assert.deepEqual(definitions.find((entity) => entity.entity_id === "switch.protection")?.supported_features, ["read"]);
    assert.deepEqual(definitions.find((entity) => entity.entity_id === "switch.lock_power")?.supported_features, ["read"]);
    assert.equal((await connection.gateway.executeCommand({ entity_id: "switch.protection", domain: "switch", service: "turn_off", service_data: {} })).status, "rejected");
    await connection.refresh(true);
    assert.equal(registryRequests, 6, "metadata is cached while states can refresh");
  } finally { for (const client of ws.clients) client.terminate(); ws.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

it("rejects invalid registry authorization without exposing upstream details", async () => {
  const http = createServer((_req, response) => { response.setHeader("Content-Type", "application/json"); response.end("[]"); });
  const server = new WebSocketServer({ server: http });
  server.on("connection", (client) => client.send(JSON.stringify({ type: "auth_invalid", message: "private-upstream-detail" })));
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  const app = fastify();
  try {
    await assert.rejects(readHomeRegistry(url, "token", "xiaomi_home"), /^Error: ha_registry_unavailable$/);
    const connection = createHomeConnection({ HA_URL: url, HA_TOKEN: "token", HA_INTEGRATION: "xiaomi_home", HA_ALLOWED_ENTITIES: "*" });
    connection.register(app);
    const response = await app.inject({ url: "/api/home/connection" });
    assert.equal(response.json().healthy, false);
    assert.equal(response.json().error, "ha_registry_unavailable");
    assert.ok(!response.body.includes("private-upstream-detail"));
  } finally { await app.close(); for (const client of server.clients) client.terminate(); server.close(); http.closeAllConnections(); await new Promise<void>((resolve) => http.close(() => resolve())); }
});

it("paginates broad voice discovery instead of issuing one state request per imported entity", async () => {
  let reads = 0;
  const gateway = new HomeAssistantGateway({
    initialEntities: Array.from({ length: 80 }, (_, index) => ({ entity_id: `sensor.item_${index}`, friendly_name: `传感器 ${index}`,
      domain: "sensor", supported_features: ["read"], is_whitelisted: true })),
    transport: { async fetchState() { reads++; return null; }, async callService() { throw new Error("must not write"); }, isHealthy() { return true; }, getLastVerifiedAt() { return null; } },
  });
  const first = await executeHomeVoiceTool("list_home_devices", {}, gateway);
  assert.equal(first.total, 80); assert.equal(first.next_offset, 30); assert.equal(reads, 30);
  const last = await executeHomeVoiceTool("list_home_devices", { offset: 60 }, gateway);
  assert.equal(last.next_offset, null); assert.equal(reads, 50);
});

it("uses the standard global WebSocket for authenticated registry discovery", async () => {
  const http = createServer();
  const server = new WebSocketServer({ server: http });
  server.on("connection", (client) => {
    client.send(JSON.stringify({ type: "auth_required" }));
    client.on("message", (data) => {
      const message = JSON.parse(data.toString());
      if (message.type === "auth") {
        assert.equal(message.access_token, "fixture-token");
        client.send(JSON.stringify({ type: "auth_ok" }));
      } else {
        const result = message.id === 1 ? [
          { entity_id: "light.actual", device_id: "lamp", platform: "xiaomi_home" },
          { entity_id: "light.other", platform: "other" },
          { entity_id: "switch.lock_power", device_id: "lock", platform: "xiaomi_home", original_name: "power" },
        ] : message.id === 2 ? [{ id: "lamp", name: "阅读灯", area_id: "study" }, { id: "lock", name: "门锁", model: "vendor.lock.v1" }]
          : [{ area_id: "study", name: "书房" }];
        client.send(JSON.stringify({ type: "result", id: message.id, success: true, result }));
      }
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
    const metadata = await readSharedHomeRegistry(url, "fixture-token", "xiaomi_home");
    assert.equal(metadata.size, 2);
    assert.deepEqual(metadata.get("light.actual"), { device_id: "lamp", device_name: "阅读灯", room: "书房" });
    assert.equal(metadata.get("switch.lock_power")?.control_restricted, true);
  } finally {
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => http.close(() => resolve()));
  }
});

