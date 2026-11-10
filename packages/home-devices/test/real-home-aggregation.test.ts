import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildHomeDashboardModel,
  collectCardVisibleTexts,
  createEmptyLayoutPreferences,
  createSimulationRawRecords,
  cycleTileSpan,
  formatTileSpanDimensions,
  moveApplianceToIndexInList,
  parseLayoutPreferences,
  parseTileSpanDimensions,
  resolveApplianceCardView,
  serializeLayoutPreferences,
  swapApplianceOrderInList,
  updateApplianceOrder,
  updateApplianceSpan,
  type RawHomeEntityRecord,
  type TileSpan,
} from "../src/index.js";

const storageDir = resolve(import.meta.dirname, "../../../data/home-assistant/.storage");

function loadRealHomeSnapshotRecords(): RawHomeEntityRecord[] {
  const areasRaw = JSON.parse(readFileSync(resolve(storageDir, "core.area_registry"), "utf8"));
  const devicesRaw = JSON.parse(readFileSync(resolve(storageDir, "core.device_registry"), "utf8"));
  const entitiesRaw = JSON.parse(readFileSync(resolve(storageDir, "core.entity_registry"), "utf8"));

  const areaMap = new Map<string, string>();
  for (const area of areasRaw.data.areas) {
    areaMap.set(area.id, area.name);
  }

  const deviceMap = new Map<string, Record<string, unknown>>();
  for (const dev of devicesRaw.data.devices) {
    deviceMap.set(dev.id, dev);
  }

  const records: RawHomeEntityRecord[] = [];
  const nowIso = "2026-11-09T20:00:00.000Z";

  for (const ent of entitiesRaw.data.entities) {
    if (ent.platform !== "xiaomi_home" || ent.disabled_by) continue;
    const dev = deviceMap.get(ent.device_id);
    if (!dev) continue;
    const areaName = areaMap.get(ent.area_id ?? (dev.area_id as string));
    const domain = String(ent.entity_id).split(".")[0];
    const origName = String(ent.original_name ?? "");
    const devName = String(dev.name_by_user ?? dev.name ?? ent.entity_id);

    let mockState = "on";
    const attrs: Record<string, unknown> = { friendly_name: `${devName} ${origName}`.trim() };
    if (domain === "sensor") {
      mockState = /温度/.test(origName)
        ? "26.8"
        : /湿度/.test(origName)
          ? "58"
          : /二氧化碳|co2/i.test(origName)
            ? "540"
            : /剩余时间|剩余时长|left_time/i.test(`${origName} ${ent.entity_id}`)
              ? "18"
              : /阶段|状态/.test(origName)
                ? "沸腾中"
                : /功率/.test(origName)
                  ? "42"
                  : /电量/.test(origName)
                    ? "85"
                    : "10";
    } else if (domain === "climate") {
      mockState = "cool";
      attrs.current_temperature = 27.4;
      attrs.temperature = 26.0;
      attrs.min_temp = 16;
      attrs.max_temp = 31;
      attrs.target_temp_step = 0.5;
      attrs.hvac_modes = ["cool", "heat", "dry", "auto", "off"];
    } else if (domain === "number") {
      mockState = "55";
      attrs.min = 40;
      attrs.max = 90;
    }

    records.push({
      entity_id: ent.entity_id,
      friendly_name: `${devName} ${origName}`.trim(),
      original_name: origName,
      device_id: String(ent.device_id),
      device_name: devName,
      device_model: String(dev.model ?? ""),
      entity_category: ent.entity_category ?? undefined,
      room: areaName,
      domain,
      supported_features:
        domain === "light" || domain === "switch" || domain === "fan"
          ? ["turn_on", "turn_off"]
          : domain === "climate"
            ? ["turn_on", "turn_off", "set_temperature", "set_hvac_mode"]
            : domain === "button"
              ? ["press"]
              : domain === "notify"
                ? ["send_message"]
                : domain === "select"
                  ? ["select_option"]
                  : domain === "number"
                    ? ["set_value"]
                    : ["read"],
      is_whitelisted: true,
      source: "external_ha",
      snapshot: {
        entity_id: ent.entity_id,
        state: mockState,
        attributes: attrs as Record<string, string | number | boolean | null>,
        last_changed: nowIso,
        last_updated: nowIso,
      },
    });
  }

  return records;
}

describe("@super-looi/home-devices: Real Home Snapshot ('源心锁的家') & Bento Layout", () => {
  it("aggregates 600+ raw entities from '源心锁的家' into 45 clean physical appliances across 4 normalized rooms", () => {
    const rawRecords = loadRealHomeSnapshotRecords();
    assert.ok(rawRecords.length > 350, `Expected >350 active entities, got ${rawRecords.length}`);

    const dashboard = buildHomeDashboardModel(rawRecords);
    assert.equal(dashboard.homeName, "源心锁的家");
    assert.equal(dashboard.totalAppliances, 45);

    const roomNames = dashboard.rooms.map((r) => r.name);
    assert.deepEqual(roomNames, ["大厅", "卧室", "天台", "杂物间"]);

    // Verify room-level environmental metrics are aggregated on '大厅'
    const hall = dashboard.rooms.find((r) => r.name === "大厅")!;
    assert.ok(hall);
    assert.ok(hall.environment.some((e) => e.key === "temperature"));
    assert.ok(hall.environment.some((e) => e.key === "humidity"));
    assert.ok(hall.environment.some((e) => e.key === "co2"));

    // 1. 大厅监控 -> vision_security, camera, defaultSpan 2x2
    const camera = dashboard.allAppliances.find((a) => a.name === "监控")!;
    assert.ok(camera);
    assert.equal(camera.archetype, "vision_security");
    assert.equal(camera.icon, "camera");
    assert.equal(camera.defaultSpan, "2x2");
    assert.equal(camera.span, "2x2");
    assert.ok(camera.capabilities.visionStream);

    // 2. 电饭煲 -> cycle_appliance, cooker, defaultSpan 2x1, 5 stages + actions
    const cooker = dashboard.allAppliances.find((a) => a.name === "电饭煲")!;
    assert.ok(cooker);
    assert.equal(cooker.archetype, "cycle_appliance");
    assert.equal(cooker.icon, "cooker");
    assert.equal(cooker.defaultSpan, "2x1");
    assert.deepEqual(cooker.capabilities.cycleTask?.stages, ["预热", "吸水", "沸腾", "焖饭", "保温"]);
    assert.equal(cooker.capabilities.cycleTask?.remainingMinutes, 18);
    assert.ok((cooker.capabilities.actions?.length ?? 0) >= 1);

    // 2b. 扫地机器人 -> never exposes raw '13' / '14' / 'Yes', populates rich VacuumCapability
    const vacuum = dashboard.allAppliances.find((a) => a.name === "扫地机器人");
    if (vacuum) {
      assert.equal(vacuum.icon, "vacuum");
      assert.ok(!/^(13|14|yes|no)$/i.test(vacuum.statusBadge));
      assert.ok(!/^(13|14|yes|no)$/i.test(vacuum.capabilities.cycleTask?.stageLabel ?? ""));
      assert.ok(vacuum.capabilities.vacuum);
    }

    // 2c. 大厅灯 -> binds to primary switch on_p_2_1, never to '* 辅助开关 语音功能禁用开关' (disable_p_7_2)
    const hallLight = dashboard.allAppliances.find((a) => a.name === "大厅灯");
    if (hallLight && hallLight.capabilities.power) {
      assert.ok(
        !hallLight.capabilities.power.entityId.includes("disable_p_7_2"),
        `hallLight bound to wrong switch: ${hallLight.capabilities.power.entityId}`,
      );
    }

    // 3. 大厅空调 -> climate, ac, defaultSpan 2x1, thermostat + modeBar + auxiliaryToggles
    const ac = dashboard.allAppliances.find((a) => a.name === "空调")!;
    assert.ok(ac);
    assert.equal(ac.archetype, "climate");
    assert.equal(ac.icon, "ac");
    assert.equal(ac.defaultSpan, "2x1");
    assert.equal(ac.capabilities.thermostat?.targetTemp, 26);
    assert.equal(ac.capabilities.thermostat?.currentTemp, 27.4);
    assert.ok((ac.capabilities.auxiliaryToggles?.length ?? 0) >= 2);

    // 4. 天台洗衣机 -> cycle_appliance, washer, defaultSpan 2x1, actions include 清新抖散
    const washer = dashboard.allAppliances.find((a) => a.name === "洗衣机")!;
    assert.ok(washer);
    assert.equal(washer.archetype, "cycle_appliance");
    assert.equal(washer.icon, "washer");
    assert.equal(washer.defaultSpan, "2x1");
    assert.ok(washer.capabilities.actions?.some((act) => act.label === "清新抖散"));

    // 5. 主卧开关 -> lighting_power, switch_gang, 3 independent gang channels
    const multiSwitch = dashboard.allAppliances.find((a) => a.name === "主卧开关")!;
    assert.ok(multiSwitch);
    assert.equal(multiSwitch.archetype, "lighting_power");
    assert.equal(multiSwitch.icon, "switch_gang");
    assert.equal(multiSwitch.capabilities.multiGang?.channels.length, 3);

    // 6. 门锁 -> vision_security, lock, strictly readOnly
    const lock = dashboard.allAppliances.find((a) => a.name === "门锁")!;
    assert.ok(lock);
    assert.equal(lock.archetype, "vision_security");
    assert.equal(lock.icon, "lock");
    assert.equal(lock.capabilities.securityEvents?.readOnly, true);
    assert.equal(lock.capabilities.power, undefined);
  });

  it("supports user customization of card spans (1x1 / 2x1 / 2x2) and order with persistence", () => {
    const simRecords = createSimulationRawRecords();
    const initial = buildHomeDashboardModel(simRecords);

    const cooker = initial.allAppliances.find((a) => a.name === "电饭煲")!;
    assert.equal(cooker.span, "2x1");

    // User enlarges Rice Cooker to 2x2 and moves it to order 1
    let prefs = createEmptyLayoutPreferences();
    prefs = updateApplianceSpan(prefs, cooker.id, cycleTileSpan(cooker.span));
    prefs = updateApplianceOrder(prefs, cooker.id, 1);

    const serialized = serializeLayoutPreferences(prefs);
    const restored = parseLayoutPreferences(serialized);

    const updated = buildHomeDashboardModel(simRecords, restored);
    const updatedCooker = updated.allAppliances.find((a) => a.id === cooker.id)!;
    assert.equal(updatedCooker.span, "2x2");
    assert.equal(updatedCooker.order, 1);

    // Ensure it is now first in the '大厅' room list
    const hall = updated.rooms.find((r) => r.name === "大厅")!;
    assert.equal(hall.appliances[0].id, cooker.id);

    // Verify simulation Robot Vacuum translates raw '13' state into human-readable '基站待命' and exposes consumables
    const simVacuum = updated.allAppliances.find((a) => a.name === "扫地机器人")!;
    assert.ok(simVacuum);
    assert.equal(simVacuum.statusBadge, "基站待命");
    assert.equal(simVacuum.capabilities.vacuum?.batteryPercent, 100);
    assert.equal(simVacuum.capabilities.vacuum?.cleaningAreaSqm, 16);
    assert.equal(simVacuum.capabilities.vacuum?.consumables.length, 4);

    // Verify swapApplianceOrderInList swaps two blocks in the room
    const orderedIds = hall.appliances.map((a) => a.id);
    const swappedPrefs = swapApplianceOrderInList(restored, orderedIds, orderedIds[0]!, orderedIds[1]!);
    const afterSwap = buildHomeDashboardModel(simRecords, swappedPrefs);
    const hallAfterSwap = afterSwap.rooms.find((r) => r.name === "大厅")!;
    assert.equal(hallAfterSwap.appliances[0]!.id, orderedIds[1]);
    assert.equal(hallAfterSwap.appliances[1]!.id, orderedIds[0]);

    // Verify 1x2 span dimensions and moveApplianceToIndexInList
    assert.deepEqual(parseTileSpanDimensions("1x2"), { cols: 1, rows: 2 });
    assert.equal(formatTileSpanDimensions(1, 2), "1x2");
    const tallPrefs = updateApplianceSpan(swappedPrefs, cooker.id, "1x2");
    const restoredTall = parseLayoutPreferences(serializeLayoutPreferences(tallPrefs));
    assert.equal(restoredTall.appliances[cooker.id]?.span, "1x2");
    const movedPrefs = moveApplianceToIndexInList(restoredTall, orderedIds, orderedIds[2]!, 0);
    const afterMove = buildHomeDashboardModel(simRecords, movedPrefs);
    assert.equal(afterMove.rooms.find((r) => r.name === "大厅")!.appliances[0]!.id, orderedIds[2]);
  });

  it("correctly aggregates Direct MIoT fan, dishwasher, vacuum dual-brushes, idle cooker, camera KB storage, desk lamp, and same-device PM2.5 grade", () => {
    const directRecords: RawHomeEntityRecord[] = [
      // 1. dmaker.fan.p45
      {
        entity_id: "fan.miot_1092488635_s2_p1_on",
        domain: "fan",
        friendly_name: "米家智能直流变频循环扇 · Switch Status",
        device_id: "1092488635",
        device_name: "米家智能直流变频循环扇",
        device_model: "dmaker.fan.p45",
        room: "大厅",
        source: "direct_miot",
        original_name: "Fan · Switch Status",
        supported_features: ["read", "turn_on", "turn_off"],
        snapshot: { entity_id: "fan.miot_1092488635_s2_p1_on", state: "on", attributes: {}, last_updated: "" },
      },
      {
        entity_id: "select.miot_1092488635_s2_p2_fan_level",
        domain: "select",
        friendly_name: "米家智能直流变频循环扇 · Fan Level",
        device_id: "1092488635",
        device_name: "米家智能直流变频循环扇",
        device_model: "dmaker.fan.p45",
        room: "大厅",
        source: "direct_miot",
        original_name: "Fan · Fan Level",
        supported_features: ["read", "select_option"],
        snapshot: {
          entity_id: "select.miot_1092488635_s2_p2_fan_level",
          state: "Level2",
          attributes: { options: ["Level1", "Level2", "Level3", "Level4"] },
          last_updated: "",
        },
      },
      {
        entity_id: "select.miot_1092488635_s2_p3_mode",
        domain: "select",
        friendly_name: "米家智能直流变频循环扇 · Mode",
        device_id: "1092488635",
        device_name: "米家智能直流变频循环扇",
        device_model: "dmaker.fan.p45",
        room: "大厅",
        source: "direct_miot",
        original_name: "Fan · Mode",
        supported_features: ["read", "select_option"],
        snapshot: {
          entity_id: "select.miot_1092488635_s2_p3_mode",
          state: "Natural Wind",
          attributes: { options: ["Straight Wind", "Natural Wind", "Sleep"] },
          last_updated: "",
        },
      },
      {
        entity_id: "switch.miot_1092488635_s2_p4_horizontal_swing",
        domain: "switch",
        friendly_name: "米家智能直流变频循环扇 · Horizontal Swing",
        device_id: "1092488635",
        device_name: "米家智能直流变频循环扇",
        device_model: "dmaker.fan.p45",
        room: "大厅",
        source: "direct_miot",
        original_name: "Fan · Horizontal Swing",
        supported_features: ["read", "turn_on", "turn_off"],
        snapshot: { entity_id: "switch.miot_1092488635_s2_p4_horizontal_swing", state: "on", attributes: {}, last_updated: "" },
      },
      {
        entity_id: "select.miot_1092488635_s2_p5_horizontal_swing_included_angle",
        domain: "select",
        friendly_name: "米家智能直流变频循环扇 · Horizontal Swing Included Angle",
        device_id: "1092488635",
        device_name: "米家智能直流变频循环扇",
        device_model: "dmaker.fan.p45",
        room: "大厅",
        source: "direct_miot",
        original_name: "Fan · Horizontal Swing Included Angle",
        supported_features: ["read", "select_option"],
        snapshot: {
          entity_id: "select.miot_1092488635_s2_p5_horizontal_swing_included_angle",
          state: "120",
          attributes: { options: ["30", "60", "90", "120", "150"] },
          last_updated: "",
        },
      },
      {
        entity_id: "button.miot_1092488635_s2_a2_turn_left",
        domain: "button",
        friendly_name: "米家智能直流变频循环扇 · Turn Left",
        device_id: "1092488635",
        device_name: "米家智能直流变频循环扇",
        device_model: "dmaker.fan.p45",
        room: "大厅",
        source: "direct_miot",
        original_name: "Fan · Turn Left",
        supported_features: ["press"],
        snapshot: { entity_id: "button.miot_1092488635_s2_a2_turn_left", state: "ready", attributes: {}, last_updated: "" },
      },
      // 2. qmdq88.dishwasher.s1
      {
        entity_id: "switch.miot_1145020874_s2_p1_on",
        domain: "switch",
        friendly_name: "米家智能独嵌两用洗碗机15套S1 · Switch Status",
        device_id: "1145020874",
        device_name: "米家智能独嵌两用洗碗机15套S1",
        device_model: "qmdq88.dishwasher.s1",
        room: "厨房",
        source: "direct_miot",
        original_name: "Dishwasher · Switch Status",
        supported_features: ["read", "turn_on", "turn_off"],
        snapshot: { entity_id: "switch.miot_1145020874_s2_p1_on", state: "off", attributes: {}, last_updated: "" },
      },
      {
        entity_id: "sensor.miot_1145020874_s2_p2_status",
        domain: "sensor",
        friendly_name: "米家智能独嵌两用洗碗机15套S1 · Status",
        device_id: "1145020874",
        device_name: "米家智能独嵌两用洗碗机15套S1",
        device_model: "qmdq88.dishwasher.s1",
        room: "厨房",
        source: "direct_miot",
        original_name: "Dishwasher · Status",
        supported_features: ["read"],
        snapshot: { entity_id: "sensor.miot_1145020874_s2_p2_status", state: "Off", attributes: {}, last_updated: "" },
      },
      // 3. xiaomi.vacuum.d103cn dual brushes
      {
        entity_id: "sensor.miot_845910099_s2_p1_status",
        domain: "sensor",
        friendly_name: "米家全能扫拖机器人M30 S · Status",
        device_id: "845910099",
        device_name: "米家全能扫拖机器人M30 S",
        device_model: "xiaomi.vacuum.d103cn",
        room: "大厅",
        source: "direct_miot",
        original_name: "Robot Cleaner · Status",
        supported_features: ["read"],
        snapshot: { entity_id: "sensor.miot_845910099_s2_p1_status", state: "Charging", attributes: {}, last_updated: "" },
      },
      {
        entity_id: "sensor.miot_845910099_s9_p1_brush_left_time",
        domain: "sensor",
        friendly_name: "米家全能扫拖机器人M30 S · Brush Left Time",
        device_id: "845910099",
        device_name: "米家全能扫拖机器人M30 S",
        device_model: "xiaomi.vacuum.d103cn",
        room: "大厅",
        source: "direct_miot",
        original_name: "Main Cleaning Brush · Brush Left Time",
        supported_features: ["read"],
        snapshot: { entity_id: "sensor.miot_845910099_s9_p1_brush_left_time", state: "258", attributes: {}, last_updated: "" },
      },
      {
        entity_id: "sensor.miot_845910099_s9_p2_brush_life_level",
        domain: "sensor",
        friendly_name: "米家全能扫拖机器人M30 S · Brush Life Level",
        device_id: "845910099",
        device_name: "米家全能扫拖机器人M30 S",
        device_model: "xiaomi.vacuum.d103cn",
        room: "大厅",
        source: "direct_miot",
        original_name: "Main Cleaning Brush · Brush Life Level",
        supported_features: ["read"],
        snapshot: { entity_id: "sensor.miot_845910099_s9_p2_brush_life_level", state: "86", attributes: {}, last_updated: "" },
      },
      {
        entity_id: "sensor.miot_845910099_s10_p1_brush_left_time",
        domain: "sensor",
        friendly_name: "米家全能扫拖机器人M30 S · Brush Left Time",
        device_id: "845910099",
        device_name: "米家全能扫拖机器人M30 S",
        device_model: "xiaomi.vacuum.d103cn",
        room: "大厅",
        source: "direct_miot",
        original_name: "Side Cleaning Brush · Brush Left Time",
        supported_features: ["read"],
        snapshot: { entity_id: "sensor.miot_845910099_s10_p1_brush_left_time", state: "106", attributes: {}, last_updated: "" },
      },
      {
        entity_id: "sensor.miot_845910099_s10_p2_brush_life_level",
        domain: "sensor",
        friendly_name: "米家全能扫拖机器人M30 S · Brush Life Level",
        device_id: "845910099",
        device_name: "米家全能扫拖机器人M30 S",
        device_model: "xiaomi.vacuum.d103cn",
        room: "大厅",
        source: "direct_miot",
        original_name: "Side Cleaning Brush · Brush Life Level",
        supported_features: ["read"],
        snapshot: { entity_id: "sensor.miot_845910099_s10_p2_brush_life_level", state: "58", attributes: {}, last_updated: "" },
      },
      // 4. chunmi.cooker.cmwy4 idle without recipe
      {
        entity_id: "sensor.miot_1095370281_s2_p1_status",
        domain: "sensor",
        friendly_name: "米家智能电饭煲 · Status",
        device_id: "1095370281",
        device_name: "米家智能电饭煲",
        device_model: "chunmi.cooker.cmwy4",
        room: "大厅",
        source: "direct_miot",
        original_name: "Cooker · Status",
        supported_features: ["read"],
        snapshot: { entity_id: "sensor.miot_1095370281_s2_p1_status", state: "Idle", attributes: {}, last_updated: "" },
      },
      // 5. isa.camera.hlc7 KB storage and placeholder stream
      {
        entity_id: "switch.miot_570967500_s2_p1_on",
        domain: "switch",
        friendly_name: "小米智能摄像机 标准版 2K · Switch Status",
        device_id: "570967500",
        device_name: "小米智能摄像机 标准版 2K",
        device_model: "isa.camera.hlc7",
        room: "天台",
        source: "direct_miot",
        original_name: "Camera Control · Switch Status",
        supported_features: ["read", "turn_on", "turn_off"],
        snapshot: { entity_id: "switch.miot_570967500_s2_p1_on", state: "on", attributes: {}, last_updated: "" },
      },
      {
        entity_id: "sensor.miot_570967500_s4_p2_storage_total_space",
        domain: "sensor",
        friendly_name: "小米智能摄像机 标准版 2K · Storage Total Space",
        device_id: "570967500",
        device_name: "小米智能摄像机 标准版 2K",
        device_model: "isa.camera.hlc7",
        room: "天台",
        source: "direct_miot",
        original_name: "Memory Card Management · Storage Total Space",
        supported_features: ["read"],
        snapshot: { entity_id: "sensor.miot_570967500_s4_p2_storage_total_space", state: "30521344", attributes: {}, last_updated: "" },
      },
      {
        entity_id: "sensor.miot_570967500_s4_p4_storage_used_space",
        domain: "sensor",
        friendly_name: "小米智能摄像机 标准版 2K · Storage Used Space",
        device_id: "570967500",
        device_name: "小米智能摄像机 标准版 2K",
        device_model: "isa.camera.hlc7",
        room: "天台",
        source: "direct_miot",
        original_name: "Memory Card Management · Storage Used Space",
        supported_features: ["read"],
        snapshot: { entity_id: "sensor.miot_570967500_s4_p4_storage_used_space", state: "29299392", attributes: {}, last_updated: "" },
      },
      // 6. zhimi.airp.rma3 with same-device PM2.5 and air quality grade
      {
        entity_id: "fan.miot_721125732_s2_p1_on",
        domain: "fan",
        friendly_name: "米家空气净化器 4 Lite · Switch Status",
        device_id: "721125732",
        device_name: "米家空气净化器 4 Lite",
        device_model: "zhimi.airp.rma3",
        room: "大厅",
        source: "direct_miot",
        original_name: "Air Purifier · Switch Status",
        supported_features: ["read", "turn_on", "turn_off"],
        snapshot: { entity_id: "fan.miot_721125732_s2_p1_on", state: "on", attributes: {}, last_updated: "" },
      },
      {
        entity_id: "sensor.miot_721125732_s3_p4_pm2_5_density",
        domain: "sensor",
        friendly_name: "米家空气净化器 4 Lite · Pm2.5 Density",
        device_id: "721125732",
        device_name: "米家空气净化器 4 Lite",
        device_model: "zhimi.airp.rma3",
        room: "大厅",
        source: "direct_miot",
        original_name: "Environment · Pm2.5 Density",
        supported_features: ["read"],
        snapshot: { entity_id: "sensor.miot_721125732_s3_p4_pm2_5_density", state: "10", attributes: {}, last_updated: "" },
      },
      {
        entity_id: "sensor.miot_721125732_s3_p8_air_quality",
        domain: "sensor",
        friendly_name: "米家空气净化器 4 Lite · Air Quality",
        device_id: "721125732",
        device_name: "米家空气净化器 4 Lite",
        device_model: "zhimi.airp.rma3",
        room: "大厅",
        source: "direct_miot",
        original_name: "Environment · Air Quality",
        supported_features: ["read"],
        snapshot: { entity_id: "sensor.miot_721125732_s3_p8_air_quality", state: "Excellent", attributes: {}, last_updated: "" },
      },
      // 7. philips.light.lite desk lamp
      {
        entity_id: "light.miot_570967591_s2_p1_on",
        domain: "light",
        friendly_name: "米家飞利浦台灯Lite · Switch Status",
        device_id: "570967591",
        device_name: "米家飞利浦台灯Lite",
        device_model: "philips.light.lite",
        room: "书房",
        source: "direct_miot",
        original_name: "Light · Switch Status",
        supported_features: ["read", "turn_on", "turn_off", "brightness"],
        snapshot: { entity_id: "light.miot_570967591_s2_p1_on", state: "on", attributes: { brightness: 128 }, last_updated: "" },
      },
    ];

    const model = buildHomeDashboardModel(directRecords);

    const fan = model.allAppliances.find((a) => a.model === "dmaker.fan.p45")!;
    assert.equal(fan.icon, "fan");
    assert.equal(fan.capabilities.modeBar?.currentLabel, "自然风");
    assert.equal(fan.capabilities.fanLevel?.currentLabel, "2档");
    assert.ok(fan.capabilities.auxiliaryToggles?.some((t) => t.label === "左右摆风" && t.isOn));
    assert.ok(fan.capabilities.actions?.some((act) => act.label === "左转"));
    assert.ok(fan.capabilities.controls?.some((c) => c.kind === "choice" && c.label === "摇头角度"));

    const dishwasher = model.allAppliances.find((a) => a.model === "qmdq88.dishwasher.s1")!;
    assert.equal(dishwasher.icon, "dishwasher");

    const vacuum = model.allAppliances.find((a) => a.model === "xiaomi.vacuum.d103cn")!;
    const mainBrush = vacuum.capabilities.vacuum?.consumables.find((c) => c.id === "main_brush");
    const sideBrush = vacuum.capabilities.vacuum?.consumables.find((c) => c.id === "side_brush");
    assert.equal(mainBrush?.percent, 86);
    assert.equal(mainBrush?.remainingHours, 258);
    assert.equal(sideBrush?.percent, 58);
    assert.equal(sideBrush?.remainingHours, 106);

    const cooker = model.allAppliances.find((a) => a.model === "chunmi.cooker.cmwy4")!;
    assert.equal(cooker.capabilities.cycleTask?.stageLabel, "待机");
    assert.equal(cooker.capabilities.cycleTask?.recipeLabel, undefined);
    assert.equal(cooker.capabilities.cycleTask?.progressPercent, undefined);

    const camera = model.allAppliances.find((a) => a.model === "isa.camera.hlc7")!;
    assert.equal(camera.capabilities.visionStream?.streamActive, false);
    assert.equal(camera.capabilities.visionStream?.resolutionBadge, undefined);
    assert.equal(camera.capabilities.visionStream?.statusText, "暂未接入实时视频流");
    assert.ok(camera.capabilities.visionStream?.storageStatusText?.includes("27.9 GB / 29.1 GB"));

    const purifier = model.allAppliances.find((a) => a.model === "zhimi.airp.rma3")!;
    const pmMetric = purifier.capabilities.telemetry.find((m) => m.key === "pm25");
    assert.equal(pmMetric?.value, "10");
    assert.equal(pmMetric?.badge, "优");
    const hallRoom = model.rooms.find((r) => r.name === "大厅")!;
    const roomPm = hallRoom.environment.find((e) => e.key === "pm25");
    assert.equal(roomPm?.badge, "优");

    const deskLamp = model.allAppliances.find((a) => a.model === "philips.light.lite")!;
    assert.equal(deskLamp.icon, "desk_lamp");
  });

  it("enforces single-slot ownership and prevents status duplication across all spans", () => {
    // 1. Screenshot Case A: 洗碗机 in '保管中' with mode '智能'
    // Previously repeated '保管中' / '保管' 5 times across Header, inner box title, inner box subtitle, and stage labels.
    const dishwasherRecords: RawHomeEntityRecord[] = [
      {
        entity_id: "switch.miot_1145020874_s2_p1_on",
        domain: "switch",
        friendly_name: "洗碗机 · Switch Status",
        device_id: "1145020874",
        device_name: "洗碗机",
        device_model: "qmdq88.dishwasher.s1",
        room: "厨房",
        source: "direct_miot",
        original_name: "Dishwasher · Switch Status",
        supported_features: ["read", "turn_on", "turn_off"],
        snapshot: { entity_id: "switch.miot_1145020874_s2_p1_on", state: "on", attributes: {}, last_updated: "" },
      },
      {
        entity_id: "sensor.miot_1145020874_s2_p2_status",
        domain: "sensor",
        friendly_name: "洗碗机 · Status",
        device_id: "1145020874",
        device_name: "洗碗机",
        device_model: "qmdq88.dishwasher.s1",
        room: "厨房",
        source: "direct_miot",
        original_name: "Dishwasher · Status",
        supported_features: ["read"],
        snapshot: { entity_id: "sensor.miot_1145020874_s2_p2_status", state: "保管中", attributes: {}, last_updated: "" },
      },
      {
        entity_id: "select.miot_1145020874_s2_p3_mode",
        domain: "select",
        friendly_name: "洗碗机 · Mode",
        device_id: "1145020874",
        device_name: "洗碗机",
        device_model: "qmdq88.dishwasher.s1",
        room: "厨房",
        source: "direct_miot",
        original_name: "Dishwasher · Mode",
        supported_features: ["read", "select_option"],
        snapshot: {
          entity_id: "select.miot_1145020874_s2_p3_mode",
          state: "智能",
          attributes: { options: ["智能", "标准洗", "强力洗"] },
          last_updated: "",
        },
      },
    ];
    const dishwasherModel = buildHomeDashboardModel(dishwasherRecords);
    const dishwasher = dishwasherModel.allAppliances[0]!;
    const dishwasherView = resolveApplianceCardView(dishwasher, "2x1");
    assert.equal(dishwasherView.header.subtitle, "智能 · 保管中");
    assert.equal(dishwasherView.header.trailing.kind, "power");
    assert.equal(dishwasherView.cycleBody?.primaryReadout, undefined);
    assert.deepEqual(
      dishwasherView.cycleBody?.stages.map((s) => ({ label: s.label, state: s.state })),
      [
        { label: "预洗", state: "completed" },
        { label: "主洗", state: "completed" },
        { label: "漂洗", state: "completed" },
        { label: "烘干", state: "completed" },
        { label: "保管", state: "current" },
      ],
    );
    const dishwasherTexts = collectCardVisibleTexts(dishwasherView);
    assert.equal(dishwasherTexts.filter((t) => t.includes("保管中")).length, 1);

    // 2. Screenshot Case B: 主卧开关 (1x1 multi-gang switch with 1 channel on)
    // Previously rendered '1/3 开启' badge in top-right (squeezing 4-char title '主卧开关' into 2 lines) AND '已开 1 路' subtitle.
    const switchRecords: RawHomeEntityRecord[] = [
      {
        entity_id: "switch.master_sw_1",
        domain: "switch",
        friendly_name: "主卧开关 按键 1",
        device_id: "master_sw",
        device_name: "主卧开关",
        device_model: "lumi.switch.b3lacn02",
        room: "卧室",
        source: "external_ha",
        original_name: "左键开关",
        supported_features: ["turn_on", "turn_off"],
        snapshot: { entity_id: "switch.master_sw_1", state: "off", attributes: {}, last_updated: "" },
      },
      {
        entity_id: "switch.master_sw_2",
        domain: "switch",
        friendly_name: "主卧开关 按键 2",
        device_id: "master_sw",
        device_name: "主卧开关",
        device_model: "lumi.switch.b3lacn02",
        room: "卧室",
        source: "external_ha",
        original_name: "中键开关",
        supported_features: ["turn_on", "turn_off"],
        snapshot: { entity_id: "switch.master_sw_2", state: "on", attributes: {}, last_updated: "" },
      },
      {
        entity_id: "switch.master_sw_3",
        domain: "switch",
        friendly_name: "主卧开关 按键 3",
        device_id: "master_sw",
        device_name: "主卧开关",
        device_model: "lumi.switch.b3lacn02",
        room: "卧室",
        source: "external_ha",
        original_name: "右键开关",
        supported_features: ["turn_on", "turn_off"],
        snapshot: { entity_id: "switch.master_sw_3", state: "off", attributes: {}, last_updated: "" },
      },
    ];
    const switchModel = buildHomeDashboardModel(switchRecords);
    const masterSwitch = switchModel.allAppliances[0]!;
    const switchView1x1 = resolveApplianceCardView(masterSwitch, "1x1");
    assert.equal(switchView1x1.header.trailing.kind, "none");
    assert.equal(switchView1x1.header.subtitle, "已开 1 路");
    assert.equal(switchView1x1.multiGangChannels?.length, 3);

    // 3. Screenshot Case C: 米家智能微烤一体机 in idle '待机' state without power switch
    // Previously repeated '待机' 6 times and lit up stage bar[0] in black because stages[0] was '待机' and activeStageIndex defaulted to 0.
    const microwaveRecords: RawHomeEntityRecord[] = [
      {
        entity_id: "sensor.microwave_status",
        domain: "sensor",
        friendly_name: "米家智能微烤一体机 · Status",
        device_id: "mw_1",
        device_name: "米家智能微烤一体机",
        device_model: "chunmi.microwave.n20l01",
        room: "厨房",
        source: "direct_miot",
        original_name: "Microwave · Status",
        supported_features: ["read"],
        snapshot: { entity_id: "sensor.microwave_status", state: "Idle", attributes: {}, last_updated: "" },
      },
    ];
    const microwaveModel = buildHomeDashboardModel(microwaveRecords);
    const microwave = microwaveModel.allAppliances[0]!;
    assert.deepEqual(microwave.capabilities.cycleTask?.stages, ["预热", "加热", "烘烤", "散温"]);
    assert.equal(microwave.capabilities.cycleTask?.activeStageIndex, -1);
    const microwaveView = resolveApplianceCardView(microwave, "2x1");
    assert.equal(microwaveView.header.trailing.kind, "none");
    assert.equal(microwaveView.header.subtitle, "待机");
    assert.equal(microwaveView.cycleBody?.primaryReadout, undefined);
    assert.ok(microwaveView.cycleBody?.stages.every((s) => s.state === "upcoming"));
    const microwaveTexts = collectCardVisibleTexts(microwaveView);
    assert.equal(microwaveTexts.filter((t) => t.includes("待机")).length, 1);

    // 4. Screenshot Case D: 空调 in 2x1 vs 1x1 when targetTemp === currentTemp === 22.5°C
    // Previously repeated '22.5°C' in both Header ('制冷 · 22.5°C') and Body stepper ('22.5°C' + '室温 22.5°C').
    const acRecords: RawHomeEntityRecord[] = [
      {
        entity_id: "climate.living_ac",
        domain: "climate",
        friendly_name: "空调",
        device_id: "ac_1",
        device_name: "空调",
        device_model: "xiaomi.aircondition.mc5",
        room: "大厅",
        source: "external_ha",
        original_name: "空调",
        supported_features: ["turn_on", "turn_off", "set_temperature", "set_hvac_mode"],
        snapshot: {
          entity_id: "climate.living_ac",
          state: "cool",
          attributes: {
            current_temperature: 22.5,
            temperature: 22.5,
            min_temp: 16,
            max_temp: 31,
            target_temp_step: 0.5,
            hvac_modes: ["cool", "heat", "dry", "auto", "off"],
          },
          last_updated: "",
        },
      },
    ];
    const acModel = buildHomeDashboardModel(acRecords);
    const ac = acModel.allAppliances[0]!;
    const acView2x1 = resolveApplianceCardView(ac, "2x1");
    assert.equal(acView2x1.header.subtitle, "制冷 · 室温 22.5°C");
    assert.equal(acView2x1.climateBody?.thermostat?.readoutText, "22.5°C");
    // In 1x1, Body is hidden, so Header folds target temperature back into subtitle
    const acView1x1 = resolveApplianceCardView(ac, "1x1");
    assert.equal(acView1x1.header.subtitle, "制冷 · 22.5°C");
    assert.equal(acView1x1.climateBody, undefined);

    // 5. Global Invariant Check across all 45 real-home appliances + simulation appliances across all 4 spans
    const allDashboards = [
      buildHomeDashboardModel(loadRealHomeSnapshotRecords()),
      buildHomeDashboardModel(createSimulationRawRecords()),
    ];
    const spans: TileSpan[] = ["1x1", "2x1", "1x2", "2x2"];
    for (const dashboard of allDashboards) {
      for (const app of dashboard.allAppliances) {
        for (const span of spans) {
          const view = resolveApplianceCardView(app, span);
          const slotTexts = collectCardVisibleTexts(view).slice(1); // exclude card title
          const normalizedSeen = new Set<string>();
          for (const text of slotTexts) {
            const norm = text.trim();
            if (!norm) continue;
            assert.ok(
              !normalizedSeen.has(norm),
              `Duplicate visible text '${norm}' on appliance '${app.name}' (${app.id}) at span ${span}: [${slotTexts.join(", ")}]`,
            );
            normalizedSeen.add(norm);
          }
        }
      }
    }
  });
});
