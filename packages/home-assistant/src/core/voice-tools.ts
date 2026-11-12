import type { ActionReceipt, JsonObject } from "@super-looi/contracts";
import type { HomeVoiceToolDefinition } from "../types.js";
import type { HomeGateway } from "./gateway.js";
import { transportErrorDetails } from "../transport-error.js";

export const HOME_VOICE_TOOLS: HomeVoiceToolDefinition[] = [
  { type: "function", name: "list_home_devices", description: "查询家中真实设备及当前状态。控制前先查找实际 entity_id；匹配多个设备时询问用户，不能猜测设备名或传感器读数。", parameters: {
    type: "object", properties: { query: { type: "string", description: "设备名称或房间关键词" }, offset: { type: "integer", minimum: 0, description: "分页起点，默认 0" } },
  } },
  { type: "function", name: "control_home_device", description: "按用户明确要求控制单个真实设备，使用 list_home_devices 返回的 entity_id。只能根据回执 verified 确认完成，其余结果如实说明待核实。", parameters: {
    type: "object", properties: {
      entity_id: { type: "string" }, service: { type: "string", enum: ["turn_on", "turn_off"] },
      brightness: { type: "integer", minimum: 1, maximum: 255 }, color_temp_kelvin: { type: "integer" },
    }, required: ["entity_id", "service"],
  } },
];

export function homeControlInstruction(receipt: ActionReceipt): string {
  if (receipt.status === "verified") return "设备状态已回读确认。";
  const detail = "依据 reason_code 与 diagnostics.error 说明具体失败原因，保留服务错误码，不得改称其他错误。";
  if (receipt.diagnostics?.stage === "write") return `指令写入未确认成功。${detail}不能声称指令已被设备受理。`;
  if (receipt.diagnostics?.write_acknowledged === true) return `指令已受理，但实际效果尚未确认。${detail}不得声称操作已完成。`;
  return `执行尚未确认成功。${detail}不得声称操作已完成。`;
}

export async function executeHomeVoiceTool(name: string, args: Record<string, unknown>, gateway: HomeGateway): Promise<JsonObject> {
  if (name === "list_home_devices") {
    const query = typeof args.query === "string" ? args.query.trim().toLowerCase() : "";
    const entities = (await gateway.listEntities()).filter((entity) =>
      !query || `${entity.friendly_name} ${entity.room ?? ""} ${entity.device_name ?? ""} ${entity.entity_id}`.toLowerCase().includes(query))
      .sort((a, b) => Number(Boolean(a.entity_category)) - Number(Boolean(b.entity_category))
        || Number(b.supported_features.includes("turn_on")) - Number(a.supported_features.includes("turn_on")) || a.entity_id.localeCompare(b.entity_id));
    const offset = typeof args.offset === "number" && Number.isInteger(args.offset) ? Math.max(0, args.offset) : 0;
    const page = entities.slice(offset, offset + 30);
    return { total: entities.length, next_offset: offset + page.length < entities.length ? offset + page.length : null,
      devices: await Promise.all(page.map(async (entity) => {
        try { return { ...entity, snapshot: await gateway.getState(entity.entity_id) }; }
        catch (error) { return { ...entity, snapshot: null, read_error: transportErrorDetails(error, "home_state_read_failed") }; }
      })),
      instruction: "只根据实际回读回答。无设备表示尚未连接或未找到；多个匹配必须澄清，离线/未知值不可猜测。" } as unknown as JsonObject;
  }
  const data: JsonObject = {};
  if (args.brightness !== undefined) data.brightness = args.brightness as number;
  if (args.color_temp_kelvin !== undefined) data.color_temp_kelvin = args.color_temp_kelvin as number;
  const entityId = typeof args.entity_id === "string" ? args.entity_id : "";
  const receipt = await gateway.executeCommand({ entity_id: entityId, domain: entityId.split(".")[0],
    service: typeof args.service === "string" ? args.service : "", service_data: data });
  return { receipt, instruction: homeControlInstruction(receipt) } as unknown as JsonObject;
}
