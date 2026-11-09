import { FORBIDDEN_HIGH_RISK_DOMAINS } from "../core/gateway.js";
import type { HomeRegistryOptions, HomeRegistrySocket } from "../types.js";

const PRIMARY_POWER_SWITCH_NAMES = new Set([
  "开关", "开关 开关", "开关 按键", "按键", "开关 设备状态", "开关 开/关 灯", "电源", "电源 开关",
  "摄像机控制 开关", "洗碗机 开关", "洗衣机 开关", "禹泰电工智能插座（Mesh） 开关", "空气净化器 开关",
  "大灯 左键", "小灯 中键", "没有用的开关 右键", "左键", "中键", "右键",
  "上下扫风", "左右扫风", "电辅热", "睡眠模式", "移动侦测", "时间水印", "自动保温",
  "power", "onoff",
].map((name) => name.toLowerCase()));

export interface HomeEntityMetadata {
  device_id?: string;
  device_name?: string;
  device_model?: string;
  original_name?: string;
  room?: string;
  entity_category?: string;
  power_control?: boolean;
  control_restricted?: boolean;
}

/** Read only registry metadata, through the standard WebSocket event API. */
export async function readHomeRegistry(
  url: string, token: string, integration: string, options: HomeRegistryOptions = {},
): Promise<Map<string, HomeEntityMetadata>> {
  try {
    const endpoint = new URL(url);
    if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
      throw new Error("invalid_url");
    }
    endpoint.pathname = `${endpoint.pathname.replace(/\/$/, "")}/api/websocket`;
    endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
    const socket: HomeRegistrySocket = (options.createWebSocket ?? ((address) => new WebSocket(address)))(endpoint.href);
    return await new Promise((resolve, reject) => {
      const results = new Map<number, Array<Record<string, unknown>>>();
      let settled = false;
      let authenticated = false;
      const timer = setTimeout(() => finish(), options.timeoutMs ?? 5000);
      function finish(value?: Map<string, HomeEntityMetadata>) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.removeEventListener("message", onMessage);
        socket.removeEventListener("error", onFailure);
        socket.removeEventListener("close", onFailure);
        try { socket.close(); } catch { /* A failed socket must not prevent settlement. */ }
        if (value) resolve(value); else reject(new Error("ha_registry_unavailable"));
      }
      function onFailure() { finish(); }
      function onMessage(event: { data: unknown }) {
        if (settled) return;
        try {
          if (typeof event.data !== "string") { finish(); return; }
          const message = JSON.parse(event.data);
          if (!message || typeof message !== "object") { finish(); return; }
          if (message.type === "auth_required" && !authenticated) socket.send(JSON.stringify({ type: "auth", access_token: token }));
          else if (message.type === "auth_invalid") finish();
          else if (message.type === "auth_ok" && !authenticated) {
            authenticated = true;
            ["config/entity_registry/list", "config/device_registry/list", "config/area_registry/list"]
              .forEach((type, index) => socket.send(JSON.stringify({ id: index + 1, type })));
          } else if (authenticated && message.type === "result" && [1, 2, 3].includes(message.id)) {
            if (!message.success || !Array.isArray(message.result)
              || !message.result.every((item: unknown) => item !== null && typeof item === "object" && !Array.isArray(item))) {
              finish(); return;
            }
            results.set(message.id, message.result);
            if (results.size === 3) finish(joinRegistry(results, integration));
          }
        } catch { finish(); }
      }
      socket.addEventListener("message", onMessage);
      socket.addEventListener("error", onFailure);
      socket.addEventListener("close", onFailure);
    });
  } catch { throw new Error("ha_registry_unavailable"); }
}

function joinRegistry(results: Map<number, Array<Record<string, unknown>>>, integration: string): Map<string, HomeEntityMetadata> {
  const devices = new Map(results.get(2)!.map((device) => [device.id, device]));
  const areas = new Map(results.get(3)!.map((area) => [area.area_id, area.name]));
  const metadata = new Map<string, HomeEntityMetadata>();
  for (const entity of results.get(1)!) {
    if ((integration && entity.platform !== integration) || entity.disabled_by || typeof entity.entity_id !== "string") continue;
    const device = devices.get(entity.device_id);
    const area = areas.get(entity.area_id ?? device?.area_id);
    const name = device?.name_by_user ?? device?.name;
    const restricted = String(device?.model ?? "").split(/[.\s]/).some((part) => FORBIDDEN_HIGH_RISK_DOMAINS.has(part))
      || /lock|gas|water[-_ ]?heater|garage[-_ ]?door|valve|siren|alarm_control_panel|门锁|燃气|煤气|热水器|水阀|车库门|警笛|警报/i.test(`${name ?? ""} ${device?.model ?? ""}`);
    const originalName = String(entity.original_name ?? "").trim();
    const normalizedOrig = originalName.replace(/\s+/g, " ").toLowerCase();
    const powerSwitch = !entity.entity_category && !originalName.startsWith("*")
      && !/转无线|无线开关|防闪烁|互锁|禁用|童锁|指示灯/.test(normalizedOrig)
      && (PRIMARY_POWER_SWITCH_NAMES.has(normalizedOrig)
        || /开关$|按键$|左键|中键|右键|扫风|辅热|移动侦测|休眠|巡航|水印|保温/.test(normalizedOrig));
    metadata.set(entity.entity_id, {
      device_id: typeof entity.device_id === "string" ? entity.device_id : undefined,
      device_name: typeof name === "string" ? name : undefined,
      device_model: typeof device?.model === "string" ? device.model : undefined,
      original_name: originalName || undefined,
      room: typeof area === "string" ? area : undefined,
      ...(typeof entity.entity_category === "string" ? { entity_category: entity.entity_category } : {}),
      ...(entity.entity_id.startsWith("switch.") ? { power_control: powerSwitch } : {}),
      ...(restricted ? { control_restricted: true } : {}),
    });
  }
  return metadata;
}
