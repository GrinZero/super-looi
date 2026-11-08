import { t, translateMessage, formatDate } from "../i18n";
import { effect, signal, Text, View, Scroll, windowSize } from "nsh";
import { Select } from "nsh/base";
import type { HomeConfiguration } from "../generated/looi-runtime.js";
import type { createAppStore } from "../store";
import { ActionButton, TextField } from "./Controls";

type HomeModeTab = "direct_miot" | "external_ha" | "simulation";

export function HomeSpaceView(props: {
  store: ReturnType<typeof createAppStore>;
  modeTab: HomeModeTab | (() => HomeModeTab);
}) {
  const activeModeTab = (): HomeModeTab =>
    typeof props.modeTab === "function" ? props.modeTab() : props.modeTab;
  const regions = [
    { value: "cn", get title() { return t("mainlandChina"); } },
    { value: "de", get title() { return t("europe"); } },
    { value: "i2", get title() { return t("india"); } },
    { value: "ru", get title() { return t("russia"); } },
    { value: "sg", get title() { return t("singapore"); } },
    { value: "us", get title() { return t("unitedStates"); } },
  ];

  const region = signal<HomeConfiguration["region"]>("cn");
  const haUrl = signal("");
  const haToken = signal("");
  const working = signal(false);
  const error = signal("");

  let lastSyncedHomeKey = "";
  effect(() => {
    const cfg = props.store.homeConfiguration();
    const readyFlag = typeof props.store.ready === "function" ? props.store.ready() : true;
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
    } catch (cause) {
      error.set(cause instanceof Error ? cause.message : String(cause));
    } finally {
      working.set(false);
    }
  };

  const renderLeftCard = () => (
    <View class="gap-3.5">
      <If when={activeModeTab() === "direct_miot"}>
        <View class="rounded-2xl border border-border bg-card p-4 gap-3.5">
          <View class="gap-1.5 border-b border-border pb-2.5">
            <View class="gap-0.5">
              <Text class="text-foreground text-sm font-semibold">
                {t("connectYourXiaomiHomeAccount")}</Text>
              <Text class="text-muted-foreground text-xs font-mono">
                {t("cloudSyncOutletsLightsAndTemperaturehumiditySensors")}</Text>
            </View>
            <If when={props.store.homeConfiguration().hasMiotAccount}>
              <View class="flex-row items-center gap-1.5 px-2 py-0.5 rounded-full bg-muted">
                <View class="w-1.5 h-1.5 rounded-full bg-verified" />
                <Text class="text-verified text-xs font-medium">{t("signedIn")}</Text>
              </View>
            </If>
          </View>

          <Text class="text-muted-foreground text-xs">
            {t("chooseYourXiaomiHomeRegionAfterSigning")}</Text>

          <View class="gap-2">
            <Text class="text-muted-foreground text-sm">{t("xiaomiHomeRegion")}</Text>
            <Select
              testID="home-miot-region"
              accessibilityLabel={t("xiaomiHomeRegion")}
              items={regions}
              value={region()}
              disabled={working() || props.store.busy()}
              onChange={(event) => {
                if (regions.some((item) => item.value === event.value)) {
                  region.set(event.value as HomeConfiguration["region"]);
                }
              }}
              popupClass="bg-card rounded-xl border border-border"
              itemClass="min-h-12 px-4 text-foreground selected:bg-muted"
              trigger={
                <View class="min-h-12 justify-center rounded-xl border border-input bg-background px-4">
                  <Text class="text-foreground text-base">
                    {regions.find((item) => item.value === region())?.title}
                  </Text>
                </View>
              }
            />
          </View>

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

      <If when={activeModeTab() === "external_ha"}>
        <View class="rounded-2xl border border-border bg-card p-4 gap-3.5">
          <View class="border-b border-border pb-2.5">
            <Text class="text-foreground text-sm font-semibold">
              {t("connectAHomeAssistantInstance")}</Text>
            <Text class="text-muted-foreground text-xs font-mono">
              {t("directLocalOrRemoteWebsocketApiConnection")}</Text>
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
              label={working() ? t("connecting48") : t("connectHomeAssistant")}
              testID="home-connect"
              kind="primary"
              compact={true}
              disabled={working() || !haUrl().trim()}
              onPress={configureHa}
            />
          </View>
        </View>
      </If>

      <If when={activeModeTab() === "simulation"}>
        <View class="rounded-2xl border border-border bg-card p-4 gap-3.5">
          <View class="border-b border-border pb-2.5">
            <Text class="text-foreground text-sm font-semibold">
              {t("offlineDemoEnvironment")}</Text>
            <Text class="text-muted-foreground text-xs font-mono">
              {t("virtualDevicesStoredInLocalMemory")}</Text>
          </View>

          <Text class="text-muted-foreground text-xs">
            {t("tryAStudyCeilingLightDeskLamp")}</Text>

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
          {t("deviceControlsRequireOnetimeApprovalBeforeExecution")}</Text>
      </View>

      <If when={translateMessage(error() || props.store.homeConnection()?.error || "")}>
        <View class="rounded-xl border border-destructive bg-muted p-3">
          <Text role="alert" class="text-destructive text-xs font-medium">
            {translateMessage(error() || props.store.homeConnection()?.error || "")}
          </Text>
        </View>
      </If>
    </View>
  );

  const renderRightCard = () => (
    <View class="rounded-2xl border border-border bg-card p-4 gap-3.5">
      <View class="gap-1.5 border-b border-border pb-2.5">
        <Text class="text-foreground text-sm font-semibold">
          {t("devicesCount", { count: devices().length })}
        </Text>
        <If
          when={props.store.homeConnection()?.healthy}
          else={
            <Text class="text-muted-foreground text-xs">{t("notConnected")}</Text>
          }
        >
          <View class="flex-row items-center gap-1.5">
            <View class="w-1.5 h-1.5 rounded-full bg-verified" />
            <Text class="text-verified text-xs font-semibold">{t("serviceAvailable")}</Text>
          </View>
        </If>
      </View>

      <If
        when={devices().length > 0}
        else={
          <View class="py-6 items-center justify-center">
            <Text class="text-muted-foreground text-xs">
              {t("noDevicesFoundConnectXiaomiHomeHome")}</Text>
          </View>
        }
      >
        <View class="gap-2">
          <Each of={devices()} key={(d) => d.entity_id}>
            {(d) => (
              <View class="rounded-xl border border-border bg-muted p-3 flex-row items-center justify-between">
                <View class="gap-0.5" style={{ flex: 1, minWidth: 0 }}>
                  <Text
                    class="text-foreground text-sm font-medium"
                    style={{ numberOfLines: 1 }}
                  >
                    {d().friendly_name}
                  </Text>
                  <Text
                    class="text-muted-foreground text-xs font-mono"
                    style={{ numberOfLines: 1 }}
                  >
                    {d().entity_id}
                  </Text>
                </View>
                <View class="px-2 py-0.5 rounded-md bg-secondary">
                  <Text class="text-foreground text-xs font-medium">
                    {d().snapshot?.state ?? t("online")}
                  </Text>
                </View>
              </View>
            )}
          </Each>
        </View>
      </If>
    </View>
  );

  const wide = () => windowSize().width >= 600;

  return (
    <If
      when={wide()}
      else={
        <Scroll class="flex-1" contentClass="gap-3.5 pb-6">
          {renderLeftCard()}
          {renderRightCard()}
        </Scroll>
      }
    >
      <View class="flex-1 flex-row gap-3.5 min-h-0">
        <View style={{ flex: 7, minWidth: 0, minHeight: 0 }}>
          <Scroll class="flex-1" contentClass="gap-3 pb-4">
            {renderLeftCard()}
          </Scroll>
        </View>
        <View style={{ flex: 5, minWidth: 0, minHeight: 0 }}>
          <Scroll class="flex-1" contentClass="gap-3 pb-4">
            {renderRightCard()}
          </Scroll>
        </View>
      </View>
    </If>
  );
}
