import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildHomeDashboardModel,
  createEmptyLayoutPreferences,
  createSimulationRawRecords,
  cycleTileSpan,
  parseLayoutPreferences,
  serializeLayoutPreferences,
  swapApplianceOrderInList,
  updateApplianceOrder,
  updateApplianceSpan,
  type RawHomeEntityRecord,
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
  });
});
