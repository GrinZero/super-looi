import { uiMessage } from "../runtime/messages";
import { t, translateMessage, formatDate } from "../i18n";
import { effect, openUrl, Clipboard, signal, Text, View, Scroll, windowSize } from "nsh";
import { Button } from "nsh/base";
import type {
  LlmBrandId,
  CompatibleApiProtocol,
  LlmChannelStatus,
  LlmModelItem,
} from "../generated/looi-runtime.js";
import type { createAppStore } from "../store";
import { ActionButton, TextField } from "./Controls";

export function ModelsSpaceView(props: {
  store: ReturnType<typeof createAppStore>;
  selectedBrandId: LlmBrandId | (() => LlmBrandId);
}) {
  const brandId = (): LlmBrandId =>
    typeof props.selectedBrandId === "function"
      ? props.selectedBrandId()
      : props.selectedBrandId;

  const selectedChannelId = signal<string>("");
  const authMode = signal<"api_key" | "oauth">("api_key");
  const apiKey = signal("");
  const customApi = signal<CompatibleApiProtocol>("openai-completions");
  const customBaseUrl = signal("");
  const customModelId = signal("");
  const extraModelId = signal("");
  const oauthCallbackUrl = signal("");
  const saving = signal(false);
  const localModelChoice = signal("");

  const brand = () =>
    props.store
      .llm()
      .brands.find((item) => item.brandId === brandId());

  // Sync default channel only when brand changes
  let lastBrandId: LlmBrandId | null = null;
  effect(() => {
    const bId = brandId();
    const currentBrand = brand();
    if (!currentBrand || !currentBrand.channels.length) return;
    if (bId !== lastBrandId) {
      lastBrandId = bId;
      const activeProvider = props.store.llm().active?.providerId;
      const activeInBrand = currentBrand.channels.find(
        (ch) => ch.providerId === activeProvider,
      );
      selectedChannelId.set(
        activeInBrand?.providerId ?? currentBrand.channels[0].providerId,
      );
    }
  });

  const channel = (): LlmChannelStatus => {
    const currentBrand = brand();
    if (!currentBrand || !currentBrand.channels.length) {
      return {
        providerId: "custom",
        label: t("compatibleEndpoint"),
        baseUrl: "",
        protocolLabel: "OpenAI Chat Completions",
        authTypes: ["api_key"],
        defaultModelId: "",
        hasApiKey: false,
        hasOAuth: false,
        oauthExpiresAt: null,
        models: [],
      };
    }
    return (
      currentBrand.channels.find(
        (ch) => ch.providerId === selectedChannelId(),
      ) ?? currentBrand.channels[0]
    );
  };

  // Sync auth mode and custom fields only when ready state or channel changes
  let lastChannelKey = "";
  effect(() => {
    const ch = channel();
    const bId = brandId();
    const key = `${props.store.ready()}:${bId}:${ch.providerId}`;
    if (key === lastChannelKey) return;
    lastChannelKey = key;
    if (ch.hasOAuth || (!ch.hasApiKey && ch.authTypes.includes("oauth"))) {
      authMode.set("oauth");
    } else {
      authMode.set("api_key");
    }
    if (bId === "custom") {
      const custom = props.store.llm().custom;
      customApi.set(custom.api || "openai-completions");
      customBaseUrl.set(custom.baseUrl || "");
      customModelId.set(custom.modelId || "");
    }
    apiKey.set("");
    extraModelId.set("");
    oauthCallbackUrl.set("");
    localModelChoice.set("");
    if (props.store.ready() && (ch.hasApiKey || ch.hasOAuth)) {
      void props.store.refreshProviderModels(ch.providerId);
    }
  });

  const isGloballyActiveChannel = () =>
    props.store.llm().active?.providerId === channel().providerId;

  const saveConfiguration = async () => {
    if (saving()) return;
    saving.set(true);
    try {
      const targetModel =
        localModelChoice().trim() ||
        customModelId().trim() ||
        channel().defaultModelId ||
        "";

      if (brandId() === "custom") {
        await props.store.saveProviderApiKey({
          providerId: "custom",
          apiKey: apiKey().trim() || undefined,
          modelId: targetModel,
          custom: {
            api: customApi(),
            baseUrl: customBaseUrl().trim(),
            modelId: targetModel,
          },
          setActive: true,
        });
      } else {
        await props.store.saveProviderApiKey({
          providerId: channel().providerId,
          apiKey: apiKey().trim() || undefined,
          modelId: targetModel,
          setActive: true,
        });
      }
      apiKey.set("");
    } catch (cause) {
      props.store.notify(
        cause instanceof Error ? cause.message : "@looi:couldNotSaveSettings",
      );
    } finally {
      saving.set(false);
    }
  };

  const handlePickModel = async (modelItem: LlmModelItem) => {
    const ch = channel();
    if (ch.hasApiKey || ch.hasOAuth) {
      await props.store.selectActiveModel(ch.providerId, modelItem.id);
    } else {
      localModelChoice.set(modelItem.id);
      props.store.notify(uiMessage("selectPendingModel", { model: modelItem.id }));
    }
  };

  const handleAddCustomModel = async () => {
    const raw = extraModelId().trim();
    if (!raw) return;
    const ch = channel();
    if (ch.hasApiKey || ch.hasOAuth) {
      await props.store.selectActiveModel(ch.providerId, raw, true);
    } else {
      localModelChoice.set(raw);
      props.store.notify(uiMessage("addPendingModel", { model: raw }));
    }
    extraModelId.set("");
  };

  const copyAndOpenDeviceOAuth = async () => {
    const code = props.store.oauth().userCode;
    const url = props.store.oauth().url;
    if (code) {
      await Clipboard.writeText(code);
    }
    if (url) {
      openUrl(url).catch(() => {});
    }
    props.store.notify("@looi:codeCopiedBrowserVerificationPageRequested");
  };

  const renderLeftCard = () => (
    <View class="rounded-2xl border border-border bg-card p-4 gap-3.5">
      <View class="flex-row items-center justify-between gap-2 pb-0.5">
        <View class="gap-0.5 flex-1 min-w-0">
          <Text class="text-foreground text-sm font-semibold">
            {brand()?.label ?? t("modelService")}
          </Text>
          <Text
            class="text-muted-foreground text-xs font-mono"
            style={{ numberOfLines: 1, flexShrink: 1 }}
          >
            {channel().baseUrl || (brandId() === "custom" ? t("customEndpoint") : t("officialEndpoint"))}
            {channel().protocolLabel ? ` · ${channel().protocolLabel}` : ""}
          </Text>
        </View>
        <If when={channel().hasApiKey || channel().hasOAuth}>
          <View class="flex-row items-center gap-1.5 px-2 py-0.5 rounded-full bg-muted">
            <View class="w-1.5 h-1.5 rounded-full bg-verified" />
            <Text class="text-verified text-xs font-medium">{t("credentialsSaved")}</Text>
          </View>
        </If>
      </View>

      <If when={(brand()?.channels.length ?? 0) > 1}>
        <View class="gap-1.5 border-t border-border pt-3">
          <Text class="text-muted-foreground text-xs">{t("connectionChannel")}</Text>
          <View class="flex-row flex-wrap gap-1.5">
            <Each of={brand()?.channels ?? []} key={(ch) => ch.providerId}>
              {(ch) => {
                const isSelected = () =>
                  ch().providerId === channel().providerId;
                return (
                  <Button
                    onPress={() => selectedChannelId.set(ch().providerId)}
                    class={
                      isSelected()
                        ? "min-h-11 px-3 rounded-xl bg-primary items-center justify-center active:opacity-75"
                        : "min-h-11 px-3 rounded-xl border border-border bg-muted items-center justify-center active:opacity-75"
                    }
                  >
                    <Text
                      class={
                        isSelected()
                          ? "text-primary-foreground text-xs font-semibold"
                          : "text-foreground text-xs"
                      }
                    >
                      {ch().label}
                    </Text>
                  </Button>
                );
              }}
            </Each>
          </View>
        </View>
      </If>

      <If when={brandId() === "custom"}>
        <View class="gap-3 border-t border-border pt-3">
          <Text class="text-muted-foreground text-xs">{t("apiProtocol")}</Text>
          <View class="flex-row flex-wrap gap-1.5">
            <Button
              onPress={() => customApi.set("openai-completions")}
              class={
                customApi() === "openai-completions"
                  ? "min-h-11 px-3 rounded-xl bg-primary items-center justify-center active:opacity-75"
                  : "min-h-11 px-3 rounded-xl border border-border bg-muted items-center justify-center active:opacity-75"
              }
            >
              <Text
                class={
                  customApi() === "openai-completions"
                    ? "text-primary-foreground text-xs font-semibold"
                    : "text-foreground text-xs"
                }
              >
                OpenAI Completions
              </Text>
            </Button>
            <Button
              onPress={() => customApi.set("openai-responses")}
              class={
                customApi() === "openai-responses"
                  ? "min-h-11 px-3 rounded-xl bg-primary items-center justify-center active:opacity-75"
                  : "min-h-11 px-3 rounded-xl border border-border bg-muted items-center justify-center active:opacity-75"
              }
            >
              <Text
                class={
                  customApi() === "openai-responses"
                    ? "text-primary-foreground text-xs font-semibold"
                    : "text-foreground text-xs"
                }
              >
                OpenAI Responses
              </Text>
            </Button>
            <Button
              onPress={() => customApi.set("anthropic-messages")}
              class={
                customApi() === "anthropic-messages"
                  ? "min-h-11 px-3 rounded-xl bg-primary items-center justify-center active:opacity-75"
                  : "min-h-11 px-3 rounded-xl border border-border bg-muted items-center justify-center active:opacity-75"
              }
            >
              <Text
                class={
                  customApi() === "anthropic-messages"
                    ? "text-primary-foreground text-xs font-semibold"
                    : "text-foreground text-xs"
                }
              >
                Anthropic Messages
              </Text>
            </Button>
          </View>

          <TextField
            label={t("serviceEndpointHttps")}
            testID="custom-base-url"
            value={customBaseUrl()}
            onChange={(v) => customBaseUrl.set(v)}
            placeholder="https://api.example.com/v1"
          />

          <TextField
            label={t("defaultModelId")}
            testID="custom-model-id"
            value={customModelId()}
            onChange={(v) => customModelId.set(v)}
            placeholder="gpt-4.1 / deepseek-chat / claude-sonnet-4-5"
          />
        </View>
      </If>

      <If
        when={
          channel().authTypes.includes("oauth") &&
          channel().authTypes.includes("api_key")
        }
      >
        <View class="gap-1.5 border-t border-border pt-3">
          <Text class="text-muted-foreground text-xs">{t("authentication")}</Text>
          <View class="flex-row gap-2">
            <Button
              onPress={() => authMode.set("oauth")}
              class={
                authMode() === "oauth"
                  ? "flex-1 min-h-11 rounded-xl bg-primary items-center justify-center active:opacity-75"
                  : "flex-1 min-h-11 rounded-xl border border-border bg-muted items-center justify-center active:opacity-75"
              }
            >
              <Text
                class={
                  authMode() === "oauth"
                    ? "text-primary-foreground text-xs font-semibold"
                    : "text-foreground text-xs"
                }
              >
                {t("subscriptionSigninOauth")}</Text>
            </Button>
            <Button
              onPress={() => authMode.set("api_key")}
              class={
                authMode() === "api_key"
                  ? "flex-1 min-h-11 rounded-xl bg-primary items-center justify-center active:opacity-75"
                  : "flex-1 min-h-11 rounded-xl border border-border bg-muted items-center justify-center active:opacity-75"
              }
            >
              <Text
                class={
                  authMode() === "api_key"
                    ? "text-primary-foreground text-xs font-semibold"
                    : "text-foreground text-xs"
                }
              >
                {t("apiKey")}</Text>
            </Button>
          </View>
        </View>
      </If>

      <If
        when={
          channel().authTypes.includes("oauth") &&
          (authMode() === "oauth" || !channel().authTypes.includes("api_key"))
        }
        else={
          <View class="gap-3.5 border-t border-border pt-3">
            <TextField
              label="API Key"
              testID="model-key"
              value={apiKey()}
              onChange={(v) => apiKey.set(v)}
              masked={true}
              placeholder={
                channel().hasApiKey
                  ? t("savedInTheSystemKeychainLeaveBlank")
                  : "sk-..."
              }
              onSubmit={saveConfiguration}
            />

            <View class="flex-row items-center justify-between gap-2 pt-1">
              <View>
                <If when={channel().hasApiKey || channel().hasOAuth}>
                  <ActionButton
                    label={t("clearCredentials")}
                    testID="clear-provider-btn"
                    kind="danger"
                    compact={true}
                    onPress={() =>
                      props.store.removeProviderCredential(channel().providerId)
                    }
                  />
                </If>
              </View>
              <ActionButton
                label={saving() ? t("saving") : t("saveAndUseModel")}
                testID="save-provider-btn"
                kind="primary"
                compact={true}
                disabled={
                  !props.store.ready() ||
                  saving() ||
                  (!apiKey().trim() && !channel().hasApiKey) ||
                  (brandId() === "custom" &&
                    (!customBaseUrl().trim() || !customModelId().trim()))
                }
                onPress={saveConfiguration}
              />
            </View>
          </View>
        }
      >
        <View class="gap-3 border-t border-border pt-3">
          <If
            when={
              props.store.oauth().running &&
              props.store.oauth().providerId === channel().providerId
            }
            else={
              <If
                when={channel().hasOAuth}
                else={
                  <View class="gap-2.5">
                    <Text class="text-muted-foreground text-xs">
                      {t("signInOnTheOfficialWebsiteTokens")}</Text>
                    <ActionButton
                      label={
                        brandId() === "kimi"
                          ? t("signInWithKimiCode")
                          : t("signInWithChatgpt")
                      }
                      testID="oauth-start-btn"
                      kind="primary"
                      compact={true}
                      disabled={!props.store.ready()}
                      onPress={() =>
                        void props.store.startProviderOAuth(channel().providerId)
                      }
                    />
                  </View>
                }
              >
                <View class="gap-3 rounded-xl border border-border bg-muted p-3">
                  <View class="flex-row items-center gap-2">
                    <View class="w-2 h-2 rounded-full bg-verified" />
                    <Text class="text-verified text-xs font-semibold">
                      {t("subscriptionAccountConnected")}</Text>
                  </View>
                  <Text class="text-muted-foreground text-xs">
                    {t("oauthCredentialsAreActiveYouCanReauthorize")}</Text>
                  <View class="flex-row gap-2">
                    <ActionButton
                      label={t("reauthorize")}
                      compact={true}
                      onPress={() =>
                        props.store.startProviderOAuth(channel().providerId)
                      }
                    />
                    <ActionButton
                      label={t("disconnect")}
                      kind="danger"
                      compact={true}
                      onPress={() =>
                        props.store.removeProviderCredential(
                          channel().providerId,
                        )
                      }
                    />
                  </View>
                </View>
              </If>
            }
          >
            <If
              when={props.store.oauth().kind === "device_code"}
              else={
                <If
                  when={
                    props.store.oauth().kind === "auth_url" ||
                    props.store.oauth().kind === "awaiting_callback"
                  }
                  else={
                    <View class="gap-2.5 rounded-xl border border-border bg-muted p-3">
                      <Text class="text-foreground text-xs font-medium">
                        {props.store.oauth().instructions || t("authorizing")}
                      </Text>
                      <ActionButton
                        label={t("cancel")}
                        compact={true}
                        onPress={() => props.store.cancelProviderOAuth()}
                      />
                    </View>
                  }
                >
                  <View class="gap-2.5 rounded-xl border border-border bg-muted p-3">
                    <Text class="text-foreground text-xs font-semibold">
                      {t("browserAuthorization")}</Text>
                    <If when={props.store.oauth().url}>
                      <ActionButton
                        label={t("openSigninPage")}
                        compact={true}
                        kind="primary"
                        onPress={() => openUrl(props.store.oauth().url).catch(() => {})}
                      />
                    </If>
                    <TextField
                      label={t("ifTheBrowserDidNotRedirectPaste")}
                      testID="oauth-callback-input"
                      value={oauthCallbackUrl()}
                      onChange={(v) => oauthCallbackUrl.set(v)}
                      placeholder="http://127.0.0.1:1455/auth/callback?code=..."
                    />
                    <View class="flex-row gap-2">
                      <ActionButton
                        label={t("submitCallbackUrl")}
                        kind="primary"
                        compact={true}
                        disabled={!oauthCallbackUrl().trim()}
                        onPress={() =>
                          props.store.submitProviderOAuthCallback(
                            oauthCallbackUrl().trim(),
                          )
                        }
                      />
                      <ActionButton
                        label={t("cancelAuthorization")}
                        kind="danger"
                        compact={true}
                        onPress={() => props.store.cancelProviderOAuth()}
                      />
                    </View>
                  </View>
                </If>
              }
            >
              <View class="gap-3 rounded-xl border border-border bg-muted p-3.5">
                <Text class="text-muted-foreground text-xs">
                  {t("copyTheDeviceCodeBelowThenAuthorize")}</Text>
                <View class="items-center py-1">
                  <Text class="text-xl font-mono font-bold tracking-widest text-foreground">
                    {props.store.oauth().userCode || "----"}
                  </Text>
                </View>
                <View class="flex-row gap-2">
                  <ActionButton
                    label={t("copyCodeAndOpenBrowser")}
                    kind="primary"
                    compact={true}
                    onPress={copyAndOpenDeviceOAuth}
                  />
                  <ActionButton
                    label={t("cancelAuthorization")}
                    compact={true}
                    onPress={() => props.store.cancelProviderOAuth()}
                  />
                </View>
              </View>
            </If>
          </If>
        </View>
      </If>
    </View>
  );

  const renderRightCard = () => (
    <View class="rounded-2xl border border-border bg-card p-4 gap-3">
      <View class="gap-1.5 border-b border-border pb-2.5">
        <Text class="text-foreground text-sm font-semibold">{t("availableModels")}</Text>
        <If
          when={isGloballyActiveChannel()}
          else={
            <Text class="text-muted-foreground text-xs">
              {props.store.llm().active
                ? t("activeModel", { model: props.store.llm().active?.modelId })
                : t("noModelSelected")}
            </Text>
          }
        >
          <View class="flex-row items-center gap-1.5">
            <View class="w-1.5 h-1.5 rounded-full bg-verified" />
            <Text class="text-verified text-xs font-semibold">
              {t("activeForThisConversation")}</Text>
          </View>
        </If>
      </View>

      <View class="gap-1.5">
        <If when={!channel().modelsFetched}>
          <Text class="text-muted-foreground text-xs py-2">
            {channel().hasApiKey || channel().hasOAuth
              ? channel().modelsError || t("loadingOnlineModels")
              : t("connectToLoadAvailableModels")}
          </Text>
        </If>
        <If when={channel().modelsFetched && !channel().models.length}>
          <Text class="text-muted-foreground text-xs py-2">
            {t("noModelsReturnedEnterAModelId")}</Text>
        </If>
        <Each of={channel().models} key={(m) => m.id}>
          {(m) => {
            const isGlobalActive = () =>
              isGloballyActiveChannel() &&
              props.store.llm().active?.modelId === m().id;
            const isChosen = () =>
              localModelChoice() === m().id ||
              (!localModelChoice() && channel().defaultModelId === m().id);
            const active = () => isGlobalActive() || isChosen();

            return (
              <Button
                onPress={() => handlePickModel(m())}
                class={
                  active()
                    ? "min-h-11 px-3 py-2 rounded-xl bg-primary flex-row items-center justify-between gap-2 active:opacity-75"
                    : "min-h-11 px-3 py-2 rounded-xl border border-border bg-muted flex-row items-center justify-between gap-2 active:opacity-75"
                }
              >
                <View
                  class="flex-row items-center gap-1.5"
                  style={{ flex: 1, minWidth: 0 }}
                >
                  <View class="flex-1 min-w-0 gap-0.5">
                    <Text
                      class={
                        active()
                          ? "text-primary-foreground font-mono text-sm font-medium"
                          : "text-foreground font-mono text-sm font-medium"
                      }
                      style={{ numberOfLines: 1 }}
                    >
                      {m().id}
                    </Text>
                    <If when={m().name !== m().id}>
                      <Text
                        class={active() ? "text-primary-foreground text-xs" : "text-muted-foreground text-xs"}
                        style={{ numberOfLines: 1 }}
                      >
                        {m().name}
                      </Text>
                    </If>
                  </View>
                  <If when={m().reasoning}>
                    <View class="px-1.5 py-0.5 rounded-md bg-secondary">
                      <Text class="text-muted-foreground text-xs">{t("reasoning")}</Text>
                    </View>
                  </If>
                </View>
                <If
                  when={isGlobalActive()}
                  else={
                    <Text
                      class={
                        active()
                          ? "text-primary-foreground text-xs font-medium"
                          : "text-muted-foreground text-xs"
                      }
                    >
                      {channel().hasApiKey || channel().hasOAuth
                        ? t("select")
                        : t("selectLater")}
                    </Text>
                  }
                >
                  <View class="flex-row items-center gap-1.5">
                    <View class="w-1.5 h-1.5 rounded-full bg-verified" />
                    <Text class="text-primary-foreground text-xs font-bold">
                      {t("inUse")}</Text>
                  </View>
                </If>
              </Button>
            );
          }}
        </Each>
      </View>

      <View class="gap-2 border-t border-border pt-3">
        <TextField
          label={t("customModelId")}
          testID="custom-extra-model-input"
          value={extraModelId()}
          onChange={(v) => extraModelId.set(v)}
          placeholder={t("enterAModelIdEgGlm5flash")}
          onSubmit={handleAddCustomModel}
        />
        <View class="flex-row justify-end">
          <ActionButton
            label={t("addAndSelect")}
            testID="add-custom-model-btn"
            compact={true}
            kind="primary"
            disabled={!extraModelId().trim()}
            onPress={handleAddCustomModel}
          />
        </View>
      </View>
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
