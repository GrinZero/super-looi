import {
  computed,
  ErrorBoundary,
  Scroll,
  signal,
  Text,
  View,
  windowSize,
} from "nsh";
import { Button, Input } from "nsh/base";
import { t } from "../i18n";
import type { PluginSnapshot } from "../generated/looi-runtime";
import {
  PLUGIN_CATEGORIES,
  type PluginCategory,
  type PluginDependencyStatus,
} from "../runtime/plugins/shared-types";
import type { createAppStore } from "../store";
import { ActionButton, ToggleSwitch } from "./Controls";
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

function compactDependencyStatus(
  dep: PluginDependencyStatus,
  locale: "zh-CN" | "en-US",
): string {
  if (dep.satisfied) return t("pluginDependencyReady");
  if (dep.reason?.startsWith("version_mismatch")) {
    return t("pluginDependencyVersionMismatch");
  }
  if (dep.optional) return t("pluginDependencyOptional");
  return locale === "en-US" ? "Enable required" : "待启用";
}

function PluginDependencyChips(props: {
  dependencies: PluginDependencyStatus[];
  locale: "zh-CN" | "en-US";
  onInspectPlugin: (id: string) => void;
  compact?: boolean;
}) {
  return (
    <Each of={props.dependencies} key={(dep) => dep.service}>
      {(dep) => {
        const providerTitle = () => dep().providerName?.[props.locale] ?? dep().service;
        const statusText = () => compactDependencyStatus(dep(), props.locale);
        return (
          <Button
            disabled={!dep().providerPluginId}
            accessibilityLabel={`${providerTitle()} · ${dependencyHintText(dep(), props.locale)}`}
            hitSlop={4}
            onPress={() => {
              const targetId = dep().providerPluginId;
              if (targetId) {
                props.onInspectPlugin(targetId);
              }
            }}
            class={
              props.compact
                ? "max-w-52 min-h-11 px-3 rounded-full bg-muted border border-border flex-row items-center gap-1.5 shrink hover:bg-accent transition-colors duration-150 active:opacity-75 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card disabled:opacity-100"
                : "min-h-11 px-3 rounded-full bg-muted border border-border flex-row items-center gap-1.5 hover:bg-accent transition-colors duration-150 active:opacity-75 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card disabled:opacity-100"
            }
          >
            <View
              class={
                dep().satisfied
                  ? "w-2 h-2 rounded-full bg-verified shrink-0"
                  : dep().optional
                    ? "w-2 h-2 rounded-full bg-muted-foreground shrink-0"
                    : "w-2 h-2 rounded-full bg-warning shrink-0"
              }
            />
            <Text
              class="text-foreground text-xs font-medium shrink min-w-0"
              style={{ numberOfLines: 1 }}
            >
              {providerTitle()}
            </Text>
            <Text class="text-muted-foreground text-xs shrink-0">
              · {statusText()}
            </Text>
          </Button>
        );
      }}
    </Each>
  );
}

/** Top context bar for the Plugins space: switches between catalog title and detail breadcrumb + identity/dependencies + enable switch. */
export function PluginsContextBar(props: {
  store: ReturnType<typeof createAppStore>;
}) {
  const wide = () => windowSize().width >= 600;
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
        <View class="flex-1 min-w-0 h-11 flex-row items-baseline gap-2.5">
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
      <View class="flex-1 min-w-0 h-11 flex-row items-center justify-between gap-2.5">
        <View class="flex-row items-center gap-2 min-w-0 flex-1">
          <Button
            testID="plugin-back-to-list"
            accessibilityLabel={t("pluginBackToList")}
            onPress={() => props.store.setInspectedPluginId(null)}
            class="min-h-11 px-2.5 -ml-1.5 rounded-xl flex-row items-center gap-1 shrink-0 hover:bg-muted active:bg-muted transition-colors duration-150 focus:border-ring focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
          >
            <PluginVectorIcon name="chevron_left" tone="muted" size={16} />
            <Text class="text-muted-foreground text-sm font-medium">
              {t("pluginBackToList")}
            </Text>
          </Button>
          <View class="w-px h-4 bg-border shrink-0" />
          <View class="w-7 h-7 rounded-lg bg-primary items-center justify-center shrink-0">
            <PluginVectorIcon
              name={normalizePluginIconName(plugin()?.manifest?.icon)}
              tone="primaryFg"
              size={15}
            />
          </View>
          <Text
            class="text-foreground text-base font-bold shrink min-w-0"
            style={{ numberOfLines: 1 }}
          >
            {localizedPluginName(plugin(), locale())}
          </Text>
          <If when={wide() && Boolean(plugin()?.version)}>
            <Text class="text-muted-foreground text-xs font-mono shrink-0">
              v{plugin()?.version}
            </Text>
          </If>
        </View>

        <View class="flex-row items-center gap-2.5 shrink-0">
          <If when={wide() && (plugin()?.dependencies?.length ?? 0) > 0}>
            <PluginDependencyChips
              dependencies={plugin()?.dependencies ?? []}
              locale={locale()}
              onInspectPlugin={(targetId) => props.store.setInspectedPluginId(targetId)}
              compact
            />
          </If>

          <View class="flex-row items-center gap-2 shrink-0">
            <Text class="text-foreground text-xs font-medium">
              {t("pluginEnabled")}
            </Text>
            <ToggleSwitch
              testID="plugin-enabled"
              accessibilityLabel={t("pluginEnabled")}
              checked={plugin()?.enabled ?? false}
              disabled={busy()}
              hitSlop={10}
              onChange={(checked) => {
                const id = inspectedId();
                if (id) {
                  void props.store.setPluginEnabled(id, checked);
                }
              }}
            />
          </View>
        </View>
      </View>
    </If>
  );
}

function PluginDetailPane(props: {
  pluginId: string;
  store: ReturnType<typeof createAppStore>;
}) {
  const wide = () => windowSize().width >= 600;
  const locale = () => props.store.effectiveLocale();
  const plugin = () =>
    props.store.plugins().find((item) => item.id === props.pluginId);
  const customSettingsView = computed(
    () => getPluginUiModule(props.pluginId)?.SettingsView,
  );
  const viewCtx = props.store.pluginViewContext(props.pluginId);
  const formattedDiagnosticError = () => {
    const uiErr = viewCtx.uiError();
    if (uiErr) return uiErr;
    const lastErr = plugin()?.lastError;
    if (!lastErr) return "";
    const codePart = lastErr.code !== undefined ? ` code=${String(lastErr.code)}` : "";
    return `[stage=${lastErr.stage}${codePart}] ${lastErr.reason}`;
  };
  const showHostStageCrashBanner = () => {
    const text = formattedDiagnosticError();
    if (!text) return false;
    return Boolean(customSettingsView()) && text.includes(":ui.Stage");
  };

  return (
    <If when={Boolean(plugin())}>
      <View class="flex-1 min-h-0 gap-2.5">
        <If when={!wide() && (plugin()?.dependencies?.length ?? 0) > 0}>
          <View class="flex-row flex-wrap gap-2 shrink-0">
            <PluginDependencyChips
              dependencies={plugin()?.dependencies ?? []}
              locale={locale()}
              onInspectPlugin={(targetId) => props.store.setInspectedPluginId(targetId)}
            />
          </View>
        </If>

        <If when={showHostStageCrashBanner()}>
          <View
            testID="plugin-stage-crash-banner"
            class="rounded-xl border border-destructive bg-card px-3.5 py-2 flex-row items-center gap-2"
          >
            <PluginVectorIcon name="alert" tone="destructive" size={16} />
            <Text class="flex-1 text-destructive text-xs font-mono">
              {formattedDiagnosticError()}
            </Text>
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
              <View class="flex-1 min-h-0 rounded-2xl border border-border bg-card p-5 items-center justify-center gap-3">
                <If when={Boolean(localizedPluginSummary(plugin(), locale()))}>
                  <Text class="text-foreground text-sm font-medium text-center">
                    {localizedPluginSummary(plugin(), locale())}
                  </Text>
                </If>
                <If when={Boolean(formattedDiagnosticError())}>
                  <View class="w-full rounded-xl bg-muted border border-destructive px-3 py-2">
                    <Text testID="plugin-error" class="text-destructive text-xs font-mono">
                      {formattedDiagnosticError()}
                    </Text>
                  </View>
                </If>
                <Text class="text-muted-foreground text-xs text-center">
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

  const filteredPlugins = computed(() => {
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
  });

  const inspectedIds = () => {
    const id = props.store.inspectedPluginId();
    return id ? [id] : [];
  };

  return (
    <If
      when={Boolean(props.store.inspectedPluginId())}
      else={
        /* View 1: Plugins Directory / Marketplace-Ready Catalog */
        <View class="flex-1 min-h-0 gap-2.5">
          {/* Search bar + Category filter pills */}
          <View class={wide() ? "flex-row items-center gap-2.5 shrink-0" : "gap-2.5 shrink-0"}>
            <View
              class={
                wide()
                  ? "w-60 shrink-0 min-h-11 rounded-full border border-border bg-card px-3.5 flex-row items-center gap-2"
                  : "min-h-11 rounded-full border border-border bg-card px-3.5 flex-row items-center gap-2.5"
              }
            >
              <PluginVectorIcon name="search" tone="muted" size={17} />
              <Input
                testID="plugin-search"
                accessibilityLabel={t("pluginSearchPlaceholder")}
                value={searchQuery()}
                onChange={(e) => searchQuery.set(e.value)}
                placeholder={t("pluginSearchPlaceholder")}
                autoCorrect={false}
                autoCapitalize="none"
                maxLength={256}
                class="flex-1 min-w-0 min-h-11 text-foreground text-sm"
              />
              <If when={Boolean(searchQuery().trim())}>
                <Button
                  testID="plugin-search-clear"
                  hitSlop={6}
                  onPress={() => searchQuery.set("")}
                  class="h-8 px-2.5 rounded-full bg-muted items-center justify-center shrink-0 hover:bg-accent transition-colors duration-150 active:opacity-75 focus-visible:ring-2 focus-visible:ring-ring"
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
              class={wide() ? "flex-1 min-w-0" : "shrink-0"}
              contentClass="flex-row items-center gap-2 pr-2"
            >
              <Button
                testID="plugin-category-all"
                selected={selectedCategory() === "all"}
                hitSlop={4}
                onPress={() => selectedCategory.set("all")}
                class={
                  selectedCategory() === "all"
                    ? "min-h-11 px-4 rounded-full bg-primary border border-transparent items-center justify-center transition-colors duration-150 active:opacity-75 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                    : "min-h-11 px-4 rounded-full bg-muted border border-border items-center justify-center hover:bg-accent transition-colors duration-150 active:opacity-75 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
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
                        ? "min-h-11 px-4 rounded-full bg-primary border border-transparent items-center justify-center transition-colors duration-150 active:opacity-75 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                        : "min-h-11 px-4 rounded-full bg-muted border border-border items-center justify-center hover:bg-accent transition-colors duration-150 active:opacity-75 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
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
          </View>

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
                testID="plugin-catalog-grid"
                class={
                  windowSize().width >= 960
                    ? "grid grid-cols-3 gap-3 items-stretch"
                    : wide()
                      ? "grid grid-cols-2 gap-3 items-stretch"
                      : "flex-col gap-3"
                }
              >
                <Each of={filteredPlugins()} key={(item) => item.id}>
                  {(item) => (
                    <Button
                      testID={`plugin-${item().id}`}
                      accessibilityLabel={`${localizedPluginName(item(), locale())} · ${cardStatusText(item())}`}
                      onPress={() =>
                        props.store.setInspectedPluginId(item().id)
                      }
                      class="min-w-0 rounded-2xl border border-border bg-card p-3.5 gap-2.5 items-stretch justify-between hover:bg-muted/40 active:bg-muted transition-colors duration-150 focus:border-ring focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                    >
                      <View class="gap-2 min-w-0">
                        <View class="flex-row items-center justify-between gap-2">
                          <View class="flex-row items-center gap-2.5 flex-1 min-w-0">
                            <View class="w-9 h-9 rounded-xl bg-primary items-center justify-center shrink-0">
                              <PluginVectorIcon
                                name={normalizePluginIconName(
                                  item().manifest?.icon,
                                )}
                                tone="primaryFg"
                                size={18}
                              />
                            </View>
                            <View class="flex-1 min-w-0 gap-0.5">
                              <Text
                                class="text-foreground text-sm font-bold"
                                style={{ numberOfLines: 1 }}
                              >
                                {localizedPluginName(item(), locale())}
                              </Text>
                              <Text
                                class="text-muted-foreground text-xs font-mono"
                                style={{ numberOfLines: 1 }}
                              >
                                v{item().version}
                              </Text>
                            </View>
                          </View>
                          <View class="shrink-0">
                            <PluginVectorIcon
                              name="chevron_right"
                              tone="muted"
                              size={15}
                            />
                          </View>
                        </View>

                        <Text
                          class="text-muted-foreground text-xs"
                          style={{ numberOfLines: 2 }}
                        >
                          {localizedPluginSummary(item(), locale())}
                        </Text>
                      </View>

                      <View class="flex-row items-center justify-between gap-2 pt-0.5">
                        <View class="flex-row items-center gap-1.5 min-w-0 flex-1">
                          <View class={cardStatusDotClass(item())} />
                          <Text
                            class="flex-1 min-w-0 text-muted-foreground text-xs font-medium"
                            style={{ numberOfLines: 1 }}
                          >
                            {cardStatusText(item())}
                          </Text>
                        </View>
                        <Text
                          class="text-muted-foreground text-xs shrink-0"
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
