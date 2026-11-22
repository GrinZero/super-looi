import {
  Clipboard,
  effect,
  openUrl,
  Scroll,
  signal,
  Text,
  View,
  windowSize,
} from "nsh";
import { Button } from "nsh/base";
import { t } from "../../../i18n";
import { ActionButton, SelectField, TextField } from "../../../ui/Controls";
import { PluginVectorIcon } from "../../../ui/plugins/PluginVectorIcon";
import type { PluginViewContext } from "../../../ui/plugins/ui-contracts";
import type { CodexPluginCommand, CodexPluginState } from "../contracts";

export function CodexSettingsView(props: {
  ctx: PluginViewContext<CodexPluginState, CodexPluginCommand>;
}) {
  const environment = signal("");
  const branch = signal("");
  const details = signal(false);
  const cloudLoading = signal(false);
  const updateAction = signal<"check_cli_update" | "install_cli_update" | undefined>(undefined);

  const wide = () => windowSize().width >= 600;
  const busy = () => props.ctx.busy();
  const enabled = () => props.ctx.enabled();
  const auth = () => props.ctx.auth();
  const authorizing = () => auth()?.state === "authorizing";
  const signedIn = () => auth()?.state === "signed_in";

  let syncedKey = "";
  let refreshedOnce = false;
  let requestedCatalog = false;
  const state = () => props.ctx.state();
  const catalog = () => state()?.cloudEnvironments;
  const selectedEnvironment = () => {
    const entries = catalog() ?? [];
    const exact = entries.find((entry) => entry.id === environment());
    if (exact) return exact;
    const matching = entries.filter((entry) => entry.name === environment());
    return matching.length === 1 ? matching[0] : undefined;
  };
  const loadCatalog = async () => {
    cloudLoading.set(true);
    try {
      await props.ctx.sendCommand({ type: "load_cloud_environments" });
    } finally {
      cloudLoading.set(false);
    }
  };
  const updateCli = async () => {
    const type = state()?.cliUpdateAvailable ? "install_cli_update" : "check_cli_update";
    updateAction.set(type);
    try {
      await props.ctx.sendCommand({ type });
    } finally {
      updateAction.set(undefined);
    }
  };
  const updateLabel = () => {
    if (updateAction() === "install_cli_update") return t("pluginCliInstalling");
    if (updateAction() === "check_cli_update") return t("pluginCliChecking");
    if (state()?.cliUpdateAvailable) return `${t("pluginCliInstall")} ${state()?.latestCliVersion}`;
    return t("pluginCliCheck");
  };

  effect(() => {
    const st = props.ctx.state();
    const cfg = props.ctx.configuration();
    const envVal = st?.environment ?? cfg.environment ?? "";
    const branchVal = st?.branch ?? cfg.branch ?? "";
    const nextKey = JSON.stringify([props.ctx.pluginId, envVal, branchVal]);
    if (syncedKey !== nextKey) {
      syncedKey = nextKey;
      environment.set(envVal);
      branch.set(branchVal);
    }
  });

  effect(() => {
    if (enabled() && !refreshedOnce) {
      refreshedOnce = true;
      void props.ctx.refresh();
    }
  });

  effect(() => {
    if (!enabled() || !signedIn()) {
      requestedCatalog = false;
      return;
    }
    if (!requestedCatalog && !busy()) {
      requestedCatalog = true;
      void loadCatalog();
    }
  });

  const statusDotClass = () => {
    if (!enabled()) return "w-2 h-2 rounded-full bg-subtle-text";
    const a = auth()?.state;
    if (a === "signed_in") return "w-2 h-2 rounded-full bg-verified";
    if (a === "authorizing") return "w-2 h-2 rounded-full bg-warning";
    if (a === "unavailable") return "w-2 h-2 rounded-full bg-destructive";
    return "w-2 h-2 rounded-full bg-subtle-text";
  };

  const statusLabel = () => {
    if (!enabled()) return t("pluginDisabled");
    if (authorizing()) return t("pluginAuthorizing");
    if (signedIn()) return t("pluginSignedIn");
    if (auth()?.state === "unavailable") return t("pluginAccountUnavailable");
    return t("pluginSignedOut");
  };

  const catalogFailure = () => props.ctx.lastError()?.stage.startsWith("cloud.directory") ?? false;
  const catalogLoginExpired = () => catalogFailure() && props.ctx.lastError()?.code === 401 && !catalog()?.length;
  const diagnosticError = () => {
    const failure = props.ctx.lastError();
    return failure
      ? `[stage=${failure.stage}${failure.code === undefined ? "" : ` code=${failure.code}`}] ${failure.reason}`
      : props.ctx.uiError();
  };

  const executionSummary = () => {
    const exec = props.ctx.lastExecution();
    if (exec) {
      if (exec.stage === "codex.account" && exec.state === "exited") {
        return t("pluginRecentAccountUpdated");
      }
      return `${t("pluginRecentStagePrefix")}${exec.stage} (${exec.state})`;
    }
    if (signedIn()) {
      return t("pluginRecentAccountUpdated");
    }
    return t("pluginRecentNoRecord");
  };

  return (
    <View
      class={
        wide()
          ? "flex-1 min-h-0 flex-row gap-3.5"
          : "flex-1 min-h-0 gap-3"
      }
    >
      {/* Left Card: Account Connection + Available Capabilities */}
      <View class="flex-1 min-w-0 min-h-0 rounded-2xl border border-border bg-card overflow-hidden">
        <Scroll class="flex-1 min-h-0" contentClass="p-3.5 gap-3">
          {/* Section 1: Account Connection */}
          <View class="gap-2.5">
            <View class="flex-row items-center justify-between gap-2">
              <Text class="text-foreground text-sm font-bold" role="header">
                {t("pluginAccountSection")}
              </Text>
            </View>

            <View class="flex-row items-center justify-between gap-3">
              <View class="flex-row items-center gap-2.5 flex-1 min-w-0">
                <View class="w-10 h-10 rounded-xl bg-muted border border-border items-center justify-center shrink-0">
                  <PluginVectorIcon name="user" tone="foreground" size={18} />
                </View>
                <View class="flex-1 min-w-0 gap-0.5">
                  <Text
                    class="text-foreground text-sm font-semibold"
                    style={{ numberOfLines: 1 }}
                  >
                    {t("pluginChatGptAccount")}
                  </Text>
                  <View class="flex-row items-center gap-1.5">
                    <View class={statusDotClass()} />
                    <Text
                      testID="plugin-account-state"
                      class="text-muted-foreground text-xs font-medium"
                      style={{ numberOfLines: 1 }}
                    >
                      {statusLabel()}
                    </Text>
                  </View>
                </View>
              </View>

              <View class="shrink-0">
                <If when={!signedIn() && !authorizing()}>
                  <ActionButton
                    testID="plugin-login"
                    compact
                    label={t("pluginSignIn")}
                    kind="primary"
                    disabled={busy() || !enabled()}
                    onPress={() => {
                      void props.ctx.beginLogin();
                    }}
                  />
                </If>
                <If when={authorizing()}>
                  <ActionButton
                    testID="plugin-cancel-login"
                    compact
                    label={t("pluginCancel")}
                    disabled={busy()}
                    onPress={() => {
                      void props.ctx.cancelLogin();
                    }}
                  />
                </If>
                <If when={signedIn()}>
                  <ActionButton
                    testID="plugin-logout"
                    compact
                    label={t("pluginSignOut")}
                    disabled={busy()}
                    onPress={() => {
                      void props.ctx.logout();
                    }}
                  />
                </If>
              </View>
            </View>

            <Text class="text-muted-foreground text-xs">
              {t("codexPluginDescription")}
            </Text>

            <View class="flex-row flex-wrap items-center gap-2">
              <Button
                testID="plugin-refresh"
                disabled={busy() || authorizing() || !enabled()}
                onPress={() => {
                  void props.ctx.refresh();
                }}
                class="min-h-11 px-3.5 rounded-full border border-border bg-background flex-row items-center gap-1.5 active:bg-muted focus:border-ring disabled:opacity-35"
              >
                <PluginVectorIcon name="refresh" tone="foreground" size={14} />
                <Text class="text-foreground text-xs font-medium">
                  {t("pluginRefresh")}
                </Text>
              </Button>

              <If when={authorizing() && Boolean(auth()?.url)}>
                <ActionButton
                  compact
                  label={t("pluginOpenSignIn")}
                  onPress={() => {
                    const url = auth()?.url;
                    if (!url) return;
                    void openUrl(url).catch((error) =>
                      props.ctx.notify(String(error)),
                    );
                  }}
                />
                <ActionButton
                  compact
                  label={t("copyLink")}
                  onPress={() => {
                    const url = auth()?.url;
                    if (!url) return;
                    void Clipboard.writeText(url).catch((error) =>
                      props.ctx.notify(String(error)),
                    );
                  }}
                />
              </If>
            </View>

            <If when={authorizing() && Boolean(auth()?.url)}>
              <Text class="text-muted-foreground text-xs">
                {t("pluginContinueInBrowser")}
              </Text>
            </If>

            <If when={Boolean(state()?.cliVersion)}>
              <View class="border-t border-border pt-2.5 flex-row flex-wrap items-center justify-between gap-2">
                <View class="gap-0.5">
                  <Text testID="plugin-cli-version" class="text-foreground text-xs font-mono">
                    Codex CLI {state()?.cliVersion}
                  </Text>
                  <If when={Boolean(state()?.latestCliVersion && !state()?.cliUpdateAvailable)}>
                    <Text class="text-muted-foreground text-xs">{t("pluginCliUpToDate")}</Text>
                  </If>
                </View>
                <ActionButton
                  testID="plugin-cli-update"
                  compact
                  label={updateLabel()}
                  disabled={busy() || authorizing() || !enabled()}
                  onPress={() => { void updateCli(); }}
                />
              </View>
            </If>

            <If when={!catalogFailure() && Boolean(diagnosticError())}>
              <View class="rounded-xl bg-muted border border-destructive px-3 py-2">
                <Text testID="plugin-error" class="text-destructive text-xs">
                  {diagnosticError()}
                </Text>
              </View>
            </If>
          </View>

          <View class="h-px bg-border" />

          {/* Section 2: Available Capabilities */}
          <View class="gap-2.5">
            <Text class="text-foreground text-sm font-bold" role="header">
              {t("pluginAgentTools")}
            </Text>

            <View class="flex-row items-center gap-2.5">
              <View class="w-9 h-9 rounded-xl bg-muted border border-border items-center justify-center shrink-0">
                <PluginVectorIcon name="terminal" tone="foreground" size={16} />
              </View>
              <View class="flex-1 min-w-0 gap-0.5">
                <Text class="text-foreground text-xs font-semibold">
                  {t("pluginExecTitle")}
                </Text>
                <Text class="text-muted-foreground text-xs">
                  {t("pluginExecDescription")}
                </Text>
              </View>
            </View>

            <View class="flex-row items-center gap-2.5">
              <View class="w-9 h-9 rounded-xl bg-muted border border-border items-center justify-center shrink-0">
                <PluginVectorIcon name="cloud" tone="foreground" size={16} />
              </View>
              <View class="flex-1 min-w-0 gap-0.5">
                <Text class="text-foreground text-xs font-semibold">
                  {t("pluginCloudTitle")}
                </Text>
                <Text class="text-muted-foreground text-xs">
                  {t("pluginCloudDescription")}
                </Text>
              </View>
            </View>
          </View>
        </Scroll>
      </View>

      {/* Right Card: Cloud Defaults + Execution Details */}
      <View class="flex-1 min-w-0 min-h-0 rounded-2xl border border-border bg-card overflow-hidden">
        <Scroll class="flex-1 min-h-0" contentClass="p-3.5 gap-3">
          {/* Section 1: Cloud Defaults */}
          <View class="gap-2.5">
            <View class="gap-0.5">
              <Text class="text-foreground text-sm font-bold" role="header">
                {t("pluginCloudDefaults")}
              </Text>
              <Text class="text-muted-foreground text-xs">
                {t("pluginCloudDefaultsHint")}
              </Text>
            </View>

            <If when={!signedIn()}>
              <Text class="text-muted-foreground text-xs">{t("pluginCloudSignIn")}</Text>
            </If>
            <If when={signedIn()}>
              <If when={cloudLoading()}>
                <Text class="text-muted-foreground text-xs">{t("pluginCloudLoading")}</Text>
              </If>
              <If when={!cloudLoading() && catalogFailure()}>
                <Text testID="plugin-cloud-error" class="text-destructive text-xs">{diagnosticError()}</Text>
              </If>
              <If when={!cloudLoading() && !catalogFailure() && catalog()?.length === 0}>
                <Text class="text-muted-foreground text-xs">{t("pluginCloudEmpty")}</Text>
              </If>
              <If when={Boolean(catalog()?.length)}>
                <SelectField
                  testID="plugin-environment"
                  compact
                  label={t("pluginEnvironment")}
                  items={[
                    { value: "", title: t("pluginChooseEnvironment"), disabled: true },
                    ...(catalog() ?? []).map((entry) => ({
                      value: entry.id,
                      title: entry.name,
                      group: t(entry.scope === "legacy" ? "pluginCloudLegacy" : entry.scope === "workspace" ? "pluginCloudWorkspace" : "pluginCloudPersonal"),
                    })),
                  ]}
                  value={selectedEnvironment()?.id ?? ""}
                  disabled={busy()}
                  onChange={(value) => {
                    if (selectedEnvironment()?.id !== value) branch.set("");
                    environment.set(value);
                  }}
                />
              </If>

              <If when={selectedEnvironment()?.scope === "legacy"}>
                <TextField
                  testID="plugin-branch"
                  compact
                  label={t("pluginBranch")}
                  value={branch()}
                  onChange={branch.set}
                  placeholder={t("pluginBranchCliDefault")}
                />
              </If>
              <If when={Boolean(selectedEnvironment() && selectedEnvironment()?.scope !== "legacy")}>
                <Text class="text-muted-foreground text-xs">{t("pluginCloudSavedBranch")}</Text>
                <If when={Boolean(state()?.currentCloudSubmitUnsupported)}>
                  <Text testID="plugin-cloud-compatibility" class="text-foreground text-xs font-medium">{t("pluginCloudCurrentUnavailable")}</Text>
                </If>
              </If>

              <View class="flex-row flex-wrap justify-between gap-2 pt-0.5">
                <ActionButton
                  testID="plugin-cloud-refresh"
                  compact
                  label={t(catalogLoginExpired() ? "pluginSignInAgain" : "pluginCloudRefresh")}
                  disabled={busy()}
                  onPress={() => {
                    if (catalogLoginExpired()) void props.ctx.beginLogin();
                    else void loadCatalog();
                  }}
                />
                <If when={Boolean(catalog()?.length)}>
                  <ActionButton
                    testID="plugin-save"
                    compact
                    kind="primary"
                    label={t("pluginSave")}
                    disabled={busy() || !selectedEnvironment()}
                    onPress={() => {
                      const selected = selectedEnvironment();
                      if (!selected) return;
                      void props.ctx.configure({
                        environment: selected.id,
                        branch: selected.scope === "legacy" ? branch() : "",
                      }).then(() => {
                        if (!props.ctx.uiError()) props.ctx.notify(t("pluginSettingsSaved"));
                      });
                    }}
                  />
                </If>
              </View>
            </If>
          </View>

          <View class="h-px bg-border" />

          {/* Section 2: Execution Details */}
          <View class="gap-2">
            <Button
              testID="plugin-execution-details"
              onPress={() => details.set(!details())}
              class="min-h-11 rounded-xl px-2 -mx-2 py-1 flex-row items-center justify-between gap-2 active:bg-muted focus:border-ring"
            >
              <View class="flex-1 min-w-0 gap-0.5">
                <Text class="text-foreground text-sm font-bold">
                  {t("pluginExecutionDetails")}
                </Text>
                <Text
                  class="text-muted-foreground text-xs"
                  style={{ numberOfLines: 1 }}
                >
                  {executionSummary()}
                </Text>
              </View>
              <PluginVectorIcon
                name={details() ? "chevron_down" : "chevron_right"}
                tone="muted"
                size={16}
              />
            </Button>

            <If when={details() && Boolean(props.ctx.lastExecution())}>
              <View class="rounded-xl bg-muted border border-border p-2.5">
                <Text
                  testID="plugin-execution-output"
                  class="text-muted-foreground text-xs font-mono"
                >
                  {JSON.stringify(props.ctx.lastExecution(), null, 2)}
                </Text>
              </View>
            </If>
          </View>
        </Scroll>
      </View>
    </View>
  );
}
