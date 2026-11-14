import {
  computed,
  ErrorBoundary,
  Scroll,
  signal,
  Text,
  View,
  windowSize,
} from "nsh";
import { Button, Input, Switch } from "nsh/base";
import { t } from "../i18n";
import type { PluginSnapshot } from "../generated/looi-runtime";
import {
  PLUGIN_CATEGORIES,
  type PluginCategory,
  type PluginDependencyStatus,
} from "../runtime/plugins/shared-types";
import type { createAppStore } from "../store";
import { ActionButton } from "./Controls";
import {
  normalizePluginIconName,
  PluginVectorIcon,
} from "./plugins/PluginVectorIcon";
import { getPluginUiModule } from "./plugins/registry";

function categoryLabel(cat: PluginCategory): string {
  switch (cat) {
    case "productivity":
      return t("pluginCategoryProductivity");
    case "vision_motion":
      return t("pluginCategoryVisionMotion");
    case "games_social":
      return t("pluginCategoryGamesSocial");
    case "persona_expression":
      return t("pluginCategoryPersonaExpression");
    case "smart_space":
      return t("pluginCategorySmartSpace");
    case "utilities":
      return t("pluginCategoryUtilities");
  }
}

function localizedPluginName(
  item: PluginSnapshot | undefined,
  locale: "zh-CN" | "en-US",
): string {
  if (!item) return "";
  return item.manifest?.name?.[locale] ?? item.name;
}

function localizedPluginSummary(
  item: PluginSnapshot | undefined,
  locale: "zh-CN" | "en-US",
): string {
  if (!item) return "";
  return item.manifest?.summary?.[locale] ?? item.description;
}

function cardStatusDotClass(item: PluginSnapshot | undefined): string {
  if (!item?.enabled) return "w-2 h-2 rounded-full bg-subtle-text";
  if (item.lifecycle === "waiting_dependency") {
    return "w-2 h-2 rounded-full bg-warning";
  }
  if (item.lifecycle === "failed") {
    return "w-2 h-2 rounded-full bg-destructive";
  }
  if (item.auth) {
    if (item.auth.state === "signed_in") return "w-2 h-2 rounded-full bg-verified";
    if (item.auth.state === "authorizing") return "w-2 h-2 rounded-full bg-warning";
    if (item.auth.state === "unavailable") return "w-2 h-2 rounded-full bg-destructive";
    return "w-2 h-2 rounded-full bg-subtle-text";
  }
  return "w-2 h-2 rounded-full bg-verified";
}

function cardStatusText(item: PluginSnapshot | undefined): string {
  if (!item?.enabled) return t("pluginDisabled");
  if (item.lifecycle === "waiting_dependency") {
    return t("pluginWaitingDependency");
  }
  if (item.lifecycle === "failed") {
    return t("pluginFailedState");
  }
  if (item.auth) {
    if (item.auth.state === "authorizing") return t("pluginAuthorizing");
    if (item.auth.state === "signed_in") return t("pluginConnected");
    if (item.auth.state === "unavailable") return t("pluginAccountUnavailable");
    return t("pluginSignedOut");
  }
  return t("pluginActive");
}

function dependencyHintText(
  dep: PluginDependencyStatus,
  locale: "zh-CN" | "en-US",
): string {
  if (dep.satisfied) return t("pluginDependencyReady");
  if (dep.reason?.startsWith("version_mismatch")) {
    return t("pluginDependencyVersionMismatch");
  }
  if (dep.optional) return t("pluginDependencyOptional");
  if (dep.reason === "provider_inactive" && dep.providerName) {
    return `${t("pluginDependencyProviderInactive")}${dep.providerName[locale]}`;
  }
  return t("pluginDependencyMissingProvider");
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
  const locale = () => props.store.effectiveLocale();

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
            {localizedPluginName(plugin(), locale())}
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

function PluginDetailPane(props: {
  pluginId: string;
  store: ReturnType<typeof createAppStore>;
}) {
  const locale = () => props.store.effectiveLocale();
  const plugin = () =>
    props.store.plugins().find((item) => item.id === props.pluginId);
  const customSettingsView = computed(
    () => getPluginUiModule(props.pluginId)?.SettingsView,
  );
  const viewCtx = props.store.pluginViewContext(props.pluginId);

  return (
    <If when={Boolean(plugin())}>
      <View class="flex-1 min-h-0 gap-2.5">
        {/* Top Plugin Identity Header */}
        <View class="flex-row items-center justify-between gap-3 px-0.5">
          <View class="flex-row items-center gap-3 flex-1 min-w-0">
            <View class="w-10 h-10 rounded-xl bg-primary items-center justify-center shrink-0">
              <PluginVectorIcon
                name={normalizePluginIconName(plugin()?.manifest?.icon)}
                tone="primaryFg"
                size={20}
              />
            </View>
            <View class="flex-1 min-w-0 gap-0.5">
              <View class="flex-row flex-wrap items-center gap-2">
                <Text
                  class="text-foreground text-base font-bold"
                  style={{ numberOfLines: 1 }}
                >
                  {localizedPluginName(plugin(), locale())}
                </Text>
                <View class="px-2 py-0.5 rounded-md bg-muted border border-border">
                  <Text class="text-muted-foreground text-xs font-mono">
                    v{plugin()?.version}
                  </Text>
                </View>
                <If when={Boolean(plugin()?.category)}>
                  <View class="px-2 py-0.5 rounded-md bg-muted border border-border">
                    <Text class="text-muted-foreground text-xs">
                      {categoryLabel(plugin()!.category)}
                    </Text>
                  </View>
                </If>
                <If when={(plugin()?.manifest?.provides?.length ?? 0) > 0}>
                  <Each
                    of={plugin()?.manifest?.provides ?? []}
                    key={(svc) => svc.id}
                  >
                    {(svc) => (
                      <View class="px-2 py-0.5 rounded-md bg-muted border border-border flex-row items-center gap-1">
                        <PluginVectorIcon name="link" tone="muted" size={12} />
                        <Text class="text-muted-foreground text-xs font-mono">
                          {svc().id}@{svc().version}
                        </Text>
                      </View>
                    )}
                  </Each>
                </If>
              </View>
              <Text
                class="text-muted-foreground text-xs"
                style={{ numberOfLines: 1 }}
              >
                {localizedPluginSummary(plugin(), locale())}
              </Text>
            </View>
          </View>
        </View>

        {/* Cross-Plugin Service Dependencies Banner (when plugin declares dependencies) */}
        <If when={(plugin()?.dependencies?.length ?? 0) > 0}>
          <View class="rounded-2xl border border-border bg-card px-3.5 py-2.5 gap-2">
            <Text class="text-foreground text-xs font-bold" role="header">
              {t("pluginDependenciesSection")}
            </Text>
            <View class="flex-row flex-wrap items-center gap-2">
              <Each
                of={plugin()?.dependencies ?? []}
                key={(dep) => dep.service}
              >
                {(dep) => (
                  <Button
                    disabled={!dep().providerPluginId}
                    onPress={() => {
                      const targetId = dep().providerPluginId;
                      if (targetId) {
                        props.store.setInspectedPluginId(targetId);
                      }
                    }}
                    class="min-h-11 px-3 rounded-xl bg-muted border border-border flex-row items-center gap-2 active:opacity-75 disabled:opacity-100"
                  >
                    <View
                      class={
                        dep().satisfied
                          ? "w-2 h-2 rounded-full bg-verified"
                          : dep().optional
                            ? "w-2 h-2 rounded-full bg-subtle-text"
                            : "w-2 h-2 rounded-full bg-warning"
                      }
                    />
                    <Text class="text-foreground text-xs font-mono">
                      {dep().service} ({dep().versionRange})
                    </Text>
                    <Text class="text-muted-foreground text-xs">
                      {dependencyHintText(dep(), locale())}
                    </Text>
                  </Button>
                )}
              </Each>
            </View>
          </View>
        </If>

        {/* Error-Boundary-Isolated Plugin Custom SettingsView */}
        <ErrorBoundary
          fallback={(error, reset) => (
            <View
              testID="plugin-view-error-boundary"
              class="flex-1 min-h-0 rounded-2xl border border-destructive bg-card p-5 items-center justify-center gap-3"
            >
              <PluginVectorIcon name="alert" tone="destructive" size={24} />
              <Text class="text-foreground text-sm font-bold">
                {t("pluginViewCrashedTitle")}
              </Text>
              <Text class="text-destructive text-xs font-mono">
                {error instanceof Error ? error.message : String(error)}
              </Text>
              <ActionButton
                testID="plugin-view-retry"
                compact
                label={t("pluginViewRetry")}
                onPress={reset}
              />
            </View>
          )}
        >
          <If
            when={Boolean(customSettingsView())}
            else={
              <View class="flex-1 min-h-0 rounded-2xl border border-border bg-card p-5 items-center justify-center gap-2">
                <Text class="text-muted-foreground text-sm">
                  {t("pluginNoCustomSettings")}
                </Text>
              </View>
            }
          >
            {() => {
              const CustomSettings = customSettingsView()!;
              return <CustomSettings ctx={viewCtx} />;
            }}
          </If>
        </ErrorBoundary>
      </View>
    </If>
  );
}

/** Plugin catalog directory, category filtering, dependency indicators, and isolated custom SettingsView host. */
export function PluginsSpaceView(props: {
  store: ReturnType<typeof createAppStore>;
}) {
  const searchQuery = signal("");
  const selectedCategory = signal<"all" | PluginCategory>("all");

  const wide = () => windowSize().width >= 600;
  const locale = () => props.store.effectiveLocale();

  const filteredPlugins = () => {
    const q = searchQuery().trim().toLowerCase();
    const cat = selectedCategory();
    const loc = locale();
    return props.store.plugins().filter((item) => {
      if (cat !== "all" && item.category !== cat) return false;
      if (!q) return true;
      const provided = (item.manifest?.provides ?? [])
        .map((svc) => svc.id)
        .join(" ");
      const haystack = [
        item.id,
        localizedPluginName(item, loc),
        localizedPluginSummary(item, loc),
        item.manifest?.name?.["zh-CN"] ?? "",
        item.manifest?.name?.["en-US"] ?? "",
        item.manifest?.summary?.["zh-CN"] ?? "",
        item.manifest?.summary?.["en-US"] ?? "",
        provided,
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  };

  const inspectedIds = () => {
    const id = props.store.inspectedPluginId();
    return id ? [id] : [];
  };

  return (
    <If
      when={Boolean(props.store.inspectedPluginId())}
      else={
        /* View 1: Plugins Directory / Marketplace-Ready Catalog */
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
          <Scroll
            horizontal={true}
            scrollbar={false}
            class="shrink-0"
            contentClass="flex-row items-center gap-2 pr-2"
          >
            <Button
              testID="plugin-category-all"
              selected={selectedCategory() === "all"}
              hitSlop={4}
              onPress={() => selectedCategory.set("all")}
              class={
                selectedCategory() === "all"
                  ? "min-h-10 px-4 rounded-full bg-primary border border-transparent items-center justify-center active:opacity-75"
                  : "min-h-10 px-4 rounded-full bg-muted border border-border items-center justify-center active:opacity-75"
              }
            >
              <Text
                class={
                  selectedCategory() === "all"
                    ? "text-primary-foreground text-xs font-semibold"
                    : "text-muted-foreground text-xs font-medium"
                }
              >
                {t("pluginCategoryAll")}
              </Text>
            </Button>

            <Each of={PLUGIN_CATEGORIES} key={(cat) => cat}>
              {(cat) => (
                <Button
                  testID={`plugin-category-${cat()}`}
                  selected={selectedCategory() === cat()}
                  hitSlop={4}
                  onPress={() => selectedCategory.set(cat())}
                  class={
                    selectedCategory() === cat()
                      ? "min-h-10 px-4 rounded-full bg-primary border border-transparent items-center justify-center active:opacity-75"
                      : "min-h-10 px-4 rounded-full bg-muted border border-border items-center justify-center active:opacity-75"
                  }
                >
                  <Text
                    class={
                      selectedCategory() === cat()
                        ? "text-primary-foreground text-xs font-semibold"
                        : "text-muted-foreground text-xs font-medium"
                    }
                  >
                    {categoryLabel(cat())}
                  </Text>
                </Button>
              )}
            </Each>
          </Scroll>

          {/* Plugin cards grid */}
          <Scroll class="flex-1 min-h-0" contentClass="gap-3 pb-2">
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
                      onPress={() =>
                        props.store.setInspectedPluginId(item().id)
                      }
                      class="rounded-2xl border border-border bg-card p-4 gap-3 items-stretch justify-between active:bg-muted focus:border-ring"
                      style={
                        wide() ? { width: "32%", minWidth: 220 } : undefined
                      }
                    >
                      <View class="flex-row items-center justify-between gap-2.5">
                        <View class="flex-row items-center gap-3 flex-1 min-w-0">
                          <View class="w-10 h-10 rounded-xl bg-primary items-center justify-center shrink-0">
                            <PluginVectorIcon
                              name={normalizePluginIconName(
                                item().manifest?.icon,
                              )}
                              tone="primaryFg"
                              size={20}
                            />
                          </View>
                          <View class="flex-1 min-w-0 gap-0.5">
                            <Text
                              class="text-foreground text-base font-bold"
                              style={{ numberOfLines: 1 }}
                            >
                              {localizedPluginName(item(), locale())}
                            </Text>
                            <Text
                              class="text-subtle-text text-xs font-mono"
                              style={{ numberOfLines: 1 }}
                            >
                              v{item().version}
                            </Text>
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
                        {localizedPluginSummary(item(), locale())}
                      </Text>

                      <View class="flex-row items-center justify-between gap-2 pt-0.5">
                        <View class="flex-row items-center gap-1.5">
                          <View class={cardStatusDotClass(item())} />
                          <Text class="text-muted-foreground text-xs font-medium">
                            {cardStatusText(item())}
                          </Text>
                        </View>
                        <Text
                          class="text-subtle-text text-xs"
                          style={{ numberOfLines: 1 }}
                        >
                          {categoryLabel(item().category)}
                        </Text>
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
      <Each of={inspectedIds()} key={(id) => id}>
        {(id) => <PluginDetailPane pluginId={id()} store={props.store} />}
      </Each>
    </If>
  );
}
