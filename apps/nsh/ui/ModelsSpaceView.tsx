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
        label: "兼容端点",
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
        cause instanceof Error ? cause.message : "保存配置失败",
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
      props.store.notify(`已选用 ${modelItem.id}（保存配置后生效）`);
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
      props.store.notify(`已添加并选用 ${raw}（保存配置后生效）`);
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
    props.store.notify("验证码已复制，已尝试在浏览器中打开验证页");
  };

  const renderLeftCard = () => (
    <View class="rounded-2xl border border-border bg-card p-4 gap-3.5">
      <View class="flex-row items-center justify-between gap-2 pb-0.5">
        <View class="gap-0.5 flex-1 min-w-0">
          <Text class="text-foreground text-sm font-semibold">
            {brand()?.label ?? "模型服务"}
          </Text>
          <Text
            class="text-muted-foreground text-xs font-mono"
            style={{ numberOfLines: 1, flexShrink: 1 }}
          >
            {channel().baseUrl || (brandId() === "custom" ? "自定义服务端点" : "官方默认端点")}
            {channel().protocolLabel ? ` · ${channel().protocolLabel}` : ""}
          </Text>
        </View>
        <If when={channel().hasApiKey || channel().hasOAuth}>
          <View class="flex-row items-center gap-1.5 px-2 py-0.5 rounded-full bg-muted">
            <View class="w-1.5 h-1.5 rounded-full bg-verified" />
            <Text class="text-verified text-xs font-medium">已保存凭证</Text>
          </View>
        </If>
      </View>

      <If when={(brand()?.channels.length ?? 0) > 1}>
        <View class="gap-1.5 border-t border-border pt-3">
          <Text class="text-muted-foreground text-xs">接入通道</Text>
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
          <Text class="text-muted-foreground text-xs">兼容协议</Text>
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
            label="服务端点 (HTTPS)"
            testID="custom-base-url"
            value={customBaseUrl()}
            onChange={(v) => customBaseUrl.set(v)}
            placeholder="https://api.example.com/v1"
          />

          <TextField
            label="默认模型 ID"
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
          <Text class="text-muted-foreground text-xs">认证方式</Text>
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
                账号订阅登录 (OAuth)
              </Text>
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
                API Key 密钥
              </Text>
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
                  ? "已安全保存于系统钥匙串；留空可仅更新模型"
                  : "sk-..."
              }
              onSubmit={saveConfiguration}
            />

            <View class="flex-row items-center justify-between gap-2 pt-1">
              <View>
                <If when={channel().hasApiKey || channel().hasOAuth}>
                  <ActionButton
                    label="清除凭证"
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
                label={saving() ? "正在保存…" : "保存并设为当前模型"}
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
                      使用官方网页安全授权登录，令牌由系统钥匙串加密保存并自动续期。
                    </Text>
                    <ActionButton
                      label={
                        brandId() === "kimi"
                          ? "使用 Kimi Code 会员登录"
                          : "使用 ChatGPT 订阅登录"
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
                      已连接订阅账号
                    </Text>
                  </View>
                  <Text class="text-muted-foreground text-xs">
                    OAuth 凭证正常生效中，可随时重新授权或解绑。
                  </Text>
                  <View class="flex-row gap-2">
                    <ActionButton
                      label="重新授权"
                      compact={true}
                      onPress={() =>
                        props.store.startProviderOAuth(channel().providerId)
                      }
                    />
                    <ActionButton
                      label="退出授权"
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
                        {props.store.oauth().instructions || "正在处理授权…"}
                      </Text>
                      <ActionButton
                        label="取消"
                        compact={true}
                        onPress={() => props.store.cancelProviderOAuth()}
                      />
                    </View>
                  }
                >
                  <View class="gap-2.5 rounded-xl border border-border bg-muted p-3">
                    <Text class="text-foreground text-xs font-semibold">
                      系统浏览器登录授权
                    </Text>
                    <If when={props.store.oauth().url}>
                      <ActionButton
                        label="在浏览器中打开登录页"
                        compact={true}
                        kind="primary"
                        onPress={() =>
                          openUrl(props.store.oauth().url).catch(() => {})
                        }
                      />
                    </If>
                    <TextField
                      label="若未自动重定向，请粘贴回调链接："
                      testID="oauth-callback-input"
                      value={oauthCallbackUrl()}
                      onChange={(v) => oauthCallbackUrl.set(v)}
                      placeholder="http://127.0.0.1:1455/auth/callback?code=..."
                    />
                    <View class="flex-row gap-2">
                      <ActionButton
                        label="提交回调链接"
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
                        label="取消授权"
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
                  请复制下方设备验证码，并在随后打开的浏览器验证页完成授权：
                </Text>
                <View class="items-center py-1">
                  <Text class="text-xl font-mono font-bold tracking-widest text-foreground">
                    {props.store.oauth().userCode || "----"}
                  </Text>
                </View>
                <View class="flex-row gap-2">
                  <ActionButton
                    label="复制验证码并打开浏览器"
                    kind="primary"
                    compact={true}
                    onPress={copyAndOpenDeviceOAuth}
                  />
                  <ActionButton
                    label="取消授权"
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
      <View class="flex-row items-center justify-between border-b border-border pb-2.5">
        <Text class="text-foreground text-sm font-semibold">生效模型</Text>
        <If
          when={isGloballyActiveChannel()}
          else={
            <Text class="text-muted-foreground text-xs">
              {props.store.llm().active
                ? `全局生效: ${props.store.llm().active?.modelId}`
                : "尚未设置全局模型"}
            </Text>
          }
        >
          <View class="flex-row items-center gap-1.5">
            <View class="w-1.5 h-1.5 rounded-full bg-verified" />
            <Text class="text-verified text-xs font-semibold">
              当前对话生效中
            </Text>
          </View>
        </If>
      </View>

      <View class="gap-1.5">
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
                  <Text
                    class={
                      active()
                        ? "text-primary-foreground font-mono text-sm font-medium"
                        : "text-foreground font-mono text-sm font-medium"
                    }
                    style={{ numberOfLines: 1, flexShrink: 1 }}
                  >
                    {m().id}
                  </Text>
                  <If when={m().reasoning}>
                    <View class="px-1.5 py-0.5 rounded-md bg-secondary">
                      <Text class="text-muted-foreground text-xs">思考</Text>
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
                        ? "选用"
                        : "设为待选"}
                    </Text>
                  }
                >
                  <View class="flex-row items-center gap-1.5">
                    <View class="w-1.5 h-1.5 rounded-full bg-verified" />
                    <Text class="text-primary-foreground text-xs font-bold">
                      使用中
                    </Text>
                  </View>
                </If>
              </Button>
            );
          }}
        </Each>
      </View>

      <View class="gap-2 border-t border-border pt-3">
        <TextField
          label="自定义模型 ID"
          testID="custom-extra-model-input"
          value={extraModelId()}
          onChange={(v) => extraModelId.set(v)}
          placeholder="输入模型 ID，如 glm-5-flash"
          onSubmit={handleAddCustomModel}
        />
        <View class="flex-row justify-end">
          <ActionButton
            label="添加并选用"
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
