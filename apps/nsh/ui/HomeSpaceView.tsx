import { t, translateMessage } from "../i18n";
import { effect, signal, Text, View, Scroll, windowSize } from "nsh";
import { Button } from "nsh/base";
import type {
  HomeAppliance,
  HomeConfiguration,
  HomeDashboardModel,
  HomeRoomSection,
  HomeSourceId,
  TileSpan,
} from "../generated/looi-runtime.js";
import type { createAppStore } from "../store";
import { ActionButton, Panel, SelectField, TextField } from "./Controls";

type HomeModeTab = "direct_miot" | "external_ha" | "simulation";

interface BentoRowItem {
  key: string;
  appliance?: HomeAppliance;
  weight: number;
}

interface BentoRow {
  id: string;
  items: BentoRowItem[];
}

function packBentoRows(appliances: HomeAppliance[], maxColumns: number): BentoRow[] {
  const cols = Math.max(1, maxColumns);
  if (cols === 1) {
    return appliances.map((a) => ({
      id: `row_${a.id}`,
      items: [{ key: a.id, appliance: a, weight: 1 }],
    }));
  }
  const rows: BentoRow[] = [];
  let current: BentoRowItem[] = [];
  let used = 0;

  const flush = () => {
    if (current.length === 0) return;
    if (used < cols) {
      current.push({
        key: `spacer_${rows.length}_${used}`,
        weight: cols - used,
      });
    }
    rows.push({
      id: current.map((entry) => entry.key).join("__"),
      items: current,
    });
    current = [];
    used = 0;
  };

  for (const app of appliances) {
    const spanCols = app.span === "1x1" ? 1 : Math.min(cols, 2);
    if (used + spanCols > cols) {
      flush();
    }
    current.push({
      key: app.id,
      appliance: app,
      weight: spanCols,
    });
    used += spanCols;
    if (used >= cols) {
      flush();
    }
  }
  flush();
  return rows;
}

export function HomeSpaceView(props: {
  store: ReturnType<typeof createAppStore>;
  modeTab?: HomeModeTab | (() => HomeModeTab);
}) {
  const localServiceTab = signal<HomeModeTab>("direct_miot");

  let lastExternalModeTab = "";
  effect(() => {
    const ext =
      typeof props.modeTab === "function" ? props.modeTab() : props.modeTab;
    if (ext && ext !== lastExternalModeTab) {
      lastExternalModeTab = ext;
      localServiceTab.set(ext);
    }
  });

  const activeSubView = (): "devices" | "services" => {
    if (typeof props.store.homeSubView === "function") {
      return props.store.homeSubView();
    }
    return "services";
  };

  const dashboard = (): HomeDashboardModel => {
    if (typeof props.store.homeDashboard === "function") {
      return props.store.homeDashboard();
    }
    return {
      homeName: "我的家",
      totalAppliances: 0,
      activeAppliances: 0,
      rooms: [],
      allAppliances: [],
    };
  };

  const selectedRoom = (): string =>
    typeof props.store.homeSelectedRoom === "function"
      ? props.store.homeSelectedRoom()
      : "all";

  const layoutEditing = (): boolean =>
    typeof props.store.homeLayoutEditing === "function"
      ? props.store.homeLayoutEditing()
      : false;

  const inspectedAppliance = (): HomeAppliance | undefined => {
    const id =
      typeof props.store.homeInspectedApplianceId === "function"
        ? props.store.homeInspectedApplianceId()
        : null;
    if (!id) return undefined;
    return dashboard().allAppliances.find((item) => item.id === id);
  };

  const regions = (): Array<{
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

  const region = signal<HomeConfiguration["region"]>("cn");
  const haUrl = signal("");
  const haToken = signal("");
  const working = signal(false);
  const error = signal("");

  let lastSyncedHomeKey = "";
  effect(() => {
    const cfg = props.store.homeConfiguration();
    const readyFlag =
      typeof props.store.ready === "function" ? props.store.ready() : true;
    const key = `${readyFlag}:${cfg.mode}:${cfg.region}:${cfg.haUrl}`;
    if (key === lastSyncedHomeKey) return;
    lastSyncedHomeKey = key;
    haUrl.set(cfg.haUrl || "");
    region.set(cfg.region || "cn");
    haToken.set("");
    error.set("");
  });

  const savedMiotSelected = () =>
    props.store.homeConfiguration().hasMiotAccount &&
    region() === props.store.homeConfiguration().region;

  const devices = () => {
    const value = props.store.homeDevices().devices;
    return Array.isArray(value)
      ? (value as Array<{
          entity_id: string;
          friendly_name: string;
          snapshot?: { state?: string };
        }>)
      : [];
  };

  const loginMiot = async (logout = false) => {
    if (working()) return;
    working.set(true);
    error.set("");
    try {
      if (logout) {
        await props.store.logoutMiot();
      } else {
        await props.store.loginMiot(region());
      }
    } catch (cause) {
      error.set(
        cause instanceof Error && cause.message.startsWith("@looi:")
          ? cause.message
          : "@looi:xiaomiHomeConnectionFailedTryAgainLater",
      );
    } finally {
      working.set(false);
    }
  };

  const refreshMiot = async () => {
    if (working()) return;
    working.set(true);
    error.set("");
    try {
      if (props.store.homeConfiguration().mode !== "direct_miot") {
        await props.store.configureHome({
          mode: "direct_miot",
          region: region(),
        });
      }
      await props.store.connectHome();
      if (typeof props.store.setHomeSubView === "function") {
        props.store.setHomeSubView("devices");
      }
    } catch {
      error.set("@looi:couldNotLoadXiaomiHomeDevicesTry");
    } finally {
      working.set(false);
    }
  };

  const configureHa = async () => {
    if (working()) return;
    working.set(true);
    error.set("");
    try {
      await props.store.configureHome({
        mode: "external_ha",
        haUrl: haUrl().trim(),
        ...(haToken().trim() ? { haToken: haToken().trim() } : {}),
      });
      haToken.set("");
      await props.store.connectHome();
      if (typeof props.store.setHomeSubView === "function") {
        props.store.setHomeSubView("devices");
      }
    } catch (cause) {
      error.set(cause instanceof Error ? cause.message : String(cause));
    } finally {
      working.set(false);
    }
  };

  const configureSimulation = async () => {
    if (working()) return;
    working.set(true);
    error.set("");
    try {
      await props.store.configureHome({ mode: "simulation" });
      await props.store.connectHome();
      if (typeof props.store.setHomeSubView === "function") {
        props.store.setHomeSubView("devices");
      }
    } catch (cause) {
      error.set(cause instanceof Error ? cause.message : String(cause));
    } finally {
      working.set(false);
    }
  };

  const toggleSourceEnabled = async (source: HomeSourceId, enabled: boolean) => {
    if (working() || typeof props.store.setHomeSourceEnabled !== "function") return;
    working.set(true);
    error.set("");
    try {
      await props.store.setHomeSourceEnabled(source, enabled);
    } catch (cause) {
      error.set(cause instanceof Error ? cause.message : String(cause));
    } finally {
      working.set(false);
    }
  };

  const sendCommand = (command: {
    entity_id: string;
    domain: string;
    service: string;
    service_data?: Record<string, unknown>;
  }) => {
    if (typeof props.store.controlHomeAppliance === "function") {
      void props.store.controlHomeAppliance(command);
    }
  };

  const moveApplianceOrder = (
    room: HomeRoomSection,
    appliance: HomeAppliance,
    delta: -1 | 1,
  ) => {
    if (typeof props.store.setHomeApplianceLayout !== "function") return;
    const list = [...room.appliances];
    const idx = list.findIndex((item) => item.id === appliance.id);
    const targetIdx = idx + delta;
    if (idx < 0 || targetIdx < 0 || targetIdx >= list.length) return;
    const temp = list[idx];
    list[idx] = list[targetIdx];
    list[targetIdx] = temp;
    for (let i = 0; i < list.length; i++) {
      void props.store.setHomeApplianceLayout(list[i].id, {
        order: (i + 1) * 10,
      });
    }
  };

  const renderLayoutToolbar = (
    room: HomeRoomSection,
    appliance: HomeAppliance,
  ) => {
    const spans: Array<{ value: TileSpan; label: string }> = [
      { value: "1x1", label: t("spanSmall") },
      { value: "2x1", label: t("spanWide") },
      { value: "2x2", label: t("spanLarge") },
    ];
    return (
      <View class="flex-row items-center justify-between gap-1.5 pb-2 mb-1 border-b border-border">
        <View class="flex-row items-center gap-1">
          <Each of={spans} key={(s) => s.value}>
            {(s) => {
              const active = () => appliance.span === s().value;
              return (
                <Button
                  testID={`tile-span-${s().value}-${appliance.id}`}
                  onPress={() =>
                    void props.store.setHomeApplianceLayout?.(appliance.id, {
                      span: s().value,
                    })
                  }
                  class={
                    active()
                      ? "min-h-8 px-2.5 rounded-lg bg-primary items-center justify-center active:opacity-75"
                      : "min-h-8 px-2.5 rounded-lg border border-border bg-muted items-center justify-center active:opacity-75"
                  }
                >
                  <Text
                    class={
                      active()
                        ? "text-primary-foreground text-xs font-semibold"
                        : "text-muted-foreground text-xs font-medium"
                    }
                  >
                    {s().label}
                  </Text>
                </Button>
              );
            }}
          </Each>
        </View>
        <View class="flex-row items-center gap-1">
          <Button
            testID={`tile-up-${appliance.id}`}
            accessibilityLabel={t("moveEarlier")}
            onPress={() => moveApplianceOrder(room, appliance, -1)}
            class="min-h-8 w-8 rounded-lg border border-border bg-muted items-center justify-center active:opacity-75"
          >
            <Text class="text-foreground text-xs font-bold">↑</Text>
          </Button>
          <Button
            testID={`tile-down-${appliance.id}`}
            accessibilityLabel={t("moveLater")}
            onPress={() => moveApplianceOrder(room, appliance, 1)}
            class="min-h-8 w-8 rounded-lg border border-border bg-muted items-center justify-center active:opacity-75"
          >
            <Text class="text-foreground text-xs font-bold">↓</Text>
          </Button>
        </View>
      </View>
    );
  };

  const renderApplianceHeader = (appliance: HomeAppliance) => (
    <View class="flex-row items-center justify-between gap-2">
      <Button
        testID={`inspect-${appliance.id}`}
        onPress={() => props.store.setHomeInspectedApplianceId?.(appliance.id)}
        class="flex-1 min-w-0 flex-row items-center gap-2 active:opacity-75"
      >
        <View
          class={
            appliance.online
              ? appliance.isActive
                ? "w-2 h-2 rounded-full bg-verified"
                : "w-2 h-2 rounded-full bg-muted-foreground"
              : "w-2 h-2 rounded-full bg-border"
          }
        />
        <View class="flex-1 min-w-0">
          <Text
            class="text-foreground text-sm font-semibold"
            style={{ numberOfLines: 1 }}
          >
            {appliance.name}
          </Text>
          <Text
            class="text-muted-foreground text-xs font-mono"
            style={{ numberOfLines: 1 }}
          >
            {appliance.conciseSubtitle}
          </Text>
        </View>
      </Button>

      <If
        when={
          appliance.capabilities.power?.controllable &&
          appliance.archetype !== "vision_security" &&
          appliance.archetype !== "cycle_appliance" &&
          !appliance.capabilities.multiGang
        }
        else={
          <Button
            testID={`badge-${appliance.id}`}
            onPress={() =>
              props.store.setHomeInspectedApplianceId?.(appliance.id)
            }
            class="min-h-8 px-2.5 rounded-full border border-border bg-muted items-center justify-center active:opacity-75"
          >
            <Text
              class={
                appliance.isActive
                  ? "text-verified text-xs font-semibold"
                  : "text-muted-foreground text-xs font-medium"
              }
            >
              {appliance.statusBadge}
            </Text>
          </Button>
        }
      >
        <Button
          testID={`power-${appliance.id}`}
          onPress={() => {
            const p = appliance.capabilities.power;
            if (!p) return;
            sendCommand({
              entity_id: p.entityId,
              domain: p.domain,
              service: p.isOn ? "turn_off" : "turn_on",
            });
          }}
          class={
            appliance.capabilities.power?.isOn
              ? "min-h-9 px-3 rounded-full bg-primary items-center justify-center active:opacity-75"
              : "min-h-9 px-3 rounded-full border border-border bg-muted items-center justify-center active:opacity-75"
          }
        >
          <Text
            class={
              appliance.capabilities.power?.isOn
                ? "text-primary-foreground text-xs font-semibold"
                : "text-muted-foreground text-xs font-medium"
            }
          >
            {appliance.capabilities.power?.isOn ? t("powerOn") : t("powerOff")}
          </Text>
        </Button>
      </If>
    </View>
  );

  const renderVisionCameraBody = (appliance: HomeAppliance) => {
    const stream = appliance.capabilities.visionStream;
    const isLarge = appliance.span === "2x2";
    const isWide = appliance.span === "2x1" || isLarge;
    return (
      <View class="gap-2.5 mt-1">
        <If when={isWide}>
          <Button
            testID={`camera-viewport-${appliance.id}`}
            onPress={() =>
              props.store.setHomeInspectedApplianceId?.(appliance.id)
            }
            class="w-full rounded-xl bg-stage-bg border border-border p-3 justify-between active:opacity-85"
            style={{ minHeight: isLarge ? 124 : 84 }}
          >
            <View class="flex-row items-center justify-between">
              <View class="flex-row items-center gap-1.5 px-2 py-0.5 rounded-md bg-card border border-border">
                <View
                  class={
                    stream?.streamActive
                      ? "w-1.5 h-1.5 rounded-full bg-verified"
                      : "w-1.5 h-1.5 rounded-full bg-muted-foreground"
                  }
                />
                <Text class="text-foreground text-xs font-mono font-semibold">
                  {stream?.streamActive ? "LIVE · 1080P" : stream?.statusText ?? "STANDBY"}
                </Text>
              </View>
              <If when={stream?.lastMotionText}>
                <View class="px-2 py-0.5 rounded-md bg-muted">
                  <Text class="text-muted-foreground text-xs font-mono">
                    {stream?.lastMotionText}
                  </Text>
                </View>
              </If>
            </View>

            <View class="flex-row items-end justify-between pt-4">
              <Text class="text-muted-foreground text-xs font-mono">
                {appliance.room} · {appliance.sourceLabel}
              </Text>
              <Text class="text-foreground text-xs font-medium">
                {t("deviceInspector")} ›
              </Text>
            </View>
          </Button>
        </If>

        <View class="flex-row flex-wrap items-center justify-between gap-1.5">
          <View class="flex-row flex-wrap items-center gap-1.5">
            <If when={appliance.capabilities.power?.controllable}>
              <Button
                testID={`camera-power-${appliance.id}`}
                onPress={() => {
                  const p = appliance.capabilities.power!;
                  sendCommand({
                    entity_id: p.entityId,
                    domain: p.domain,
                    service: p.isOn ? "turn_off" : "turn_on",
                  });
                }}
                class={
                  appliance.capabilities.power?.isOn
                    ? "min-h-9 px-3 rounded-lg bg-primary items-center justify-center active:opacity-75"
                    : "min-h-9 px-3 rounded-lg border border-border bg-muted items-center justify-center active:opacity-75"
                }
              >
                <Text
                  class={
                    appliance.capabilities.power?.isOn
                      ? "text-primary-foreground text-xs font-semibold"
                      : "text-foreground text-xs font-medium"
                  }
                >
                  {appliance.capabilities.power?.isOn ? "画面监控中" : "唤醒监控"}
                </Text>
              </Button>
            </If>
            <Each
              of={(appliance.capabilities.actions ?? []).slice(0, 2)}
              key={(act) => act.id}
            >
              {(act) => (
                <Button
                  testID={`action-${act().entityId}`}
                  onPress={() =>
                    sendCommand({
                      entity_id: act().entityId,
                      domain: act().domain,
                      service: act().service,
                      service_data: act().serviceData,
                    })
                  }
                  class="min-h-9 px-2.5 rounded-lg border border-border bg-muted items-center justify-center active:opacity-75"
                >
                  <Text class="text-foreground text-xs font-medium">
                    {act().label}
                  </Text>
                </Button>
              )}
            </Each>
          </View>

          <If when={isLarge && (stream?.ptzActions.length ?? 0) > 0}>
            <View class="flex-row items-center gap-1">
              <Each of={stream?.ptzActions ?? []} key={(ptz) => ptz.id}>
                {(ptz) => (
                  <Button
                    testID={`ptz-${ptz().entityId}`}
                    onPress={() =>
                      sendCommand({
                        entity_id: ptz().entityId,
                        domain: ptz().domain,
                        service: ptz().service,
                      })
                    }
                    class="min-h-8 px-2 rounded-lg border border-border bg-secondary items-center justify-center active:opacity-75"
                  >
                    <Text class="text-foreground text-xs font-medium">
                      {ptz().label}
                    </Text>
                  </Button>
                )}
              </Each>
            </View>
          </If>
        </View>
      </View>
    );
  };

  const renderCycleApplianceBody = (appliance: HomeAppliance) => {
    const cycle = appliance.capabilities.cycleTask;
    const isWide = appliance.span === "2x1" || appliance.span === "2x2";
    const actions = appliance.capabilities.actions ?? [];

    if (!isWide || !cycle) {
      return (
        <View class="flex-row items-center justify-between gap-2 mt-1.5">
          <Text class="text-muted-foreground text-xs font-mono">
            {cycle?.stageLabel ?? appliance.statusBadge}
          </Text>
          <If when={actions.length > 0}>
            <Button
              testID={`action-${actions[0].entityId}`}
              onPress={() =>
                sendCommand({
                  entity_id: actions[0].entityId,
                  domain: actions[0].domain,
                  service: actions[0].service,
                  service_data: actions[0].serviceData,
                })
              }
              class="min-h-9 px-3 rounded-lg bg-primary items-center justify-center active:opacity-75"
            >
              <Text class="text-primary-foreground text-xs font-semibold">
                {actions[0].label}
              </Text>
            </Button>
          </If>
        </View>
      );
    }

    return (
      <View class="flex-row items-center gap-3 mt-1.5">
        {/* Left Countdown Well */}
        <View class="rounded-xl border border-border bg-muted px-3 py-2 items-center justify-center min-w-20">
          <Text class="text-foreground text-base font-bold font-mono">
            {cycle.remainingMinutes !== undefined && cycle.remainingMinutes > 0
              ? `${cycle.remainingMinutes}m`
              : cycle.stageLabel}
          </Text>
          <Text class="text-muted-foreground text-xs font-mono">
            {cycle.temperatureCelsius !== undefined
              ? `${cycle.temperatureCelsius}°C`
              : cycle.subStatus ?? appliance.statusBadge}
          </Text>
        </View>

        {/* Right 5-Stage Pipeline + Action Triggers */}
        <View class="flex-1 min-w-0 gap-2">
          <View class="flex-row flex-wrap items-center gap-1">
            <Each of={cycle.stages} key={(stage, idx) => `${idx}_${stage}`}>
              {(stage, idx) => {
                const isCurrent = () => idx() === cycle.activeStageIndex;
                const isDone = () => idx() < cycle.activeStageIndex;
                return (
                  <View
                    class={
                      isCurrent()
                        ? "px-2 py-0.5 rounded-md bg-primary"
                        : isDone()
                          ? "px-2 py-0.5 rounded-md border border-verified bg-muted"
                          : "px-2 py-0.5 rounded-md bg-muted"
                    }
                  >
                    <Text
                      class={
                        isCurrent()
                          ? "text-primary-foreground text-xs font-semibold"
                          : isDone()
                            ? "text-verified text-xs font-medium"
                            : "text-muted-foreground text-xs"
                      }
                    >
                      {stage()}
                    </Text>
                  </View>
                );
              }}
            </Each>
          </View>

          <View class="flex-row flex-wrap items-center gap-1.5">
            <Each of={actions.slice(0, 3)} key={(act) => act.id}>
              {(act) => (
                <Button
                  testID={`action-${act().entityId}`}
                  onPress={() =>
                    sendCommand({
                      entity_id: act().entityId,
                      domain: act().domain,
                      service: act().service,
                      service_data: act().serviceData,
                    })
                  }
                  class={
                    act().tone === "primary"
                      ? "min-h-8 px-3 rounded-lg bg-primary items-center justify-center active:opacity-75"
                      : act().tone === "destructive"
                        ? "min-h-8 px-2.5 rounded-lg border border-destructive bg-muted items-center justify-center active:opacity-75"
                        : "min-h-8 px-2.5 rounded-lg border border-border bg-muted items-center justify-center active:opacity-75"
                  }
                >
                  <Text
                    class={
                      act().tone === "primary"
                        ? "text-primary-foreground text-xs font-semibold"
                        : act().tone === "destructive"
                          ? "text-destructive text-xs font-medium"
                          : "text-foreground text-xs font-medium"
                    }
                  >
                    {act().label}
                  </Text>
                </Button>
              )}
            </Each>
          </View>
        </View>
      </View>
    );
  };

  const renderClimateBody = (appliance: HomeAppliance) => {
    const thermo = appliance.capabilities.thermostat;
    const modeBar = appliance.capabilities.modeBar;
    const isWide = appliance.span === "2x1" || appliance.span === "2x2";

    if (!thermo) {
      return null;
    }

    const adjustTemp = (delta: number) => {
      const next = Math.max(
        thermo.minTemp,
        Math.min(
          thermo.maxTemp,
          Math.round((thermo.targetTemp + delta) * 10) / 10,
        ),
      );
      sendCommand({
        entity_id: thermo.entityId,
        domain: thermo.domain,
        service: thermo.domain === "climate" ? "set_temperature" : "set_value",
        service_data:
          thermo.domain === "climate" ? { temperature: next } : { value: next },
      });
    };

    return (
      <View class="flex-row flex-wrap items-center justify-between gap-2 mt-1.5">
        <View class="flex-row items-center gap-2 rounded-xl border border-border bg-muted px-2 py-1">
          <Button
            testID={`climate-dec-${appliance.id}`}
            disabled={!thermo.controllable}
            onPress={() => adjustTemp(-thermo.step)}
            class="w-8 h-8 rounded-lg bg-card border border-border items-center justify-center active:opacity-75 disabled:opacity-40"
          >
            <Text class="text-foreground text-sm font-bold">-</Text>
          </Button>
          <Text class="text-foreground text-sm font-bold font-mono px-1">
            {thermo.targetTemp}
            {thermo.unit}
          </Text>
          <Button
            testID={`climate-inc-${appliance.id}`}
            disabled={!thermo.controllable}
            onPress={() => adjustTemp(thermo.step)}
            class="w-8 h-8 rounded-lg bg-card border border-border items-center justify-center active:opacity-75 disabled:opacity-40"
          >
            <Text class="text-foreground text-sm font-bold">+</Text>
          </Button>
        </View>

        <If when={isWide && modeBar && modeBar.options.length > 0}>
          <View class="flex-row flex-wrap items-center gap-1">
            <Each
              of={(modeBar?.options ?? []).slice(0, 4)}
              key={(opt) => opt.value}
            >
              {(opt) => {
                const selected = () => modeBar?.currentMode === opt().value;
                return (
                  <Button
                    testID={`mode-${appliance.id}-${opt().value}`}
                    onPress={() => {
                      if (!modeBar) return;
                      sendCommand({
                        entity_id: modeBar.entityId,
                        domain: modeBar.domain,
                        service: modeBar.service,
                        service_data: {
                          [modeBar.parameterKey]: opt().value,
                        },
                      });
                    }}
                    class={
                      selected()
                        ? "min-h-8 px-2.5 rounded-lg bg-primary items-center justify-center active:opacity-75"
                        : "min-h-8 px-2.5 rounded-lg border border-border bg-muted items-center justify-center active:opacity-75"
                    }
                  >
                    <Text
                      class={
                        selected()
                          ? "text-primary-foreground text-xs font-semibold"
                          : "text-muted-foreground text-xs font-medium"
                      }
                    >
                      {opt().label}
                    </Text>
                  </Button>
                );
              }}
            </Each>
          </View>
        </If>
      </View>
    );
  };

  const renderMultiGangBody = (appliance: HomeAppliance) => {
    const channels = appliance.capabilities.multiGang?.channels ?? [];
    return (
      <View class="flex-row items-center gap-1.5 mt-1.5">
        <Each of={channels} key={(ch) => ch.id}>
          {(ch) => (
            <Button
              testID={`gang-${ch().entityId}`}
              disabled={!ch().controllable}
              onPress={() =>
                sendCommand({
                  entity_id: ch().entityId,
                  domain: ch().domain,
                  service: ch().isOn ? "turn_off" : "turn_on",
                })
              }
              class={
                ch().isOn
                  ? "flex-1 min-h-10 rounded-xl bg-primary px-2 flex-row items-center justify-center gap-1.5 active:opacity-75"
                  : "flex-1 min-h-10 rounded-xl border border-border bg-muted px-2 flex-row items-center justify-center gap-1.5 active:opacity-75"
              }
            >
              <View
                class={
                  ch().isOn
                    ? "w-1.5 h-1.5 rounded-full bg-verified"
                    : "w-1.5 h-1.5 rounded-full bg-border"
                }
              />
              <Text
                class={
                  ch().isOn
                    ? "text-primary-foreground text-xs font-semibold"
                    : "text-muted-foreground text-xs font-medium"
                }
                style={{ numberOfLines: 1 }}
              >
                {ch().label}
              </Text>
            </Button>
          )}
        </Each>
      </View>
    );
  };

  const renderCompactBody = (appliance: HomeAppliance) => {
    const actions = appliance.capabilities.actions ?? [];
    const sec = appliance.capabilities.securityEvents;
    const dimmer = appliance.capabilities.dimmer;

    if (sec) {
      const latest = sec.events[0];
      return (
        <View class="flex-row items-center justify-between gap-2 mt-1.5">
          <Text
            class="text-muted-foreground text-xs font-mono flex-1"
            style={{ numberOfLines: 1 }}
          >
            {latest ? `${latest.time} ${latest.label}` : "安全只读保护"}
          </Text>
          <If when={sec.batteryPercent !== undefined}>
            <Text class="text-muted-foreground text-xs font-mono">
              电量 {sec.batteryPercent}%
            </Text>
          </If>
        </View>
      );
    }

    if (actions.length > 0) {
      const primary = actions[0];
      return (
        <View class="flex-row items-center justify-between gap-2 mt-1.5">
          <Text
            class="text-muted-foreground text-xs font-mono flex-1"
            style={{ numberOfLines: 1 }}
          >
            {appliance.capabilities.modeBar?.currentLabel ?? appliance.room}
          </Text>
          <Button
            testID={`action-${primary.entityId}`}
            onPress={() =>
              sendCommand({
                entity_id: primary.entityId,
                domain: primary.domain,
                service: primary.service,
                service_data: primary.serviceData,
              })
            }
            class="min-h-8 px-3 rounded-lg bg-primary items-center justify-center active:opacity-75"
          >
            <Text class="text-primary-foreground text-xs font-semibold">
              {primary.label}
            </Text>
          </Button>
        </View>
      );
    }

    if (dimmer && dimmer.brightnessPercent !== undefined) {
      return (
        <View class="flex-row items-center justify-between gap-2 mt-1.5">
          <View class="flex-1 h-2 rounded-full bg-muted overflow-hidden flex-row">
            <View
              class="h-2 rounded-full bg-primary"
              style={{ width: `${Math.max(8, dimmer.brightnessPercent)}%` }}
            />
          </View>
          <Text class="text-muted-foreground text-xs font-mono">
            {dimmer.brightnessPercent}%
          </Text>
        </View>
      );
    }

    const topTelemetry = appliance.capabilities.telemetry.slice(0, 2);
    if (topTelemetry.length > 0) {
      return (
        <View class="flex-row flex-wrap items-center gap-1.5 mt-1.5">
          <Each of={topTelemetry} key={(m) => m.key}>
            {(m) => (
              <View class="px-2 py-0.5 rounded-md bg-muted">
                <Text class="text-muted-foreground text-xs font-mono">
                  {m().label} {m().value}
                </Text>
              </View>
            )}
          </Each>
        </View>
      );
    }

    return null;
  };

  const renderApplianceTile = (
    room: HomeRoomSection,
    appliance: HomeAppliance,
  ) => (
    <View
      testID={`appliance-tile-${appliance.id}`}
      class="rounded-2xl border border-border bg-card p-3.5 justify-between gap-2"
    >
      <View class="gap-1">
        <If when={layoutEditing()}>
          {renderLayoutToolbar(room, appliance)}
        </If>
        {renderApplianceHeader(appliance)}
      </View>

      <If
        when={
          appliance.archetype === "vision_security" &&
          appliance.icon === "camera"
        }
        else={
          <If
            when={Boolean(appliance.capabilities.multiGang)}
            else={
              <If
                when={appliance.archetype === "cycle_appliance"}
                else={
                  <If
                    when={Boolean(appliance.capabilities.thermostat)}
                    else={renderCompactBody(appliance)}
                  >
                    {renderClimateBody(appliance)}
                  </If>
                }
              >
                {renderCycleApplianceBody(appliance)}
              </If>
            }
          >
            {renderMultiGangBody(appliance)}
          </If>
        }
      >
        {renderVisionCameraBody(appliance)}
      </If>
    </View>
  );

  const renderRoomSection = (room: HomeRoomSection, columns: number) => {
    const rows = () => packBentoRows(room.appliances, columns);
    const hasPowerControls = () =>
      room.roomPowerEntities.turnOnIds.length > 0 ||
      room.roomPowerEntities.turnOffIds.length > 0;

    return (
      <View class="gap-2.5">
        {/* Room Header */}
        <View class="flex-row flex-wrap items-center justify-between gap-2 px-0.5">
          <View class="flex-row flex-wrap items-center gap-2">
            <Text role="header" class="text-foreground text-sm font-bold">
              {room.name}
            </Text>
            <Each of={room.environment.slice(0, 4)} key={(env) => env.key}>
              {(env) => (
                <View class="px-2 py-0.5 rounded-full border border-border bg-muted">
                  <Text class="text-muted-foreground text-xs font-mono">
                    {env().label} {env().value}
                  </Text>
                </View>
              )}
            </Each>
          </View>

          <If when={hasPowerControls()}>
            <View class="flex-row items-center gap-1.5">
              <Button
                testID={`room-all-on-${room.name}`}
                onPress={() =>
                  void props.store.controlRoomPower?.(room.name, true)
                }
                class="min-h-8 px-2.5 rounded-full border border-border bg-card items-center justify-center active:opacity-75"
              >
                <Text class="text-foreground text-xs font-medium">
                  {t("allOn")}
                </Text>
              </Button>
              <Button
                testID={`room-all-off-${room.name}`}
                onPress={() =>
                  void props.store.controlRoomPower?.(room.name, false)
                }
                class="min-h-8 px-2.5 rounded-full border border-border bg-card items-center justify-center active:opacity-75"
              >
                <Text class="text-muted-foreground text-xs font-medium">
                  {t("allOff")}
                </Text>
              </Button>
            </View>
          </If>
        </View>

        {/* Multi-Size Bento Rows */}
        <View class="gap-2.5">
          <Each of={rows()} key={(r) => r.id}>
            {(row) => (
              <View class="flex-row gap-2.5">
                <Each of={row().items} key={(item) => item.key}>
                  {(item) => (
                    <View
                      style={{
                        flex: item().weight,
                        minWidth: 0,
                      }}
                    >
                      <If when={item().appliance}>
                        {renderApplianceTile(room, item().appliance!)}
                      </If>
                    </View>
                  )}
                </Each>
              </View>
            )}
          </Each>
        </View>
      </View>
    );
  };

  const renderInspectorPanel = () => {
    const app = inspectedAppliance();
    const brightnessLevels = [10, 25, 50, 75, 100];
    const colorTempLevels = [
      { kelvin: 2700, label: "2700K 暖光" },
      { kelvin: 4000, label: "4000K 自然" },
      { kelvin: 5700, label: "5700K 冷白" },
    ];

    return (
      <Panel
        open={Boolean(app)}
        title={app ? `${app.room} · ${app.name}` : t("deviceInspector")}
        height={520}
        wide={true}
        onClose={() => props.store.setHomeInspectedApplianceId?.(null)}
      >
        <If when={app}>
          {(item) => {
            const current = () => inspectedAppliance() ?? item();
            const auxList = () => [
              ...(current().capabilities.auxiliaryToggles ?? []),
              ...(current().capabilities.visionStream?.featureToggles ?? []),
            ];
            return (
              <View class="gap-4 pb-4">
                {/* Summary Bar */}
                <View class="flex-row flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-muted p-3">
                  <View class="gap-0.5">
                    <Text class="text-foreground text-sm font-semibold">
                      {current().name} · {current().statusBadge}
                    </Text>
                    <Text class="text-muted-foreground text-xs font-mono">
                      {current().sourceLabel}
                      {current().model ? ` · ${current().model}` : ""}
                    </Text>
                  </View>

                  <View class="flex-row items-center gap-1.5">
                    <Each
                      of={["1x1", "2x1", "2x2"] as TileSpan[]}
                      key={(sp) => sp}
                    >
                      {(sp) => (
                        <Button
                          testID={`inspector-span-${sp()}`}
                          onPress={() =>
                            void props.store.setHomeApplianceLayout?.(
                              current().id,
                              { span: sp() },
                            )
                          }
                          class={
                            current().span === sp()
                              ? "min-h-8 px-2.5 rounded-lg bg-primary items-center justify-center active:opacity-75"
                              : "min-h-8 px-2.5 rounded-lg border border-border bg-card items-center justify-center active:opacity-75"
                          }
                        >
                          <Text
                            class={
                              current().span === sp()
                                ? "text-primary-foreground text-xs font-semibold"
                                : "text-muted-foreground text-xs"
                            }
                          >
                            {sp() === "1x1"
                              ? t("spanSmall")
                              : sp() === "2x1"
                                ? t("spanWide")
                                : t("spanLarge")}
                          </Text>
                        </Button>
                      )}
                    </Each>
                  </View>
                </View>

                {/* Primary Controls */}
                <If when={current().capabilities.power?.controllable}>
                  <View class="flex-row items-center justify-between rounded-xl border border-border bg-card p-3">
                    <Text class="text-foreground text-sm font-medium">
                      {t("primaryControls")}
                    </Text>
                    <ActionButton
                      label={
                        current().capabilities.power?.isOn
                          ? t("powerOff")
                          : t("powerOn")
                      }
                      testID="inspector-power-btn"
                      kind={
                        current().capabilities.power?.isOn
                          ? undefined
                          : "primary"
                      }
                      compact={true}
                      onPress={() => {
                        const p = current().capabilities.power!;
                        sendCommand({
                          entity_id: p.entityId,
                          domain: p.domain,
                          service: p.isOn ? "turn_off" : "turn_on",
                        });
                      }}
                    />
                  </View>
                </If>

                {/* Cycle Pipeline */}
                <If when={current().capabilities.cycleTask}>
                  <View class="rounded-xl border border-border bg-card p-3 gap-2.5">
                    <Text class="text-foreground text-xs font-semibold">
                      阶段进度 · {current().capabilities.cycleTask?.stageLabel}
                    </Text>
                    <View class="flex-row flex-wrap items-center gap-1.5">
                      <Each
                        of={current().capabilities.cycleTask?.stages ?? []}
                        key={(st, i) => `${i}_${st}`}
                      >
                        {(st, i) => (
                          <View
                            class={
                              i() ===
                              current().capabilities.cycleTask?.activeStageIndex
                                ? "px-2.5 py-1 rounded-lg bg-primary"
                                : "px-2.5 py-1 rounded-lg border border-border bg-muted"
                            }
                          >
                            <Text
                              class={
                                i() ===
                                current().capabilities.cycleTask
                                  ?.activeStageIndex
                                  ? "text-primary-foreground text-xs font-semibold"
                                  : "text-muted-foreground text-xs"
                              }
                            >
                              {st()}
                            </Text>
                          </View>
                        )}
                      </Each>
                    </View>
                  </View>
                </If>

                {/* Dimmer & Color Temp */}
                <If when={current().capabilities.dimmer?.controllable}>
                  <View class="rounded-xl border border-border bg-card p-3 gap-2.5">
                    <Text class="text-foreground text-xs font-semibold">
                      {t("brightness")}
                    </Text>
                    <View class="flex-row flex-wrap items-center gap-1.5">
                      <Each of={brightnessLevels} key={(lvl) => String(lvl)}>
                        {(lvl) => (
                          <Button
                            testID={`inspector-brightness-${lvl()}`}
                            onPress={() => {
                              const d = current().capabilities.dimmer!;
                              sendCommand({
                                entity_id: d.entityId,
                                domain: "light",
                                service: "turn_on",
                                service_data: {
                                  brightness: Math.max(
                                    1,
                                    Math.min(
                                      255,
                                      Math.round((lvl() / 100) * 255),
                                    ),
                                  ),
                                },
                              });
                            }}
                            class={
                              current().capabilities.dimmer
                                ?.brightnessPercent === lvl()
                                ? "min-h-9 px-3 rounded-lg bg-primary items-center justify-center active:opacity-75"
                                : "min-h-9 px-3 rounded-lg border border-border bg-muted items-center justify-center active:opacity-75"
                            }
                          >
                            <Text
                              class={
                                current().capabilities.dimmer
                                  ?.brightnessPercent === lvl()
                                  ? "text-primary-foreground text-xs font-semibold"
                                  : "text-foreground text-xs font-medium"
                              }
                            >
                              {lvl()}%
                            </Text>
                          </Button>
                        )}
                      </Each>
                    </View>

                    <If
                      when={
                        current().capabilities.dimmer?.colorTempKelvin !==
                        undefined
                      }
                    >
                      <Text class="text-foreground text-xs font-semibold pt-1">
                        {t("colorTemperature")}
                      </Text>
                      <View class="flex-row flex-wrap items-center gap-1.5">
                        <Each
                          of={colorTempLevels}
                          key={(ct) => String(ct.kelvin)}
                        >
                          {(ct) => (
                            <Button
                              testID={`inspector-ct-${ct().kelvin}`}
                              onPress={() => {
                                const d = current().capabilities.dimmer!;
                                sendCommand({
                                  entity_id: d.entityId,
                                  domain: "light",
                                  service: "turn_on",
                                  service_data: {
                                    color_temp_kelvin: ct().kelvin,
                                  },
                                });
                              }}
                              class="min-h-9 px-3 rounded-lg border border-border bg-muted items-center justify-center active:opacity-75"
                            >
                              <Text class="text-foreground text-xs font-medium">
                                {ct().label}
                              </Text>
                            </Button>
                          )}
                        </Each>
                      </View>
                    </If>
                  </View>
                </If>

                {/* Mode Selection */}
                <If
                  when={
                    (current().capabilities.modeBar?.options.length ?? 0) > 0
                  }
                >
                  <View class="rounded-xl border border-border bg-card p-3 gap-2.5">
                    <Text class="text-foreground text-xs font-semibold">
                      {t("modeSelection")} ·{" "}
                      {current().capabilities.modeBar?.currentLabel}
                    </Text>
                    <View class="flex-row flex-wrap items-center gap-1.5">
                      <Each
                        of={current().capabilities.modeBar?.options ?? []}
                        key={(opt) => opt.value}
                      >
                        {(opt) => {
                          const selected = () =>
                            current().capabilities.modeBar?.currentMode ===
                            opt().value;
                          return (
                            <Button
                              testID={`inspector-mode-${opt().value}`}
                              onPress={() => {
                                const mb = current().capabilities.modeBar!;
                                sendCommand({
                                  entity_id: mb.entityId,
                                  domain: mb.domain,
                                  service: mb.service,
                                  service_data: {
                                    [mb.parameterKey]: opt().value,
                                  },
                                });
                              }}
                              class={
                                selected()
                                  ? "min-h-9 px-3 rounded-lg bg-primary items-center justify-center active:opacity-75"
                                  : "min-h-9 px-3 rounded-lg border border-border bg-muted items-center justify-center active:opacity-75"
                              }
                            >
                              <Text
                                class={
                                  selected()
                                    ? "text-primary-foreground text-xs font-semibold"
                                    : "text-foreground text-xs font-medium"
                                }
                              >
                                {opt().label}
                              </Text>
                            </Button>
                          );
                        }}
                      </Each>
                    </View>
                  </View>
                </If>

                {/* Auxiliary Feature Toggles */}
                <If when={auxList().length > 0}>
                  <View class="rounded-xl border border-border bg-card p-3 gap-2.5">
                    <Text class="text-foreground text-xs font-semibold">
                      {t("auxiliaryFeatures")}
                    </Text>
                    <View class="flex-row flex-wrap items-center gap-1.5">
                      <Each of={auxList()} key={(aux) => aux.id}>
                        {(aux) => (
                          <Button
                            testID={`inspector-aux-${aux().entityId}`}
                            onPress={() =>
                              sendCommand({
                                entity_id: aux().entityId,
                                domain: aux().domain,
                                service: aux().isOn ? "turn_off" : "turn_on",
                              })
                            }
                            class={
                              aux().isOn
                                ? "min-h-9 px-3 rounded-lg bg-primary items-center justify-center active:opacity-75"
                                : "min-h-9 px-3 rounded-lg border border-border bg-muted items-center justify-center active:opacity-75"
                            }
                          >
                            <Text
                              class={
                                aux().isOn
                                  ? "text-primary-foreground text-xs font-semibold"
                                  : "text-muted-foreground text-xs font-medium"
                              }
                            >
                              {aux().label} ·{" "}
                              {aux().isOn ? t("powerOn") : t("powerOff")}
                            </Text>
                          </Button>
                        )}
                      </Each>
                    </View>
                  </View>
                </If>

                {/* Security Events Timeline */}
                <If when={current().capabilities.securityEvents}>
                  <View class="rounded-xl border border-border bg-card p-3 gap-2">
                    <Text class="text-foreground text-xs font-semibold">
                      {t("securityEventsTimeline")}
                    </Text>
                    <Text class="text-muted-foreground text-xs">
                      {t("readOnlySecurityNotice")}
                    </Text>
                    <Each
                      of={current().capabilities.securityEvents?.events ?? []}
                      key={(ev, idx) => `${idx}_${ev.time}`}
                    >
                      {(ev) => (
                        <View class="flex-row items-center justify-between border-t border-border pt-1.5">
                          <Text class="text-foreground text-xs">
                            {ev().label}
                          </Text>
                          <Text class="text-muted-foreground text-xs font-mono">
                            {ev().time}
                          </Text>
                        </View>
                      )}
                    </Each>
                  </View>
                </If>

                {/* Telemetry Metrics */}
                <If when={current().capabilities.telemetry.length > 0}>
                  <View class="rounded-xl border border-border bg-card p-3 gap-2">
                    <Text class="text-foreground text-xs font-semibold">
                      {t("telemetryMetrics")}
                    </Text>
                    <View class="flex-row flex-wrap gap-2">
                      <Each
                        of={current().capabilities.telemetry}
                        key={(metric) => metric.key}
                      >
                        {(metric) => (
                          <View class="rounded-lg border border-border bg-muted px-2.5 py-1.5 min-w-24">
                            <Text class="text-muted-foreground text-xs">
                              {metric().label}
                            </Text>
                            <Text class="text-foreground text-xs font-bold font-mono">
                              {metric().value}
                            </Text>
                          </View>
                        )}
                      </Each>
                    </View>
                  </View>
                </If>
              </View>
            );
          }}
        </If>
      </Panel>
    );
  };

  const renderDevicesSubView = () => {
    const isWide = () => windowSize().width >= 600;
    const gridCols = () => (windowSize().width >= 980 ? 3 : 2);
    const visibleRooms = () => {
      const sel = selectedRoom();
      if (sel === "all") return dashboard().rooms;
      return dashboard().rooms.filter((r) => r.name === sel);
    };

    return (
      <If
        when={dashboard().totalAppliances > 0}
        else={
          <View class="flex-1 items-center justify-center py-6">
            <View class="w-full max-w-lg rounded-2xl border border-border bg-card p-6 gap-4">
              <View class="gap-1.5">
                <Text class="text-foreground text-base font-bold">
                  {t("noHomeSourceEnabledTitle")}
                </Text>
                <Text class="text-muted-foreground text-xs">
                  {t("noHomeSourceEnabledDesc")}
                </Text>
              </View>
              <View class="flex-row flex-wrap items-center gap-2.5 pt-1">
                <ActionButton
                  label={t("enableFullHouseDemo")}
                  testID="home-empty-enable-sim"
                  kind="primary"
                  compact={true}
                  disabled={working()}
                  onPress={configureSimulation}
                />
                <ActionButton
                  label={t("openServiceBinding")}
                  testID="home-empty-open-services"
                  compact={true}
                  onPress={() => props.store.setHomeSubView?.("services")}
                />
              </View>
            </View>
          </View>
        }
      >
        <If
          when={isWide()}
          else={
            <View class="flex-1 min-h-0 gap-3">
              {/* Compact Horizontal Room Bar on Portrait */}
              <Scroll
                horizontal={true}
                scrollbar={false}
                class="h-11"
                contentClass="flex-row items-center gap-1.5 h-11"
              >
                <Button
                  testID="home-room-all"
                  selected={selectedRoom() === "all"}
                  onPress={() => props.store.setHomeSelectedRoom?.("all")}
                  class={
                    selectedRoom() === "all"
                      ? "min-h-10 px-3 rounded-full bg-primary items-center justify-center"
                      : "min-h-10 px-3 rounded-full border border-border bg-card items-center justify-center"
                  }
                >
                  <Text
                    class={
                      selectedRoom() === "all"
                        ? "text-primary-foreground text-xs font-semibold"
                        : "text-foreground text-xs font-medium"
                    }
                  >
                    {t("allRoomsOverview")} · {dashboard().activeAppliances}/
                    {dashboard().totalAppliances}
                  </Text>
                </Button>
                <Each of={dashboard().rooms} key={(r) => r.id}>
                  {(room) => (
                    <Button
                      testID={`home-room-${room().name}`}
                      selected={selectedRoom() === room().name}
                      onPress={() =>
                        props.store.setHomeSelectedRoom?.(room().name)
                      }
                      class={
                        selectedRoom() === room().name
                          ? "min-h-10 px-3 rounded-full bg-primary items-center justify-center"
                          : "min-h-10 px-3 rounded-full border border-border bg-card items-center justify-center"
                      }
                    >
                      <Text
                        class={
                          selectedRoom() === room().name
                            ? "text-primary-foreground text-xs font-semibold"
                            : "text-foreground text-xs font-medium"
                        }
                      >
                        {room().name} · {room().activeCount}/{room().totalCount}
                      </Text>
                    </Button>
                  )}
                </Each>
              </Scroll>

              <Scroll class="flex-1" contentClass="gap-4 pb-6">
                <Each of={visibleRooms()} key={(r) => r.id}>
                  {(room) => renderRoomSection(room(), 1)}
                </Each>
              </Scroll>
            </View>
          }
        >
          {/* 16:9 Landscape Dual-Column Room + Bento Grid */}
          <View class="flex-1 flex-row gap-3.5 min-h-0">
            {/* Left Room Navigation Column (Low Text Density: max 2 lines per room card) */}
            <View class="w-48 min-h-0">
              <Scroll class="flex-1" contentClass="gap-2 pb-4">
                <View class="px-1 pb-0.5 flex-row items-center justify-between">
                  <Text class="text-muted-foreground text-xs font-semibold">
                    {t("roomsAndAreas")}
                  </Text>
                  <Text class="text-muted-foreground text-xs font-mono">
                    {dashboard().homeName}
                  </Text>
                </View>

                <Button
                  testID="home-room-all"
                  selected={selectedRoom() === "all"}
                  onPress={() => props.store.setHomeSelectedRoom?.("all")}
                  class={
                    selectedRoom() === "all"
                      ? "w-full rounded-xl border border-ring bg-card p-3 gap-0.5 active:opacity-75"
                      : "w-full rounded-xl border border-border bg-card p-3 gap-0.5 active:opacity-75"
                  }
                >
                  <View class="flex-row items-center justify-between">
                    <Text class="text-foreground text-xs font-bold">
                      {t("allRoomsOverview")}
                    </Text>
                    <View class="px-1.5 py-0.5 rounded-full bg-muted">
                      <Text class="text-foreground text-xs font-mono font-semibold">
                        {dashboard().totalAppliances}
                      </Text>
                    </View>
                  </View>
                  <Text
                    class="text-muted-foreground text-xs font-mono"
                    style={{ numberOfLines: 1 }}
                  >
                    {t("activeCountSummary", {
                      active: dashboard().activeAppliances,
                      total: dashboard().totalAppliances,
                    })}
                  </Text>
                </Button>

                <Each of={dashboard().rooms} key={(r) => r.id}>
                  {(room) => {
                    const isSelected = () => selectedRoom() === room().name;
                    return (
                      <Button
                        testID={`home-room-${room().name}`}
                        selected={isSelected()}
                        onPress={() =>
                          props.store.setHomeSelectedRoom?.(room().name)
                        }
                        class={
                          isSelected()
                            ? "w-full rounded-xl border border-ring bg-card p-3 gap-0.5 active:opacity-75"
                            : "w-full rounded-xl border border-border bg-card p-3 gap-0.5 active:opacity-75"
                        }
                      >
                        <View class="flex-row items-center justify-between">
                          <Text class="text-foreground text-xs font-bold">
                            {room().name}
                          </Text>
                          <View
                            class={
                              room().activeCount > 0
                                ? "px-1.5 py-0.5 rounded-full bg-secondary"
                                : "px-1.5 py-0.5 rounded-full bg-muted"
                            }
                          >
                            <Text
                              class={
                                room().activeCount > 0
                                  ? "text-verified text-xs font-mono font-semibold"
                                  : "text-muted-foreground text-xs font-mono"
                              }
                            >
                              {room().activeCount}
                            </Text>
                          </View>
                        </View>
                        <Text
                          class="text-muted-foreground text-xs font-mono"
                          style={{ numberOfLines: 1 }}
                        >
                          {room().navSummary}
                        </Text>
                      </Button>
                    );
                  }}
                </Each>
              </Scroll>
            </View>

            {/* Right Multi-Size Bento Grid Column */}
            <View class="flex-1 min-w-0 min-h-0">
              <Scroll class="flex-1" contentClass="gap-4 pb-6">
                <Each of={visibleRooms()} key={(r) => r.id}>
                  {(room) => renderRoomSection(room(), gridCols())}
                </Each>
              </Scroll>
            </View>
          </View>
        </If>
      </If>
    );
  };

  const renderServicesLeftCard = () => {
    const serviceTabs: Array<{ id: HomeModeTab; label: string }> = [
      { id: "direct_miot", label: t("xiaomiHome92") },
      { id: "external_ha", label: "Home Assistant" },
      { id: "simulation", label: t("offlineDemo") },
    ];

    return (
      <View class="gap-3.5">
        {/* Service Type Selector Tabs */}
        <View class="flex-row flex-wrap items-center gap-1.5">
          <Each of={serviceTabs} key={(tab) => tab.id}>
            {(tab) => {
              const active = () => localServiceTab() === tab().id;
              return (
                <Button
                  testID={`home-service-tab-${tab().id}`}
                  selected={active()}
                  onPress={() => localServiceTab.set(tab().id)}
                  class={
                    active()
                      ? "min-h-10 px-3 rounded-full bg-primary border border-transparent items-center justify-center active:opacity-75"
                      : "min-h-10 px-3 rounded-full border border-border bg-card items-center justify-center active:opacity-75"
                  }
                >
                  <Text
                    class={
                      active()
                        ? "text-primary-foreground text-xs font-semibold"
                        : "text-muted-foreground text-xs font-medium"
                    }
                  >
                    {tab().label}
                  </Text>
                </Button>
              );
            }}
          </Each>
        </View>

        <If when={localServiceTab() === "direct_miot"}>
          <View class="rounded-2xl border border-border bg-card p-4 gap-3.5">
            <View class="gap-1.5 border-b border-border pb-2.5">
              <View class="gap-0.5">
                <Text class="text-foreground text-sm font-semibold">
                  {t("connectYourXiaomiHomeAccount")}
                </Text>
                <Text class="text-muted-foreground text-xs font-mono">
                  {t("cloudSyncOutletsLightsAndTemperaturehumiditySensors")}
                </Text>
              </View>
              <If when={props.store.homeConfiguration().hasMiotAccount}>
                <View class="flex-row items-center gap-1.5 px-2 py-0.5 rounded-full bg-muted">
                  <View class="w-1.5 h-1.5 rounded-full bg-verified" />
                  <Text class="text-verified text-xs font-medium">
                    {t("signedIn")}
                  </Text>
                </View>
              </If>
            </View>

            <Text class="text-muted-foreground text-xs">
              {t("chooseYourXiaomiHomeRegionAfterSigning")}
            </Text>

            <SelectField
              label={t("xiaomiHomeRegion")}
              testID="home-miot-region"
              items={regions()}
              value={region()}
              disabled={working() || props.store.busy()}
              onChange={(next) => region.set(next)}
            />

            <View class="flex-row flex-wrap gap-2 pt-1">
              <ActionButton
                label={
                  props.store.homeLoggingIn()
                    ? t("waitingForXiaomiAuthorization")
                    : savedMiotSelected()
                      ? t("signInToXiaomiHomeAgain")
                      : t("signInToXiaomiHome")
                }
                testID="home-miot-login"
                kind="primary"
                compact={true}
                disabled={working() || props.store.busy()}
                onPress={() => void loginMiot()}
              />
              <If when={props.store.homeLoggingIn()}>
                <ActionButton
                  label={t("cancelXiaomiSignin")}
                  testID="home-miot-cancel"
                  compact={true}
                  onPress={() => props.store.cancelHomeLogin()}
                />
              </If>
              <If when={savedMiotSelected()}>
                <ActionButton
                  label={
                    props.store.homeConfiguration().mode === "direct_miot"
                      ? t("refreshXiaomiDevices")
                      : t("connectSavedXiaomiAccount")
                  }
                  testID="home-miot-refresh"
                  compact={true}
                  disabled={working() || props.store.busy()}
                  onPress={() => void refreshMiot()}
                />
              </If>
              <If
                when={
                  props.store.homeConfiguration().mode === "direct_miot" &&
                  savedMiotSelected()
                }
              >
                <ActionButton
                  label={t("signOutOfXiaomiHome")}
                  testID="home-miot-logout"
                  kind="danger"
                  compact={true}
                  disabled={working() || props.store.busy()}
                  onPress={() => void loginMiot(true)}
                />
              </If>
            </View>
          </View>
        </If>

        <If when={localServiceTab() === "external_ha"}>
          <View class="rounded-2xl border border-border bg-card p-4 gap-3.5">
            <View class="border-b border-border pb-2.5">
              <Text class="text-foreground text-sm font-semibold">
                {t("connectAHomeAssistantInstance")}
              </Text>
              <Text class="text-muted-foreground text-xs font-mono">
                {t("directLocalOrRemoteWebsocketApiConnection")}
              </Text>
            </View>

            <TextField
              label={t("homeAssistantServerUrl")}
              testID="home-url"
              value={haUrl()}
              onChange={(v) => haUrl.set(v)}
              placeholder="https://homeassistant.local:8123"
            />

            <TextField
              label={t("longlivedAccessToken76")}
              testID="home-token"
              value={haToken()}
              onChange={(v) => haToken.set(v)}
              masked={true}
              placeholder={
                props.store.homeConfiguration().hasToken
                  ? t("savedSecurelyLeaveBlankToReuseWith")
                  : t("enterAccessToken")
              }
              onSubmit={configureHa}
            />

            <View class="flex-row justify-end pt-1">
              <ActionButton
                label={
                  working() ? t("connecting48") : t("connectHomeAssistant")
                }
                testID="home-connect"
                kind="primary"
                compact={true}
                disabled={working() || !haUrl().trim()}
                onPress={configureHa}
              />
            </View>
          </View>
        </If>

        <If when={localServiceTab() === "simulation"}>
          <View class="rounded-2xl border border-border bg-card p-4 gap-3.5">
            <View class="border-b border-border pb-2.5">
              <Text class="text-foreground text-sm font-semibold">
                {t("offlineDemoEnvironment")}
              </Text>
              <Text class="text-muted-foreground text-xs font-mono">
                {t("virtualDevicesStoredInLocalMemory")}
              </Text>
            </View>

            <Text class="text-muted-foreground text-xs">
              {t("tryAStudyCeilingLightDeskLamp")}
            </Text>

            <View class="flex-row justify-end pt-1">
              <ActionButton
                label={t("enableDemoDevices")}
                testID="home-simulation"
                kind="primary"
                compact={true}
                disabled={working()}
                onPress={configureSimulation}
              />
            </View>
          </View>
        </If>

        <View class="rounded-xl border border-border bg-muted p-3">
          <Text class="text-muted-foreground text-xs">
            {t("multiSourceConcurrentHint")}
          </Text>
        </View>

        <If
          when={translateMessage(
            error() || props.store.homeConnection()?.error || "",
          )}
        >
          <View class="rounded-xl border border-destructive bg-muted p-3">
            <Text role="alert" class="text-destructive text-xs font-medium">
              {translateMessage(
                error() || props.store.homeConnection()?.error || "",
              )}
            </Text>
          </View>
        </If>
      </View>
    );
  };

  const renderServicesRightCard = () => {
    const sourceItems = (): Array<{
      id: HomeSourceId;
      title: string;
      enabled: boolean;
      healthy: boolean;
      count: number;
    }> => {
      const cfg = props.store.homeConfiguration();
      const conn = props.store.homeConnection();
      const sources = conn?.sources;
      const enabledMap = cfg.enabledSources ?? {
        direct_miot: cfg.mode === "direct_miot",
        external_ha: cfg.mode === "external_ha",
        simulation: cfg.mode === "simulation",
      };
      return [
        {
          id: "direct_miot",
          title: t("xiaomiHome92"),
          enabled: Boolean(enabledMap.direct_miot),
          healthy: Boolean(sources?.direct_miot?.healthy),
          count: sources?.direct_miot?.entityCount ?? 0,
        },
        {
          id: "external_ha",
          title: "Home Assistant",
          enabled: Boolean(enabledMap.external_ha),
          healthy: Boolean(sources?.external_ha?.healthy),
          count: sources?.external_ha?.entityCount ?? 0,
        },
        {
          id: "simulation",
          title: t("offlineDemo"),
          enabled: Boolean(enabledMap.simulation),
          healthy: Boolean(sources?.simulation?.healthy),
          count: sources?.simulation?.entityCount ?? 0,
        },
      ];
    };

    return (
      <View class="rounded-2xl border border-border bg-card p-4 gap-3.5">
        <View class="gap-1.5 border-b border-border pb-2.5">
          <Text class="text-foreground text-sm font-semibold">
            {t("devicesCount", { count: devices().length })}
          </Text>
          <If
            when={props.store.homeConnection()?.healthy}
            else={
              <Text class="text-muted-foreground text-xs">
                {t("notConnected")}
              </Text>
            }
          >
            <View class="flex-row items-center gap-1.5">
              <View class="w-1.5 h-1.5 rounded-full bg-verified" />
              <Text class="text-verified text-xs font-semibold">
                {t("serviceAvailable")}
              </Text>
            </View>
          </If>
        </View>

        {/* Multi-Source Concurrent Status List */}
        <View class="gap-2">
          <Each of={sourceItems()} key={(s) => s.id}>
            {(src) => (
              <View class="rounded-xl border border-border bg-muted p-3 flex-row items-center justify-between gap-2">
                <View class="gap-0.5 flex-1 min-w-0">
                  <View class="flex-row items-center gap-1.5">
                    <View
                      class={
                        src().healthy
                          ? "w-1.5 h-1.5 rounded-full bg-verified"
                          : src().enabled
                            ? "w-1.5 h-1.5 rounded-full bg-warning"
                            : "w-1.5 h-1.5 rounded-full bg-border"
                      }
                    />
                    <Text class="text-foreground text-xs font-semibold">
                      {src().title}
                    </Text>
                  </View>
                  <Text class="text-muted-foreground text-xs font-mono">
                    {src().enabled
                      ? `${t("sourceEnabled")} · ${src().count}`
                      : t("sourceDisabled")}
                  </Text>
                </View>

                <Button
                  testID={`home-source-toggle-${src().id}`}
                  disabled={working()}
                  onPress={() =>
                    void toggleSourceEnabled(src().id, !src().enabled)
                  }
                  class={
                    src().enabled
                      ? "min-h-8 px-2.5 rounded-lg border border-border bg-card items-center justify-center active:opacity-75"
                      : "min-h-8 px-2.5 rounded-lg bg-primary items-center justify-center active:opacity-75"
                  }
                >
                  <Text
                    class={
                      src().enabled
                        ? "text-foreground text-xs font-medium"
                        : "text-primary-foreground text-xs font-semibold"
                    }
                  >
                    {src().enabled ? t("disableSource") : t("enableSource")}
                  </Text>
                </Button>
              </View>
            )}
          </Each>
        </View>
      </View>
    );
  };

  const renderServicesSubView = () => {
    const wide = () => windowSize().width >= 600;
    return (
      <If
        when={wide()}
        else={
          <Scroll class="flex-1" contentClass="gap-3.5 pb-6">
            {renderServicesLeftCard()}
            {renderServicesRightCard()}
          </Scroll>
        }
      >
        <View class="flex-1 flex-row gap-3.5 min-h-0">
          <View style={{ flex: 7, minWidth: 0, minHeight: 0 }}>
            <Scroll class="flex-1" contentClass="gap-3 pb-4">
              {renderServicesLeftCard()}
            </Scroll>
          </View>
          <View style={{ flex: 5, minWidth: 0, minHeight: 0 }}>
            <Scroll class="flex-1" contentClass="gap-3 pb-4">
              {renderServicesRightCard()}
            </Scroll>
          </View>
        </View>
      </If>
    );
  };

  return (
    <View class="flex-1 min-h-0">
      <If
        when={activeSubView() === "devices"}
        else={renderServicesSubView()}
      >
        {renderDevicesSubView()}
      </If>
      {renderInspectorPanel()}
    </View>
  );
}
