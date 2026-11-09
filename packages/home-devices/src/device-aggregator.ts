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
  return /禁用|指示灯|童锁|防闪烁|点动|灵动|互锁|转无线|无线开关|自动保温|延长保温|休眠|遮蔽|移动侦测|追踪|巡航|水印|扫风|辅热|除菌|干燥|负离子|地毯|翻滚|disable|child_lock|indicator|watermark|motion_detection|sleep|swing|heater|auto_keep_warm/i.test(
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
  if (/washer|洗衣机/.test(combined)) {
    return { archetype: "cycle_appliance", icon: "washer" };
  }
  if (/dishwasher|洗碗机/.test(combined)) {
    return { archetype: "cycle_appliance", icon: "dishwasher" };
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
      candidates.find((r) => /_on_p_2_1$|_on_p_\d+_1$|_power$/i.test(r.entity_id)) ??
      candidates.find((r) =>
        /^(开关|开关\s*开关|开关\s*按键|按键|电源|.*开关$|.*电源$)/i.test(
          (r.original_name ?? r.friendly_name ?? "").trim(),
        ),
      );
    return preferredByIdOrName ?? candidates[0];
  }
  return undefined;
}

function extractTelemetry(records: RawHomeEntityRecord[], icon?: ApplianceIconKind): TelemetryMetric[] {
  const metrics: TelemetryMetric[] = [];
  const addMetric = (key: string, label: string, val: string, num?: number, unit?: string) => {
    if (metrics.some((m) => m.key === key)) return;
    metrics.push({ key, label, value: val, numericValue: num, unit });
  };

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
      if (num !== undefined && num >= 0 && num <= 100) {
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
        addMetric("pm25", "PM2.5", `${rounded}`, rounded, unit || "μg/m³");
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
    const text = (r.original_name ?? r.friendly_name ?? "").trim();
    if (!text) continue;

    if (icon === "cooker" || icon === "microwave") {
      if (/开始煮饭|开始烹饪|开始|启动/.test(text)) {
        addTrigger({
          id: r.entity_id,
          label: "开始",
          entityId: r.entity_id,
          domain: r.domain,
          service: r.domain === "button" ? "press" : "send_message",
          tone: "primary",
          iconKey: "play",
        });
      } else if (/暂停/.test(text)) {
        addTrigger({
          id: r.entity_id,
          label: "暂停",
          entityId: r.entity_id,
          domain: r.domain,
          service: r.domain === "button" ? "press" : "send_message",
          iconKey: "pause",
        });
      } else if (/取消|停止/.test(text)) {
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
      if (/清新抖散|启动抖散/.test(text)) {
        addTrigger({
          id: r.entity_id,
          label: "清新抖散",
          entityId: r.entity_id,
          domain: r.domain,
          service: r.domain === "button" ? "press" : "send_message",
          iconKey: "refresh",
        });
      } else if (/开始洗涤|开始洗碗|开始|启动/.test(text) && !/清洁|插件|抖散/.test(text)) {
        addTrigger({
          id: r.entity_id,
          label: "启动",
          entityId: r.entity_id,
          domain: r.domain,
          service: r.domain === "button" ? "press" : "send_message",
          tone: "primary",
          iconKey: "play",
        });
      } else if (/暂停/.test(text)) {
        addTrigger({
          id: r.entity_id,
          label: "暂停",
          entityId: r.entity_id,
          domain: r.domain,
          service: "press",
          iconKey: "pause",
        });
      } else if (/停止洗涤|停止洗碗|停止/.test(text) && !/抖散|清洁/.test(text)) {
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
      if (/开始清扫/.test(text)) {
        addTrigger({
          id: r.entity_id,
          label: "清扫",
          entityId: r.entity_id,
          domain: r.domain,
          service: "press",
          tone: "primary",
          iconKey: "play",
        });
      } else if (/停止清扫/.test(text)) {
        addTrigger({
          id: r.entity_id,
          label: "停止",
          entityId: r.entity_id,
          domain: r.domain,
          service: "press",
          iconKey: "stop",
        });
      } else if (/充电|回充|出仓/.test(text)) {
        addTrigger({
          id: r.entity_id,
          label: /出仓/.test(text) ? "回充/出仓" : "回充",
          entityId: r.entity_id,
          domain: r.domain,
          service: "press",
          iconKey: "dock",
        });
      } else if (/开始集尘/.test(text)) {
        addTrigger({
          id: r.entity_id,
          label: "集尘",
          entityId: r.entity_id,
          domain: r.domain,
          service: "press",
          iconKey: "dust",
        });
      } else if (/开始洗拖布/.test(text)) {
        addTrigger({
          id: r.entity_id,
          label: "洗拖布",
          entityId: r.entity_id,
          domain: r.domain,
          service: "press",
          iconKey: "wash",
        });
      } else if (/开始烘干/.test(text)) {
        addTrigger({
          id: r.entity_id,
          label: "烘干",
          entityId: r.entity_id,
          domain: r.domain,
          service: "press",
          iconKey: "dry",
        });
      } else if (/定位机器人|查找/.test(text)) {
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
      if (/开始加热|煮沸/.test(text)) {
        addTrigger({
          id: r.entity_id,
          label: "加热",
          entityId: r.entity_id,
          domain: r.domain,
          service: "press",
          tone: "primary",
          iconKey: "play",
        });
      } else if (/停止加热/.test(text)) {
        addTrigger({
          id: r.entity_id,
          label: "停止",
          entityId: r.entity_id,
          domain: r.domain,
          service: "press",
          iconKey: "stop",
        });
      }
    } else if (icon === "feeder") {
      if (/出粮|喂食/.test(text)) {
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
      if (/开机|唤醒|播放音乐/.test(text)) {
        addTrigger({
          id: r.entity_id,
          label: /唤醒/.test(text) ? "唤醒" : /播放音乐/.test(text) ? "播放音乐" : "开机",
          entityId: r.entity_id,
          domain: r.domain,
          service: "press",
          tone: "primary",
          iconKey: "play",
        });
      } else if (/关机|暂停|停止闹钟/.test(text)) {
        addTrigger({
          id: r.entity_id,
          label: /停止闹钟/.test(text) ? "停闹钟" : /关机/.test(text) ? "关机" : "暂停",
          entityId: r.entity_id,
          domain: r.domain,
          service: "press",
          iconKey: "pause",
        });
      } else if (/首页|返回|菜单/.test(text)) {
        const shortLabel = /首页/.test(text) ? "首页" : /返回/.test(text) ? "返回" : "菜单";
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
      currentLabel: cur,
      options: rawOpts.slice(0, 5).map((o) => ({ value: String(o), label: String(o) })),
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

  addConsumable("main_brush", "主刷寿命", /主刷.*寿命百分比|brush_life_level_p_14_1|main_brush_life/i, /主刷.*剩余寿命|brush_left_time_p_14_2/i);
  addConsumable("side_brush", "边刷寿命", /边刷.*寿命百分比|brush_life_level_p_15_1|side_brush_life/i, /边刷.*剩余寿命|brush_left_time_p_15_2/i);
  addConsumable("filter", "滤芯寿命", /滤芯.*寿命百分比|filter_life_level_p_13_1|filter_life/i, /滤芯.*剩余寿命|filter_left_time_p_13_2/i);
  addConsumable("mop", "拖布寿命", /拖布.*寿命百分比|brush_life_level_p_16_1|mop_life/i, /拖布.*剩余寿命|brush_left_time_p_16_2/i);

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
  if (!trimmed || lower === "off" || lower === "idle" || lower === "standby" || lower === "no" || lower === "false") {
    return "待机";
  }
  if (lower === "yes" || lower === "true") {
    return "待机";
  }
  // Translate raw MIoT numeric status codes if any leaked through
  if (/^\d+$/.test(trimmed)) {
    const code = Number(trimmed);
    if (code === 0 || code === 1) return "待机";
    if (code === 2) return icon === "cooker" ? "精煮中" : icon === "washer" ? "洗涤中" : "运行中";
    if (code === 3) return icon === "cooker" ? "保温中" : "已暂停";
    if (code === 4) return "已完成";
    return "待机";
  }
  if (lower === "on" || lower === "cooking") {
    return icon === "cooker" ? "精煮中" : "运行中";
  }
  if (lower === "keep_warm" || /保温/.test(trimmed)) {
    return "保温中";
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
    microwave: ["待机", "预热", "烘烤", "完成"],
    washer: ["称重", "洗涤", "漂洗", "脱水", "抖散"],
    dishwasher: ["预洗", "主洗", "漂洗", "烘干", "保管"],
    vacuum: ["待机", "清扫", "回充", "洗拖布", "烘干"],
  };
  const stages = defaultStages[icon] ?? ["待机", "运行中", "完成"];

  if (icon === "vacuum" && vacuumCap) {
    const isRunning =
      vacuumCap.statusCode === "cleaning" ||
      vacuumCap.statusCode === "returning" ||
      vacuumCap.statusCode === "washing" ||
      vacuumCap.statusCode === "drying" ||
      vacuumCap.statusCode === "dust_collecting";
    const activeStageIndex =
      vacuumCap.statusCode === "cleaning"
        ? 1
        : vacuumCap.statusCode === "returning"
          ? 2
          : vacuumCap.statusCode === "washing" || vacuumCap.statusCode === "dust_collecting"
            ? 3
            : vacuumCap.statusCode === "drying"
              ? 4
              : 0;
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

  let activeStageIndex = 0;
  for (let i = 0; i < stages.length; i++) {
    if (stageLabel.includes(stages[i]!)) {
      activeStageIndex = i;
      break;
    }
  }
  if (isRunning && activeStageIndex === 0 && stages.length >= 3) {
    activeStageIndex = Math.min(2, stages.length - 1);
  }

  const progressPercent = isRunning
    ? remainingMinutes !== undefined
      ? Math.max(12, Math.min(92, Math.round(100 - (remainingMinutes / 60) * 100)))
      : 60
    : stageLabel === "保温中"
      ? 100
      : 0;

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
    const model = first.device_model ?? "";
    const { archetype, icon } = classifyAppliance(name, model, deviceRecords);

    const telemetry = extractTelemetry(deviceRecords, icon);

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

    // 3. Light dimmer capability
    if (icon === "light" && primary) {
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
      conciseSubtitle = capabilities.power?.isOn
        ? briPct !== undefined
          ? `亮度 ${briPct}%`
          : "照明开启"
        : "已关闭";
    }

    // 4. Climate & Thermostat capability
    if (archetype === "climate") {
      const climateRec = deviceRecords.find((r) => r.domain === "climate" || r.domain === "humidifier");
      const targetNumRec = deviceRecords.find(
        (r) => r.domain === "number" && /目标温度|保温温度|设定温度|target_temp/i.test(entityLabelText(r)),
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
          label: HVAC_MODE_LABELS[String(m)] ?? String(m),
        }));
        const currentMode = String(climateRec.snapshot?.state ?? "cool");
        capabilities.modeBar = {
          entityId: climateRec.entity_id,
          domain: "climate",
          service: "set_hvac_mode",
          parameterKey: "hvac_mode",
          currentMode,
          currentLabel: HVAC_MODE_LABELS[currentMode] ?? currentMode,
          options,
          controllable:
            climateRec.supported_features.includes("set_hvac_mode") ||
            climateRec.supported_features.includes("turn_on"),
        };
        isActive = currentMode !== "off" && currentMode !== "unavailable" && currentMode !== "unknown";
        statusBadge = isActive ? HVAC_MODE_LABELS[currentMode] ?? "运行中" : "已关闭";
        conciseSubtitle =
          attrCurrentTemp !== undefined ? `室温 ${attrCurrentTemp}°C` : `设定 ${target}°C`;
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
        capabilities.thermostat = {
          entityId: targetNumRec.entity_id,
          domain: "number",
          currentTemp: attrCurrentTemp,
          targetTemp: target,
          minTemp,
          maxTemp,
          step: 1,
          unit: "°C",
          controllable: targetNumRec.supported_features.includes("set_value"),
        };
        isActive = true;
        statusBadge = attrCurrentTemp !== undefined ? `${attrCurrentTemp}°C` : "保温中";
        conciseSubtitle = `设定 ${target}°C`;
      } else {
        const tempStr = currentTempMetric ? currentTempMetric.value : undefined;
        const pmStr = telemetry.find((m) => m.key === "pm25")?.value;
        conciseSubtitle =
          [tempStr, pmStr ? `PM2.5 ${pmStr}` : undefined].filter(Boolean).join(" · ") || statusBadge;
      }

      if (!capabilities.modeBar) {
        const selectRec = deviceRecords.find(
          (r) => r.domain === "select" && /模式|档位|mode/i.test(entityLabelText(r)),
        );
        if (selectRec) {
          const rawOpts = Array.isArray(selectRec.snapshot?.attributes?.options)
            ? (selectRec.snapshot?.attributes?.options as string[])
            : ["自动", "睡眠", "高速"];
          const current = stringState(selectRec) ?? rawOpts[0] ?? "自动";
          capabilities.modeBar = {
            entityId: selectRec.entity_id,
            domain: "select",
            service: "select_option",
            parameterKey: "option",
            currentMode: current,
            currentLabel: current,
            options: rawOpts.slice(0, 5).map((o) => ({ value: String(o), label: String(o) })),
            controllable: selectRec.supported_features.includes("select_option"),
          };
        }
      }

      capabilities.actions = buildActionTriggers(deviceRecords, icon);

      const auxSwitches = deviceRecords
        .filter(
          (r) =>
            r.domain === "switch" &&
            r.supported_features.includes("turn_on") &&
            /扫风|辅热|睡眠|干燥|负离子|保温|除菌/i.test(entityLabelText(r)),
        )
        .slice(0, 6);
      if (auxSwitches.length > 0) {
        capabilities.auxiliaryToggles = auxSwitches.map((r) => ({
          id: r.entity_id,
          label:
            (r.original_name ?? r.friendly_name ?? "")
              .replace(/^.*?(上下扫风|左右扫风|电辅热|辅热|睡眠模式|睡眠|自动保温|延长保温|干燥|除菌).*$/, "$1")
              .trim() || "辅控",
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
        capabilities.modeBar = {
          entityId: modeSelect.entity_id,
          domain: "select",
          service: "select_option",
          parameterKey: "option",
          currentMode: cur,
          currentLabel: cur,
          options: rawOpts.slice(0, 6).map((o) => ({ value: String(o), label: String(o) })),
          controllable: modeSelect.supported_features.includes("select_option"),
        };
        cycle.recipeLabel = cur;
      } else if (icon === "cooker") {
        cycle.recipeLabel = "精煮饭";
      }

      // Auxiliary toggles for cycle appliances (e.g. rice cooker auto-keep-warm, vacuum carpet boost)
      const cycleAuxSwitches = deviceRecords
        .filter(
          (r) =>
            r.domain === "switch" &&
            r.supported_features.includes("turn_on") &&
            /保温|地毯|除菌|烘干|抖散/i.test(entityLabelText(r)),
        )
        .slice(0, 4);
      if (cycleAuxSwitches.length > 0) {
        capabilities.auxiliaryToggles = cycleAuxSwitches.map((r) => ({
          id: r.entity_id,
          label:
            (r.original_name ?? r.friendly_name ?? "")
              .replace(/^.*?(自动保温|营养保温|保温开关|地毯增压|仅扫地|除菌|保管).*$/, "$1")
              .trim() || "辅助功能",
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
        if (cycle.remainingMinutes !== undefined && cycle.remainingMinutes > 0) {
          conciseSubtitle = `剩余 ${cycle.remainingMinutes}m`;
        } else if (cycle.keepWarmMinutes !== undefined && cycle.keepWarmMinutes > 0) {
          conciseSubtitle = `已保温 ${cycle.keepWarmMinutes}m`;
        } else if (cycle.temperatureCelsius !== undefined) {
          conciseSubtitle = `${cycle.temperatureCelsius}°C · ${cycle.stageLabel}`;
        } else {
          conciseSubtitle = cycle.stageLabel;
        }
      }
    }

    // 6. Vision & Security (Camera, Doorbell, Smart Lock)
    if (archetype === "vision_security") {
      if (icon === "camera") {
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
              r.supported_features.includes("turn_on") &&
              /休眠|遮蔽|移动侦测|追踪|巡航|水印|开关/i.test(entityLabelText(r)),
          )
          .slice(0, 4)
          .map((r) => ({
            id: r.entity_id,
            label: /休眠|遮蔽/.test(entityLabelText(r))
              ? "休眠遮蔽"
              : /巡航/.test(entityLabelText(r))
                ? "自动巡航"
                : /侦测|追踪/.test(entityLabelText(r))
                  ? "移动侦测"
                  : /水印|watermark/i.test(entityLabelText(r))
                    ? "时间水印"
                    : "画面开关",
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
                currentLabel: cur,
                options: opts.map((o) => ({ value: String(o), label: String(o) })),
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
                currentLabel: cur,
                options: opts.map((o) => ({ value: String(o), label: String(o) })),
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
                currentLabel: cur,
                options: opts.map((o) => ({ value: String(o), label: String(o) })),
                controllable: selectRec.supported_features.includes("select_option"),
              },
            });
          }
        }

        // SD card storage info
        const sdStatusRec = deviceRecords.find(
          (r) => r.domain === "sensor" && /sdcard_status|存储卡状态/i.test(entityLabelText(r)),
        );
        const totalSpaceRec = deviceRecords.find(
          (r) => r.domain === "sensor" && /storage_total_space|总存储空间/i.test(entityLabelText(r)),
        );
        const usedSpaceRec = deviceRecords.find(
          (r) => r.domain === "sensor" && /storage_used_space|已用存储空间/i.test(entityLabelText(r)),
        );
        const totalMb = totalSpaceRec ? numericState(totalSpaceRec) : undefined;
        const usedMb = usedSpaceRec ? numericState(usedSpaceRec) : undefined;
        const storageUsedPercent =
          totalMb && totalMb > 0 && usedMb !== undefined
            ? Math.max(0, Math.min(100, Math.round((usedMb / totalMb) * 100)))
            : undefined;
        const sdStatus = stringState(sdStatusRec);
        const storageStatusText =
          totalMb && totalMb > 0 && usedMb !== undefined
            ? `${sdStatus ?? "存储正常"} · 已用 ${(usedMb / 1024).toFixed(1)} GB / ${(totalMb / 1024).toFixed(1)} GB`
            : sdStatus;

        const motionEvent = deviceRecords.find(
          (r) => (r.domain === "event" || r.domain === "binary_sensor") && /移动|有人|变化/i.test(entityLabelText(r)),
        );
        const lastMotionText = motionEvent?.snapshot?.last_changed ? "移动侦测守护中" : "实时监控就绪";
        isActive = online && (capabilities.power?.isOn ?? true);
        statusBadge = online ? (isActive ? "实时监控" : "已休眠") : "离线";
        conciseSubtitle = isActive ? lastMotionText : "镜头物理遮蔽中";

        const ptzActions: ApplianceActionTrigger[] = [];
        if (startBtn) {
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
          streamActive: isActive,
          statusText: online ? (isActive ? "实时画面流就绪" : "摄像机已休眠") : "设备离线",
          resolutionBadge: "2K HD",
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
    ) => {
      if (envMetrics.some((e) => e.key === key)) return;
      envMetrics.push({ key, label, value, numericValue });
    };

    let totalPowerWatts = 0;
    for (const app of roomAppliances) {
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
          addRoomEnv("temperature", "温度", m.value, m.numericValue);
        } else if (m.key === "humidity" && m.numericValue !== undefined) {
          addRoomEnv("humidity", "湿度", m.value, m.numericValue);
        } else if (m.key === "co2" && m.numericValue !== undefined) {
          addRoomEnv("co2", "CO₂", m.value, m.numericValue);
        } else if (m.key === "pm25" && m.numericValue !== undefined) {
          addRoomEnv("pm25", "PM2.5", m.value, m.numericValue);
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
        );
      }
    }
    if (totalPowerWatts > 0) {
      addRoomEnv("power", "功率", `${Math.round(totalPowerWatts)}W`, totalPowerWatts);
    }

    // Room-level batch power entities (only safe lights/switches/fans)
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
