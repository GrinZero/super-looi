import { t, translateMessage, formatDate } from "../i18n";
import { effect, safeAreaInsets, signal, Text, View, Scroll, windowSize } from "nsh";
import { Button } from "nsh/base";
import type { LlmBrandId } from "../generated/looi-runtime.js";
import type { createAppStore, AppSpace } from "../store";
import { ActionButton, IconButton, LightToast } from "./Controls";
import { ModelsSpaceView } from "./ModelsSpaceView";
import { VoiceServiceBar, VoiceSpaceView } from "./VoiceSpaceView";
import { HomeSpaceView } from "./HomeSpaceView";
import { BodySpaceView } from "./BodySpaceView";
import { TasksSpaceView } from "./TasksSpaceView";
import { SchedulesContextBar, SchedulesSpaceView } from "./SchedulesSpaceView";
import { PluginsContextBar, PluginsSpaceView } from "./PluginsSpaceView";
import { SettingsSpaceView } from "./SettingsSpaceView";
import { RetainedPage } from "./RetainedPage";

export function ManagementShell(props: {
  store: ReturnType<typeof createAppStore>;
  onNewConversation: () => void;
  cutoutInsets?: { left: number; right: number };
}) {
  const insets = safeAreaInsets();
  const leftInset = () => insets().left + (props.cutoutInsets?.left ?? 0);
  const rightInset = () => insets().right + (props.cutoutInsets?.right ?? 0);
  const selectedBrandId = signal<LlmBrandId>("openai");
  const homeModeTab = signal<"direct_miot" | "external_ha" | "simulation">(
    "direct_miot",
  );
  const scheduleCreateRuleNonce = signal(0);
  const scheduleAddQuietNonce = signal(0);

  // Sync selectedBrandId only when active brand transitions
  let lastSyncedActiveBrand: LlmBrandId | null = null;
  effect(() => {
    const activeBrand = props.store.llm().active?.brandId ?? null;
    if (activeBrand && activeBrand !== lastSyncedActiveBrand) {
      lastSyncedActiveBrand = activeBrand;
      selectedBrandId.set(activeBrand);
    }
  });

  // Sync homeModeTab only when configured home mode transitions
  let lastSyncedHomeMode = "";
  effect(() => {
    const mode = props.store.homeConfiguration().mode;
    if (mode === lastSyncedHomeMode) return;
    lastSyncedHomeMode = mode;
    if (mode === "external_ha") {
      homeModeTab.set("external_ha");
    } else if (mode === "simulation") {
      homeModeTab.set("simulation");
    } else if (mode === "direct_miot") {
      homeModeTab.set("direct_miot");
    }
  });

  const wide = () => windowSize().width >= 600;

  const renderNavButton = (
    space: AppSpace,
    label: () => string,
    testId: string,
    rail = false,
  ) => {
    const isSelected = () => props.store.activeSpace() === space;
    const widthClass = rail ? "w-full min-h-11 px-1" : "min-h-11 min-w-11 px-1.5";
    const focusRingClass = rail
      ? "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar"
      : "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card";
    const scheduleHasWarning = () =>
      space === "schedules" &&
      (props.store.pendingScheduleInteractionCount() > 0 ||
        props.store.scheduleRules().some((item) => item.state === "unconfirmed"));
    const scheduleIsActive = () =>
      space === "schedules" &&
      !scheduleHasWarning() &&
      props.store
        .scheduleRules()
        .some((item) => item.state === "running" || (item.state === "active" && item.enabled));
    return (
      <Button
        testID={testId}
        selected={isSelected()}
        accessibilityLabel={label()}
        onPress={() => props.store.openSpace(space)}
        class={
          isSelected()
            ? `${widthClass} rounded-xl bg-primary items-center justify-center transition-colors duration-150 active:opacity-75 ${focusRingClass}`
            : `${widthClass} rounded-xl items-center justify-center hover:bg-muted transition-colors duration-150 active:opacity-75 ${focusRingClass}`
        }
      >
        <View class="w-full items-center justify-center relative">
          <Text
            class={
              isSelected()
                ? "text-primary-foreground text-xs font-bold text-center"
                : "text-muted-foreground text-xs font-medium text-center"
            }
            style={{ numberOfLines: 1 }}
          >
            {label()}
          </Text>
          <If
            when={
              space === "body" &&
              props.store.bodyStatus().connected
            }
          >
            <View class="absolute -top-1 right-0.5 w-2 h-2 rounded-full bg-verified" />
          </If>
          <If
            when={
              space === "home" &&
              Boolean(props.store.homeConnection()?.healthy)
            }
          >
            <View class="absolute -top-1 right-0.5 w-2 h-2 rounded-full bg-verified" />
          </If>
          <If when={scheduleHasWarning()}>
            <View testID="nav-schedules-warning-dot" class="absolute -top-1 right-0.5 w-2 h-2 rounded-full bg-warning" />
          </If>
          <If when={scheduleIsActive()}>
            <View testID="nav-schedules-active-dot" class="absolute -top-1 right-0.5 w-2 h-2 rounded-full bg-verified" />
          </If>
        </View>
      </Button>
    );
  };

  const homeModes: Array<{
    id: "direct_miot" | "external_ha" | "simulation";
    label: string;
  }> = [
    { id: "direct_miot", get label() { return t("xiaomiHome92"); } },
    { id: "external_ha", label: "Home Assistant" },
    { id: "simulation", get label() { return t("offlineDemo"); } },
  ];

  const renderContextPillBar = () => (
    <View class="flex-1 min-w-0 h-11 flex-row items-center">
      <If when={props.store.activeSpace() === "models"}>
        <Scroll
          horizontal={true}
          scrollbar={false}
          class="flex-1 h-11"
          contentClass="flex-row items-center gap-1 h-11 pr-1"
        >
          <Each of={props.store.llm().brands} key={(b) => b.brandId}>
            {(b) => {
              const isSelected = () => selectedBrandId() === b().brandId;
              const hasCreds = () =>
                b().configured ||
                b().channels.some((c) => c.hasApiKey || c.hasOAuth);

              return (
                <Button
                  testID={`brand-${b().brandId}`}
                  onPress={() => selectedBrandId.set(b().brandId)}
                  class={
                    isSelected()
                      ? "min-h-11 px-2.5 rounded-full bg-primary border border-transparent flex-row items-center gap-1.5 transition-colors duration-150 active:opacity-75 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
                      : "min-h-11 px-2.5 rounded-full border border-border bg-muted flex-row items-center gap-1.5 hover:bg-accent transition-colors duration-150 active:opacity-75 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
                  }
                >
                  <If when={hasCreds()}>
                    <View class="w-1.5 h-1.5 rounded-full bg-verified" />
                  </If>
                  <Text
                    class={
                      isSelected()
                        ? "text-primary-foreground text-xs font-semibold"
                        : "text-muted-foreground text-xs font-medium"
                    }
                    style={{ numberOfLines: 1 }}
                  >
                    {b().label}
                  </Text>
                </Button>
              );
            }}
          </Each>
        </Scroll>
      </If>

      <If when={props.store.activeSpace() === "plugins"}>
        <PluginsContextBar store={props.store} />
      </If>
      <If when={props.store.activeSpace() === "voice"}>
        <VoiceServiceBar store={props.store} />
      </If>

      <If when={props.store.activeSpace() === "home"}>
        <View class="flex-1 min-w-0 h-11 flex-row items-center justify-between gap-2">
          <Scroll
            horizontal={true}
            scrollbar={false}
            class="flex-1 h-11"
            contentClass="flex-row items-center gap-1.5 h-11"
          >
            <Button
              testID="home-tab-devices"
              selected={props.store.homeSubView() === "devices"}
              onPress={() => props.store.setHomeSubView("devices")}
              class={
                props.store.homeSubView() === "devices"
                  ? "min-h-11 px-3 rounded-full bg-primary border border-transparent flex-row items-center gap-1.5 transition-colors duration-150 active:opacity-75 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
                  : "min-h-11 px-3 rounded-full border border-border bg-muted flex-row items-center gap-1.5 hover:bg-accent transition-colors duration-150 active:opacity-75 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
              }
            >
              <Text
                class={
                  props.store.homeSubView() === "devices"
                    ? "text-primary-foreground text-xs font-semibold"
                    : "text-muted-foreground text-xs font-medium"
                }
              >
                {props.store.homeDashboard().totalAppliances > 0
                  ? `${t("myDevices")} · ${props.store.homeDashboard().totalAppliances}`
                  : t("myDevices")}
              </Text>
            </Button>

            <Button
              testID="home-tab-services"
              selected={props.store.homeSubView() === "services"}
              onPress={() => props.store.setHomeSubView("services")}
              class={
                props.store.homeSubView() === "services"
                  ? "min-h-11 px-3 rounded-full bg-primary border border-transparent flex-row items-center gap-1.5 transition-colors duration-150 active:opacity-75 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
                  : "min-h-11 px-3 rounded-full border border-border bg-muted flex-row items-center gap-1.5 hover:bg-accent transition-colors duration-150 active:opacity-75 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
              }
            >
              <If when={props.store.homeConnection()?.healthy}>
                <View class="w-1.5 h-1.5 rounded-full bg-verified" />
              </If>
              <Text
                class={
                  props.store.homeSubView() === "services"
                    ? "text-primary-foreground text-xs font-semibold"
                    : "text-muted-foreground text-xs font-medium"
                }
              >
                {t("serviceBinding")}
              </Text>
            </Button>
          </Scroll>

          <If
            when={
              props.store.homeSubView() === "services" &&
              props.store.homeConfiguration().mode !== "disabled"
            }
          >
            <Button
              testID="home-disable"
              onPress={() =>
                void props.store.configureHome({ mode: "disabled" })
              }
              class="min-h-11 px-3 rounded-full border border-border bg-muted items-center justify-center shrink-0 hover:bg-accent transition-colors duration-150 active:opacity-75 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
            >
              <Text class="text-muted-foreground text-xs font-medium">{t("disableHome95")}</Text>
            </Button>
          </If>

          <If
            when={
              props.store.homeSubView() === "devices" &&
              props.store.homeDashboard().totalAppliances > 0
            }
          >
            <View class="flex-row items-center gap-1.5">
              <IconButton
                testID="home-refresh-btn"
                icon="refresh"
                label={t("refresh")}
                busy={props.store.homeRefreshing()}
                onPress={() => void props.store.refreshHomeDashboard()}
              />
            </View>
          </If>
        </View>
      </If>

      <If when={props.store.activeSpace() === "body"}>
        <View class="flex-1 min-w-0 h-11 flex-row items-center justify-between gap-2">
          <Scroll
            horizontal={true}
            scrollbar={false}
            class="flex-1 h-11"
            contentClass="flex-row items-center gap-1.5 h-11"
          >
            <Button
              testID="body-mode-ble"
              selected={props.store.bodyStatus().mode !== "simulation"}
              onPress={() =>
                void props.store.configureBody({ mode: "real_ble" })
              }
              class={
                props.store.bodyStatus().mode !== "simulation"
                  ? "min-h-11 px-3 rounded-full bg-primary border border-transparent items-center justify-center transition-colors duration-150 active:opacity-75 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
                  : "min-h-11 px-3 rounded-full border border-border bg-muted items-center justify-center hover:bg-accent transition-colors duration-150 active:opacity-75 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
              }
            >
              <Text
                class={
                  props.store.bodyStatus().mode !== "simulation"
                    ? "text-primary-foreground text-xs font-semibold"
                    : "text-muted-foreground text-xs font-medium"
                }
              >
                {t("bleDock")}
              </Text>
            </Button>
            <Button
              testID="body-mode-sim"
              selected={props.store.bodyStatus().mode === "simulation"}
              onPress={() =>
                void props.store.configureBody({ mode: "simulation" })
              }
              class={
                props.store.bodyStatus().mode === "simulation"
                  ? "min-h-11 px-3 rounded-full bg-primary border border-transparent items-center justify-center transition-colors duration-150 active:opacity-75 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
                  : "min-h-11 px-3 rounded-full border border-border bg-muted items-center justify-center hover:bg-accent transition-colors duration-150 active:opacity-75 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
              }
            >
              <Text
                class={
                  props.store.bodyStatus().mode === "simulation"
                    ? "text-primary-foreground text-xs font-semibold"
                    : "text-muted-foreground text-xs font-medium"
                }
              >
                {t("simulationMode")}
              </Text>
            </Button>
          </Scroll>
          <IconButton
            testID="body-scan-btn"
            icon="scan"
            label={props.store.bodyStatus().scanning
              ? t("scanningNearbyDocks")
              : t("scanNearbyDocks")}
            busy={props.store.bodyStatus().scanning}
            onPress={() => void props.store.scanBodyDevices()}
          />
        </View>
      </If>

      <If when={props.store.activeSpace() === "tasks"}>
        <View class="flex-1 min-w-0 h-11 flex-row items-center justify-between gap-2">
          <Text class="text-foreground text-base font-semibold flex-1 min-w-0" role="header" style={{ numberOfLines: 1 }}>
            {t("tasks")}
          </Text>
          <View class="flex-row items-center gap-1.5 shrink-0">
            <ActionButton
              testID="new-conversation-btn"
              label={t("newConversation")}
              kind="primary"
              compact={true}
              disabled={!props.store.ready() || props.store.busy()}
              onPress={() => props.onNewConversation()}
            />
            <IconButton
              icon="refresh"
              label={t("refresh")}
              testID="refresh-tasks-btn"
              disabled={!props.store.ready()}
              onPress={() => props.store.refreshTasks(props.store.tasks().offset)}
            />
          </View>
        </View>
      </If>

      <If when={props.store.activeSpace() === "schedules"}>
        <SchedulesContextBar
          store={props.store}
          onNewRule={() => scheduleCreateRuleNonce.update((n) => n + 1)}
          onAddQuietWindow={() => scheduleAddQuietNonce.update((n) => n + 1)}
        />
      </If>

      <If when={props.store.activeSpace() === "settings"}>
        <View class="flex-row items-center gap-2 flex-1 min-w-0 h-11">
          <Text class="text-foreground text-xs font-semibold">
            {t("generalSettings")}
          </Text>
        </View>
      </If>
    </View>
  );

  const renderActiveWorkspace = () => (
    <View class="flex-1 min-h-0">
      <RetainedPage active={props.store.activeSpace() === "models"}>
        <ModelsSpaceView
          store={props.store}
          selectedBrandId={() => selectedBrandId()}
        />
      </RetainedPage>
      <RetainedPage active={props.store.activeSpace() === "voice"}>
        <VoiceSpaceView store={props.store} />
      </RetainedPage>
      <RetainedPage active={props.store.activeSpace() === "home"}>
        <HomeSpaceView
          store={props.store}
          modeTab={() => homeModeTab()}
        />
      </RetainedPage>
      <RetainedPage active={props.store.activeSpace() === "body"}>
        <BodySpaceView store={props.store} />
      </RetainedPage>
      <RetainedPage active={props.store.activeSpace() === "tasks"}>
        <TasksSpaceView store={props.store} />
      </RetainedPage>
      <RetainedPage active={props.store.activeSpace() === "schedules"}>
        <SchedulesSpaceView
          store={props.store}
          createRuleNonce={() => scheduleCreateRuleNonce()}
          addQuietNonce={() => scheduleAddQuietNonce()}
        />
      </RetainedPage>
      <RetainedPage active={props.store.activeSpace() === "plugins"}>
        <PluginsSpaceView store={props.store} />
      </RetainedPage>
      <RetainedPage active={props.store.activeSpace() === "settings"}>
        <SettingsSpaceView store={props.store} />
      </RetainedPage>
    </View>
  );

  return (
    <If
      when={wide()}
      else={
        // Handheld portrait layout
        <View
          class="flex-1 bg-background"
        >
          {/* Top header */}
          <View
            class="min-h-12 border-b border-border px-3 py-1.5 flex-row items-center justify-between gap-2 bg-card"
            style={{
              paddingTop: insets().top + 6,
              paddingLeft: leftInset() + 12,
              paddingRight: rightInset() + 12,
            }}
          >
            <Button
              testID="back-to-face"
              accessibilityLabel={t("backToLooi")}
              onPress={() => props.store.backToFace()}
              class="min-h-11 px-2.5 rounded-xl bg-stage-bg border border-border flex-row items-center justify-center gap-1 active:opacity-75 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
            >
              <View class="w-2 h-2 rounded-full bg-eye-core" />
              <View class="w-2 h-2 rounded-full bg-eye-core" />
            </Button>
            {renderContextPillBar()}
            <If
              when={
                !(
                  props.store.activeSpace() === "plugins" &&
                  Boolean(props.store.inspectedPluginId())
                )
              }
            >
              <IconButton
                testID="back-btn"
                icon="back"
                label={t("back")}
                kind="outline"
                onPress={() => props.store.goBack()}
              />
            </If>
          </View>

          {/* Main Workspace */}
          <View
            class="flex-1 p-3 min-h-0 relative"
            style={{ paddingLeft: leftInset() + 12, paddingRight: rightInset() + 12 }}
          >
            {renderActiveWorkspace()}
            <If when={props.store.toast()}>
              <View class="absolute top-2 inset-x-0 items-center pointer-events-none z-30">
                <LightToast text={props.store.toast()} />
              </View>
            </If>
          </View>

          {/* Bottom navigation bar */}
          <View
            class="min-h-14 bg-sidebar border-t border-border flex-row items-center justify-around px-2 py-1"
            style={{
              paddingBottom: insets().bottom + 4,
              paddingLeft: leftInset() + 8,
              paddingRight: rightInset() + 8,
            }}
          >
            {renderNavButton("models", () => t("models"), "nav-models")}
            {renderNavButton("voice", () => t("voice"), "nav-voice")}
            {renderNavButton("home", () => t("home"), "nav-home")}
            {renderNavButton("body", () => t("body"), "nav-body")}
            {renderNavButton("tasks", () => t("tasks"), "nav-tasks")}
            {renderNavButton("schedules", () => t("schedules"), "nav-schedules")}
            {renderNavButton("plugins", () => t("plugins"), "nav-plugins")}
            {renderNavButton("settings", () => t("settings"), "nav-settings")}
          </View>
        </View>
      }
    >
      {/* Landscape dock layout */}
      <View
        class="flex-1 flex-row bg-background"
      >
        {/* Left Slim Rail */}
        <View
          class="w-20 bg-sidebar border-r border-border pt-2.5 pb-2.5 items-center justify-between"
          style={{
            width: 80 + leftInset(),
            paddingLeft: leftInset(),
            paddingTop: insets().top + 10,
            paddingBottom: insets().bottom + 10,
          }}
        >
          <Button
            testID="back-to-face"
            accessibilityLabel={t("backToLooi")}
            onPress={() => props.store.backToFace()}
            class="w-11 h-11 rounded-xl bg-stage-bg border border-border flex-row items-center justify-center gap-1.5 active:opacity-75 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar"
          >
            <View class="w-2 h-2 rounded-full bg-eye-core" />
            <View class="w-2 h-2 rounded-full bg-eye-core" />
          </Button>

          <Scroll
            scrollbar={false}
            class="w-full flex-1 my-1"
            contentClass="w-full px-1.5 gap-1 items-center justify-center grow"
          >
            {renderNavButton("models", () => t("models"), "nav-models", true)}
            {renderNavButton("voice", () => t("voice"), "nav-voice", true)}
            {renderNavButton("home", () => t("home"), "nav-home", true)}
            {renderNavButton("body", () => t("body"), "nav-body", true)}
            {renderNavButton("tasks", () => t("tasks"), "nav-tasks", true)}
            {renderNavButton("schedules", () => t("schedules"), "nav-schedules", true)}
            {renderNavButton("plugins", () => t("plugins"), "nav-plugins", true)}
            {renderNavButton("settings", () => t("settings"), "nav-settings", true)}
          </Scroll>

          <View
            accessibilityLabel={
              props.store.ready()
                ? t("pluginDependencyReady")
                : t("runtimeLocalRuntimeIsNotReady")
            }
            class={
              props.store.ready()
                ? "w-2 h-2 rounded-full bg-verified"
                : "w-2 h-2 rounded-full bg-border"
            }
          />
        </View>

        {/* Right Main Workspace */}
        <View class="flex-1 min-w-0 flex flex-col min-h-0">
          {/* Top 48pt Context Pill Bar */}
          <View
            class="min-h-12 border-b border-border px-4 py-1.5 flex-row items-center justify-between gap-3 bg-card"
            style={{ paddingTop: insets().top + 6, paddingRight: rightInset() + 16 }}
          >
            {renderContextPillBar()}
            <If
              when={
                !(
                  props.store.activeSpace() === "plugins" &&
                  Boolean(props.store.inspectedPluginId())
                )
              }
            >
              <IconButton
                testID="back-btn"
                icon="back"
                label={t("back")}
                kind="outline"
                onPress={() => props.store.goBack()}
              />
            </If>
          </View>

          {/* Bottom Workspace Body */}
          <View
            class={
              props.store.activeSpace() === "voice"
                ? "flex-1 min-h-0 relative bg-card"
                : "flex-1 px-3.5 pt-2.5 min-h-0 relative"
            }
            style={
              props.store.activeSpace() === "voice"
                ? { paddingRight: rightInset(), paddingBottom: insets().bottom }
                : { paddingRight: rightInset() + 14, paddingBottom: Math.max(10, insets().bottom) }
            }
          >
            {renderActiveWorkspace()}
            <If when={props.store.toast()}>
              <View class="absolute top-2 inset-x-0 items-center pointer-events-none z-30">
                <LightToast text={props.store.toast()} />
              </View>
            </If>
          </View>
        </View>
      </View>
    </If>
  );
}
