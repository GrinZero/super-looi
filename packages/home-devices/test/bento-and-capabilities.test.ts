import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildHomeDashboardModel,
  packBentoTiles,
  type RawHomeEntityRecord,
  type TileSpan,
} from "../src/index.js";

describe("packBentoTiles 2D dense grid packer", () => {
  it("packs Hall-like mixed spans into 2 and 3 columns without overlaps or empty right-column holes", () => {
    const items: Array<{ id: string; span: TileSpan }> = [
      { id: "cam", span: "2x2" },
      { id: "ac", span: "2x1" },
      { id: "purifier", span: "2x1" },
      { id: "kettle", span: "2x1" },
      { id: "cooker", span: "2x1" },
      ...Array.from({ length: 21 }, (_, idx) => ({ id: `s-${idx + 1}`, span: "1x1" as const })),
    ];

    for (const cols of [2, 3]) {
      const placements = packBentoTiles(items, cols);
      assert.equal(placements.length, items.length);
      const packed = new Map(placements.map((p) => [p.id, p]));

      const occupied = new Set<string>();
      for (const item of items) {
        const p = packed.get(item.id);
        assert.ok(p, `missing placement for ${item.id}`);
        assert.ok(p.colStart >= 1 && p.colStart + p.colSpan - 1 <= cols);
        for (let r = p.rowStart; r < p.rowStart + p.rowSpan; r++) {
          for (let c = p.colStart; c < p.colStart + p.colSpan; c++) {
            const key = `${r}:${c}`;
            assert.equal(occupied.has(key), false, `overlap at ${key} in ${cols}-col grid`);
            occupied.add(key);
          }
        }
      }

      if (cols === 3) {
        // Rows 1..6 in column 3 must all be filled by 1x1 tiles alongside cam(2x2) and four 2x1 tiles
        for (let row = 1; row <= 6; row++) {
          assert.equal(occupied.has(`${row}:3`), true, `expected row ${row} col 3 to be filled`);
        }
      }
    }
  });
});

describe("Converged Mijia device capabilities & Chinese labels", () => {
  it("converges xiaomi.feeder.pi2001 portions, child lock mode, real eaten grams, and dispense/calibrate actions", () => {
    const records: RawHomeEntityRecord[] = [
      {
        entity_id: "sensor.mijia_feeder_s2_p18",
        domain: "sensor",
        friendly_name: "米家智能宠物喂食器2 · Eaten Food Measure",
        original_name: "pet-feeder eaten-food-measure Pet Feeder Eaten Food Measure",
        device_id: "feeder1",
        device_name: "米家智能宠物喂食器2",
        device_model: "xiaomi.feeder.pi2001",
        room: "大厅",
        source: "direct_miot",
        is_whitelisted: true,
        supported_features: ["read"],
        snapshot: { entity_id: "sensor.mijia_feeder_s2_p18", state: "0", attributes: { unit_of_measurement: "g" }, last_changed: "", last_updated: "" },
      },
      {
        entity_id: "sensor.mijia_feeder_s2_p22",
        domain: "sensor",
        friendly_name: "米家智能宠物喂食器2 · Eaten Food Measure",
        original_name: "pet-feeder eaten-food-measure Pet Feeder Eaten Food Measure",
        device_id: "feeder1",
        device_name: "米家智能宠物喂食器2",
        device_model: "xiaomi.feeder.pi2001",
        room: "大厅",
        source: "direct_miot",
        is_whitelisted: true,
        supported_features: ["read"],
        snapshot: { entity_id: "sensor.mijia_feeder_s2_p22", state: "98", attributes: { unit_of_measurement: "g" }, last_changed: "", last_updated: "" },
      },
      {
        entity_id: "number.mijia_feeder_s2_p7",
        domain: "number",
        friendly_name: "米家智能宠物喂食器2 · Target Feeding Measure",
        original_name: "pet-feeder target-feeding-measure Pet Feeder Target Feeding Measure",
        device_id: "feeder1",
        device_name: "米家智能宠物喂食器2",
        device_model: "xiaomi.feeder.pi2001",
        room: "大厅",
        source: "direct_miot",
        is_whitelisted: true,
        supported_features: ["read", "set_value"],
        snapshot: {
          entity_id: "number.mijia_feeder_s2_p7",
          state: "10",
          attributes: { min: 0, max: 200, step: 1, unit_of_measurement: "none" },
          last_changed: "",
          last_updated: "",
        },
      },
      {
        entity_id: "select.mijia_feeder_s3_p3",
        domain: "select",
        friendly_name: "米家智能宠物喂食器2 · Mode",
        original_name: "physical-controls-locked mode Physical Control Locked Mode",
        device_id: "feeder1",
        device_name: "米家智能宠物喂食器2",
        device_model: "xiaomi.feeder.pi2001",
        room: "大厅",
        source: "direct_miot",
        is_whitelisted: true,
        supported_features: ["read", "select_option"],
        snapshot: {
          entity_id: "select.mijia_feeder_s3_p3",
          state: "On",
          attributes: { options: ["Off", "On"] },
          last_changed: "",
          last_updated: "",
        },
      },
      {
        entity_id: "button.mijia_feeder_s2_a1_pet_food_out",
        domain: "button",
        friendly_name: "米家智能宠物喂食器2 · Pet Food Out",
        original_name: "pet-feeder pet-food-out Pet Feeder Pet Food Out",
        device_id: "feeder1",
        device_name: "米家智能宠物喂食器2",
        device_model: "xiaomi.feeder.pi2001",
        room: "大厅",
        source: "direct_miot",
        is_whitelisted: true,
        supported_features: ["press"],
        snapshot: { entity_id: "button.mijia_feeder_s2_a1_pet_food_out", state: "idle", attributes: {}, last_changed: "", last_updated: "" },
      },
      {
        entity_id: "button.mijia_feeder_s2_a5_weigh_manual_calibrate",
        domain: "button",
        friendly_name: "米家智能宠物喂食器2 · Weigh Manual Calibrate",
        original_name: "pet-feeder weigh-manual-calibrate Pet Feeder Weigh Manual Calibrate",
        device_id: "feeder1",
        device_name: "米家智能宠物喂食器2",
        device_model: "xiaomi.feeder.pi2001",
        room: "大厅",
        source: "direct_miot",
        is_whitelisted: true,
        supported_features: ["press"],
        snapshot: { entity_id: "button.mijia_feeder_s2_a5_weigh_manual_calibrate", state: "idle", attributes: {}, last_changed: "", last_updated: "" },
      },
    ];

    const model = buildHomeDashboardModel(records);
    const feeder = model.allAppliances[0]!;
    assert.equal(feeder.icon, "feeder");
    assert.equal(feeder.conciseSubtitle, "今日已进食 98g");

    const controls = feeder.capabilities.controls ?? [];
    const labels = controls.map((c) => c.label);
    assert.ok(labels.includes("单次出粮份数"));
    assert.ok(labels.includes("童锁模式"));
    assert.ok(labels.includes("立即出粮"));
    assert.ok(labels.includes("称重校准"));
    assert.equal(labels.includes("工作模式"), false);
    assert.equal(labels.includes("数值调节"), false);

    const portion = controls.find((c) => c.kind === "range" && c.label === "单次出粮份数");
    assert.ok(portion && portion.kind === "range");
    assert.equal(portion.min, 1);
    assert.equal(portion.max, 30);
    assert.equal(portion.unit, "份");
  });

  it("distinguishes PTZ Hall Camera from fixed Outdoor Camera and translates recording & SD states", () => {
    const records: RawHomeEntityRecord[] = [
      {
        entity_id: "switch.hall_cam_s2_p1",
        domain: "switch",
        friendly_name: "监控 · Switch Status",
        original_name: "camera-control on Camera Control Switch Status",
        device_id: "cam_hall",
        device_name: "监控",
        device_model: "chuangmi.camera.039a01",
        room: "大厅",
        source: "direct_miot",
        is_whitelisted: true,
        supported_features: ["turn_on", "turn_off"],
        snapshot: { entity_id: "switch.hall_cam_s2_p1", state: "on", attributes: {}, last_changed: "", last_updated: "" },
      },
      {
        entity_id: "select.hall_cam_s2_p5",
        domain: "select",
        friendly_name: "监控 · Recording Mode",
        original_name: "camera-control recording-mode Camera Control Recording Mode",
        device_id: "cam_hall",
        device_name: "监控",
        device_model: "chuangmi.camera.039a01",
        room: "大厅",
        source: "direct_miot",
        is_whitelisted: true,
        supported_features: ["read", "select_option"],
        snapshot: {
          entity_id: "select.hall_cam_s2_p5",
          state: "All Record",
          attributes: { options: ["All Record", "Motion Record", "No Record"] },
          last_changed: "",
          last_updated: "",
        },
      },
      {
        entity_id: "select.hall_cam_s2_p2",
        domain: "select",
        friendly_name: "监控 · Image Rollover",
        original_name: "camera-control image-rollover Camera Control Image Rollover",
        device_id: "cam_hall",
        device_name: "监控",
        device_model: "chuangmi.camera.039a01",
        room: "大厅",
        source: "direct_miot",
        is_whitelisted: true,
        supported_features: ["read", "select_option"],
        snapshot: {
          entity_id: "select.hall_cam_s2_p2",
          state: "0°",
          attributes: { options: ["0°", "180°"] },
          last_changed: "",
          last_updated: "",
        },
      },
      {
        entity_id: "sensor.hall_cam_sd",
        domain: "sensor",
        friendly_name: "监控 · Memory Card Status",
        original_name: "memory-card-management status Memory Card Management Status",
        device_id: "cam_hall",
        device_name: "监控",
        device_model: "chuangmi.camera.039a01",
        room: "大厅",
        source: "direct_miot",
        is_whitelisted: true,
        supported_features: ["read"],
        snapshot: { entity_id: "sensor.hall_cam_sd", state: "SD-Nomal", attributes: {}, last_changed: "", last_updated: "" },
      },
      {
        entity_id: "switch.roof_cam_s2_p1",
        domain: "switch",
        friendly_name: "天台监控 · Switch Status",
        original_name: "camera-control on Camera Control Switch Status",
        device_id: "cam_roof",
        device_name: "天台监控",
        device_model: "isa.camera.hlc7",
        room: "天台",
        source: "direct_miot",
        is_whitelisted: true,
        supported_features: ["turn_on", "turn_off"],
        snapshot: { entity_id: "switch.roof_cam_s2_p1", state: "on", attributes: {}, last_changed: "", last_updated: "" },
      },
    ];

    const model = buildHomeDashboardModel(records);
    const hallCam = model.allAppliances.find((a) => a.deviceId === "cam_hall")!;
    const roofCam = model.allAppliances.find((a) => a.deviceId === "cam_roof")!;

    assert.equal(hallCam.capabilities.visionStream?.supportsPtz, true);
    assert.equal(hallCam.capabilities.visionStream?.storageStatusText, "存储正常");
    const recSel = hallCam.capabilities.visionStream?.modeSelectors?.find((s) => s.label === "录制模式");
    assert.deepEqual(
      recSel?.capability.options.map((o) => o.label),
      ["全天录制", "移动录制", "不录制"],
    );
    const flipSel = hallCam.capabilities.visionStream?.modeSelectors?.find((s) => s.label === "画面翻转");
    assert.deepEqual(
      flipSel?.capability.options.map((o) => o.label),
      ["正常 (0°)", "倒装 (180°)"],
    );

    assert.equal(roofCam.capabilities.visionStream?.supportsPtz, false);
  });

  it("preserves all >8 wash modes on cycle appliances and prefers keep-warm-temperature on kettle", () => {
    const twentyModes = Array.from({ length: 14 }, (_, i) => `Mode${i + 1}`);
    const records: RawHomeEntityRecord[] = [
      {
        entity_id: "select.washer_mode",
        domain: "select",
        friendly_name: "洗衣机 · Mode",
        original_name: "washer mode Washer Mode",
        device_id: "washer1",
        device_name: "米家直驱滚筒洗衣机",
        device_model: "midjd8.washer.44",
        room: "天台",
        source: "direct_miot",
        is_whitelisted: true,
        supported_features: ["read", "select_option"],
        snapshot: {
          entity_id: "select.washer_mode",
          state: "Mode1",
          attributes: { options: twentyModes },
          last_changed: "",
          last_updated: "",
        },
      },
      {
        entity_id: "number.kettle_target",
        domain: "number",
        friendly_name: "电热水瓶 · Target Temperature",
        original_name: "kettle target-temperature Kettle Target Temperature",
        device_id: "kettle1",
        device_name: "米家智能电热水瓶",
        device_model: "xiaomi.kettle.mek01",
        room: "大厅",
        source: "direct_miot",
        is_whitelisted: true,
        supported_features: ["read", "set_value"],
        snapshot: { entity_id: "number.kettle_target", state: "100", attributes: { min: 40, max: 100, step: 1 }, last_changed: "", last_updated: "" },
      },
      {
        entity_id: "number.kettle_warm",
        domain: "number",
        friendly_name: "电热水瓶 · Keep Warm Temperature",
        original_name: "kettle keep-warm-temperature Kettle Keep Warm Temperature",
        device_id: "kettle1",
        device_name: "米家智能电热水瓶",
        device_model: "xiaomi.kettle.mek01",
        room: "大厅",
        source: "direct_miot",
        is_whitelisted: true,
        supported_features: ["read", "set_value"],
        snapshot: { entity_id: "number.kettle_warm", state: "55", attributes: { min: 40, max: 90, step: 1 }, last_changed: "", last_updated: "" },
      },
      {
        entity_id: "sensor.kettle_status",
        domain: "sensor",
        friendly_name: "电热水瓶 · Status",
        original_name: "kettle status Kettle Status",
        device_id: "kettle1",
        device_name: "米家智能电热水瓶",
        device_model: "xiaomi.kettle.mek01",
        room: "大厅",
        source: "direct_miot",
        is_whitelisted: true,
        supported_features: ["read"],
        snapshot: { entity_id: "sensor.kettle_status", state: "Keep Warm", attributes: {}, last_changed: "", last_updated: "" },
      },
    ];

    const model = buildHomeDashboardModel(records);
    const washer = model.allAppliances.find((a) => a.deviceId === "washer1")!;
    assert.equal(washer.capabilities.modeBar?.options.length, 14);

    const kettle = model.allAppliances.find((a) => a.deviceId === "kettle1")!;
    assert.equal(kettle.capabilities.thermostat?.entityId, "number.kettle_warm");
    assert.equal(kettle.capabilities.thermostat?.targetTemp, 55);
    assert.equal(kettle.statusBadge, "保温中");
  });
});
