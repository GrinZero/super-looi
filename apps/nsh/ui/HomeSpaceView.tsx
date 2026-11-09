import { t, translateMessage } from "../i18n";
import { effect, signal, Text, View, Scroll, Video, windowSize } from "nsh";
import { Button } from "nsh/base";
import type { createAppStore } from "../store";
import { ActionButton, HorizontalValueSlider, LoadingIndicator, SelectField, TextField } from "./Controls";
import { ActionIcon, ApplianceIcon, PowerIconButton, type ActionIconName } from "./HomeIcons";
import type {
  ApplianceActionTrigger,
  HomeAppliance,
  HomeConfiguration,
  HomeRoomSection,
  HomeSourceId,
  ModeBarCapability,
  TileSpan,
} from "../generated/looi-runtime.js";

const REGIONS = (): Array<{
  value: HomeConfiguration["region"];
  title: string;
}> => [
  { value: "cn", title: t("mainlandChina") },
  { value: "de", title: t("europe") },
  { value: "i2", title: t("india") },
  { value: "ru", title: t("russia") },
  { value: "sg", title: t("singapore") },
  { value: "us", title: t("unitedStates") },
];

function resolveActionIconName(trigger: ApplianceActionTrigger): ActionIconName {
  if (trigger.iconKey) {
    return trigger.iconKey;
  }
  if (/清扫|开始|启动|加热|连接|播放|开机|唤醒/.test(trigger.label)) return "play";
  if (/暂停/.test(trigger.label)) return "pause";
  if (/停止|取消|关机/.test(trigger.label)) return "stop";
  if (/回充|出仓/.test(trigger.label)) return "dock";
  if (/集尘/.test(trigger.label)) return "dust";
  if (/洗拖布|清洗/.test(trigger.label)) return "wash";
  if (/烘干/.test(trigger.label)) return "dry";
  if (/定位/.test(trigger.label)) return "locate";
  if (/出粮|喂食/.test(trigger.label)) return "dispense";
  return "refresh";
}

/** The native player has its own stable source; device refreshes update controls. */
function CameraMonitor(props: { store: ReturnType<typeof createAppStore> }) {
  const playback = () => props.store.homeCamera();
  return (
    <View class="rounded-2xl border border-border bg-card p-4 gap-3">
      <View
        class="w-full rounded-xl overflow-hidden bg-secondary items-center justify-center"
        style={{ aspectRatio: "16 / 9", minHeight: 210, maxHeight: 310 }}
      >
        <Each of={playback().url ? [playback().url!] : []} key={(url) => url}>
          {(source) => {
            const url = source();
            return (
              <Video
                testID="home-camera-video"
                src={url}
                muted
                controls={false}
                class="absolute inset-0"
                progressUpdateInterval={1000}
                onLoad={(event) =>
                  props.store.homeCameraLoaded(url, event.size)
                }
                onProgress={(event) =>
                  props.store.homeCameraProgress(url, event.currentTime)
                }
                onBuffer={(event) =>
                  props.store.homeCameraBuffer(url, event.isBuffering)
                }
                onError={() => props.store.homeCameraFailed(url)}
                onEnd={() => props.store.homeCameraFailed(url)}
              />
            );
          }}
        </Each>
        <If when={!playback().url}>
          <View class="items-center gap-3 p-4">
            <ApplianceIcon kind="camera" active={false} size="lg" />
            <If when={playback().phase === "loading"}>
              <LoadingIndicator label={t("cameraConnecting")} />
            </If>
            <If when={Boolean(playback().error)}>
              <Text class="text-muted-foreground text-sm">
                {translateMessage(playback().error ?? "")}
              </Text>
            </If>
          </View>
        </If>
      </View>
      <View class="flex-row items-center justify-between gap-3">
        <View class="flex-1 gap-1">
          <Text
            testID="home-camera-status"
            class="text-foreground text-sm font-semibold"
          >
            {playback().phase === "playing"
              ? playback().buffering
                ? t("cameraBuffering")
                : t("cameraPlaying")
              : playback().phase === "error"
                ? translateMessage(playback().error ?? "")
                : playback().phase === "idle"
                  ? t("cameraStopped")
                  : t("cameraWaiting")}
          </Text>
          <If when={Boolean(playback().width && playback().height)}>
            <Text class="text-muted-foreground text-xs">{`${playback().width} × ${playback().height}`}</Text>
          </If>
        </View>
        <ActionButton
          testID="home-camera-retry"
          label={t("cameraReconnect")}
          kind="quiet"
          onPress={() => props.store.retryHomeCamera()}
        />
      </View>
    </View>
  );
}

export function HomeSpaceView(props: {
  store: ReturnType<typeof createAppStore>;
  modeTab?: HomeSourceId | (() => HomeSourceId);
}) {
  const saved = () => props.store.homeConfiguration();
  const dashboard = () =>
    typeof props.store.homeDashboard === "function"
      ? props.store.homeDashboard()
      : {
          homeName: "我的家",
          totalAppliances: 0,
          activeAppliances: 0,
          rooms: [],
          allAppliances: [],
        };
  const subView = (): "devices" | "services" =>
    typeof props.store.homeSubView === "function"
      ? props.store.homeSubView()
      : "services";
  const selectedRoomName = (): string =>
    typeof props.store.homeSelectedRoom === "function"
      ? props.store.homeSelectedRoom()
      : "all";
  const layoutEditing = (): boolean =>
    typeof props.store.homeLayoutEditing === "function"
      ? props.store.homeLayoutEditing()
      : false;
  const inspectedId = (): string | null =>
    typeof props.store.homeInspectedApplianceId === "function"
      ? props.store.homeInspectedApplianceId()
      : null;

  // Track the currently selected block in free layout editing mode for 2-tap swap/placement
  const movingApplianceId = signal<string | null>(null);

  // Service binding form signals
  const activeServiceTab = signal<HomeSourceId>("direct_miot");
  const region = signal<HomeConfiguration["region"]>(saved().region || "cn");
  const haUrl = signal(saved().haUrl || "http://homeassistant.local:8123");
  const token = signal("");
  const busy = signal(false);

  let lastExternalModeTab = "";
  effect(() => {
    const ext =
      typeof props.modeTab === "function" ? props.modeTab() : props.modeTab;
    if (ext && ext !== lastExternalModeTab) {
      lastExternalModeTab = ext;
      activeServiceTab.set(ext);
    }
  });

  const isWide = () => windowSize().width >= 660;
  const gridColumns = () => (windowSize().width >= 900 ? 4 : windowSize().width >= 560 ? 3 : 2);

  const visibleRooms = (): HomeRoomSection[] => {
    const all = dashboard().rooms;
    const sel = selectedRoomName();
    if (sel === "all" || !all.some((r) => r.name === sel)) {
      return all;
    }
    return all.filter((r) => r.name === sel);
  };

  const inspectedAppliance = (): HomeAppliance | undefined => {
    const id = inspectedId();
    if (!id) return undefined;
    return dashboard().allAppliances.find((a) => a.id === id);
  };

  const enterLayoutEditWithCard = (applianceId: string) => {
    props.store.setHomeInspectedApplianceId(null);
    props.store.setHomeLayoutEditing(true);
    movingApplianceId.set(applianceId);
  };

  const handleCardPressInEditMode = (room: HomeRoomSection, targetId: string) => {
    const liveRoom = dashboard().rooms.find((r) => r.id === room.id) ?? room;
    const currentMoving = movingApplianceId();
    if (!currentMoving) {
      movingApplianceId.set(targetId);
      return;
    }
    if (currentMoving === targetId) {
      movingApplianceId.set(null);
      return;
    }
    const idxA = liveRoom.appliances.findIndex((a) => a.id === currentMoving);
    const idxB = liveRoom.appliances.findIndex((a) => a.id === targetId);
    if (idxA < 0 || idxB < 0) {
      movingApplianceId.set(targetId);
      return;
    }
    const nextList = [...liveRoom.appliances];
    const temp = nextList[idxA]!;
    nextList[idxA] = nextList[idxB]!;
    nextList[idxB] = temp;
    movingApplianceId.set(null);
    void props.store.reorderHomeAppliances(
      nextList.map((item, idx) => ({ id: item.id, order: (idx + 1) * 10 })),
    );
  };

  // --- Control Dispatch Helpers ---
  const togglePower = (entityId: string, domain: string, currentOn: boolean) => {
    void props.store.controlHomeAppliance({
      entity_id: entityId,
      domain,
      service: currentOn ? "turn_off" : "turn_on",
      service_data: {},
    });
  };

  const triggerAction = (trigger: ApplianceActionTrigger) => {
    void props.store.controlHomeAppliance({
      entity_id: trigger.entityId,
      domain: trigger.domain,
      service: trigger.service,
      service_data: trigger.serviceData ?? {},
    });
  };

  const selectMode = (modeCap: ModeBarCapability, nextOption: string) => {
    void props.store.controlHomeAppliance({
      entity_id: modeCap.entityId,
      domain: modeCap.domain,
      service: modeCap.service,
      service_data: { [modeCap.parameterKey]: nextOption },
    });
  };

  const adjustThermostat = (
    entityId: string,
    domain: string,
    nextTemp: number,
    min: number,
    max: number,
    step: number,
  ) => {
    const clamped = Math.max(min, Math.min(max, Math.round(nextTemp / step) * step));
    if (domain === "climate") {
      void props.store.controlHomeAppliance({
        entity_id: entityId,
        domain: "climate",
        service: "set_temperature",
        service_data: { temperature: clamped },
      });
    } else if (domain === "number") {
      void props.store.controlHomeAppliance({
        entity_id: entityId,
        domain: "number",
        service: "set_value",
        service_data: { value: clamped },
      });
    }
  };

  const setLightBrightness = (entityId: string, percent: number) => {
    const clampedPct = Math.max(1, Math.min(100, Math.round(percent)));
    const brightnessByte = Math.max(1, Math.min(255, Math.round((clampedPct / 100) * 255)));
    void props.store.controlHomeAppliance({
      entity_id: entityId,
      domain: "light",
      service: "turn_on",
      service_data: { brightness: brightnessByte },
    });
  };

  const setLightColorTemp = (entityId: string, kelvin: number) => {
    void props.store.controlHomeAppliance({
      entity_id: entityId,
      domain: "light",
      service: "turn_on",
      service_data: { color_temp_kelvin: Math.round(kelvin) },
    });
  };

  const setApplianceSpan = (appliance: HomeAppliance, nextSpan: TileSpan) => {
    void props.store.setHomeApplianceLayout(appliance.id, { span: nextSpan });
  };

  const moveApplianceOrder = (room: HomeRoomSection, appliance: HomeAppliance, delta: -1 | 1) => {
    const liveRoom = dashboard().rooms.find((r) => r.id === room.id) ?? room;
    const idx = liveRoom.appliances.findIndex((a) => a.id === appliance.id);
    if (idx < 0) return;
    const swapIdx = idx + delta;
    if (swapIdx < 0 || swapIdx >= liveRoom.appliances.length) return;
    const nextList = [...liveRoom.appliances];
    const temp = nextList[idx]!;
    nextList[idx] = nextList[swapIdx]!;
    nextList[swapIdx] = temp;
    void props.store.reorderHomeAppliances(
      nextList.map((item, i) => ({ id: item.id, order: (i + 1) * 10 })),
    );
  };

  // --- Bento Card Sub-Renderers ---

  const renderEditOverlay = (room: HomeRoomSection, appliance: HomeAppliance) => {
    const spans: Array<{ value: TileSpan; label: string }> = [
      { value: "1x1", label: t("spanSmall") },
      { value: "2x1", label: t("spanWide") },
      { value: "2x2", label: t("spanLarge") },
    ];
    const isMovingThis = () => movingApplianceId() === appliance.id;
    const hasMovingOther = () =>
      movingApplianceId() !== null && movingApplianceId() !== appliance.id;

    return (
      <View class="mt-2 pt-2 border-t border-border gap-1.5">
        <View class="flex-row items-center justify-between gap-1 flex-wrap">
          <View class="flex-row items-center gap-1">
            {spans.map((sp) => (
              <Button
                testID={`home-span-opt-${appliance.id}-${sp.value}`}
                hitSlop={8}
                selected={appliance.span === sp.value}
                onPress={() => setApplianceSpan(appliance, sp.value)}
                class={
                  appliance.span === sp.value
                    ? "min-h-7 px-2 rounded-lg bg-primary items-center justify-center active:opacity-75"
                    : "min-h-7 px-2 rounded-lg bg-muted border border-border items-center justify-center active:opacity-75"
                }
              >
                <Text
                  class={
                    appliance.span === sp.value
                      ? "text-primary-foreground text-xs font-semibold"
                      : "text-muted-foreground text-xs font-medium"
                  }
                >
                  {sp.label}
                </Text>
              </Button>
            ))}
          </View>
          <View class="flex-row items-center gap-1">
            <Button
              testID={`home-order-up-${appliance.id}`}
              hitSlop={8}
              accessibilityLabel={t("moveEarlier")}
              onPress={() => moveApplianceOrder(room, appliance, -1)}
              class="w-7 h-7 rounded-lg bg-muted border border-border items-center justify-center active:opacity-75"
            >
              <ActionIcon name="move_left" tone="foreground" size={14} />
            </Button>
            <Button
              testID={`home-order-down-${appliance.id}`}
              hitSlop={8}
              accessibilityLabel={t("moveLater")}
              onPress={() => moveApplianceOrder(room, appliance, 1)}
              class="w-7 h-7 rounded-lg bg-muted border border-border items-center justify-center active:opacity-75"
            >
              <ActionIcon name="move_right" tone="foreground" size={14} />
            </Button>
          </View>
        </View>
        <Button
          testID={`home-swap-btn-${appliance.id}`}
          hitSlop={8}
          selected={isMovingThis()}
          onPress={() => handleCardPressInEditMode(room, appliance.id)}
          class={
            isMovingThis()
              ? "min-h-7 rounded-lg bg-primary px-2.5 flex-row items-center justify-center gap-1.5 active:opacity-75"
              : hasMovingOther()
                ? "min-h-7 rounded-lg bg-live-active-bg border border-verified px-2.5 flex-row items-center justify-center gap-1.5 active:opacity-75"
                : "min-h-7 rounded-lg bg-muted border border-border px-2.5 flex-row items-center justify-center gap-1.5 active:opacity-75"
          }
        >
          <ActionIcon
            name={isMovingThis() ? "check" : "swap"}
            tone={isMovingThis() ? "primaryFg" : hasMovingOther() ? "verified" : "muted"}
            size={13}
          />
          <Text
            class={
              isMovingThis()
                ? "text-primary-foreground text-xs font-semibold"
                : hasMovingOther()
                  ? "text-verified text-xs font-semibold"
                  : "text-muted-foreground text-xs font-medium"
            }
          >
            {isMovingThis()
              ? t("movingSelected")
              : hasMovingOther()
                ? t("swapWithSelected")
                : t("selectToMove")}
          </Text>
        </Button>
      </View>
    );
  };

  const renderCameraCardBody = (room: HomeRoomSection, appliance: HomeAppliance) => {
    const vs = appliance.capabilities.visionStream;
    const isLarge = appliance.span === "2x2";
    const isWideCard = appliance.span === "2x1";

    return (
      <View class="gap-2.5 mt-1">
        <If when={isLarge || isWideCard}>
          <View
            role="button"
            onPress={() => {
              if (layoutEditing()) {
                handleCardPressInEditMode(room, appliance.id);
              } else {
                props.store.setHomeInspectedApplianceId(appliance.id);
              }
            }}
            onLongPress={() => enterLayoutEditWithCard(appliance.id)}
            class="w-full rounded-xl bg-secondary border border-border p-3 justify-between active:opacity-80"
            style={{ minHeight: isLarge ? 124 : 74 }}
          >
            <View class="flex-row items-center justify-between gap-2">
              <View class="flex-row items-center gap-1.5 px-2 py-0.5 rounded-full bg-card border border-border">
                <View
                  class={
                    appliance.online && appliance.isActive
                      ? "w-2 h-2 rounded-full bg-verified"
                      : "w-2 h-2 rounded-full bg-muted-foreground"
                  }
                />
                <Text class="text-foreground text-xs font-semibold">
                  {vs?.statusText ?? appliance.statusBadge}
                </Text>
              </View>
              <Text class="text-muted-foreground text-xs font-medium">
                {vs?.resolutionBadge ?? ""}
              </Text>
            </View>

            <View class="flex-row items-center justify-between gap-2 mt-2">
              <View class="flex-row items-center gap-1.5 flex-1">
                <ActionIcon name="shield" tone="muted" size={14} />
                <Text class="text-muted-foreground text-xs flex-1" style={{ numberOfLines: 1 }}>
                  {vs?.lastMotionText ?? appliance.conciseSubtitle}
                </Text>
              </View>
              <If when={Boolean(vs?.storageUsedPercent !== undefined)}>
                <Text class="text-muted-foreground text-xs">
                  SD {vs?.storageUsedPercent}%
                </Text>
              </If>
            </View>
          </View>
        </If>

        <If when={isLarge && (vs?.featureToggles.length ?? 0) > 0}>
          <View class="flex-row items-center gap-1.5 flex-wrap">
            {(vs?.featureToggles ?? []).slice(0, 3).map((tog) => (
              <Button
                testID={`home-cam-tog-${tog.id}`}
                disabled={!tog.controllable}
                selected={tog.isOn}
                onPress={() => togglePower(tog.entityId, tog.domain, tog.isOn)}
                class={
                  tog.isOn
                    ? "min-h-8 px-2.5 rounded-lg bg-primary flex-row items-center justify-center gap-1 active:opacity-75 disabled:opacity-40"
                    : "min-h-8 px-2.5 rounded-lg bg-muted border border-border flex-row items-center justify-center gap-1 active:opacity-75 disabled:opacity-40"
                }
              >
                <Text
                  class={
                    tog.isOn
                      ? "text-primary-foreground text-xs font-semibold"
                      : "text-foreground text-xs font-medium"
                  }
                >
                  {tog.label}
                </Text>
              </Button>
            ))}
          </View>
        </If>
      </View>
    );
  };

  const renderVacuumCardBody = (appliance: HomeAppliance) => {
    const vac = appliance.capabilities.vacuum;
    const actions = appliance.capabilities.actions ?? [];
    const isExpanded = appliance.span === "2x1" || appliance.span === "2x2";
    if (!vac) return null;

    return (
      <View class="gap-2.5 mt-1">
        <If when={isExpanded}>
          <View class="rounded-xl bg-muted border border-border px-3 py-2.5 flex-row items-center justify-between gap-3">
            <View class="gap-0.5 flex-1" style={{ minWidth: 0 }}>
              <Text class="text-foreground text-base font-bold" style={{ numberOfLines: 1 }}>
                {vac.statusLabel}
              </Text>
              <Text class="text-muted-foreground text-xs" style={{ numberOfLines: 1 }}>
                {[
                  vac.batteryPercent !== undefined ? `电量 ${vac.batteryPercent}%` : undefined,
                  vac.cleaningAreaSqm !== undefined ? `面积 ${vac.cleaningAreaSqm}㎡` : undefined,
                  vac.cleaningMinutes !== undefined ? `${vac.cleaningMinutes}分钟` : undefined,
                ]
                  .filter(Boolean)
                  .join(" · ") || vac.chargingLabel || "基站就绪"}
              </Text>
            </View>

            <If when={actions.length > 0}>
              <View class="flex-row items-center gap-1.5">
                {actions.slice(0, 3).map((act) => (
                  <Button
                    testID={`home-vac-act-${act.id}`}
                    onPress={() => triggerAction(act)}
                    class={
                      act.tone === "primary"
                        ? "min-h-9 px-3 rounded-lg bg-primary flex-row items-center justify-center gap-1 active:opacity-75"
                        : "min-h-9 px-2.5 rounded-lg bg-card border border-border flex-row items-center justify-center gap-1 active:opacity-75"
                    }
                  >
                    <ActionIcon
                      name={resolveActionIconName(act)}
                      tone={act.tone === "primary" ? "primaryFg" : "foreground"}
                      size={14}
                    />
                    <Text
                      class={
                        act.tone === "primary"
                          ? "text-primary-foreground text-xs font-semibold"
                          : "text-foreground text-xs font-medium"
                      }
                    >
                      {act.label}
                    </Text>
                  </Button>
                ))}
              </View>
            </If>
          </View>
        </If>

        <If when={appliance.span === "2x2" && vac.consumables.length > 0}>
          <View class="flex-row items-center gap-2 flex-wrap">
            {vac.consumables.slice(0, 4).map((c) => (
              <View class="px-2.5 py-1 rounded-lg bg-muted border border-border flex-row items-center gap-1.5">
                <Text class="text-muted-foreground text-xs">{c.label.replace("寿命", "")}</Text>
                <Text class="text-foreground text-xs font-semibold">{c.percent}%</Text>
              </View>
            ))}
          </View>
        </If>
      </View>
    );
  };

  const renderCycleCardBody = (appliance: HomeAppliance) => {
    if (appliance.icon === "vacuum" && appliance.capabilities.vacuum) {
      return renderVacuumCardBody(appliance);
    }
    const cycle = appliance.capabilities.cycleTask;
    const actions = appliance.capabilities.actions ?? [];
    const isExpanded = appliance.span === "2x1" || appliance.span === "2x2";
    const isLarge = appliance.span === "2x2";

    if (!cycle) return null;

    return (
      <View class="gap-2.5 mt-1">
        <If when={isExpanded}>
          <View class="flex-row items-center justify-between gap-3 rounded-xl bg-muted border border-border px-3 py-2.5">
            <View class="gap-0.5">
              <Text class="text-foreground text-lg font-bold">
                {cycle.remainingMinutes !== undefined && cycle.remainingMinutes > 0
                  ? `${cycle.remainingMinutes} min`
                  : cycle.stageLabel}
              </Text>
              <Text class="text-muted-foreground text-xs">
                {cycle.temperatureCelsius !== undefined
                  ? `${cycle.stageLabel} · ${cycle.temperatureCelsius}°C`
                  : cycle.recipeLabel
                    ? `${cycle.recipeLabel} · ${cycle.stageLabel}`
                    : cycle.stageLabel}
              </Text>
            </View>

            <View class="flex-1 gap-1.5" style={{ minWidth: 0 }}>
              <View class="flex-row items-center gap-1">
                {cycle.stages.map((st, idx) => (
                  <View
                    class={
                      idx <= cycle.activeStageIndex && cycle.isRunning
                        ? "flex-1 h-1.5 rounded-full bg-verified"
                        : idx === cycle.activeStageIndex
                          ? "flex-1 h-1.5 rounded-full bg-primary"
                          : "flex-1 h-1.5 rounded-full bg-border"
                    }
                  />
                ))}
              </View>
              <View class="flex-row items-center justify-between">
                <Text class="text-muted-foreground text-xs">{cycle.stages[0]}</Text>
                <Text class="text-foreground text-xs font-semibold">{cycle.stageLabel}</Text>
                <Text class="text-muted-foreground text-xs">
                  {cycle.stages[cycle.stages.length - 1]}
                </Text>
              </View>
            </View>
          </View>
        </If>

        <If when={(isExpanded || isLarge) && actions.length > 0}>
          <View class="flex-row items-center gap-1.5 flex-wrap">
            {actions.slice(0, isLarge ? 4 : 3).map((act) => (
              <Button
                testID={`home-cycle-act-${act.id}`}
                onPress={() => triggerAction(act)}
                class={
                  act.tone === "primary"
                    ? "min-h-8 px-3 rounded-lg bg-primary flex-row items-center justify-center gap-1.5 active:opacity-75"
                    : "min-h-8 px-2.5 rounded-lg bg-muted border border-border flex-row items-center justify-center gap-1.5 active:opacity-75"
                }
              >
                <ActionIcon
                  name={resolveActionIconName(act)}
                  tone={act.tone === "primary" ? "primaryFg" : "foreground"}
                  size={13}
                />
                <Text
                  class={
                    act.tone === "primary"
                      ? "text-primary-foreground text-xs font-semibold"
                      : "text-foreground text-xs font-medium"
                  }
                >
                  {act.label}
                </Text>
              </Button>
            ))}
          </View>
        </If>
      </View>
    );
  };

  const renderClimateCardBody = (appliance: HomeAppliance) => {
    const therm = appliance.capabilities.thermostat;
    const modeBar = appliance.capabilities.modeBar;
    const isExpanded = appliance.span === "2x1" || appliance.span === "2x2";
    const isLarge = appliance.span === "2x2";

    if (!isExpanded) return null;

    return (
      <View class="gap-2.5 mt-1">
        <If when={Boolean(therm)}>
          <View class="flex-row items-center justify-between gap-2 rounded-xl bg-muted border border-border px-3 py-2">
            <Button
              testID={`home-therm-minus-${appliance.id}`}
              disabled={!therm?.controllable}
              accessibilityLabel="-"
              onPress={() =>
                therm &&
                adjustThermostat(
                  therm.entityId,
                  therm.domain,
                  therm.targetTemp - therm.step,
                  therm.minTemp,
                  therm.maxTemp,
                  therm.step,
                )
              }
              class="w-9 h-9 rounded-lg bg-card border border-border items-center justify-center active:opacity-75 disabled:opacity-35"
            >
              <ActionIcon name="minus" tone="foreground" size={16} />
            </Button>

            <View class="items-center">
              <Text class="text-foreground text-xl font-bold">
                {therm?.targetTemp}
                {therm?.unit ?? "°C"}
              </Text>
              <If when={therm?.currentTemp !== undefined}>
                <Text class="text-muted-foreground text-xs">
                  室温 {therm?.currentTemp}°C
                </Text>
              </If>
            </View>

            <Button
              testID={`home-therm-plus-${appliance.id}`}
              disabled={!therm?.controllable}
              accessibilityLabel="+"
              onPress={() =>
                therm &&
                adjustThermostat(
                  therm.entityId,
                  therm.domain,
                  therm.targetTemp + therm.step,
                  therm.minTemp,
                  therm.maxTemp,
                  therm.step,
                )
              }
              class="w-9 h-9 rounded-lg bg-card border border-border items-center justify-center active:opacity-75 disabled:opacity-35"
            >
              <ActionIcon name="plus" tone="foreground" size={16} />
            </Button>
          </View>
        </If>

        <If when={Boolean(modeBar) && (isLarge || !therm)}>
          <View class="flex-row items-center gap-1.5 flex-wrap">
            {(modeBar?.options ?? []).slice(0, 4).map((opt) => (
              <Button
                testID={`home-mode-${appliance.id}-${opt.value}`}
                disabled={!modeBar?.controllable}
                selected={modeBar?.currentMode === opt.value}
                onPress={() => modeBar && selectMode(modeBar, opt.value)}
                class={
                  modeBar?.currentMode === opt.value
                    ? "min-h-8 px-2.5 rounded-lg bg-primary items-center justify-center active:opacity-75 disabled:opacity-40"
                    : "min-h-8 px-2.5 rounded-lg bg-muted border border-border items-center justify-center active:opacity-75 disabled:opacity-40"
                }
              >
                <Text
                  class={
                    modeBar?.currentMode === opt.value
                      ? "text-primary-foreground text-xs font-semibold"
                      : "text-foreground text-xs font-medium"
                  }
                >
                  {opt.label}
                </Text>
              </Button>
            ))}
          </View>
        </If>
      </View>
    );
  };

  const renderMultiGangCardBody = (appliance: HomeAppliance) => {
    const mg = appliance.capabilities.multiGang;
    if (!mg) return null;

    return (
      <View class="flex-row items-center gap-1.5 mt-1.5">
        {mg.channels.map((ch) => (
          <Button
            testID={`home-gang-${ch.id}`}
            disabled={!ch.controllable}
            selected={ch.isOn}
            onPress={() => togglePower(ch.entityId, ch.domain, ch.isOn)}
            class={
              ch.isOn
                ? "flex-1 min-h-10 rounded-xl bg-primary px-2 py-1.5 items-center justify-center gap-0.5 active:opacity-75 disabled:opacity-40"
                : "flex-1 min-h-10 rounded-xl bg-muted border border-border px-2 py-1.5 items-center justify-center gap-0.5 active:opacity-75 disabled:opacity-40"
            }
          >
            <ActionIcon
              name="power"
              tone={ch.isOn ? "primaryFg" : "muted"}
              size={13}
            />
            <Text
              class={
                ch.isOn
                  ? "text-primary-foreground text-xs font-semibold"
                  : "text-foreground text-xs font-medium"
              }
              style={{ numberOfLines: 1 }}
            >
              {ch.label}
            </Text>
          </Button>
        ))}
      </View>
    );
  };

  const renderApplianceCard = (room: HomeRoomSection, appliance: HomeAppliance) => {
    const cols = gridColumns();
    const effectiveColSpan =
      appliance.span === "1x1" ? 1 : Math.min(2, cols);
    const power = appliance.capabilities.power;
    const isMovingSelected = () => layoutEditing() && movingApplianceId() === appliance.id;

    const cardBorderClass = () => {
      if (isMovingSelected()) {
        return "rounded-2xl border-2 border-primary bg-card p-3.5 justify-between";
      }
      if (appliance.isActive) {
        return "rounded-2xl border border-ring bg-card p-3.5 justify-between";
      }
      return "rounded-2xl border border-border bg-card p-3.5 justify-between";
    };

    return (
      <View
        style={{
          gridColumn: `span ${effectiveColSpan}`,
          gridRow: appliance.span === "2x2" ? "span 2" : "span 1",
          minHeight: appliance.span === "2x2" ? 210 : 112,
        }}
        class={cardBorderClass()}
      >
        <View class="gap-2">
          {/* Card Header: Icon + Name + Subtitle on Left, Power Icon Button or Status Badge on Right */}
          <View class="flex-row items-start justify-between gap-2">
            <View
              testID={`home-card-${appliance.id}`}
              role="button"
              accessibilityLabel={`${appliance.name} · ${appliance.conciseSubtitle}`}
              onPress={() => {
                if (layoutEditing()) {
                  handleCardPressInEditMode(room, appliance.id);
                } else {
                  props.store.setHomeInspectedApplianceId(appliance.id);
                }
              }}
              onLongPress={() => enterLayoutEditWithCard(appliance.id)}
              class="flex-1 flex-row items-center gap-2.5 active:opacity-75"
              style={{ minWidth: 0 }}
            >
              <ApplianceIcon
                kind={appliance.icon}
                active={appliance.isActive}
                size="md"
              />
              <View class="flex-1 gap-0.5" style={{ minWidth: 0 }}>
                <Text
                  class="text-foreground text-sm font-semibold"
                  style={{ numberOfLines: 1 }}
                >
                  {appliance.name}
                </Text>
                <Text
                  class={
                    appliance.isActive
                      ? "text-foreground text-xs font-medium"
                      : "text-muted-foreground text-xs"
                  }
                  style={{ numberOfLines: 1 }}
                >
                  {appliance.conciseSubtitle}
                </Text>
              </View>
            </View>

            <If
              when={Boolean(power && power.controllable && !layoutEditing())}
              else={
                <View
                  class={
                    appliance.isActive
                      ? "px-2 py-1 rounded-full bg-live-active-bg border border-verified"
                      : "px-2 py-1 rounded-full bg-muted border border-border"
                  }
                >
                  <Text
                    class={
                      appliance.isActive
                        ? "text-verified text-xs font-semibold"
                        : "text-muted-foreground text-xs"
                    }
                  >
                    {appliance.statusBadge}
                  </Text>
                </View>
              }
            >
              <PowerIconButton
                testID={`home-power-${appliance.id}`}
                isOn={Boolean(power?.isOn)}
                disabled={!power?.controllable}
                size="sm"
                accessibilityLabel={`${appliance.name} ${power?.isOn ? t("powerOff") : t("powerOn")}`}
                onPress={() =>
                  power && togglePower(power.entityId, power.domain, power.isOn)
                }
              />
            </If>
          </View>

          {/* Domain-specific card body */}
          <If when={appliance.icon === "camera"}>
            {renderCameraCardBody(room, appliance)}
          </If>
          <If when={appliance.archetype === "cycle_appliance"}>
            {renderCycleCardBody(appliance)}
          </If>
          <If when={appliance.archetype === "climate"}>
            {renderClimateCardBody(appliance)}
          </If>
          <If when={appliance.icon === "switch_gang"}>
            {renderMultiGangCardBody(appliance)}
          </If>
          <If
            when={
              (appliance.icon === "feeder" ||
                appliance.icon === "waterer" ||
                appliance.archetype === "media") &&
              (appliance.capabilities.actions?.length ?? 0) > 0 &&
              appliance.span !== "1x1"
            }
          >
            <View class="flex-row items-center gap-1.5 mt-1 flex-wrap">
              {(appliance.capabilities.actions ?? []).slice(0, 2).map((act) => (
                <Button
                  testID={`home-pet-act-${act.id}`}
                  onPress={() => triggerAction(act)}
                  class={
                    act.tone === "primary"
                      ? "min-h-8 px-3 rounded-lg bg-primary flex-row items-center justify-center gap-1.5 active:opacity-75"
                      : "min-h-8 px-2.5 rounded-lg bg-muted border border-border flex-row items-center justify-center gap-1.5 active:opacity-75"
                  }
                >
                  <ActionIcon
                    name={resolveActionIconName(act)}
                    tone={act.tone === "primary" ? "primaryFg" : "foreground"}
                    size={13}
                  />
                  <Text
                    class={
                      act.tone === "primary"
                        ? "text-primary-foreground text-xs font-semibold"
                        : "text-foreground text-xs font-medium"
                    }
                  >
                    {act.label}
                  </Text>
                </Button>
              ))}
            </View>
          </If>
        </View>

        <If when={layoutEditing()}>
          {renderEditOverlay(room, appliance)}
        </If>
      </View>
    );
  };

  // ============================================================================
  // DEDICATED FULL-PAGE APPLIANCE VIEWS (Camera, Vacuum, Rice Cooker/Cycle, etc.)
  // ============================================================================

  const renderCameraFullPage = (appliance: () => HomeAppliance) => {
    const vs = () => appliance().capabilities.visionStream;

    return (
      <View class={isWide() ? "flex-row items-start gap-4" : "gap-4"}>
        {/* Left Column: 16:9 Live Monitor Viewport + Quick Controls */}
        <View
          class={isWide() ? "flex-1 gap-4" : "w-full gap-4"}
          style={{ minWidth: 0 }}
        >
          <CameraMonitor store={props.store} />
          <If when={(vs()?.ptzActions.length ?? 0) > 0}>
            <View class="flex-row flex-wrap items-center gap-2">
              <Each of={vs()?.ptzActions ?? []} key={(action) => action.id}>
                {(action) => (
                  <ActionButton
                    label={action().label}
                    kind="quiet"
                    onPress={() => triggerAction(action())}
                  />
                )}
              </Each>
            </View>
          </If>

          {/* Quick Feature Toggles */}
          <If when={(vs()?.featureToggles.length ?? 0) > 0}>
            <View class="rounded-2xl border border-border bg-card p-4 gap-3">
              <Text class="text-foreground text-sm font-semibold">
                {t("primaryControls")}
              </Text>
              <View class="flex-row items-center gap-2.5 flex-wrap">
                {(vs()?.featureToggles ?? []).map((tog) => (
                  <Button
                    testID={`detail-cam-tog-${tog.id}`}
                    disabled={!tog.controllable}
                    selected={tog.isOn}
                    onPress={() =>
                      togglePower(tog.entityId, tog.domain, tog.isOn)
                    }
                    class={
                      tog.isOn
                        ? "flex-1 min-w-28 min-h-12 px-3.5 rounded-xl bg-primary flex-row items-center justify-between gap-2 active:opacity-75 disabled:opacity-40"
                        : "flex-1 min-w-28 min-h-12 px-3.5 rounded-xl bg-muted border border-border flex-row items-center justify-between gap-2 active:opacity-75 disabled:opacity-40"
                    }
                  >
                    <Text
                      class={
                        tog.isOn
                          ? "text-primary-foreground text-sm font-semibold"
                          : "text-foreground text-sm font-medium"
                      }
                    >
                      {tog.label}
                    </Text>
                    <ActionIcon
                      name={tog.isOn ? "check" : "power"}
                      tone={tog.isOn ? "primaryFg" : "muted"}
                      size={16}
                    />
                  </Button>
                ))}
              </View>
            </View>
          </If>
        </View>

        {/* Right Column: Mode Selectors (Night Vision / Sensitivity / Recording) + SD Storage */}
        <View class={isWide() ? "w-80 gap-4" : "w-full gap-4"}>
          <If when={(vs()?.modeSelectors?.length ?? 0) > 0}>
            <View class="rounded-2xl border border-border bg-card p-4 gap-3.5">
              <Text class="text-foreground text-sm font-semibold">
                {t("cameraStorageAndSettings")}
              </Text>
              {(vs()?.modeSelectors ?? []).map((sel) => (
                <View class="gap-1.5">
                  <Text class="text-muted-foreground text-xs font-medium">
                    {sel.label}
                  </Text>
                  <View class="flex-row items-center gap-1.5 flex-wrap">
                    {sel.capability.options.map((opt) => (
                      <Button
                        testID={`detail-cam-mode-${sel.id}-${opt.value}`}
                        disabled={!sel.capability.controllable}
                        selected={sel.capability.currentMode === opt.value}
                        onPress={() => selectMode(sel.capability, opt.value)}
                        class={
                          sel.capability.currentMode === opt.value
                            ? "flex-1 min-h-10 px-3 rounded-xl bg-primary items-center justify-center active:opacity-75 disabled:opacity-40"
                            : "flex-1 min-h-10 px-3 rounded-xl bg-muted border border-border items-center justify-center active:opacity-75 disabled:opacity-40"
                        }
                      >
                        <Text
                          class={
                            sel.capability.currentMode === opt.value
                              ? "text-primary-foreground text-xs font-semibold"
                              : "text-foreground text-xs font-medium"
                          }
                        >
                          {opt.label}
                        </Text>
                      </Button>
                    ))}
                  </View>
                </View>
              ))}
            </View>
          </If>

          <If when={vs()?.storageStatusText !== undefined}>
            <View class="rounded-2xl border border-border bg-card p-4 gap-2.5">
              <View class="flex-row items-center justify-between">
                <Text class="text-foreground text-sm font-semibold">
                  存储卡状态
                </Text>
                <Text class="text-verified text-xs font-semibold">
                  {vs()?.storageUsedPercent !== undefined
                    ? `已用 ${vs()?.storageUsedPercent}%`
                    : "正常"}
                </Text>
              </View>
              <If when={vs()?.storageUsedPercent !== undefined}>
                <View class="w-full h-2.5 rounded-full bg-muted overflow-hidden">
                  <View
                    class="h-full rounded-full bg-verified"
                    style={{ width: `${vs()?.storageUsedPercent ?? 0}%` }}
                  />
                </View>
              </If>
              <Text class="text-muted-foreground text-xs">
                {vs()?.storageStatusText}
              </Text>
            </View>
          </If>
        </View>
      </View>
    );
  };

  const renderVacuumFullPage = (appliance: HomeAppliance) => {
    const vac = appliance.capabilities.vacuum;
    const cycle = appliance.capabilities.cycleTask;
    const actions = appliance.capabilities.actions ?? [];
    const modeBar = appliance.capabilities.modeBar;
    const mopModeBar = vac?.mopModeBar;

    return (
      <View class="gap-4">
        {/* Top Hero: Status + Stage Pipeline + 4 Cleaning Telemetry Metrics */}
        <View class="rounded-3xl border border-border bg-card p-5 gap-4">
          <View class="flex-row items-center justify-between gap-3 flex-wrap">
            <View class="flex-row items-center gap-3">
              <ApplianceIcon kind="vacuum" active={appliance.isActive} size="lg" />
              <View class="gap-0.5">
                <Text class="text-foreground text-2xl font-bold">
                  {vac?.statusLabel ?? cycle?.stageLabel ?? appliance.statusBadge}
                </Text>
                <Text class="text-muted-foreground text-xs">
                  {[
                    vac?.chargingLabel,
                    vac?.waterBoxInstalled !== undefined
                      ? vac.waterBoxInstalled
                        ? "拖布支架已安装"
                        : "未安装拖布"
                      : undefined,
                  ]
                    .filter(Boolean)
                    .join(" · ") || "基站自检正常"}
                </Text>
              </View>
            </View>

            <If when={vac?.batteryPercent !== undefined}>
              <View class="px-3.5 py-2 rounded-2xl bg-live-active-bg border border-verified flex-row items-center gap-2">
                <View class="w-2 h-2 rounded-full bg-verified" />
                <Text class="text-verified text-sm font-bold">
                  电量 {vac?.batteryPercent}%
                </Text>
              </View>
            </If>
          </View>

          {/* 5-Stage Pipeline */}
          <If when={Boolean(cycle)}>
            <View class="flex-row items-center gap-2">
              {(cycle?.stages ?? []).map((st, idx) => {
                const isCurrent = idx === (cycle?.activeStageIndex ?? 0);
                return (
                  <View
                    class={
                      isCurrent
                        ? "flex-1 rounded-xl bg-primary px-2.5 py-2 items-center justify-center"
                        : "flex-1 rounded-xl bg-muted border border-border px-2.5 py-2 items-center justify-center"
                    }
                  >
                    <Text
                      class={
                        isCurrent
                          ? "text-primary-foreground text-xs font-semibold"
                          : "text-muted-foreground text-xs"
                      }
                    >
                      {st}
                    </Text>
                  </View>
                );
              })}
            </View>
          </If>

          {/* Cleaning Statistics Grid */}
          <View class="flex-row items-center gap-2.5 flex-wrap">
            <View class="flex-1 min-w-28 rounded-2xl bg-muted border border-border p-3 gap-0.5">
              <Text class="text-muted-foreground text-xs">本次清扫面积</Text>
              <Text class="text-foreground text-lg font-bold">
                {vac?.cleaningAreaSqm ?? 0} ㎡
              </Text>
            </View>
            <View class="flex-1 min-w-28 rounded-2xl bg-muted border border-border p-3 gap-0.5">
              <Text class="text-muted-foreground text-xs">本次清扫时长</Text>
              <Text class="text-foreground text-lg font-bold">
                {vac?.cleaningMinutes ?? 0} min
              </Text>
            </View>
            <If when={vac?.totalCleanCount !== undefined}>
              <View class="flex-1 min-w-28 rounded-2xl bg-muted border border-border p-3 gap-0.5">
                <Text class="text-muted-foreground text-xs">累计清扫次数</Text>
                <Text class="text-foreground text-lg font-bold">
                  {vac?.totalCleanCount} 次
                </Text>
              </View>
            </If>
            <If when={vac?.totalCleanAreaSqm !== undefined}>
              <View class="flex-1 min-w-28 rounded-2xl bg-muted border border-border p-3 gap-0.5">
                <Text class="text-muted-foreground text-xs">累计清扫面积</Text>
                <Text class="text-foreground text-lg font-bold">
                  {vac?.totalCleanAreaSqm} ㎡
                </Text>
              </View>
            </If>
          </View>

          {/* Primary Action Dock with Vector Icons */}
          <If when={actions.length > 0}>
            <View class="flex-row items-center gap-2 flex-wrap pt-1">
              {actions.map((act) => (
                <Button
                  testID={`detail-vac-act-${act.id}`}
                  onPress={() => triggerAction(act)}
                  class={
                    act.tone === "primary"
                      ? "flex-1 min-w-28 min-h-12 px-4 rounded-2xl bg-primary flex-row items-center justify-center gap-2 active:opacity-75"
                      : "flex-1 min-w-24 min-h-12 px-3.5 rounded-2xl bg-muted border border-border flex-row items-center justify-center gap-2 active:opacity-75"
                  }
                >
                  <ActionIcon
                    name={resolveActionIconName(act)}
                    tone={act.tone === "primary" ? "primaryFg" : "foreground"}
                    size={17}
                  />
                  <Text
                    class={
                      act.tone === "primary"
                        ? "text-primary-foreground text-sm font-semibold"
                        : "text-foreground text-sm font-medium"
                    }
                  >
                    {act.label}
                  </Text>
                </Button>
              ))}
            </View>
          </If>
        </View>

        {/* Bottom 2-Column Section: Cleaning/Mop Modes + Consumable Health Bars */}
        <View class={isWide() ? "flex-row items-start gap-4" : "gap-4"}>
          {/* Modes Card */}
          <If when={Boolean(modeBar || mopModeBar)}>
            <View class="flex-1 rounded-2xl border border-border bg-card p-4 gap-4" style={{ minWidth: 0 }}>
              <If when={Boolean(modeBar)}>
                <View class="gap-2">
                  <Text class="text-foreground text-sm font-semibold">
                    {t("modeSelection")}
                  </Text>
                  <View class="flex-row items-center gap-2 flex-wrap">
                    {(modeBar?.options ?? []).map((opt) => (
                      <Button
                        testID={`detail-vac-mode-${opt.value}`}
                        disabled={!modeBar?.controllable}
                        selected={modeBar?.currentMode === opt.value}
                        onPress={() => modeBar && selectMode(modeBar, opt.value)}
                        class={
                          modeBar?.currentMode === opt.value
                            ? "flex-1 min-w-20 min-h-11 px-3 rounded-xl bg-primary items-center justify-center active:opacity-75 disabled:opacity-40"
                            : "flex-1 min-w-20 min-h-11 px-3 rounded-xl bg-muted border border-border items-center justify-center active:opacity-75 disabled:opacity-40"
                        }
                      >
                        <Text
                          class={
                            modeBar?.currentMode === opt.value
                              ? "text-primary-foreground text-sm font-semibold"
                              : "text-foreground text-sm font-medium"
                          }
                        >
                          {opt.label}
                        </Text>
                      </Button>
                    ))}
                  </View>
                </View>
              </If>

              <If when={Boolean(mopModeBar)}>
                <View class="gap-2">
                  <Text class="text-foreground text-sm font-semibold">
                    {t("waterOutputMode")}
                  </Text>
                  <View class="flex-row items-center gap-2 flex-wrap">
                    {(mopModeBar?.options ?? []).map((opt) => (
                      <Button
                        testID={`detail-vac-mop-${opt.value}`}
                        disabled={!mopModeBar?.controllable}
                        selected={mopModeBar?.currentMode === opt.value}
                        onPress={() => mopModeBar && selectMode(mopModeBar, opt.value)}
                        class={
                          mopModeBar?.currentMode === opt.value
                            ? "flex-1 min-w-20 min-h-11 px-3 rounded-xl bg-primary items-center justify-center active:opacity-75 disabled:opacity-40"
                            : "flex-1 min-w-20 min-h-11 px-3 rounded-xl bg-muted border border-border items-center justify-center active:opacity-75 disabled:opacity-40"
                        }
                      >
                        <Text
                          class={
                            mopModeBar?.currentMode === opt.value
                              ? "text-primary-foreground text-sm font-semibold"
                              : "text-foreground text-sm font-medium"
                          }
                        >
                          {opt.label}
                        </Text>
                      </Button>
                    ))}
                  </View>
                </View>
              </If>
            </View>
          </If>

          {/* Consumables Health Card */}
          <If when={(vac?.consumables.length ?? 0) > 0}>
            <View class="flex-1 rounded-2xl border border-border bg-card p-4 gap-3" style={{ minWidth: 0 }}>
              <Text class="text-foreground text-sm font-semibold">
                {t("consumablesHealth")}
              </Text>
              <View class="gap-2.5">
                {(vac?.consumables ?? []).map((c) => {
                  const barClass =
                    c.percent <= 15
                      ? "h-full rounded-full bg-destructive"
                      : c.percent <= 30
                        ? "h-full rounded-full bg-warning"
                        : "h-full rounded-full bg-verified";
                  return (
                    <View class="gap-1">
                      <View class="flex-row items-center justify-between">
                        <Text class="text-foreground text-xs font-medium">{c.label}</Text>
                        <Text class="text-muted-foreground text-xs font-semibold">
                          剩余 {c.percent}%
                          {c.remainingHours !== undefined ? ` (约 ${c.remainingHours}h)` : ""}
                        </Text>
                      </View>
                      <View class="w-full h-2 rounded-full bg-muted overflow-hidden">
                        <View class={barClass} style={{ width: `${c.percent}%` }} />
                      </View>
                    </View>
                  );
                })}
              </View>
            </View>
          </If>
        </View>
      </View>
    );
  };

  const renderCycleApplianceFullPage = (appliance: HomeAppliance) => {
    const cycle = appliance.capabilities.cycleTask;
    const actions = appliance.capabilities.actions ?? [];
    const modeBar = appliance.capabilities.modeBar;
    const auxToggles = appliance.capabilities.auxiliaryToggles ?? [];

    return (
      <View class="gap-4">
        {/* Hero Cooking / Cycle Stage Card */}
        <View class="rounded-3xl border border-border bg-card p-5 gap-4">
          <View class="flex-row items-center justify-between gap-4 flex-wrap">
            <View class="flex-row items-center gap-3.5">
              <ApplianceIcon kind={appliance.icon} active={appliance.isActive} size="lg" />
              <View class="gap-0.5">
                <Text class="text-foreground text-2xl font-bold">
                  {cycle?.remainingMinutes !== undefined && cycle.remainingMinutes > 0
                    ? `剩余 ${cycle.remainingMinutes} 分钟`
                    : cycle?.stageLabel ?? appliance.statusBadge}
                </Text>
                <Text class="text-muted-foreground text-sm">
                  {[
                    cycle?.recipeLabel ? `当前程序：${cycle.recipeLabel}` : undefined,
                    cycle?.keepWarmMinutes ? `已保温 ${cycle.keepWarmMinutes} 分钟` : undefined,
                  ]
                    .filter(Boolean)
                    .join(" · ") || appliance.conciseSubtitle}
                </Text>
              </View>
            </View>

            <If when={cycle?.temperatureCelsius !== undefined}>
              <View class="px-4 py-2.5 rounded-2xl bg-muted border border-border items-end">
                <Text class="text-muted-foreground text-xs">腔体/锅内温度</Text>
                <Text class="text-foreground text-xl font-bold">
                  {cycle?.temperatureCelsius}°C
                </Text>
              </View>
            </If>
          </View>

          {/* 5-Stage Pipeline */}
          <If when={Boolean(cycle)}>
            <View class="gap-2">
              <Text class="text-muted-foreground text-xs font-medium">
                {t("stagePipeline")}
              </Text>
              <View class="flex-row items-center gap-2">
                {(cycle?.stages ?? []).map((st, idx) => {
                  const activeIdx = cycle?.activeStageIndex ?? 0;
                  const isCurrent = idx === activeIdx;
                  const isDone = Boolean(cycle?.isRunning && idx < activeIdx);
                  return (
                    <View
                      class={
                        isCurrent
                          ? "flex-1 rounded-2xl bg-primary px-2.5 py-2.5 items-center justify-center gap-0.5"
                          : isDone
                            ? "flex-1 rounded-2xl bg-live-active-bg border border-verified px-2.5 py-2.5 items-center justify-center gap-0.5"
                            : "flex-1 rounded-2xl bg-muted border border-border px-2.5 py-2.5 items-center justify-center gap-0.5"
                      }
                    >
                      <Text
                        class={
                          isCurrent
                            ? "text-primary-foreground text-xs font-bold"
                            : isDone
                              ? "text-verified text-xs font-semibold"
                              : "text-muted-foreground text-xs"
                        }
                      >
                        {st}
                      </Text>
                    </View>
                  );
                })}
              </View>
            </View>
          </If>

          {/* Primary Transport Dock */}
          <If when={actions.length > 0}>
            <View class="flex-row items-center gap-2.5 flex-wrap pt-1">
              {actions.map((act) => (
                <Button
                  testID={`detail-cycle-act-${act.id}`}
                  onPress={() => triggerAction(act)}
                  class={
                    act.tone === "primary"
                      ? "flex-1 min-w-28 min-h-12 px-5 rounded-2xl bg-primary flex-row items-center justify-center gap-2 active:opacity-75"
                      : "flex-1 min-w-28 min-h-12 px-4 rounded-2xl bg-muted border border-border flex-row items-center justify-center gap-2 active:opacity-75"
                  }
                >
                  <ActionIcon
                    name={resolveActionIconName(act)}
                    tone={act.tone === "primary" ? "primaryFg" : "foreground"}
                    size={17}
                  />
                  <Text
                    class={
                      act.tone === "primary"
                        ? "text-primary-foreground text-sm font-semibold"
                        : "text-foreground text-sm font-medium"
                    }
                  >
                    {act.label}
                  </Text>
                </Button>
              ))}
            </View>
          </If>
        </View>

        {/* Cooking / Washing Programs & Auxiliary Switches */}
        <If when={Boolean(modeBar)}>
          <View class="rounded-2xl border border-border bg-card p-4 gap-3">
            <Text class="text-foreground text-sm font-semibold">
              {t("cookingPrograms")}
            </Text>
            <View class="flex-row items-center gap-2 flex-wrap">
              {(modeBar?.options ?? []).map((opt) => (
                <Button
                  testID={`detail-cycle-mode-${opt.value}`}
                  disabled={!modeBar?.controllable}
                  selected={modeBar?.currentMode === opt.value}
                  onPress={() => modeBar && selectMode(modeBar, opt.value)}
                  class={
                    modeBar?.currentMode === opt.value
                      ? "min-w-24 flex-1 min-h-12 px-3.5 rounded-xl bg-primary items-center justify-center active:opacity-75 disabled:opacity-40"
                      : "min-w-24 flex-1 min-h-12 px-3.5 rounded-xl bg-muted border border-border items-center justify-center active:opacity-75 disabled:opacity-40"
                  }
                >
                  <Text
                    class={
                      modeBar?.currentMode === opt.value
                        ? "text-primary-foreground text-sm font-semibold"
                        : "text-foreground text-sm font-medium"
                    }
                  >
                    {opt.label}
                  </Text>
                </Button>
              ))}
            </View>
          </View>
        </If>

        <If when={auxToggles.length > 0}>
          <View class="rounded-2xl border border-border bg-card p-4 gap-3">
            <Text class="text-foreground text-sm font-semibold">
              {t("auxiliaryFeatures")}
            </Text>
            <View class="flex-row items-center gap-2.5 flex-wrap">
              {auxToggles.map((tog) => (
                <Button
                  testID={`detail-cycle-aux-${tog.id}`}
                  disabled={!tog.controllable}
                  selected={tog.isOn}
                  onPress={() => togglePower(tog.entityId, tog.domain, tog.isOn)}
                  class={
                    tog.isOn
                      ? "min-h-11 px-4 rounded-xl bg-primary flex-row items-center justify-center gap-2 active:opacity-75 disabled:opacity-40"
                      : "min-h-11 px-4 rounded-xl bg-muted border border-border flex-row items-center justify-center gap-2 active:opacity-75 disabled:opacity-40"
                  }
                >
                  <ActionIcon
                    name={tog.isOn ? "check" : "power"}
                    tone={tog.isOn ? "primaryFg" : "muted"}
                    size={15}
                  />
                  <Text
                    class={
                      tog.isOn
                        ? "text-primary-foreground text-sm font-semibold"
                        : "text-foreground text-sm font-medium"
                    }
                  >
                    {tog.label}
                  </Text>
                </Button>
              ))}
            </View>
          </View>
        </If>
      </View>
    );
  };

  const renderGenericApplianceFullPage = (appliance: HomeAppliance) => {
    const cap = appliance.capabilities;

    return (
      <View class="gap-4">
        {/* Multi-Gang Switch Channels */}
        <If when={Boolean(cap.multiGang)}>
          <View class="rounded-2xl border border-border bg-card p-4 gap-3">
            <Text class="text-foreground text-sm font-semibold">{t("primaryControls")}</Text>
            <View class="flex-row items-center gap-2.5">
              {(cap.multiGang?.channels ?? []).map((ch) => (
                <Button
                  testID={`detail-gang-${ch.id}`}
                  disabled={!ch.controllable}
                  selected={ch.isOn}
                  onPress={() => togglePower(ch.entityId, ch.domain, ch.isOn)}
                  class={
                    ch.isOn
                      ? "flex-1 min-h-16 rounded-2xl bg-primary px-3 py-3 items-center justify-center gap-1.5 active:opacity-75 disabled:opacity-40"
                      : "flex-1 min-h-16 rounded-2xl bg-muted border border-border px-3 py-3 items-center justify-center gap-1.5 active:opacity-75 disabled:opacity-40"
                  }
                >
                  <ActionIcon
                    name="power"
                    tone={ch.isOn ? "primaryFg" : "muted"}
                    size={18}
                  />
                  <Text
                    class={
                      ch.isOn
                        ? "text-primary-foreground text-sm font-semibold"
                        : "text-foreground text-sm font-medium"
                    }
                  >
                    {ch.label}
                  </Text>
                </Button>
              ))}
            </View>
          </View>
        </If>

        {/* Light Dimmer & Color Temperature */}
        <If when={Boolean(cap.dimmer)}>
          <View class="rounded-2xl border border-border bg-card p-4 gap-4">
            <View class="gap-2">
              <View class="flex-row items-center justify-between">
                <View class="flex-row items-center gap-2">
                  <ActionIcon name="sun" tone="foreground" size={16} />
                  <Text class="text-foreground text-sm font-semibold">{t("brightness")}</Text>
                </View>
                <Text class="text-foreground text-sm font-bold">
                  {cap.dimmer?.brightnessPercent ?? 80}%
                </Text>
              </View>
              <HorizontalValueSlider
                testID={`detail-dimmer-${appliance.id}`}
                min={1}
                max={100}
                step={1}
                value={cap.dimmer?.brightnessPercent ?? 80}
                disabled={!cap.dimmer?.controllable}
                accessibilityLabel={t("brightness")}
                onChange={() => {}}
                onChangeEnd={(val) =>
                  cap.dimmer && setLightBrightness(cap.dimmer.entityId, val)
                }
              />
            </View>

            <If when={Boolean(cap.dimmer?.colorTempRange)}>
              <View class="gap-2 pt-2 border-t border-border">
                <View class="flex-row items-center justify-between">
                  <Text class="text-foreground text-sm font-semibold">{t("colorTemperature")}</Text>
                  <Text class="text-muted-foreground text-xs font-semibold">
                    {cap.dimmer?.colorTempKelvin ?? 4000}K
                  </Text>
                </View>
                <View class="flex-row items-center gap-2 flex-wrap">
                  {[
                    { k: 2700, label: "2700K 暖光" },
                    { k: 4000, label: "4000K 自然" },
                    { k: 5000, label: "5000K 日光" },
                    { k: 6500, label: "6500K 冷白" },
                  ].map((preset) => (
                    <Button
                      testID={`detail-ct-${preset.k}`}
                      onPress={() =>
                        cap.dimmer && setLightColorTemp(cap.dimmer.entityId, preset.k)
                      }
                      class={
                        Math.abs((cap.dimmer?.colorTempKelvin ?? 4000) - preset.k) < 400
                          ? "flex-1 min-w-20 min-h-10 px-2.5 rounded-xl bg-primary items-center justify-center active:opacity-75"
                          : "flex-1 min-w-20 min-h-10 px-2.5 rounded-xl bg-muted border border-border items-center justify-center active:opacity-75"
                      }
                    >
                      <Text
                        class={
                          Math.abs((cap.dimmer?.colorTempKelvin ?? 4000) - preset.k) < 400
                            ? "text-primary-foreground text-xs font-semibold"
                            : "text-foreground text-xs font-medium"
                        }
                      >
                        {preset.label}
                      </Text>
                    </Button>
                  ))}
                </View>
              </View>
            </If>
          </View>
        </If>

        {/* Climate / Thermostat */}
        <If when={Boolean(cap.thermostat)}>
          <View class="rounded-2xl border border-border bg-card p-4 gap-3">
            <View class="flex-row items-center justify-between">
              <Text class="text-foreground text-sm font-semibold">
                {t("targetTemperature")}
              </Text>
              <Text class="text-foreground text-2xl font-bold">
                {cap.thermostat?.targetTemp}
                {cap.thermostat?.unit ?? "°C"}
              </Text>
            </View>
            <HorizontalValueSlider
              testID={`detail-therm-slider-${appliance.id}`}
              min={cap.thermostat?.minTemp ?? 16}
              max={cap.thermostat?.maxTemp ?? 31}
              step={cap.thermostat?.step ?? 0.5}
              value={cap.thermostat?.targetTemp ?? 26}
              disabled={!cap.thermostat?.controllable}
              accessibilityLabel={t("targetTemperature")}
              onChange={() => {}}
              onChangeEnd={(val) =>
                cap.thermostat &&
                adjustThermostat(
                  cap.thermostat.entityId,
                  cap.thermostat.domain,
                  val,
                  cap.thermostat.minTemp,
                  cap.thermostat.maxTemp,
                  cap.thermostat.step,
                )
              }
            />
          </View>
        </If>

        {/* Mode Selection */}
        <If when={Boolean(cap.modeBar)}>
          <View class="rounded-2xl border border-border bg-card p-4 gap-2.5">
            <Text class="text-foreground text-sm font-semibold">{t("modeSelection")}</Text>
            <View class="flex-row items-center gap-2 flex-wrap">
              {(cap.modeBar?.options ?? []).map((opt) => (
                <Button
                  testID={`detail-mode-${opt.value}`}
                  disabled={!cap.modeBar?.controllable}
                  selected={cap.modeBar?.currentMode === opt.value}
                  onPress={() => cap.modeBar && selectMode(cap.modeBar, opt.value)}
                  class={
                    cap.modeBar?.currentMode === opt.value
                      ? "flex-1 min-w-20 min-h-11 px-3 rounded-xl bg-primary items-center justify-center active:opacity-75 disabled:opacity-40"
                      : "flex-1 min-w-20 min-h-11 px-3 rounded-xl bg-muted border border-border items-center justify-center active:opacity-75 disabled:opacity-40"
                  }
                >
                  <Text
                    class={
                      cap.modeBar?.currentMode === opt.value
                        ? "text-primary-foreground text-sm font-semibold"
                        : "text-foreground text-sm font-medium"
                    }
                  >
                    {opt.label}
                  </Text>
                </Button>
              ))}
            </View>
          </View>
        </If>

        {/* Action Triggers */}
        <If when={(cap.actions?.length ?? 0) > 0}>
          <View class="rounded-2xl border border-border bg-card p-4 gap-2.5">
            <Text class="text-foreground text-sm font-semibold">{t("primaryControls")}</Text>
            <View class="flex-row items-center gap-2 flex-wrap">
              {(cap.actions ?? []).map((act) => (
                <Button
                  testID={`detail-act-${act.id}`}
                  onPress={() => triggerAction(act)}
                  class={
                    act.tone === "primary"
                      ? "flex-1 min-w-28 min-h-12 px-4 rounded-xl bg-primary flex-row items-center justify-center gap-2 active:opacity-75"
                      : "flex-1 min-w-28 min-h-12 px-4 rounded-xl bg-muted border border-border flex-row items-center justify-center gap-2 active:opacity-75"
                  }
                >
                  <ActionIcon
                    name={resolveActionIconName(act)}
                    tone={act.tone === "primary" ? "primaryFg" : "foreground"}
                    size={16}
                  />
                  <Text
                    class={
                      act.tone === "primary"
                        ? "text-primary-foreground text-sm font-semibold"
                        : "text-foreground text-sm font-medium"
                    }
                  >
                    {act.label}
                  </Text>
                </Button>
              ))}
            </View>
          </View>
        </If>

        {/* Auxiliary Toggles */}
        <If when={(cap.auxiliaryToggles?.length ?? 0) > 0}>
          <View class="rounded-2xl border border-border bg-card p-4 gap-2.5">
            <Text class="text-foreground text-sm font-semibold">{t("auxiliaryFeatures")}</Text>
            <View class="flex-row items-center gap-2 flex-wrap">
              {(cap.auxiliaryToggles ?? []).map((tog) => (
                <Button
                  testID={`detail-aux-${tog.id}`}
                  disabled={!tog.controllable}
                  selected={tog.isOn}
                  onPress={() => togglePower(tog.entityId, tog.domain, tog.isOn)}
                  class={
                    tog.isOn
                      ? "min-h-11 px-3.5 rounded-xl bg-primary flex-row items-center justify-center gap-2 active:opacity-75 disabled:opacity-40"
                      : "min-h-11 px-3.5 rounded-xl bg-muted border border-border flex-row items-center justify-center gap-2 active:opacity-75 disabled:opacity-40"
                  }
                >
                  <ActionIcon
                    name={tog.isOn ? "check" : "power"}
                    tone={tog.isOn ? "primaryFg" : "muted"}
                    size={14}
                  />
                  <Text
                    class={
                      tog.isOn
                        ? "text-primary-foreground text-xs font-semibold"
                        : "text-foreground text-xs font-medium"
                    }
                  >
                    {tog.label}
                  </Text>
                </Button>
              ))}
            </View>
          </View>
        </If>

        {/* Read-only Security Notice for Smart Locks */}
        <If when={Boolean(cap.securityEvents)}>
          <View class="rounded-2xl border border-border bg-card p-4 gap-2">
            <View class="flex-row items-center gap-2">
              <ActionIcon name="shield" tone="verified" size={16} />
              <Text class="text-foreground text-sm font-semibold">
                {t("securityEventsTimeline")}
              </Text>
            </View>
            <Text class="text-muted-foreground text-xs">{t("readOnlySecurityNotice")}</Text>
            {(cap.securityEvents?.events ?? []).map((ev) => (
              <View class="flex-row items-center justify-between pt-1">
                <Text class="text-foreground text-xs font-medium">{ev.label}</Text>
                <Text class="text-muted-foreground text-xs">{ev.time}</Text>
              </View>
            ))}
          </View>
        </If>

        {/* Telemetry Metrics */}
        <If when={cap.telemetry.length > 0}>
          <View class="rounded-2xl border border-border bg-card p-4 gap-2.5">
            <Text class="text-foreground text-sm font-semibold">{t("telemetryMetrics")}</Text>
            <View class="flex-row items-center gap-2.5 flex-wrap">
              {cap.telemetry.map((m) => (
                <View
                  class="min-w-28 flex-1 rounded-xl bg-muted border border-border px-3.5 py-2.5 gap-0.5"
                >
                  <Text class="text-muted-foreground text-xs">{m.label}</Text>
                  <Text class="text-foreground text-base font-bold">{m.value}</Text>
                </View>
              ))}
            </View>
          </View>
        </If>
      </View>
    );
  };

  const renderFullPageApplianceView = (appliance: () => HomeAppliance) => {
    const power = () => appliance().capabilities.power;

    return (
      <Scroll class="flex-1" contentClass="p-4 gap-4">
        {/* Top Full-Page Navigation Header */}
        <View class="rounded-2xl border border-border bg-card px-4 py-3 flex-row items-center justify-between gap-3">
          <View
            class="flex-row items-center gap-3 flex-1"
            style={{ minWidth: 0 }}
          >
            <Button
              testID="home-detail-back"
              accessibilityLabel={t("backToRoom")}
              onPress={() => props.store.setHomeInspectedApplianceId(null)}
              class="min-h-10 px-3 rounded-xl bg-muted border border-border flex-row items-center justify-center gap-1.5 active:opacity-75"
            >
              <ActionIcon name="back" tone="foreground" size={16} />
              <Text class="text-foreground text-xs font-semibold">
                {t("backToRoom")}
              </Text>
            </Button>

            <View class="flex-1 gap-0.5" style={{ minWidth: 0 }}>
              <Text
                class="text-foreground text-lg font-bold"
                style={{ numberOfLines: 1 }}
              >
                {appliance().name}
              </Text>
              <Text
                class="text-muted-foreground text-xs"
                style={{ numberOfLines: 1 }}
              >
                {appliance().room} · {appliance().sourceLabel} ·{" "}
                {appliance().statusBadge}
              </Text>
            </View>
          </View>

          <If
            when={Boolean(power() && power()?.controllable)}
            else={
              <View
                class={
                  appliance().isActive
                    ? "px-3 py-1.5 rounded-full bg-live-active-bg border border-verified"
                    : "px-3 py-1.5 rounded-full bg-muted border border-border"
                }
              >
                <Text
                  class={
                    appliance().isActive
                      ? "text-verified text-xs font-semibold"
                      : "text-muted-foreground text-xs"
                  }
                >
                  {appliance().statusBadge}
                </Text>
              </View>
            }
          >
            <PowerIconButton
              testID={`detail-power-toggle-${appliance().id}`}
              isOn={Boolean(power()?.isOn)}
              disabled={!power()?.controllable}
              size="md"
              accessibilityLabel={power()?.isOn ? t("powerOff") : t("powerOn")}
              onPress={() =>
                power() &&
                togglePower(power()!.entityId, power()!.domain, power()!.isOn)
              }
            />
          </If>
        </View>

        {/* Specialized Full-Page Body by Appliance Type */}
        <If
          when={appliance().icon === "camera"}
          else={
            <If
              when={appliance().icon === "vacuum"}
              else={
                <If
                  when={appliance().archetype === "cycle_appliance"}
                  else={renderGenericApplianceFullPage(appliance())}
                >
                  {renderCycleApplianceFullPage(appliance())}
                </If>
              }
            >
              {renderVacuumFullPage(appliance())}
            </If>
          }
        >
          {renderCameraFullPage(appliance)}
        </If>
      </Scroll>
    );
  };

  const applianceKey = (app: HomeAppliance) =>
    [
      app.id,
      app.span,
      app.order,
      app.online,
      app.isActive,
      app.statusBadge,
      app.conciseSubtitle,
      app.capabilities.power?.isOn ?? "",
      app.capabilities.thermostat?.targetTemp ?? "",
      app.capabilities.thermostat?.currentTemp ?? "",
      app.capabilities.modeBar?.currentMode ?? "",
      app.capabilities.dimmer?.brightnessPercent ?? "",
      app.capabilities.dimmer?.colorTempKelvin ?? "",
      app.capabilities.cycleTask?.stageLabel ?? "",
      app.capabilities.cycleTask?.remainingMinutes ?? "",
      app.capabilities.vacuum?.mopModeBar?.currentMode ?? "",
      (app.capabilities.vacuum?.consumables ?? []).map((c) => `${c.id}=${c.percent}`).join(","),
      (app.capabilities.telemetry ?? []).map((m) => `${m.key}=${m.value}`).join(","),
      (app.capabilities.multiGang?.channels ?? []).map((c) => `${c.id}=${c.isOn}`).join(","),
      (app.capabilities.auxiliaryToggles ?? []).map((t) => `${t.id}=${t.isOn}`).join(","),
      (app.capabilities.visionStream?.featureToggles ?? []).map((t) => `${t.id}=${t.isOn}`).join(","),
      (app.capabilities.visionStream?.modeSelectors ?? [])
        .map((s) => `${s.id}=${s.capability.currentMode}`)
        .join(","),
    ].join(":");

  // --- Devices Sub-View (Left Room Sidebar + Right Bento Grid) ---
  const renderDevicesSubView = () => (
    <If
      when={dashboard().rooms.length > 0}
      else={
        <If
          when={props.store.homeLoading()}
          else={
            <Scroll class="flex-1" contentClass="grow justify-center p-6">
              <View class="max-w-lg mx-auto rounded-3xl border border-border bg-card p-6 items-center gap-4">
                <ApplianceIcon kind="light" active={true} size="lg" />
                <Text class="text-foreground text-xl font-bold text-center">
                  {t("noHomeSourceEnabledTitle")}
                </Text>
                <Text class="text-muted-foreground text-sm text-center">
                  {t("noHomeSourceEnabledDesc")}
                </Text>
                <View class="flex-row items-center gap-3 flex-wrap justify-center mt-1">
                  <ActionButton
                    testID="home-empty-open-services"
                    kind="primary"
                    label={t("openServiceBinding")}
                    onPress={() => props.store.setHomeSubView("services")}
                  />
                  <ActionButton
                    testID="home-empty-enable-sim"
                    label={t("enableFullHouseDemo")}
                    onPress={() => void props.store.setHomeSourceEnabled("simulation", true)}
                  />
                </View>
              </View>
            </Scroll>
          }
        >
          <View class="flex-1 items-center justify-center p-6">
            <LoadingIndicator testID="home-devices-loading" label={t("loadingHomeDevices")} />
          </View>
        </If>
      }
    >
      <View class={isWide() ? "flex-1 flex-row" : "flex-1"} style={{ minHeight: 0 }}>
        {/* Left Room Navigation Sidebar (or Top Bar on narrow screens) */}
        <If
          when={isWide()}
          else={
            <View class="px-4 pt-2.5 pb-1.5 border-b border-border bg-card">
              <Scroll
                horizontal={true}
                scrollbar={false}
                contentClass="flex-row items-center gap-1.5"
              >
                <Button
                  testID="home-room-pill-all"
                  selected={selectedRoomName() === "all"}
                  onPress={() => props.store.setHomeSelectedRoom("all")}
                  class={
                    selectedRoomName() === "all"
                      ? "min-h-9 px-3.5 rounded-full bg-primary items-center justify-center active:opacity-75"
                      : "min-h-9 px-3.5 rounded-full bg-muted border border-border items-center justify-center active:opacity-75"
                  }
                >
                  <Text
                    class={
                      selectedRoomName() === "all"
                        ? "text-primary-foreground text-xs font-semibold"
                        : "text-foreground text-xs font-medium"
                    }
                  >
                    {t("allRoomsOverview")} ({dashboard().totalAppliances})
                  </Text>
                </Button>
                <Each of={dashboard().rooms} key={(rm) => rm.id}>
                  {(rm) => (
                    <Button
                      testID={`home-room-pill-${rm().name}`}
                      selected={selectedRoomName() === rm().name}
                      onPress={() => props.store.setHomeSelectedRoom(rm().name)}
                      class={
                        selectedRoomName() === rm().name
                          ? "min-h-9 px-3.5 rounded-full bg-primary items-center justify-center active:opacity-75"
                          : "min-h-9 px-3.5 rounded-full bg-muted border border-border items-center justify-center active:opacity-75"
                      }
                    >
                      <Text
                        class={
                          selectedRoomName() === rm().name
                            ? "text-primary-foreground text-xs font-semibold"
                            : "text-foreground text-xs font-medium"
                        }
                      >
                        {rm().name} ({rm().activeCount}/{rm().totalCount})
                      </Text>
                    </Button>
                  )}
                </Each>
              </Scroll>
            </View>
          }
        >
          <View
            class="border-r border-border bg-card p-3 gap-2"
            style={{ width: 204, minHeight: 0 }}
          >
            <View class="px-2 py-1 flex-row items-center justify-between">
              <Text class="text-muted-foreground text-xs font-semibold">
                {dashboard().homeName}
              </Text>
              <Text class="text-muted-foreground text-xs">
                {t("activeCountSummary", {
                  active: dashboard().activeAppliances,
                  total: dashboard().totalAppliances,
                })}
              </Text>
            </View>

            <Scroll class="flex-1" scrollbar={false} contentClass="gap-1.5">
              <Button
                testID="home-room-nav-all"
                selected={selectedRoomName() === "all"}
                onPress={() => props.store.setHomeSelectedRoom("all")}
                class={
                  selectedRoomName() === "all"
                    ? "w-full rounded-xl bg-primary px-3 py-2.5 items-start gap-0.5 active:opacity-75"
                    : "w-full rounded-xl bg-muted border border-border px-3 py-2.5 items-start gap-0.5 active:opacity-75"
                }
              >
                <Text
                  class={
                    selectedRoomName() === "all"
                      ? "text-primary-foreground text-sm font-semibold"
                      : "text-foreground text-sm font-medium"
                  }
                >
                  {t("allRoomsOverview")}
                </Text>
                <Text
                  class={
                    selectedRoomName() === "all"
                      ? "text-primary-foreground text-xs opacity-80"
                      : "text-muted-foreground text-xs"
                  }
                >
                  {t("activeCountSummary", {
                    active: dashboard().activeAppliances,
                    total: dashboard().totalAppliances,
                  })}
                </Text>
              </Button>

              <Each of={dashboard().rooms} key={(rm) => rm.id}>
                {(rm) => (
                  <Button
                    testID={`home-room-nav-${rm().name}`}
                    selected={selectedRoomName() === rm().name}
                    onPress={() => props.store.setHomeSelectedRoom(rm().name)}
                    class={
                      selectedRoomName() === rm().name
                        ? "w-full rounded-xl bg-primary px-3 py-2.5 items-start gap-0.5 active:opacity-75"
                        : "w-full rounded-xl bg-card border border-border px-3 py-2.5 items-start gap-0.5 active:bg-muted"
                    }
                  >
                    <View class="w-full flex-row items-center justify-between">
                      <Text
                        class={
                          selectedRoomName() === rm().name
                            ? "text-primary-foreground text-sm font-semibold"
                            : "text-foreground text-sm font-medium"
                        }
                        style={{ numberOfLines: 1 }}
                      >
                        {rm().name}
                      </Text>
                      <If when={rm().activeCount > 0}>
                        <View
                          class={
                            selectedRoomName() === rm().name
                              ? "w-2 h-2 rounded-full bg-primary-foreground"
                              : "w-2 h-2 rounded-full bg-verified"
                          }
                        />
                      </If>
                    </View>
                    <Text
                      class={
                        selectedRoomName() === rm().name
                          ? "text-primary-foreground text-xs opacity-80"
                          : "text-muted-foreground text-xs"
                      }
                      style={{ numberOfLines: 1 }}
                    >
                      {[
                        rm().environment.find((e) => e.key === "temperature")?.value,
                        t("activeCountSummary", {
                          active: rm().activeCount,
                          total: rm().totalCount,
                        }),
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </Text>
                  </Button>
                )}
              </Each>
            </Scroll>
          </View>
        </If>

        {/* Right Scrollable Multi-Size Bento Canvas */}
        <Scroll class="flex-1" contentClass="p-4 gap-5">
          {/* Active Layout Editing Banner */}
          <If when={layoutEditing()}>
            <View class="rounded-2xl border border-primary bg-card px-4 py-2.5 flex-row items-center justify-between gap-3">
              <View class="flex-row items-center gap-2 flex-1" style={{ minWidth: 0 }}>
                <ActionIcon name="edit" tone="primary" size={16} />
                <Text class="text-foreground text-xs font-semibold flex-1" style={{ numberOfLines: 2 }}>
                  {t("layoutEditBanner")}
                </Text>
              </View>
              <Button
                testID="home-layout-banner-done"
                onPress={() => {
                  movingApplianceId.set(null);
                  props.store.setHomeLayoutEditing(false);
                }}
                class="min-h-8 px-3.5 rounded-full bg-primary flex-row items-center justify-center gap-1.5 active:opacity-75"
              >
                <ActionIcon name="check" tone="primaryFg" size={14} />
                <Text class="text-primary-foreground text-xs font-semibold">
                  {t("doneLayout")}
                </Text>
              </Button>
            </View>
          </If>

          <Each of={visibleRooms()} key={(room) => room.id}>
            {(room) => (
              <View class="gap-3">
                {/* Room Section Header + Environment Strip + Batch Room Power */}
                <View class="flex-row items-center justify-between gap-2 flex-wrap">
                  <View class="flex-row items-center gap-2 flex-wrap">
                    <Text class="text-foreground text-lg font-bold" role="header">
                      {room().name}
                    </Text>
                    <Each of={room().environment.slice(0, 4)} key={(env) => env.key}>
                      {(env) => (
                        <View class="px-2.5 py-1 rounded-full bg-card border border-border flex-row items-center gap-1">
                          <Text class="text-muted-foreground text-xs">{env().label}</Text>
                          <Text class="text-foreground text-xs font-semibold">{env().value}</Text>
                        </View>
                      )}
                    </Each>
                  </View>

                  <View class="flex-row items-center gap-1.5">
                    <If when={!layoutEditing()}>
                      <Button
                        testID={`home-room-edit-${room().name}`}
                        accessibilityLabel={t("longPressEditHint")}
                        onPress={() => props.store.setHomeLayoutEditing(true)}
                        class="min-h-8 px-2.5 rounded-lg bg-card border border-border flex-row items-center justify-center gap-1 active:opacity-75"
                      >
                        <ActionIcon name="edit" tone="muted" size={13} />
                        <Text class="text-muted-foreground text-xs">
                          {t("editLayout")}
                        </Text>
                      </Button>
                    </If>
                    <If when={room().roomPowerEntities.turnOnIds.length > 0}>
                      <Button
                        testID={`home-room-on-${room().name}`}
                        onPress={() => void props.store.controlRoomPower(room().name, true)}
                        class="min-h-8 px-2.5 rounded-lg bg-card border border-border flex-row items-center justify-center gap-1 active:opacity-75"
                      >
                        <ActionIcon name="power" tone="verified" size={13} />
                        <Text class="text-foreground text-xs font-medium">{t("allOn")}</Text>
                      </Button>
                    </If>
                    <If when={room().roomPowerEntities.turnOffIds.length > 0}>
                      <Button
                        testID={`home-room-off-${room().name}`}
                        onPress={() => void props.store.controlRoomPower(room().name, false)}
                        class="min-h-8 px-2.5 rounded-lg bg-card border border-border flex-row items-center justify-center gap-1 active:opacity-75"
                      >
                        <ActionIcon name="power" tone="muted" size={13} />
                        <Text class="text-muted-foreground text-xs font-medium">{t("allOff")}</Text>
                      </Button>
                    </If>
                  </View>
                </View>

                {/* CSS Grid with dense packing for 1x1, 2x1, 2x2 Bento tiles */}
                <View
                  style={{
                    display: "grid",
                    gridTemplateColumns: `repeat(${gridColumns()}, 1fr)`,
                    gridAutoFlow: "row dense",
                    gap: 12,
                  }}
                >
                  <Each of={room().appliances} key={applianceKey}>
                    {(app) => renderApplianceCard(room(), app())}
                  </Each>
                </View>
              </View>
            )}
          </Each>
        </Scroll>
      </View>
    </If>
  );

  // --- Services Sub-View (Concurrent Multi-Source Binding) ---
  const renderServicesSubView = () => {
    const enabledSources = () =>
      saved().enabledSources ?? {
        direct_miot: saved().mode === "direct_miot",
        external_ha: saved().mode === "external_ha",
        simulation: saved().mode === "simulation",
      };

    const saveHa = async () => {
      busy.set(true);
      try {
        await props.store.configureHome({
          mode: "external_ha",
          haUrl: haUrl(),
          region: region(),
          enabledSources: {
            ...enabledSources(),
            external_ha: true,
          },
          ...(token().trim() ? { accessToken: token().trim() } : {}),
        });
        token.set("");
      } finally {
        busy.set(false);
      }
    };

    const loginXiaomi = async () => {
      await props.store.loginMiot(region());
    };

    const savedMiotSelected = () =>
      saved().hasMiotAccount && region() === saved().region;

    const refreshMiot = async () => {
      if (busy()) return;
      busy.set(true);
      try {
        if (saved().mode !== "direct_miot") {
          await props.store.configureHome({
            mode: "direct_miot",
            region: region(),
          });
        }
        await props.store.connectHome();
        if (typeof props.store.setHomeSubView === "function") {
          props.store.setHomeSubView("devices");
        }
      } finally {
        busy.set(false);
      }
    };

    const sourceCards = (): Array<{
      id: HomeSourceId;
      title: string;
      subtitle: string;
      enabled: boolean;
    }> => [
      {
        id: "direct_miot",
        title: t("xiaomiHome92"),
        subtitle: saved().hasMiotAccount ? t("signedIn") : t("signInToXiaomiHome"),
        enabled: Boolean(enabledSources().direct_miot),
      },
      {
        id: "external_ha",
        title: "Home Assistant",
        subtitle: saved().haUrl || "http://homeassistant.local:8123",
        enabled: Boolean(enabledSources().external_ha),
      },
      {
        id: "simulation",
        title: t("offlineDemo"),
        subtitle: t("virtualDevicesStoredInLocalMemory"),
        enabled: Boolean(enabledSources().simulation),
      },
    ];

    return (
      <Scroll class="flex-1" contentClass="p-5 gap-4">
        <View class="max-w-3xl w-full mx-auto gap-4">
          <View class="rounded-2xl border border-border bg-card px-4 py-3 flex-row items-center justify-between gap-3">
            <Text class="text-muted-foreground text-xs flex-1">
              {t("multiSourceConcurrentHint")}
            </Text>
          </View>

          <View class={isWide() ? "flex-row items-stretch gap-3" : "gap-3"}>
            <Each of={sourceCards()} key={(sc) => `${sc.id}:${sc.enabled}:${sc.subtitle}`}>
              {(sc) => (
                <View
                  class={
                    activeServiceTab() === sc().id
                      ? "flex-1 rounded-2xl border-2 border-ring bg-card p-4 justify-between gap-3"
                      : "flex-1 rounded-2xl border border-border bg-card p-4 justify-between gap-3"
                  }
                >
                  <Button
                    testID={`home-service-tab-${sc().id}`}
                    onPress={() => activeServiceTab.set(sc().id)}
                    class="items-start gap-1 active:opacity-75"
                  >
                    <View class="w-full flex-row items-center justify-between gap-2">
                      <Text class="text-foreground text-base font-bold">{sc().title}</Text>
                      <View
                        class={
                          sc().enabled
                            ? "px-2 py-0.5 rounded-full bg-live-active-bg border border-verified"
                            : "px-2 py-0.5 rounded-full bg-muted border border-border"
                        }
                      >
                        <Text
                          class={
                            sc().enabled
                              ? "text-verified text-xs font-semibold"
                              : "text-muted-foreground text-xs"
                          }
                        >
                          {sc().enabled ? t("sourceEnabled") : t("sourceDisabled")}
                        </Text>
                      </View>
                    </View>
                    <Text class="text-muted-foreground text-xs" style={{ numberOfLines: 1 }}>
                      {sc().subtitle}
                    </Text>
                  </Button>

                  <View class="flex-row items-center justify-between gap-2 pt-2 border-t border-border">
                    <Button
                      testID={`home-source-toggle-${sc().id}`}
                      selected={sc().enabled}
                      onPress={() => void props.store.setHomeSourceEnabled(sc().id, !sc().enabled)}
                      class={
                        sc().enabled
                          ? "flex-1 min-h-9 rounded-xl bg-muted border border-border items-center justify-center active:opacity-75"
                          : "flex-1 min-h-9 rounded-xl bg-primary items-center justify-center active:opacity-75"
                      }
                    >
                      <Text
                        class={
                          sc().enabled
                            ? "text-foreground text-xs font-medium"
                            : "text-primary-foreground text-xs font-semibold"
                        }
                      >
                        {sc().enabled ? t("disableSource") : t("enableSource")}
                      </Text>
                    </Button>
                  </View>
                </View>
              )}
            </Each>
          </View>

          <If when={activeServiceTab() === "direct_miot"}>
            <View class="rounded-2xl border border-border bg-card p-5 gap-4">
              <View class="gap-1">
                <Text class="text-foreground text-lg font-semibold" role="header">
                  {t("connectYourXiaomiHomeAccount")}
                </Text>
                <Text class="text-muted-foreground text-xs">
                  {t("cloudSyncOutletsLightsAndTemperaturehumiditySensors")}
                </Text>
              </View>

              <SelectField
                testID="home-miot-region"
                label={t("xiaomiHomeRegion")}
                items={REGIONS()}
                value={region()}
                disabled={props.store.homeLoggingIn()}
                onChange={(value) => region.set(value)}
              />

              <View class="flex-row flex-wrap gap-2">
                <ActionButton
                  testID="home-miot-login"
                  kind="primary"
                  disabled={props.store.homeLoggingIn()}
                  label={
                    props.store.homeLoggingIn()
                      ? t("waitingForXiaomiAuthorization")
                      : savedMiotSelected()
                        ? t("signInToXiaomiHomeAgain")
                        : t("signInToXiaomiHome")
                  }
                  onPress={() => void loginXiaomi()}
                />
                <If when={props.store.homeLoggingIn()}>
                  <ActionButton
                    testID="home-miot-cancel"
                    label={t("cancelXiaomiSignin")}
                    onPress={() => props.store.cancelHomeLogin()}
                  />
                </If>
                <If when={savedMiotSelected()}>
                  <ActionButton
                    testID="home-miot-refresh"
                    disabled={busy() || props.store.homeLoggingIn()}
                    label={
                      saved().mode === "direct_miot"
                        ? t("refreshXiaomiDevices")
                        : t("connectSavedXiaomiAccount")
                    }
                    onPress={() => void refreshMiot()}
                  />
                </If>
                <If
                  when={
                    saved().mode === "direct_miot" &&
                    savedMiotSelected() &&
                    !props.store.homeLoggingIn()
                  }
                >
                  <ActionButton
                    testID="home-miot-logout"
                    kind="danger"
                    label={t("signOutOfXiaomiHome")}
                    onPress={() => void props.store.logoutMiot()}
                  />
                </If>
              </View>
            </View>
          </If>

          <If when={activeServiceTab() === "external_ha"}>
            <View class="rounded-2xl border border-border bg-card p-5 gap-4">
              <View class="gap-1">
                <Text class="text-foreground text-lg font-semibold" role="header">
                  {t("connectAHomeAssistantInstance")}
                </Text>
                <Text class="text-muted-foreground text-xs">
                  {t("directLocalOrRemoteWebsocketApiConnection")}
                </Text>
              </View>

              <TextField
                testID="home-url"
                label={t("homeAssistantServerUrl")}
                value={haUrl()}
                onChange={(v) => haUrl.set(v)}
                placeholder="http://homeassistant.local:8123"
              />
              <TextField
                testID="home-token"
                label={t("longlivedAccessToken76")}
                value={token()}
                onChange={(v) => token.set(v)}
                masked={true}
                placeholder={
                  saved().hasToken
                    ? t("savedSecurelyLeaveBlankToReuseWith")
                    : t("enterAccessToken")
                }
              />
              <View class="flex-row flex-wrap gap-2">
                <ActionButton
                  testID="home-connect"
                  kind="primary"
                  disabled={busy()}
                  label={busy() ? t("connecting48") : t("connectHomeAssistant")}
                  onPress={() => void saveHa()}
                />
              </View>
            </View>
          </If>

          <If when={activeServiceTab() === "simulation"}>
            <View class="rounded-2xl border border-border bg-card p-5 gap-3">
              <Text class="text-foreground text-lg font-semibold" role="header">
                {t("offlineDemoEnvironment")}
              </Text>
              <Text class="text-muted-foreground text-sm">
                {t("tryAStudyCeilingLightDeskLamp")}
              </Text>
              <View class="flex-row justify-end pt-1">
                <ActionButton
                  label={t("enableDemoDevices")}
                  testID="home-simulation"
                  kind="primary"
                  compact={true}
                  disabled={busy()}
                  onPress={() => void props.store.setHomeSourceEnabled("simulation", true)}
                />
              </View>
            </View>
          </If>

          <If when={translateMessage(props.store.homeConnection()?.error || "")}>
            <View class="rounded-xl border border-destructive bg-muted p-3">
              <Text role="alert" class="text-destructive text-xs font-medium">
                {translateMessage(props.store.homeConnection()?.error || "")}
              </Text>
            </View>
          </If>
        </View>
      </Scroll>
    );
  };

  return (
    <View class="flex-1 bg-background" style={{ minHeight: 0 }}>
      <If
        when={subView() === "services"}
        else={
          <If
            when={Boolean(inspectedAppliance())}
            else={renderDevicesSubView()}
          >
            <Each
              of={inspectedAppliance() ? [inspectedAppliance()!] : []}
              key={(appliance) =>
                appliance.icon === "camera"
                  ? appliance.id
                  : applianceKey(appliance)
              }
            >
              {(app) => renderFullPageApplianceView(app)}
            </Each>
          </If>
        }
      >
        {renderServicesSubView()}
      </If>
    </View>
  );
}
