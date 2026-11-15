import { assert, equal } from "./assert.js";
import { rankDocuments } from "../../search/src/index.js";
import { HomeAssistantGateway, InMemoryHaTransportAdapter, executeHomeVoiceTool } from "../../home-assistant/src/index.js";
import type { HomeEntityDefinition, HomeStateSnapshot } from "@super-looi/contracts";

const documents = [
  { id: "light.desk", name: "客厅台灯", text: "灯 照明 亮度", context: "客厅" },
  { id: "light.ceiling", name: "客厅吸顶灯", text: "灯 照明 亮度", context: "客厅" },
  { id: "light.bedroom", name: "卧室台灯", text: "灯 照明 亮度", context: "卧室" },
  { id: "climate.living", name: "客厅空调", text: "空调 温度", context: "客厅" },
];
equal(rankDocuments("客厅的台灯", documents)[0].id, "light.desk");
equal(rankDocuments("客厅 灯", documents), rankDocuments("灯 客厅", documents));
equal(rankDocuments("LIGHT.DESK", documents)[0].id, "light.desk");
equal(rankDocuments("台灯", [
  { id: "other", name: "吊灯", text: "台灯" },
  { id: "exact", name: "台灯" },
])[0].id, "exact");
equal(rankDocuments("issue search", [{ id: "api.searchIssues", name: "IssueSearch" }])[0].id, "api.searchIssues");
equal(rankDocuments("livingroomlight", [{ id: "light.reading", name: "LivingRoomLight" }])[0].exact, true);
equal(rankDocuments("热水器", documents), []);

const definitions: HomeEntityDefinition[] = [...Array.from({ length: 65 }, (_, index) => ({
  entity_id: `light.desk_${String(index).padStart(2, "0")}`,
  friendly_name: "阅读台灯",
  device_name: "小米智能台灯",
  room: "客厅",
  domain: "light",
  supported_features: ["turn_on", "brightness"],
  is_whitelisted: true,
})),
  { entity_id: "light.bedroom", friendly_name: "卧室台灯", room: "卧室", domain: "light", supported_features: ["turn_on"], is_whitelisted: true },
  { entity_id: "climate.living", friendly_name: "客厅空调", room: "客厅", domain: "climate", supported_features: ["set_temperature"], is_whitelisted: true },
];
const states: Record<string, HomeStateSnapshot> = Object.fromEntries(definitions.map(entity => [entity.entity_id, {
  entity_id: entity.entity_id, state: "off", attributes: {},
  last_changed: "2026-11-15T00:00:00Z", last_updated: "2026-11-15T00:00:00Z",
}]));
const gateway = new HomeAssistantGateway({ transport: new InMemoryHaTransportAdapter(states) });
gateway.replaceEntities(definitions);
for (const query of ["客厅的台灯", "照明 客厅", "客厅 调光", "小米智能台灯"]) {
  const result = await executeHomeVoiceTool("list_home_devices", { query, offset: 30 }, gateway);
  equal(result.total, 65);
  equal(result.next_offset, 60);
  const devices = result.devices as unknown as Array<{ entity_id: string; snapshot: HomeStateSnapshot }>;
  equal(devices.length, 30);
  equal(devices[0].entity_id, "light.desk_30");
  equal(devices[0].snapshot.state, "off");
}
const last = await executeHomeVoiceTool("list_home_devices", { query: "灯 客厅", offset: 60 }, gateway);
equal(last.next_offset, null);
assert(Array.isArray(last.devices) && last.devices.length === 5);
equal((await executeHomeVoiceTool("list_home_devices", { query: "LIGHT.DESK_00" }, gateway)).total, 1);
console.log("PASS search: ICU Chinese segmentation, relevance, Unicode names, identifiers and HA device search with 65-entity pagination/readbacks");
