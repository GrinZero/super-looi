import {
  cleanApplianceDisplayName,
  getRoomSortWeight,
  normalizeRoomName,
} from "./room-normalizer.js";
import {
  getArchetypeDefaultOrder,
  resolveDefaultTileSpan,
} from "./layout-store.js";
import type {
  ApplianceActionTrigger,
  ApplianceArchetype,
  ApplianceCapabilities,
  ApplianceControlPrimitive,
  ApplianceIconKind,
  CycleTaskCapability,
  HomeAppliance,
  HomeDashboardModel,
  HomeLayoutPreferences,
  HomeRoomSection,
  HomeSourceId,
  ModeBarCapability,
  ModeOption,
  MultiGangChannel,
  RawHomeEntityRecord,
  RoomEnvironmentMetric,
  TelemetryMetric,
  VacuumCapability,
  VacuumConsumableMetric,
  VacuumStatusCode,
} from "./types.js";

const SOURCE_LABELS: Record<HomeSourceId, { zh: string; en: string }> = {
  direct_miot: { zh: "米家", en: "Mi Home" },
  external_ha: { zh: "HA", en: "HA" },
  simulation: { zh: "演示", en: "Demo" },
};

const HVAC_MODE_LABELS: Record<string, string> = {
  cool: "制冷",
  heat: "制热",
  dry: "除湿",
  fan_only: "送风",
  auto: "自动",
  heat_cool: "自动",
  off: "关闭",
};

const MIOT_OPTION_TRANSLATIONS: Record<string, string> = {
  "straight wind": "直吹风",
  "natural wind": "自然风",
  sleep: "睡眠",
  auto: "自动",
  favorite: "最爱",
  manual: "手动",
  none: "关闭",
  off: "关闭",
  on: "开启",
  cool: "制冷",
  heat: "制热",
  dry: "除湿",
  fan: "送风",
  silent: "安静",
  basic: "标准",
  strong: "强力",
  "full speed": "超强",
  sweep: "扫地",
  mop: "拖地",
  "sweep and mop": "扫拖",
  low: "1档",
  medium: "2档",
  high: "3档",
  custom: "自定义",
  smart: "智能",
  "tap water": "自来水",
  "purified water": "纯净水",
  "cooled boiled water": "凉白开",
  "quick wash": "超快洗",
  "standard wash": "标准洗",
  "intensive wash": "强力洗",
  eco: "节能洗",
  "energy saving": "节能洗",
  disinfect: "消毒洗",
  "self clean": "自清洁",
  drying: "单独烘干",
  "baby care": "母婴洗",
  babycare: "婴童洗",
  glass: "晶柔洗",
  "pre-wash": "预冲洗",
  standard: "标准",
  soft: "柔和",
  quick: "快洗",
  "super quick": "快速",
  delicate: "轻柔",
  wool: "羊毛",
  "down coat": "羽绒",
  spin: "单脱水",
  "rinse and spin": "漂+脱",
  "drum clean": "筒清洁",
  "wash and dry": "洗烘",
  shirt: "衬衣",
  bedding: "大件",
  underwear: "内衣",
  "mite removal": "除螨",
  "dry air wash": "空气洗",
  soak: "浸泡洗",
  sterilization: "除菌",
  fragrance: "香薰",
  reading: "阅读",
  computer: "电脑",
  hospitality: "会客",
  entertainment: "娱乐",
  wakeup: "唤醒",
  night: "夜灯",
  continuous: "连续除湿",
  "dry clothes": "干衣",
  "target humidity": "恒湿",
};

function translateOptionLabel(raw: string, contextHint = ""): string {
  const trimmed = String(raw).trim();
  if (!trimmed) return trimmed;
  const lower = trimmed.toLowerCase();
  if (/^level\s*(\d+)$/i.test(trimmed)) {
    return `${RegExp.$1}档`;
  }
  if (/angle|角度/i.test(contextHint) && /^\d+$/.test(trimmed)) {
    return `${trimmed}°`;
  }
  if (/light|desk_lamp|scene|光模式/i.test(contextHint) && /^\d+$/.test(trimmed)) {
    return trimmed === "0" ? "默认" : `场景 ${trimmed}`;
  }
  if (MIOT_OPTION_TRANSLATIONS[lower]) {
    if (lower === "sleep" && /fan|风扇/i.test(contextHint)) return "睡眠风";
    return MIOT_OPTION_TRANSLATIONS[lower]!;
  }
  if (HVAC_MODE_LABELS[lower]) {
    return HVAC_MODE_LABELS[lower]!;
  }
  return trimmed;
}

function translateSwitchLabel(record: RawHomeEntityRecord): string {
  const text = entityLabelText(record);
  if (/horizontal_swing|左右摆风|左右扫风|摇头/i.test(text)) return "左右摆风";
  if (/vertical_swing|上下摆风|上下扫风/i.test(text)) return "上下摆风";
  if (/un_straight_blowing|防直吹/i.test(text)) return "防直吹";
  if (/sleep_mode|睡眠/i.test(text)) return "睡眠模式";
  if (/heater|电辅热|辅热/i.test(text)) return "电辅热";
  if (/dryer|干燥/i.test(text)) return "干燥防霉";
  if (/\beco\b|节能/i.test(text)) return "节能";
  if (/anion|负离子/i.test(text)) return "负离子";
  if (/auto_keep_warm|自动保温|延长保温|营养保温/i.test(text)) return "自动保温";
  if (/dechlorination|除氯/i.test(text)) return "除氯";
  if (/rapid_cooling|速冷/i.test(text)) return "速冷";
  if (/over_boiling|延长煮沸/i.test(text)) return "延长煮沸";
  if (/physical_controls_locked|child_lock|童锁/i.test(text)) return "童锁";
  if (/indicator|指示灯|led/i.test(text)) return "指示灯";
  if (/alarm|提示音|蜂鸣/i.test(text)) return "提示音";
  if (/mute|静音/i.test(text)) return "静音";
  if (/watermark|水印/i.test(text)) return "时间水印";
  if (/motion_tracking|移动追踪|人形追踪/i.test(text)) return "移动追踪";
  if (/motion_detection|移动侦测/i.test(text)) return "移动侦测";
  if (/wdr|宽动态/i.test(text)) return "宽动态";
  if (/glimmer_full_color|微光全彩/i.test(text)) return "微光全彩";
  if (/carpet|地毯/i.test(text)) return "地毯增压";
  if (/除菌|steril/i.test(text)) return "除菌";
  const raw = (record.original_name ?? record.friendly_name ?? "").trim();
  const tail = raw.includes("·") ? raw.split("·").pop()!.trim() : raw;
  return tail || "辅助开关";
}

function translateControlLabel(record: RawHomeEntityRecord, fallback: string): string {
  const text = entityLabelText(record);
  if (/horizontal_swing_included_angle|摇头角度|摆风角度/i.test(text)) return "摇头角度";
  if (/favorite_level|最爱档位/i.test(text)) return "最爱档位";
  if (/target_humidity|目标湿度/i.test(text)) return "目标湿度";
  if (/target_temperature|目标温度|设定温度/i.test(text)) return "目标温度";
  if (/keep_warm_temperature|保温温度/i.test(text)) return "保温温度";
  if (/delay_off_time|延时关/i.test(text)) return "延时关闭";
  if (/image_rollover|画面翻转|画面旋转/i.test(text)) return "画面旋转";
  if (/night_shot|夜视/i.test(text)) return "夜视模式";
  if (/recording_mode|录制模式|存储模式/i.test(text)) return "录制模式";
  if (/mop_mode|water_output|水量|拖地档位/i.test(text)) return "拖地水量";
  if (/fan_level|风速|档位/i.test(text)) return "风速档位";
  if (/\bmode\b|模式|程序|菜单/i.test(text)) return "工作模式";
  if (/volume|音量/i.test(text)) return "音量";
  return fallback;
}

function formatConciseCardDisplayName(name: string, room: string): string {
  let out = name.trim();
  if (!out) return name;
  if (room) {
    const escapedRoom = room.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const withoutRoomPrefix = out.replace(new RegExp(`^${escapedRoom}的?\\s*`), "").trim();
    if (withoutRoomPrefix.length >= 3) {
      out = withoutRoomPrefix;
    }
    out = out.replace(new RegExp(`\\s*[（(]${escapedRoom}[）)]$`), "").trim();
  }
  out = out
    .replace(/^(客厅|大厅|书房|主卧|卧室|天台|阳台|厨房|餐厅|小鸟)的?\s+/, "")
    .replace(/^(客厅|大厅|书房|主卧|卧室|天台|阳台|厨房|餐厅)的(?=.{3,})/, "")
    .replace(/\s*[（(](客厅|大厅|书房|主卧|卧室|天台|阳台|厨房|餐厅)[）)]$/, "")
    .trim();
  return out || name;
}

/**
 * Convert Fahrenheit temperatures reported by HA (e.g. `75°F`, `77.54°F`) into Celsius (`°C`).
 */
function normalizeCelsius(value: number, unit: string, isRoomOrApplianceTemp = true): number {
  const trimmedUnit = unit.trim();
  if (/°f|fahrenheit|华氏/i.test(trimmedUnit)) {
    return Math.round((((value - 32) * 5) / 9) * 10) / 10;
  }
  if (isRoomOrApplianceTemp && !/°c|celsius|摄氏/i.test(trimmedUnit) && value > 60 && value <= 212) {
    return Math.round((((value - 32) * 5) / 9) * 10) / 10;
  }
  return Math.round(value * 10) / 10;
}

function numericState(record: RawHomeEntityRecord | undefined): number | undefined {
  const raw = record?.snapshot?.state;
  if (raw === undefined || raw === null) return undefined;
  const trimmed = String(raw).trim();
  if (!trimmed || trimmed === "unavailable" || trimmed === "unknown") return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function stringState(record: RawHomeEntityRecord | undefined): string | undefined {
  const raw = record?.snapshot?.state;
  if (raw === undefined || raw === null) return undefined;
  const trimmed = String(raw).trim();
  if (!trimmed || trimmed === "unavailable" || trimmed === "unknown") return undefined;
  return trimmed;
}

function isEntityOnline(record: RawHomeEntityRecord): boolean {
  if (!record.snapshot) return true;
  const st = String(record.snapshot.state ?? "").toLowerCase();
  return st !== "unavailable" && st !== "unknown";
}

function entityLabelText(record: RawHomeEntityRecord): string {
  return `${record.original_name ?? ""} ${record.friendly_name ?? ""} ${record.entity_id}`.trim();
}

function isAuxiliaryOrConfigSwitch(record: RawHomeEntityRecord): boolean {
  const orig = (record.original_name ?? "").trim();
  const label = entityLabelText(record);
  if (orig.startsWith("*")) return true;
  if (record.entity_category === "config" || record.entity_category === "diagnostic") return true;
  return /禁用|指示灯|童锁|防闪烁|点动|灵动|互锁|转无线|无线开关|自动保温|延长保温|休眠|遮蔽|移动侦测|追踪|巡航|水印|扫风|摇头|摆风|直吹|辅热|除菌|干燥|负离子|地毯|翻滚|提示音|蜂鸣|静音|除氯|速冷|煮沸|节能|屏幕|宽动态|全彩|disable|child_lock|physical_controls_locked|indicator|watermark|motion_detection|motion_tracking|sleep|swing|straight_blowing|heater|dryer|eco|anion|alarm|mute|auto_keep_warm|dechlorination|rapid_cooling|over_boiling|screen|wdr|glimmer_full_color/i.test(
    label,
  );
}

function classifyAppliance(
  deviceName: string,
  model: string,
  records: RawHomeEntityRecord[],
): { archetype: ApplianceArchetype; icon: ApplianceIconKind } {
  const nameAndModel = `${deviceName} ${model}`.toLowerCase();
  const combined = `${nameAndModel} ${records.map((r) => r.entity_id).join(" ")}`.toLowerCase();

  if (/camera|监控|摄像头|摄像机/.test(combined)) {
    return { archetype: "vision_security", icon: "camera" };
  }
  if (/cateye|doorbell|门铃|猫眼/.test(combined)) {
    return { archetype: "vision_security", icon: "bell" };
  }
  if (/\.lock\.|^lock\.|门锁/.test(combined)) {
    return { archetype: "vision_security", icon: "lock" };
  }

  if (/cooker|电饭煲|压力锅/.test(combined)) {
    return { archetype: "cycle_appliance", icon: "cooker" };
  }
  if (/microwave|oven|微烤|微波炉|烤箱/.test(combined)) {
    return { archetype: "cycle_appliance", icon: "microwave" };
  }
  if (/dishwasher|洗碗机/.test(combined)) {
    return { archetype: "cycle_appliance", icon: "dishwasher" };
  }
  if (/washer|洗衣机/.test(combined)) {
    return { archetype: "cycle_appliance", icon: "washer" };
  }
  if (/vacuum|扫地|拖地/.test(combined)) {
    return { archetype: "cycle_appliance", icon: "vacuum" };
  }

  if (/kettle|电热水瓶|烧水壶|恒温壶/.test(combined)) {
    return { archetype: "climate", icon: "kettle" };
  }
  if (/blanket|电热毯|水暖毯/.test(combined)) {
    return { archetype: "climate", icon: "blanket" };
  }
  if (/derh|dehumidifier|除湿机/.test(combined)) {
    return { archetype: "climate", icon: "dehumidifier" };
  }
  if (/airp|purifier|净化器|新风/.test(combined)) {
    return { archetype: "climate", icon: "purifier" };
  }
  if (/airc|空调/.test(combined) || records.some((r) => r.domain === "climate")) {
    return { archetype: "climate", icon: "ac" };
  }
  if (/\.fan\.|风扇|循环扇/.test(combined) || records.some((r) => r.domain === "fan")) {
    return { archetype: "climate", icon: "fan" };
  }

  if (/\.tv\.|电视/.test(combined)) {
    return { archetype: "media", icon: "tv" };
  }
  if (/speaker|音箱|小爱/.test(combined) || records.some((r) => r.domain === "media_player")) {
    return { archetype: "media", icon: "speaker" };
  }

  if (/feeder|喂食器/.test(combined)) {
    return { archetype: "sensor_pet", icon: "feeder" };
  }
  if (/waterer|饮水机/.test(combined)) {
    return { archetype: "sensor_pet", icon: "waterer" };
  }
  if (/router|路由/.test(combined) && !/插座/.test(deviceName)) {
    return { archetype: "sensor_pet", icon: "router" };
  }

  // Pure environmental/occupancy sensors & thermometers must be classified before light/plug checks
  // (e.g. occupancy sensors have a `config` indicator light; `冰箱温度计` contains `冰箱`).
  if (/sensor|airm|传感器|温度计|温湿度|人体|人在|存在|门窗|检测仪|检测器/.test(nameAndModel)) {
    return { archetype: "sensor_pet", icon: "sensor" };
  }

  // Multi-gang switch detection: >= 2 non-diagnostic switch entities for left/middle/right keys
  const gangCandidates = records.filter(
    (r) =>
      r.domain === "switch" &&
      r.entity_category !== "config" &&
      r.entity_category !== "diagnostic" &&
      !/转无线|无线开关|mode_p_|防闪烁|互锁|指示灯/i.test(entityLabelText(r)) &&
      /左键|中键|右键|键1|键2|键3|left|middle|right|channel_[123]/i.test(entityLabelText(r)),
  );
  if (gangCandidates.length >= 2 || /meshk3|三键|双键|墙壁开关/.test(combined)) {
    return { archetype: "lighting_power", icon: "switch_gang" };
  }

  const hasPrimaryLight = records.some(
    (r) =>
      r.domain === "light" &&
      r.entity_category !== "config" &&
      r.entity_category !== "diagnostic" &&
      !/indicator|指示灯/i.test(entityLabelText(r)),
  );
  if (hasPrimaryLight || /light|lamp|吸顶灯|台灯|夜灯|射灯|灯带|灯$/.test(deviceName.toLowerCase())) {
    if (/台灯|夜灯|desk_lamp|\.light\.lite|lamp\d+/i.test(combined)) {
      return { archetype: "lighting_power", icon: "desk_lamp" };
    }
    return { archetype: "lighting_power", icon: "light" };
  }

  const hasPrimarySwitch = records.some(
    (r) => r.domain === "switch" && !isAuxiliaryOrConfigSwitch(r),
  );
  if (
    hasPrimarySwitch ||
    /plug|outlet|switch|插座|开关|底座|电脑|冰箱|水阀/.test(combined)
  ) {
    return { archetype: "lighting_power", icon: "plug" };
  }

  return { archetype: "sensor_pet", icon: "sensor" };
}

function cleanGangLabel(record: RawHomeEntityRecord, index: number): string {
  const raw = (record.original_name ?? record.friendly_name ?? "").trim();
  if (/左键/.test(raw)) {
    const prefix = raw.replace(/开关|\s*左键.*$/g, "").trim();
    return prefix ? `左·${prefix}` : "左键";
  }
  if (/中键/.test(raw)) {
    const prefix = raw.replace(/开关|\s*中键.*$/g, "").trim();
    return prefix ? `中·${prefix}` : "中键";
  }
  if (/右键/.test(raw)) {
    const prefix = raw.replace(/开关|\s*右键.*$/g, "").trim();
    return prefix ? `右·${prefix}` : "右键";
  }
  return `按键 ${index + 1}`;
}

function findPrimaryPowerEntity(records: RawHomeEntityRecord[]): RawHomeEntityRecord | undefined {
  const nonConfig = records.filter(
    (r) => r.entity_category !== "config" && r.entity_category !== "diagnostic",
  );
  const pool = nonConfig.length > 0 ? nonConfig : records;
  const domainPriority = ["light", "climate", "humidifier", "fan", "vacuum", "media_player", "switch"];

  for (const dom of domainPriority) {
    const rawMatches = pool.filter((r) => r.domain === dom);
    if (rawMatches.length === 0) continue;

    // Filter out auxiliary/config switches or indicator lights so we never bind main power to "Voice Disable" or "Child Lock"
    const cleanMatches =
      dom === "switch" || dom === "light"
        ? rawMatches.filter((r) => !isAuxiliaryOrConfigSwitch(r))
        : rawMatches;
    if (cleanMatches.length === 0) continue;

    const controllableMatches = cleanMatches.filter(
      (r) => r.supported_features.includes("turn_on") || r.supported_features.includes("turn_off"),
    );
    const candidates = controllableMatches.length > 0 ? controllableMatches : cleanMatches;

    const preferredByIdOrName =
      candidates.find((r) => /_s2_p1_on$|_on_p_2_1$|_on_p_\d+_1$|_power$/i.test(r.entity_id)) ??
      candidates.find((r) =>
        /^(开关|开关\s*开关|开关\s*按键|按键|电源|.*开关$|.*电源$|.*switch status$)/i.test(
          (r.original_name ?? r.friendly_name ?? "").trim(),
        ),
      );
    return preferredByIdOrName ?? candidates[0];
  }
  return undefined;
}

function normalizeAirQualityBadge(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();
  if (lower === "excellent" || lower === "great" || trimmed === "优" || trimmed === "0" || trimmed === "1") {
    return "优";
  }
  if (lower === "good" || lower === "fine" || trimmed === "良" || trimmed === "2") {
    return "良";
  }
  if (lower === "moderate" || lower === "normal" || trimmed === "中" || trimmed === "3") {
    return "中";
  }
  if (lower === "poor" || lower === "pollution" || trimmed === "差" || trimmed === "劣" || trimmed === "4") {
    return "差";
  }
  if (lower === "heavy" || lower === "severe" || trimmed === "重度" || trimmed === "5") {
    return "重度";
  }
  return undefined;
}

function extractTelemetry(
  records: RawHomeEntityRecord[],
  icon?: ApplianceIconKind,
  deviceId?: string,
): TelemetryMetric[] {
  const metrics: TelemetryMetric[] = [];
  const addMetric = (
    key: string,
    label: string,
    val: string,
    num?: number,
    unit?: string,
    badge?: string,
  ) => {
    if (metrics.some((m) => m.key === key)) return;
    metrics.push({
      key,
      label,
      value: val,
      numericValue: num,
      unit,
      ...(badge ? { badge } : {}),
      ...(deviceId ? { sourceDeviceId: deviceId } : {}),
    });
  };

  // Detect same-device air quality grade sensor if present
  const sameDeviceAirQualityRec = records.find(
    (r) =>
      r.domain === "sensor" &&
      !/pm2|co2|tvoc|hcho/i.test(entityLabelText(r)) &&
      /air_quality|空气质量/i.test(entityLabelText(r)),
  );
  const sameDeviceAirQualityBadge = normalizeAirQualityBadge(stringState(sameDeviceAirQualityRec));

  // Sort non-diagnostic records first so primary sensors take precedence over `*` diagnostic sensors
  const sortedRecords = [...records].sort((a, b) => {
    const aDiag = (a.original_name ?? "").startsWith("*") || a.entity_category === "diagnostic" ? 1 : 0;
    const bDiag = (b.original_name ?? "").startsWith("*") || b.entity_category === "diagnostic" ? 1 : 0;
    return aDiag - bDiag;
  });

  for (const r of sortedRecords) {
    if (r.domain !== "sensor" && r.domain !== "binary_sensor" && r.domain !== "number") continue;
    const label = entityLabelText(r);
    const num = numericState(r);
    const str = stringState(r);
    const unit = String(r.snapshot?.attributes?.unit_of_measurement ?? "");

    if (/实时功率|electric_power|\bpower\b/i.test(label) && !/耗电|power_consumption/.test(label)) {
      const v = num !== undefined ? Math.round(num * 10) / 10 : 0;
      addMetric("power", "实时功率", `${v}W`, v, "W");
    } else if (/耗电量|power_consumption|energy/i.test(label)) {
      if (num !== undefined && num >= 0) {
        const v = Math.round(num * 100) / 100;
        addMetric("energy", "耗电量", `${v}kWh`, v, "kWh");
      }
    } else if (
      /温度|temperature/i.test(label) &&
      !/色温|目标|设定|沸点|保温|室外管温|outdoor_pipe/i.test(label)
    ) {
      if (num !== undefined) {
        // Ignore dummy 0°C chip temperature sensors on smart plugs/switches
        if ((icon === "plug" || icon === "switch_gang") && num === 0) continue;
        const isCookerOrKettle = icon === "cooker" || icon === "kettle" || icon === "microwave";
        const celsius = normalizeCelsius(num, unit, !isCookerOrKettle);
        addMetric("temperature", "温度", `${celsius}°C`, celsius, "°C");
      }
    } else if (/湿度|humidity/i.test(label) && !/目标/.test(label)) {
      if (num !== undefined && num > 0 && num <= 100) {
        const rounded = Math.round(num);
        addMetric("humidity", "湿度", `${rounded}%`, rounded, "%");
      }
    } else if (/co2|二氧化碳/i.test(label)) {
      if (num !== undefined && num > 0) {
        const rounded = Math.round(num);
        addMetric("co2", "CO₂", `${rounded}ppm`, rounded, "ppm");
      }
    } else if (/pm2\.?5|pm25/i.test(label) && unit !== "%") {
      if (num !== undefined && num >= 0) {
        const rounded = Math.round(num);
        addMetric("pm25", "PM2.5", `${rounded}`, rounded, unit || "μg/m³", sameDeviceAirQualityBadge);
      }
    } else if (/tvoc/i.test(label) && num !== undefined) {
      addMetric("tvoc", "TVOC", `${num}${unit}`, num, unit);
    } else if (/hcho|甲醛/i.test(label) && num !== undefined) {
      addMetric("hcho", "甲醛", `${num}${unit}`, num, unit);
    } else if (/今日已进食|宠物进食量|eaten/i.test(label)) {
      const v = num ?? 0;
      addMetric("pet_eaten", "今日进食", `${v}g`, v, "g");
    } else if (/出水次数/i.test(label)) {
      const v = num ?? 0;
      addMetric("water_count", "今日出水", `${v}次`, v);
    } else if (/电池电量|battery_level|\bbattery\b/i.test(label) && num !== undefined) {
      const pct = Math.max(0, Math.min(100, Math.round(num)));
      addMetric("battery", "电量", `${pct}%`, pct, "%");
    } else if (/滤芯.*寿命|滤网.*寿命|干燥剂.*寿命|filter.*life.*level/i.test(label) && num !== undefined) {
      const pct = Math.max(0, Math.min(100, Math.round(num)));
      addMetric("filter_life", "滤芯寿命", `${pct}%`, pct, "%");
    } else if (/人在|有人|occupancy|motion/i.test(label) && r.domain === "binary_sensor") {
      const occupied = str === "on" || str === "true" || str === "detected";
      addMetric("occupancy", "感知", occupied ? "有人" : "无人", occupied ? 1 : 0);
    } else if (/光照度|illumination/i.test(label) && num !== undefined) {
      addMetric("lux", "光照", `${Math.round(num)}lx`, Math.round(num), "lx");
    } else if (/下载速度|download/i.test(label) && num !== undefined) {
      addMetric("download", "下载", `${num}${unit || "KB/s"}`, num);
    } else if (/连接设备|connected/i.test(label) && num !== undefined) {
      addMetric("clients", "终端数", `${num}台`, num);
    }
  }

  return metrics;
}

function buildActionTriggers(
  records: RawHomeEntityRecord[],
  icon: ApplianceIconKind,
): ApplianceActionTrigger[] {
  const triggers: ApplianceActionTrigger[] = [];
  const addTrigger = (trigger: ApplianceActionTrigger) => {
    if (triggers.some((t) => t.label === trigger.label)) return;
    triggers.push(trigger);
  };

  for (const r of records) {
    if (r.domain !== "button" && r.domain !== "notify") continue;
    if (
      !r.supported_features.includes("press") &&
      !r.supported_features.includes("send_message") &&
      !r.supported_features.includes("turn_on")
    ) {
      continue;
    }
    const text = entityLabelText(r);
    if (!text) continue;

    if (icon === "cooker" || icon === "microwave") {
      if (/开始煮饭|开始烹饪|开始|启动|start[_\s]*cook/i.test(text)) {
        addTrigger({
          id: r.entity_id,
          label: "开始",
          entityId: r.entity_id,
          domain: r.domain,
          service: r.domain === "button" ? "press" : "send_message",
          tone: "primary",
          iconKey: "play",
        });
      } else if (/暂停|pause/i.test(text)) {
        addTrigger({
          id: r.entity_id,
          label: "暂停",
          entityId: r.entity_id,
          domain: r.domain,
          service: r.domain === "button" ? "press" : "send_message",
          iconKey: "pause",
        });
      } else if (/取消|停止|cancel[_\s]*cook|stop/i.test(text)) {
        addTrigger({
          id: r.entity_id,
          label: "取消/保温",
          entityId: r.entity_id,
          domain: r.domain,
          service: r.domain === "button" ? "press" : "send_message",
          iconKey: "stop",
        });
      }
    } else if (icon === "washer" || icon === "dishwasher") {
      if (/清新抖散|启动抖散/i.test(text)) {
        addTrigger({
          id: r.entity_id,
          label: "清新抖散",
          entityId: r.entity_id,
          domain: r.domain,
          service: r.domain === "button" ? "press" : "send_message",
          iconKey: "refresh",
        });
      } else if (/开始洗涤|开始洗碗|开始|启动|start[_\s]*wash/i.test(text) && !/清洁|插件|抖散/i.test(text)) {
        addTrigger({
          id: r.entity_id,
          label: "启动",
          entityId: r.entity_id,
          domain: r.domain,
          service: r.domain === "button" ? "press" : "send_message",
          tone: "primary",
          iconKey: "play",
        });
      } else if (/暂停|pause/i.test(text)) {
        addTrigger({
          id: r.entity_id,
          label: "暂停",
          entityId: r.entity_id,
          domain: r.domain,
          service: "press",
          iconKey: "pause",
        });
      } else if (/停止洗涤|停止洗碗|停止|stop[_\s]*wash/i.test(text) && !/抖散|清洁/i.test(text)) {
        addTrigger({
          id: r.entity_id,
          label: "停止",
          entityId: r.entity_id,
          domain: r.domain,
          service: "press",
          iconKey: "stop",
        });
      }
    } else if (icon === "vacuum") {
      if (/开始清扫|start[_\s]*sweep/i.test(text)) {
        addTrigger({
          id: r.entity_id,
          label: "清扫",
          entityId: r.entity_id,
          domain: r.domain,
          service: "press",
          tone: "primary",
          iconKey: "play",
        });
      } else if (/暂停清扫|pause[_\s]*sweep|\bpause\b/i.test(text)) {
        addTrigger({
          id: r.entity_id,
          label: "暂停",
          entityId: r.entity_id,
          domain: r.domain,
          service: "press",
          iconKey: "pause",
        });
      } else if (/停止清扫|stop[_\s]*sweep/i.test(text)) {
        addTrigger({
          id: r.entity_id,
          label: "停止",
          entityId: r.entity_id,
          domain: r.domain,
          service: "press",
          iconKey: "stop",
        });
      } else if (/充电|回充|出仓|start[_\s]*charge/i.test(text)) {
        addTrigger({
          id: r.entity_id,
          label: /出仓|eject/i.test(text) ? "回充/出仓" : "回充",
          entityId: r.entity_id,
          domain: r.domain,
          service: "press",
          iconKey: "dock",
        });
      } else if (/开始集尘|dust[_\s]*collect|start[_\s]*dust/i.test(text)) {
        addTrigger({
          id: r.entity_id,
          label: "集尘",
          entityId: r.entity_id,
          domain: r.domain,
          service: "press",
          iconKey: "dust",
        });
      } else if (/开始洗拖布|mop[_\s]*wash/i.test(text)) {
        addTrigger({
          id: r.entity_id,
          label: "洗拖布",
          entityId: r.entity_id,
          domain: r.domain,
          service: "press",
          iconKey: "wash",
        });
      } else if (/开始烘干|start[_\s]*dry/i.test(text)) {
        addTrigger({
          id: r.entity_id,
          label: "烘干",
          entityId: r.entity_id,
          domain: r.domain,
          service: "press",
          iconKey: "dry",
        });
      } else if (/定位机器人|查找|identify/i.test(text)) {
        addTrigger({
          id: r.entity_id,
          label: "定位",
          entityId: r.entity_id,
          domain: r.domain,
          service: "press",
          iconKey: "locate",
        });
      }
    } else if (icon === "kettle") {
      if (/开始加热|煮沸|start[_\s]*heat/i.test(text)) {
        addTrigger({
          id: r.entity_id,
          label: "加热",
          entityId: r.entity_id,
          domain: r.domain,
          service: "press",
          tone: "primary",
          iconKey: "play",
        });
      } else if (/停止加热|stop[_\s]*heat/i.test(text)) {
        addTrigger({
          id: r.entity_id,
          label: "停止",
          entityId: r.entity_id,
          domain: r.domain,
          service: "press",
          iconKey: "stop",
        });
      }
    } else if (icon === "fan") {
      if (/向左转|左转|turn[_\s]*left/i.test(text)) {
        addTrigger({
          id: r.entity_id,
          label: "左转",
          entityId: r.entity_id,
          domain: r.domain,
          service: "press",
          iconKey: "refresh",
        });
      } else if (/向右转|右转|turn[_\s]*right/i.test(text)) {
        addTrigger({
          id: r.entity_id,
          label: "右转",
          entityId: r.entity_id,
          domain: r.domain,
          service: "press",
          iconKey: "refresh",
        });
      }
    } else if (icon === "light" || icon === "desk_lamp") {
      if (/翻转|切换|toggle/i.test(text)) {
        addTrigger({
          id: r.entity_id,
          label: "切换开关",
          entityId: r.entity_id,
          domain: r.domain,
          service: "press",
          iconKey: "power",
        });
      }
    } else if (icon === "feeder") {
      if (/出粮|喂食|pet[_\s]*food[_\s]*out/i.test(text)) {
        addTrigger({
          id: r.entity_id,
          label: "立即出粮",
          entityId: r.entity_id,
          domain: r.domain,
          service: r.domain === "button" ? "press" : "send_message",
          tone: "primary",
          iconKey: "dispense",
        });
      }
    } else if (icon === "tv" || icon === "speaker") {
      if (/开机|唤醒|播放音乐|wake[_\s]*up|play[_\s]*music|\bplay\b/i.test(text)) {
        addTrigger({
          id: r.entity_id,
          label: /唤醒|wake/i.test(text) ? "唤醒" : /音乐|music/i.test(text) ? "播放音乐" : /play/i.test(text) ? "播放" : "开机",
          entityId: r.entity_id,
          domain: r.domain,
          service: "press",
          tone: "primary",
          iconKey: "play",
        });
      } else if (/关机|暂停|停止闹钟|stop[_\s]*alarm|\bpause\b/i.test(text)) {
        addTrigger({
          id: r.entity_id,
          label: /闹钟|alarm/i.test(text) ? "停闹钟" : /关机/i.test(text) ? "关机" : "暂停",
          entityId: r.entity_id,
          domain: r.domain,
          service: "press",
          iconKey: "pause",
        });
      } else if (/首页|返回|菜单|上一曲|下一曲|previous|next/i.test(text)) {
        const shortLabel = /上一曲|previous/i.test(text)
          ? "上一曲"
          : /下一曲|next/i.test(text)
            ? "下一曲"
            : /首页/i.test(text)
              ? "首页"
              : /返回/i.test(text)
                ? "返回"
                : "菜单";
        addTrigger({ id: r.entity_id, label: shortLabel, entityId: r.entity_id, domain: r.domain, service: "press" });
      }
    }
  }

  return triggers;
}

/**
 * Translate MIoT / HA vacuum status codes (including raw integers like `13` or `14`)
 * into clean, unambiguous human-readable states.
 */
function resolveVacuumStatus(
  records: RawHomeEntityRecord[],
  batteryPercent?: number,
): { statusCode: VacuumStatusCode; statusLabel: string; chargingLabel?: string } {
  const vacuumEntity = records.find((r) => r.domain === "vacuum");
  const chargingSensor = records.find(
    (r) => r.domain === "sensor" && /charging_state|充电状态/i.test(entityLabelText(r)),
  );
  const statusSensor = records.find(
    (r) =>
      r.domain === "sensor" &&
      !/waterbox|拖布|水箱|charging|充电|fault|异常/i.test(entityLabelText(r)) &&
      /status_p_2|work_mode|工作状态|设备状态|\bstatus\b/i.test(entityLabelText(r)),
  );

  const chargingText = stringState(chargingSensor);
  const vacuumState = stringState(vacuumEntity)?.toLowerCase() ?? "";
  const rawSensorState = stringState(statusSensor) ?? "";

  const combined = `${vacuumState} ${rawSensorState} ${chargingText ?? ""}`.toLowerCase();

  // Check explicit active cleaning / washing / drying / returning states first
  if (/洗拖布|清洗拖布|washing/i.test(combined) || rawSensorState === "9") {
    return { statusCode: "washing", statusLabel: "清洗拖布中", chargingLabel: chargingText };
  }
  if (/烘干|drying/i.test(combined) || rawSensorState === "8") {
    return { statusCode: "drying", statusLabel: "拖布烘干中", chargingLabel: chargingText };
  }
  if (/集尘|dust/i.test(combined) || rawSensorState === "10") {
    return { statusCode: "dust_collecting", statusLabel: "自动集尘中", chargingLabel: chargingText };
  }
  if (
    vacuumState === "cleaning" ||
    /正在清扫|清扫中|sweeping|cleaning|mopping|拖地中/i.test(rawSensorState) ||
    rawSensorState === "1" ||
    rawSensorState === "7"
  ) {
    return { statusCode: "cleaning", statusLabel: "清扫中", chargingLabel: chargingText };
  }
  if (
    vacuumState === "returning" ||
    /回充|返回基站|go_charging|returning/i.test(combined) ||
    rawSensorState === "5"
  ) {
    return { statusCode: "returning", statusLabel: "正在回充", chargingLabel: chargingText };
  }
  if (vacuumState === "paused" || /暂停|paused/i.test(rawSensorState) || rawSensorState === "3") {
    return { statusCode: "paused", statusLabel: "已暂停", chargingLabel: chargingText };
  }
  if (vacuumState === "error" || /故障|错误|error/i.test(rawSensorState) || rawSensorState === "4") {
    return { statusCode: "error", statusLabel: "故障需处理", chargingLabel: chargingText };
  }

  // Docked / Charging / Sleeping / Standby (including MIoT enum codes 6, 11, 12, 13, 14)
  if (/正在充电|charging/i.test(chargingText ?? "") || rawSensorState === "6") {
    const label = batteryPercent !== undefined && batteryPercent >= 100 ? "基站待命" : "正在充电";
    return {
      statusCode: batteryPercent !== undefined && batteryPercent >= 100 ? "docked" : "charging",
      statusLabel: label,
      chargingLabel: chargingText ?? "正在充电",
    };
  }
  if (
    vacuumState === "docked" ||
    rawSensorState === "11" ||
    rawSensorState === "12" ||
    rawSensorState === "13" ||
    rawSensorState === "14" ||
    /充电完成|已回充|休眠|待机|docked|sleeping|standby|idle/i.test(combined)
  ) {
    return {
      statusCode: "docked",
      statusLabel: "基站待命",
      chargingLabel: chargingText ?? "已充满",
    };
  }

  return {
    statusCode: "idle",
    statusLabel: "待机就绪",
    chargingLabel: chargingText,
  };
}

function buildVacuumCapability(
  records: RawHomeEntityRecord[],
  telemetry: TelemetryMetric[],
): VacuumCapability {
  const batteryMetric = telemetry.find((m) => m.key === "battery");
  const batteryPercent = batteryMetric?.numericValue;
  const { statusCode, statusLabel, chargingLabel } = resolveVacuumStatus(records, batteryPercent);

  const areaSensor = records.find(
    (r) => r.domain === "sensor" && /cleaning_area|清扫面积/i.test(entityLabelText(r)) && !/total|累计/i.test(entityLabelText(r)),
  );
  const timeSensor = records.find(
    (r) => r.domain === "sensor" && /cleaning_time|清扫时间|清扫时长/i.test(entityLabelText(r)) && !/total|累计/i.test(entityLabelText(r)),
  );
  const totalCountSensor = records.find(
    (r) => r.domain === "sensor" && /total_clean_count|累计清扫次数|清扫次数/i.test(entityLabelText(r)),
  );
  const totalAreaSensor = records.find(
    (r) => r.domain === "sensor" && /total_clean_area|累计清扫面积/i.test(entityLabelText(r)),
  );
  const totalTimeSensor = records.find(
    (r) => r.domain === "sensor" && /total_clean_time|累计清扫时间|累计清扫时长/i.test(entityLabelText(r)),
  );
  const waterBoxSensor = records.find(
    (r) => (r.domain === "sensor" || r.domain === "binary_sensor") && /waterbox|拖布安装|水箱状态/i.test(entityLabelText(r)),
  );

  const cleaningAreaSqm = areaSensor ? numericState(areaSensor) : undefined;
  const cleaningMinutes = timeSensor ? numericState(timeSensor) : undefined;
  const totalCleanCount = totalCountSensor ? numericState(totalCountSensor) : undefined;
  const totalCleanAreaSqm = totalAreaSensor ? numericState(totalAreaSensor) : undefined;
  const totalCleanHours = totalTimeSensor ? numericState(totalTimeSensor) : undefined;
  const waterBoxRaw = stringState(waterBoxSensor)?.toLowerCase();
  const waterBoxInstalled =
    waterBoxRaw !== undefined ? waterBoxRaw === "yes" || waterBoxRaw === "on" || waterBoxRaw === "true" || waterBoxRaw === "1" : undefined;

  // Mop water output mode bar
  let mopModeBar: ModeBarCapability | undefined;
  const mopSelect = records.find(
    (r) => r.domain === "select" && /mop_mode|water_output|水量|湿度|拖地档位/i.test(entityLabelText(r)),
  );
  if (mopSelect) {
    const rawOpts = Array.isArray(mopSelect.snapshot?.attributes?.options)
      ? (mopSelect.snapshot?.attributes?.options as string[])
      : ["1档水量", "2档水量", "3档水量"];
    const cur = stringState(mopSelect) ?? rawOpts[0] ?? "2档水量";
    mopModeBar = {
      entityId: mopSelect.entity_id,
      domain: "select",
      service: "select_option",
      parameterKey: "option",
      currentMode: cur,
      currentLabel: translateOptionLabel(cur, "mop"),
      options: rawOpts.slice(0, 5).map((o) => ({ value: String(o), label: translateOptionLabel(String(o), "mop") })),
      controllable: mopSelect.supported_features.includes("select_option"),
    };
  }

  // Consumables (Main brush, Side brush, Filter, Mop pad)
  const consumables: VacuumConsumableMetric[] = [];
  const addConsumable = (
    id: string,
    label: string,
    levelRegex: RegExp,
    hoursRegex: RegExp,
  ) => {
    const levelRec = records.find((r) => r.domain === "sensor" && levelRegex.test(entityLabelText(r)));
    if (!levelRec) return;
    const pct = numericState(levelRec);
    if (pct === undefined) return;
    const hoursRec = records.find((r) => r.domain === "sensor" && hoursRegex.test(entityLabelText(r)));
    const hours = hoursRec ? numericState(hoursRec) : undefined;
    consumables.push({
      id,
      label,
      percent: Math.max(0, Math.min(100, Math.round(pct))),
      ...(hours !== undefined ? { remainingHours: Math.max(0, Math.round(hours)) } : {}),
    });
  };

  addConsumable(
    "main_brush",
    "主刷寿命",
    /主刷.*寿命百分比|brush_life_level_p_14_1|main cleaning brush.*brush life level|_s9_p2_brush_life_level|main_brush_life/i,
    /主刷.*剩余寿命|brush_left_time_p_14_2|main cleaning brush.*brush left time|_s9_p1_brush_left_time/i,
  );
  addConsumable(
    "side_brush",
    "边刷寿命",
    /边刷.*寿命百分比|brush_life_level_p_15_1|side cleaning brush.*brush life level|_s10_p2_brush_life_level|side_brush_life/i,
    /边刷.*剩余寿命|brush_left_time_p_15_2|side cleaning brush.*brush left time|_s10_p1_brush_left_time/i,
  );
  addConsumable(
    "filter",
    "滤芯寿命",
    /滤芯.*寿命百分比|filter_life_level_p_13_1|_s11_p1_filter_life_level|filter_life/i,
    /滤芯.*剩余寿命|filter_left_time_p_13_2|_s11_p2_filter_left_time/i,
  );
  addConsumable(
    "mop",
    "拖布寿命",
    /拖布.*寿命百分比|brush_life_level_p_16_1|_s18_p1_mop_life_level|mop_life/i,
    /拖布.*剩余寿命|brush_left_time_p_16_2|_s18_p2_mop_left_time/i,
  );

  return {
    statusCode,
    statusLabel,
    chargingLabel,
    batteryPercent,
    cleaningAreaSqm,
    cleaningMinutes,
    totalCleanCount,
    totalCleanAreaSqm,
    totalCleanHours,
    waterBoxInstalled,
    mopModeBar,
    consumables,
  };
}

function normalizeCycleStageText(rawStage: string, icon: ApplianceIconKind): string {
  const trimmed = rawStage.trim();
  const lower = trimmed.toLowerCase();
  if (
    !trimmed ||
    lower === "off" ||
    lower === "idle" ||
    lower === "standby" ||
    lower === "no" ||
    lower === "false" ||
    lower === "devicesleep" ||
    lower === "sleep"
  ) {
    return "待机";
  }
  if (lower === "yes" || lower === "true") {
    return "待机";
  }
  // Translate raw MIoT numeric status codes if any leaked through
  if (/^\d+$/.test(trimmed)) {
    const code = Number(trimmed);
    if (code === 0 || code === 1) return "待机";
    if (code === 2) return icon === "cooker" ? "精煮中" : icon === "washer" || icon === "dishwasher" ? "洗涤中" : "运行中";
    if (code === 3) return icon === "cooker" ? "保温中" : "已暂停";
    if (code === 4) return "已完成";
    return "待机";
  }
  if (lower === "busy" || lower === "running") {
    return icon === "cooker" ? "烹饪中" : icon === "washer" || icon === "dishwasher" ? "洗涤中" : "运行中";
  }
  if (lower === "paused" || lower === "pause") {
    return "已暂停";
  }
  if (lower === "completed" || lower === "finish" || lower === "finished") {
    return "已完成";
  }
  if (lower === "preservation") {
    return "保管中";
  }
  if (lower === "drying") {
    return "烘干中";
  }
  if (lower === "pre-wash") {
    return "预洗中";
  }
  if (lower === "main-wash") {
    return "主洗中";
  }
  if (lower === "rinse") {
    return "漂洗中";
  }
  if (lower === "on" || lower === "cooking") {
    return icon === "cooker" ? "精煮中" : "运行中";
  }
  if (lower === "keep_warm" || lower === "keep warm" || /保温/.test(trimmed)) {
    return "保温中";
  }
  if (/^(预热|吸水|沸腾|焖饭|加热|烘烤|散温|称重|洗涤|预洗|主洗|漂洗|脱水|抖散|烘干|保管)$/.test(trimmed)) {
    return `${trimmed}中`;
  }
  return trimmed;
}

function buildCycleTaskCapability(
  icon: ApplianceIconKind,
  records: RawHomeEntityRecord[],
  telemetry: TelemetryMetric[],
  vacuumCap?: VacuumCapability,
): CycleTaskCapability {
  const defaultStages: Record<string, string[]> = {
    cooker: ["预热", "吸水", "沸腾", "焖饭", "保温"],
    microwave: ["预热", "加热", "烘烤", "散温"],
    washer: ["称重", "洗涤", "漂洗", "脱水", "抖散"],
    dishwasher: ["预洗", "主洗", "漂洗", "烘干", "保管"],
    vacuum: ["清扫", "回充", "集尘", "洗拖布", "烘干"],
  };
  const stages = defaultStages[icon] ?? ["预热", "运行", "散温"];

  if (icon === "vacuum" && vacuumCap) {
    const isRunning =
      vacuumCap.statusCode === "cleaning" ||
      vacuumCap.statusCode === "returning" ||
      vacuumCap.statusCode === "washing" ||
      vacuumCap.statusCode === "drying" ||
      vacuumCap.statusCode === "dust_collecting";
    const activeStageIndex =
      vacuumCap.statusCode === "cleaning"
        ? 0
        : vacuumCap.statusCode === "returning"
          ? 1
          : vacuumCap.statusCode === "dust_collecting"
            ? 2
            : vacuumCap.statusCode === "washing"
              ? 3
              : vacuumCap.statusCode === "drying"
                ? 4
                : -1;
    return {
      stageLabel: vacuumCap.statusLabel,
      stages,
      activeStageIndex,
      remainingMinutes: vacuumCap.cleaningMinutes,
      progressPercent: isRunning ? 65 : 0,
      isRunning,
      subStatus:
        vacuumCap.batteryPercent !== undefined
          ? `电量 ${vacuumCap.batteryPercent}%`
          : vacuumCap.chargingLabel,
    };
  }

  const statusSensor = records.find(
    (r) =>
      r.domain === "sensor" &&
      !/waterbox|拖布|水箱|fault|异常|预约|keep_warm|保温/i.test(entityLabelText(r)) &&
      /设备状态|工作状态|阶段|status_p_2|stage|\bstatus\b/i.test(entityLabelText(r)),
  );
  const remainingSensor =
    records.find(
      (r) =>
        (r.domain === "sensor" || r.domain === "number") &&
        !/预约|pre_left|keep_warm|保温|滤芯|刷|filter|brush/i.test(entityLabelText(r)) &&
        /剩余时间|剩余时长|left_time|remaining/i.test(entityLabelText(r)),
    ) ??
    records.find(
      (r) =>
        (r.domain === "sensor" || r.domain === "number") &&
        !/滤芯|刷|filter|brush/i.test(entityLabelText(r)) &&
        /剩余时间|剩余时长|left_time|remaining/i.test(entityLabelText(r)),
    );

  const keepWarmSensor = records.find(
    (r) => r.domain === "sensor" && /已保温|保温时间|keep_warm_time/i.test(entityLabelText(r)),
  );
  const targetTempRec = records.find(
    (r) =>
      (r.domain === "number" || r.domain === "sensor") &&
      /目标温度|保温温度|设定温度|target_temperature/i.test(entityLabelText(r)),
  );

  const rawStage = stringState(statusSensor ?? records[0]) ?? "待机";
  const stageLabel = normalizeCycleStageText(rawStage, icon);
  const remainingMinutes = remainingSensor ? numericState(remainingSensor) : undefined;
  const keepWarmMinutes = keepWarmSensor ? numericState(keepWarmSensor) : undefined;
  const targetTempCelsius = targetTempRec ? numericState(targetTempRec) : undefined;
  const tempMetric = telemetry.find((m) => m.key === "temperature");

  const isRunning =
    (remainingMinutes !== undefined && remainingMinutes > 0) ||
    /煮|热|沸|焖|洗|漂|脱|烘|清扫|工作|运行|cooking|washing|cleaning|drying|boiling/i.test(stageLabel);

  let activeStageIndex = -1;
  for (let i = 0; i < stages.length; i++) {
    if (stageLabel.includes(stages[i]!)) {
      activeStageIndex = i;
      break;
    }
  }
  if (activeStageIndex < 0 && isRunning && stages.length >= 2) {
    activeStageIndex = icon === "cooker" ? Math.min(2, stages.length - 1) : 1;
  }

  const progressPercent = isRunning
    ? remainingMinutes !== undefined
      ? Math.max(12, Math.min(92, Math.round(100 - (remainingMinutes / 60) * 100)))
      : undefined
    : stageLabel === "保温中" || stageLabel === "保管中"
      ? 100
      : undefined;

  return {
    stageLabel,
    stages,
    activeStageIndex,
    remainingMinutes,
    keepWarmMinutes: keepWarmMinutes !== undefined && keepWarmMinutes > 0 ? keepWarmMinutes : undefined,
    progressPercent,
    temperatureCelsius: tempMetric?.numericValue,
    targetTempCelsius,
    isRunning,
  };
}

function buildUnifiedControls(
  icon: ApplianceIconKind,
  capabilities: ApplianceCapabilities,
  deviceRecords: RawHomeEntityRecord[],
): ApplianceControlPrimitive[] {
  const controls: ApplianceControlPrimitive[] = [];
  const usedEntityKeys = new Set<string>();

  if (capabilities.power) {
    controls.push({
      kind: "toggle",
      id: `${capabilities.power.entityId}:power`,
      label: "电源开关",
      entityId: capabilities.power.entityId,
      domain: capabilities.power.domain,
      serviceOn: "turn_on",
      serviceOff: "turn_off",
      isOn: capabilities.power.isOn,
      controllable: capabilities.power.controllable,
      role: "primary_power",
    });
    usedEntityKeys.add(`${capabilities.power.entityId}:toggle`);
  }

  if (capabilities.multiGang) {
    for (const ch of capabilities.multiGang.channels) {
      controls.push({
        kind: "toggle",
        id: ch.id,
        label: ch.label,
        entityId: ch.entityId,
        domain: ch.domain,
        serviceOn: "turn_on",
        serviceOff: "turn_off",
        isOn: ch.isOn,
        controllable: ch.controllable,
        role: "channel",
      });
      usedEntityKeys.add(`${ch.entityId}:toggle`);
    }
  }

  if (capabilities.thermostat) {
    const t = capabilities.thermostat;
    controls.push({
      kind: "range",
      id: "thermostat",
      label: icon === "kettle" ? "保温温度" : "目标温度",
      entityId: t.entityId,
      domain: t.domain,
      service: t.domain === "climate" ? "set_temperature" : "set_value",
      parameterKey: t.domain === "climate" ? "temperature" : "value",
      value: t.targetTemp,
      min: t.minTemp,
      max: t.maxTemp,
      step: t.step,
      unit: t.unit,
      controllable: t.controllable,
    });
    usedEntityKeys.add(`${t.entityId}:range`);
  }

  if (capabilities.dimmer) {
    const d = capabilities.dimmer;
    if (d.brightnessPercent !== undefined || d.controllable) {
      controls.push({
        kind: "range",
        id: "brightness",
        label: "亮度",
        entityId: d.entityId,
        domain: "light",
        service: "turn_on",
        parameterKey: "brightness_pct",
        value: d.brightnessPercent ?? 100,
        min: 1,
        max: 100,
        step: 1,
        unit: "%",
        controllable: d.controllable,
      });
    }
    if (d.colorTempKelvin !== undefined) {
      const [minK, maxK] = d.colorTempRange ?? [2700, 6500];
      controls.push({
        kind: "range",
        id: "color_temp",
        label: "色温",
        entityId: d.entityId,
        domain: "light",
        service: "turn_on",
        parameterKey: "color_temp_kelvin",
        value: d.colorTempKelvin,
        min: minK,
        max: maxK,
        step: 100,
        unit: "K",
        controllable: d.controllable,
      });
    }
    usedEntityKeys.add(`${d.entityId}:range`);
  }

  if (capabilities.modeBar) {
    const m = capabilities.modeBar;
    controls.push({
      kind: "choice",
      id: "mode",
      label: icon === "light" || icon === "desk_lamp" ? "灯光场景" : "工作模式",
      entityId: m.entityId,
      domain: m.domain,
      service: m.service,
      parameterKey: m.parameterKey,
      currentValue: m.currentMode,
      currentLabel: m.currentLabel,
      options: m.options,
      controllable: m.controllable,
    });
    usedEntityKeys.add(`${m.entityId}:${m.parameterKey}`);
  }

  if (capabilities.fanLevel) {
    const f = capabilities.fanLevel;
    controls.push({
      kind: "choice",
      id: "fan_level",
      label: "风速档位",
      entityId: f.entityId,
      domain: f.domain,
      service: f.service,
      parameterKey: f.parameterKey,
      currentValue: f.currentMode,
      currentLabel: f.currentLabel,
      options: f.options,
      controllable: f.controllable,
    });
    usedEntityKeys.add(`${f.entityId}:${f.parameterKey}`);
  }

  if (capabilities.vacuum?.mopModeBar) {
    const mop = capabilities.vacuum.mopModeBar;
    controls.push({
      kind: "choice",
      id: "mop_mode",
      label: "拖地水量",
      entityId: mop.entityId,
      domain: mop.domain,
      service: mop.service,
      parameterKey: mop.parameterKey,
      currentValue: mop.currentMode,
      currentLabel: mop.currentLabel,
      options: mop.options,
      controllable: mop.controllable,
    });
    usedEntityKeys.add(`${mop.entityId}:${mop.parameterKey}`);
  }

  if (capabilities.visionStream?.modeSelectors) {
    for (const sel of capabilities.visionStream.modeSelectors) {
      const c = sel.capability;
      if (usedEntityKeys.has(`${c.entityId}:${c.parameterKey}`)) continue;
      controls.push({
        kind: "choice",
        id: sel.id,
        label: sel.label,
        entityId: c.entityId,
        domain: c.domain,
        service: c.service,
        parameterKey: c.parameterKey,
        currentValue: c.currentMode,
        currentLabel: c.currentLabel,
        options: c.options,
        controllable: c.controllable,
      });
      usedEntityKeys.add(`${c.entityId}:${c.parameterKey}`);
    }
  }

  // Additional writable select entities (e.g. horizontal_swing_included_angle, led_light)
  for (const r of deviceRecords) {
    if (r.domain !== "select") continue;
    if (usedEntityKeys.has(`${r.entity_id}:option`)) continue;
    const rawOpts = Array.isArray(r.snapshot?.attributes?.options)
      ? (r.snapshot?.attributes?.options as string[])
      : [];
    if (rawOpts.length === 0) continue;
    const cur = stringState(r) ?? String(rawOpts[0]);
    const labelHint = entityLabelText(r);
    controls.push({
      kind: "choice",
      id: `${r.entity_id}:option`,
      label: translateControlLabel(r, "档位调节"),
      entityId: r.entity_id,
      domain: "select",
      service: "select_option",
      parameterKey: "option",
      currentValue: cur,
      currentLabel: translateOptionLabel(cur, labelHint),
      options: rawOpts.map((o) => ({
        value: String(o),
        label: translateOptionLabel(String(o), labelHint),
      })),
      controllable: r.supported_features.includes("select_option"),
    });
    usedEntityKeys.add(`${r.entity_id}:option`);
  }

  // Additional writable number entities (e.g. favorite_level, target_humidity, delay_off_time, volume)
  for (const r of deviceRecords) {
    if (r.domain !== "number") continue;
    if (usedEntityKeys.has(`${r.entity_id}:range`)) continue;
    if (!r.supported_features.includes("set_value")) continue;
    const val = numericState(r);
    const min = typeof r.snapshot?.attributes?.min === "number" ? (r.snapshot.attributes.min as number) : 0;
    const max = typeof r.snapshot?.attributes?.max === "number" ? (r.snapshot.attributes.max as number) : 100;
    const step = typeof r.snapshot?.attributes?.step === "number" ? (r.snapshot.attributes.step as number) : 1;
    const unit = String(r.snapshot?.attributes?.unit_of_measurement ?? "");
    controls.push({
      kind: "range",
      id: `${r.entity_id}:range`,
      label: translateControlLabel(r, "数值调节"),
      entityId: r.entity_id,
      domain: "number",
      service: "set_value",
      parameterKey: "value",
      value: val ?? min,
      min,
      max,
      step,
      ...(unit ? { unit } : {}),
      controllable: true,
    });
    usedEntityKeys.add(`${r.entity_id}:range`);
  }

  // HA Fan oscillate toggle if supported on fan entity
  const fanRec = deviceRecords.find((r) => r.domain === "fan");
  if (fanRec && fanRec.supported_features.includes("oscillate")) {
    const osc = Boolean(fanRec.snapshot?.attributes?.oscillating);
    controls.push({
      kind: "toggle",
      id: `${fanRec.entity_id}:oscillate`,
      label: "左右摆风",
      entityId: fanRec.entity_id,
      domain: "fan",
      serviceOn: "oscillate",
      serviceOff: "oscillate",
      serviceDataOn: { oscillating: true },
      serviceDataOff: { oscillating: false },
      isOn: osc,
      controllable: true,
      role: "swing",
    });
  }

  if (capabilities.auxiliaryToggles) {
    for (const t of capabilities.auxiliaryToggles) {
      if (usedEntityKeys.has(`${t.entityId}:toggle`)) continue;
      controls.push({
        kind: "toggle",
        id: t.id,
        label: t.label,
        entityId: t.entityId,
        domain: t.domain,
        serviceOn: "turn_on",
        serviceOff: "turn_off",
        isOn: t.isOn,
        controllable: t.controllable,
        role: /摆风|扫风|摇头|swing/i.test(t.label) ? "swing" : "feature",
      });
      usedEntityKeys.add(`${t.entityId}:toggle`);
    }
  }

  if (capabilities.visionStream?.featureToggles) {
    for (const t of capabilities.visionStream.featureToggles) {
      if (usedEntityKeys.has(`${t.entityId}:toggle`)) continue;
      controls.push({
        kind: "toggle",
        id: t.id,
        label: t.label,
        entityId: t.entityId,
        domain: t.domain,
        serviceOn: "turn_on",
        serviceOff: "turn_off",
        isOn: t.isOn,
        controllable: t.controllable,
        role: "feature",
      });
      usedEntityKeys.add(`${t.entityId}:toggle`);
    }
  }

  if (capabilities.actions) {
    for (const a of capabilities.actions) {
      controls.push({
        kind: "action",
        id: a.id,
        label: a.label,
        entityId: a.entityId,
        domain: a.domain,
        service: a.service,
        serviceData: a.serviceData,
        tone: a.tone,
        iconKey: a.iconKey,
      });
    }
  }

  if (capabilities.visionStream?.ptzActions) {
    for (const a of capabilities.visionStream.ptzActions) {
      controls.push({
        kind: "action",
        id: a.id,
        label: a.label,
        entityId: a.entityId,
        domain: a.domain,
        service: a.service,
        serviceData: a.serviceData,
        tone: a.tone,
        iconKey: a.iconKey,
      });
    }
  }

  for (const m of capabilities.telemetry) {
    controls.push({
      kind: "metric",
      id: `metric:${m.key}`,
      label: m.label,
      value: m.value,
      numericValue: m.numericValue,
      unit: m.unit,
      badge: m.badge,
    });
  }

  return controls;
}

export function buildHomeDashboardModel(
  records: RawHomeEntityRecord[],
  layoutPrefs?: HomeLayoutPreferences,
  lang: "zh-CN" | "en-US" = "zh-CN",
): HomeDashboardModel {
  const groups = new Map<string, RawHomeEntityRecord[]>();

  for (const record of records) {
    const source: HomeSourceId = record.source ?? "external_ha";
    const deviceKey = record.device_id?.trim() || record.device_name?.trim() || record.entity_id;
    const compositeKey = `${source}:${deviceKey}`;
    const list = groups.get(compositeKey) ?? [];
    list.push({ ...record, source });
    groups.set(compositeKey, list);
  }

  let detectedHomeName = lang === "en-US" ? "My Home" : "我的家";
  const appliances: HomeAppliance[] = [];

  for (const [groupId, deviceRecords] of groups.entries()) {
    const primary = findPrimaryPowerEntity(deviceRecords);
    const first = primary ?? deviceRecords[0]!;
    const source: HomeSourceId = first.source ?? "external_ha";
    const sourceLabel = lang === "en-US" ? SOURCE_LABELS[source].en : SOURCE_LABELS[source].zh;

    const rawDeviceName = (first.device_name ?? first.friendly_name ?? first.entity_id).trim();
    const roomInfo = normalizeRoomName(first.room, rawDeviceName, lang);
    if (roomInfo.homeName) {
      detectedHomeName = roomInfo.homeName;
    }

    const name = cleanApplianceDisplayName(rawDeviceName, roomInfo.room, roomInfo.homeName);
    const displayName = formatConciseCardDisplayName(name, roomInfo.room);
    const model = first.device_model ?? "";
    const { archetype, icon } = classifyAppliance(name, model, deviceRecords);

    const telemetry = extractTelemetry(deviceRecords, icon, groupId);

    // Skip pure diagnostic orphans that have neither controls nor telemetry
    const allDiagnostic = deviceRecords.every(
      (r) => r.entity_category === "diagnostic" || r.entity_category === "config",
    );
    if (allDiagnostic && telemetry.length === 0 && archetype === "sensor_pet" && icon === "sensor") {
      continue;
    }

    const capabilities: ApplianceCapabilities = { telemetry };
    const online = deviceRecords.some(isEntityOnline);
    let isActive = false;
    let statusBadge = online ? (lang === "en-US" ? "Standby" : "待机") : lang === "en-US" ? "Offline" : "离线";
    let conciseSubtitle = sourceLabel;

    // 1. Multi-gang wall switch
    if (icon === "switch_gang") {
      const gangRecords = deviceRecords.filter(
        (r) =>
          r.domain === "switch" &&
          r.entity_category !== "config" &&
          r.entity_category !== "diagnostic" &&
          !/转无线|无线开关|mode_p_|防闪烁|互锁|指示灯/i.test(entityLabelText(r)) &&
          /左键|中键|右键|键1|键2|键3|left|middle|right|channel_[123]/i.test(entityLabelText(r)),
      );
      const effectiveGangs =
        gangRecords.length > 0 ? gangRecords : deviceRecords.filter((r) => r.domain === "switch").slice(0, 3);
      const channels: MultiGangChannel[] = effectiveGangs.map((r, idx) => ({
        id: r.entity_id,
        label: cleanGangLabel(r, idx),
        entityId: r.entity_id,
        domain: "switch",
        isOn: r.snapshot?.state === "on",
        controllable: r.supported_features.includes("turn_on"),
      }));
      capabilities.multiGang = { channels };
      const onCount = channels.filter((c) => c.isOn).length;
      isActive = onCount > 0;
      statusBadge = `${onCount}/${channels.length} 开启`;
      conciseSubtitle = onCount > 0 ? `已开 ${onCount} 路` : "全部关闭";
    }

    // 2. Primary power capability
    if (
      primary &&
      icon !== "switch_gang" &&
      icon !== "lock" &&
      icon !== "bell" &&
      icon !== "sensor" &&
      icon !== "vacuum" &&
      icon !== "cooker" &&
      icon !== "kettle" &&
      icon !== "feeder" &&
      icon !== "waterer"
    ) {
      const st = String(primary.snapshot?.state ?? "off").toLowerCase();
      const isOn =
        st !== "off" && st !== "idle" && st !== "standby" && st !== "unavailable" && st !== "unknown";
      capabilities.power = {
        entityId: primary.entity_id,
        domain: primary.domain,
        isOn,
        controllable:
          primary.supported_features.includes("turn_on") ||
          primary.supported_features.includes("turn_off"),
      };
      isActive = isOn;
      statusBadge = isOn ? "已开启" : "已关闭";
    }

    // 3. Light & Desk Lamp dimmer / scene capability
    if ((icon === "light" || icon === "desk_lamp") && primary) {
      const rawBri = primary.snapshot?.attributes?.brightness;
      const briPct =
        typeof rawBri === "number" && Number.isFinite(rawBri)
          ? Math.max(1, Math.min(100, Math.round((rawBri / 255) * 100)))
          : undefined;
      const rawCt = primary.snapshot?.attributes?.color_temp_kelvin;
      const ctKelvin = typeof rawCt === "number" && Number.isFinite(rawCt) ? Math.round(rawCt) : undefined;
      const ctRange = primary.allowed_range?.color_temp_kelvin;

      if (
        primary.supported_features.includes("brightness") ||
        primary.supported_features.includes("color_temp") ||
        briPct !== undefined
      ) {
        capabilities.dimmer = {
          entityId: primary.entity_id,
          brightnessPercent: briPct,
          colorTempKelvin: ctKelvin,
          colorTempRange: ctRange,
          controllable: primary.supported_features.includes("brightness"),
        };
      }

      const lightSelect = deviceRecords.find(
        (r) => r.domain === "select" && /mode|模式|场景|scene/i.test(entityLabelText(r)),
      );
      if (lightSelect) {
        const rawOpts = Array.isArray(lightSelect.snapshot?.attributes?.options)
          ? (lightSelect.snapshot?.attributes?.options as string[])
          : [];
        if (rawOpts.length > 0) {
          const cur = stringState(lightSelect) ?? String(rawOpts[0]);
          capabilities.modeBar = {
            entityId: lightSelect.entity_id,
            domain: "select",
            service: "select_option",
            parameterKey: "option",
            currentMode: cur,
            currentLabel: translateOptionLabel(cur, icon),
            options: rawOpts.map((o) => ({
              value: String(o),
              label: translateOptionLabel(String(o), icon),
            })),
            controllable: lightSelect.supported_features.includes("select_option"),
          };
        }
      }

      const lightActions = buildActionTriggers(deviceRecords, icon);
      if (lightActions.length > 0) {
        capabilities.actions = lightActions;
      }

      conciseSubtitle = capabilities.power?.isOn
        ? briPct !== undefined
          ? `亮度 ${briPct}%`
          : capabilities.modeBar
            ? `场景 · ${capabilities.modeBar.currentLabel}`
            : "照明开启"
        : "已关闭";
    }

    // 4. Climate & Thermostat capability
    if (archetype === "climate") {
      const climateRec = deviceRecords.find((r) => r.domain === "climate" || r.domain === "humidifier");
      const fanEntity = deviceRecords.find((r) => r.domain === "fan");
      const targetNumRec = deviceRecords.find(
        (r) => r.domain === "number" && /目标温度|保温温度|设定温度|target_temp|keep_warm_temp/i.test(entityLabelText(r)),
      );
      const currentTempMetric = telemetry.find((m) => m.key === "temperature");
      const unitAttr = String(climateRec?.snapshot?.attributes?.unit_of_measurement ?? "");
      const rawCurrentAttr =
        typeof climateRec?.snapshot?.attributes?.current_temperature === "number"
          ? (climateRec.snapshot.attributes.current_temperature as number)
          : undefined;
      const normalizedCurrentAttr =
        rawCurrentAttr !== undefined ? normalizeCelsius(rawCurrentAttr, unitAttr, true) : undefined;
      // Ignore invalid >45°C outdoor pipe readings when AC is off
      const attrCurrentTemp =
        normalizedCurrentAttr !== undefined && normalizedCurrentAttr <= 45
          ? normalizedCurrentAttr
          : currentTempMetric?.numericValue;

      if (climateRec && climateRec.domain === "climate") {
        const rawTarget =
          typeof climateRec.snapshot?.attributes?.temperature === "number"
            ? (climateRec.snapshot.attributes.temperature as number)
            : 26;
        const target = normalizeCelsius(rawTarget, unitAttr, true);
        const rawMin =
          typeof climateRec.snapshot?.attributes?.min_temp === "number"
            ? (climateRec.snapshot.attributes.min_temp as number)
            : 16;
        const minTemp = rawMin > 45 ? 16 : rawMin;
        const rawMax =
          typeof climateRec.snapshot?.attributes?.max_temp === "number"
            ? (climateRec.snapshot.attributes.max_temp as number)
            : 31;
        const maxTemp = rawMax > 50 ? 31 : rawMax;
        const step =
          typeof climateRec.snapshot?.attributes?.target_temp_step === "number"
            ? (climateRec.snapshot.attributes.target_temp_step as number)
            : 0.5;
        capabilities.thermostat = {
          entityId: climateRec.entity_id,
          domain: "climate",
          currentTemp: attrCurrentTemp,
          targetTemp: target,
          minTemp,
          maxTemp,
          step,
          unit: "°C",
          controllable:
            climateRec.supported_features.includes("set_temperature") ||
            climateRec.supported_features.includes("turn_on"),
        };

        const rawModes = Array.isArray(climateRec.snapshot?.attributes?.hvac_modes)
          ? (climateRec.snapshot?.attributes?.hvac_modes as string[])
          : ["cool", "heat", "dry", "auto", "off"];
        const options: ModeOption[] = rawModes.map((m) => ({
          value: String(m),
          label: translateOptionLabel(String(m), "ac"),
        }));
        const currentMode = String(climateRec.snapshot?.state ?? "cool");
        capabilities.modeBar = {
          entityId: climateRec.entity_id,
          domain: "climate",
          service: "set_hvac_mode",
          parameterKey: "hvac_mode",
          currentMode,
          currentLabel: translateOptionLabel(currentMode, "ac"),
          options,
          controllable:
            climateRec.supported_features.includes("set_hvac_mode") ||
            climateRec.supported_features.includes("turn_on"),
        };

        if (Array.isArray(climateRec.snapshot?.attributes?.fan_modes)) {
          const rawFanModes = climateRec.snapshot.attributes.fan_modes as string[];
          if (rawFanModes.length > 0) {
            const curFan = String(climateRec.snapshot?.attributes?.fan_mode ?? rawFanModes[0]);
            capabilities.fanLevel = {
              entityId: climateRec.entity_id,
              domain: "climate",
              service: "set_fan_mode",
              parameterKey: "fan_mode",
              currentMode: curFan,
              currentLabel: translateOptionLabel(curFan, "fan"),
              options: rawFanModes.slice(0, 8).map((fm) => ({
                value: String(fm),
                label: translateOptionLabel(String(fm), "fan"),
              })),
              controllable:
                climateRec.supported_features.includes("set_fan_mode") ||
                climateRec.supported_features.includes("turn_on"),
            };
          }
        }

        isActive = currentMode !== "off" && currentMode !== "unavailable" && currentMode !== "unknown";
        const modeTitle = translateOptionLabel(currentMode, "ac") || "运行中";
        statusBadge = isActive ? modeTitle : "已关闭";
        conciseSubtitle = isActive
          ? `${modeTitle} · ${target}°C`
          : attrCurrentTemp !== undefined
            ? `已关闭 · 室温 ${attrCurrentTemp}°C`
            : `已关闭 · 设定 ${target}°C`;
      } else if (targetNumRec) {
        const target = numericState(targetNumRec) ?? (icon === "kettle" ? 55 : 26);
        const minTemp =
          typeof targetNumRec.snapshot?.attributes?.min === "number"
            ? (targetNumRec.snapshot.attributes.min as number)
            : icon === "kettle"
              ? 40
              : 16;
        const maxTemp =
          typeof targetNumRec.snapshot?.attributes?.max === "number"
            ? (targetNumRec.snapshot.attributes.max as number)
            : icon === "kettle"
              ? 90
              : 45;
        const step =
          typeof targetNumRec.snapshot?.attributes?.step === "number"
            ? (targetNumRec.snapshot.attributes.step as number)
            : icon === "kettle"
              ? 1
              : 0.5;
        capabilities.thermostat = {
          entityId: targetNumRec.entity_id,
          domain: "number",
          currentTemp: attrCurrentTemp,
          targetTemp: target,
          minTemp,
          maxTemp,
          step,
          unit: "°C",
          controllable: targetNumRec.supported_features.includes("set_value"),
        };
        if (icon === "kettle") {
          const kettleStatusRec = deviceRecords.find(
            (r) => r.domain === "sensor" && /\bstatus\b|状态/i.test(entityLabelText(r)),
          );
          const rawKettleSt = stringState(kettleStatusRec) ?? "";
          const kettleRunning = !rawKettleSt || !/^(idle|off|standby|0|待机|休眠)$/i.test(rawKettleSt.trim());
          isActive = kettleRunning;
          statusBadge = attrCurrentTemp !== undefined ? `${attrCurrentTemp}°C` : kettleRunning ? "保温中" : "待机";
          conciseSubtitle = `设定 ${target}°C`;
        } else {
          isActive = capabilities.power ? capabilities.power.isOn : true;
          statusBadge = isActive
            ? `${target}°C`
            : "已关闭";
          conciseSubtitle = isActive
            ? `设定 ${target}°C${attrCurrentTemp !== undefined ? ` · 室温 ${attrCurrentTemp}°C` : ""}`
            : attrCurrentTemp !== undefined
              ? `室温 ${attrCurrentTemp}°C`
              : `设定 ${target}°C`;
        }
      } else {
        const tempStr = currentTempMetric ? currentTempMetric.value : undefined;
        const pmMetric = telemetry.find((m) => m.key === "pm25");
        const pmStr = pmMetric ? `PM2.5 ${pmMetric.value}${pmMetric.badge ? ` ${pmMetric.badge}` : ""}` : undefined;
        conciseSubtitle = [tempStr, pmStr].filter(Boolean).join(" · ") || statusBadge;
      }

      // Mode bar for fan / purifier / dehumidifier / Direct MIoT AC / kettle
      if (!capabilities.modeBar) {
        if (
          fanEntity &&
          Array.isArray(fanEntity.snapshot?.attributes?.preset_modes) &&
          (fanEntity.snapshot.attributes.preset_modes as string[]).length > 0
        ) {
          const rawOpts = fanEntity.snapshot.attributes.preset_modes as string[];
          const current = String(fanEntity.snapshot?.attributes?.preset_mode ?? rawOpts[0] ?? "直吹风");
          capabilities.modeBar = {
            entityId: fanEntity.entity_id,
            domain: "fan",
            service: "set_preset_mode",
            parameterKey: "preset_mode",
            currentMode: current,
            currentLabel: translateOptionLabel(current, icon),
            options: rawOpts.slice(0, 6).map((o) => ({
              value: String(o),
              label: translateOptionLabel(String(o), icon),
            })),
            controllable:
              fanEntity.supported_features.includes("set_preset_mode") ||
              fanEntity.supported_features.includes("turn_on"),
          };
        } else {
          const modeSelectRec =
            deviceRecords.find(
              (r) =>
                r.domain === "select" &&
                !/fan_level|风速|档位|angle|角度|led|light/i.test(entityLabelText(r)) &&
                /\bmode\b|模式|功能|水温|water/i.test(entityLabelText(r)),
            ) ??
            deviceRecords.find(
              (r) =>
                r.domain === "select" &&
                !/angle|角度|led|light/i.test(entityLabelText(r)) &&
                /模式|档位|mode|fan_level/i.test(entityLabelText(r)),
            );
          if (modeSelectRec) {
            const rawOpts = Array.isArray(modeSelectRec.snapshot?.attributes?.options)
              ? (modeSelectRec.snapshot?.attributes?.options as string[])
              : ["自动", "睡眠", "高速"];
            const current = stringState(modeSelectRec) ?? rawOpts[0] ?? "自动";
            capabilities.modeBar = {
              entityId: modeSelectRec.entity_id,
              domain: "select",
              service: "select_option",
              parameterKey: "option",
              currentMode: current,
              currentLabel: translateOptionLabel(current, icon),
              options: rawOpts.map((o) => ({
                value: String(o),
                label: translateOptionLabel(String(o), icon),
              })),
              controllable: modeSelectRec.supported_features.includes("select_option"),
            };
          }
        }
      }

      // Fan level bar for fan / AC / purifier
      if (!capabilities.fanLevel) {
        const fanLevelSelect = deviceRecords.find(
          (r) =>
            r.domain === "select" &&
            r.entity_id !== capabilities.modeBar?.entityId &&
            /fan_level|风速|档位/i.test(entityLabelText(r)),
        );
        if (fanLevelSelect) {
          const rawOpts = Array.isArray(fanLevelSelect.snapshot?.attributes?.options)
            ? (fanLevelSelect.snapshot?.attributes?.options as string[])
            : ["1档", "2档", "3档", "4档"];
          const current = stringState(fanLevelSelect) ?? rawOpts[0] ?? "1档";
          capabilities.fanLevel = {
            entityId: fanLevelSelect.entity_id,
            domain: "select",
            service: "select_option",
            parameterKey: "option",
            currentMode: current,
            currentLabel: translateOptionLabel(current, "fan"),
            options: rawOpts.slice(0, 8).map((o) => ({
              value: String(o),
              label: translateOptionLabel(String(o), "fan"),
            })),
            controllable: fanLevelSelect.supported_features.includes("select_option"),
          };
        } else if (fanEntity && fanEntity.supported_features.includes("set_percentage")) {
          const pct =
            typeof fanEntity.snapshot?.attributes?.percentage === "number"
              ? (fanEntity.snapshot.attributes.percentage as number)
              : 25;
          const quantized = pct <= 25 ? "25" : pct <= 50 ? "50" : pct <= 75 ? "75" : "100";
          const levelMap: Record<string, string> = {
            "25": "1档",
            "50": "2档",
            "75": "3档",
            "100": "4档",
          };
          capabilities.fanLevel = {
            entityId: fanEntity.entity_id,
            domain: "fan",
            service: "set_percentage",
            parameterKey: "percentage",
            currentMode: quantized,
            currentLabel: levelMap[quantized] ?? `${pct}%`,
            options: [
              { value: "25", label: "1档" },
              { value: "50", label: "2档" },
              { value: "75", label: "3档" },
              { value: "100", label: "4档" },
            ],
            controllable: true,
          };
        }
      }

      if (icon === "ac" && capabilities.thermostat) {
        const modeLabel = capabilities.modeBar?.currentLabel ?? "运行中";
        if (isActive) {
          statusBadge = `${modeLabel} ${capabilities.thermostat.targetTemp}°C`;
          conciseSubtitle = `${modeLabel} · ${capabilities.thermostat.targetTemp}°C`;
        } else {
          statusBadge = "已关闭";
        }
      } else if (icon === "fan") {
        const modeLabel = capabilities.modeBar?.currentLabel;
        const levelLabel = capabilities.fanLevel?.currentLabel;
        if (isActive) {
          statusBadge = levelLabel ?? modeLabel ?? "送风中";
          conciseSubtitle = [modeLabel, levelLabel].filter(Boolean).join(" · ") || "运行中";
        } else {
          statusBadge = "已关闭";
          conciseSubtitle = levelLabel
            ? `已关闭 · 记忆${levelLabel}`
            : modeLabel
              ? `已关闭 · ${modeLabel}`
              : "待机";
        }
      } else if (icon === "purifier") {
        const pmMetric = telemetry.find((m) => m.key === "pm25");
        const modeLabel = capabilities.modeBar?.currentLabel;
        statusBadge = isActive ? modeLabel ?? "净化中" : "已关闭";
        conciseSubtitle =
          [
            pmMetric ? `PM2.5 ${pmMetric.value}${pmMetric.badge ? ` ${pmMetric.badge}` : ""}` : undefined,
            modeLabel,
          ]
            .filter(Boolean)
            .join(" · ") || statusBadge;
      }

      capabilities.actions = buildActionTriggers(deviceRecords, icon);

      const auxSwitches = deviceRecords
        .filter(
          (r) =>
            r.domain === "switch" &&
            r.entity_id !== capabilities.power?.entityId &&
            r.supported_features.includes("turn_on") &&
            /扫风|摇头|摆风|直吹|辅热|睡眠|干燥|负离子|保温|除菌|除氯|速冷|煮沸|节能|指示灯|童锁|提示音|swing|straight_blowing|heater|sleep|dryer|anion|keep_warm|dechlorination|rapid_cooling|over_boiling|eco|indicator|physical_controls_locked|child_lock|alarm/i.test(
              entityLabelText(r),
            ),
        )
        .slice(0, 8);
      if (auxSwitches.length > 0) {
        capabilities.auxiliaryToggles = auxSwitches.map((r) => ({
          id: r.entity_id,
          label: translateSwitchLabel(r),
          entityId: r.entity_id,
          domain: "switch",
          isOn: r.snapshot?.state === "on",
          controllable: r.supported_features.includes("turn_on"),
        }));
      }
    }

    // 5. Cycle / Batch task appliances (Rice cooker, Washer, Dishwasher, Microwave, Vacuum)
    if (archetype === "cycle_appliance") {
      const vacuumCap = icon === "vacuum" ? buildVacuumCapability(deviceRecords, telemetry) : undefined;
      if (vacuumCap) {
        capabilities.vacuum = vacuumCap;
      }

      const cycle = buildCycleTaskCapability(icon, deviceRecords, telemetry, vacuumCap);
      capabilities.cycleTask = cycle;
      capabilities.actions = buildActionTriggers(deviceRecords, icon);

      const modeSelect = deviceRecords.find(
        (r) =>
          r.domain === "select" &&
          !/mop_mode|water_output|水量/i.test(entityLabelText(r)) &&
          /模式|程序|菜单|吸力|mode/i.test(entityLabelText(r)),
      );
      if (modeSelect) {
        const rawOpts = Array.isArray(modeSelect.snapshot?.attributes?.options)
          ? (modeSelect.snapshot?.attributes?.options as string[])
          : icon === "cooker"
            ? ["精煮饭", "快煮饭", "煮粥", "热饭", "保温"]
            : icon === "vacuum"
              ? ["安静", "标准", "强力", "超强"]
              : ["混合洗", "快洗", "单脱水"];
        const cur = stringState(modeSelect) ?? rawOpts[0] ?? "标准";
        const translatedCur = translateOptionLabel(cur, icon);
        capabilities.modeBar = {
          entityId: modeSelect.entity_id,
          domain: "select",
          service: "select_option",
          parameterKey: "option",
          currentMode: cur,
          currentLabel: translatedCur,
          options: rawOpts.slice(0, 8).map((o) => ({
            value: String(o),
            label: translateOptionLabel(String(o), icon),
          })),
          controllable: modeSelect.supported_features.includes("select_option"),
        };
        cycle.recipeLabel = translatedCur;
      }

      // Auxiliary toggles for cycle appliances (e.g. rice cooker auto-keep-warm, vacuum carpet boost, child lock, alarm)
      const cycleAuxSwitches = deviceRecords
        .filter(
          (r) =>
            r.domain === "switch" &&
            r.entity_id !== capabilities.power?.entityId &&
            r.supported_features.includes("turn_on") &&
            /保温|地毯|除菌|烘干|抖散|童锁|提示音|keep_warm|carpet|steril|dry|physical_controls_locked|child_lock|alarm/i.test(
              entityLabelText(r),
            ),
        )
        .slice(0, 6);
      if (cycleAuxSwitches.length > 0) {
        capabilities.auxiliaryToggles = cycleAuxSwitches.map((r) => ({
          id: r.entity_id,
          label: translateSwitchLabel(r),
          entityId: r.entity_id,
          domain: "switch",
          isOn: r.snapshot?.state === "on",
          controllable: r.supported_features.includes("turn_on"),
        }));
      }

      if (icon === "vacuum" && vacuumCap) {
        isActive = cycle.isRunning;
        statusBadge = vacuumCap.statusLabel;
        const parts: string[] = [];
        if (vacuumCap.batteryPercent !== undefined) {
          parts.push(`电量 ${vacuumCap.batteryPercent}%`);
        }
        if (vacuumCap.cleaningAreaSqm !== undefined && vacuumCap.cleaningAreaSqm > 0) {
          parts.push(
            cycle.isRunning ? `已扫 ${vacuumCap.cleaningAreaSqm}㎡` : `上次 ${vacuumCap.cleaningAreaSqm}㎡`,
          );
        } else if (vacuumCap.chargingLabel) {
          parts.push(vacuumCap.chargingLabel);
        }
        conciseSubtitle = parts.join(" · ") || vacuumCap.statusLabel;
      } else {
        isActive = cycle.isRunning;
        statusBadge = cycle.stageLabel;
        const distinctRecipe =
          cycle.recipeLabel &&
          !cycle.stageLabel.includes(cycle.recipeLabel) &&
          !cycle.recipeLabel.includes(cycle.stageLabel)
            ? cycle.recipeLabel
            : undefined;
        if (cycle.remainingMinutes !== undefined && cycle.remainingMinutes > 0) {
          conciseSubtitle = distinctRecipe
            ? `${distinctRecipe} · 剩余 ${cycle.remainingMinutes}m`
            : `剩余 ${cycle.remainingMinutes}m`;
        } else if (cycle.keepWarmMinutes !== undefined && cycle.keepWarmMinutes > 0) {
          conciseSubtitle = `已保温 ${cycle.keepWarmMinutes}m`;
        } else if (cycle.temperatureCelsius !== undefined) {
          conciseSubtitle = `${cycle.temperatureCelsius}°C · ${cycle.stageLabel}`;
        } else if (distinctRecipe) {
          conciseSubtitle = `${distinctRecipe} · ${cycle.stageLabel}`;
        } else {
          conciseSubtitle = cycle.stageLabel;
        }
      }
    }

    // 6. Vision & Security (Camera, Doorbell, Smart Lock)
    if (archetype === "vision_security") {
      if (icon === "camera") {
        const cameraEntity = deviceRecords.find((r) => r.domain === "camera");
        const startBtn = deviceRecords.find(
          (r) => r.domain === "button" && /开启.*(p2p|hls|流)|start.*stream/i.test(entityLabelText(r)),
        );
        const stopBtn = deviceRecords.find(
          (r) => r.domain === "button" && /停止.*(p2p|hls|流)|stop.*stream/i.test(entityLabelText(r)),
        );
        const restartBtn = deviceRecords.find(
          (r) => r.domain === "button" && /重启|restart/i.test(entityLabelText(r)),
        );
        const toggles = deviceRecords
          .filter(
            (r) =>
              r.domain === "switch" &&
              r.entity_id !== capabilities.power?.entityId &&
              r.supported_features.includes("turn_on") &&
              /休眠|遮蔽|移动侦测|追踪|巡航|水印|宽动态|全彩|夜视|watermark|motion_detection|motion_tracking|wdr|glimmer_full_color/i.test(
                entityLabelText(r),
              ),
          )
          .slice(0, 6)
          .map((r) => ({
            id: r.entity_id,
            label: translateSwitchLabel(r),
            entityId: r.entity_id,
            domain: "switch",
            isOn: r.snapshot?.state !== "off",
            controllable: r.supported_features.includes("turn_on"),
          }));

        // Camera mode selectors (Night vision, Recording mode, Sensitivity)
        const modeSelectors: NonNullable<ApplianceCapabilities["visionStream"]>["modeSelectors"] = [];
        for (const selectRec of deviceRecords) {
          if (selectRec.domain !== "select") continue;
          const labelText = entityLabelText(selectRec);
          const rawOpts = Array.isArray(selectRec.snapshot?.attributes?.options)
            ? (selectRec.snapshot?.attributes?.options as string[])
            : [];
          const cur = stringState(selectRec) ?? rawOpts[0] ?? "自动";
          if (/夜视|night_shot/i.test(labelText)) {
            const opts = rawOpts.length > 0 ? rawOpts : ["自动", "始终开启", "关闭"];
            modeSelectors.push({
              id: selectRec.entity_id,
              label: "夜视模式",
              capability: {
                entityId: selectRec.entity_id,
                domain: "select",
                service: "select_option",
                parameterKey: "option",
                currentMode: cur,
                currentLabel: translateOptionLabel(cur, "camera"),
                options: opts.map((o) => ({
                  value: String(o),
                  label: translateOptionLabel(String(o), "camera"),
                })),
                controllable: selectRec.supported_features.includes("select_option"),
              },
            });
          } else if (/灵敏度|sensitivity/i.test(labelText)) {
            const opts = rawOpts.length > 0 ? rawOpts : ["高", "中", "低"];
            modeSelectors.push({
              id: selectRec.entity_id,
              label: "侦测灵敏度",
              capability: {
                entityId: selectRec.entity_id,
                domain: "select",
                service: "select_option",
                parameterKey: "option",
                currentMode: cur,
                currentLabel: translateOptionLabel(cur, "camera"),
                options: opts.map((o) => ({
                  value: String(o),
                  label: translateOptionLabel(String(o), "camera"),
                })),
                controllable: selectRec.supported_features.includes("select_option"),
              },
            });
          } else if (/录制模式|存储模式|recording_mode/i.test(labelText)) {
            const opts = rawOpts.length > 0 ? rawOpts : ["移动录制", "全天录制", "不录制"];
            modeSelectors.push({
              id: selectRec.entity_id,
              label: "录制模式",
              capability: {
                entityId: selectRec.entity_id,
                domain: "select",
                service: "select_option",
                parameterKey: "option",
                currentMode: cur,
                currentLabel: translateOptionLabel(cur, "camera"),
                options: opts.map((o) => ({
                  value: String(o),
                  label: translateOptionLabel(String(o), "camera"),
                })),
                controllable: selectRec.supported_features.includes("select_option"),
              },
            });
          }
        }

        // SD card storage info (convert KB >= 1048576 or MB < 1048576 to GB accurately)
        const sdStatusRec = deviceRecords.find(
          (r) => r.domain === "sensor" && /sdcard_status|存储卡状态/i.test(entityLabelText(r)),
        );
        const totalSpaceRec = deviceRecords.find(
          (r) => r.domain === "sensor" && /storage_total_space|总存储空间/i.test(entityLabelText(r)),
        );
        const usedSpaceRec = deviceRecords.find(
          (r) => r.domain === "sensor" && /storage_used_space|已用存储空间/i.test(entityLabelText(r)),
        );
        const totalRaw = totalSpaceRec ? numericState(totalSpaceRec) : undefined;
        const usedRaw = usedSpaceRec ? numericState(usedSpaceRec) : undefined;
        const toGb = (val: number, rec?: RawHomeEntityRecord): number => {
          const unitStr = String(rec?.snapshot?.attributes?.unit_of_measurement ?? "");
          if (/gb/i.test(unitStr)) return Math.round(val * 10) / 10;
          if (/kb/i.test(unitStr) || val >= 1024 * 1024) {
            return Math.round((val / (1024 * 1024)) * 10) / 10;
          }
          return Math.round((val / 1024) * 10) / 10;
        };
        const storageUsedPercent =
          totalRaw && totalRaw > 0 && usedRaw !== undefined
            ? Math.max(0, Math.min(100, Math.round((usedRaw / totalRaw) * 100)))
            : undefined;
        const rawSdStatus = stringState(sdStatusRec);
        const sdStatus =
          rawSdStatus === "Normal" || rawSdStatus === "0"
            ? "存储正常"
            : rawSdStatus;
        const storageStatusText =
          totalRaw && totalRaw > 0 && usedRaw !== undefined
            ? `${sdStatus ?? "存储正常"} · 已用 ${toGb(usedRaw, usedSpaceRec).toFixed(1)} GB / ${toGb(totalRaw, totalSpaceRec).toFixed(1)} GB`
            : sdStatus;

        const motionEvent = deviceRecords.find(
          (r) => (r.domain === "event" || r.domain === "binary_sensor") && /移动|有人|变化/i.test(entityLabelText(r)),
        );
        const hasRealVideoStream = Boolean(
          cameraEntity?.snapshot?.attributes?.stream_source ||
            cameraEntity?.snapshot?.attributes?.entity_picture ||
            cameraEntity?.snapshot?.attributes?.frontend_stream_type,
        );
        const rawResolution = cameraEntity?.snapshot?.attributes?.resolution;
        const resolutionBadge =
          typeof rawResolution === "string" && rawResolution.trim() ? rawResolution.trim() : undefined;

        const lastMotionText = motionEvent?.snapshot?.last_changed
          ? "移动侦测守护中"
          : storageStatusText ?? "暂未接入实时视频流";
        isActive = online && (capabilities.power?.isOn ?? true);
        statusBadge = online ? (isActive ? "监控在线" : "已休眠") : "离线";
        conciseSubtitle = isActive ? lastMotionText : "镜头物理遮蔽中";

        const ptzActions: ApplianceActionTrigger[] = [];
        if (startBtn && source !== "direct_miot") {
          ptzActions.push({
            id: startBtn.entity_id,
            label: "连接实时流",
            entityId: startBtn.entity_id,
            domain: "button",
            service: "press",
            tone: "primary",
            iconKey: "play",
          });
        }
        if (restartBtn && restartBtn.supported_features.includes("press")) {
          ptzActions.push({
            id: restartBtn.entity_id,
            label: "重启摄像机",
            entityId: restartBtn.entity_id,
            domain: "button",
            service: "press",
            iconKey: "refresh",
          });
        }

        capabilities.visionStream = {
          streamActive: Boolean(isActive && hasRealVideoStream),
          statusText: !online
            ? "设备离线"
            : !isActive
              ? "摄像机已休眠"
              : hasRealVideoStream
                ? "实时画面流就绪"
                : "暂未接入实时视频流",
          ...(resolutionBadge ? { resolutionBadge } : {}),
          lastMotionText,
          storageStatusText,
          storageUsedPercent,
          streamEntityId: startBtn?.entity_id ?? primary?.entity_id,
          stopEntityId: stopBtn?.entity_id,
          ptzActions,
          featureToggles: toggles,
          ...(modeSelectors.length > 0 ? { modeSelectors } : {}),
        };
      } else {
        const batteryMetric = telemetry.find((m) => m.key === "battery");
        isActive = online;
        statusBadge = icon === "lock" ? "已上锁" : "在线";
        conciseSubtitle = batteryMetric ? `电量 ${batteryMetric.value}` : "只读安防监测";
        capabilities.securityEvents = {
          readOnly: true,
          lockState: icon === "lock" ? "已上锁" : undefined,
          batteryPercent: batteryMetric?.numericValue,
          events: [{ time: "实时", label: icon === "lock" ? "门锁安全监测中" : "门铃移动监测中" }],
        };
      }
    }

    // 7. Smart plug telemetry subtitle & Media / Pet actions
    if (icon === "plug") {
      const powerMetric = telemetry.find((m) => m.key === "power");
      if (powerMetric && powerMetric.numericValue && powerMetric.numericValue > 0) {
        conciseSubtitle = `${capabilities.power?.isOn ? "供电中" : "待机"} · ${powerMetric.value}`;
      } else {
        conciseSubtitle = capabilities.power?.isOn ? "供电中" : "已关闭";
      }
    } else if (archetype === "media" || icon === "feeder" || icon === "waterer") {
      capabilities.actions = buildActionTriggers(deviceRecords, icon);
      const mediaOrPetSwitches = deviceRecords
        .filter(
          (r) =>
            r.domain === "switch" &&
            r.entity_id !== capabilities.power?.entityId &&
            r.supported_features.includes("turn_on"),
        )
        .slice(0, 6);
      if (mediaOrPetSwitches.length > 0) {
        capabilities.auxiliaryToggles = mediaOrPetSwitches.map((r) => ({
          id: r.entity_id,
          label: translateSwitchLabel(r),
          entityId: r.entity_id,
          domain: "switch",
          isOn: r.snapshot?.state === "on",
          controllable: r.supported_features.includes("turn_on"),
        }));
      }
      if (icon === "feeder") {
        const eaten = telemetry.find((m) => m.key === "pet_eaten");
        statusBadge = online ? "正常" : "离线";
        conciseSubtitle = eaten ? `今日已进食 ${eaten.value}` : "余粮充足 · 自动计划中";
      } else if (icon === "waterer") {
        const waterCount = telemetry.find((m) => m.key === "water_count");
        statusBadge = online ? "正常" : "离线";
        conciseSubtitle = waterCount ? `今日出水 ${waterCount.value}` : "循环过滤正常";
      } else if (archetype === "media") {
        conciseSubtitle = isActive ? "正在播放" : "待机";
      }
    } else if (icon === "sensor" || icon === "router") {
      statusBadge = online ? "在线" : "离线";
      conciseSubtitle =
        telemetry
          .slice(0, 2)
          .map((m) => `${m.label} ${m.value}`)
          .join(" · ") || sourceLabel;
    }

    capabilities.controls = buildUnifiedControls(icon, capabilities, deviceRecords);

    const defaultSpan = resolveDefaultTileSpan(archetype, icon);
    const savedLayout = layoutPrefs?.appliances[groupId];
    const span = savedLayout?.span ?? defaultSpan;
    const order = savedLayout?.order ?? getArchetypeDefaultOrder(archetype, icon);

    appliances.push({
      id: groupId,
      deviceId: first.device_id ?? first.entity_id,
      source,
      sourceLabel,
      name,
      displayName,
      room: roomInfo.room,
      homeName: roomInfo.homeName,
      model: model || undefined,
      archetype,
      icon,
      defaultSpan,
      span,
      order,
      online,
      isActive,
      statusBadge,
      conciseSubtitle,
      capabilities,
      entityIds: deviceRecords.map((r) => r.entity_id),
    });
  }

  // Group appliances by room
  const roomMap = new Map<string, HomeAppliance[]>();
  for (const app of appliances) {
    const list = roomMap.get(app.room) ?? [];
    list.push(app);
    roomMap.set(app.room, list);
  }

  const rooms: HomeRoomSection[] = [];
  for (const [roomName, roomAppliances] of roomMap.entries()) {
    roomAppliances.sort((a, b) => {
      if (a.order !== b.order) return a.order - b.order;
      return a.name.localeCompare(b.name, "zh-CN") || a.id.localeCompare(b.id);
    });

    // Aggregate room-level environment metrics
    const envMetrics: RoomEnvironmentMetric[] = [];
    const addRoomEnv = (
      key: RoomEnvironmentMetric["key"],
      label: string,
      value: string,
      numericValue?: number,
      badge?: string,
      sourceDeviceId?: string,
    ) => {
      if (envMetrics.some((e) => e.key === key)) return;
      envMetrics.push({
        key,
        label,
        value,
        numericValue,
        ...(badge ? { badge } : {}),
        ...(sourceDeviceId ? { sourceDeviceId } : {}),
      });
    };

    const envPriorityRank = (iconKind: ApplianceIconKind): number => {
      if (iconKind === "sensor") return 1;
      if (iconKind === "purifier") return 2;
      if (iconKind === "ac") return 3;
      if (iconKind === "dehumidifier") return 4;
      if (iconKind === "fan") return 5;
      return 10;
    };
    const envOrderedAppliances = [...roomAppliances].sort((a, b) => {
      const rankDiff = envPriorityRank(a.icon) - envPriorityRank(b.icon);
      if (rankDiff !== 0) return rankDiff;
      return a.id.localeCompare(b.id);
    });

    let totalPowerWatts = 0;
    for (const app of envOrderedAppliances) {
      const canProvideRoomTemp =
        app.icon === "sensor" ||
        app.icon === "ac" ||
        app.icon === "purifier" ||
        app.icon === "dehumidifier" ||
        app.icon === "fan";
      for (const m of app.capabilities.telemetry) {
        if (
          m.key === "temperature" &&
          canProvideRoomTemp &&
          m.numericValue !== undefined &&
          m.numericValue > -10 &&
          m.numericValue < 45
        ) {
          addRoomEnv("temperature", "温度", m.value, m.numericValue, undefined, m.sourceDeviceId);
        } else if (m.key === "humidity" && m.numericValue !== undefined && m.numericValue > 0) {
          addRoomEnv("humidity", "湿度", m.value, m.numericValue, undefined, m.sourceDeviceId);
        } else if (m.key === "co2" && m.numericValue !== undefined) {
          addRoomEnv("co2", "CO₂", m.value, m.numericValue, undefined, m.sourceDeviceId);
        } else if (m.key === "pm25" && m.numericValue !== undefined) {
          addRoomEnv("pm25", "PM2.5", m.value, m.numericValue, m.badge, m.sourceDeviceId);
        } else if (m.key === "occupancy" && m.numericValue === 1) {
          addRoomEnv("occupancy", "状态", "有人");
        } else if (m.key === "power" && m.numericValue !== undefined) {
          totalPowerWatts += m.numericValue;
        }
      }
      if (
        app.capabilities.thermostat?.currentTemp !== undefined &&
        app.capabilities.thermostat.currentTemp > -10 &&
        app.capabilities.thermostat.currentTemp < 45
      ) {
        addRoomEnv(
          "temperature",
          "温度",
          `${app.capabilities.thermostat.currentTemp}°C`,
          app.capabilities.thermostat.currentTemp,
          undefined,
          app.id,
        );
      }
    }
    if (totalPowerWatts > 0) {
      addRoomEnv("power", "功率", `${Math.round(totalPowerWatts)}W`, totalPowerWatts);
    }

    // Room-level batch power entities (lights, desk lamps, plugs, and multi-gang switches)
    const turnOnIds: string[] = [];
    const turnOffIds: string[] = [];
    for (const app of roomAppliances) {
      if (app.archetype === "lighting_power") {
        if (app.capabilities.multiGang) {
          for (const ch of app.capabilities.multiGang.channels) {
            if (!ch.controllable) continue;
            if (ch.isOn) turnOffIds.push(ch.entityId);
            else turnOnIds.push(ch.entityId);
          }
        } else if (app.capabilities.power?.controllable) {
          if (app.capabilities.power.isOn) turnOffIds.push(app.capabilities.power.entityId);
          else turnOnIds.push(app.capabilities.power.entityId);
        }
      }
    }

    const activeCount = roomAppliances.filter((a) => a.isActive).length;
    const tempEnv = envMetrics.find((e) => e.key === "temperature");
    const navSummary = [
      tempEnv?.value,
      `${activeCount}/${roomAppliances.length} 开启`,
    ]
      .filter(Boolean)
      .join(" · ");

    rooms.push({
      id: roomName,
      name: roomName,
      totalCount: roomAppliances.length,
      activeCount,
      navSummary,
      environment: envMetrics,
      appliances: roomAppliances,
      roomPowerEntities: { turnOnIds, turnOffIds },
    });
  }

  rooms.sort((a, b) => {
    const wa = getRoomSortWeight(a.name);
    const wb = getRoomSortWeight(b.name);
    if (wa !== wb) return wa - wb;
    return b.totalCount - a.totalCount;
  });

  const allAppliances = rooms.flatMap((r) => r.appliances);
  return {
    homeName: detectedHomeName,
    totalAppliances: allAppliances.length,
    activeAppliances: allAppliances.filter((a) => a.isActive).length,
    rooms,
    allAppliances,
  };
}
