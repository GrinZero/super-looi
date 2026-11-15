import assert from "node:assert/strict";
import { test } from "node:test";
import type { HomeEntityDefinition } from "@super-looi/contracts";
import { HomeAssistantGateway } from "../src/core/gateway.js";
import { executeHomeVoiceTool } from "../src/core/voice-tools.js";
import type { HaTransportAdapter } from "../src/types.js";

function entity(entity_id: string, friendly_name: string, room: string, extra: Partial<HomeEntityDefinition> = {}): HomeEntityDefinition {
  return { entity_id, friendly_name, room, domain: entity_id.split(".")[0],
    supported_features: ["turn_on", "turn_off"], is_whitelisted: true, ...extra };
}

const entities = [
  entity("light.living_ceiling", "米家吸顶灯", "客厅", { supported_features: ["turn_on", "brightness"] }),
  entity("light.living_desk", "阅读台灯", "客厅", { device_name: "小米智能台灯", supported_features: ["turn_on", "brightness"] }),
  entity("light.bedroom", "床头灯", "卧室"),
  entity("climate.living", "米家空调", "客厅", { supported_features: ["set_temperature"] }),
  entity("sensor.living_temperature", "环境温度", "客厅", { supported_features: [] }),
];

function fixture(definitions = entities, failId?: string) {
  const reads: string[] = [];
  const transport: HaTransportAdapter = {
    async fetchState(entityId) {
      reads.push(entityId);
      if (entityId === failId) throw Object.assign(new Error("HA state read rejected"), { code: "ERR_HA_STATE_REJECTED" });
      return { entity_id: entityId, state: "off", attributes: {}, last_changed: "2026-11-15T00:00:00Z", last_updated: "2026-11-15T00:00:00Z" };
    },
    async callService() { throw new Error("Search must not control devices"); },
    isHealthy: () => true,
    getLastVerifiedAt: () => null,
  };
  const gateway = new HomeAssistantGateway({ transport });
  gateway.replaceEntities(definitions);
  async function search(query?: string, offset?: number) {
    return await executeHomeVoiceTool("list_home_devices", { query, offset }, gateway) as unknown as {
      total: number;
      next_offset: number | null;
      devices: Array<HomeEntityDefinition & { snapshot: unknown; read_error?: Record<string, unknown> }>;
    };
  }
  return { search, reads };
}

test("room and Chinese type keywords rank the right room's lamps above partial matches", async () => {
  const { search } = fixture();
  const result = await search("客厅 灯");
  assert.equal(result.total, 2);
  assert.deepEqual(new Set(result.devices.slice(0, 2).map(device => device.entity_id)),
    new Set(["light.living_ceiling", "light.living_desk"]));
  assert.equal((await search("灯 客厅")).devices[0].entity_id, result.devices[0].entity_id);
  assert.equal((await search("客厅的台灯")).devices[0].entity_id, "light.living_desk");
  assert.equal((await search("客厅的台灯")).total, 1);
  assert.equal((await search("吸顶灯")).total, 1);
});

test("device names, entity identifiers, type aliases and supported capabilities are searchable", async () => {
  const { search } = fixture();
  assert.equal((await search("小米智能台灯")).devices[0].entity_id, "light.living_desk");
  assert.equal((await search("LIGHT.LIVING_DESK")).devices[0].entity_id, "light.living_desk");
  assert.equal((await search("LIGHT.LIVING_DESK")).total, 1);
  assert.equal((await search("客厅 照明")).devices[0].domain, "light");
  const dimmable = await search("调光");
  assert.deepEqual(new Set(dimmable.devices.map(device => device.entity_id)),
    new Set(["light.living_ceiling", "light.living_desk"]));
  assert.equal((await search("客厅 thermostat")).devices[0].entity_id, "climate.living");
});

test("an exact display name takes precedence over a longer device name", async () => {
  const { search } = fixture([
    entity("light.a", "客厅台灯备用", "客厅"),
    entity("light.z", "客厅台灯", "客厅"),
  ]);
  assert.equal((await search("客厅台灯")).devices[0].entity_id, "light.z");
  assert.equal((await search("客厅台灯")).total, 1);
});

test("equally named devices remain candidates while weaker matches are excluded", async () => {
  const { search } = fixture([
    entity("light.living_desk", "台灯", "客厅"),
    entity("light.bedroom_desk", "台灯", "卧室"),
    entity("light.ceiling", "吸顶灯", "客厅"),
  ]);
  const result = await search("台灯");
  assert.equal(result.total, 2);
  assert.deepEqual(new Set(result.devices.map(device => device.entity_id)),
    new Set(["light.living_desk", "light.bedroom_desk"]));
  assert.equal((await search("客厅 台灯")).total, 1);
});

test("the tool preserves camelCase queries until the shared tokenizer sees them", async () => {
  const { search } = fixture([
    entity("light.reading", "LivingRoomLight", "Living Room"),
    entity("light.bedroom", "BedroomLight", "Bedroom"),
  ]);
  for (const query of ["LivingRoomLight", "livingroomlight", "LIVINGROOMLIGHT"]) {
    assert.equal((await search(query)).devices[0].entity_id, "light.reading");
    assert.equal((await search(query)).total, 1);
  }
  assert.equal((await search("room living")).devices[0].entity_id, "light.reading");
});

test("empty queries preserve the existing category and controllability ordering", async () => {
  const { search } = fixture([
    entity("sensor.a", "温度", "客厅", { supported_features: [] }),
    entity("light.c", "灯参数", "客厅", { entity_category: "config" }),
    entity("light.b", "灯", "客厅"),
  ]);
  assert.deepEqual((await search()).devices.map(device => device.entity_id), ["light.b", "sensor.a", "light.c"]);
  assert.deepEqual(await search("  "), await search());
});

test("search totals and pagination include every match and read only the requested page", async () => {
  const { search, reads } = fixture(Array.from({ length: 65 }, (_, index) =>
    entity(`light.desk_${String(index).padStart(2, "0")}`, "台灯", "客厅")));
  for (const [offset, count, next] of [[0, 30, 30], [30, 30, 60], [60, 5, null]] as const) {
    const page = await search("客厅 灯", offset);
    assert.equal(page.total, 65);
    assert.equal(page.devices.length, count);
    assert.equal(page.next_offset, next);
    assert.deepEqual(page.devices.map(device => device.entity_id),
      Array.from({ length: count }, (_, i) => `light.desk_${String(i + offset).padStart(2, "0")}`));
  }
  assert.equal(reads.length, 65);
  const outside = await search("客厅 灯", 90);
  assert.equal(outside.total, 65);
  assert.deepEqual(outside.devices, []);
  assert.equal(reads.length, 65);
});

test("unmatched searches read no state; directory filtering remains owned by the gateway", async () => {
  const { search, reads } = fixture([
    ...entities,
    entity("light.hidden", "隐藏设备", "客厅", { is_whitelisted: false }),
  ]);
  for (const query of ["热水器", "隐藏设备", "!!!"]) {
    const result = await search(query);
    assert.equal(result.total, 0);
    assert.deepEqual(result.devices, []);
    assert.equal(result.next_offset, null);
  }
  assert.deepEqual(reads, []);
});

test("state read failures retain the actual error alongside the matched entity", async () => {
  const { search } = fixture(entities, "light.living_desk");
  const result = await search("light.living_desk");
  assert.equal(result.devices[0].entity_id, "light.living_desk");
  assert.equal(result.devices[0].snapshot, null);
  assert.equal(result.devices[0].read_error?.code, "home_state_read_failed");
  assert.equal((result.devices[0].read_error?.cause as Record<string, unknown>).code, "ERR_HA_STATE_REJECTED");
  assert.match(JSON.stringify(result.devices[0].read_error), /HA state read rejected/);
});
