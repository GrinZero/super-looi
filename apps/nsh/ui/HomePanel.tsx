import { t, translateMessage, formatDate } from "../i18n";
import { effect, signal, Text, View, windowSize } from "nsh";
import { Select } from "nsh/base";
import type { HomeConfiguration } from "../generated/looi-runtime.js";
import type { createAppStore } from "../store";
import { ActionButton, Panel, TextField } from "./Controls";

export function HomePanel(props: {
  open: boolean;
  store: ReturnType<typeof createAppStore>;
  onClose: () => void;
}) {
  const regions = [
    { value: "cn", get title() { return t("mainlandChina"); } }, { value: "de", get title() { return t("europe"); } },
    { value: "i2", get title() { return t("india"); } }, { value: "ru", get title() { return t("russia"); } },
    { value: "sg", get title() { return t("singapore"); } }, { value: "us", get title() { return t("unitedStates"); } },
  ];
  const region = signal<HomeConfiguration["region"]>("cn");
  const url = signal(""),
    token = signal(""),
    working = signal(false),
    error = signal("");
  let wasOpen = false;
  effect(() => {
    if (props.open && !wasOpen) {
      url.set(props.store.homeConfiguration().haUrl);
      region.set(props.store.homeConfiguration().region);
      token.set("");
      error.set("");
    }
    if (!props.open) {
      token.set("");
      if (wasOpen) props.store.cancelHomeLogin();
    }
    wasOpen = props.open;
  });
  const configure = async (mode: "disabled" | "simulation" | "external_ha") => {
    if (working()) return;
    working.set(true);
    error.set("");
    try {
      await props.store.configureHome({
        mode,
        ...(mode === "external_ha"
          ? { haUrl: url(), ...(token().trim() ? { haToken: token() } : {}) }
          : {}),
      });
      token.set("");
      if (mode !== "disabled") await props.store.connectHome();
    } catch (cause) {
      error.set(cause instanceof Error ? cause.message : String(cause));
    } finally {
      working.set(false);
    }
  };
  const login = async (logout = false) => {
    if (working()) return;
    working.set(true); error.set("");
    try {
      if (logout) await props.store.logoutMiot();
      else await props.store.loginMiot(region());
    } catch (cause) {
      error.set(cause instanceof Error && cause.message.startsWith("@looi:")
        ? cause.message : "@looi:xiaomiHomeConnectionFailedTryAgainLater");
    } finally { working.set(false); }
  };
  const refreshMiot = async () => {
    if (working()) return;
    working.set(true); error.set("");
    try {
      if (props.store.homeConfiguration().mode !== "direct_miot")
        await props.store.configureHome({ mode: "direct_miot", region: region() });
      await props.store.connectHome();
    }
    catch { error.set("@looi:couldNotLoadXiaomiHomeDevicesTry"); }
    finally { working.set(false); }
  };
  const savedMiotSelected = () => props.store.homeConfiguration().hasMiotAccount &&
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
  return (
    <Panel
      open={props.open}
      title={t("homeConnection")}
      height={560}
      wide={true}
      dismissible={!working()}
      onClose={props.onClose}
    >
      <View
        style={{
          flexDirection: windowSize().width >= 680 ? "row" : "column",
          gap: 24,
        }}
      >
        <View class="flex-1 gap-3" style={{ minWidth: 0 }}>
          <TextField
            label={t("homeAssistantUrl")}
            testID="home-url"
            value={url()}
            onChange={(value) => url.set(value)}
            placeholder="https://…"
          />
          <TextField
            label={t("longlivedAccessToken")}
            testID="home-token"
            value={token()}
            onChange={(value) => token.set(value)}
            masked={true}
            placeholder={
              props.store.homeConfiguration().hasToken
                ? t("savedSecurelyLeaveBlankForTheSame")
                : t("enterToken")
            }
          />
          <ActionButton
            label={working() ? t("connecting48") : t("connectHomeAssistant")}
            testID="home-connect"
            kind="primary"
            disabled={working() || props.store.busy() || !url().trim()}
            onPress={() => {
              void configure("external_ha");
            }}
          />
        </View>
        <View class="flex-1 gap-3" style={{ minWidth: 0 }}>
          <Text class="text-foreground text-base">
            {props.store.homeConfiguration().mode === "simulation"
              ? t("offlineDemoNoRealDevices")
              : props.store.homeConnection()?.healthy
                ? t("homeServiceConnected")
                : t("homeIsNotConnected")}
          </Text>
          <View class="gap-1">
            <Text class="text-muted-foreground text-sm">{t("deviceControlRequiresOnetimeApprovalAndA")}</Text>
            <Text class="text-muted-foreground text-sm">{t("aFailedConnectionDoesNotSwitchTo")}</Text>
          </View>
          <View class="flex-row gap-2">
            <ActionButton
              label={t("offlineDemo")}
              testID="home-simulation"
              disabled={working() || props.store.busy()}
              onPress={() => {
                void configure("simulation");
              }}
            />
            <ActionButton
              label={t("disableHome")}
              disabled={working() || props.store.busy()}
              onPress={() => {
                void configure("disabled");
              }}
            />
          </View>
          <View class="gap-3 border-t border-border pt-3">
            <Text class="text-foreground text-base">{t("xiaomiHomeAccount")}</Text>
            <Text class="text-muted-foreground text-sm">{t("chooseTheSameRegionAsInThe")}</Text>
            <Select
              testID="home-miot-region"
              accessibilityLabel={t("xiaomiHomeRegion")}
              items={regions}
              value={region()}
              disabled={working() || props.store.busy()}
              onChange={(event) => {
                if (regions.some((item) => item.value === event.value)) region.set(event.value as HomeConfiguration["region"]);
              }}
              popupClass="bg-card rounded-xl border border-border"
              itemClass="min-h-12 px-4 text-foreground selected:bg-muted"
              trigger={<View class="min-h-12 justify-center rounded-xl border border-input bg-background px-4"><Text class="text-foreground text-base">{regions.find((item) => item.value === region())?.title}</Text></View>}
            />
            <ActionButton
              label={props.store.homeLoggingIn() ? t("waitingForXiaomiAuthorization") : savedMiotSelected() ? t("signInToXiaomiHomeAgain") : t("signInToXiaomiHome")}
              testID="home-miot-login"
              disabled={working() || props.store.busy()}
              onPress={() => { void login(); }}
            />
            <If when={props.store.homeLoggingIn()}>
              <ActionButton label={t("cancelXiaomiSignin")} testID="home-miot-cancel" onPress={() => props.store.cancelHomeLogin()} />
            </If>
            <If when={savedMiotSelected()}>
              <ActionButton label={props.store.homeConfiguration().mode === "direct_miot" ? t("refreshXiaomiDevices") : t("connectSavedXiaomiAccount")} testID="home-miot-refresh" disabled={working() || props.store.busy()} onPress={() => { void refreshMiot(); }} />
            </If>
            <If when={props.store.homeConfiguration().mode === "direct_miot" && savedMiotSelected()}>
              <ActionButton label={t("signOutOfXiaomiHome")} testID="home-miot-logout" disabled={working() || props.store.busy()} onPress={() => { void login(true); }} />
            </If>
          </View>
          <If when={translateMessage(error() || props.store.homeConnection()?.error || "")}>
            <Text role="alert" class="text-destructive text-sm">
              {translateMessage(error() || props.store.homeConnection()?.error || "")}
            </Text>
          </If>
          <If when={devices().length}>
            <Text class="text-muted-foreground text-sm">
              {t("devicePreviewAskInChatToFind")}</Text>
            <Each of={devices()} key={(item) => item.entity_id}>
              {(item) => (
                <View class="gap-1 border-b border-border pb-2">
                  <Text class="text-foreground text-base">
                    {item().friendly_name}
                  </Text>
                  <Text class="text-muted-foreground text-sm">
                    {item().entity_id} · {item().snapshot?.state ?? t("unknownState")}
                  </Text>
                </View>
              )}
            </Each>
          </If>
        </View>
      </View>
    </Panel>
  );
}
