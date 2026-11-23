import { randomUUID } from "node:crypto";
import {
  LLM_PROVIDER_CATALOG,
  VaultCredentialStore,
  createLooiModelsRegistry,
  resolveProviderBaseUrl,
  syncLooiModelsRegistry,
  type ActiveLlmSelection,
  type CompatibleApiProtocol,
  type CustomEndpointConfig,
  type LlmBrandId,
  type LlmChannelSpec,
  type ModelVaultEnvelope,
} from "@super-looi/runtime/agent/llm-providers";
import { uiMessage } from "../messages.js";
import { chooseConnectedModelId, fetchOnlineModels, type OnlineModel } from "../model-list.js";
import type { UiActionGuard, Vault } from "../vault.js";
import type { UserActionRef } from "@super-looi/contracts";
import { LlmOAuthFlow } from "./oauth.js";
import type {
  LlmBrandStatus,
  LlmCatalogSnapshot,
  LlmChannelStatus,
  LlmModelItem,
  LlmModelStreamConfig,
  LlmOAuthUiEvent,
  ModelConfiguration,
} from "./types.js";

type MutableModels = ReturnType<typeof createLooiModelsRegistry>;
type Credential = ModelVaultEnvelope["credentials"][string];

export interface ConversationState {
  id: string;
  persisted: boolean;
}

export interface LlmModelManagerHooks {
  vault: Vault;
  assertUiAction: UiActionGuard;
  isClosed: () => boolean;
  isForegroundBusy: () => boolean;
  hasExecutor: () => boolean;
  getConversationState: () => ConversationState;
  setConversationState: (state: ConversationState) => void;
  onBeforeExecutorRebuild: () => Promise<void>;
  onSelectionCommitted: (selection: ActiveLlmSelection) => void;
}

/**
 * Owns the LLM provider catalog, credential CRUD, online model list caching,
 * transactional vault updates with executor rollback, and provider OAuth orchestration.
 */
export class LlmModelManager {
  readonly store: VaultCredentialStore;
  readonly registry: MutableModels;
  private readonly fetchedModels = new Map<string, OnlineModel[]>();
  private readonly modelFetchErrors = new Map<string, string>();
  private readonly modelFetchVersions = new Map<string, number>();
  private readonly oauth = new LlmOAuthFlow();
  private mutating = false;

  constructor(private readonly hooks: LlmModelManagerHooks) {
    this.store = new VaultCredentialStore(hooks.vault, {
      conversationId: () => this.hooks.getConversationState().id,
    });
    this.registry = createLooiModelsRegistry(this.store);
  }

  get isBusy(): boolean {
    return this.mutating || this.oauth.isActive;
  }

  get isOAuthActive(): boolean {
    return this.oauth.isActive;
  }

  private assertCanMutate(allowDuringOAuth = false): void {
    if (
      this.hooks.isClosed() ||
      this.hooks.isForegroundBusy() ||
      this.mutating ||
      (!allowDuringOAuth && this.oauth.isActive)
    ) {
      throw new Error("@looi:runtimeStopTheCurrentTaskOrCancelSigninFirst");
    }
  }

  private findChannel(providerId: string): LlmChannelSpec {
    for (const brand of LLM_PROVIDER_CATALOG) {
      const channel = brand.channels.find((c) => c.providerId === providerId);
      if (channel) return channel;
    }
    throw new Error(uiMessage("unknownProvider", { provider: providerId }));
  }

  private isSelectableSelection(
    envelope: ModelVaultEnvelope,
    selection?: ActiveLlmSelection,
  ): selection is ActiveLlmSelection {
    if (!selection || !envelope.credentials[selection.providerId]) {
      return false;
    }
    if (selection.providerId === "custom") {
      return this.isValidCustomEndpoint(envelope.custom);
    }
    return true;
  }

  private validateLegacyConfig(config: ModelConfiguration): ModelConfiguration {
    if (
      typeof config?.baseUrl !== "string" ||
      typeof config.model !== "string" ||
      typeof config.apiKey !== "string"
    ) {
      throw new Error("@looi:runtimeModelSettingsAreIncomplete");
    }
    let url: URL;
    try {
      url = new URL(config.baseUrl);
    } catch {
      throw new Error("@looi:runtimeUseAnHttpsModelUrlWithoutCredentialsOr");
    }
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error("@looi:runtimeUseAnHttpsModelUrlWithoutCredentialsOr");
    }
    if (
      !config.model.trim() ||
      config.model.length > 256 ||
      !config.apiKey.trim() ||
      config.apiKey.length > 8192
    ) {
      throw new Error("@looi:runtimeEnterAModelNameAndApiKey");
    }
    return {
      baseUrl: url.href.replace(/\/$/, ""),
      model: config.model.trim(),
      apiKey: config.apiKey.trim(),
    };
  }

  isValidCustomEndpoint(custom?: CustomEndpointConfig): boolean {
    if (
      !custom ||
      typeof custom.baseUrl !== "string" ||
      typeof custom.modelId !== "string"
    ) {
      return false;
    }
    let url: URL;
    try {
      url = new URL(custom.baseUrl);
    } catch {
      return false;
    }
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return false;
    }
    return Boolean(custom.modelId.trim() && custom.modelId.length <= 256);
  }

  private validateCustomEndpoint(
    custom?: CustomEndpointConfig,
  ): CustomEndpointConfig {
    if (
      !custom ||
      typeof custom.baseUrl !== "string" ||
      typeof custom.modelId !== "string"
    ) {
      throw new Error("@looi:runtimeCustomEndpointSettingsAreIncomplete");
    }
    let url: URL;
    try {
      url = new URL(custom.baseUrl);
    } catch {
      throw new Error("@looi:runtimeUseAnHttpsModelUrlWithoutCredentialsOr");
    }
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error("@looi:runtimeUseAnHttpsModelUrlWithoutCredentialsOr");
    }
    const model = custom.modelId.trim();
    if (!model || model.length > 256) throw new Error("@looi:runtimeEnterAModelName");
    const validProtocols: CompatibleApiProtocol[] = [
      "openai-completions",
      "openai-responses",
      "anthropic-messages",
    ];
    const api = validProtocols.includes(custom.api)
      ? custom.api
      : "openai-completions";
    return {
      api,
      baseUrl: url.href.replace(/\/$/, ""),
      modelId: model,
    };
  }

  private invalidateFetchedModels(providerId: string): number {
    const version = (this.modelFetchVersions.get(providerId) ?? 0) + 1;
    this.modelFetchVersions.set(providerId, version);
    this.fetchedModels.delete(providerId);
    this.modelFetchErrors.delete(providerId);
    return version;
  }

  private async commitVaultTransaction(options: {
    willRebuildExecutor: boolean;
    nextConversationId?: string;
    signal?: AbortSignal;
    mutate: (draft: ModelVaultEnvelope) => ModelVaultEnvelope;
  }): Promise<ModelVaultEnvelope> {
    const prevEnvelope = this.store.readEnvelope();
    const prevConversation = this.hooks.getConversationState();

    this.mutating = true;
    try {
      let nextEnvelope: ModelVaultEnvelope;
      try {
        if (options.willRebuildExecutor) {
          await this.hooks.onBeforeExecutorRebuild();
        }
        if (this.hooks.isClosed()) throw new Error("@looi:runtimePageClosed");
        options.signal?.throwIfAborted();
        nextEnvelope = await this.store.updateEnvelopeAsync(
          options.mutate,
          options.signal ? { signal: options.signal } : undefined,
        );
      } catch (error) {
        // Restore prior conversation, registry, and executor so vault errors never brick runtime.
        this.hooks.setConversationState(prevConversation);
        syncLooiModelsRegistry(this.registry, prevEnvelope);
        if (
          options.willRebuildExecutor &&
          !this.hooks.isClosed() &&
          this.isSelectableSelection(prevEnvelope, prevEnvelope.active)
        ) {
          this.hooks.onSelectionCommitted(prevEnvelope.active);
        }
        throw error;
      }

      if (options.nextConversationId) {
        this.hooks.setConversationState({
          id: options.nextConversationId,
          persisted: true,
        });
      }
      syncLooiModelsRegistry(this.registry, nextEnvelope);
      if (
        options.willRebuildExecutor &&
        !this.hooks.isClosed() &&
        this.isSelectableSelection(nextEnvelope, nextEnvelope.active)
      ) {
        this.hooks.onSelectionCommitted(nextEnvelope.active);
      }
      return nextEnvelope;
    } finally {
      this.mutating = false;
    }
  }

  configuration(): { baseUrl: string; model: string; hasKey: boolean } {
    const envelope = this.store.readEnvelope();
    if (envelope.active) {
      const providerId = envelope.active.providerId;
      const baseUrl =
        providerId === "custom"
          ? (envelope.custom?.baseUrl ?? "")
          : (resolveProviderBaseUrl(providerId) ??
            envelope.custom?.baseUrl ??
            "");
      return {
        baseUrl,
        model: envelope.active.modelId ?? "",
        hasKey: Boolean(envelope.credentials[providerId]),
      };
    }
    return {
      baseUrl: envelope.custom?.baseUrl ?? "",
      model: envelope.custom?.modelId ?? "",
      hasKey: Boolean(envelope.credentials["custom"]),
    };
  }

  resolveStreamConfig(): LlmModelStreamConfig | undefined {
    const envelope = this.store.readEnvelope();
    const active = envelope.active;
    if (!active) return undefined;
    const cred = envelope.credentials[active.providerId];
    if (!cred) return undefined;
    if (
      active.providerId === "custom" &&
      !this.isValidCustomEndpoint(envelope.custom)
    ) {
      return undefined;
    }
    let apiKey: string | undefined;
    if (cred.type === "api_key" && cred.key) {
      apiKey = cred.key;
    } else if (cred.type === "oauth") {
      const oauth = cred as unknown as { access?: string };
      if (oauth.access) apiKey = oauth.access;
    }
    const baseUrl =
      active.providerId === "custom"
        ? envelope.custom?.baseUrl
        : resolveProviderBaseUrl(active.providerId);
    return {
      modelsRegistry: this.registry,
      providerId: active.providerId,
      model: active.modelId,
      ...(apiKey ? { apiKey } : {}),
      ...(baseUrl ? { baseUrl } : {}),
    };
  }

  secretValues(): string[] {
    const secrets: string[] = [];
    const envelope = this.store.readEnvelope();
    for (const cred of Object.values(envelope.credentials)) {
      if (!cred) continue;
      if (cred.type === "api_key" && cred.key && cred.key.length >= 4) {
        secrets.push(cred.key);
      } else if (cred.type === "oauth") {
        const oauth = cred as unknown as { access?: string; refresh?: string };
        if (oauth.access && oauth.access.length >= 4) {
          secrets.push(oauth.access);
        }
        if (oauth.refresh && oauth.refresh.length >= 4) {
          secrets.push(oauth.refresh);
        }
      }
    }
    return secrets;
  }

  snapshot(): LlmCatalogSnapshot {
    const envelope = this.store.readEnvelope();
    const customModelsMap = envelope.customModelsByProvider ?? {};

    const brands: LlmBrandStatus[] = LLM_PROVIDER_CATALOG.map((brandSpec) => {
      const channels: LlmChannelStatus[] = brandSpec.channels.map((ch) => {
        const cred = envelope.credentials[ch.providerId];
        const hasApiKey = cred?.type === "api_key";
        const hasOAuth = cred?.type === "oauth";
        const oauthExpiresAt =
          cred?.type === "oauth" && typeof cred.expires === "number"
            ? cred.expires
            : null;

        const customIds = new Set(customModelsMap[ch.providerId] ?? []);
        const activeIdOnChannel =
          envelope.active?.providerId === ch.providerId
            ? envelope.active.modelId
            : "";
        const visibleModels = new Map<string, { id: string; name: string }>();
        if (hasApiKey || hasOAuth) {
          for (const model of this.fetchedModels.get(ch.providerId) ?? []) {
            visibleModels.set(model.id, model);
          }
          for (const id of customIds) {
            if (!visibleModels.has(id)) visibleModels.set(id, { id, name: id });
          }
          if (
            activeIdOnChannel &&
            !this.fetchedModels.has(ch.providerId) &&
            !this.modelFetchErrors.has(ch.providerId) &&
            !visibleModels.has(activeIdOnChannel)
          ) {
            visibleModels.set(activeIdOnChannel, {
              id: activeIdOnChannel,
              name: activeIdOnChannel,
            });
          }
        }
        const models: LlmModelItem[] = [...visibleModels.values()]
          .map((m) => {
            const known = this.registry.getModel(ch.providerId, m.id);
            return {
              id: m.id,
              name: m.name,
              reasoning: Boolean(known?.reasoning),
              contextWindow: known?.contextWindow ?? 32768,
              isCustom: customIds.has(m.id) || ch.providerId === "custom",
            };
          })
          .sort((a, b) => {
            const rank = (item: LlmModelItem) => {
              if (activeIdOnChannel && item.id === activeIdOnChannel) return 0;
              if (item.id === ch.defaultModelId) return 1;
              if (item.isCustom) return 2;
              return 3;
            };
            return rank(a) - rank(b);
          });

        const baseUrl =
          ch.providerId === "custom"
            ? (envelope.custom?.baseUrl ?? "")
            : ch.baseUrl;

        return {
          providerId: ch.providerId,
          label: ch.label,
          baseUrl,
          protocolLabel: ch.protocolLabel,
          authTypes: [...ch.authTypes] as Array<"api_key" | "oauth">,
          defaultModelId: ch.defaultModelId,
          hasApiKey,
          hasOAuth,
          oauthExpiresAt,
          models,
          modelsFetched: this.fetchedModels.has(ch.providerId),
          modelsError: this.modelFetchErrors.get(ch.providerId),
        };
      });

      const configured = channels.some((c) => c.hasApiKey || c.hasOAuth);

      return {
        brandId: brandSpec.brandId,
        label: brandSpec.label,
        shortLabel: brandSpec.shortLabel,
        configured,
        channels,
      };
    });

    let active: LlmCatalogSnapshot["active"] = null;
    if (envelope.active) {
      let activeBrandId: LlmBrandId = "custom";
      for (const b of LLM_PROVIDER_CATALOG) {
        if (
          b.channels.some((c) => c.providerId === envelope.active!.providerId)
        ) {
          activeBrandId = b.brandId;
          break;
        }
      }
      active = {
        brandId: activeBrandId,
        providerId: envelope.active.providerId,
        modelId: envelope.active.modelId,
        authType: envelope.active.authType === "oauth" ? "oauth" : "api_key",
      };
    }

    return {
      brands,
      active,
      custom: envelope.custom ?? {
        api: "openai-completions",
        baseUrl: "",
        modelId: "",
      },
    };
  }

  async refreshModels(
    providerId: string,
    signal?: AbortSignal,
  ): Promise<LlmCatalogSnapshot> {
    const envelope = this.store.readEnvelope();
    const credential = envelope.credentials[providerId];
    if (!credential) return this.snapshot();
    const channel = this.findChannel(providerId);

    const version = this.invalidateFetchedModels(providerId);
    try {
      const auth = await this.registry.getAuth(providerId, { signal });
      if (!auth) throw new Error("@looi:runtimeConnectAModelServiceFirst");
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(auth.auth.headers ?? {})) {
        if (value !== null) headers[name] = value;
      }
      if (auth.auth.apiKey) headers.Authorization = `Bearer ${auth.auth.apiKey}`;
      const baseUrl =
        providerId === "custom" ? envelope.custom?.baseUrl : channel.baseUrl;
      if (!baseUrl) return this.snapshot();
      const knownChatIds =
        credential.type === "api_key"
          ? new Set(this.registry.getModels(providerId).map((model) => model.id))
          : undefined;
      const models = await fetchOnlineModels(baseUrl, headers, {
        knownChatIds,
        signal,
      });
      signal?.throwIfAborted();
      if (this.modelFetchVersions.get(providerId) !== version) {
        return this.snapshot();
      }
      this.fetchedModels.set(providerId, models);
    } catch (error) {
      if (signal?.aborted) throw error;
      if (this.modelFetchVersions.get(providerId) === version) {
        this.modelFetchErrors.set(
          providerId,
          error instanceof Error ? error.message : "@looi:runtimeCouldNotLoadOnlineModels",
        );
      }
    }
    return this.snapshot();
  }

  async configureLegacy(input: ModelConfiguration): Promise<void> {
    this.assertCanMutate();
    const prevEnvelope = this.store.readEnvelope();
    const existingCustomKey =
      prevEnvelope.credentials.custom?.type === "api_key"
        ? (prevEnvelope.credentials.custom.key ?? "")
        : "";
    let sameOrigin = false;
    if (prevEnvelope.custom?.baseUrl && existingCustomKey) {
      try {
        sameOrigin =
          new URL(input.baseUrl).origin ===
          new URL(prevEnvelope.custom.baseUrl).origin;
      } catch {
        sameOrigin = false;
      }
    }
    const next = this.validateLegacyConfig({
      ...input,
      apiKey: input.apiKey || (sameOrigin ? existingCustomKey : ""),
    });
    const conversationId = `session_${randomUUID()}`;
    await this.commitVaultTransaction({
      willRebuildExecutor: true,
      nextConversationId: conversationId,
      mutate: (draft) => {
        draft.conversationId = conversationId;
        draft.custom = {
          api: draft.custom?.api ?? "openai-completions",
          baseUrl: next.baseUrl,
          modelId: next.model,
        };
        draft.credentials.custom = {
          type: "api_key",
          key: next.apiKey,
        };
        draft.active = {
          providerId: "custom",
          modelId: next.model,
          authType: "api_key",
        };
        return draft;
      },
    });
  }

  async saveApiKey(
    input: {
      providerId: string;
      apiKey?: string;
      modelId?: string;
      custom?: CustomEndpointConfig;
      setActive?: boolean;
    },
    action: UserActionRef,
  ): Promise<LlmCatalogSnapshot> {
    this.assertCanMutate();
    this.hooks.assertUiAction(action);

    const targetChannel = this.findChannel(input.providerId);
    const validatedCustom =
      input.providerId === "custom"
        ? this.validateCustomEndpoint(input.custom)
        : undefined;

    const envelope = this.store.readEnvelope();
    const existingCred = envelope.credentials[input.providerId];
    let nextCred: Credential;
    const trimmedKey = input.apiKey?.trim();
    if (trimmedKey) {
      if (trimmedKey.length > 8192) throw new Error("@looi:runtimeApiKeyIsTooLong");
      nextCred = { type: "api_key", key: trimmedKey };
    } else if (existingCred) {
      nextCred = existingCred;
    } else {
      throw new Error("@looi:runtimeEnterAnApiKey");
    }

    const targetModelId =
      input.modelId?.trim() ||
      (input.providerId === "custom" ? validatedCustom?.modelId : "") ||
      targetChannel.defaultModelId;
    if (!targetModelId) throw new Error("@looi:runtimeSelectOrEnterAModelId");

    const isKnownModel = Boolean(
      this.registry.getModel(input.providerId, targetModelId),
    );
    const shouldSetActive = input.setActive !== false;
    const willRebuildExecutor =
      shouldSetActive || envelope.active?.providerId === input.providerId;
    const nextConversationId = shouldSetActive
      ? `session_${randomUUID()}`
      : undefined;

    await this.commitVaultTransaction({
      willRebuildExecutor,
      nextConversationId,
      mutate: (draft) => {
        draft.credentials[input.providerId] = nextCred;
        if (validatedCustom) {
          draft.custom = validatedCustom;
        }
        if (
          input.providerId !== "custom" &&
          !isKnownModel &&
          !this.fetchedModels.get(input.providerId)?.some((model) => model.id === targetModelId)
        ) {
          draft.customModelsByProvider ??= {};
          draft.customModelsByProvider[input.providerId] ??= [];
          if (
            !draft.customModelsByProvider[input.providerId].includes(
              targetModelId,
            )
          ) {
            draft.customModelsByProvider[input.providerId].push(targetModelId);
          }
        }
        if (shouldSetActive && nextConversationId) {
          draft.conversationId = nextConversationId;
          draft.active = {
            providerId: input.providerId,
            modelId: targetModelId,
            authType: nextCred.type,
          };
        }
        return draft;
      },
    });

    this.invalidateFetchedModels(input.providerId);
    return this.snapshot();
  }

  async selectActive(
    input: { providerId: string; modelId: string; addCustomModel?: boolean },
    action: UserActionRef,
  ): Promise<LlmCatalogSnapshot> {
    this.assertCanMutate();
    this.hooks.assertUiAction(action);

    const envelope = this.store.readEnvelope();
    const cred = envelope.credentials[input.providerId];
    if (!cred) throw new Error("@looi:runtimeConfigureThisProvidersApiKeyOrSignIn");

    const targetModelId = input.modelId.trim();
    if (!targetModelId) throw new Error("@looi:runtimeSelectOrEnterAModelId");

    const isKnownModel = Boolean(
      this.registry.getModel(input.providerId, targetModelId),
    );
    const changed =
      envelope.active?.providerId !== input.providerId ||
      envelope.active?.modelId !== targetModelId;
    const willRebuild = changed || !this.hooks.hasExecutor();
    const nextConversationId = changed ? `session_${randomUUID()}` : undefined;

    await this.commitVaultTransaction({
      willRebuildExecutor: willRebuild,
      nextConversationId,
      mutate: (draft) => {
        if (
          !isKnownModel &&
          input.providerId !== "custom" &&
          !this.fetchedModels.get(input.providerId)?.some((model) => model.id === targetModelId)
        ) {
          draft.customModelsByProvider ??= {};
          draft.customModelsByProvider[input.providerId] ??= [];
          if (
            !draft.customModelsByProvider[input.providerId].includes(
              targetModelId,
            )
          ) {
            draft.customModelsByProvider[input.providerId].push(targetModelId);
          }
        }
        if (input.providerId === "custom" && draft.custom) {
          draft.custom.modelId = targetModelId;
        }
        if (changed && nextConversationId) {
          draft.conversationId = nextConversationId;
        }
        draft.active = {
          providerId: input.providerId,
          modelId: targetModelId,
          authType: cred.type,
        };
        return draft;
      },
    });

    return this.snapshot();
  }

  async removeCredential(
    providerId: string,
    action: UserActionRef,
  ): Promise<LlmCatalogSnapshot> {
    this.assertCanMutate();
    this.hooks.assertUiAction(action);

    const envelope = this.store.readEnvelope();
    const isActive = envelope.active?.providerId === providerId;
    const nextConversationId = isActive ? `session_${randomUUID()}` : undefined;

    await this.commitVaultTransaction({
      willRebuildExecutor: isActive,
      nextConversationId,
      mutate: (draft) => {
        delete draft.credentials[providerId];
        if (draft.active?.providerId === providerId) {
          draft.active = undefined;
          if (nextConversationId) {
            draft.conversationId = nextConversationId;
          }
        }
        return draft;
      },
    });

    this.invalidateFetchedModels(providerId);
    return this.snapshot();
  }

  async startOAuth(
    providerId: string,
    action: UserActionRef,
    onEvent: (event: LlmOAuthUiEvent) => void,
  ): Promise<LlmCatalogSnapshot> {
    this.assertCanMutate();
    this.hooks.assertUiAction(action);
    const targetChannel = this.findChannel(providerId);

    await this.oauth.run({
      providerId,
      modelsRegistry: this.registry,
      getDeviceId: () => this.store.readEnvelope().deviceId,
      onEvent,
      afterLogin: async (signal) => {
        signal.throwIfAborted();
        await this.refreshModels(providerId, signal);
        const envelope = this.store.readEnvelope();
        const targetModelId = chooseConnectedModelId(
          this.fetchedModels.get(providerId),
          envelope.active?.providerId === providerId ? envelope.active.modelId : "",
          targetChannel.defaultModelId,
          this.registry.getModels(providerId)[0]?.id ?? "",
        );
        const conversationId = `session_${randomUUID()}`;
        await this.commitVaultTransaction({
          willRebuildExecutor: true,
          nextConversationId: conversationId,
          signal,
          mutate: (draft) => {
            draft.conversationId = conversationId;
            draft.active = {
              providerId,
              modelId: targetModelId,
              authType: "oauth",
            };
            return draft;
          },
        });
      },
    });

    return this.snapshot();
  }

  submitOAuthCallback(callbackUrl: string): void {
    this.oauth.submitCallback(callbackUrl);
  }

  cancelOAuth(): void {
    this.oauth.cancel();
  }
}
