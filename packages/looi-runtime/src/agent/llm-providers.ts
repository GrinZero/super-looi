import { randomUUID } from "node:crypto";
import {
  createModels,
  createProvider,
  envApiKeyAuth,
  type Api,
  type AuthContext,
  type AuthOperationOptions,
  type AuthType,
  type Credential,
  type CredentialInfo,
  type CredentialStore,
  type Model,
  type MutableModels,
  type Provider,
} from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { kimiCodingProvider } from "@earendil-works/pi-ai/providers/kimi-coding";
import { moonshotaiCnProvider } from "@earendil-works/pi-ai/providers/moonshotai-cn";
import { moonshotaiProvider } from "@earendil-works/pi-ai/providers/moonshotai";
import { minimaxCnProvider } from "@earendil-works/pi-ai/providers/minimax-cn";
import { minimaxProvider } from "@earendil-works/pi-ai/providers/minimax";
import { xiaomiProvider } from "@earendil-works/pi-ai/providers/xiaomi";
import { xiaomiTokenPlanCnProvider } from "@earendil-works/pi-ai/providers/xiaomi-token-plan-cn";
import { xiaomiTokenPlanSgpProvider } from "@earendil-works/pi-ai/providers/xiaomi-token-plan-sgp";
import { xiaomiTokenPlanAmsProvider } from "@earendil-works/pi-ai/providers/xiaomi-token-plan-ams";
import { zaiCodingCnProvider } from "@earendil-works/pi-ai/providers/zai-coding-cn";
import { ZAI_CODING_CN_MODELS } from "@earendil-works/pi-ai/providers/zai-coding-cn.models";
import { zaiProvider } from "@earendil-works/pi-ai/providers/zai";
import { ZAI_MODELS } from "@earendil-works/pi-ai/providers/zai.models";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";

let bunOAuthRegistered = false;

/**
 * Statically registers bundled OAuth flow loaders (OpenAI ChatGPT, Kimi Code, etc.).
 * Idempotent: safe to call multiple times.
 */
export function registerLooiBundledOAuthFlows(): void {
  if (bunOAuthRegistered) return;
  registerBunOAuthFlows();
  bunOAuthRegistered = true;
}

export type LlmBrandId =
  | "openai"
  | "kimi"
  | "minimax"
  | "xiaomi"
  | "zai"
  | "custom";

export type CompatibleApiProtocol =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages";

export interface LlmChannelSpec {
  providerId: string;
  label: string;
  baseUrl: string;
  protocolLabel: string;
  authTypes: readonly AuthType[];
  defaultModelId: string;
  hint?: string;
}

export interface LlmBrandSpec {
  brandId: LlmBrandId;
  label: string;
  shortLabel: string;
  channels: readonly LlmChannelSpec[];
}

export const LLM_PROVIDER_CATALOG: readonly LlmBrandSpec[] = [
  {
    brandId: "openai",
    label: "OpenAI / ChatGPT",
    shortLabel: "OpenAI",
    channels: [
      {
        providerId: "openai",
        label: "官方 API / ChatGPT 订阅",
        baseUrl: "https://api.openai.com/v1",
        protocolLabel: "OpenAI Responses",
        authTypes: ["oauth", "api_key"],
        defaultModelId: "gpt-5.4",
      },
    ],
  },
  {
    brandId: "kimi",
    label: "Kimi",
    shortLabel: "Kimi",
    channels: [
      {
        providerId: "kimi-coding",
        label: "Kimi Code (会员订阅)",
        baseUrl: "https://api.kimi.com/coding/v1",
        protocolLabel: "OpenAI Chat Completions",
        authTypes: ["oauth", "api_key"],
        defaultModelId: "k3.1-pro",
      },
      {
        providerId: "moonshotai-cn",
        label: "Moonshot 开放平台 (国内)",
        baseUrl: "https://api.moonshot.cn/v1",
        protocolLabel: "OpenAI Chat Completions",
        authTypes: ["api_key"],
        defaultModelId: "kimi-k3.1-pro",
      },
      {
        providerId: "moonshotai",
        label: "Moonshot 开放平台 (国际)",
        baseUrl: "https://api.moonshot.ai/v1",
        protocolLabel: "OpenAI Chat Completions",
        authTypes: ["api_key"],
        defaultModelId: "kimi-k3.1-pro",
      },
    ],
  },
  {
    brandId: "minimax",
    label: "MiniMax",
    shortLabel: "MiniMax",
    channels: [
      {
        providerId: "minimax-cn",
        label: "国内站 (minimaxi.com)",
        baseUrl: "https://api.minimaxi.com/anthropic",
        protocolLabel: "Anthropic Messages",
        authTypes: ["api_key"],
        defaultModelId: "MiniMax-M3.1-Flash",
      },
      {
        providerId: "minimax",
        label: "国际站 (minimax.io)",
        baseUrl: "https://api.minimax.io/anthropic",
        protocolLabel: "Anthropic Messages",
        authTypes: ["api_key"],
        defaultModelId: "MiniMax-M3.1-Flash",
      },
    ],
  },
  {
    brandId: "xiaomi",
    label: "小米 MiMo",
    shortLabel: "小米",
    channels: [
      {
        providerId: "xiaomi",
        label: "普通按量 API",
        baseUrl: "https://api.xiaomimimo.com/v1",
        protocolLabel: "OpenAI Chat Completions",
        authTypes: ["api_key"],
        defaultModelId: "mimo-v2.6-flash",
      },
      {
        providerId: "xiaomi-token-plan-cn",
        label: "Token Plan (国内)",
        baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
        protocolLabel: "OpenAI Chat Completions",
        authTypes: ["api_key"],
        defaultModelId: "mimo-v2.6-flash",
      },
      {
        providerId: "xiaomi-token-plan-sgp",
        label: "Token Plan (新加坡)",
        baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
        protocolLabel: "OpenAI Chat Completions",
        authTypes: ["api_key"],
        defaultModelId: "mimo-v2.6-flash",
      },
      {
        providerId: "xiaomi-token-plan-ams",
        label: "Token Plan (欧洲)",
        baseUrl: "https://token-plan-ams.xiaomimimo.com/v1",
        protocolLabel: "OpenAI Chat Completions",
        authTypes: ["api_key"],
        defaultModelId: "mimo-v2.6-flash",
      },
    ],
  },
  {
    brandId: "zai",
    label: "智谱 / Z.AI",
    shortLabel: "智谱",
    channels: [
      {
        providerId: "zai-cn",
        label: "标准 API (国内 BigModel)",
        baseUrl: "https://open.bigmodel.cn/api/paas/v4",
        protocolLabel: "OpenAI Chat Completions",
        authTypes: ["api_key"],
        defaultModelId: "glm-5.3-flash",
      },
      {
        providerId: "zai-intl",
        label: "标准 API (国际 Z.AI)",
        baseUrl: "https://api.z.ai/api/paas/v4",
        protocolLabel: "OpenAI Chat Completions",
        authTypes: ["api_key"],
        defaultModelId: "glm-5.3-flash",
      },
      {
        providerId: "zai-coding-cn",
        label: "Coding Plan 专属 (国内)",
        baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
        protocolLabel: "OpenAI Chat Completions",
        authTypes: ["api_key"],
        defaultModelId: "glm-5.3-flash",
      },
      {
        providerId: "zai",
        label: "Coding Plan 专属 (国际)",
        baseUrl: "https://api.z.ai/api/coding/paas/v4",
        protocolLabel: "OpenAI Chat Completions",
        authTypes: ["api_key"],
        defaultModelId: "glm-5.3-flash",
      },
    ],
  },
  {
    brandId: "custom",
    label: "+ 兼容 API",
    shortLabel: "兼容",
    channels: [
      {
        providerId: "custom",
        label: "自定义兼容端点",
        baseUrl: "",
        protocolLabel: "可切换协议",
        authTypes: ["api_key"],
        defaultModelId: "",
      },
    ],
  },
] as const;

const KNOWN_PROVIDER_BASE_URLS = new Map<string, string>();
for (const brand of LLM_PROVIDER_CATALOG) {
  for (const channel of brand.channels) {
    if (channel.baseUrl) {
      KNOWN_PROVIDER_BASE_URLS.set(channel.providerId, channel.baseUrl);
    }
  }
}

export function resolveProviderBaseUrl(providerId?: string): string | undefined {
  if (!providerId) return undefined;
  return KNOWN_PROVIDER_BASE_URLS.get(providerId);
}

export interface CustomEndpointConfig {
  api: CompatibleApiProtocol;
  baseUrl: string;
  modelId: string;
}

export interface ActiveLlmSelection {
  providerId: string;
  modelId: string;
  authType: AuthType;
}

export interface ModelVaultEnvelope {
  version: 2;
  deviceId: string;
  conversationId: string;
  active?: ActiveLlmSelection;
  custom?: CustomEndpointConfig;
  customModelsByProvider?: Record<string, string[]>;
  credentials: Record<string, Credential>;
  /** Mirror fields for legacy compatibility checks (e.g. JSON.parse(saved).model). */
  baseUrl?: string;
  model?: string;
}

export function parseModelVaultEnvelope(
  raw: string,
  createIds?: { deviceId?: () => string; conversationId?: () => string },
): ModelVaultEnvelope {
  const genDeviceId = () => createIds?.deviceId?.() ?? randomUUID();
  const genConversationId = () =>
    createIds?.conversationId?.() ?? `session_${randomUUID()}`;

  let parsed: any;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      version: 2,
      deviceId: genDeviceId(),
      conversationId: genConversationId(),
      credentials: {},
    };
  }

  if (parsed.version === 2) {
    return {
      version: 2,
      deviceId:
        typeof parsed.deviceId === "string" && parsed.deviceId
          ? parsed.deviceId
          : genDeviceId(),
      conversationId:
        typeof parsed.conversationId === "string" && parsed.conversationId
          ? parsed.conversationId
          : genConversationId(),
      credentials:
        parsed.credentials &&
        typeof parsed.credentials === "object" &&
        !Array.isArray(parsed.credentials)
          ? { ...parsed.credentials }
          : {},
      active:
        parsed.active && typeof parsed.active === "object"
          ? { ...parsed.active }
          : undefined,
      custom:
        parsed.custom && typeof parsed.custom === "object"
          ? { ...parsed.custom }
          : undefined,
      customModelsByProvider:
        parsed.customModelsByProvider &&
        typeof parsed.customModelsByProvider === "object"
          ? { ...parsed.customModelsByProvider }
          : undefined,
      baseUrl: typeof parsed.baseUrl === "string" ? parsed.baseUrl : undefined,
      model: typeof parsed.model === "string" ? parsed.model : undefined,
    };
  }

  // Legacy configuration migration
  const conversationId =
    typeof parsed.conversationId === "string" && parsed.conversationId.trim()
      ? parsed.conversationId.trim()
      : genConversationId();

  const baseUrl = typeof parsed.baseUrl === "string" ? parsed.baseUrl.trim() : "";
  const model = typeof parsed.model === "string" ? parsed.model.trim() : "";
  const apiKey = typeof parsed.apiKey === "string" ? parsed.apiKey.trim() : "";

  const credentials: Record<string, Credential> = {};
  let custom: CustomEndpointConfig | undefined = undefined;
  let active: ActiveLlmSelection | undefined = undefined;

  if (baseUrl || model) {
    custom = {
      api: "openai-completions",
      baseUrl,
      modelId: model,
    };
  }

  if (apiKey) {
    credentials.custom = {
      type: "api_key",
      key: apiKey,
    };
  }

  if (baseUrl && model && apiKey) {
    active = {
      providerId: "custom",
      modelId: model,
      authType: "api_key",
    };
  }

  return {
    version: 2,
    deviceId: genDeviceId(),
    conversationId,
    credentials,
    custom,
    active,
    baseUrl: baseUrl || undefined,
    model: model || undefined,
  };
}

export function serializeModelVaultEnvelope(
  envelope: ModelVaultEnvelope,
): string {
  const activeModel = envelope.active?.modelId ?? envelope.custom?.modelId ?? "";
  const activeBaseUrl =
    (envelope.active?.providerId === "custom"
      ? envelope.custom?.baseUrl
      : resolveProviderBaseUrl(envelope.active?.providerId)) ??
    envelope.custom?.baseUrl ??
    "";

  const serialized: ModelVaultEnvelope = {
    ...envelope,
    version: 2,
    model: activeModel,
    baseUrl: activeBaseUrl,
  };
  return JSON.stringify(serialized);
}

export interface BackingVault {
  get(key: string): string;
  set(key: string, value: string): void;
  remove?(key: string): void;
}

export class VaultCredentialStore implements CredentialStore {
  /** Single mutex chain across the shared `"model"` vault slot prevents cross-provider RMW clobbering. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly vault: BackingVault,
    private readonly createIds?: {
      deviceId?: () => string;
      conversationId?: () => string;
    },
  ) {}

  private enqueue<T>(
    task: () => Promise<T>,
    options?: AuthOperationOptions,
  ): Promise<T> {
    const signal = options?.signal;
    const previous = this.chain;
    const queued = (async () => {
      await previous.catch(() => {});
      signal?.throwIfAborted();
      return task();
    })();
    this.chain = queued.catch(() => {});
    return queued;
  }

  readEnvelope(): ModelVaultEnvelope {
    const raw = this.vault.get("model");
    return parseModelVaultEnvelope(raw, this.createIds);
  }

  updateEnvelope(
    mutator: (draft: ModelVaultEnvelope) => ModelVaultEnvelope,
  ): ModelVaultEnvelope {
    const current = this.readEnvelope();
    const draft: ModelVaultEnvelope = JSON.parse(JSON.stringify(current));
    const next = mutator(draft);
    const serialized = serializeModelVaultEnvelope(next);
    this.vault.set("model", serialized);
    return next;
  }

  updateEnvelopeAsync(
    mutator: (
      draft: ModelVaultEnvelope,
    ) => ModelVaultEnvelope | Promise<ModelVaultEnvelope>,
    options?: AuthOperationOptions,
  ): Promise<ModelVaultEnvelope> {
    return this.enqueue(async () => {
      const current = this.readEnvelope();
      const draft: ModelVaultEnvelope = JSON.parse(JSON.stringify(current));
      const next = await mutator(draft);
      options?.signal?.throwIfAborted();
      const serialized = serializeModelVaultEnvelope(next);
      this.vault.set("model", serialized);
      return next;
    }, options);
  }

  async read(
    providerId: string,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    const envelope = this.readEnvelope();
    return envelope.credentials[providerId];
  }

  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    options?.signal?.throwIfAborted();
    const envelope = this.readEnvelope();
    return Object.entries(envelope.credentials).map(([providerId, cred]) => ({
      providerId,
      type: cred.type,
    }));
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    return this.enqueue(
      async () => {
        const envelope = this.readEnvelope();
        const current = envelope.credentials[providerId];
        const next = await fn(current);
        options?.signal?.throwIfAborted();
        if (next !== undefined) {
          envelope.credentials[providerId] = next;
          const serialized = serializeModelVaultEnvelope(envelope);
          this.vault.set("model", serialized);
        }
        return next ?? current;
      },
      options,
    );
  }

  delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    return this.enqueue(
      async () => {
        options?.signal?.throwIfAborted();
        const envelope = this.readEnvelope();
        if (providerId in envelope.credentials) {
          delete envelope.credentials[providerId];
          const serialized = serializeModelVaultEnvelope(envelope);
          this.vault.set("model", serialized);
        }
      },
      options,
    );
  }
}

function createZaiCnProvider(): Provider {
  const models: Model<Api>[] = Object.values(ZAI_CODING_CN_MODELS).map((m) => ({
    ...m,
    provider: "zai-cn",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
  }));
  return createProvider({
    id: "zai-cn",
    name: "Zhipu AI (BigModel)",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    auth: {
      apiKey: envApiKeyAuth("Zhipu AI API key", [
        "ZHIPU_API_KEY",
        "ZAI_CN_API_KEY",
      ]),
    },
    models,
    api: openAICompletionsApi(),
  });
}

function createZaiIntlProvider(): Provider {
  const models: Model<Api>[] = Object.values(ZAI_MODELS).map((m) => ({
    ...m,
    provider: "zai-intl",
    baseUrl: "https://api.z.ai/api/paas/v4",
  }));
  return createProvider({
    id: "zai-intl",
    name: "Z.AI",
    baseUrl: "https://api.z.ai/api/paas/v4",
    auth: {
      apiKey: envApiKeyAuth("Z.AI API key", ["ZAI_API_KEY"]),
    },
    models,
    api: openAICompletionsApi(),
  });
}

function getPresetProvider(providerId: string): Provider | undefined {
  switch (providerId) {
    case "openai":
      return openaiProvider();
    case "kimi-coding":
      return kimiCodingProvider();
    case "moonshotai-cn":
      return moonshotaiCnProvider();
    case "moonshotai":
      return moonshotaiProvider();
    case "minimax-cn":
      return minimaxCnProvider();
    case "minimax":
      return minimaxProvider();
    case "xiaomi":
      return xiaomiProvider();
    case "xiaomi-token-plan-cn":
      return xiaomiTokenPlanCnProvider();
    case "xiaomi-token-plan-sgp":
      return xiaomiTokenPlanSgpProvider();
    case "xiaomi-token-plan-ams":
      return xiaomiTokenPlanAmsProvider();
    case "zai-cn":
      return createZaiCnProvider();
    case "zai-intl":
      return createZaiIntlProvider();
    case "zai-coding-cn":
      return zaiCodingCnProvider();
    case "zai":
      return zaiProvider();
    default:
      return undefined;
  }
}

const PRESET_PROVIDER_IDS = [
  "openai",
  "kimi-coding",
  "moonshotai-cn",
  "moonshotai",
  "minimax-cn",
  "minimax",
  "xiaomi",
  "xiaomi-token-plan-cn",
  "xiaomi-token-plan-sgp",
  "xiaomi-token-plan-ams",
  "zai-cn",
  "zai-intl",
  "zai-coding-cn",
  "zai",
] as const;

function wrapProviderWithCustomModels(
  baseProvider: Provider,
  customModelIds?: readonly string[],
): Provider {
  if (!customModelIds || !customModelIds.length) return baseProvider;
  const existingModels = baseProvider.getModels();
  const existingIds = new Set(existingModels.map((m) => m.id));
  const template = existingModels[0];
  const addedModels: Model<Api>[] = [];

  for (const id of customModelIds) {
    const trimmed = id.trim();
    if (!trimmed || existingIds.has(trimmed)) continue;
    existingIds.add(trimmed);
    const model: Model<Api> = template
      ? {
          ...template,
          id: trimmed,
          name: trimmed,
        }
      : {
          id: trimmed,
          name: trimmed,
          api: "openai-completions",
          provider: baseProvider.id,
          baseUrl: baseProvider.baseUrl ?? "",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 32768,
          maxTokens: 4096,
        };
    addedModels.push(model);
  }

  if (!addedModels.length) return baseProvider;

  return {
    ...baseProvider,
    getModels: () => [...baseProvider.getModels(), ...addedModels],
    getAllModels: () =>
      baseProvider.getAllModels
        ? [...baseProvider.getAllModels(), ...addedModels]
        : [...baseProvider.getModels(), ...addedModels],
  };
}

function buildCustomProvider(
  config: CustomEndpointConfig,
  customModels?: readonly string[],
): Provider {
  const modelIds = new Set<string>();
  const initialId = config.modelId?.trim() || "custom-model";
  modelIds.add(initialId);

  if (customModels) {
    for (const m of customModels) {
      if (m?.trim()) modelIds.add(m.trim());
    }
  }

  const apiProtocol = config.api;
  const streamApi =
    apiProtocol === "openai-responses"
      ? openAIResponsesApi()
      : apiProtocol === "anthropic-messages"
        ? anthropicMessagesApi()
        : openAICompletionsApi();

  const models: Model<Api>[] = Array.from(modelIds).map((id) => ({
    id,
    name: id,
    api: apiProtocol,
    provider: "custom",
    baseUrl: config.baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32768,
    maxTokens: 4096,
    ...(apiProtocol === "openai-completions"
      ? {
          compat: {
            supportsDeveloperRole: false,
            supportsReasoningEffort: false,
            supportsStore: false,
            maxTokensField: "max_tokens",
          },
        }
      : {}),
  }));

  return createProvider({
    id: "custom",
    name: "Custom Compatible Gateway",
    baseUrl: config.baseUrl,
    auth: {
      apiKey: envApiKeyAuth("Custom Compatible API Key", [
        "CUSTOM_API_KEY",
        "LLM_API_KEY",
      ]),
    },
    models,
    api: streamApi,
  });
}

export function syncLooiModelsRegistry(
  models: MutableModels,
  envelope: ModelVaultEnvelope,
): void {
  for (const providerId of PRESET_PROVIDER_IDS) {
    const base = getPresetProvider(providerId);
    if (!base) continue;
    const customModels = envelope.customModelsByProvider?.[providerId];
    const wrapped = wrapProviderWithCustomModels(base, customModels);
    models.setProvider(wrapped);
  }

  if (envelope.custom?.baseUrl?.trim()) {
    const customModels = envelope.customModelsByProvider?.custom;
    const customProvider = buildCustomProvider(envelope.custom, customModels);
    models.setProvider(customProvider);
  } else {
    models.deleteProvider("custom");
  }
}

export function createLooiModelsRegistry(
  store: VaultCredentialStore,
  options?: { authContext?: AuthContext },
): MutableModels {
  registerLooiBundledOAuthFlows();
  const models = createModels({
    credentials: store,
    authContext: options?.authContext ?? {
      env: async () => undefined,
      fileExists: async () => false,
    },
  });

  const envelope = store.readEnvelope();
  syncLooiModelsRegistry(models, envelope);

  return models;
}
