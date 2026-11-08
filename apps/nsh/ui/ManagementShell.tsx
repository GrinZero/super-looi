import { t, translateMessage, formatDate } from "../i18n";
import { effect, signal, Text, View, Scroll, windowSize } from "nsh";
import { Button } from "nsh/base";
import type { LlmBrandId } from "../generated/looi-runtime.js";
import type { createAppStore, AppSpace } from "../store";
import { ActionButton, LightToast } from "./Controls";
import { ModelsSpaceView } from "./ModelsSpaceView";
import { VoiceSpaceView } from "./VoiceSpaceView";
import { HomeSpaceView } from "./HomeSpaceView";
import { BodySpaceView } from "./BodySpaceView";
import { TasksSpaceView } from "./TasksSpaceView";
import { SettingsSpaceView } from "./SettingsSpaceView";

export function ManagementShell(props: {
  store: ReturnType<typeof createAppStore>;
}) {
  const selectedBrandId = signal<LlmBrandId>("openai");
  const homeModeTab = signal<"direct_miot" | "external_ha" | "simulation">(
    "direct_miot",
  );

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
    const widthClass = rail ? "w-full min-h-11 px-1" : "min-h-11 min-w-11 px-2.5";
    return (
      <Button
        testID={testId}
        selected={isSelected()}
        accessibilityLabel={label()}
        onPress={() => props.store.openSpace(space)}
        class={
          isSelected()
            ? `${widthClass} rounded-xl bg-card border border-border items-center justify-center active:opacity-75`
            : `${widthClass} rounded-xl items-center justify-center active:opacity-75`
        }
      >
        <View class="w-full items-center justify-center relative">
          <Text
            class={
              isSelected()
                ? "text-foreground text-xs font-bold text-center"
                : "text-muted-foreground text-xs font-medium text-center"
            }
            style={{ numberOfLines: 1 }}
          >
            {label()}
          </Text>
          <If when={space === "tasks" && props.store.recoveryCount() > 0}>
            <View class="absolute -top-1 right-0.5 w-2 h-2 rounded-full bg-destructive" />
          </If>
          <If
            when={
              space === "body" &&
              props.store.bodyStatus().connected
            }
          >
            <View class="absolute -top-1 right-0.5 w-2 h-2 rounded-full bg-verified" />
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
                      ? "min-h-11 px-2.5 rounded-full bg-primary border border-transparent flex-row items-center gap-1.5 active:opacity-75"
                      : "min-h-11 px-2.5 rounded-full border border-border bg-muted flex-row items-center gap-1.5 active:opacity-75"
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

      <If when={props.store.activeSpace() === "voice"}>
        <View class="flex-row items-center gap-2 flex-1 min-w-0 h-11">
          <Text class="text-foreground text-xs font-semibold">{t("liveVoice")}</Text>
          <View class="px-2.5 py-1 rounded-full border border-border bg-muted flex-row items-center gap-1.5">
            <View
              class={
                props.store.voiceConfigured()
                  ? "w-1.5 h-1.5 rounded-full bg-verified"
                  : "w-1.5 h-1.5 rounded-full bg-border"
              }
            />
            <Text class="text-muted-foreground text-xs">
              {props.store.voiceConfigured()
                ? t("providerReady", { provider: props.store.voiceProviderLabel() })
                : t("voiceCredentialsNotConfigured")}
            </Text>
          </View>
        </View>
      </If>

      <If when={props.store.activeSpace() === "home"}>
        <Scroll
          horizontal={true}
          scrollbar={false}
          class="flex-1 h-11"
          contentClass="flex-row items-center gap-1.5 h-11"
        >
          <Each of={homeModes} key={(m) => m.id}>
            {(m) => {
              const active = () => homeModeTab() === m().id;
              return (
                <Button
                  onPress={() => homeModeTab.set(m().id)}
                  class={
                    active()
                      ? "min-h-11 px-3 rounded-full bg-primary border border-transparent items-center justify-center active:opacity-75"
                      : "min-h-11 px-3 rounded-full border border-border bg-muted items-center justify-center active:opacity-75"
                  }
                >
                  <Text
                    class={
                      active()
                        ? "text-primary-foreground text-xs font-semibold"
                        : "text-muted-foreground text-xs font-medium"
                    }
                  >
                    {m().label}
                  </Text>
                </Button>
              );
            }}
          </Each>
          <If when={props.store.homeConfiguration().mode !== "disabled"}>
            <Button
              testID="home-disable"
              onPress={() =>
                void props.store.configureHome({ mode: "disabled" })
              }
              class="min-h-11 px-2.5 items-center justify-center active:opacity-75"
            >
              <Text class="text-muted-foreground text-xs">{t("disableHome95")}</Text>
            </Button>
          </If>
        </Scroll>
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
                  ? "min-h-11 px-3 rounded-full bg-primary border border-transparent items-center justify-center active:opacity-75"
                  : "min-h-11 px-3 rounded-full border border-border bg-muted items-center justify-center active:opacity-75"
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
                  ? "min-h-11 px-3 rounded-full bg-primary border border-transparent items-center justify-center active:opacity-75"
                  : "min-h-11 px-3 rounded-full border border-border bg-muted items-center justify-center active:opacity-75"
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
          <Button
            testID="body-scan-btn"
            disabled={props.store.bodyStatus().scanning}
            onPress={() => void props.store.scanBodyDevices()}
            class="min-h-11 px-3 rounded-full border border-border bg-muted items-center justify-center active:opacity-75 disabled:opacity-40"
          >
            <Text class="text-foreground text-xs font-medium">
              {props.store.bodyStatus().scanning
                ? t("scanningNearbyDocks")
                : t("scanNearbyDocks")}
            </Text>
          </Button>
        </View>
      </If>

      <If when={props.store.activeSpace() === "tasks"}>
        <Scroll horizontal={true} scrollbar={false} class="flex-1 min-w-0 h-11" contentClass="flex-row items-center gap-2 h-11 pr-2">
          <Text class="text-foreground text-xs font-semibold">
            {t("tasksAndActivity")}</Text>
          <ActionButton
            label={t("newConversation")}
            testID="new-conversation-btn"
            compact={true}
            disabled={props.store.busy()}
            onPress={() => props.store.newConversation()}
          />
          <ActionButton
            label={t("refresh")}
            testID="refresh-tasks-btn"
            compact={true}
            onPress={() => props.store.refreshTasks(props.store.tasks().offset)}
          />
        </Scroll>
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
      <If when={props.store.activeSpace() === "models"}>
        <ModelsSpaceView
          store={props.store}
          selectedBrandId={() => selectedBrandId()}
        />
      </If>
      <If when={props.store.activeSpace() === "voice"}>
        <VoiceSpaceView store={props.store} />
      </If>
      <If when={props.store.activeSpace() === "home"}>
        <HomeSpaceView
          store={props.store}
          modeTab={() => homeModeTab()}
        />
      </If>
      <If when={props.store.activeSpace() === "body"}>
        <BodySpaceView store={props.store} />
      </If>
      <If when={props.store.activeSpace() === "tasks"}>
        <TasksSpaceView store={props.store} />
      </If>
      <If when={props.store.activeSpace() === "settings"}>
        <SettingsSpaceView store={props.store} />
      </If>
    </View>
  );

  return (
    <If
      when={wide()}
      else={
        // Handheld portrait layout
        <View
          class="flex-1 bg-background"
          style={{
            paddingLeft: "env(safe-area-inset-left)",
            paddingRight: "env(safe-area-inset-right)",
          }}
        >
          {/* Top header */}
          <View
            class="min-h-12 border-b border-border px-3 py-1.5 flex-row items-center justify-between gap-2 bg-card"
            style={{
              paddingTop: "calc(env(safe-area-inset-top) + 6px)",
            }}
          >
            <Button
              testID="back-to-face"
              accessibilityLabel={t("backToLooi")}
              onPress={() => props.store.backToFace()}
              class="min-h-11 px-2.5 rounded-xl bg-stage-bg border border-border flex-row items-center justify-center gap-1 active:opacity-75"
            >
              <View class="w-2 h-2 rounded-full bg-eye-core" />
              <View class="w-2 h-2 rounded-full bg-eye-core" />
            </Button>
            {renderContextPillBar()}
            <Button
              testID="back-btn"
              onPress={() => props.store.backToFace()}
              class="min-h-11 px-2.5 rounded-full border border-border bg-card items-center justify-center active:opacity-75"
            >
              <Text class="text-foreground text-xs font-medium">{t("back")}</Text>
            </Button>
          </View>

          {/* Main Workspace */}
          <View class="flex-1 p-3 min-h-0 relative">
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
              paddingBottom: "calc(env(safe-area-inset-bottom) + 4px)",
            }}
          >
            {renderNavButton("models", () => t("models"), "nav-models")}
            {renderNavButton("voice", () => t("voice"), "nav-voice")}
            {renderNavButton("home", () => t("home"), "nav-home")}
            {renderNavButton("body", () => t("body"), "nav-body")}
            {renderNavButton("tasks", () => t("tasks"), "nav-tasks")}
            {renderNavButton("settings", () => t("settings"), "nav-settings")}
          </View>
        </View>
      }
    >
      {/* Landscape dock layout */}
      <View
        class="flex-1 flex-row bg-background"
        style={{
          paddingTop: "env(safe-area-inset-top)",
          paddingRight: "env(safe-area-inset-right)",
          paddingBottom: "env(safe-area-inset-bottom)",
          paddingLeft: "env(safe-area-inset-left)",
        }}
      >
        {/* Left Slim Rail */}
        <View
          class="w-20 bg-sidebar border-r border-border pt-2.5 pb-2.5 items-center justify-between"
        >
          <Button
            testID="back-to-face"
            accessibilityLabel={t("backToLooi")}
            onPress={() => props.store.backToFace()}
            class="w-11 h-11 rounded-xl bg-stage-bg border border-border flex-row items-center justify-center gap-1.5 active:opacity-75"
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
            {renderNavButton("settings", () => t("settings"), "nav-settings", true)}
          </Scroll>

          <View
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
          >
            {renderContextPillBar()}
            <Button
              testID="back-btn"
              onPress={() => props.store.backToFace()}
              class="min-h-11 px-3 rounded-full border border-border bg-card items-center justify-center active:opacity-75"
            >
              <Text class="text-foreground text-xs font-medium">{t("back")}</Text>
            </Button>
          </View>

          {/* Bottom Workspace Body */}
          <View
            class="flex-1 p-3.5 min-h-0 relative"
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
