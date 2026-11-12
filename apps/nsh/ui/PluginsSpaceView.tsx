import { effect, signal, Text, View, Scroll, openUrl, Clipboard } from "nsh";
import { Button } from "nsh/base";
import { t } from "../i18n";
import type { createAppStore } from "../store";
import { ActionButton, TextField, SwitchRow } from "./Controls";

/** Settings stay in the runtime; this surface owns selection and editable drafts. */
export function PluginsSpaceView(props: { store: ReturnType<typeof createAppStore> }) {
  const selectedId = signal("codex");
  const environment = signal("");
  const branch = signal("");
  const details = signal(false);
  const plugin = () => props.store.plugins().find(item => item.id === selectedId());
  const busy = () => props.store.pluginBusy() === selectedId();
  const authorizing = () => plugin()?.auth?.state === "authorizing";
  const signedIn = () => plugin()?.auth?.state === "signed_in";
  let configurationKey = "";
  let checked = false;
  effect(() => {
    const item = plugin();
    if (!item) return;
    const nextKey = JSON.stringify([item.id, item.configuration]);
    if (configurationKey !== nextKey) {
      configurationKey = nextKey;
      environment.set(item.configuration.environment ?? "");
      branch.set(item.configuration.branch ?? "");
    }
  });
  effect(() => {
    if (props.store.activeSpace() === "plugins" && plugin() && !checked) {
      checked = true;
      void props.store.refreshPlugin(selectedId());
    }
  });
  const status = () => !plugin()?.enabled ? t("pluginDisabled") : authorizing() ? t("pluginAuthorizing") : signedIn() ? t("pluginSignedIn") : plugin()?.auth?.state === "unavailable" ? t("pluginAccountUnavailable") : t("pluginSignedOut");
  return (
    <View class="flex-1 min-h-0 p-4">
      <View class="flex-1 min-h-0 flex-row items-start gap-4">
        <View class="w-48 shrink-0 gap-2">
          <Each of={props.store.plugins()} key={item => item.id}>
            {item => (
              <Button testID={`plugin-${item().id}`} selected={selectedId() === item().id} onPress={() => selectedId.set(item().id)} class={selectedId() === item().id ? "min-h-20 p-4 rounded-2xl border border-primary bg-accent gap-2 items-start active:opacity-75" : "min-h-20 p-4 rounded-2xl border border-border bg-card gap-2 items-start active:opacity-75"}>
                <Text class="text-foreground text-base font-semibold">{item().name}</Text>
                <Text class="text-muted-foreground text-xs">{item().enabled ? t("pluginEnabled") : t("pluginDisabled")}</Text>
              </Button>
            )}
          </Each>
          <Text class="text-muted-foreground text-xs px-1">{t("pluginsDescription")}</Text>
        </View>
        <Scroll class="flex-1 min-w-0 min-h-0 h-full" contentClass="gap-4 pb-4">
          <If when={Boolean(plugin())}>
            <View class="rounded-2xl border border-border bg-card p-4 gap-3">
              <View class="flex-row items-center justify-between gap-3">
                <View class="flex-1 min-w-0 gap-1">
                  <Text class="text-foreground text-lg font-semibold">{plugin()?.name}</Text>
                  <Text testID="plugin-account-state" class="text-muted-foreground text-sm">{status()}</Text>
                </View>
                <SwitchRow testID="plugin-enabled" label={t("pluginEnabled")} checked={plugin()?.enabled ?? false} disabled={busy()} onChange={value => { void props.store.setPluginEnabled(selectedId(), value); }} />
              </View>
              <Text class="text-muted-foreground text-sm">{t("codexPluginDescription")}</Text>
              <If when={Boolean(plugin()?.version)}><Text class="text-muted-foreground text-xs">Codex CLI {plugin()?.version}</Text></If>
              <View class="flex-row flex-wrap gap-2">
                <If when={!signedIn() && !authorizing()}><ActionButton testID="plugin-login" compact label={t("pluginSignIn")} kind="primary" disabled={busy() || !plugin()?.enabled} onPress={() => { void props.store.beginPluginLogin(selectedId()); }} /></If>
                <If when={authorizing()}><ActionButton testID="plugin-cancel-login" compact label={t("pluginCancel")} disabled={busy()} onPress={() => { void props.store.cancelPluginLogin(selectedId()); }} /></If>
                <If when={signedIn()}><ActionButton testID="plugin-logout" compact label={t("pluginSignOut")} disabled={busy()} onPress={() => { void props.store.logoutPlugin(selectedId()); }} /></If>
                <ActionButton testID="plugin-refresh" compact label={t("pluginRefresh")} disabled={busy() || authorizing() || !plugin()?.enabled} onPress={() => { void props.store.refreshPlugin(selectedId()); }} />
              </View>
              <If when={authorizing() && Boolean(plugin()?.auth?.url)}>
                <Text class="text-muted-foreground text-sm">{t("pluginContinueInBrowser")}</Text>
                <View class="flex-row gap-2">
                  <ActionButton compact label={t("pluginOpenSignIn")} onPress={() => { void openUrl(plugin()!.auth!.url!).catch(error => props.store.notify(String(error))); }} />
                  <ActionButton compact label={t("copyLink")} onPress={() => { void Clipboard.writeText(plugin()!.auth!.url!).catch(error => props.store.notify(String(error))); }} />
                </View>
              </If>
              <If when={Boolean(props.store.pluginUiError() || plugin()?.lastError)}>
                <Text testID="plugin-error" class="text-destructive text-sm">{props.store.pluginUiError() || `${plugin()?.lastError?.stage}: ${plugin()?.lastError?.reason}`}</Text>
              </If>
            </View>
            <View class="rounded-2xl border border-border bg-card p-4 gap-3">
              <Text class="text-foreground text-sm font-semibold">{t("pluginCloudDefaults")}</Text>
              <View class="flex-row gap-3">
                <View class="flex-1 min-w-0"><TextField testID="plugin-environment" compact label={t("pluginEnvironment")} value={environment()} onChange={environment.set} placeholder="video2rig" /></View>
                <View class="flex-1 min-w-0"><TextField testID="plugin-branch" compact label={t("pluginBranch")} value={branch()} onChange={branch.set} placeholder="main" /></View>
              </View>
              <View class="flex-row justify-end"><ActionButton testID="plugin-save" compact label={t("pluginSave")} disabled={busy()} onPress={() => { void props.store.configurePlugin(selectedId(), { environment: environment(), branch: branch() }); }} /></View>
            </View>
            <View class="gap-2 px-1">
              <Text class="text-foreground text-sm font-semibold">{t("pluginAgentTools")}</Text>
              <Text class="text-muted-foreground text-sm">{t("pluginExecDescription")}</Text>
              <Text class="text-muted-foreground text-sm">{t("pluginCloudDescription")}</Text>
            </View>
            <If when={Boolean(plugin()?.lastExecution)}>
              <ActionButton testID="plugin-execution-details" compact label={t("pluginExecutionDetails")} onPress={() => details.set(!details())} />
              <If when={details()}><Text testID="plugin-execution-output" class="text-muted-foreground text-xs">{JSON.stringify(plugin()?.lastExecution, null, 2)}</Text></If>
            </If>
          </If>
        </Scroll>
      </View>
    </View>
  );
}
