import type { HomeEntityDefinition } from "@super-looi/contracts";
import { rankDocuments } from "@super-looi/search";

const domainTerms: Readonly<Record<string, string>> = {
  light: "灯 灯光 照明 lamp lighting",
  switch: "开关 switch",
  fan: "风扇 电扇 fan",
  climate: "空调 温控 thermostat",
  cover: "窗帘 遮阳 卷帘 curtain blind",
  vacuum: "扫地机 扫地机器人 吸尘器 vacuum",
  humidifier: "加湿器 humidifier",
  sensor: "传感器 sensor",
  binary_sensor: "传感器 sensor",
  camera: "摄像头 摄像机 camera",
  media_player: "播放器 音箱 player speaker",
  button: "按钮 button",
  number: "数值 number",
  select: "选项 select",
  text: "文本 text",
};

const featureTerms: Readonly<Record<string, string>> = {
  brightness: "亮度 调光",
  color_temp: "色温",
  set_temperature: "温度 调温",
  set_hvac_mode: "空调模式",
  set_fan_mode: "风速模式",
  set_percentage: "风速",
  oscillate: "摇头",
};

/** Keep domain vocabulary here; the shared search package only ranks text. */
export function searchHomeEntities(query: string, entities: readonly HomeEntityDefinition[]): HomeEntityDefinition[] {
  const ordered = [...entities].sort((a, b) => Number(Boolean(a.entity_category)) - Number(Boolean(b.entity_category))
    || Number(b.supported_features.includes("turn_on")) - Number(a.supported_features.includes("turn_on"))
    || a.entity_id.localeCompare(b.entity_id));
  if (!query.trim()) return ordered;

  const byId = new Map(ordered.map(entity => [entity.entity_id, entity]));
  const documents = ordered.map(entity => ({
    id: entity.entity_id,
    name: entity.friendly_name,
    text: [entity.device_name ?? "", entity.domain, domainTerms[entity.domain] ?? "",
      ...entity.supported_features.map(feature => `${feature} ${featureTerms[feature] ?? ""}`)].join(" "),
    context: entity.room,
  }));
  const matches = rankDocuments(query, documents);
  // Only equally specific candidates represent a device ambiguity. Weaker room-
  // or type-only hits must not force clarification after a precise search.
  const best = matches[0];
  return matches.filter(match => best.exact ? match.exact : match.matchedTerms === best.matchedTerms)
    .map(match => byId.get(match.id)!);
}
