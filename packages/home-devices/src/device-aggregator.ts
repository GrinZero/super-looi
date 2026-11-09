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
  ModeOption,
  MultiGangChannel,
  RawHomeEntityRecord,
  RoomEnvironmentMetric,
  TelemetryMetric,
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

function numericState(record: RawHomeEntityRecord): number | undefined {
  const raw = record.snapshot?.state;
  if (raw === undefined || raw === null) return undefined;
  const trimmed = String(raw).trim();
  if (!trimmed || trimmed === "unavailable" || trimmed === "unknown") return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function stringState(record: RawHomeEntityRecord): string | undefined {
  const raw = record.snapshot?.state;
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

function classifyAppliance(
  deviceName: string,
  model: string,
  records: RawHomeEntityRecord[],
): { archetype: ApplianceArchetype; icon: ApplianceIconKind } {
  const combined = `${deviceName} ${model} ${records.map((r) => r.entity_id).join(" ")}`.toLowerCase();

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

  if (records.some((r) => r.domain === "light") || /light|lamp|吸顶灯|台灯|夜灯|射灯|灯带/.test(combined)) {
    return { archetype: "lighting_power", icon: "light" };
  }

  if (
    records.some((r) => r.domain === "switch") ||
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
  const nonConfig = records.filter((r) => r.entity_category !== "config" && r.entity_category !== "diagnostic");
  const pool = nonConfig.length > 0 ? nonConfig : records;
  const domainPriority = ["light", "climate", "humidifier", "fan", "vacuum", "media_player", "switch"];
  for (const dom of domainPriority) {
    const matches = pool.filter((r) => r.domain === dom);
    if (matches.length === 0) continue;
    const preferred = matches.find((r) =>
      /^(开关|电源|摄像机控制 开关|洗衣机 开关|洗碗机 开关|空气净化器 开关)/i.test(
        (r.original_name ?? r.friendly_name ?? "").trim(),
      ),
    );
    return preferred ?? matches[0];
  }
  return undefined;
}

function extractTelemetry(records: RawHomeEntityRecord[]): TelemetryMetric[] {
  const metrics: TelemetryMetric[] = [];
  const addMetric = (key: string, label: string, val: string, num?: number, unit?: string) => {
    if (metrics.some((m) => m.key === key)) return;
    metrics.push({ key, label, value: val, numericValue: num, unit });
  };

  for (const r of records) {
    if (r.domain !== "sensor" && r.domain !== "binary_sensor" && r.domain !== "number") continue;
    const label = entityLabelText(r);
    const num = numericState(r);
    const str = stringState(r);
    const unit = String(r.snapshot?.attributes?.unit_of_measurement ?? "");

    if (/实时功率|electric_power|\bpower\b/i.test(label) && !/耗电/.test(label)) {
      const v = num ?? 0;
      addMetric("power", "实时功率", `${v}W`, v, "W");
    } else if (/耗电量|power_consumption|energy/i.test(label)) {
      const v = num ?? 0;
      addMetric("energy", "耗电量", `${v}kWh`, v, "kWh");
    } else if (/温度|temperature/i.test(label) && !/色温|目标|设定|沸点|保温/.test(label)) {
      if (num !== undefined) {
        addMetric("temperature", "温度", `${num}°C`, num, "°C");
      }
    } else if (/湿度|humidity/i.test(label) && !/目标/.test(label)) {
      if (num !== undefined) {
        addMetric("humidity", "湿度", `${num}%`, num, "%");
      }
    } else if (/co2|二氧化碳/i.test(label)) {
      if (num !== undefined) {
        addMetric("co2", "CO₂", `${num}ppm`, num, "ppm");
      }
    } else if (/pm2\.?5|空气质量|aqi/i.test(label)) {
      if (num !== undefined) {
        addMetric("pm25", "PM2.5", `${num}`, num, unit || "μg/m³");
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
    } else if (/电池电量|battery/i.test(label) && num !== undefined) {
      addMetric("battery", "电量", `${num}%`, num, "%");
    } else if (/滤芯.*寿命|滤网.*寿命|干燥剂.*寿命|filter.*life/i.test(label) && num !== undefined) {
      addMetric("filter_life", "滤芯寿命", `${num}%`, num, "%");
    } else if (/人在|有人|occupancy|motion/i.test(label) && r.domain === "binary_sensor") {
      const occupied = str === "on" || str === "true" || str === "detected";
      addMetric("occupancy", "感知", occupied ? "有人" : "无人", occupied ? 1 : 0);
    } else if (/光照度|illumination/i.test(label) && num !== undefined) {
      addMetric("lux", "光照", `${num}lx`, num, "lx");
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
        });
      } else if (/暂停/.test(text)) {
        addTrigger({
          id: r.entity_id,
          label: "暂停",
          entityId: r.entity_id,
          domain: r.domain,
          service: r.domain === "button" ? "press" : "send_message",
        });
      } else if (/取消|停止/.test(text)) {
        addTrigger({
          id: r.entity_id,
          label: "取消/保温",
          entityId: r.entity_id,
          domain: r.domain,
          service: r.domain === "button" ? "press" : "send_message",
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
        });
      } else if (/开始洗涤|开始洗碗|开始|启动/.test(text) && !/清洁|插件|抖散/.test(text)) {
        addTrigger({
          id: r.entity_id,
          label: "启动",
          entityId: r.entity_id,
          domain: r.domain,
          service: r.domain === "button" ? "press" : "send_message",
          tone: "primary",
        });
      } else if (/暂停/.test(text)) {
        addTrigger({
          id: r.entity_id,
          label: "暂停",
          entityId: r.entity_id,
          domain: r.domain,
          service: "press",
        });
      } else if (/停止洗涤|停止洗碗|停止/.test(text) && !/抖散|清洁/.test(text)) {
        addTrigger({
          id: r.entity_id,
          label: "停止",
          entityId: r.entity_id,
          domain: r.domain,
          service: "press",
        });
      }
    } else if (icon === "vacuum") {
      if (/开始清扫/.test(text)) {
        addTrigger({ id: r.entity_id, label: "清扫", entityId: r.entity_id, domain: r.domain, service: "press", tone: "primary" });
      } else if (/停止清扫/.test(text)) {
        addTrigger({ id: r.entity_id, label: "停止", entityId: r.entity_id, domain: r.domain, service: "press" });
      } else if (/开始集尘/.test(text)) {
        addTrigger({ id: r.entity_id, label: "集尘", entityId: r.entity_id, domain: r.domain, service: "press" });
      } else if (/开始洗拖布/.test(text)) {
        addTrigger({ id: r.entity_id, label: "洗拖布", entityId: r.entity_id, domain: r.domain, service: "press" });
      } else if (/开始烘干/.test(text)) {
        addTrigger({ id: r.entity_id, label: "烘干", entityId: r.entity_id, domain: r.domain, service: "press" });
      }
    } else if (icon === "kettle") {
      if (/开始加热|煮沸/.test(text)) {
        addTrigger({ id: r.entity_id, label: "加热", entityId: r.entity_id, domain: r.domain, service: "press", tone: "primary" });
      } else if (/停止加热/.test(text)) {
        addTrigger({ id: r.entity_id, label: "停止", entityId: r.entity_id, domain: r.domain, service: "press" });
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
        });
      } else if (/关机|暂停|停止闹钟/.test(text)) {
        addTrigger({
          id: r.entity_id,
          label: /停止闹钟/.test(text) ? "停闹钟" : /关机/.test(text) ? "关机" : "暂停",
          entityId: r.entity_id,
          domain: r.domain,
          service: "press",
        });
      } else if (/首页|返回|菜单/.test(text)) {
        const shortLabel = /首页/.test(text) ? "首页" : /返回/.test(text) ? "返回" : "菜单";
        addTrigger({ id: r.entity_id, label: shortLabel, entityId: r.entity_id, domain: r.domain, service: "press" });
      }
    }
  }

  return triggers;
}

function buildCycleTaskCapability(
  icon: ApplianceIconKind,
  records: RawHomeEntityRecord[],
  telemetry: TelemetryMetric[],
): CycleTaskCapability {
  const defaultStages: Record<string, string[]> = {
    cooker: ["浸泡", "升温", "沸腾", "焖饭", "保温"],
    microwave: ["待机", "预热", "烘烤", "完成"],
    washer: ["称重", "洗涤", "漂洗", "脱水", "抖散"],
    dishwasher: ["预洗", "主洗", "漂洗", "烘干", "存储"],
    vacuum: ["待机", "清扫", "洗拖布", "集尘", "烘干"],
  };
  const stages = defaultStages[icon] ?? ["待机", "运行中", "完成"];

  const statusSensor = records.find(
    (r) =>
      (r.domain === "sensor" || r.domain === "vacuum") &&
      /设备状态|工作状态|阶段|status|stage/i.test(entityLabelText(r)),
  );
  const remainingSensor =
    records.find(
      (r) =>
        (r.domain === "sensor" || r.domain === "number") &&
        !/预约|pre_left/i.test(entityLabelText(r)) &&
        /剩余时间|剩余时长|left_time|remaining/i.test(entityLabelText(r)),
    ) ??
    records.find(
      (r) =>
        (r.domain === "sensor" || r.domain === "number") &&
        /剩余时间|剩余时长|left_time|remaining/i.test(entityLabelText(r)),
    );

  const rawStage = stringState(statusSensor ?? records[0]) ?? "待机";
  const remainingMinutes = remainingSensor ? numericState(remainingSensor) : undefined;
  const tempMetric = telemetry.find((m) => m.key === "temperature");

  const isRunning =
    (remainingMinutes !== undefined && remainingMinutes > 0) ||
    /煮|热|洗|漂|脱|烘|清扫|工作|运行|cooking|washing|cleaning|drying|boiling/i.test(rawStage);

  let activeStageIndex = 0;
  for (let i = 0; i < stages.length; i++) {
    if (rawStage.includes(stages[i])) {
      activeStageIndex = i;
      break;
    }
  }
  if (isRunning && activeStageIndex === 0 && stages.length >= 3) {
    activeStageIndex = Math.min(2, stages.length - 1);
  }

  const stageLabel =
    rawStage === "off" || rawStage === "idle" || rawStage === "standby"
      ? "待机"
      : rawStage === "on" || rawStage === "cooking"
        ? icon === "cooker"
          ? "精煮中"
          : "运行中"
        : rawStage;

  const progressPercent = isRunning
    ? remainingMinutes !== undefined
      ? Math.max(12, Math.min(92, Math.round(100 - (remainingMinutes / 60) * 100)))
      : 60
    : 0;

  return {
    stageLabel,
    stages,
    activeStageIndex,
    remainingMinutes,
    progressPercent,
    temperatureCelsius: tempMetric?.numericValue,
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
    // Skip groups that ONLY contain diagnostic/config noise and no meaningful sensor/control
    const primary = findPrimaryPowerEntity(deviceRecords);
    const first = primary ?? deviceRecords[0];
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

    const telemetry = extractTelemetry(deviceRecords);

    // If a pure sensor group has neither controls nor any telemetry/state, skip pure diagnostic orphans
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
      const effectiveGangs = gangRecords.length > 0 ? gangRecords : deviceRecords.filter((r) => r.domain === "switch").slice(0, 3);
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
    if (primary && icon !== "switch_gang" && icon !== "lock" && icon !== "sensor") {
      const st = String(primary.snapshot?.state ?? "off").toLowerCase();
      const isOn = st !== "off" && st !== "idle" && st !== "standby" && st !== "unavailable" && st !== "unknown";
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
      const attrCurrentTemp =
        typeof climateRec?.snapshot?.attributes?.current_temperature === "number"
          ? (climateRec.snapshot.attributes.current_temperature as number)
          : currentTempMetric?.numericValue;

      if (climateRec && climateRec.domain === "climate") {
        const target =
          typeof climateRec.snapshot?.attributes?.temperature === "number"
            ? (climateRec.snapshot.attributes.temperature as number)
            : 26;
        const minTemp =
          typeof climateRec.snapshot?.attributes?.min_temp === "number"
            ? (climateRec.snapshot.attributes.min_temp as number)
            : 16;
        const maxTemp =
          typeof climateRec.snapshot?.attributes?.max_temp === "number"
            ? (climateRec.snapshot.attributes.max_temp as number)
            : 31;
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
        conciseSubtitle = [tempStr, pmStr ? `PM2.5 ${pmStr}` : undefined].filter(Boolean).join(" · ") || statusBadge;
      }

      // Select mode bar for purifier/fan/kettle if not already populated
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

      // Auxiliary toggles for AC (swing, heater, sleep)
      const auxSwitches = deviceRecords
        .filter(
          (r) =>
            r.domain === "switch" &&
            r.supported_features.includes("turn_on") &&
            /扫风|辅热|睡眠|指示灯|干燥|负离子/i.test(entityLabelText(r)),
        )
        .slice(0, 6);
      if (auxSwitches.length > 0) {
        capabilities.auxiliaryToggles = auxSwitches.map((r) => ({
          id: r.entity_id,
          label: (r.original_name ?? r.friendly_name ?? "")
            .replace(/^.*?(上下扫风|左右扫风|电辅热|辅热|睡眠模式|睡眠|指示灯|干燥).*$/, "$1")
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
      const cycle = buildCycleTaskCapability(icon, deviceRecords, telemetry);
      capabilities.cycleTask = cycle;
      capabilities.actions = buildActionTriggers(deviceRecords, icon);

      const modeSelect = deviceRecords.find(
        (r) => r.domain === "select" && /模式|程序|菜单|mode/i.test(entityLabelText(r)),
      );
      if (modeSelect) {
        const rawOpts = Array.isArray(modeSelect.snapshot?.attributes?.options)
          ? (modeSelect.snapshot?.attributes?.options as string[])
          : icon === "cooker"
            ? ["精煮饭", "快煮饭", "煮粥", "热饭"]
            : ["混合洗", "快洗", "单脱水"];
        const cur = stringState(modeSelect) ?? rawOpts[0] ?? "标准";
        capabilities.modeBar = {
          entityId: modeSelect.entity_id,
          domain: "select",
          service: "select_option",
          parameterKey: "option",
          currentMode: cur,
          currentLabel: cur,
          options: rawOpts.slice(0, 5).map((o) => ({ value: String(o), label: String(o) })),
          controllable: modeSelect.supported_features.includes("select_option"),
        };
      }

      isActive = cycle.isRunning;
      statusBadge = cycle.stageLabel;
      if (cycle.remainingMinutes !== undefined && cycle.remainingMinutes > 0) {
        conciseSubtitle = `剩余 ${cycle.remainingMinutes}m`;
      } else if (cycle.temperatureCelsius !== undefined) {
        conciseSubtitle = `${cycle.temperatureCelsius}°C`;
      } else {
        conciseSubtitle = cycle.stageLabel;
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
        const toggles = deviceRecords
          .filter(
            (r) =>
              r.domain === "switch" &&
              r.supported_features.includes("turn_on") &&
              /休眠|遮蔽|移动侦测|追踪|巡航|开关/i.test(entityLabelText(r)),
          )
          .slice(0, 4)
          .map((r) => ({
            id: r.entity_id,
            label: /休眠|遮蔽/.test(entityLabelText(r))
              ? "休眠"
              : /巡航/.test(entityLabelText(r))
                ? "巡航"
                : /侦测|追踪/.test(entityLabelText(r))
                  ? "移动侦测"
                  : "画面开关",
            entityId: r.entity_id,
            domain: "switch",
            isOn: r.snapshot?.state !== "off",
            controllable: r.supported_features.includes("turn_on"),
          }));

        const motionEvent = deviceRecords.find(
          (r) => (r.domain === "event" || r.domain === "binary_sensor") && /移动|有人|变化/i.test(entityLabelText(r)),
        );
        const lastMotionText = motionEvent?.snapshot?.last_changed ? "有人移动" : "监控在线";
        isActive = online && (capabilities.power?.isOn ?? true);
        statusBadge = online ? "在线" : "离线";
        conciseSubtitle = lastMotionText;

        capabilities.visionStream = {
          streamActive: isActive,
          statusText: online ? "实时流就绪" : "设备离线",
          lastMotionText,
          streamEntityId: startBtn?.entity_id ?? primary?.entity_id,
          stopEntityId: stopBtn?.entity_id,
          ptzActions: [],
          featureToggles: toggles,
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
      if (powerMetric) {
        conciseSubtitle = `实时 ${powerMetric.value}`;
      } else {
        conciseSubtitle = capabilities.power?.isOn ? "供电中" : "已关闭";
      }
    } else if (archetype === "media" || icon === "feeder" || icon === "waterer") {
      capabilities.actions = buildActionTriggers(deviceRecords, icon);
      if (icon === "feeder") {
        const eaten = telemetry.find((m) => m.key === "pet_eaten");
        statusBadge = "正常";
        conciseSubtitle = eaten ? `今日 ${eaten.value}` : "余粮充足";
      } else if (icon === "waterer") {
        const waterCount = telemetry.find((m) => m.key === "water_count");
        statusBadge = "正常";
        conciseSubtitle = waterCount ? `出水 ${waterCount.value}` : "水质正常";
      } else if (archetype === "media") {
        conciseSubtitle = isActive ? "播放/在线" : "待机";
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
      if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
      return a.name.localeCompare(b.name, "zh-CN");
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
      for (const m of app.capabilities.telemetry) {
        if (m.key === "temperature" && m.numericValue !== undefined && m.numericValue > -10 && m.numericValue < 45) {
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
      if (app.capabilities.thermostat?.currentTemp !== undefined) {
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
