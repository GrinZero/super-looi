import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import {
  ActivityIndicator,
  AppState,
  Linking,
  Pressable as NativePressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
  type PressableProps,
} from "react-native";
import type { CabinSpaceController } from "../cabin-space.js";
import { LOOI_PALETTE as P } from "../theme.js";
import { LooiIcon } from "../components/LooiIcon.js";
import { ToggleSwitch } from "../components/ToggleSwitch.js";
import { BrightnessSliderBar } from "../components/BrightnessSliderBar.js";
import { HomeControlInteraction, mergeHomeSnapshots, resolveOptimisticHomeState } from "../home-control-interaction.js";
import type { HomeClient } from "../../runtime/local-control-center.js";
import {
  HomeDeviceDetailModal,
  buildKelvinPresets,
  formatDeviceDisplay,
  formatSensorReading,
  isKelvinPresetActive,
  type ConnectedDevice,
  type ReadOnlyDevice,
} from "./HomeDeviceDetailModal.js";

interface Connection {
  configured: boolean;
  healthy: boolean;
  lastVerifiedAt: string | null;
  deviceCount?: number;
  label?: string;
  entities: ConnectedDevice[];
  readOnlyEntities: ReadOnlyDevice[];
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

async function fetchJson<T>(url: string, init: RequestInit = {}, timeoutMs = 12000): Promise<T> {
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: abort.signal });
    if (!response.ok) throw new Error("无法读取家居服务");
    return (await response.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}

export interface ConnectedHomeSpaceViewProps {
  hubOrigin: string;
  client?: HomeClient;
  controller: CabinSpaceController;
  onNotify?: (message: string) => void;
  modeSubtitle?: string;
  onOpenSettings?: () => void;
}

export function ConnectedHomeSpaceView({
  hubOrigin,
  controller,
  client,
  modeSubtitle,
  onOpenSettings,
}: ConnectedHomeSpaceViewProps): ReactElement {
  const [connection, setConnection] = useState<Connection | null>(null);
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [category, setCategory] = useState<"controls" | "sensors" | "all">("controls");
  const [selectedRoom, setSelectedRoom] = useState<string>("all");
  const [selectedEntityId, setSelectedEntityId] = useState<string | null>(null);
  const [limit, setLimit] = useState(40);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [, renderFeedback] = useState(0);
  const live = useRef(true);
  const scrollRef = useRef<ScrollView>(null);
  const refreshLatest = useRef<(() => Promise<void>) | null>(null);
  const { width, height, fontScale } = useWindowDimensions();
  const short = width >= 700 && height < 480 && fontScale < 1.3;
  const compact = width < 660;
  const origin = hubOrigin.replace(/\/+$/, "");

  const interaction = useMemo(
    () =>
      new HomeControlInteraction({
        execute: (command) =>
          client
            ? client.execute(command)
            : fetchJson(
                `${origin}/api/home/execute`,
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(command),
                },
                20000,
              ),
        changed: () => renderFeedback((version) => version + 1),
        observed: (entityId, snapshot) =>
          setConnection((value) =>
            value
              ? {
                  ...value,
                  entities: value.entities.map((entity) =>
                    entity.entity_id === entityId ? { ...entity, snapshot } : entity,
                  ),
                }
              : value,
          ),
        settled: () => {
          // Optimistic state keeps the card steady while background sync reconciles silently.
          void refreshLatest.current?.();
        },
      }),
    [client, origin],
  );

  useEffect(() => {
    interaction.activate();
    return () => interaction.dispose();
  }, [interaction]);

  const refreshing = useMemo<{ current: Promise<void> | null }>(() => ({ current: null }), [interaction]);
  const refresh = useCallback(async () => {
    if (refreshing.current) return refreshing.current;
    setIsRefreshing(true);
    const task = (async () => {
      // A poll started before a control must not overwrite its newer receipt/target.
      while (live.current && interaction.isActive) {
        const requestGeneration = interaction.revision;
        try {
          const data = client ? await client.getConnection() : await fetchJson<Connection>(`${origin}/api/home/connection`);
          if (!live.current || !interaction.isActive) return;
          if (interaction.revision !== requestGeneration) continue;
          interaction.reconcile(data.entities);
          setConnection((previous) => ({
            ...data,
            entities: mergeHomeSnapshots(previous?.entities ?? [], data.entities),
          }));
          setError(null);
          controller.updateSubsystemStatus(
            "homeAssistant",
            data.healthy ? "connected" : "disconnected",
            data.lastVerifiedAt ?? undefined,
          );
        } catch {
          if (!live.current || !interaction.isActive) return;
          if (interaction.revision !== requestGeneration) continue;
          setError("暂时连不上家居服务，请检查连接设置与网络。");
          setConnection((value) => (value ? { ...value, healthy: false } : null));
          controller.updateSubsystemStatus("homeAssistant", "disconnected");
        } finally {
          if (live.current && interaction.isActive) {
            setLoading(false);
            setIsRefreshing(false);
          }
        }
        return;
      }
    })();
    refreshing.current = task;
    try {
      await task;
    } finally {
      if (refreshing.current === task) refreshing.current = null;
    }
  }, [origin, controller, client, interaction, refreshing]);

  useEffect(() => {
    refreshLatest.current = refresh;
  }, [refresh]);

  useEffect(() => {
    live.current = true;
    void refresh();
    const timer = setInterval(() => {
      if (AppState.currentState === "active") void refresh();
    }, 10000);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void refresh();
    });
    return () => {
      live.current = false;
      clearInterval(timer);
      subscription.remove();
    };
  }, [refresh]);

  const execute = useCallback(
    (device: ConnectedDevice, on: boolean, brightness?: number, kelvin?: number) => {
      const data = {
        ...(brightness === undefined ? {} : { brightness }),
        ...(kelvin === undefined ? {} : { color_temp_kelvin: kelvin }),
      };
      interaction.request({
        entity_id: device.entity_id,
        domain: device.domain,
        service: on ? "turn_on" : "turn_off",
        service_data: client?.normalizeServiceData?.(device.entity_id, data) ?? data,
      });
    },
    [client, interaction],
  );

  const resolveOptimistic = (device: ConnectedDevice) =>
    resolveOptimisticHomeState(device.snapshot, interaction.get(device.entity_id));

  // Extract distinct rooms for quick room filtering
  const rooms = useMemo(() => {
    if (!connection) return [];
    const set = new Set<string>();
    for (const ent of connection.entities) {
      const r = ent.room?.trim();
      if (r) set.add(r);
    }
    for (const ent of connection.readOnlyEntities) {
      const r = ent.room?.trim();
      if (r) set.add(r);
    }
    return [...set].sort((a, b) => a.localeCompare(b, "zh"));
  }, [connection]);

  useEffect(() => {
    if (selectedRoom !== "all" && !rooms.includes(selectedRoom)) {
      setSelectedRoom("all");
    }
  }, [rooms, selectedRoom]);

  const trimmedQuery = query.trim().toLowerCase();
  const matchesQueryAndRoom = (device: { friendly_name: string; entity_id: string; device_name?: string; room?: string }) => {
    if (selectedRoom !== "all" && (device.room?.trim() ?? "") !== selectedRoom) return false;
    if (!trimmedQuery) return true;
    return `${device.friendly_name} ${device.device_name ?? ""} ${device.room ?? ""} ${device.entity_id}`
      .toLowerCase()
      .includes(trimmedQuery);
  };

  const isControlEntity = (device: ConnectedDevice) =>
    !device.entity_category && device.supported_features.includes("turn_on");
  const isSensorEntity = (device: ConnectedDevice) =>
    !device.entity_category && ["sensor", "binary_sensor"].includes(device.domain);

  const controlCount = useMemo(
    () => connection?.entities.filter((d) => matchesQueryAndRoom(d) && isControlEntity(d)).length ?? 0,
    [connection, selectedRoom, trimmedQuery],
  );
  const sensorCount = useMemo(
    () => connection?.entities.filter((d) => matchesQueryAndRoom(d) && isSensorEntity(d)).length ?? 0,
    [connection, selectedRoom, trimmedQuery],
  );
  const allCount = useMemo(
    () =>
      (connection?.entities.filter(matchesQueryAndRoom).length ?? 0) +
      (connection?.readOnlyEntities.filter(matchesQueryAndRoom).length ?? 0),
    [connection, selectedRoom, trimmedQuery],
  );

  // Automatically fall back to "all" or "sensors" if "controls" is empty on initial load
  const effectiveCategory =
    trimmedQuery
      ? "all"
      : category === "controls" && controlCount === 0 && sensorCount > 0
        ? "sensors"
        : category;

  const rank = (domain: string) => ["light", "fan", "switch", "binary_sensor", "sensor"].indexOf(domain);
  const matchingDevices =
    connection?.entities
      .filter(
        (device) =>
          matchesQueryAndRoom(device) &&
          (effectiveCategory === "all" ||
            (effectiveCategory === "controls" ? isControlEntity(device) : isSensorEntity(device))),
      )
      .sort((a, b) => rank(a.domain) - rank(b.domain) || a.friendly_name.localeCompare(b.friendly_name, "zh")) ?? [];

  const matchingReadOnly = effectiveCategory === "all" ? connection?.readOnlyEntities.filter(matchesQueryAndRoom) ?? [] : [];
  const devices = matchingDevices.slice(0, limit);
  const readOnly = matchingReadOnly.slice(0, Math.max(0, limit - devices.length));
  const matchCount = matchingDevices.length + matchingReadOnly.length;
  const healthy = connection?.healthy === true && !error;
  const total = (connection?.entities.length ?? 0) + (connection?.readOnlyEntities.length ?? 0);

  const selectedDevice = useMemo(
    () => (selectedEntityId ? connection?.entities.find((item) => item.entity_id === selectedEntityId) ?? null : null),
    [connection, selectedEntityId],
  );
  const selectedReadOnly = useMemo(
    () =>
      selectedEntityId && !selectedDevice
        ? connection?.readOnlyEntities.find((item) => item.entity_id === selectedEntityId) ?? null
        : null,
    [connection, selectedDevice, selectedEntityId],
  );
  const selectedOptimistic = selectedDevice
    ? resolveOptimistic(selectedDevice)
    : { on: false, brightness: 128, kelvin: undefined, syncing: false, rejected: false };

  return (
    <View style={s.root}>
      <ScrollView
        ref={scrollRef}
        scrollEnabled={!dragging}
        style={s.root}
        contentContainerStyle={[s.content, short && s.shortContent]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/* Unified Compact Bento Top Bar */}
        <View style={[s.topBar, short && s.shortTopBar]}>
          <View style={s.statusLeft}>
            <View style={[s.dot, { backgroundColor: healthy ? P.confirmGreen : P.amberWarning }]} />
            <Text numberOfLines={1} style={s.heading}>
              {healthy
                ? `${connection?.label ?? "米家"} · ${connection?.deviceCount ? `${connection.deviceCount} 台设备` : `${total} 项状态`}`
                : `${connection?.label ?? "家居"} · 等待连接`}
            </Text>
            {!!modeSubtitle && (
              <View style={s.modeBadge}>
                <Text numberOfLines={1} style={s.modeBadgeText}>{modeSubtitle}</Text>
              </View>
            )}
          </View>

          {total > 0 && (
            <View style={s.filters}>
              {(
                [
                  { id: "controls", label: "设备控制", shortLabel: "控制", count: controlCount },
                  { id: "sensors", label: "传感器", shortLabel: "传感器", count: sensorCount },
                  { id: "all", label: "全部功能", shortLabel: "全部", count: allCount },
                ] as const
              ).map((item) => {
                const active = effectiveCategory === item.id;
                return (
                  <Pressable
                    key={item.id}
                    accessibilityRole="button"
                    accessibilityLabel={item.label}
                    accessibilityState={{ selected: active }}
                    style={[s.filter, short && s.shortFilter, active && s.filterOn]}
                    onPress={() => {
                      setCategory(item.id);
                      setLimit(40);
                      scrollRef.current?.scrollTo({ y: 0, animated: true });
                    }}
                  >
                    <Text style={[s.filterText, active && s.filterTextOn]}>
                      {short ? item.shortLabel : item.label}
                      {item.count > 0 ? ` ${item.count}` : ""}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          )}

          <View style={s.topRightActions}>
            {total > 0 && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={searchOpen || query ? "收起设备搜索" : "搜索家居设备"}
                style={[s.iconActionBtn, (searchOpen || !!query) && s.iconActionBtnActive]}
                onPress={() => {
                  if (searchOpen && query) {
                    setQuery("");
                  } else {
                    setSearchOpen((prev) => !prev);
                  }
                }}
              >
                <LooiIcon name="radar" size={14} color={searchOpen || query ? P.presenceCyan : P.textSecondary} />
                <Text style={[s.topBtnText, (searchOpen || !!query) && s.topBtnTextActive]}>搜索</Text>
              </Pressable>
            )}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="刷新家居设备"
              disabled={isRefreshing}
              style={[s.iconActionBtn, isRefreshing && s.disabled]}
              onPress={() => void refresh()}
            >
              <Text style={s.topBtnText}>{isRefreshing ? "同步中" : "刷新"}</Text>
            </Pressable>
            {onOpenSettings && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="家居与本机设置"
                style={s.settingsBtn}
                onPress={onOpenSettings}
              >
                <LooiIcon name="wrench" size={13} color={P.presenceCyan} />
                <Text style={s.settingsBtnText}>连接设置</Text>
              </Pressable>
            )}
          </View>
        </View>

        {/* Expandable Search & Room Chips Bar */}
        {(searchOpen || !!query || rooms.length > 1) && total > 0 && (
          <View style={s.subToolbar}>
            {(searchOpen || !!query) && (
              <View style={s.searchBox}>
                <LooiIcon name="radar" size={14} color={P.textMuted} />
                <TextInput
                  value={query}
                  onChangeText={(value) => {
                    setQuery(value);
                    setLimit(40);
                  }}
                  style={s.searchInput}
                  placeholder="搜索设备名称、房间或标识"
                  placeholderTextColor={P.textMuted}
                  accessibilityLabel="搜索家居设备"
                />
                {!!query && (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="清空搜索关键词"
                    hitSlop={8}
                    style={s.clearSearchBtn}
                    onPress={() => setQuery("")}
                  >
                    <LooiIcon name="close" size={14} color={P.textSecondary} />
                  </Pressable>
                )}
              </View>
            )}
            {rooms.length > 1 && (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={s.roomStrip}
                style={s.roomScroll}
              >
                {["all", ...rooms].map((room) => {
                  const active = selectedRoom === room;
                  return (
                    <Pressable
                      key={room}
                      accessibilityRole="button"
                      accessibilityLabel={room === "all" ? "全部房间" : `筛选房间 ${room}`}
                      accessibilityState={{ selected: active }}
                      style={[s.roomChip, active && s.roomChipActive]}
                      onPress={() => {
                        setSelectedRoom(room);
                        setLimit(40);
                      }}
                    >
                      <Text style={[s.roomChipText, active && s.roomChipTextActive]}>
                        {room === "all" ? "全部房间" : room}
                      </Text>
                    </Pressable>
                  );
                })}
              </ScrollView>
            )}
          </View>
        )}

        {loading && (
          <View style={s.loadingBox}>
            <ActivityIndicator color={P.presenceCyan} accessibilityLabel="正在读取设备" />
          </View>
        )}

        {!loading && (!healthy || total === 0) && (
          <View style={s.empty}>
            <LooiIcon name="gateway" size={30} color={P.presenceCyan} />
            <Text style={s.emptyTitle}>{healthy ? "还没有导入设备" : "让 LOOI 认识你的家"}</Text>
            <Text style={s.description}>
              {error ??
                (connection?.configured
                  ? "暂时无法读取家居设备。请确认 Home Assistant 与米家连接正常，稍后刷新。"
                  : client
                    ? "点击右上角「连接设置」，登录米家、连接 Home Assistant 或启用离线演示。"
                    : "在主机上完成米家账号授权后，这里会自动出现真实设备。")}
            </Text>
            {onOpenSettings ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="打开连接设置"
                style={s.setupPrimary}
                onPress={onOpenSettings}
              >
                <Text style={s.setupPrimaryText}>打开连接设置</Text>
              </Pressable>
            ) : (
              !client && (
                <Pressable
                  accessibilityRole="link"
                  accessibilityLabel="查看米家连接方法"
                  style={s.setup}
                  onPress={() => void Linking.openURL(`${origin}/home-setup`)}
                >
                  <Text style={s.action}>查看连接方法</Text>
                </Pressable>
              )
            )}
          </View>
        )}

        {/* Bento Device Grid */}
        <View style={[s.grid, short && s.shortGrid]}>
          {devices.map((device) => {
            const state = device.snapshot;
            const optimistic = resolveOptimistic(device);
            const display = formatDeviceDisplay(device);
            const on = optimistic.on;
            const unavailable = !healthy || !state || ["unavailable", "unknown"].includes(state.state);
            const control = device.is_whitelisted && device.supported_features.includes("turn_on");
            const sensor = ["sensor", "binary_sensor"].includes(device.domain);
            const hasBrightness = control && device.supported_features.includes("brightness");
            const kelvinPresets = control ? buildKelvinPresets(device.allowed_range?.color_temp_kelvin, 3) : [];
            const sensorInfo = sensor ? formatSensorReading(state, healthy) : null;

            const statusLabel = unavailable
              ? "离线"
              : optimistic.rejected
                ? "未执行"
                : sensor
                  ? sensorInfo?.statusLabel ?? "实时采样"
                  : on
                    ? "已开启"
                    : "已关闭";

            const statusColor = unavailable
              ? P.amberWarning
              : optimistic.rejected
                ? P.alertCoral
                : sensor
                  ? P.presenceCyan
                  : on
                    ? P.confirmGreen
                    : P.textSecondary;

            return (
              <View
                key={device.entity_id}
                style={[
                  s.card,
                  compact && s.fullCard,
                  short && s.shortCard,
                  on && !unavailable && s.onCard,
                ]}
              >
                {/* Card Header: Left area opens Detail Sheet; Right Switch toggles power */}
                <View style={s.cardHead}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`${device.friendly_name}详情设置`}
                    accessibilityHint="打开设备精细调节与关联状态面板"
                    style={s.cardHeadMain}
                    onPress={() => setSelectedEntityId(device.entity_id)}
                  >
                    <View style={[s.deviceIconBox, on && !unavailable && s.deviceIconBoxOn]}>
                      <LooiIcon
                        name={display.icon}
                        color={on && !unavailable ? P.presenceCyan : P.textSecondary}
                        size={short ? 17 : 19}
                      />
                    </View>
                    <View style={s.titleGroup}>
                      <View style={s.nameRow}>
                        <Text numberOfLines={1} style={[s.name, short && s.shortName]}>
                          {display.title}
                        </Text>
                        {display.roomLabel && (
                          <View style={s.roomTag}>
                            <Text numberOfLines={1} style={s.roomTagText}>{display.roomLabel}</Text>
                          </View>
                        )}
                      </View>
                    </View>
                    <View style={[s.statusPill, on && !unavailable && s.statusPillOn]}>
                      <Text style={[s.statusPillText, { color: statusColor }]}>{statusLabel}</Text>
                      <Text style={s.detailChevron}>›</Text>
                    </View>
                  </Pressable>

                  {control && (
                    <ToggleSwitch
                      compact
                      value={on}
                      disabled={unavailable}
                      label={`${device.friendly_name}开关`}
                      onValueChange={(value) => execute(device, value)}
                    />
                  )}
                </View>

                {/* Sensor Card Body */}
                {sensor && sensorInfo && (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`查看${device.friendly_name}详情`}
                    style={s.sensorBody}
                    onPress={() => setSelectedEntityId(device.entity_id)}
                  >
                    <View style={s.sensorMetricPill}>
                      <Text style={s.reading}>{sensorInfo.valueText}</Text>
                      {!!sensorInfo.unitText && <Text style={s.readingUnit}>{sensorInfo.unitText}</Text>}
                    </View>
                    <Text numberOfLines={1} style={s.footerHint}>
                      点击查看关联设备与采样详情 ›
                    </Text>
                  </Pressable>
                )}

                {/* Light Brightness Slider */}
                {hasBrightness && (
                  <BrightnessSliderBar
                    compact
                    label={`${device.friendly_name}亮度`}
                    value={optimistic.brightness}
                    inactive={!on}
                    disabled={unavailable}
                    onDragStateChange={setDragging}
                    onChange={(value) => execute(device, true, value)}
                  />
                )}

                {/* Light Color Temperature Presets */}
                {kelvinPresets.length > 0 && (
                  <View style={[s.temperatures, short && s.shortTemperatures]}>
                    {kelvinPresets.map((preset) => {
                      const active = on && isKelvinPresetActive(optimistic.kelvin, preset.kelvin, kelvinPresets);
                      return (
                        <Pressable
                          key={preset.kelvin}
                          hitSlop={{ top: 4, bottom: 4 }}
                          accessibilityRole="button"
                          accessibilityLabel={`${device.friendly_name}色温 ${preset.kelvin}K`}
                          accessibilityState={{ selected: active, disabled: unavailable }}
                          disabled={unavailable}
                          style={[
                            s.temperature,
                            short && s.shortTemperature,
                            active && s.temperatureActive,
                            unavailable && s.disabled,
                          ]}
                          onPress={() => execute(device, true, undefined, preset.kelvin)}
                        >
                          <View style={[s.tempDot, { backgroundColor: preset.color }]} />
                          <Text style={[s.tempText, active && s.tempTextActive]}>{preset.kelvin}K</Text>
                        </Pressable>
                      );
                    })}
                  </View>
                )}

                {/* Light without Kelvin Footer (e.g. Desk Lamp) */}
                {control && device.domain === "light" && kelvinPresets.length === 0 && (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`打开${device.friendly_name}精细光效设置`}
                    style={s.deviceFooter}
                    onPress={() => setSelectedEntityId(device.entity_id)}
                  >
                    <View style={s.warmModeTag}>
                      <View style={[s.tempDot, { backgroundColor: "#FFF4E0" }]} />
                      <Text style={s.warmModeText}>柔和护眼调光</Text>
                    </View>
                    <Text numberOfLines={1} style={s.footerHint}>
                      光效场景与精细调节 ›
                    </Text>
                  </Pressable>
                )}

                {/* Fan / Switch Card Footer */}
                {control && device.domain !== "light" && (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`打开${device.friendly_name}更多设置`}
                    style={s.deviceFooter}
                    onPress={() => setSelectedEntityId(device.entity_id)}
                  >
                    <View
                      style={s.airflowArtwork}
                      accessibilityElementsHidden
                      importantForAccessibility="no-hide-descendants"
                    >
                      {[0, 1, 2].map((index) => (
                        <View
                          key={index}
                          style={[
                            s.airflowLine,
                            {
                              width: `${100 - index * 18}%`,
                              opacity: on && !unavailable ? 0.9 - index * 0.22 : 0.25,
                            },
                          ]}
                        />
                      ))}
                    </View>
                    <Text numberOfLines={1} style={s.footerHint}>
                      {on ? "运行中" : "待机中"} · 点击进入设备详情 ›
                    </Text>
                  </Pressable>
                )}
              </View>
            );
          })}

          {readOnly.map((device) => {
            const display = formatDeviceDisplay(device);
            const reading = formatSensorReading(device.snapshot, healthy);
            return (
              <Pressable
                key={device.entity_id}
                accessibilityRole="button"
                accessibilityLabel={`查看${device.friendly_name}状态详情`}
                style={[s.card, compact && s.fullCard, short && s.shortCard]}
                onPress={() => setSelectedEntityId(device.entity_id)}
              >
                <View style={s.cardHead}>
                  <View style={s.deviceIconBox}>
                    <LooiIcon name={display.icon} color={P.textSecondary} size={short ? 17 : 19} />
                  </View>
                  <View style={s.titleGroup}>
                    <View style={s.nameRow}>
                      <Text numberOfLines={1} style={[s.name, short && s.shortName]}>
                        {display.title}
                      </Text>
                      {display.roomLabel && (
                        <View style={s.roomTag}>
                          <Text numberOfLines={1} style={s.roomTagText}>{display.roomLabel}</Text>
                        </View>
                      )}
                    </View>
                  </View>
                  <View style={s.statusPill}>
                    <Text style={[s.statusPillText, { color: P.textSecondary }]}>只读</Text>
                    <Text style={s.detailChevron}>›</Text>
                  </View>
                </View>
                <View style={s.sensorBody}>
                  <View style={s.sensorMetricPill}>
                    <Text numberOfLines={1} style={s.reading}>{reading.valueText}</Text>
                    {!!reading.unitText && <Text style={s.readingUnit}>{reading.unitText}</Text>}
                  </View>
                  <Text numberOfLines={1} style={s.footerHint}>点击查看详情 ›</Text>
                </View>
              </Pressable>
            );
          })}
        </View>

        {total > 0 && devices.length + readOnly.length === 0 && (
          <View style={s.noMatchBox}>
            <Text style={s.description}>没有匹配的设备，请尝试切换分类或清空搜索条件</Text>
          </View>
        )}

        {matchCount > limit && (
          <Pressable
            accessibilityRole="button"
            style={s.loadMore}
            onPress={() => setLimit((value) => value + 40)}
          >
            <Text style={s.action}>继续显示 · 还有 {matchCount - limit} 项</Text>
          </Pressable>
        )}
      </ScrollView>

      {/* Device Detail Settings Modal */}
      <HomeDeviceDetailModal
        device={selectedDevice}
        readOnlyDevice={selectedReadOnly}
        optimistic={selectedOptimistic}
        healthy={healthy}
        allEntities={connection?.entities ?? []}
        allReadOnly={connection?.readOnlyEntities ?? []}
        resolveOptimistic={resolveOptimistic}
        onClose={() => setSelectedEntityId(null)}
        onExecute={execute}
      />
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: 12, paddingBottom: 24, gap: 10 },
  shortContent: { paddingHorizontal: 4, paddingTop: 2, paddingBottom: 12, gap: 7 },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    minHeight: 44,
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: P.lineSubtle,
    backgroundColor: P.surfaceGlass,
    gap: 8,
  },
  shortTopBar: {
    flexWrap: "nowrap",
    minHeight: 40,
    paddingHorizontal: 9,
    paddingVertical: 3,
    gap: 6,
    backgroundColor: "rgba(10, 22, 36, 0.72)",
  },
  statusLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flexShrink: 1,
    minWidth: 0,
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    boxShadow: "0 0 8px rgba(74, 222, 128, 0.55)",
  },
  heading: {
    color: P.textPrimary,
    fontSize: 12.5,
    fontWeight: "700",
    flexShrink: 1,
  },
  modeBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "rgba(84, 167, 255, 0.2)",
    backgroundColor: "rgba(14, 28, 44, 0.75)",
  },
  modeBadgeText: {
    color: P.textSecondary,
    fontSize: 10,
    fontWeight: "500",
  },
  filters: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  filter: {
    minHeight: 32,
    justifyContent: "center",
    paddingHorizontal: 10,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: "rgba(84, 167, 255, 0.16)",
    backgroundColor: "rgba(12, 24, 38, 0.65)",
  },
  shortFilter: {
    minHeight: 28,
    paddingHorizontal: 7,
  },
  filterOn: {
    backgroundColor: "rgba(40, 213, 255, 0.14)",
    borderColor: P.lineActive,
  },
  filterText: {
    color: P.textSecondary,
    fontSize: 11,
    fontWeight: "600",
  },
  filterTextOn: {
    color: P.presenceCyan,
    fontWeight: "700",
  },
  topRightActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  iconActionBtn: {
    minHeight: 30,
    paddingHorizontal: 8,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: "rgba(84, 167, 255, 0.18)",
    backgroundColor: P.surfaceElevated,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 3,
  },
  iconActionBtnActive: {
    borderColor: P.presenceCyan,
    backgroundColor: "rgba(40, 213, 255, 0.12)",
  },
  topBtnText: {
    color: P.textSecondary,
    fontSize: 11,
    fontWeight: "600",
  },
  topBtnTextActive: {
    color: P.presenceCyan,
  },
  settingsBtn: {
    minHeight: 30,
    paddingHorizontal: 9,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: "rgba(40, 213, 255, 0.35)",
    backgroundColor: "rgba(40, 213, 255, 0.1)",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
  },
  settingsBtnText: {
    color: P.presenceCyan,
    fontSize: 11,
    fontWeight: "700",
  },
  subToolbar: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 6,
  },
  searchBox: {
    flex: 1,
    minWidth: 200,
    minHeight: 36,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: P.lineSubtle,
    backgroundColor: P.surfaceGlass,
  },
  searchInput: {
    flex: 1,
    color: P.textPrimary,
    fontSize: 13,
    paddingVertical: 5,
  },
  clearSearchBtn: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(148, 163, 184, 0.16)",
  },
  roomScroll: {
    flexGrow: 0,
  },
  roomStrip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  roomChip: {
    minHeight: 28,
    paddingHorizontal: 10,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: "rgba(84, 167, 255, 0.16)",
    backgroundColor: "rgba(10, 22, 36, 0.72)",
    justifyContent: "center",
  },
  roomChipActive: {
    borderColor: P.presenceCyan,
    backgroundColor: "rgba(40, 213, 255, 0.14)",
  },
  roomChipText: {
    color: P.textSecondary,
    fontSize: 11,
    fontWeight: "500",
  },
  roomChipTextActive: {
    color: P.presenceCyan,
    fontWeight: "700",
  },
  loadingBox: {
    paddingVertical: 16,
    alignItems: "center",
  },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },
  shortGrid: {
    gap: 8,
  },
  card: {
    flexBasis: "48%",
    flexGrow: 1,
    minWidth: 240,
    gap: 6,
    padding: 12,
    borderWidth: 1,
    borderColor: P.lineSubtle,
    borderRadius: 16,
    backgroundColor: P.surfaceGlass,
  },
  fullCard: {
    flexBasis: "100%",
    minWidth: 0,
  },
  shortCard: {
    padding: 9,
    gap: 5,
    borderRadius: 15,
  },
  onCard: {
    borderColor: "rgba(40, 213, 255, 0.32)",
    experimental_backgroundImage:
      "linear-gradient(135deg, rgba(36, 98, 132, 0.22) 0%, rgba(7, 19, 32, 0.86) 62%, rgba(255, 179, 71, 0.05) 100%)",
    boxShadow: "inset 0 1px 16px 0 rgba(40,213,255,0.06), 0 6px 18px 0 rgba(0,0,0,0.18)",
  },
  cardHead: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 38,
    gap: 7,
  },
  cardHeadMain: {
    flex: 1,
    minWidth: 0,
    minHeight: 38,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  deviceIconBox: {
    width: 30,
    height: 30,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(12, 26, 42, 0.78)",
    borderWidth: 1,
    borderColor: "rgba(84, 167, 255, 0.16)",
  },
  deviceIconBoxOn: {
    borderColor: "rgba(40, 213, 255, 0.38)",
    backgroundColor: "rgba(40, 213, 255, 0.12)",
  },
  titleGroup: {
    flex: 1,
    minWidth: 0,
  },
  nameRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  name: {
    color: P.textPrimary,
    fontSize: 14,
    fontWeight: "700",
    flexShrink: 1,
  },
  shortName: {
    fontSize: 13,
  },
  roomTag: {
    paddingHorizontal: 6,
    paddingVertical: 1.5,
    borderRadius: 6,
    backgroundColor: "rgba(84, 167, 255, 0.1)",
    borderWidth: 1,
    borderColor: "rgba(84, 167, 255, 0.18)",
  },
  roomTagText: {
    color: P.textSecondary,
    fontSize: 10,
    fontWeight: "600",
  },
  statusPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    borderRadius: 8,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderWidth: 1,
    borderColor: "rgba(148, 163, 184, 0.16)",
    backgroundColor: "rgba(15, 28, 42, 0.68)",
  },
  statusPillOn: {
    borderColor: "rgba(74, 222, 128, 0.3)",
    backgroundColor: "rgba(74, 222, 128, 0.08)",
  },
  statusPillText: {
    fontSize: 10,
    fontWeight: "600",
  },
  detailChevron: {
    color: P.textMuted,
    fontSize: 12,
    fontWeight: "700",
    marginLeft: 1,
  },
  temperatures: {
    flexDirection: "row",
    gap: 7,
    minHeight: 36,
    paddingVertical: 2,
  },
  shortTemperatures: {
    minHeight: 34,
    gap: 6,
  },
  temperature: {
    flex: 1,
    minHeight: 34,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    paddingHorizontal: 6,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: P.lineSubtle,
    backgroundColor: "rgba(9, 21, 31, 0.8)",
  },
  shortTemperature: {
    minHeight: 32,
    borderRadius: 8,
  },
  temperatureActive: {
    borderColor: P.presenceCyan,
    backgroundColor: "rgba(40, 213, 255, 0.14)",
  },
  tempDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  tempText: {
    color: P.textSecondary,
    fontSize: 11,
    fontWeight: "500",
    fontVariant: ["tabular-nums"],
  },
  tempTextActive: {
    color: P.textPrimary,
    fontWeight: "700",
  },
  sensorBody: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "rgba(40, 213, 255, 0.16)",
    backgroundColor: "rgba(8, 20, 34, 0.68)",
  },
  sensorMetricPill: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: 4,
  },
  reading: {
    color: P.presenceCyan,
    fontSize: 16,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  readingUnit: {
    color: P.textSecondary,
    fontSize: 11,
    fontWeight: "600",
  },
  deviceFooter: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    minHeight: 34,
    paddingVertical: 5,
    paddingHorizontal: 10,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: "rgba(40, 213, 255, 0.14)",
    backgroundColor: "rgba(8, 20, 34, 0.65)",
  },
  warmModeTag: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  warmModeText: {
    color: "#FFF4E0",
    fontSize: 11,
    fontWeight: "600",
  },
  airflowArtwork: {
    width: 44,
    gap: 3.5,
  },
  airflowLine: {
    height: 2.5,
    borderRadius: 2,
    backgroundColor: P.presenceCyan,
    boxShadow: "0 0 6px rgba(40, 213, 255, 0.45)",
  },
  footerHint: {
    flexShrink: 1,
    color: P.textSecondary,
    fontSize: 10.5,
  },
  empty: {
    paddingVertical: 24,
    paddingHorizontal: 20,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: P.lineSubtle,
    backgroundColor: P.surfaceGlass,
    alignItems: "center",
    gap: 12,
  },
  emptyTitle: {
    color: P.textPrimary,
    fontSize: 19,
    fontWeight: "700",
  },
  description: {
    color: P.textSecondary,
    fontSize: 13,
    lineHeight: 20,
    textAlign: "center",
  },
  setup: {
    minHeight: 40,
    justifyContent: "center",
    paddingHorizontal: 18,
  },
  setupPrimary: {
    minHeight: 42,
    paddingHorizontal: 18,
    borderRadius: 12,
    backgroundColor: P.presenceCyanSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  setupPrimaryText: {
    color: P.bgPure,
    fontSize: 14,
    fontWeight: "700",
  },
  action: {
    color: P.presenceCyan,
    fontSize: 13,
    fontWeight: "600",
  },
  noMatchBox: {
    paddingVertical: 20,
    alignItems: "center",
  },
  loadMore: {
    minHeight: 42,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: P.lineSubtle,
    backgroundColor: P.surfaceGlass,
    alignItems: "center",
    justifyContent: "center",
  },
  disabled: {
    opacity: 0.45,
  },
});
