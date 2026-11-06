import { useState, type ReactElement } from "react";
import { Modal, Pressable as NativePressable, ScrollView, StyleSheet, Text, View, useWindowDimensions, type PressableProps } from "react-native";
import type { HomeEntityDefinition, HomeStateSnapshot } from "@super-looi/contracts";
import {
  buildKelvinPresets,
  formatDeviceDisplay,
  formatSensorReading,
  isKelvinPresetActive,
  type KelvinPreset,
  type OptimisticHomeDeviceState,
} from "../home-control-interaction.js";
import { LooiIcon } from "../components/LooiIcon.js";
import { ToggleSwitch } from "../components/ToggleSwitch.js";
import { BrightnessSliderBar } from "../components/BrightnessSliderBar.js";
import { LOOI_PALETTE as P } from "../theme.js";

export { buildKelvinPresets, formatDeviceDisplay, formatSensorReading, isKelvinPresetActive, type KelvinPreset };

export interface ConnectedDevice extends HomeEntityDefinition {
  snapshot: HomeStateSnapshot | null;
}

export interface ReadOnlyDevice {
  entity_id: string;
  friendly_name: string;
  device_id?: string;
  device_name?: string;
  room?: string;
  snapshot: HomeStateSnapshot | null;
}

function Pressable({ style, ...props }: PressableProps): ReactElement {
  return (
    <NativePressable
      {...props}
      style={(state) => [
        typeof style === "function" ? style(state) : style,
        state.pressed && { opacity: 0.76, transform: [{ scale: 0.98 }] },
      ]}
    />
  );
}

function quantizeStep(value: number, min: number, max: number): number {
  const clamped = Math.max(min, Math.min(max, value));
  const rounded = Math.round(clamped / 100) * 100;
  return Math.max(min, Math.min(max, rounded));
}

function formatClock(timestamp: string | undefined): string {
  if (!timestamp) return "刚刚";
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) return "刚刚";
  return parsed.toLocaleTimeString("zh-CN", { hour12: false });
}

export interface HomeDeviceDetailModalProps {
  device: ConnectedDevice | null;
  readOnlyDevice?: ReadOnlyDevice | null;
  optimistic: OptimisticHomeDeviceState;
  healthy: boolean;
  allEntities: ConnectedDevice[];
  allReadOnly: ReadOnlyDevice[];
  resolveOptimistic: (entity: ConnectedDevice) => OptimisticHomeDeviceState;
  onClose: () => void;
  onExecute: (device: ConnectedDevice, on: boolean, brightness?: number, kelvin?: number) => void;
}

export function HomeDeviceDetailModal({
  device,
  readOnlyDevice,
  optimistic,
  healthy,
  allEntities,
  allReadOnly,
  resolveOptimistic,
  onClose,
  onExecute,
}: HomeDeviceDetailModalProps): ReactElement | null {
  const [sliderDragging, setSliderDragging] = useState(false);
  const { width, height } = useWindowDimensions();
  const shortLandscape = width > height && height < 480;

  const target = device ?? readOnlyDevice;
  if (!target) return null;

  const display = formatDeviceDisplay(target);
  const state = target.snapshot;
  const unavailable = !healthy || !state || ["unavailable", "unknown"].includes(state.state);
  const controllable = Boolean(device && device.is_whitelisted && device.supported_features.includes("turn_on"));
  const hasBrightness = Boolean(device && controllable && device.supported_features.includes("brightness"));
  const kelvinRange = device && controllable ? device.allowed_range?.color_temp_kelvin : undefined;
  const kelvinPresets = buildKelvinPresets(kelvinRange, 5);
  const isSensor = Boolean(device && ["sensor", "binary_sensor"].includes(device.domain));
  const sensorInfo = formatSensorReading(state, healthy);

  // Group sibling entities belonging to the same physical appliance
  const siblingControls = allEntities.filter(
    (item) =>
      item.entity_id !== target.entity_id &&
      ((target.device_id && item.device_id === target.device_id) ||
        (target.device_name && item.device_name === target.device_name)),
  );
  const siblingReadOnly = allReadOnly.filter(
    (item) =>
      item.entity_id !== target.entity_id &&
      ((target.device_id && item.device_id === target.device_id) ||
        (target.device_name && item.device_name === target.device_name)),
  );

  const scenes = device && hasBrightness
    ? [
        {
          id: "reading",
          label: "阅读专注",
          desc: kelvinRange ? "100% · 自然白" : "100% 满亮",
          color: "#FFF4E0",
          brightness: 255,
          kelvin: kelvinRange ? quantizeStep(4000, kelvinRange[0], kelvinRange[1]) : undefined,
        },
        {
          id: "cozy",
          label: "温馨夜读",
          desc: kelvinRange ? "60% · 暖黄光" : "60% 柔光",
          color: "#FFB347",
          brightness: 153,
          kelvin: kelvinRange ? quantizeStep(3000, kelvinRange[0], kelvinRange[1]) : undefined,
        },
        {
          id: "night",
          label: "柔和起夜",
          desc: kelvinRange ? "20% · 柔暖光" : "20% 微光",
          color: "#FF9E44",
          brightness: 51,
          kelvin: kelvinRange ? kelvinRange[0] : undefined,
        },
        {
          id: "cool",
          label: "明亮清冷",
          desc: kelvinRange ? "100% · 清冷光" : "80% 明亮",
          color: "#8CE0FF",
          brightness: kelvinRange ? 255 : 204,
          kelvin: kelvinRange ? kelvinRange[1] : undefined,
        },
      ]
    : [];

  const statusText = unavailable
    ? "设备暂不可用"
    : optimistic.rejected
      ? "参数未生效 · 请重试"
      : controllable
        ? optimistic.on
          ? "已开启"
          : "已关闭"
        : isSensor
          ? sensorInfo.statusLabel
          : "状态只读";

  const statusColor = unavailable
    ? P.amberWarning
    : optimistic.rejected
      ? P.alertCoral
      : controllable
        ? optimistic.on
          ? P.confirmGreen
          : P.textSecondary
        : P.presenceCyan;

  return (
    <Modal
      visible
      transparent
      animationType="fade"
      supportedOrientations={["portrait", "landscape", "landscape-left", "landscape-right"]}
      onRequestClose={onClose}
    >
      <View style={s.backdrop}>
        <NativePressable
          style={StyleSheet.absoluteFill}
          accessibilityRole="button"
          accessibilityLabel="关闭设备详情"
          onPress={onClose}
        />
        <View style={[s.sheet, shortLandscape && s.shortSheet]}>
          <View style={s.header}>
            <View style={[s.iconBox, optimistic.on && !unavailable && s.iconBoxOn]}>
              <LooiIcon name={display.icon} size={22} color={optimistic.on && !unavailable ? P.presenceCyan : P.textSecondary} />
            </View>
            <View style={s.headerCopy}>
              <View style={s.titleRow}>
                <Text numberOfLines={1} style={s.title}>{display.title}</Text>
                {display.roomLabel && (
                  <View style={s.roomBadge}>
                    <Text style={s.roomBadgeText}>{display.roomLabel}</Text>
                  </View>
                )}
                <View style={[s.statusBadge, optimistic.on && !unavailable && s.statusBadgeOn]}>
                  <View style={[s.statusDot, { backgroundColor: statusColor }]} />
                  <Text style={[s.statusBadgeText, { color: statusColor }]}>{statusText}</Text>
                </View>
              </View>
              <Text numberOfLines={1} style={s.subtitle}>
                {target.device_name ? `${target.device_name} · ` : ""}更新于 {formatClock(state?.last_updated)}
              </Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="关闭设备详情"
              hitSlop={8}
              style={s.closeButton}
              onPress={onClose}
            >
              <LooiIcon name="close" size={18} color={P.textSecondary} />
              <Text style={s.closeText}>关闭</Text>
            </Pressable>
          </View>

          <ScrollView
            scrollEnabled={!sliderDragging}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={[s.body, shortLandscape && s.shortBody]}
            showsVerticalScrollIndicator={false}
          >
            {/* Primary Power / Sensor Hero Section */}
            {controllable && device ? (
              <View style={[s.powerCard, optimistic.on && !unavailable && s.powerCardOn]}>
                <View style={s.powerCopy}>
                  <Text style={s.sectionTitle}>主电源控制</Text>
                  <Text style={s.powerDesc}>
                    {unavailable
                      ? "当前无法与该设备通信，请检查网关或电源连接"
                      : optimistic.on
                        ? `当前处于开启状态${hasBrightness ? ` · 亮度 ${Math.round((optimistic.brightness / 255) * 100)}%` : ""}${optimistic.kelvin ? ` · 色温 ${optimistic.kelvin}K` : ""}`
                        : "当前已关闭 · 轻触开关或直接选择下方参数即可立即开启"}
                  </Text>
                </View>
                <View style={s.powerActions}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={optimistic.on ? `立即关闭${display.title}` : `立即开启${display.title}`}
                    disabled={unavailable}
                    style={[s.quickPowerBtn, optimistic.on && s.quickPowerBtnOn, unavailable && s.disabled]}
                    onPress={() => onExecute(device, !optimistic.on)}
                  >
                    <Text style={[s.quickPowerText, optimistic.on && s.quickPowerTextOn]}>
                      {optimistic.on ? "关闭电源" : "立即开启"}
                    </Text>
                  </Pressable>
                  <ToggleSwitch
                    value={optimistic.on}
                    disabled={unavailable}
                    label={`${display.title}主开关`}
                    onValueChange={(nextOn) => onExecute(device, nextOn)}
                  />
                </View>
              </View>
            ) : (
              <View style={s.sensorHeroCard}>
                <View>
                  <Text style={s.sectionTitle}>{isSensor ? "传感器实时读数" : "设备当前状态"}</Text>
                  <Text style={s.powerDesc}>该实体为只读状态通道，展示来自物理设备的实测上报值</Text>
                </View>
                <View style={s.sensorHeroValueBox}>
                  <Text style={s.sensorHeroValue}>{sensorInfo.valueText}</Text>
                  {!!sensorInfo.unitText && <Text style={s.sensorHeroUnit}>{sensorInfo.unitText}</Text>}
                </View>
              </View>
            )}

            {/* Quick Lighting Scenes */}
            {device && scenes.length > 0 && (
              <View style={s.sectionCard}>
                <View style={s.sectionHeader}>
                  <Text style={s.sectionTitle}>快捷光效场景</Text>
                  <Text style={s.sectionHint}>点按即刻切换亮度与色温组合</Text>
                </View>
                <View style={s.sceneGrid}>
                  {scenes.map((scene) => {
                    const active =
                      optimistic.on &&
                      Math.abs(optimistic.brightness - scene.brightness) <= 15 &&
                      (scene.kelvin === undefined ||
                        (optimistic.kelvin !== undefined && Math.abs(optimistic.kelvin - scene.kelvin) <= 300));
                    return (
                      <Pressable
                        key={scene.id}
                        accessibilityRole="button"
                        accessibilityLabel={`${display.title}场景 ${scene.label}`}
                        accessibilityState={{ selected: active, disabled: unavailable }}
                        disabled={unavailable}
                        style={[s.sceneChip, active && s.sceneChipActive, unavailable && s.disabled]}
                        onPress={() => onExecute(device, true, scene.brightness, scene.kelvin)}
                      >
                        <View style={s.sceneChipTop}>
                          <View style={[s.tempDot, { backgroundColor: scene.color }]} />
                          <Text style={[s.sceneLabel, active && s.sceneLabelActive]}>{scene.label}</Text>
                        </View>
                        <Text style={s.sceneDesc}>{scene.desc}</Text>
                      </Pressable>
                    );
                  })}
                </View>
              </View>
            )}

            {/* Fine Brightness Control */}
            {device && hasBrightness && (
              <View style={s.sectionCard}>
                <View style={s.sectionHeader}>
                  <Text style={s.sectionTitle}>精细亮度调节</Text>
                  <View style={s.stepperRow}>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="亮度减 10%"
                      disabled={unavailable}
                      style={[s.stepperBtn, unavailable && s.disabled]}
                      onPress={() => onExecute(device, true, Math.max(1, optimistic.brightness - 26))}
                    >
                      <Text style={s.stepperText}>-10%</Text>
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="亮度加 10%"
                      disabled={unavailable}
                      style={[s.stepperBtn, unavailable && s.disabled]}
                      onPress={() => onExecute(device, true, Math.min(255, optimistic.brightness + 26))}
                    >
                      <Text style={s.stepperText}>+10%</Text>
                    </Pressable>
                  </View>
                </View>
                <BrightnessSliderBar
                  label={`${display.title}精细亮度`}
                  value={optimistic.brightness}
                  inactive={!optimistic.on}
                  disabled={unavailable}
                  onDragStateChange={setSliderDragging}
                  onChange={(value) => onExecute(device, true, value)}
                />
              </View>
            )}

            {/* Fine Color Temperature Control */}
            {device && kelvinRange && kelvinPresets.length > 0 && (
              <View style={s.sectionCard}>
                <View style={s.sectionHeader}>
                  <View>
                    <Text style={s.sectionTitle}>色温冷暖调节</Text>
                    <Text style={s.sectionHint}>
                      当前 {optimistic.kelvin ? `${optimistic.kelvin}K` : "默认色温"} · 支持范围 {kelvinRange[0]}K – {kelvinRange[1]}K
                    </Text>
                  </View>
                  <View style={s.stepperRow}>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="色温调暖 200K"
                      disabled={unavailable}
                      style={[s.stepperBtn, unavailable && s.disabled]}
                      onPress={() => {
                        const base = optimistic.kelvin ?? Math.round((kelvinRange[0] + kelvinRange[1]) / 2);
                        onExecute(device, true, undefined, Math.max(kelvinRange[0], base - 200));
                      }}
                    >
                      <Text style={s.stepperText}>-200K 暖</Text>
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="色温调冷 200K"
                      disabled={unavailable}
                      style={[s.stepperBtn, unavailable && s.disabled]}
                      onPress={() => {
                        const base = optimistic.kelvin ?? Math.round((kelvinRange[0] + kelvinRange[1]) / 2);
                        onExecute(device, true, undefined, Math.min(kelvinRange[1], base + 200));
                      }}
                    >
                      <Text style={s.stepperText}>+200K 冷</Text>
                    </Pressable>
                  </View>
                </View>
                <View style={s.kelvinGrid}>
                  {kelvinPresets.map((preset) => {
                    const active = optimistic.on && isKelvinPresetActive(optimistic.kelvin, preset.kelvin, kelvinPresets);
                    return (
                      <Pressable
                        key={preset.kelvin}
                        accessibilityRole="button"
                        accessibilityLabel={`${display.title}色温 ${preset.kelvin}K ${preset.label}`}
                        accessibilityState={{ selected: active, disabled: unavailable }}
                        disabled={unavailable}
                        style={[s.kelvinChip, active && s.kelvinChipActive, unavailable && s.disabled]}
                        onPress={() => onExecute(device, true, undefined, preset.kelvin)}
                      >
                        <View style={[s.tempDot, { backgroundColor: preset.color }]} />
                        <View>
                          <Text style={[s.kelvinValue, active && s.kelvinValueActive]}>{preset.kelvin}K</Text>
                          <Text style={s.kelvinDesc}>{preset.shortLabel}</Text>
                        </View>
                      </Pressable>
                    );
                  })}
                </View>
              </View>
            )}

            {/* Sibling Entities on the Same Appliance */}
            {(siblingControls.length > 0 || siblingReadOnly.length > 0) && (
              <View style={s.sectionCard}>
                <View style={s.sectionHeader}>
                  <Text style={s.sectionTitle}>同设备关联状态与通道 ({siblingControls.length + siblingReadOnly.length})</Text>
                </View>
                <View style={s.siblingList}>
                  {siblingControls.map((sibling) => {
                    const sibDisplay = formatDeviceDisplay(sibling);
                    const sibOpt = resolveOptimistic(sibling);
                    const sibSensor = ["sensor", "binary_sensor"].includes(sibling.domain);
                    const sibReading = formatSensorReading(sibling.snapshot, healthy);
                    const sibUnavailable = !healthy || !sibling.snapshot || ["unavailable", "unknown"].includes(sibling.snapshot.state);
                    const sibCanToggle = sibling.is_whitelisted && sibling.supported_features.includes("turn_on");
                    return (
                      <View key={sibling.entity_id} style={s.siblingItem}>
                        <LooiIcon name={sibDisplay.icon} size={16} color={sibOpt.on ? P.presenceCyan : P.textSecondary} />
                        <Text numberOfLines={1} style={s.siblingName}>{sibDisplay.title}</Text>
                        {sibSensor ? (
                          <Text style={s.siblingReading}>
                            {sibReading.valueText}{sibReading.unitText ? ` ${sibReading.unitText}` : ""}
                          </Text>
                        ) : sibCanToggle ? (
                          <ToggleSwitch
                            compact
                            value={sibOpt.on}
                            disabled={sibUnavailable}
                            label={`${sibDisplay.title}开关`}
                            onValueChange={(nextOn) => onExecute(sibling, nextOn)}
                          />
                        ) : (
                          <Text style={s.siblingReading}>{sibReading.valueText}</Text>
                        )}
                      </View>
                    );
                  })}
                  {siblingReadOnly.map((sibling) => {
                    const sibDisplay = formatDeviceDisplay(sibling);
                    const sibReading = formatSensorReading(sibling.snapshot, healthy);
                    return (
                      <View key={sibling.entity_id} style={s.siblingItem}>
                        <LooiIcon name="sensor" size={16} color={P.textSecondary} />
                        <Text numberOfLines={1} style={s.siblingName}>{sibDisplay.title}</Text>
                        <Text style={s.siblingReading}>{sibReading.valueText}</Text>
                      </View>
                    );
                  })}
                </View>
              </View>
            )}

            {/* Metadata Footer */}
            <View style={s.metaRow}>
              <View style={s.metaPill}>
                <Text style={s.metaLabel}>房间</Text>
                <Text style={s.metaValue}>{display.roomLabel ?? "未分配"}</Text>
              </View>
              <View style={s.metaPill}>
                <Text style={s.metaLabel}>类型</Text>
                <Text style={s.metaValue}>
                  {device?.domain === "light"
                    ? "智能灯具"
                    : device?.domain === "fan"
                      ? "风扇 / 新风"
                      : device?.domain === "switch"
                        ? "电源开关"
                        : isSensor
                          ? "环境传感器"
                          : "只读设备"}
                </Text>
              </View>
              <View style={[s.metaPill, s.metaPillWide]}>
                <Text style={s.metaLabel}>实体标识</Text>
                <Text numberOfLines={1} style={s.metaValue}>{target.entity_id}</Text>
              </View>
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(3, 7, 13, 0.72)",
    justifyContent: "center",
    alignItems: "center",
    padding: 14,
  },
  sheet: {
    width: "100%",
    maxWidth: 740,
    maxHeight: "92%",
    borderRadius: 24,
    borderWidth: 1,
    borderColor: P.lineSubtle,
    backgroundColor: "rgba(9, 20, 34, 0.96)",
    overflow: "hidden",
    boxShadow: "0 16px 38px rgba(0, 0, 0, 0.55)",
  },
  shortSheet: {
    maxHeight: "96%",
    borderRadius: 20,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(84, 167, 255, 0.16)",
    backgroundColor: "rgba(14, 28, 46, 0.75)",
  },
  iconBox: {
    width: 42,
    height: 42,
    borderRadius: 13,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(10, 22, 36, 0.85)",
    borderWidth: 1,
    borderColor: "rgba(84, 167, 255, 0.2)",
  },
  iconBoxOn: {
    borderColor: "rgba(40, 213, 255, 0.5)",
    backgroundColor: "rgba(40, 213, 255, 0.14)",
    boxShadow: "0 0 14px rgba(40, 213, 255, 0.25)",
  },
  headerCopy: {
    flex: 1,
    minWidth: 0,
    gap: 3,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 8,
  },
  title: {
    color: P.textPrimary,
    fontSize: 17,
    fontWeight: "700",
    flexShrink: 1,
  },
  roomBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 7,
    backgroundColor: "rgba(84, 167, 255, 0.12)",
    borderWidth: 1,
    borderColor: "rgba(84, 167, 255, 0.24)",
  },
  roomBadgeText: {
    color: P.textSecondary,
    fontSize: 11,
    fontWeight: "600",
  },
  statusBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 8,
    backgroundColor: "rgba(15, 28, 42, 0.8)",
    borderWidth: 1,
    borderColor: "rgba(148, 163, 184, 0.2)",
  },
  statusBadgeOn: {
    borderColor: "rgba(74, 222, 128, 0.35)",
    backgroundColor: "rgba(74, 222, 128, 0.1)",
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  statusBadgeText: {
    fontSize: 11,
    fontWeight: "600",
  },
  subtitle: {
    color: P.textSecondary,
    fontSize: 12,
  },
  closeButton: {
    minHeight: 40,
    paddingHorizontal: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "rgba(148, 163, 184, 0.22)",
    backgroundColor: "rgba(15, 28, 44, 0.75)",
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  closeText: {
    color: P.textSecondary,
    fontSize: 13,
    fontWeight: "600",
  },
  body: {
    padding: 16,
    gap: 12,
  },
  shortBody: {
    padding: 12,
    gap: 10,
  },
  powerCard: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    padding: 14,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: P.lineSubtle,
    backgroundColor: "rgba(14, 28, 44, 0.68)",
  },
  powerCardOn: {
    borderColor: "rgba(40, 213, 255, 0.38)",
    experimental_backgroundImage:
      "linear-gradient(135deg, rgba(36, 98, 132, 0.26) 0%, rgba(10, 24, 40, 0.88) 100%)",
  },
  powerCopy: {
    flex: 1,
    gap: 4,
  },
  powerDesc: {
    color: P.textSecondary,
    fontSize: 12,
    lineHeight: 17,
  },
  powerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  quickPowerBtn: {
    minHeight: 40,
    paddingHorizontal: 14,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: "rgba(40, 213, 255, 0.35)",
    backgroundColor: "rgba(40, 213, 255, 0.12)",
    justifyContent: "center",
    alignItems: "center",
  },
  quickPowerBtnOn: {
    borderColor: "rgba(148, 163, 184, 0.28)",
    backgroundColor: "rgba(15, 28, 44, 0.75)",
  },
  quickPowerText: {
    color: P.presenceCyan,
    fontSize: 13,
    fontWeight: "600",
  },
  quickPowerTextOn: {
    color: P.textSecondary,
  },
  sensorHeroCard: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    padding: 14,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "rgba(40, 213, 255, 0.25)",
    backgroundColor: "rgba(12, 26, 42, 0.75)",
  },
  sensorHeroValueBox: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: 4,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 12,
    backgroundColor: "rgba(8, 18, 30, 0.85)",
    borderWidth: 1,
    borderColor: "rgba(40, 213, 255, 0.22)",
  },
  sensorHeroValue: {
    color: P.presenceCyan,
    fontSize: 24,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  sensorHeroUnit: {
    color: P.textSecondary,
    fontSize: 13,
    fontWeight: "600",
  },
  sectionCard: {
    padding: 14,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "rgba(84, 167, 255, 0.16)",
    backgroundColor: "rgba(12, 24, 38, 0.68)",
    gap: 10,
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: 8,
  },
  sectionTitle: {
    color: P.textPrimary,
    fontSize: 14,
    fontWeight: "700",
  },
  sectionHint: {
    color: P.textSecondary,
    fontSize: 11.5,
  },
  sceneGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  sceneChip: {
    flexBasis: "23%",
    flexGrow: 1,
    minWidth: 130,
    minHeight: 54,
    paddingHorizontal: 11,
    paddingVertical: 8,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "rgba(122, 170, 191, 0.18)",
    backgroundColor: "rgba(9, 20, 32, 0.82)",
    justifyContent: "center",
    gap: 4,
  },
  sceneChipActive: {
    borderColor: P.presenceCyan,
    backgroundColor: "rgba(40, 213, 255, 0.15)",
  },
  sceneChipTop: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  sceneLabel: {
    color: P.textPrimary,
    fontSize: 13,
    fontWeight: "600",
  },
  sceneLabelActive: {
    color: P.presenceCyan,
    fontWeight: "700",
  },
  sceneDesc: {
    color: P.textSecondary,
    fontSize: 11,
  },
  stepperRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  stepperBtn: {
    minHeight: 34,
    paddingHorizontal: 10,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: "rgba(84, 167, 255, 0.24)",
    backgroundColor: "rgba(15, 32, 50, 0.8)",
    justifyContent: "center",
    alignItems: "center",
  },
  stepperText: {
    color: P.presenceCyan,
    fontSize: 12,
    fontWeight: "600",
  },
  kelvinGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  kelvinChip: {
    flex: 1,
    minWidth: 105,
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: "rgba(122, 170, 191, 0.18)",
    backgroundColor: "rgba(9, 20, 32, 0.82)",
  },
  kelvinChipActive: {
    borderColor: P.presenceCyan,
    backgroundColor: "rgba(40, 213, 255, 0.15)",
  },
  tempDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  kelvinValue: {
    color: P.textPrimary,
    fontSize: 12.5,
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
  },
  kelvinValueActive: {
    color: P.presenceCyan,
    fontWeight: "700",
  },
  kelvinDesc: {
    color: P.textSecondary,
    fontSize: 10.5,
  },
  siblingList: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  siblingItem: {
    flexBasis: "48%",
    flexGrow: 1,
    minWidth: 200,
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: "rgba(84, 167, 255, 0.14)",
    backgroundColor: "rgba(8, 18, 30, 0.78)",
  },
  siblingName: {
    flex: 1,
    color: P.textPrimary,
    fontSize: 12.5,
    fontWeight: "500",
  },
  siblingReading: {
    color: P.presenceCyan,
    fontSize: 13,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  metaRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  metaPill: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: "rgba(84, 167, 255, 0.12)",
    backgroundColor: "rgba(8, 18, 28, 0.65)",
    gap: 2,
  },
  metaPillWide: {
    flex: 1,
    minWidth: 180,
  },
  metaLabel: {
    color: P.textMuted,
    fontSize: 10.5,
  },
  metaValue: {
    color: P.textSecondary,
    fontSize: 12,
    fontWeight: "600",
  },
  disabled: {
    opacity: 0.45,
  },
});
