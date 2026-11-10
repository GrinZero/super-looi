import { CameraVideo } from "./CameraVideo";
import { t, translateMessage } from "../i18n";
import { effect, signal, Text, View, Scroll, windowSize } from "nsh";
import { Button, Switch } from "nsh/base";
import { RetainedPage } from "./RetainedPage";
import type { createAppStore, HomeSubView } from "../store";
import { ActionButton, HorizontalValueSlider, LoadingIndicator, SelectField, TextField } from "./Controls";
import { ActionIcon, ApplianceIcon, PowerIconButton, type ActionIconName } from "./HomeIcons";
import { MijiaBrandIcon, HomeAssistantBrandIcon } from "./brand-icons";
import { XiaomiVideoLoginFlow } from "./XiaomiVideoLoginFlow";
import type {
  ChoiceControlPrimitive,
  RangeControlPrimitive,
  ToggleControlPrimitive,
} from "@super-looi/home-devices";
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

function resolveActionIconName(trigger: { iconKey?: ActionIconName; label: string }): ActionIconName {
  if (trigger.iconKey) {
    return trigger.iconKey;
  }
  if (/左转/.test(trigger.label)) return "rotate_left";
  if (/右转/.test(trigger.label)) return "rotate_right";
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

const BASE_ROW_HEIGHT = 116;
const GRID_GAP = 12;

function parseSpanDims(span: TileSpan): { cols: 1 | 2; rows: 1 | 2 } {
  return {
    cols: span === "2x1" || span === "2x2" ? 2 : 1,
    rows: span === "1x2" || span === "2x2" ? 2 : 1,
  };
}

function formatSpanDims(cols: 1 | 2, rows: 1 | 2): TileSpan {
  return `${cols}x${rows}` as TileSpan;
}

/** The native player has its own stable source; device refreshes update controls. */
function CameraMonitor(props: {
  store: ReturnType<typeof createAppStore>;
  statusText?: string;
  resolutionBadge?: string;
}) {
  const playback = () => props.store.homeCamera();
  return (
    <View class="rounded-2xl border border-border bg-card p-4 gap-3">
      <View
        class="w-full rounded-xl overflow-hidden bg-secondary items-center justify-center"
        style={{ aspectRatio: "16 / 9", minHeight: 210, maxHeight: 310 }}
      >
        <Each of={playback().sessionId ? [playback().sessionId!] : []} key={(id) => id}>
          {(id) => <CameraVideo testID="home-camera-video" sessionId={id()} class="absolute inset-0" onState={event => props.store.homeCameraState(event)} />}
        </Each>
        <If when={!playback().sessionId}>
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
            <If when={playback().phase !== "loading" && !playback().error}>
              <Text class="text-muted-foreground text-sm">
                {props.statusText ?? "暂未接入实时视频流"}
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
                  ? (props.statusText ?? t("cameraStopped"))
                  : t("cameraWaiting")}
          </Text>
          <If when={Boolean(playback().width && playback().height)}>
            <Text class="text-muted-foreground text-xs">{`${playback().width} × ${playback().height}`}</Text>
          </If>
          <If when={!playback().width && Boolean(props.resolutionBadge)}>
            <Text class="text-muted-foreground text-xs">{props.resolutionBadge}</Text>
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
  const subView = (): HomeSubView =>
    typeof props.store.homeSubView === "function"
      ? props.store.homeSubView()
      : "services";
  const selectedRoomName = (): string =>
    typeof props.store.homeSelectedRoom === "function"
      ? props.store.homeSelectedRoom()
      : "all";
  const editingRoomName = (): string | null => {
    if (typeof props.store.homeLayoutEditing !== "function") return null;
    const raw: unknown = props.store.homeLayoutEditing();
    if (typeof raw === "string" && raw.length > 0) return raw;
    if (raw === true) {
      return dashboard().rooms[0]?.name ?? null;
    }
    return null;
  };
  const isRoomEditing = (roomName: string): boolean =>
    editingRoomName() === roomName;
  const layoutEditing = (): boolean => editingRoomName() !== null;
  const inspectedId = (): string | null =>
    typeof props.store.homeInspectedApplianceId === "function"
      ? props.store.homeInspectedApplianceId()
      : null;

  // Track the currently selected block in free layout editing mode for 2-tap swap/placement
  const movingApplianceId = signal<string | null>(null);
  const openRoomMenu = signal<string | null>(null);
  const canvasWidth = signal<number>(0);
  const overviewCollapsed = () => props.store.homeOverviewCollapsed();
  const resizePreview = signal<{
    applianceId: string;
    targetSpan: TileSpan;
  } | null>(null);
  const reorderPreview = signal<{
    roomId: string;
    appliances: HomeAppliance[];
  } | null>(null);

  let activeResizeGesture: {
    applianceId: string;
    startX: number;
    startY: number;
    initialCols: 1 | 2;
    initialRows: 1 | 2;
    currentCols: 1 | 2;
    currentRows: 1 | 2;
    mode: "right" | "bottom" | "corner";
    didDrag: boolean;
  } | null = null;

  let activeCardDragGesture: {
    roomName: string;
    applianceId: string;
    startX: number;
    startY: number;
    didDrag: boolean;
  } | null = null;

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

  const isWide = () => windowSize().width >= 600;
  const usableCanvasWidth = () => {
    const measured = canvasWidth();
    if (measured > 0) {
      return Math.max(208, measured - 28);
    }
    const winW = windowSize().width;
    return Math.max(208, isWide() && !overviewCollapsed() ? winW - 196 - 48 : winW - 48);
  };
  const gridColumns = () => {
    const usable = usableCanvasWidth();
    if (isWide()) {
      return Math.max(2, Math.floor((usable + GRID_GAP) / (180 + GRID_GAP)));
    }
    return Math.max(1, Math.floor((usable + GRID_GAP) / (180 + GRID_GAP)));
  };
  const singleColumnWidth = () => {
    const cols = gridColumns();
    const usable = usableCanvasWidth();
    return Math.max(160, (usable - (cols - 1) * GRID_GAP) / cols);
  };

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

  const enterLayoutEditWithCard = (roomName: string, applianceId: string) => {
    props.store.setHomeInspectedApplianceId(null);
    openRoomMenu.set(null);
    props.store.setHomeLayoutEditing(roomName);
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
    const payloadValue =
      modeCap.parameterKey === "percentage" || modeCap.service === "set_percentage"
        ? Number(nextOption)
        : nextOption;
    void props.store.controlHomeAppliance({
      entity_id: modeCap.entityId,
      domain: modeCap.domain,
      service: modeCap.service,
      service_data: { [modeCap.parameterKey]: payloadValue },
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

  const dispatchTogglePrimitive = (ctrl: ToggleControlPrimitive) => {
    const service = ctrl.isOn ? (ctrl.serviceOff ?? "turn_off") : (ctrl.serviceOn ?? "turn_on");
    const serviceData = (ctrl.isOn ? ctrl.serviceDataOff : ctrl.serviceDataOn) ?? {};
    if (
      (service === "turn_on" || service === "turn_off") &&
      Object.keys(serviceData).length === 0
    ) {
      togglePower(ctrl.entityId, ctrl.domain, ctrl.isOn);
      return;
    }
    void props.store.controlHomeAppliance({
      entity_id: ctrl.entityId,
      domain: ctrl.domain,
      service,
      service_data: serviceData,
    });
  };

  const dispatchChoicePrimitive = (ctrl: ChoiceControlPrimitive, nextOption: string) => {
    const payloadValue =
      ctrl.parameterKey === "percentage" || ctrl.service === "set_percentage"
        ? Number(nextOption)
        : nextOption;
    void props.store.controlHomeAppliance({
      entity_id: ctrl.entityId,
      domain: ctrl.domain,
      service: ctrl.service,
      service_data: { [ctrl.parameterKey]: payloadValue },
    });
  };

  const dispatchRangePrimitive = (ctrl: RangeControlPrimitive, rawValue: number) => {
    const step = ctrl.step > 0 ? ctrl.step : 1;
    const clamped = Math.max(ctrl.min, Math.min(ctrl.max, Math.round(rawValue / step) * step));
    if (
      (ctrl.id === "brightness" || ctrl.parameterKey === "brightness_pct") &&
      ctrl.domain === "light"
    ) {
      setLightBrightness(ctrl.entityId, clamped);
      return;
    }
    if (
      (ctrl.id === "color_temp" || ctrl.parameterKey === "color_temp_kelvin") &&
      ctrl.domain === "light"
    ) {
      setLightColorTemp(ctrl.entityId, clamped);
      return;
    }
    void props.store.controlHomeAppliance({
      entity_id: ctrl.entityId,
      domain: ctrl.domain,
      service: ctrl.service,
      service_data: { [ctrl.parameterKey]: clamped },
    });
  };

  const previewApplianceOrder = (room: HomeRoomSection, appliance: HomeAppliance, delta: number) => {
    if (delta === 0) return;
    const currentPreview = reorderPreview();
    const baseList =
      currentPreview && currentPreview.roomId === room.id
        ? currentPreview.appliances
        : (dashboard().rooms.find((r) => r.id === room.id) ?? room).appliances;
    const idx = baseList.findIndex((a) => a.id === appliance.id);
    if (idx < 0) return;
    const targetIdx = Math.max(0, Math.min(baseList.length - 1, idx + delta));
    if (targetIdx === idx) return;
    const nextList = [...baseList];
    const [moved] = nextList.splice(idx, 1);
    if (!moved) return;
    nextList.splice(targetIdx, 0, moved);
    reorderPreview.set({
      roomId: room.id,
      appliances: nextList,
    });
  };

  const commitApplianceOrderPreview = (roomId: string) => {
    const currentPreview = reorderPreview();
    reorderPreview.set(null);
    if (!currentPreview || currentPreview.roomId !== roomId) return;
    void props.store.reorderHomeAppliances(
      currentPreview.appliances.map((item, i) => ({ id: item.id, order: (i + 1) * 10 })),
    );
  };

  const startResizeGesture = (
    appliance: HomeAppliance,
    mode: "right" | "bottom" | "corner",
    x: number,
    y: number,
  ) => {
    const dims = parseSpanDims(appliance.span);
    activeResizeGesture = {
      applianceId: appliance.id,
      startX: x,
      startY: y,
      initialCols: dims.cols,
      initialRows: dims.rows,
      currentCols: dims.cols,
      currentRows: dims.rows,
      mode,
      didDrag: false,
    };
    resizePreview.set({
      applianceId: appliance.id,
      targetSpan: appliance.span,
    });
  };

  const updateResizeGesture = (appliance: HomeAppliance, x: number, y: number) => {
    if (!activeResizeGesture || activeResizeGesture.applianceId !== appliance.id) return;
    const dx = x - activeResizeGesture.startX;
    const dy = y - activeResizeGesture.startY;
    if (Math.max(Math.abs(dx), Math.abs(dy)) > 12) activeResizeGesture.didDrag = true;
    let nextCols = activeResizeGesture.currentCols;
    let nextRows = activeResizeGesture.currentRows;
    const halfCol = Math.min(96, Math.max(44, singleColumnWidth() * 0.5));
    const halfRow = BASE_ROW_HEIGHT * 0.5;
    const hysteresis = 8;

    if (activeResizeGesture.mode === "right" || activeResizeGesture.mode === "corner") {
      if (activeResizeGesture.initialCols === 1) {
        if (dx >= halfCol + hysteresis) nextCols = 2;
        else if (dx <= halfCol - hysteresis) nextCols = 1;
      } else {
        if (dx <= -(halfCol + hysteresis)) nextCols = 1;
        else if (dx >= -(halfCol - hysteresis)) nextCols = 2;
      }
    }

    if (activeResizeGesture.mode === "bottom" || activeResizeGesture.mode === "corner") {
      if (activeResizeGesture.initialRows === 1) {
        if (dy >= halfRow + hysteresis) nextRows = 2;
        else if (dy <= halfRow - hysteresis) nextRows = 1;
      } else {
        if (dy <= -(halfRow + hysteresis)) nextRows = 1;
        else if (dy >= -(halfRow - hysteresis)) nextRows = 2;
      }
    }

    activeResizeGesture.currentCols = nextCols;
    activeResizeGesture.currentRows = nextRows;
    const targetSpan = formatSpanDims(nextCols, nextRows);
    const currentPreview = resizePreview();
    if (!currentPreview || currentPreview.targetSpan !== targetSpan) {
      resizePreview.set({
        applianceId: appliance.id,
        targetSpan,
      });
    }
  };

  let lastResizeTouchEndMs = 0;

  const endResizeGesture = (appliance: HomeAppliance, mode: "right" | "bottom" | "corner") => {
    const gesture = activeResizeGesture;
    activeResizeGesture = null;
    const preview = resizePreview();
    resizePreview.set(null);

    if (gesture && gesture.applianceId === appliance.id && gesture.didDrag && preview) {
      if (preview.targetSpan !== appliance.span) {
        setApplianceSpan(appliance, preview.targetSpan);
      }
      return;
    }

    // Tap fallback on resize handles for quick one-handed or accessibility toggling
    const dims = parseSpanDims(appliance.span);
    if (mode === "right") {
      const nextCols: 1 | 2 = dims.cols === 1 ? 2 : 1;
      setApplianceSpan(appliance, formatSpanDims(nextCols, dims.rows));
    } else if (mode === "bottom") {
      const nextRows: 1 | 2 = dims.rows === 1 ? 2 : 1;
      setApplianceSpan(appliance, formatSpanDims(dims.cols, nextRows));
    } else {
      const order: TileSpan[] = ["1x1", "2x1", "1x2", "2x2"];
      const idx = order.indexOf(appliance.span);
      const nextSpan = order[(idx + 1) % order.length] ?? "1x1";
      setApplianceSpan(appliance, nextSpan);
    }
  };

  // --- Bento Card Sub-Renderers ---

  const renderEditHandlesOverlay = (app: () => HomeAppliance) => {
    return (
      <View
        style={{
          position: "absolute",
          top: 0,
          right: 0,
          bottom: 0,
          left: 0,
          pointerEvents: "box-none",
        }}
      >
        {/* Right Edge Resize Handle (44dp wide touch zone) */}
        <View
          testID={`home-resize-right-${app().id}`}
          panActivation={{ activeOffsetX: 0, activeOffsetY: 0 }}
          onResponderGrant={() => true}
          role="button"
          accessibilityLabel={`${app().displayName ?? app().name} 调整宽度`}
          onTouchStart={(e) => startResizeGesture(app(), "right", e.pageX, e.pageY)}
          onTouchMove={(e) => updateResizeGesture(app(), e.pageX, e.pageY)}
          onTouchEnd={() => {
            lastResizeTouchEndMs = Date.now();
            endResizeGesture(app(), "right");
          }}
          onPress={() => {
            if (Date.now() - lastResizeTouchEndMs < 400) return;
            endResizeGesture(app(), "right");
          }}
          onTouchCancel={() => {
            activeResizeGesture = null;
            resizePreview.set(null);
          }}
          style={{
            position: "absolute",
            right: -6,
            top: 20,
            bottom: 36,
            width: 44,
          }}
          class="items-end justify-center pr-2"
        >
          <View class="w-1.5 h-8 rounded-full bg-primary opacity-75" />
        </View>

        {/* Bottom Edge Resize Handle (44dp tall touch zone) */}
        <View
          testID={`home-resize-bottom-${app().id}`}
          panActivation={{ activeOffsetX: 0, activeOffsetY: 0 }}
          onResponderGrant={() => true}
          role="button"
          accessibilityLabel={`${app().displayName ?? app().name} 调整高度`}
          onTouchStart={(e) => startResizeGesture(app(), "bottom", e.pageX, e.pageY)}
          onTouchMove={(e) => updateResizeGesture(app(), e.pageX, e.pageY)}
          onTouchEnd={() => {
            lastResizeTouchEndMs = Date.now();
            endResizeGesture(app(), "bottom");
          }}
          onPress={() => {
            if (Date.now() - lastResizeTouchEndMs < 400) return;
            endResizeGesture(app(), "bottom");
          }}
          onTouchCancel={() => {
            activeResizeGesture = null;
            resizePreview.set(null);
          }}
          style={{
            position: "absolute",
            left: 24,
            right: 40,
            bottom: -6,
            height: 44,
          }}
          class="items-center justify-end pb-2"
        >
          <View class="w-8 h-1.5 rounded-full bg-primary opacity-75" />
        </View>

        {/* Bottom-Right Corner 2D Resize Handle (44x44dp touch zone) */}
        <View
          testID={`home-resize-corner-${app().id}`}
          panActivation={{ activeOffsetX: 0, activeOffsetY: 0 }}
          onResponderGrant={() => true}
          role="button"
          accessibilityLabel={`${app().displayName ?? app().name} 调整尺寸`}
          onTouchStart={(e) => startResizeGesture(app(), "corner", e.pageX, e.pageY)}
          onTouchMove={(e) => updateResizeGesture(app(), e.pageX, e.pageY)}
          onTouchEnd={() => {
            lastResizeTouchEndMs = Date.now();
            endResizeGesture(app(), "corner");
          }}
          onPress={() => {
            if (Date.now() - lastResizeTouchEndMs < 400) return;
            endResizeGesture(app(), "corner");
          }}
          onTouchCancel={() => {
            activeResizeGesture = null;
            resizePreview.set(null);
          }}
          style={{
            position: "absolute",
            right: -2,
            bottom: -2,
            width: 44,
            height: 44,
          }}
          class="items-end justify-end p-2"
        >
          <View class="w-4 h-4 rounded-br-lg border-r-2 border-b-2 border-primary" />
        </View>
      </View>
    );
  };

  const renderCameraCardBody = (
    room: () => HomeRoomSection,
    app: () => HomeAppliance,
    activeSpan: () => TileSpan,
  ) => {
    const vs = () => app().capabilities.visionStream;
    const isLarge = () => activeSpan() === "2x2";
    const isExpanded = () => activeSpan() !== "1x1";

    return (
      <View class="gap-2 mt-1">
        <If when={isExpanded()}>
          <View
            role="button"
            onPress={() => {
              if (isRoomEditing(room().name)) {
                handleCardPressInEditMode(room(), app().id);
              } else {
                props.store.setHomeInspectedApplianceId(app().id);
              }
            }}
            onLongPress={() => enterLayoutEditWithCard(room().name, app().id)}
            class="w-full rounded-xl bg-secondary border border-border p-2.5 justify-between active:opacity-80"
            style={{ minHeight: isLarge() || activeSpan() === "1x2" ? 112 : 54 }}
          >
            <View class="flex-row items-center justify-between gap-2">
              <View class="flex-row items-center gap-1.5 px-2 py-0.5 rounded-full bg-card border border-border">
                <View
                  class={
                    app().online && app().isActive
                      ? "w-2 h-2 rounded-full bg-verified"
                      : "w-2 h-2 rounded-full bg-muted-foreground"
                  }
                />
                <Text class="text-foreground text-xs font-semibold">
                  {vs()?.statusText ?? app().statusBadge}
                </Text>
              </View>
              <If when={Boolean(vs()?.resolutionBadge)}>
                <Text class="text-muted-foreground text-xs font-medium">
                  {vs()?.resolutionBadge}
                </Text>
              </If>
            </View>

            <View class="flex-row items-center justify-between gap-2 mt-1.5">
              <View class="flex-row items-center gap-1.5 flex-1">
                <ActionIcon name="shield" tone="muted" size={13} />
                <Text
                  class="text-muted-foreground text-xs flex-1"
                  style={{ numberOfLines: 1 }}
                >
                  {vs()?.lastMotionText ?? app().conciseSubtitle}
                </Text>
              </View>
              <If when={Boolean(vs()?.storageUsedPercent !== undefined)}>
                <Text class="text-muted-foreground text-xs">
                  SD {vs()?.storageUsedPercent}%
                </Text>
              </If>
            </View>
          </View>
        </If>

        <If when={isLarge() && (vs()?.featureToggles.length ?? 0) > 0}>
          <View class="flex-row items-center gap-1.5 flex-wrap">
            <Each of={(vs()?.featureToggles ?? []).slice(0, 3)} key={(tog) => tog.id}>
              {(tog) => (
                <Button
                  testID={`home-cam-tog-${tog().id}`}
                  disabled={!tog().controllable}
                  selected={tog().isOn}
                  onPress={() => togglePower(tog().entityId, tog().domain, tog().isOn)}
                  class={
                    tog().isOn
                      ? "min-h-8 px-2.5 rounded-lg bg-primary flex-row items-center justify-center gap-1 active:opacity-75 disabled:opacity-40"
                      : "min-h-8 px-2.5 rounded-lg bg-muted border border-border flex-row items-center justify-center gap-1 active:opacity-75 disabled:opacity-40"
                  }
                >
                  <Text
                    class={
                      tog().isOn
                        ? "text-primary-foreground text-xs font-semibold"
                        : "text-foreground text-xs font-medium"
                    }
                  >
                    {tog().label}
                  </Text>
                </Button>
              )}
            </Each>
          </View>
        </If>
      </View>
    );
  };

  const renderVacuumCardBody = (app: () => HomeAppliance, activeSpan: () => TileSpan) => {
    const vac = () => app().capabilities.vacuum;
    const actions = () => app().capabilities.actions ?? [];
    const isExpanded = () => activeSpan() !== "1x1";
    const isTallOnly = () => activeSpan() === "1x2";

    return (
      <If when={Boolean(vac())}>
        <View class="gap-2 mt-1">
          <If when={isExpanded()}>
            <View
              class={
                isTallOnly()
                  ? "rounded-xl bg-muted border border-border px-2.5 py-2 gap-2"
                  : "rounded-xl bg-muted border border-border px-3 py-2 flex-row items-center justify-between gap-2.5"
              }
            >
              <View class="gap-0.5 flex-1" style={{ minWidth: 0 }}>
                <Text class="text-foreground text-sm font-bold" style={{ numberOfLines: 1 }}>
                  {vac()?.statusLabel}
                </Text>
                <Text class="text-muted-foreground text-xs" style={{ numberOfLines: 1 }}>
                  {[
                    vac()?.batteryPercent !== undefined ? `电量 ${vac()?.batteryPercent}%` : undefined,
                    vac()?.cleaningAreaSqm !== undefined ? `面积 ${vac()?.cleaningAreaSqm}㎡` : undefined,
                    vac()?.cleaningMinutes !== undefined ? `${vac()?.cleaningMinutes}分钟` : undefined,
                  ]
                    .filter(Boolean)
                    .join(" · ") || vac()?.chargingLabel || "基站就绪"}
                </Text>
              </View>

              <If when={actions().length > 0}>
                <View class="flex-row items-center gap-1.5 flex-wrap">
                  <Each
                    of={actions().slice(0, isTallOnly() ? 2 : 3)}
                    key={(act) => act.id}
                  >
                    {(act) => (
                      <Button
                        testID={`home-vac-act-${act().id}`}
                        onPress={() => triggerAction(act())}
                        class={
                          act().tone === "primary"
                            ? "min-h-8 px-2.5 rounded-lg bg-primary flex-row items-center justify-center gap-1 active:opacity-75"
                            : "min-h-8 px-2.5 rounded-lg bg-card border border-border flex-row items-center justify-center gap-1 active:opacity-75"
                        }
                      >
                        <ActionIcon
                          name={resolveActionIconName(act())}
                          tone={act().tone === "primary" ? "primaryFg" : "foreground"}
                          size={13}
                        />
                        <Text
                          class={
                            act().tone === "primary"
                              ? "text-primary-foreground text-xs font-semibold"
                              : "text-foreground text-xs font-medium"
                          }
                        >
                          {act().label}
                        </Text>
                      </Button>
                    )}
                  </Each>
                </View>
              </If>
            </View>
          </If>

          <If when={activeSpan() === "2x2" && (vac()?.consumables.length ?? 0) > 0}>
            <View class="flex-row items-center gap-1.5 flex-wrap">
              <Each of={(vac()?.consumables ?? []).slice(0, 4)} key={(c) => c.id}>
                {(c) => (
                  <View class="px-2 py-1 rounded-lg bg-muted border border-border flex-row items-center gap-1">
                    <Text class="text-muted-foreground text-xs">
                      {c().label.replace("寿命", "")}
                    </Text>
                    <Text class="text-foreground text-xs font-semibold">{c().percent}%</Text>
                  </View>
                )}
              </Each>
            </View>
          </If>
        </View>
      </If>
    );
  };

  const renderCycleCardBody = (app: () => HomeAppliance, activeSpan: () => TileSpan) => {
    const cycle = () => app().capabilities.cycleTask;
    const actions = () => app().capabilities.actions ?? [];
    const isExpanded = () => activeSpan() !== "1x1";
    const isLarge = () => activeSpan() === "2x2";
    const isTallOnly = () => activeSpan() === "1x2";

    return (
      <If
        when={app().icon === "vacuum" && Boolean(app().capabilities.vacuum)}
        else={
          <If when={Boolean(cycle())}>
            <View class="gap-2 mt-1">
              <If when={isExpanded()}>
                <View
                  class={
                    isTallOnly()
                      ? "gap-2 rounded-xl bg-muted border border-border px-2.5 py-2"
                      : "flex-row items-center justify-between gap-3 rounded-xl bg-muted border border-border px-3 py-2"
                  }
                >
                  <View class="gap-0.5">
                    <Text class="text-foreground text-base font-bold">
                      {cycle()?.remainingMinutes !== undefined &&
                      (cycle()?.remainingMinutes ?? 0) > 0
                        ? `${cycle()?.remainingMinutes} min`
                        : cycle()?.stageLabel}
                    </Text>
                    <Text class="text-muted-foreground text-xs" style={{ numberOfLines: 1 }}>
                      {cycle()?.temperatureCelsius !== undefined
                        ? `${cycle()?.stageLabel} · ${cycle()?.temperatureCelsius}°C`
                        : cycle()?.recipeLabel
                          ? `${cycle()?.recipeLabel} · ${cycle()?.stageLabel}`
                          : cycle()?.stageLabel}
                    </Text>
                  </View>

                  <If when={(cycle()?.stages.length ?? 0) > 1}>
                    <View class="flex-1 gap-1" style={{ minWidth: 0 }}>
                      <View class="flex-row items-center gap-1">
                        <Each
                          of={(cycle()?.stages ?? []).map((st, idx) => ({ st, idx }))}
                          key={(item) => `${item.idx}:${item.st}`}
                        >
                          {(item) => (
                            <View
                              class={
                                item().idx <= (cycle()?.activeStageIndex ?? 0) &&
                                cycle()?.isRunning
                                  ? "flex-1 h-1.5 rounded-full bg-verified"
                                  : item().idx === (cycle()?.activeStageIndex ?? 0)
                                    ? "flex-1 h-1.5 rounded-full bg-primary"
                                    : "flex-1 h-1.5 rounded-full bg-border"
                              }
                            />
                          )}
                        </Each>
                      </View>
                      <View class="flex-row items-center justify-between">
                        <Text class="text-muted-foreground text-xs">
                          {cycle()?.stages[0]}
                        </Text>
                        <Text class="text-foreground text-xs font-semibold">
                          {cycle()?.stageLabel}
                        </Text>
                        <Text class="text-muted-foreground text-xs">
                          {cycle()?.stages[(cycle()?.stages.length ?? 1) - 1]}
                        </Text>
                      </View>
                    </View>
                  </If>
                </View>
              </If>

              <If when={(isLarge() || isTallOnly()) && actions().length > 0}>
                <View class="flex-row items-center gap-1.5 flex-wrap">
                  <Each
                    of={actions().slice(0, isLarge() ? 4 : 2)}
                    key={(act) => act.id}
                  >
                    {(act) => (
                      <Button
                        testID={`home-cycle-act-${act().id}`}
                        onPress={() => triggerAction(act())}
                        class={
                          act().tone === "primary"
                            ? "min-h-8 px-2.5 rounded-lg bg-primary flex-row items-center justify-center gap-1 active:opacity-75"
                            : "min-h-8 px-2.5 rounded-lg bg-muted border border-border flex-row items-center justify-center gap-1 active:opacity-75"
                        }
                      >
                        <ActionIcon
                          name={resolveActionIconName(act())}
                          tone={act().tone === "primary" ? "primaryFg" : "foreground"}
                          size={13}
                        />
                        <Text
                          class={
                            act().tone === "primary"
                              ? "text-primary-foreground text-xs font-semibold"
                              : "text-foreground text-xs font-medium"
                          }
                        >
                          {act().label}
                        </Text>
                      </Button>
                    )}
                  </Each>
                </View>
              </If>
            </View>
          </If>
        }
      >
        {renderVacuumCardBody(app, activeSpan)}
      </If>
    );
  };

  const renderClimateCardBody = (app: () => HomeAppliance, activeSpan: () => TileSpan) => {
    const therm = () => app().capabilities.thermostat;
    const modeBar = () => app().capabilities.modeBar;
    const fanCtrl = () =>
      (app().capabilities.controls ?? []).find(
        (c): c is ChoiceControlPrimitive => c.kind === "choice" && c.id === "fan_level",
      );
    const swingToggle = () =>
      (app().capabilities.controls ?? []).find(
        (c): c is ToggleControlPrimitive => c.kind === "toggle" && /摇头|摆风|swing|oscillat/i.test(c.label),
      );
    const isExpanded = () => activeSpan() !== "1x1";
    const isLarge = () => activeSpan() === "2x2";
    const isTall = () => activeSpan() === "1x2" || activeSpan() === "2x2";

    return (
      <If when={isExpanded()}>
        <View class="gap-2 mt-1">
          <If when={Boolean(therm())}>
            <View class="flex-row items-center justify-between gap-2 rounded-xl bg-muted border border-border px-2.5 py-1.5">
              <Button
                testID={`home-therm-minus-${app().id}`}
                disabled={!therm()?.controllable}
                accessibilityLabel="-"
                onPress={() => {
                  const th = therm();
                  if (th) {
                    adjustThermostat(
                      th.entityId,
                      th.domain,
                      th.targetTemp - th.step,
                      th.minTemp,
                      th.maxTemp,
                      th.step,
                    );
                  }
                }}
                class="w-8 h-8 rounded-lg bg-card border border-border items-center justify-center active:opacity-75 disabled:opacity-35"
              >
                <ActionIcon name="minus" tone="foreground" size={14} />
              </Button>

              <View class="items-center">
                <Text class="text-foreground text-base font-bold">
                  {therm()?.targetTemp}
                  {therm()?.unit ?? "°C"}
                </Text>
                <If when={therm()?.currentTemp !== undefined}>
                  <Text class="text-muted-foreground text-xs">
                    室温 {therm()?.currentTemp}°C
                  </Text>
                </If>
              </View>

              <Button
                testID={`home-therm-plus-${app().id}`}
                disabled={!therm()?.controllable}
                accessibilityLabel="+"
                onPress={() => {
                  const th = therm();
                  if (th) {
                    adjustThermostat(
                      th.entityId,
                      th.domain,
                      th.targetTemp + th.step,
                      th.minTemp,
                      th.maxTemp,
                      th.step,
                    );
                  }
                }}
                class="w-8 h-8 rounded-lg bg-card border border-border items-center justify-center active:opacity-75 disabled:opacity-35"
              >
                <ActionIcon name="plus" tone="foreground" size={14} />
              </Button>
            </View>
          </If>

          <If when={Boolean(modeBar()) && (isLarge() || isTall() || !therm())}>
            <View class="flex-row items-center gap-1.5 flex-wrap">
              <Each of={(modeBar()?.options ?? []).slice(0, 4)} key={(opt) => opt.value}>
                {(opt) => (
                  <Button
                    testID={`home-mode-${app().id}-${opt().value}`}
                    disabled={!modeBar()?.controllable}
                    selected={modeBar()?.currentMode === opt().value}
                    onPress={() => {
                      const mb = modeBar();
                      if (mb) selectMode(mb, opt().value);
                    }}
                    class={
                      modeBar()?.currentMode === opt().value
                        ? "min-h-7 px-2.5 rounded-lg bg-primary items-center justify-center active:opacity-75 disabled:opacity-40"
                        : "min-h-7 px-2.5 rounded-lg bg-muted border border-border items-center justify-center active:opacity-75 disabled:opacity-40"
                    }
                  >
                    <Text
                      class={
                        modeBar()?.currentMode === opt().value
                          ? "text-primary-foreground text-xs font-semibold"
                          : "text-foreground text-xs font-medium"
                      }
                    >
                      {opt().label}
                    </Text>
                  </Button>
                )}
              </Each>
            </View>
          </If>

          <If when={Boolean(fanCtrl()) && (isLarge() || isTall() || !therm())}>
            <View class="flex-row items-center gap-1.5 flex-wrap">
              <Each of={(fanCtrl()?.options ?? []).slice(0, 4)} key={(opt) => opt.value}>
                {(opt) => (
                  <Button
                    testID={`home-fan-${app().id}-${opt().value}`}
                    disabled={!fanCtrl()?.controllable}
                    selected={fanCtrl()?.currentValue === opt().value}
                    onPress={() => {
                      const fc = fanCtrl();
                      if (fc) dispatchChoicePrimitive(fc, opt().value);
                    }}
                    class={
                      fanCtrl()?.currentValue === opt().value
                        ? "min-h-7 px-2.5 rounded-lg bg-airflow-bg border border-airflow-border items-center justify-center active:opacity-75 disabled:opacity-40"
                        : "min-h-7 px-2.5 rounded-lg bg-muted border border-border items-center justify-center active:opacity-75 disabled:opacity-40"
                    }
                  >
                    <Text
                      class={
                        fanCtrl()?.currentValue === opt().value
                          ? "text-airflow text-xs font-semibold"
                          : "text-foreground text-xs font-medium"
                      }
                    >
                      {opt().label}
                    </Text>
                  </Button>
                )}
              </Each>
              <If when={isLarge() && Boolean(swingToggle())}>
                <Button
                  testID={`home-swing-${app().id}`}
                  disabled={!swingToggle()?.controllable}
                  selected={Boolean(swingToggle()?.isOn)}
                  onPress={() => {
                    const st = swingToggle();
                    if (st) dispatchTogglePrimitive(st);
                  }}
                  class={
                    swingToggle()?.isOn
                      ? "min-h-7 px-2.5 rounded-lg bg-airflow-bg border border-airflow-border items-center justify-center active:opacity-75 disabled:opacity-40"
                      : "min-h-7 px-2.5 rounded-lg bg-muted border border-border items-center justify-center active:opacity-75 disabled:opacity-40"
                  }
                >
                  <Text
                    class={
                      swingToggle()?.isOn
                        ? "text-airflow text-xs font-semibold"
                        : "text-foreground text-xs font-medium"
                    }
                  >
                    {swingToggle()?.label ?? "摇头"}
                  </Text>
                </Button>
              </If>
            </View>
          </If>
        </View>
      </If>
    );
  };

  const renderLightCardBody = (app: () => HomeAppliance, activeSpan: () => TileSpan) => {
    const dimmer = () => app().capabilities.dimmer;
    const isExpanded = () => activeSpan() !== "1x1";
    const isLarge = () => activeSpan() === "2x2";
    const isTall = () => activeSpan() === "1x2" || activeSpan() === "2x2";

    return (
      <If when={isExpanded() && Boolean(dimmer())}>
        <View class="gap-2 mt-1">
          <View class="gap-1">
            <View class="flex-row items-center justify-between">
              <Text class="text-muted-foreground text-xs">{t("brightness")}</Text>
              <Text class="text-foreground text-xs font-semibold">
                {dimmer()?.brightnessPercent ?? 80}%
              </Text>
            </View>
            <HorizontalValueSlider
              testID={`home-light-dimmer-${app().id}`}
              min={1}
              max={100}
              step={1}
              value={dimmer()?.brightnessPercent ?? 80}
              disabled={!dimmer()?.controllable}
              accessibilityLabel={t("brightness")}
              onChange={() => {}}
              onChangeEnd={(val) => {
                const dm = dimmer();
                if (dm) setLightBrightness(dm.entityId, val);
              }}
            />
          </View>

          <If when={(isLarge() || isTall()) && Boolean(dimmer()?.colorTempRange)}>
            <View class="flex-row items-center gap-1.5 flex-wrap">
              {[2700, 4000, 5000].map((k) => (
                <Button
                  testID={`home-light-ct-${app().id}-${k}`}
                  disabled={!dimmer()?.controllable}
                  selected={Math.abs((dimmer()?.colorTempKelvin ?? 4000) - k) < 400}
                  onPress={() => {
                    const dm = dimmer();
                    if (dm) setLightColorTemp(dm.entityId, k);
                  }}
                  class={
                    Math.abs((dimmer()?.colorTempKelvin ?? 4000) - k) < 400
                      ? "min-h-7 px-2 rounded-lg bg-lighting-bg border border-lighting-border items-center justify-center active:opacity-75 disabled:opacity-40"
                      : "min-h-7 px-2 rounded-lg bg-muted border border-border items-center justify-center active:opacity-75 disabled:opacity-40"
                  }
                >
                  <Text
                    class={
                      Math.abs((dimmer()?.colorTempKelvin ?? 4000) - k) < 400
                        ? "text-lighting text-xs font-semibold"
                        : "text-foreground text-xs font-medium"
                    }
                  >
                    {k}K
                  </Text>
                </Button>
              ))}
            </View>
          </If>
        </View>
      </If>
    );
  };

  const renderMultiGangCardBody = (app: () => HomeAppliance) => {
    const mg = () => app().capabilities.multiGang;

    return (
      <If when={Boolean(mg())}>
        <View class="flex-row items-center gap-1.5 mt-1">
          <Each of={mg()?.channels ?? []} key={(ch) => ch.id}>
            {(ch) => (
              <Button
                testID={`home-gang-${ch().id}`}
                disabled={!ch().controllable}
                selected={ch().isOn}
                onPress={() => togglePower(ch().entityId, ch().domain, ch().isOn)}
                class={
                  ch().isOn
                    ? "flex-1 min-h-9 rounded-xl bg-primary px-2 py-1 items-center justify-center gap-0.5 active:opacity-75 disabled:opacity-40"
                    : "flex-1 min-h-9 rounded-xl bg-muted border border-border px-2 py-1 items-center justify-center gap-0.5 active:opacity-75 disabled:opacity-40"
                }
              >
                <ActionIcon
                  name="power"
                  tone={ch().isOn ? "primaryFg" : "muted"}
                  size={12}
                />
                <Text
                  class={
                    ch().isOn
                      ? "text-primary-foreground text-xs font-semibold"
                      : "text-foreground text-xs font-medium"
                  }
                  style={{ numberOfLines: 1 }}
                >
                  {ch().label}
                </Text>
              </Button>
            )}
          </Each>
        </View>
      </If>
    );
  };

  const renderApplianceCard = (room: () => HomeRoomSection, app: () => HomeAppliance) => {
    const editingThisRoom = () => isRoomEditing(room().name);
    const activeSpan = (): TileSpan => {
      const p = resizePreview();
      if (p && p.applianceId === app().id) {
        return p.targetSpan;
      }
      return app().span;
    };
    const dims = () => parseSpanDims(activeSpan());
    const effectiveColSpan = () => (dims().cols === 2 ? Math.min(2, gridColumns()) : 1);
    const effectiveRowSpan = () => dims().rows;
    const power = () => app().capabilities.power;
    const isMovingSelected = () => editingThisRoom() && movingApplianceId() === app().id;
    const isResizingThis = () => resizePreview()?.applianceId === app().id;

    const cardBorderClass = () => {
      if (isResizingThis() || isMovingSelected()) {
        return "rounded-2xl border-2 border-primary bg-card p-3 justify-between";
      }
      if (editingThisRoom()) {
        return "rounded-2xl border border-dashed border-primary bg-card p-3 justify-between";
      }
      if (app().isActive) {
        return "rounded-2xl border border-ring bg-card p-3 justify-between";
      }
      return "rounded-2xl border border-border bg-card p-3 justify-between";
    };

    const cardDisplayName = () => app().displayName ?? app().name;

    return (
      <View
        style={{
          position: "relative",
          gridColumn: `span ${effectiveColSpan()}`,
          gridRow: `span ${effectiveRowSpan()}`,
          minHeight:
            effectiveRowSpan() === 2
              ? BASE_ROW_HEIGHT * 2 + GRID_GAP
              : BASE_ROW_HEIGHT,
        }}
        class={cardBorderClass()}
      >
        <View class="gap-1.5 flex-1 justify-between">
          {/* Card Header: Icon + Concise Display Name + Subtitle on Left, Power Icon Button on Right */}
          <View class="flex-row items-start justify-between gap-2">
            <View
              testID={`home-card-${app().id}`}
              role="button"
              accessibilityLabel={`${cardDisplayName()} · ${app().conciseSubtitle}`}
              onTouchStart={(e) => {
                if (!editingThisRoom()) return;
                activeCardDragGesture = {
                  roomName: room().name,
                  applianceId: app().id,
                  startX: e.pageX,
                  startY: e.pageY,
                  didDrag: false,
                };
              }}
              onTouchMove={(e) => {
                if (
                  !editingThisRoom() ||
                  !activeCardDragGesture ||
                  activeCardDragGesture.applianceId !== app().id
                ) {
                  return;
                }
                const dx = e.pageX - activeCardDragGesture.startX;
                const dy = e.pageY - activeCardDragGesture.startY;
                if (Math.abs(dx) > 56 || Math.abs(dy) > 56) {
                  activeCardDragGesture.didDrag = true;
                  activeCardDragGesture.startX = e.pageX;
                  activeCardDragGesture.startY = e.pageY;
                  const cols = gridColumns();
                  const delta =
                    Math.abs(dy) > Math.abs(dx)
                      ? dy > 0
                        ? cols
                        : -cols
                      : dx > 0
                        ? 1
                        : -1;
                  previewApplianceOrder(room(), app(), delta);
                }
              }}
              onTouchEnd={() => {
                commitApplianceOrderPreview(room().id);
                activeCardDragGesture = null;
              }}
              onPress={() => {
                if (editingThisRoom()) {
                  handleCardPressInEditMode(room(), app().id);
                } else {
                  props.store.setHomeInspectedApplianceId(app().id);
                }
              }}
              onLongPress={() => enterLayoutEditWithCard(room().name, app().id)}
              class="flex-1 flex-row items-start gap-2.5 active:opacity-75"
              style={{ minWidth: 0 }}
            >
              <ApplianceIcon
                kind={app().icon}
                active={app().isActive}
                size="md"
              />
              <View class="flex-1 gap-0.5" style={{ minWidth: 0 }}>
                <Text
                  class="text-foreground text-sm font-semibold"
                  style={{ numberOfLines: 2 }}
                >
                  {cardDisplayName()}
                </Text>
                <Text
                  class={
                    app().isActive
                      ? "text-foreground text-xs font-medium"
                      : "text-muted-foreground text-xs"
                  }
                  style={{ numberOfLines: 1 }}
                >
                  {app().conciseSubtitle}
                </Text>
              </View>
            </View>

            <If when={!editingThisRoom()}>
              <If
                when={Boolean(power() && power()?.controllable)}
                else={
                  <View
                    class={
                      app().isActive
                        ? "px-2 py-0.5 rounded-full bg-live-active-bg border border-verified"
                        : "px-2 py-0.5 rounded-full bg-muted border border-border"
                    }
                  >
                    <Text
                      class={
                        app().isActive
                          ? "text-verified text-xs font-semibold"
                          : "text-muted-foreground text-xs"
                      }
                    >
                      {app().statusBadge}
                    </Text>
                  </View>
                }
              >
                <PowerIconButton
                  testID={`home-power-${app().id}`}
                  isOn={Boolean(power()?.isOn)}
                  disabled={!power()?.controllable}
                  size="sm"
                  accessibilityLabel={`${cardDisplayName()} ${power()?.isOn ? t("powerOff") : t("powerOn")}`}
                  onPress={() => {
                    const pw = power();
                    if (pw) togglePower(pw.entityId, pw.domain, pw.isOn);
                  }}
                />
              </If>
            </If>
          </View>

          {/* Domain-specific card body (disabled during layout edit mode) */}
          <View style={{ pointerEvents: editingThisRoom() ? "none" : "auto" }}>
            <If when={app().icon === "camera"}>
              {renderCameraCardBody(room, app, activeSpan)}
            </If>
            <If when={app().archetype === "cycle_appliance"}>
              {renderCycleCardBody(app, activeSpan)}
            </If>
            <If when={app().archetype === "climate"}>
              {renderClimateCardBody(app, activeSpan)}
            </If>
            <If when={app().archetype === "lighting_power"}>
              {renderLightCardBody(app, activeSpan)}
            </If>
            <If when={app().icon === "switch_gang"}>
              {renderMultiGangCardBody(app)}
            </If>
            <If
              when={
                (app().icon === "feeder" ||
                  app().icon === "waterer" ||
                  app().archetype === "media") &&
                (app().capabilities.actions?.length ?? 0) > 0 &&
                activeSpan() !== "1x1"
              }
            >
              <View class="flex-row items-center gap-1.5 mt-1 flex-wrap">
                <Each
                  of={(app().capabilities.actions ?? []).slice(0, 2)}
                  key={(act) => act.id}
                >
                  {(act) => (
                    <Button
                      testID={`home-pet-act-${act().id}`}
                      onPress={() => triggerAction(act())}
                      class={
                        act().tone === "primary"
                          ? "min-h-8 px-3 rounded-lg bg-primary flex-row items-center justify-center gap-1.5 active:opacity-75"
                          : "min-h-8 px-2.5 rounded-lg bg-muted border border-border flex-row items-center justify-center gap-1.5 active:opacity-75"
                      }
                    >
                      <ActionIcon
                        name={resolveActionIconName(act())}
                        tone={act().tone === "primary" ? "primaryFg" : "foreground"}
                        size={13}
                      />
                      <Text
                        class={
                          act().tone === "primary"
                            ? "text-primary-foreground text-xs font-semibold"
                            : "text-foreground text-xs font-medium"
                        }
                      >
                        {act().label}
                      </Text>
                    </Button>
                  )}
                </Each>
              </View>
            </If>
          </View>
        </View>

        <If when={editingThisRoom()}>
          {renderEditHandlesOverlay(app)}
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
          <CameraMonitor
            store={props.store}
            statusText={vs()?.statusText}
            resolutionBadge={vs()?.resolutionBadge}
          />
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
                <Each of={vs()?.featureToggles ?? []} key={(tog) => tog.id}>
                  {(tog) => (
                    <Button
                      testID={`detail-cam-tog-${tog().id}`}
                      disabled={!tog().controllable}
                      selected={tog().isOn}
                      onPress={() =>
                        togglePower(tog().entityId, tog().domain, tog().isOn)
                      }
                      class={
                        tog().isOn
                          ? "flex-1 min-w-28 min-h-12 px-3.5 rounded-xl bg-primary flex-row items-center justify-between gap-2 active:opacity-75 disabled:opacity-40"
                          : "flex-1 min-w-28 min-h-12 px-3.5 rounded-xl bg-muted border border-border flex-row items-center justify-between gap-2 active:opacity-75 disabled:opacity-40"
                      }
                    >
                      <Text
                        class={
                          tog().isOn
                            ? "text-primary-foreground text-sm font-semibold"
                            : "text-foreground text-sm font-medium"
                        }
                      >
                        {tog().label}
                      </Text>
                      <ActionIcon
                        name={tog().isOn ? "check" : "power"}
                        tone={tog().isOn ? "primaryFg" : "muted"}
                        size={16}
                      />
                    </Button>
                  )}
                </Each>
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
              <Each of={vs()?.modeSelectors ?? []} key={(sel) => sel.id}>
                {(sel) => (
                  <View class="gap-1.5">
                    <Text class="text-muted-foreground text-xs font-medium">
                      {sel().label}
                    </Text>
                    <View class="flex-row items-center gap-1.5 flex-wrap">
                      <Each of={sel().capability.options} key={(opt) => opt.value}>
                        {(opt) => (
                          <Button
                            testID={`detail-cam-mode-${sel().id}-${opt().value}`}
                            disabled={!sel().capability.controllable}
                            selected={sel().capability.currentMode === opt().value}
                            onPress={() => selectMode(sel().capability, opt().value)}
                            class={
                              sel().capability.currentMode === opt().value
                                ? "flex-1 min-h-10 px-3 rounded-xl bg-primary items-center justify-center active:opacity-75 disabled:opacity-40"
                                : "flex-1 min-h-10 px-3 rounded-xl bg-muted border border-border items-center justify-center active:opacity-75 disabled:opacity-40"
                            }
                          >
                            <Text
                              class={
                                sel().capability.currentMode === opt().value
                                  ? "text-primary-foreground text-xs font-semibold"
                                  : "text-foreground text-xs font-medium"
                              }
                            >
                              {opt().label}
                            </Text>
                          </Button>
                        )}
                      </Each>
                    </View>
                  </View>
                )}
              </Each>
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

  const renderVacuumFullPage = (appliance: () => HomeAppliance) => {
    const vac = () => appliance().capabilities.vacuum;
    const cycle = () => appliance().capabilities.cycleTask;
    const actions = () => appliance().capabilities.actions ?? [];
    const modeBar = () => appliance().capabilities.modeBar;
    const mopModeBar = () => vac()?.mopModeBar;

    return (
      <View class="gap-4">
        {/* Top Hero: Status + Stage Pipeline + 4 Cleaning Telemetry Metrics */}
        <View class="rounded-3xl border border-border bg-card p-5 gap-4">
          <View class="flex-row items-center justify-between gap-3 flex-wrap">
            <View class="flex-row items-center gap-3">
              <ApplianceIcon kind="vacuum" active={appliance().isActive} size="lg" />
              <View class="gap-0.5">
                <Text class="text-foreground text-2xl font-bold">
                  {vac()?.statusLabel ?? cycle()?.stageLabel ?? appliance().statusBadge}
                </Text>
                <Text class="text-muted-foreground text-xs">
                  {[
                    vac()?.chargingLabel,
                    vac()?.waterBoxInstalled !== undefined
                      ? vac()?.waterBoxInstalled
                        ? "拖布支架已安装"
                        : "未安装拖布"
                      : undefined,
                  ]
                    .filter(Boolean)
                    .join(" · ") || "基站自检正常"}
                </Text>
              </View>
            </View>

            <If when={vac()?.batteryPercent !== undefined}>
              <View class="px-3.5 py-2 rounded-2xl bg-live-active-bg border border-verified flex-row items-center gap-2">
                <View class="w-2 h-2 rounded-full bg-verified" />
                <Text class="text-verified text-sm font-bold">
                  电量 {vac()?.batteryPercent}%
                </Text>
              </View>
            </If>
          </View>

          {/* 5-Stage Pipeline */}
          <If when={Boolean(cycle()) && (cycle()?.stages.length ?? 0) > 1}>
            <View class="flex-row items-center gap-2">
              <Each
                of={(cycle()?.stages ?? []).map((st, idx) => ({ st, idx }))}
                key={(item) => `${item.idx}:${item.st}`}
              >
                {(item) => (
                  <View
                    class={
                      item().idx === (cycle()?.activeStageIndex ?? 0)
                        ? "flex-1 rounded-xl bg-primary px-2.5 py-2 items-center justify-center"
                        : "flex-1 rounded-xl bg-muted border border-border px-2.5 py-2 items-center justify-center"
                    }
                  >
                    <Text
                      class={
                        item().idx === (cycle()?.activeStageIndex ?? 0)
                          ? "text-primary-foreground text-xs font-semibold"
                          : "text-muted-foreground text-xs"
                      }
                    >
                      {item().st}
                    </Text>
                  </View>
                )}
              </Each>
            </View>
          </If>

          {/* Cleaning Statistics Grid */}
          <View class="flex-row items-center gap-2.5 flex-wrap">
            <View class="flex-1 min-w-28 rounded-2xl bg-muted border border-border p-3 gap-0.5">
              <Text class="text-muted-foreground text-xs">本次清扫面积</Text>
              <Text class="text-foreground text-lg font-bold">
                {vac()?.cleaningAreaSqm ?? 0} ㎡
              </Text>
            </View>
            <View class="flex-1 min-w-28 rounded-2xl bg-muted border border-border p-3 gap-0.5">
              <Text class="text-muted-foreground text-xs">本次清扫时长</Text>
              <Text class="text-foreground text-lg font-bold">
                {vac()?.cleaningMinutes ?? 0} min
              </Text>
            </View>
            <If when={vac()?.totalCleanCount !== undefined}>
              <View class="flex-1 min-w-28 rounded-2xl bg-muted border border-border p-3 gap-0.5">
                <Text class="text-muted-foreground text-xs">累计清扫次数</Text>
                <Text class="text-foreground text-lg font-bold">
                  {vac()?.totalCleanCount} 次
                </Text>
              </View>
            </If>
            <If when={vac()?.totalCleanAreaSqm !== undefined}>
              <View class="flex-1 min-w-28 rounded-2xl bg-muted border border-border p-3 gap-0.5">
                <Text class="text-muted-foreground text-xs">累计清扫面积</Text>
                <Text class="text-foreground text-lg font-bold">
                  {vac()?.totalCleanAreaSqm} ㎡
                </Text>
              </View>
            </If>
          </View>

          {/* Primary Action Dock with Vector Icons */}
          <If when={actions().length > 0}>
            <View class="flex-row items-center gap-2 flex-wrap pt-1">
              <Each of={actions()} key={(act) => act.id}>
                {(act) => (
                  <Button
                    testID={`detail-vac-act-${act().id}`}
                    onPress={() => triggerAction(act())}
                    class={
                      act().tone === "primary"
                        ? "flex-1 min-w-28 min-h-12 px-4 rounded-2xl bg-primary flex-row items-center justify-center gap-2 active:opacity-75"
                        : "flex-1 min-w-24 min-h-12 px-3.5 rounded-2xl bg-muted border border-border flex-row items-center justify-center gap-2 active:opacity-75"
                    }
                  >
                    <ActionIcon
                      name={resolveActionIconName(act())}
                      tone={act().tone === "primary" ? "primaryFg" : "foreground"}
                      size={17}
                    />
                    <Text
                      class={
                        act().tone === "primary"
                          ? "text-primary-foreground text-sm font-semibold"
                          : "text-foreground text-sm font-medium"
                      }
                    >
                      {act().label}
                    </Text>
                  </Button>
                )}
              </Each>
            </View>
          </If>
        </View>

        {/* Bottom 2-Column Section: Cleaning/Mop Modes + Consumable Health Bars */}
        <View class={isWide() ? "flex-row items-start gap-4" : "gap-4"}>
          {/* Modes Card */}
          <If when={Boolean(modeBar() || mopModeBar())}>
            <View class="flex-1 rounded-2xl border border-border bg-card p-4 gap-4" style={{ minWidth: 0 }}>
              <If when={Boolean(modeBar())}>
                <View class="gap-2">
                  <Text class="text-foreground text-sm font-semibold">
                    {t("modeSelection")}
                  </Text>
                  <View class="flex-row items-center gap-2 flex-wrap">
                    <Each of={modeBar()?.options ?? []} key={(opt) => opt.value}>
                      {(opt) => (
                        <Button
                          testID={`detail-vac-mode-${opt().value}`}
                          disabled={!modeBar()?.controllable}
                          selected={modeBar()?.currentMode === opt().value}
                          onPress={() => {
                            const mb = modeBar();
                            if (mb) selectMode(mb, opt().value);
                          }}
                          class={
                            modeBar()?.currentMode === opt().value
                              ? "flex-1 min-w-20 min-h-11 px-3 rounded-xl bg-primary items-center justify-center active:opacity-75 disabled:opacity-40"
                              : "flex-1 min-w-20 min-h-11 px-3 rounded-xl bg-muted border border-border items-center justify-center active:opacity-75 disabled:opacity-40"
                          }
                        >
                          <Text
                            class={
                              modeBar()?.currentMode === opt().value
                                ? "text-primary-foreground text-sm font-semibold"
                                : "text-foreground text-sm font-medium"
                            }
                          >
                            {opt().label}
                          </Text>
                        </Button>
                      )}
                    </Each>
                  </View>
                </View>
              </If>

              <If when={Boolean(mopModeBar())}>
                <View class="gap-2">
                  <Text class="text-foreground text-sm font-semibold">
                    {t("waterOutputMode")}
                  </Text>
                  <View class="flex-row items-center gap-2 flex-wrap">
                    <Each of={mopModeBar()?.options ?? []} key={(opt) => opt.value}>
                      {(opt) => (
                        <Button
                          testID={`detail-vac-mop-${opt().value}`}
                          disabled={!mopModeBar()?.controllable}
                          selected={mopModeBar()?.currentMode === opt().value}
                          onPress={() => {
                            const mmb = mopModeBar();
                            if (mmb) selectMode(mmb, opt().value);
                          }}
                          class={
                            mopModeBar()?.currentMode === opt().value
                              ? "flex-1 min-w-20 min-h-11 px-3 rounded-xl bg-primary items-center justify-center active:opacity-75 disabled:opacity-40"
                              : "flex-1 min-w-20 min-h-11 px-3 rounded-xl bg-muted border border-border items-center justify-center active:opacity-75 disabled:opacity-40"
                          }
                        >
                          <Text
                            class={
                              mopModeBar()?.currentMode === opt().value
                                ? "text-primary-foreground text-sm font-semibold"
                                : "text-foreground text-sm font-medium"
                            }
                          >
                            {opt().label}
                          </Text>
                        </Button>
                      )}
                    </Each>
                  </View>
                </View>
              </If>
            </View>
          </If>

          {/* Consumables Health Card */}
          <If when={(vac()?.consumables.length ?? 0) > 0}>
            <View class="flex-1 rounded-2xl border border-border bg-card p-4 gap-3" style={{ minWidth: 0 }}>
              <Text class="text-foreground text-sm font-semibold">
                {t("consumablesHealth")}
              </Text>
              <View class="gap-2.5">
                <Each of={vac()?.consumables ?? []} key={(c) => c.id}>
                  {(c) => (
                    <View class="gap-1">
                      <View class="flex-row items-center justify-between">
                        <Text class="text-foreground text-xs font-medium">{c().label}</Text>
                        <Text class="text-muted-foreground text-xs font-semibold">
                          剩余 {c().percent}%
                          {c().remainingHours !== undefined ? ` (约 ${c().remainingHours}h)` : ""}
                        </Text>
                      </View>
                      <View class="w-full h-2 rounded-full bg-muted overflow-hidden">
                        <View
                          class={
                            c().percent <= 15
                              ? "h-full rounded-full bg-destructive"
                              : c().percent <= 30
                                ? "h-full rounded-full bg-warning"
                                : "h-full rounded-full bg-verified"
                          }
                          style={{ width: `${c().percent}%` }}
                        />
                      </View>
                    </View>
                  )}
                </Each>
              </View>
            </View>
          </If>
        </View>
      </View>
    );
  };

  const renderExtraControlsSection = (appliance: () => HomeAppliance) => {
    const extraChoices = () =>
      (appliance().capabilities.controls ?? []).filter(
        (c): c is ChoiceControlPrimitive =>
          c.kind === "choice" && c.id !== "mode",
      );
    const extraRanges = () =>
      (appliance().capabilities.controls ?? []).filter(
        (c): c is RangeControlPrimitive =>
          c.kind === "range" &&
          c.id !== "thermostat" &&
          c.id !== "brightness" &&
          c.id !== "color_temp",
      );
    const extraToggles = () => {
      const auxIds = new Set(
        (appliance().capabilities.auxiliaryToggles ?? []).map((t) => t.id),
      );
      const gangIds = new Set(
        (appliance().capabilities.multiGang?.channels ?? []).map((c) => c.id),
      );
      const camIds = new Set(
        (appliance().capabilities.visionStream?.featureToggles ?? []).map((t) => t.id),
      );
      return (appliance().capabilities.controls ?? []).filter(
        (c): c is ToggleControlPrimitive =>
          c.kind === "toggle" &&
          c.id !== "power" &&
          !auxIds.has(c.id) &&
          !gangIds.has(c.id) &&
          !camIds.has(c.id),
      );
    };

    return (
      <If
        when={
          extraChoices().length > 0 ||
          extraRanges().length > 0 ||
          extraToggles().length > 0
        }
      >
        <View class="gap-4">
          <If when={extraToggles().length > 0}>
            <View class="rounded-2xl border border-border bg-card p-4 gap-2.5">
              <Text class="text-foreground text-sm font-semibold">
                {t("primaryControls")}
              </Text>
              <View class="flex-row items-center gap-2 flex-wrap">
                <Each of={extraToggles()} key={(tog) => tog.id}>
                  {(tog) => (
                    <Button
                      testID={`detail-ctrl-toggle-${tog().id}`}
                      disabled={!tog().controllable}
                      selected={tog().isOn}
                      onPress={() => dispatchTogglePrimitive(tog())}
                      class={
                        tog().isOn
                          ? "min-h-11 px-3.5 rounded-xl bg-primary flex-row items-center justify-center gap-2 active:opacity-75 disabled:opacity-40"
                          : "min-h-11 px-3.5 rounded-xl bg-muted border border-border flex-row items-center justify-center gap-2 active:opacity-75 disabled:opacity-40"
                      }
                    >
                      <ActionIcon
                        name={tog().isOn ? "check" : "power"}
                        tone={tog().isOn ? "primaryFg" : "muted"}
                        size={14}
                      />
                      <Text
                        class={
                          tog().isOn
                            ? "text-primary-foreground text-xs font-semibold"
                            : "text-foreground text-xs font-medium"
                        }
                      >
                        {tog().label}
                      </Text>
                    </Button>
                  )}
                </Each>
              </View>
            </View>
          </If>

          <Each of={extraChoices()} key={(c) => c.id}>
            {(choiceCtrl) => (
              <View class="rounded-2xl border border-border bg-card p-4 gap-2.5">
                <View class="flex-row items-center justify-between">
                  <Text class="text-foreground text-sm font-semibold">
                    {choiceCtrl().label}
                  </Text>
                  <Text class="text-muted-foreground text-xs font-semibold">
                    {choiceCtrl().options.find((o) => o.value === choiceCtrl().currentValue)
                      ?.label ?? choiceCtrl().currentValue}
                  </Text>
                </View>
                <If
                  when={choiceCtrl().options.length > 6}
                  else={
                    <View class="flex-row items-center gap-2 flex-wrap">
                      <Each of={choiceCtrl().options} key={(opt) => opt.value}>
                        {(opt) => (
                          <Button
                            testID={`detail-ctrl-choice-${choiceCtrl().id}-${opt().value}`}
                            disabled={!choiceCtrl().controllable}
                            selected={choiceCtrl().currentValue === opt().value}
                            onPress={() =>
                              dispatchChoicePrimitive(choiceCtrl(), opt().value)
                            }
                            class={
                              choiceCtrl().currentValue === opt().value
                                ? "flex-1 min-w-20 min-h-11 px-3 rounded-xl bg-primary items-center justify-center active:opacity-75 disabled:opacity-40"
                                : "flex-1 min-w-20 min-h-11 px-3 rounded-xl bg-muted border border-border items-center justify-center active:opacity-75 disabled:opacity-40"
                            }
                          >
                            <Text
                              class={
                                choiceCtrl().currentValue === opt().value
                                  ? "text-primary-foreground text-sm font-semibold"
                                  : "text-foreground text-sm font-medium"
                              }
                            >
                              {opt().label}
                            </Text>
                          </Button>
                        )}
                      </Each>
                    </View>
                  }
                >
                  <SelectField
                    testID={`detail-ctrl-select-${choiceCtrl().id}`}
                    label={choiceCtrl().label}
                    items={choiceCtrl().options.map((opt) => ({
                      value: opt.value,
                      title: opt.label,
                    }))}
                    value={choiceCtrl().currentValue}
                    disabled={!choiceCtrl().controllable}
                    onChange={(val) => dispatchChoicePrimitive(choiceCtrl(), val)}
                  />
                </If>
              </View>
            )}
          </Each>

          <Each of={extraRanges()} key={(r) => r.id}>
            {(rangeCtrl) => (
              <View class="rounded-2xl border border-border bg-card p-4 gap-3">
                <View class="flex-row items-center justify-between">
                  <Text class="text-foreground text-sm font-semibold">
                    {rangeCtrl().label}
                  </Text>
                  <Text class="text-foreground text-lg font-bold">
                    {rangeCtrl().value}
                    {rangeCtrl().unit ?? ""}
                  </Text>
                </View>
                <HorizontalValueSlider
                  testID={`detail-ctrl-range-${rangeCtrl().id}`}
                  min={rangeCtrl().min}
                  max={rangeCtrl().max}
                  step={rangeCtrl().step > 0 ? rangeCtrl().step : 1}
                  value={rangeCtrl().value}
                  disabled={!rangeCtrl().controllable}
                  accessibilityLabel={rangeCtrl().label}
                  onChange={() => {}}
                  onChangeEnd={(val) => dispatchRangePrimitive(rangeCtrl(), val)}
                />
              </View>
            )}
          </Each>
        </View>
      </If>
    );
  };

  const renderCycleApplianceFullPage = (appliance: () => HomeAppliance) => {
    const cycle = () => appliance().capabilities.cycleTask;
    const actions = () => appliance().capabilities.actions ?? [];
    const modeBar = () => appliance().capabilities.modeBar;
    const auxToggles = () => appliance().capabilities.auxiliaryToggles ?? [];
    const telemetry = () => appliance().capabilities.telemetry ?? [];

    return (
      <View class="gap-4">
        {/* Hero Cooking / Cycle Stage Card */}
        <View class="rounded-3xl border border-border bg-card p-5 gap-4">
          <View class="flex-row items-center justify-between gap-4 flex-wrap">
            <View class="flex-row items-center gap-3.5">
              <ApplianceIcon
                kind={appliance().icon}
                active={appliance().isActive}
                size="lg"
              />
              <View class="gap-0.5">
                <Text class="text-foreground text-2xl font-bold">
                  {cycle()?.remainingMinutes !== undefined &&
                  (cycle()?.remainingMinutes ?? 0) > 0
                    ? `剩余 ${cycle()?.remainingMinutes} 分钟`
                    : cycle()?.stageLabel ?? appliance().statusBadge}
                </Text>
                <Text class="text-muted-foreground text-sm">
                  {[
                    cycle()?.recipeLabel ? `当前程序：${cycle()?.recipeLabel}` : undefined,
                    cycle()?.keepWarmMinutes
                      ? `已保温 ${cycle()?.keepWarmMinutes} 分钟`
                      : undefined,
                  ]
                    .filter(Boolean)
                    .join(" · ") || appliance().conciseSubtitle}
                </Text>
              </View>
            </View>

            <If when={cycle()?.temperatureCelsius !== undefined}>
              <View class="px-4 py-2.5 rounded-2xl bg-muted border border-border items-end">
                <Text class="text-muted-foreground text-xs">腔体/锅内温度</Text>
                <Text class="text-foreground text-xl font-bold">
                  {cycle()?.temperatureCelsius}°C
                </Text>
              </View>
            </If>
          </View>

          {/* 5-Stage Pipeline */}
          <If when={Boolean(cycle()) && (cycle()?.stages.length ?? 0) > 1}>
            <View class="gap-2">
              <Text class="text-muted-foreground text-xs font-medium">
                {t("stagePipeline")}
              </Text>
              <View class="flex-row items-center gap-2">
                <Each
                  of={(cycle()?.stages ?? []).map((st, idx) => ({ st, idx }))}
                  key={(item) => `${item.idx}:${item.st}`}
                >
                  {(item) => {
                    const activeIdx = () => cycle()?.activeStageIndex ?? 0;
                    const isCurrent = () => item().idx === activeIdx();
                    const isDone = () =>
                      Boolean(cycle()?.isRunning && item().idx < activeIdx());
                    return (
                      <View
                        class={
                          isCurrent()
                            ? "flex-1 rounded-2xl bg-primary px-2.5 py-2.5 items-center justify-center gap-0.5"
                            : isDone()
                              ? "flex-1 rounded-2xl bg-live-active-bg border border-verified px-2.5 py-2.5 items-center justify-center gap-0.5"
                              : "flex-1 rounded-2xl bg-muted border border-border px-2.5 py-2.5 items-center justify-center gap-0.5"
                        }
                      >
                        <Text
                          class={
                            isCurrent()
                              ? "text-primary-foreground text-xs font-bold"
                              : isDone()
                                ? "text-verified text-xs font-semibold"
                                : "text-muted-foreground text-xs"
                          }
                        >
                          {item().st}
                        </Text>
                      </View>
                    );
                  }}
                </Each>
              </View>
            </View>
          </If>

          {/* Primary Transport Dock */}
          <If when={actions().length > 0}>
            <View class="flex-row items-center gap-2.5 flex-wrap pt-1">
              <Each of={actions()} key={(act) => act.id}>
                {(act) => (
                  <Button
                    testID={`detail-cycle-act-${act().id}`}
                    onPress={() => triggerAction(act())}
                    class={
                      act().tone === "primary"
                        ? "flex-1 min-w-28 min-h-12 px-5 rounded-2xl bg-primary flex-row items-center justify-center gap-2 active:opacity-75"
                        : "flex-1 min-w-28 min-h-12 px-4 rounded-2xl bg-muted border border-border flex-row items-center justify-center gap-2 active:opacity-75"
                    }
                  >
                    <ActionIcon
                      name={resolveActionIconName(act())}
                      tone={act().tone === "primary" ? "primaryFg" : "foreground"}
                      size={17}
                    />
                    <Text
                      class={
                        act().tone === "primary"
                          ? "text-primary-foreground text-sm font-semibold"
                          : "text-foreground text-sm font-medium"
                      }
                    >
                      {act().label}
                    </Text>
                  </Button>
                )}
              </Each>
            </View>
          </If>
        </View>

        {/* Cooking / Washing Programs & Auxiliary Switches */}
        <If when={Boolean(modeBar())}>
          <View class="rounded-2xl border border-border bg-card p-4 gap-3">
            <Text class="text-foreground text-sm font-semibold">
              {t("cookingPrograms")}
            </Text>
            <If
              when={(modeBar()?.options.length ?? 0) > 6}
              else={
                <View class="flex-row items-center gap-2 flex-wrap">
                  <Each of={modeBar()?.options ?? []} key={(opt) => opt.value}>
                    {(opt) => (
                      <Button
                        testID={`detail-cycle-mode-${opt().value}`}
                        disabled={!modeBar()?.controllable}
                        selected={modeBar()?.currentMode === opt().value}
                        onPress={() => {
                          const mb = modeBar();
                          if (mb) selectMode(mb, opt().value);
                        }}
                        class={
                          modeBar()?.currentMode === opt().value
                            ? "min-w-24 flex-1 min-h-12 px-3.5 rounded-xl bg-primary items-center justify-center active:opacity-75 disabled:opacity-40"
                            : "min-w-24 flex-1 min-h-12 px-3.5 rounded-xl bg-muted border border-border items-center justify-center active:opacity-75 disabled:opacity-40"
                        }
                      >
                        <Text
                          class={
                            modeBar()?.currentMode === opt().value
                              ? "text-primary-foreground text-sm font-semibold"
                              : "text-foreground text-sm font-medium"
                          }
                        >
                          {opt().label}
                        </Text>
                      </Button>
                    )}
                  </Each>
                </View>
              }
            >
              <SelectField
                testID={`detail-cycle-mode-select-${appliance().id}`}
                label={t("cookingPrograms")}
                items={(modeBar()?.options ?? []).map((opt) => ({
                  value: opt.value,
                  title: opt.label,
                }))}
                value={modeBar()?.currentMode ?? ""}
                disabled={!modeBar()?.controllable}
                onChange={(val) => {
                  const mb = modeBar();
                  if (mb) selectMode(mb, val);
                }}
              />
            </If>
          </View>
        </If>

        {renderExtraControlsSection(appliance)}

        <If when={auxToggles().length > 0}>
          <View class="rounded-2xl border border-border bg-card p-4 gap-3">
            <Text class="text-foreground text-sm font-semibold">
              {t("auxiliaryFeatures")}
            </Text>
            <View class="flex-row items-center gap-2.5 flex-wrap">
              <Each of={auxToggles()} key={(tog) => tog.id}>
                {(tog) => (
                  <Button
                    testID={`detail-cycle-aux-${tog().id}`}
                    disabled={!tog().controllable}
                    selected={tog().isOn}
                    onPress={() => togglePower(tog().entityId, tog().domain, tog().isOn)}
                    class={
                      tog().isOn
                        ? "min-h-11 px-4 rounded-xl bg-primary flex-row items-center justify-center gap-2 active:opacity-75 disabled:opacity-40"
                        : "min-h-11 px-4 rounded-xl bg-muted border border-border flex-row items-center justify-center gap-2 active:opacity-75 disabled:opacity-40"
                    }
                  >
                    <ActionIcon
                      name={tog().isOn ? "check" : "power"}
                      tone={tog().isOn ? "primaryFg" : "muted"}
                      size={15}
                    />
                    <Text
                      class={
                        tog().isOn
                          ? "text-primary-foreground text-sm font-semibold"
                          : "text-foreground text-sm font-medium"
                      }
                    >
                      {tog().label}
                    </Text>
                  </Button>
                )}
              </Each>
            </View>
          </View>
        </If>

        <If when={telemetry().length > 0}>
          <View class="rounded-2xl border border-border bg-card p-4 gap-2.5">
            <Text class="text-foreground text-sm font-semibold">{t("telemetryMetrics")}</Text>
            <View class="flex-row items-center gap-2.5 flex-wrap">
              <Each of={telemetry()} key={(m) => m.key}>
                {(m) => (
                  <View class="min-w-28 flex-1 rounded-xl bg-muted border border-border px-3.5 py-2.5 gap-0.5">
                    <Text class="text-muted-foreground text-xs">{m().label}</Text>
                    <Text class="text-foreground text-base font-bold">{m().value}</Text>
                  </View>
                )}
              </Each>
            </View>
          </View>
        </If>
      </View>
    );
  };

  const renderGenericApplianceFullPage = (appliance: () => HomeAppliance) => {
    const cap = () => appliance().capabilities;

    return (
      <View class="gap-4">
        {/* Multi-Gang Switch Channels */}
        <If when={Boolean(cap().multiGang)}>
          <View class="rounded-2xl border border-border bg-card p-4 gap-3">
            <Text class="text-foreground text-sm font-semibold">{t("primaryControls")}</Text>
            <View class="flex-row items-center gap-2.5">
              <Each of={cap().multiGang?.channels ?? []} key={(ch) => ch.id}>
                {(ch) => (
                  <Button
                    testID={`detail-gang-${ch().id}`}
                    disabled={!ch().controllable}
                    selected={ch().isOn}
                    onPress={() => togglePower(ch().entityId, ch().domain, ch().isOn)}
                    class={
                      ch().isOn
                        ? "flex-1 min-h-16 rounded-2xl bg-primary px-3 py-3 items-center justify-center gap-1.5 active:opacity-75 disabled:opacity-40"
                        : "flex-1 min-h-16 rounded-2xl bg-muted border border-border px-3 py-3 items-center justify-center gap-1.5 active:opacity-75 disabled:opacity-40"
                    }
                  >
                    <ActionIcon
                      name="power"
                      tone={ch().isOn ? "primaryFg" : "muted"}
                      size={18}
                    />
                    <Text
                      class={
                        ch().isOn
                          ? "text-primary-foreground text-sm font-semibold"
                          : "text-foreground text-sm font-medium"
                      }
                    >
                      {ch().label}
                    </Text>
                  </Button>
                )}
              </Each>
            </View>
          </View>
        </If>

        {/* Light Dimmer & Color Temperature */}
        <If when={Boolean(cap().dimmer)}>
          <View class="rounded-2xl border border-border bg-card p-4 gap-4">
            <View class="gap-2">
              <View class="flex-row items-center justify-between">
                <View class="flex-row items-center gap-2">
                  <ActionIcon name="sun" tone="foreground" size={16} />
                  <Text class="text-foreground text-sm font-semibold">{t("brightness")}</Text>
                </View>
                <Text class="text-foreground text-sm font-bold">
                  {cap().dimmer?.brightnessPercent ?? 80}%
                </Text>
              </View>
              <HorizontalValueSlider
                testID={`detail-dimmer-${appliance().id}`}
                min={1}
                max={100}
                step={1}
                value={cap().dimmer?.brightnessPercent ?? 80}
                disabled={!cap().dimmer?.controllable}
                accessibilityLabel={t("brightness")}
                onChange={() => {}}
                onChangeEnd={(val) => {
                  const dm = cap().dimmer;
                  if (dm) setLightBrightness(dm.entityId, val);
                }}
              />
            </View>

            <If when={Boolean(cap().dimmer?.colorTempRange)}>
              <View class="gap-2 pt-2 border-t border-border">
                <View class="flex-row items-center justify-between">
                  <Text class="text-foreground text-sm font-semibold">{t("colorTemperature")}</Text>
                  <Text class="text-muted-foreground text-xs font-semibold">
                    {cap().dimmer?.colorTempKelvin ?? 4000}K
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
                      onPress={() => {
                        const dm = cap().dimmer;
                        if (dm) setLightColorTemp(dm.entityId, preset.k);
                      }}
                      class={
                        Math.abs((cap().dimmer?.colorTempKelvin ?? 4000) - preset.k) < 400
                          ? "flex-1 min-w-20 min-h-10 px-2.5 rounded-xl bg-primary items-center justify-center active:opacity-75"
                          : "flex-1 min-w-20 min-h-10 px-2.5 rounded-xl bg-muted border border-border items-center justify-center active:opacity-75"
                      }
                    >
                      <Text
                        class={
                          Math.abs((cap().dimmer?.colorTempKelvin ?? 4000) - preset.k) < 400
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
        <If when={Boolean(cap().thermostat)}>
          <View class="rounded-2xl border border-border bg-card p-4 gap-3">
            <View class="flex-row items-center justify-between">
              <Text class="text-foreground text-sm font-semibold">
                {t("targetTemperature")}
              </Text>
              <Text class="text-foreground text-2xl font-bold">
                {cap().thermostat?.targetTemp}
                {cap().thermostat?.unit ?? "°C"}
              </Text>
            </View>
            <HorizontalValueSlider
              testID={`detail-therm-slider-${appliance().id}`}
              min={cap().thermostat?.minTemp ?? 16}
              max={cap().thermostat?.maxTemp ?? 31}
              step={cap().thermostat?.step ?? 0.5}
              value={cap().thermostat?.targetTemp ?? 26}
              disabled={!cap().thermostat?.controllable}
              accessibilityLabel={t("targetTemperature")}
              onChange={() => {}}
              onChangeEnd={(val) => {
                const th = cap().thermostat;
                if (th) {
                  adjustThermostat(
                    th.entityId,
                    th.domain,
                    val,
                    th.minTemp,
                    th.maxTemp,
                    th.step,
                  );
                }
              }}
            />
          </View>
        </If>

        {/* Mode Selection */}
        <If when={Boolean(cap().modeBar)}>
          <View class="rounded-2xl border border-border bg-card p-4 gap-2.5">
            <Text class="text-foreground text-sm font-semibold">{t("modeSelection")}</Text>
            <If
              when={(cap().modeBar?.options.length ?? 0) > 6}
              else={
                <View class="flex-row items-center gap-2 flex-wrap">
                  <Each of={cap().modeBar?.options ?? []} key={(opt) => opt.value}>
                    {(opt) => (
                      <Button
                        testID={`detail-mode-${opt().value}`}
                        disabled={!cap().modeBar?.controllable}
                        selected={cap().modeBar?.currentMode === opt().value}
                        onPress={() => {
                          const mb = cap().modeBar;
                          if (mb) selectMode(mb, opt().value);
                        }}
                        class={
                          cap().modeBar?.currentMode === opt().value
                            ? "flex-1 min-w-20 min-h-11 px-3 rounded-xl bg-primary items-center justify-center active:opacity-75 disabled:opacity-40"
                            : "flex-1 min-w-20 min-h-11 px-3 rounded-xl bg-muted border border-border items-center justify-center active:opacity-75 disabled:opacity-40"
                        }
                      >
                        <Text
                          class={
                            cap().modeBar?.currentMode === opt().value
                              ? "text-primary-foreground text-sm font-semibold"
                              : "text-foreground text-sm font-medium"
                          }
                        >
                          {opt().label}
                        </Text>
                      </Button>
                    )}
                  </Each>
                </View>
              }
            >
              <SelectField
                testID={`detail-mode-select-${appliance().id}`}
                label={t("modeSelection")}
                items={(cap().modeBar?.options ?? []).map((opt) => ({
                  value: opt.value,
                  title: opt.label,
                }))}
                value={cap().modeBar?.currentMode ?? ""}
                disabled={!cap().modeBar?.controllable}
                onChange={(val) => {
                  const mb = cap().modeBar;
                  if (mb) selectMode(mb, val);
                }}
              />
            </If>
          </View>
        </If>

        {/* Additional Choice & Range Controls (Fan Level, Swing Angle, Favorite Speed, Keep Warm, etc.) */}
        {renderExtraControlsSection(appliance)}

        {/* Action Triggers */}
        <If when={(cap().actions?.length ?? 0) > 0}>
          <View class="rounded-2xl border border-border bg-card p-4 gap-2.5">
            <Text class="text-foreground text-sm font-semibold">{t("primaryControls")}</Text>
            <View class="flex-row items-center gap-2 flex-wrap">
              <Each of={cap().actions ?? []} key={(act) => act.id}>
                {(act) => (
                  <Button
                    testID={`detail-act-${act().id}`}
                    onPress={() => triggerAction(act())}
                    class={
                      act().tone === "primary"
                        ? "flex-1 min-w-28 min-h-12 px-4 rounded-xl bg-primary flex-row items-center justify-center gap-2 active:opacity-75"
                        : "flex-1 min-w-28 min-h-12 px-4 rounded-xl bg-muted border border-border flex-row items-center justify-center gap-2 active:opacity-75"
                    }
                  >
                    <ActionIcon
                      name={resolveActionIconName(act())}
                      tone={act().tone === "primary" ? "primaryFg" : "foreground"}
                      size={16}
                    />
                    <Text
                      class={
                        act().tone === "primary"
                          ? "text-primary-foreground text-sm font-semibold"
                          : "text-foreground text-sm font-medium"
                      }
                    >
                      {act().label}
                    </Text>
                  </Button>
                )}
              </Each>
            </View>
          </View>
        </If>

        {/* Auxiliary Toggles */}
        <If when={(cap().auxiliaryToggles?.length ?? 0) > 0}>
          <View class="rounded-2xl border border-border bg-card p-4 gap-2.5">
            <Text class="text-foreground text-sm font-semibold">{t("auxiliaryFeatures")}</Text>
            <View class="flex-row items-center gap-2 flex-wrap">
              <Each of={cap().auxiliaryToggles ?? []} key={(tog) => tog.id}>
                {(tog) => (
                  <Button
                    testID={`detail-aux-${tog().id}`}
                    disabled={!tog().controllable}
                    selected={tog().isOn}
                    onPress={() => togglePower(tog().entityId, tog().domain, tog().isOn)}
                    class={
                      tog().isOn
                        ? "min-h-11 px-3.5 rounded-xl bg-primary flex-row items-center justify-center gap-2 active:opacity-75 disabled:opacity-40"
                        : "min-h-11 px-3.5 rounded-xl bg-muted border border-border flex-row items-center justify-center gap-2 active:opacity-75 disabled:opacity-40"
                    }
                  >
                    <ActionIcon
                      name={tog().isOn ? "check" : "power"}
                      tone={tog().isOn ? "primaryFg" : "muted"}
                      size={14}
                    />
                    <Text
                      class={
                        tog().isOn
                          ? "text-primary-foreground text-xs font-semibold"
                          : "text-foreground text-xs font-medium"
                      }
                    >
                      {tog().label}
                    </Text>
                  </Button>
                )}
              </Each>
            </View>
          </View>
        </If>

        {/* Read-only Security Notice for Smart Locks */}
        <If when={Boolean(cap().securityEvents)}>
          <View class="rounded-2xl border border-border bg-card p-4 gap-2">
            <View class="flex-row items-center gap-2">
              <ActionIcon name="shield" tone="verified" size={16} />
              <Text class="text-foreground text-sm font-semibold">
                {t("securityEventsTimeline")}
              </Text>
            </View>
            <Text class="text-muted-foreground text-xs">{t("readOnlySecurityNotice")}</Text>
            <Each
              of={cap().securityEvents?.events ?? []}
              key={(ev) => `${ev.time}:${ev.label}`}
            >
              {(ev) => (
                <View class="flex-row items-center justify-between pt-1">
                  <Text class="text-foreground text-xs font-medium">{ev().label}</Text>
                  <Text class="text-muted-foreground text-xs">{ev().time}</Text>
                </View>
              )}
            </Each>
          </View>
        </If>

        {/* Telemetry Metrics */}
        <If when={cap().telemetry.length > 0}>
          <View class="rounded-2xl border border-border bg-card p-4 gap-2.5">
            <Text class="text-foreground text-sm font-semibold">{t("telemetryMetrics")}</Text>
            <View class="flex-row items-center gap-2.5 flex-wrap">
              <Each of={cap().telemetry} key={(m) => m.key}>
                {(m) => (
                  <View class="min-w-28 flex-1 rounded-xl bg-muted border border-border px-3.5 py-2.5 gap-0.5">
                    <Text class="text-muted-foreground text-xs">{m().label}</Text>
                    <Text class="text-foreground text-base font-bold">{m().value}</Text>
                  </View>
                )}
              </Each>
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
                  else={renderGenericApplianceFullPage(appliance)}
                >
                  {renderCycleApplianceFullPage(appliance)}
                </If>
              }
            >
              {renderVacuumFullPage(appliance)}
            </If>
          }
        >
          {renderCameraFullPage(appliance)}
        </If>
      </Scroll>
    );
  };

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
      <View class={isWide() ? "flex-1 flex-row gap-3" : "flex-1"} style={{ minHeight: 0 }}>
        <If when={!overviewCollapsed()}>
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
              class="rounded-2xl border border-border bg-card p-3 gap-2 flex-col"
              style={{ width: 196, minHeight: 0 }}
            >
              <View class="px-1 py-0.5 flex-row items-center justify-between">
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

              <Scroll class="flex-1" scrollbar={false} contentClass="gap-1.5 pb-2">
                <Button
                  testID="home-room-nav-all"
                  selected={selectedRoomName() === "all"}
                  onPress={() => props.store.setHomeSelectedRoom("all")}
                  class={
                    selectedRoomName() === "all"
                      ? "w-full rounded-xl bg-primary px-3 py-2 items-start gap-0.5 active:opacity-75"
                      : "w-full rounded-xl bg-muted border border-border px-3 py-2 items-start gap-0.5 active:opacity-75"
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
                          ? "w-full rounded-xl bg-primary px-3 py-2 items-start gap-0.5 active:opacity-75"
                          : "w-full rounded-xl bg-card border border-border px-3 py-2 items-start gap-0.5 active:bg-muted"
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
        </If>

        {/* Right Scrollable Multi-Size Bento Canvas */}
        <View
          class="flex-1"
          style={{ minWidth: 0, minHeight: 0 }}
          onLayout={(e) => {
            if (e.bounds.size.width > 0) {
              canvasWidth.set(Math.round(e.bounds.size.width));
            }
          }}
        >
          <Switch
            testID="home-overview-collapse"
            accessibilityLabel={t("collapseHomeOverview")}
            checked={overviewCollapsed()}
            onChange={(event) => props.store.setHomeOverviewCollapsed(event.checked)}
            class="self-end min-h-11 px-2 flex-row items-center gap-2 focus:bg-muted rounded-xl"
            trackClass="w-11 h-6 rounded-full bg-border border border-border p-0.5 justify-center checked:bg-primary checked:border-primary"
            thumbClass="w-5 h-5 rounded-full bg-card checked:bg-primary-foreground checked:translate-x-5"
          >
            <Text class="text-muted-foreground text-xs font-medium">{t("collapseHomeOverview")}</Text>
          </Switch>
          <Scroll testID="home-device-grid-scroll" class="flex-1" contentClass="gap-3 pb-4">
            <Each of={visibleRooms()} key={(room) => room.id}>
              {(room) => (
                <View class="rounded-2xl bg-room-surface border border-border p-3.5 gap-3">
                  {/* Room Section Header + Environment Strip + Active Summary + Per-Room Edit & More Menu */}
                  <View class="gap-2">
                    <View class="flex-row items-center justify-between gap-2">
                      <Text class="text-foreground text-lg font-bold" role="header">
                        {room().name}
                      </Text>

                      <View class="flex-row items-center gap-2">
                        <Text class="text-muted-foreground text-xs">
                          {t("activeCountSummary", {
                            active: room().activeCount,
                            total: room().totalCount,
                          })}
                        </Text>

                        <Button
                          testID={`home-room-edit-${room().name}`}
                          accessibilityLabel={
                            isRoomEditing(room().name) ? t("doneLayout") : t("editLayout")
                          }
                          selected={isRoomEditing(room().name)}
                          onPress={() => {
                            openRoomMenu.set(null);
                            movingApplianceId.set(null);
                            resizePreview.set(null);
                            reorderPreview.set(null);
                            props.store.setHomeLayoutEditing(
                              isRoomEditing(room().name) ? null : room().name,
                            );
                          }}
                          class={
                            isRoomEditing(room().name)
                              ? "min-h-11 px-3.5 rounded-full bg-primary flex-row items-center justify-center gap-1.5 active:opacity-75"
                              : "min-h-11 px-3.5 rounded-full bg-card border border-border flex-row items-center justify-center gap-1.5 active:opacity-75"
                          }
                        >
                          <ActionIcon
                            name={isRoomEditing(room().name) ? "check" : "edit"}
                            tone={isRoomEditing(room().name) ? "primaryFg" : "muted"}
                            size={13}
                          />
                          <Text
                            class={
                              isRoomEditing(room().name)
                                ? "text-primary-foreground text-xs font-semibold"
                                : "text-foreground text-xs font-medium"
                            }
                          >
                            {isRoomEditing(room().name) ? t("doneLayout") : t("editLayout")}
                          </Text>
                        </Button>

                        <If
                          when={
                            !isRoomEditing(room().name) &&
                            (room().roomPowerEntities.turnOnIds.length > 0 ||
                              room().roomPowerEntities.turnOffIds.length > 0)
                          }
                        >
                          <Button
                            testID={`home-room-more-${room().name}`}
                            accessibilityLabel={`${room().name} 更多操作`}
                            selected={openRoomMenu() === room().name}
                            onPress={() =>
                              openRoomMenu.set(
                                openRoomMenu() === room().name ? null : room().name,
                              )
                            }
                            class={
                              openRoomMenu() === room().name
                                ? "w-11 h-11 rounded-full bg-primary items-center justify-center active:opacity-75"
                                : "w-11 h-11 rounded-full bg-card border border-border items-center justify-center active:opacity-75"
                            }
                          >
                            <ActionIcon
                              name="more"
                              tone={openRoomMenu() === room().name ? "primaryFg" : "foreground"}
                              size={15}
                            />
                          </Button>
                        </If>
                      </View>
                    </View>

                    <If when={room().environment.length > 0}>
                      <View class="flex-row items-center gap-1.5 flex-wrap">
                        <Each of={room().environment.slice(0, 4)} key={(env) => env.key}>
                          {(env) => (
                            <View class="px-2.5 py-1 rounded-full bg-card border border-border flex-row items-center gap-1.5">
                              <If when={env().key === "temperature"}>
                                <ActionIcon name="thermometer" tone="warning" size={13} />
                              </If>
                              <If when={env().key === "humidity"}>
                                <ActionIcon name="droplet" tone="airflow" size={13} />
                              </If>
                              <If when={env().key === "pm25"}>
                                <ActionIcon name="leaf" tone="airQuality" size={13} />
                              </If>
                              <If when={env().key !== "temperature" && env().key !== "humidity"}>
                                <Text class="text-muted-foreground text-xs">{env().label}</Text>
                              </If>
                              <Text class="text-foreground text-xs font-semibold">{env().value}</Text>
                              <If when={Boolean(env().badge)}>
                                <View class="px-1.5 py-0.5 rounded-full bg-air-quality-bg border border-air-quality-border">
                                  <Text class="text-air-quality text-xs font-bold">
                                    {env().badge}
                                  </Text>
                                </View>
                              </If>
                            </View>
                          )}
                        </Each>
                      </View>
                    </If>
                  </View>

                  {/* Room Batch Power Secondary Menu */}
                  <If when={!isRoomEditing(room().name) && openRoomMenu() === room().name}>
                    <View class="rounded-2xl bg-card border border-border p-2.5 flex-row items-center justify-between gap-2 flex-wrap">
                      <Text class="text-muted-foreground text-xs px-1">
                        房间照明与插座快捷控制
                      </Text>
                      <View class="flex-row items-center gap-2">
                        <If when={room().roomPowerEntities.turnOnIds.length > 0}>
                          <Button
                            testID={`home-room-on-${room().name}`}
                            onPress={() => {
                              openRoomMenu.set(null);
                              void props.store.controlRoomPower(room().name, true);
                            }}
                            class="min-h-9 px-3 rounded-xl bg-live-active-bg border border-verified flex-row items-center justify-center gap-1.5 active:opacity-75"
                          >
                            <ActionIcon name="power" tone="verified" size={13} />
                            <Text class="text-verified text-xs font-semibold">
                              灯和插座全开
                            </Text>
                          </Button>
                        </If>
                        <If when={room().roomPowerEntities.turnOffIds.length > 0}>
                          <Button
                            testID={`home-room-off-${room().name}`}
                            onPress={() => {
                              openRoomMenu.set(null);
                              void props.store.controlRoomPower(room().name, false);
                            }}
                            class="min-h-9 px-3 rounded-xl bg-muted border border-border flex-row items-center justify-center gap-1.5 active:opacity-75"
                          >
                            <ActionIcon name="power" tone="muted" size={13} />
                            <Text class="text-foreground text-xs font-medium">
                              灯和插座全关
                            </Text>
                          </Button>
                        </If>
                      </View>
                    </View>
                  </If>

                  {/* CSS Grid with stable order flow & fixed base row height for 1x1, 2x1, 1x2, 2x2 Bento tiles */}
                  <View
                    style={{
                      display: "grid",
                      gridTemplateColumns: `repeat(${gridColumns()}, 1fr)`,
                      gridAutoRows: `${BASE_ROW_HEIGHT}px`,
                      gridAutoFlow: "row",
                      gap: GRID_GAP,
                    }}
                  >
                    <Each
                      of={
                        reorderPreview()?.roomId === room().id
                          ? reorderPreview()!.appliances
                          : room().appliances
                      }
                      key={(appliance) => appliance.id}
                    >
                      {(app) => renderApplianceCard(room, app)}
                    </Each>
                  </View>
                </View>
              )}
            </Each>
          </Scroll>
        </View>
      </View>
    </If>
  );

  // --- Services Sub-View (Split Layout: Master Services List & Service Details) ---
  const renderServicesSubView = () => {
    const miotMenuOpen = signal(false);

    const enabledSources = () =>
      saved().enabledSources ?? {
        direct_miot: saved().mode === "direct_miot",
        external_ha: saved().mode === "external_ha",
        simulation: saved().mode === "simulation",
      };

    const isMiotControlConnected = () =>
      Boolean(enabledSources().direct_miot && saved().hasMiotAccount);

    const isMiotVideoAuthorized = () =>
      Boolean(
        typeof props.store.xiaomiVideoAuth === "function" &&
          props.store.xiaomiVideoAuth().authorized,
      );

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

    const haDevicesCount = () =>
      enabledSources().external_ha ? props.store.homeDashboard().totalAppliances : 0;

    return (
      <View class={isWide() ? "flex-1 flex-row items-stretch bg-background" : "flex-1 flex-col bg-background"}>
        {/* Left Column: Home Services List */}
        <View
          class={
            isWide()
              ? "w-72 shrink-0 border-r border-border p-4 gap-3 bg-card/40"
              : "w-full border-b border-border p-4 gap-3 bg-card/40"
          }
        >
          <Text class="text-foreground text-sm font-bold px-1">家居服务</Text>

          {/* 1. Mijia Direct Card */}
          <Button
            testID="home-service-tab-direct_miot"
            onPress={() => activeServiceTab.set("direct_miot")}
            class={
              activeServiceTab() === "direct_miot"
                ? "w-full rounded-2xl border-2 border-ring bg-card p-3 flex-row items-center gap-3 active:opacity-80"
                : "w-full rounded-2xl border border-border bg-card/60 p-3 flex-row items-center gap-3 active:opacity-80"
            }
          >
            <MijiaBrandIcon size={40} />
            <View class="flex-1 min-w-0 gap-1 items-start">
              <Text class="text-foreground text-sm font-bold">米家直连</Text>
              <View class="flex-row items-center gap-1.5">
                <View
                  class={
                    isMiotControlConnected()
                      ? "w-1.5 h-1.5 rounded-full bg-verified"
                      : "w-1.5 h-1.5 rounded-full bg-muted-foreground/60"
                  }
                />
                <Text
                  class={
                    isMiotControlConnected()
                      ? "text-verified text-[11px] font-medium"
                      : "text-muted-foreground text-[11px]"
                  }
                >
                  {isMiotControlConnected() ? "控制已连接" : "控制未连接"}
                </Text>
              </View>
              <View class="flex-row items-center gap-1.5">
                <View
                  class={
                    isMiotVideoAuthorized()
                      ? "w-1.5 h-1.5 rounded-full bg-verified"
                      : "w-1.5 h-1.5 rounded-full bg-muted-foreground/60"
                  }
                />
                <Text
                  class={
                    isMiotVideoAuthorized()
                      ? "text-verified text-[11px] font-medium"
                      : "text-muted-foreground text-[11px]"
                  }
                >
                  {isMiotVideoAuthorized() ? "视频已授权" : "视频未连接"}
                </Text>
              </View>
            </View>
          </Button>

          {/* 2. Home Assistant Card */}
          <Button
            testID="home-service-tab-external_ha"
            onPress={() => activeServiceTab.set("external_ha")}
            class={
              activeServiceTab() === "external_ha"
                ? "w-full rounded-2xl border-2 border-ring bg-card p-3 flex-row items-center gap-3 active:opacity-80"
                : "w-full rounded-2xl border border-border bg-card/60 p-3 flex-row items-center gap-3 active:opacity-80"
            }
          >
            <HomeAssistantBrandIcon size={40} />
            <View class="flex-1 min-w-0 gap-1 items-start">
              <Text class="text-foreground text-sm font-bold">Home Assistant</Text>
              <Text class="text-muted-foreground text-[11px]">
                {enabledSources().external_ha
                  ? `已连接 · ${haDevicesCount()} 台设备`
                  : "未连接"}
              </Text>
            </View>
          </Button>

          {/* 3. Offline Demo Card */}
          <Button
            testID="home-service-tab-simulation"
            onPress={() => activeServiceTab.set("simulation")}
            class={
              activeServiceTab() === "simulation"
                ? "w-full rounded-2xl border-2 border-ring bg-card p-3 flex-row items-center gap-3 active:opacity-80"
                : "w-full rounded-2xl border border-border bg-card/60 p-3 flex-row items-center gap-3 active:opacity-80"
            }
          >
            <View class="w-10 h-10 rounded-xl bg-muted border border-border items-center justify-center">
              <ActionIcon name="display" size={20} tone="foreground" />
            </View>
            <View class="flex-1 min-w-0 gap-1 items-start">
              <Text class="text-foreground text-sm font-bold">离线演示</Text>
              <Text class="text-muted-foreground text-[11px]">
                {enabledSources().simulation ? "已启用" : "未启用"}
              </Text>
            </View>
          </Button>
        </View>

        {/* Right Column: Service Detail Panel */}
        <Scroll class="flex-1" contentClass="p-6 gap-5">
          <View class="max-w-2xl w-full gap-5">
            {/* Mijia Detail Panel */}
            <If when={activeServiceTab() === "direct_miot"}>
              {/* Header: Title and More Menu */}
              <View class="flex-row items-center justify-between pb-1 relative">
                <View class="gap-0.5">
                  <Text role="header" class="text-foreground text-xl font-bold">
                    {t("xiaomiHome92")}
                  </Text>
                  <Text class="text-muted-foreground text-xs">
                    {t("connectYourXiaomiHomeAccount")}
                  </Text>
                </View>

                <View class="relative">
                  <Button
                    testID="home-miot-more-btn"
                    onPress={() => miotMenuOpen.update((v) => !v)}
                    class="h-9 px-3 rounded-full border border-border bg-card flex-row items-center gap-1 active:opacity-75"
                  >
                    <Text class="text-foreground text-xs font-medium">更多 ···</Text>
                  </Button>

                  <If when={miotMenuOpen()}>
                    <View class="absolute right-0 top-11 z-30 min-w-44 rounded-xl border border-border bg-popover shadow-xl p-1 gap-1">
                      <Button
                        testID="home-miot-menu-relogin"
                        onPress={() => {
                          miotMenuOpen.set(false);
                          void loginXiaomi();
                        }}
                        class="w-full h-9 px-3 rounded-lg flex-row items-center justify-start hover:bg-muted active:opacity-75"
                      >
                        <Text class="text-foreground text-xs">重新登录控制账号</Text>
                      </Button>
                      <If when={isMiotVideoAuthorized()}>
                        <Button
                          testID="home-miot-menu-disconnect-video"
                          onPress={() => {
                            miotMenuOpen.set(false);
                            props.store.disconnectXiaomiVideo();
                          }}
                          class="w-full h-9 px-3 rounded-lg flex-row items-center justify-start hover:bg-muted active:opacity-75"
                        >
                          <Text class="text-destructive text-xs">断开视频连接</Text>
                        </Button>
                      </If>
                      <If when={savedMiotSelected()}>
                        <Button
                          testID="home-miot-menu-logout"
                          onPress={() => {
                            miotMenuOpen.set(false);
                            void props.store.logoutMiot();
                          }}
                          class="w-full h-9 px-3 rounded-lg flex-row items-center justify-start hover:bg-muted active:opacity-75"
                        >
                          <Text class="text-destructive text-xs">退出米家账号</Text>
                        </Button>
                      </If>
                    </View>
                  </If>
                </View>
              </View>

              {/* Service Region Row */}
              <View class="flex-row items-center justify-between py-1">
                <Text class="text-foreground text-sm font-medium">{t("xiaomiHomeRegion")}</Text>
                <View class="w-48">
                  <SelectField
                    testID="home-miot-region"
                    accessibilityLabel={t("xiaomiHomeRegion")}
                    items={REGIONS()}
                    value={region()}
                    disabled={props.store.homeLoggingIn()}
                    onChange={(value) => region.set(value)}
                  />
                </View>
              </View>

              {/* Block 1: Device Control Card */}
              <View class="rounded-2xl border border-border bg-card p-4 gap-3">
                <View class="flex-row items-center justify-between gap-3">
                  <View class="flex-row items-center gap-3 flex-1 min-w-0">
                    <View class="w-10 h-10 rounded-xl bg-muted border border-border items-center justify-center">
                      <ActionIcon name="outlet" size={20} tone="foreground" />
                    </View>
                    <View class="flex-1 min-w-0 gap-0.5">
                      <View class="flex-row items-center gap-2">
                        <Text class="text-foreground text-sm font-bold">设备控制</Text>
                        <View class="flex-row items-center gap-1">
                          <View
                            class={
                              isMiotControlConnected()
                                ? "w-1.5 h-1.5 rounded-full bg-verified"
                                : "w-1.5 h-1.5 rounded-full bg-muted-foreground/60"
                            }
                          />
                          <Text
                            class={
                              isMiotControlConnected()
                                ? "text-verified text-xs font-semibold"
                                : "text-muted-foreground text-xs"
                            }
                          >
                            {isMiotControlConnected() ? "已连接" : "未连接"}
                          </Text>
                        </View>
                      </View>
                      <Text class="text-muted-foreground text-xs" style={{ numberOfLines: 1 }}>
                        同步设备并控制开关、灯光等。
                      </Text>
                    </View>
                  </View>

                  <If
                    when={savedMiotSelected()}
                    else={
                      <Button
                        testID="home-miot-login"
                        disabled={props.store.homeLoggingIn()}
                        onPress={() => void loginXiaomi()}
                        class="h-9 px-4 rounded-full bg-primary items-center justify-center active:opacity-80 disabled:opacity-50"
                      >
                        <Text class="text-primary-foreground text-xs font-semibold">
                          {props.store.homeLoggingIn()
                            ? t("waitingForXiaomiAuthorization")
                            : t("signInToXiaomiHome")}
                        </Text>
                      </Button>
                    }
                  >
                    <Button
                      testID="home-miot-refresh"
                      accessibilityLabel={
                        saved().mode === "direct_miot"
                          ? t("refreshXiaomiDevices")
                          : t("connectSavedXiaomiAccount")
                      }
                      disabled={busy() || props.store.homeLoggingIn()}
                      onPress={() => void refreshMiot()}
                      class="h-9 px-4 rounded-full border border-border bg-card items-center justify-center active:opacity-75 disabled:opacity-50"
                    >
                      <Text class="text-foreground text-xs font-medium">
                        {saved().mode === "direct_miot"
                          ? "同步设备"
                          : t("connectSavedXiaomiAccount")}
                      </Text>
                    </Button>
                  </If>
                </View>

                <View class="h-[1px] bg-border w-full my-0.5" />

                <View class="flex-row items-center justify-between">
                  <Text class="text-foreground text-sm font-medium">启用设备控制</Text>
                  <Switch
                    testID="home-miot-control-toggle"
                    checked={Boolean(enabledSources().direct_miot)}
                    onChange={(e) => void props.store.setHomeSourceEnabled("direct_miot", e.checked)}
                  />
                </View>

                {/* Explicit logout entry when logged in and configured */}
                <If when={saved().mode === "direct_miot" && savedMiotSelected() && !props.store.homeLoggingIn()}>
                  <View class="flex-row justify-end pt-1">
                    <Button
                      testID="home-miot-logout"
                      onPress={() => void props.store.logoutMiot()}
                      class="h-8 px-3 rounded-lg border border-destructive/40 bg-card items-center justify-center active:opacity-70"
                    >
                      <Text class="text-destructive text-xs font-medium">{t("signOutOfXiaomiHome")}</Text>
                    </Button>
                  </View>
                </If>
                <If when={props.store.homeLoggingIn()}>
                  <View class="flex-row justify-end pt-1">
                    <Button
                      testID="home-miot-cancel"
                      onPress={() => props.store.cancelHomeLogin()}
                      class="h-8 px-3 rounded-lg border border-border bg-card items-center justify-center active:opacity-70"
                    >
                      <Text class="text-foreground text-xs font-medium">{t("cancelXiaomiSignin")}</Text>
                    </Button>
                  </View>
                </If>
              </View>

              {/* Block 2: Camera Video Card */}
              <View class="rounded-2xl border border-border bg-card p-4 gap-3">
                <View class="flex-row items-center justify-between gap-3">
                  <View class="flex-row items-center gap-3 flex-1 min-w-0">
                    <View class="w-10 h-10 rounded-xl bg-muted border border-border items-center justify-center">
                      <ActionIcon name="video" size={20} tone="foreground" />
                    </View>
                    <View class="flex-1 min-w-0 gap-0.5">
                      <View class="flex-row items-center gap-2">
                        <Text class="text-foreground text-sm font-bold">摄像头视频</Text>
                        <View class="flex-row items-center gap-1">
                          <View
                            class={
                              isMiotVideoAuthorized()
                                ? "w-1.5 h-1.5 rounded-full bg-verified"
                                : "w-1.5 h-1.5 rounded-full bg-muted-foreground/60"
                            }
                          />
                          <Text
                            class={
                              isMiotVideoAuthorized()
                                ? "text-verified text-xs font-semibold"
                                : "text-muted-foreground text-xs"
                            }
                          >
                            {isMiotVideoAuthorized() ? "已授权" : "未连接"}
                          </Text>
                        </View>
                      </View>
                      <Text class="text-muted-foreground text-xs" style={{ numberOfLines: 1 }}>
                        {isMiotVideoAuthorized()
                          ? `已关联 ${props.store.xiaomiVideoAuth().cameraCount} 台摄像头。`
                          : "额外登录，用于查看实时画面。"}
                      </Text>
                    </View>
                  </View>

                  <If
                    when={isMiotVideoAuthorized()}
                    else={
                      <Button
                        testID="home-miot-connect-video-btn"
                        onPress={() => props.store.startXiaomiVideoLogin()}
                        class="h-9 px-4 rounded-full bg-[#f5e0a0] items-center justify-center active:opacity-80"
                      >
                        <Text class="text-[#2a2206] text-xs font-bold">连接视频···</Text>
                      </Button>
                    }
                  >
                    <Button
                      testID="home-miot-view-cameras-btn"
                      onPress={() => props.store.setHomeSubView("devices")}
                      class="h-9 px-4 rounded-full border border-border bg-card items-center justify-center active:opacity-75"
                    >
                      <Text class="text-foreground text-xs font-semibold">查看摄像头</Text>
                    </Button>
                  </If>
                </View>

                <Text class="text-muted-foreground text-xs pt-0.5">
                  使用摄像头所属的米家账号登录。
                </Text>
              </View>
            </If>

            {/* Home Assistant Detail Panel */}
            <If when={activeServiceTab() === "external_ha"}>
              <View class="flex-row items-center justify-between pb-1">
                <Text class="text-foreground text-xl font-bold">Home Assistant</Text>
              </View>

              <View class="rounded-2xl border border-border bg-card p-5 gap-4">
                <View class="gap-1">
                  <Text class="text-foreground text-base font-semibold">
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
                <View class="flex-row flex-wrap gap-2 pt-2">
                  <ActionButton
                    testID="home-connect"
                    kind="primary"
                    disabled={busy()}
                    label={busy() ? t("connecting48") : t("connectHomeAssistant")}
                    onPress={() => void saveHa()}
                  />
                </View>

                <View class="h-[1px] bg-border w-full my-1" />

                <View class="flex-row items-center justify-between">
                  <Text class="text-foreground text-sm font-medium">启用 Home Assistant</Text>
                  <Switch
                    testID="home-ha-source-toggle"
                    checked={Boolean(enabledSources().external_ha)}
                    onChange={(e) => void props.store.setHomeSourceEnabled("external_ha", e.checked)}
                  />
                </View>
              </View>
            </If>

            {/* Offline Simulation Detail Panel */}
            <If when={activeServiceTab() === "simulation"}>
              <View class="flex-row items-center justify-between pb-1">
                <Text class="text-foreground text-xl font-bold">离线演示</Text>
              </View>

              <View class="rounded-2xl border border-border bg-card p-5 gap-4">
                <Text class="text-foreground text-base font-semibold">
                  {t("offlineDemoEnvironment")}
                </Text>
                <Text class="text-muted-foreground text-sm">
                  {t("tryAStudyCeilingLightDeskLamp")}
                </Text>
                <View class="flex-row items-center justify-between pt-2">
                  <Text class="text-foreground text-sm font-medium">启用离线演示设备</Text>
                  <Switch
                    testID="home-simulation-toggle"
                    checked={Boolean(enabledSources().simulation)}
                    onChange={(e) => void props.store.setHomeSourceEnabled("simulation", e.checked)}
                  />
                </View>
              </View>
            </If>

            {/* Error Message Alert */}
            <If when={translateMessage(props.store.homeConnection()?.error || "")}>
              <View class="rounded-xl border border-destructive bg-muted p-3">
                <Text role="alert" class="text-destructive text-xs font-medium">
                  {translateMessage(props.store.homeConnection()?.error || "")}
                </Text>
              </View>
            </If>
          </View>
        </Scroll>
      </View>
    );
  };

  return (
    <View class="flex-1 bg-background" style={{ minHeight: 0 }}>
      <RetainedPage active={subView() === "devices" && !inspectedAppliance()}>
        {renderDevicesSubView()}
      </RetainedPage>
      <RetainedPage active={subView() === "services"}>
        {renderServicesSubView()}
      </RetainedPage>
      <RetainedPage active={subView() === "video_login"}>
        <XiaomiVideoLoginFlow store={props.store} />
      </RetainedPage>
      <If when={subView() === "devices" && Boolean(inspectedAppliance())}>
        <Each
          of={inspectedAppliance() ? [inspectedAppliance()!] : []}
          key={(appliance) => appliance.id}
        >
          {(app) => renderFullPageApplianceView(app)}
        </Each>
      </If>
    </View>
  );
}
