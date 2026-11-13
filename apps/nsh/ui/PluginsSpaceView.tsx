import {
  Canvas,
  Clipboard,
  effect,
  openUrl,
  Scroll,
  signal,
  Text,
  token,
  View,
  windowSize,
} from "nsh";
import { Button, Input, Switch } from "nsh/base";
import { t } from "../i18n";
import type { createAppStore } from "../store";
import { ActionButton, TextField } from "./Controls";

type PluginIconName =
  | "code"
  | "search"
  | "user"
  | "terminal"
  | "cloud"
  | "refresh"
  | "chevron_left"
  | "chevron_right"
  | "chevron_down";

type PluginIconTone = "foreground" | "primaryFg" | "muted";

function resolvePluginIconColor(tone: PluginIconTone): string {
  switch (tone) {
    case "primaryFg":
      return token("primary-foreground");
    case "muted":
      return token("muted-foreground");
    case "foreground":
    default:
      return token("foreground");
  }
}

function PluginVectorIcon(props: {
  name: PluginIconName;
  tone?: PluginIconTone;
  size?: number;
}) {
  const iconSize = () => props.size ?? 18;
  return (
    <Canvas
      style={{
        width: iconSize(),
        height: iconSize(),
        pointerEvents: "none",
      }}
      draw={(cx, canvasSize) => {
        const w = canvasSize.width || iconSize();
        const h = canvasSize.height || iconSize();
        const color = resolvePluginIconColor(props.tone ?? "foreground");

        cx.save();
        cx.scale(w / 24, h / 24);
        cx.strokeStyle = color;
        cx.fillStyle = color;
        cx.lineWidth = 2;
        cx.lineCap = "round";
        cx.lineJoin = "round";

        switch (props.name) {
          case "code": {
            cx.beginPath();
            cx.moveTo(8.5, 8.2);
            cx.lineTo(4.5, 12);
            cx.lineTo(8.5, 15.8);
            cx.moveTo(15.5, 8.2);
            cx.lineTo(19.5, 12);
            cx.lineTo(15.5, 15.8);
            cx.moveTo(13.4, 7.2);
            cx.lineTo(10.6, 16.8);
            cx.stroke();
            break;
          }
          case "search": {
            cx.beginPath();
            cx.arc(10.8, 10.8, 5.8, 0, Math.PI * 2);
            cx.stroke();
            cx.beginPath();
            cx.moveTo(15.2, 15.2);
            cx.lineTo(19.5, 19.5);
            cx.stroke();
            break;
          }
          case "user": {
            cx.beginPath();
            cx.arc(12, 8.2, 3.4, 0, Math.PI * 2);
            cx.stroke();
            cx.beginPath();
            cx.arc(12, 20.2, 6.2, Math.PI * 1.15, Math.PI * 1.85);
            cx.stroke();
            break;
          }
          case "terminal": {
            cx.beginPath();
            cx.moveTo(5.5, 8);
            cx.lineTo(10.2, 12);
            cx.lineTo(5.5, 16);
            cx.moveTo(12.2, 16);
            cx.lineTo(18.5, 16);
            cx.stroke();
            break;
          }
          case "cloud": {
            cx.beginPath();
            cx.moveTo(6.8, 18);
            cx.lineTo(17.2, 18);
            cx.arc(17.2, 14.3, 3.7, Math.PI * 0.5, Math.PI * 1.5, true);
            cx.arc(12.4, 10.8, 4.8, Math.PI * 1.88, Math.PI * 1.08, true);
            cx.arc(6.8, 14.6, 3.4, Math.PI * 1.5, Math.PI * 0.5, true);
            cx.closePath();
            cx.stroke();
            break;
          }
          case "refresh": {
            cx.beginPath();
            cx.arc(12, 12, 6.8, -Math.PI * 0.78, Math.PI * 0.65);
            cx.stroke();
            cx.beginPath();
            cx.moveTo(15.8, 4.2);
            cx.lineTo(18.6, 7.2);
            cx.lineTo(14.8, 8.2);
            cx.stroke();
            break;
          }
          case "chevron_left": {
            cx.beginPath();
            cx.moveTo(14.5, 6);
            cx.lineTo(8.5, 12);
            cx.lineTo(14.5, 18);
            cx.stroke();
            break;
          }
          case "chevron_right": {
            cx.beginPath();
            cx.moveTo(9.5, 6);
            cx.lineTo(15.5, 12);
            cx.lineTo(9.5, 18);
            cx.stroke();
            break;
          }
          case "chevron_down": {
            cx.beginPath();
            cx.moveTo(6, 9.5);
            cx.lineTo(12, 15.5);
            cx.lineTo(18, 9.5);
            cx.stroke();
            break;
          }
        }
        cx.restore();
      }}
    />
  );
}

/** Top 48pt context bar for the Plugins space: switches between catalog title and detail breadcrumb + enable switch. */
export function PluginsContextBar(props: {
  store: ReturnType<typeof createAppStore>;
}) {
  const inspectedId = () => props.store.inspectedPluginId();
  const plugin = () =>
    props.store.plugins().find((item) => item.id === inspectedId());
  const busy = () =>
    Boolean(inspectedId()) && props.store.pluginBusy() === inspectedId();

  return (
    <If
      when={Boolean(inspectedId())}
      else={
        <View class="flex-1 min-w-0 h-11 flex-row items-center gap-2.5">
          <Text
            class="text-foreground text-base font-bold"
            style={{ numberOfLines: 1 }}
          >
            {t("plugins")}
          </Text>
          <Text
            class="text-muted-foreground text-xs flex-1"
            style={{ numberOfLines: 1 }}
          >
            {t("pluginsDescription")}
          </Text>
        </View>
      }
    >
      <View class="flex-1 min-w-0 h-11 flex-row items-center justify-between gap-3">
        <View class="flex-row items-center gap-2 min-w-0 flex-1">
          <Button
            testID="plugin-back-to-list"
            accessibilityLabel={t("pluginBackToList")}
            onPress={() => props.store.setInspectedPluginId(null)}
            class="min-h-11 px-2.5 -ml-1.5 rounded-xl flex-row items-center gap-1 active:bg-muted focus:border-ring"
          >
            <PluginVectorIcon name="chevron_left" tone="muted" size={16} />
            <Text class="text-muted-foreground text-sm font-medium">
              {t("pluginBackToList")}
            </Text>
          </Button>
          <View class="w-px h-4 bg-border" />
          <Text
            class="text-foreground text-base font-bold px-1"
            style={{ numberOfLines: 1 }}
          >
            {plugin()?.name ?? "Codex"}
          </Text>
        </View>

        <View class="flex-row items-center gap-2.5 shrink-0">
          <Text class="text-foreground text-xs font-medium">
            {t("pluginEnabled")}
          </Text>
          <Switch
            testID="plugin-enabled"
            accessibilityLabel={t("pluginEnabled")}
            checked={plugin()?.enabled ?? false}
            disabled={busy()}
            hitSlop={10}
            onChange={(ev) => {
              const id = inspectedId();
              if (id) {
                void props.store.setPluginEnabled(id, ev.checked);
              }
            }}
            class="min-h-11 flex-row items-center justify-center disabled:opacity-40"
            trackClass="w-11 h-6 rounded-full bg-border border border-border p-0.5 justify-center checked:bg-primary checked:border-primary"
            thumbClass="w-5 h-5 rounded-full bg-card checked:bg-primary-foreground checked:translate-x-5"
          />
        </View>
      </View>
    </If>
  );
}

/** Settings stay in the runtime; this surface owns catalog filtering, selection, and editable drafts. */
export function PluginsSpaceView(props: {
  store: ReturnType<typeof createAppStore>;
}) {
  const searchQuery = signal("");
  const category = signal<"all" | "dev">("all");
  const environment = signal("");
  const branch = signal("");
  const details = signal(false);

  const wide = () => windowSize().width >= 600;
  const activePluginId = () => props.store.inspectedPluginId() ?? "codex";
  const plugin = () =>
    props.store.plugins().find((item) => item.id === activePluginId());
  const busy = () => props.store.pluginBusy() === activePluginId();
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
      void props.store.refreshPlugin(activePluginId());
    }
  });

  const filteredPlugins = () => {
    const q = searchQuery().trim().toLowerCase();
    return props.store.plugins().filter((item) => {
      if (category() === "dev" && item.id !== "codex") return false;
      if (!q) return true;
      const haystack = `${item.name} ${item.description} ${t("codexSummary")} ${t("pluginExecTitle")} ${t("pluginCloudTitle")}`.toLowerCase();
      return haystack.includes(q);
    });
  };

  const cardStatusText = (item: ReturnType<typeof plugin>) => {
    if (!item?.enabled) return t("pluginDisabled");
    if (item.auth?.state === "authorizing") return t("pluginAuthorizing");
    if (item.auth?.state === "signed_in") return t("pluginConnected");
    if (item.auth?.state === "unavailable") return t("pluginAccountUnavailable");
    return t("pluginSignedOut");
  };

  const statusDotClass = (item: ReturnType<typeof plugin>) => {
    if (!item?.enabled) return "w-2 h-2 rounded-full bg-subtle-text";
    if (item.auth?.state === "signed_in") return "w-2 h-2 rounded-full bg-verified";
    if (item.auth?.state === "authorizing") return "w-2 h-2 rounded-full bg-warning";
    if (item.auth?.state === "unavailable") return "w-2 h-2 rounded-full bg-destructive";
    return "w-2 h-2 rounded-full bg-subtle-text";
  };

  const status = () =>
    !plugin()?.enabled
      ? t("pluginDisabled")
      : authorizing()
        ? t("pluginAuthorizing")
        : signedIn()
          ? t("pluginSignedIn")
          : plugin()?.auth?.state === "unavailable"
            ? t("pluginAccountUnavailable")
            : t("pluginSignedOut");

  const executionSummary = () => {
    const exec = plugin()?.lastExecution;
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
    <If
      when={Boolean(props.store.inspectedPluginId())}
      else={
        /* View 1: Plugins Directory / List View */
        <View class="flex-1 min-h-0 gap-3">
          {/* Search bar */}
          <View class="h-11 rounded-2xl border border-border bg-card px-3.5 flex-row items-center gap-2.5">
            <PluginVectorIcon name="search" tone="muted" size={17} />
            <Input
              testID="plugin-search"
              value={searchQuery()}
              onChange={(e) => searchQuery.set(e.value)}
              placeholder={t("pluginSearchPlaceholder")}
              autoCorrect={false}
              autoCapitalize="none"
              maxLength={256}
              class="flex-1 h-11 text-foreground text-sm"
            />
            <If when={Boolean(searchQuery().trim())}>
              <Button
                testID="plugin-search-clear"
                hitSlop={4}
                onPress={() => searchQuery.set("")}
                class="min-h-9 px-2.5 rounded-lg bg-muted items-center justify-center active:opacity-75"
              >
                <Text class="text-muted-foreground text-xs font-medium">
                  {t("pluginClearSearch")}
                </Text>
              </Button>
            </If>
          </View>

          {/* Category filter pills */}
          <View class="flex-row items-center gap-2">
            <Button
              testID="plugin-category-all"
              selected={category() === "all"}
              hitSlop={4}
              onPress={() => category.set("all")}
              class={
                category() === "all"
                  ? "min-h-9 px-4 rounded-full bg-primary border border-transparent items-center justify-center active:opacity-75"
                  : "min-h-9 px-4 rounded-full bg-muted border border-border items-center justify-center active:opacity-75"
              }
            >
              <Text
                class={
                  category() === "all"
                    ? "text-primary-foreground text-xs font-semibold"
                    : "text-muted-foreground text-xs font-medium"
                }
              >
                {t("pluginCategoryAll")}
              </Text>
            </Button>

            <Button
              testID="plugin-category-dev"
              selected={category() === "dev"}
              hitSlop={4}
              onPress={() => category.set("dev")}
              class={
                category() === "dev"
                  ? "min-h-9 px-4 rounded-full bg-primary border border-transparent items-center justify-center active:opacity-75"
                  : "min-h-9 px-4 rounded-full bg-muted border border-border items-center justify-center active:opacity-75"
              }
            >
              <Text
                class={
                  category() === "dev"
                    ? "text-primary-foreground text-xs font-semibold"
                    : "text-muted-foreground text-xs font-medium"
                }
              >
                {t("pluginCategoryDev")}
              </Text>
            </Button>
          </View>

          {/* Plugin cards grid */}
          <Scroll
            class="flex-1 min-h-0"
            contentClass="gap-3 pb-2"
          >
            <If
              when={filteredPlugins().length > 0}
              else={
                <View class="rounded-2xl border border-border bg-card p-6 items-center justify-center gap-2">
                  <Text class="text-muted-foreground text-sm">
                    {t("pluginNoMatch")}
                  </Text>
                </View>
              }
            >
              <View
                class={
                  wide()
                    ? "flex-row flex-wrap gap-3.5 items-stretch"
                    : "gap-3"
                }
              >
                <Each of={filteredPlugins()} key={(item) => item.id}>
                  {(item) => (
                    <Button
                      testID={`plugin-${item().id}`}
                      onPress={() => props.store.setInspectedPluginId(item().id)}
                      class="rounded-2xl border border-border bg-card p-4 gap-3 items-stretch justify-between active:bg-muted focus:border-ring"
                      style={
                        wide()
                          ? { width: "32%", minWidth: 220 }
                          : undefined
                      }
                    >
                      <View class="flex-row items-center justify-between gap-2.5">
                        <View class="flex-row items-center gap-3 flex-1 min-w-0">
                          <View class="w-10 h-10 rounded-xl bg-primary items-center justify-center shrink-0">
                            <PluginVectorIcon
                              name="code"
                              tone="primaryFg"
                              size={20}
                            />
                          </View>
                          <View class="flex-1 min-w-0 gap-0.5">
                            <Text
                              class="text-foreground text-base font-bold"
                              style={{ numberOfLines: 1 }}
                            >
                              {item().name}
                            </Text>
                            <If when={Boolean(item().version)}>
                              <Text
                                class="text-subtle-text text-xs font-mono"
                                style={{ numberOfLines: 1 }}
                              >
                                CLI {item().version}
                              </Text>
                            </If>
                          </View>
                        </View>
                        <PluginVectorIcon
                          name="chevron_right"
                          tone="muted"
                          size={16}
                        />
                      </View>

                      <Text
                        class="text-muted-foreground text-xs"
                        style={{ numberOfLines: 2 }}
                      >
                        {t("codexSummary")}
                      </Text>

                      <View class="flex-row items-center justify-between gap-2 pt-0.5">
                        <View class="flex-row items-center gap-1.5">
                          <View class={statusDotClass(item())} />
                          <Text class="text-muted-foreground text-xs font-medium">
                            {cardStatusText(item())}
                          </Text>
                        </View>
                        <If when={Boolean(item().configuration?.environment)}>
                          <Text
                            class="text-subtle-text text-xs font-mono"
                            style={{ numberOfLines: 1 }}
                          >
                            {item().configuration.environment}
                          </Text>
                        </If>
                      </View>
                    </Button>
                  )}
                </Each>
              </View>
            </If>
          </Scroll>
        </View>
      }
    >
      {/* View 2: Plugin Detail View */}
      <If when={Boolean(plugin())}>
        <View class="flex-1 min-h-0 gap-2.5">
          {/* Top Plugin Identity Header */}
          <View class="flex-row items-center justify-between gap-3 px-0.5">
            <View class="flex-row items-center gap-3 flex-1 min-w-0">
              <View class="w-10 h-10 rounded-xl bg-primary items-center justify-center shrink-0">
                <PluginVectorIcon name="code" tone="primaryFg" size={20} />
              </View>
              <View class="flex-1 min-w-0 gap-0.5">
                <View class="flex-row items-center gap-2">
                  <Text
                    class="text-foreground text-base font-bold"
                    style={{ numberOfLines: 1 }}
                  >
                    {plugin()?.name}
                  </Text>
                  <If when={Boolean(plugin()?.version)}>
                    <View class="px-2 py-0.5 rounded-md bg-muted border border-border">
                      <Text class="text-muted-foreground text-xs font-mono">
                        Codex CLI {plugin()?.version}
                      </Text>
                    </View>
                  </If>
                </View>
                <Text
                  class="text-muted-foreground text-xs"
                  style={{ numberOfLines: 1 }}
                >
                  {t("codexSummary")}
                </Text>
              </View>
            </View>
          </View>

          {/* Balanced Two-Column Cards */}
          <View
            class={
              wide()
                ? "flex-1 min-h-0 flex-row gap-3.5"
                : "flex-1 min-h-0 gap-3"
            }
          >
            {/* Left Card: Account Connection + Available Capabilities */}
            <View class="flex-1 min-w-0 min-h-0 rounded-2xl border border-border bg-card overflow-hidden">
              <Scroll
                class="flex-1 min-h-0"
                contentClass="p-3.5 gap-3"
              >
                {/* Section 1: Account Connection */}
                <View class="gap-2.5">
                  <Text
                    class="text-foreground text-sm font-bold"
                    role="header"
                  >
                    {t("pluginAccountSection")}
                  </Text>

                  <View class="flex-row items-center justify-between gap-3">
                    <View class="flex-row items-center gap-2.5 flex-1 min-w-0">
                      <View class="w-10 h-10 rounded-xl bg-muted border border-border items-center justify-center shrink-0">
                        <PluginVectorIcon
                          name="user"
                          tone="foreground"
                          size={18}
                        />
                      </View>
                      <View class="flex-1 min-w-0 gap-0.5">
                        <Text
                          class="text-foreground text-sm font-semibold"
                          style={{ numberOfLines: 1 }}
                        >
                          {t("pluginChatGptAccount")}
                        </Text>
                        <View class="flex-row items-center gap-1.5">
                          <View class={statusDotClass(plugin())} />
                          <Text
                            testID="plugin-account-state"
                            class="text-muted-foreground text-xs font-medium"
                            style={{ numberOfLines: 1 }}
                          >
                            {status()}
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
                          disabled={busy() || !plugin()?.enabled}
                          onPress={() => {
                            void props.store.beginPluginLogin(activePluginId());
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
                            void props.store.cancelPluginLogin(activePluginId());
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
                            void props.store.logoutPlugin(activePluginId());
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
                      disabled={busy() || authorizing() || !plugin()?.enabled}
                      onPress={() => {
                        void props.store.refreshPlugin(activePluginId());
                      }}
                      class="min-h-11 px-3.5 rounded-full border border-border bg-background flex-row items-center gap-1.5 active:bg-muted focus:border-ring disabled:opacity-35"
                    >
                      <PluginVectorIcon
                        name="refresh"
                        tone="foreground"
                        size={14}
                      />
                      <Text class="text-foreground text-xs font-medium">
                        {t("pluginRefresh")}
                      </Text>
                    </Button>

                    <If when={authorizing() && Boolean(plugin()?.auth?.url)}>
                      <ActionButton
                        compact
                        label={t("pluginOpenSignIn")}
                        onPress={() => {
                          void openUrl(plugin()!.auth!.url!).catch((error) =>
                            props.store.notify(String(error)),
                          );
                        }}
                      />
                      <ActionButton
                        compact
                        label={t("copyLink")}
                        onPress={() => {
                          void Clipboard.writeText(plugin()!.auth!.url!).catch(
                            (error) => props.store.notify(String(error)),
                          );
                        }}
                      />
                    </If>
                  </View>

                  <If when={authorizing() && Boolean(plugin()?.auth?.url)}>
                    <Text class="text-muted-foreground text-xs">
                      {t("pluginContinueInBrowser")}
                    </Text>
                  </If>

                  <If
                    when={Boolean(
                      props.store.pluginUiError() || plugin()?.lastError,
                    )}
                  >
                    <View class="rounded-xl bg-muted border border-destructive px-3 py-2">
                      <Text
                        testID="plugin-error"
                        class="text-destructive text-xs"
                      >
                        {props.store.pluginUiError() ||
                          `${plugin()?.lastError?.stage}: ${plugin()?.lastError?.reason}`}
                      </Text>
                    </View>
                  </If>
                </View>

                <View class="h-px bg-border" />

                {/* Section 2: Available Capabilities */}
                <View class="gap-2.5">
                  <Text
                    class="text-foreground text-sm font-bold"
                    role="header"
                  >
                    {t("pluginAgentTools")}
                  </Text>

                  <View class="flex-row items-center gap-2.5">
                    <View class="w-9 h-9 rounded-xl bg-muted border border-border items-center justify-center shrink-0">
                      <PluginVectorIcon
                        name="terminal"
                        tone="foreground"
                        size={16}
                      />
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
                      <PluginVectorIcon
                        name="cloud"
                        tone="foreground"
                        size={16}
                      />
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
              <Scroll
                class="flex-1 min-h-0"
                contentClass="p-3.5 gap-3"
              >
                {/* Section 1: Cloud Defaults */}
                <View class="gap-2.5">
                  <View class="gap-0.5">
                    <Text
                      class="text-foreground text-sm font-bold"
                      role="header"
                    >
                      {t("pluginCloudDefaults")}
                    </Text>
                    <Text class="text-muted-foreground text-xs">
                      {t("pluginCloudDefaultsHint")}
                    </Text>
                  </View>

                  <TextField
                    testID="plugin-environment"
                    compact
                    label={t("pluginEnvironment")}
                    value={environment()}
                    onChange={environment.set}
                    placeholder="video2rig"
                  />

                  <TextField
                    testID="plugin-branch"
                    compact
                    label={t("pluginBranch")}
                    value={branch()}
                    onChange={branch.set}
                    placeholder="main"
                  />

                  <View class="flex-row justify-end pt-0.5">
                    <ActionButton
                      testID="plugin-save"
                      compact
                      kind="primary"
                      label={t("pluginSave")}
                      disabled={busy()}
                      onPress={() => {
                        void props.store
                          .configurePlugin(activePluginId(), {
                            environment: environment(),
                            branch: branch(),
                          })
                          .then(() => {
                            if (!props.store.pluginUiError()) {
                              props.store.notify(t("pluginSettingsSaved"));
                            }
                          });
                      }}
                    />
                  </View>
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

                  <If when={details() && Boolean(plugin()?.lastExecution)}>
                    <View class="rounded-xl bg-muted border border-border p-2.5">
                      <Text
                        testID="plugin-execution-output"
                        class="text-muted-foreground text-xs font-mono"
                      >
                        {JSON.stringify(plugin()?.lastExecution, null, 2)}
                      </Text>
                    </View>
                  </If>
                </View>
              </Scroll>
            </View>
          </View>
        </View>
      </If>
    </If>
  );
}
