import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { int, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { UserActionRef } from "@super-looi/contracts";
import { PiAgentExecutor } from "@super-looi/runtime/agent/pi-executor";
import type {
  AgentTask,
  AgentStepEvent,
  AgentInteractionAnswer,
} from "@super-looi/runtime/agent/executor";
import { SqliteRuntimeStore } from "@super-looi/runtime/storage/sqlite";
import { assertFreshUiAction } from "@super-looi/runtime/productivity/authorization";
import { AgentTaskStore } from "@super-looi/runtime/agent/task-store";
import {
  LLM_PROVIDER_CATALOG,
  VaultCredentialStore,
  createLooiModelsRegistry,
  syncLooiModelsRegistry,
  resolveProviderBaseUrl,
  type ActiveLlmSelection,
  type CompatibleApiProtocol,
  type CustomEndpointConfig,
  type LlmBrandId,
  type LlmChannelSpec,
  type ModelVaultEnvelope,
} from "@super-looi/runtime/agent/llm-providers";

import { HomeRuntime, type HomeSettings } from "./home.js";
import { chooseConnectedModelId, fetchOnlineModels, type OnlineModel } from "./model-list.js";

type MutableModels = ReturnType<typeof createLooiModelsRegistry>;
type Credential = ModelVaultEnvelope["credentials"][string];

export interface ModelConfiguration {
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface Vault {
  get(key: string): string;
  set(key: string, value: string): void;
  remove(key: string): void;
}

export type {
  LlmBrandId,
  CompatibleApiProtocol,
  CustomEndpointConfig,
  ActiveLlmSelection,
  ModelVaultEnvelope,
};

export interface LlmModelItem {
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  isCustom: boolean;
}

export interface LlmChannelStatus {
  providerId: string;
  label: string;
  baseUrl: string;
  protocolLabel: string;
  authTypes: Array<"api_key" | "oauth">;
  defaultModelId: string;
  hasApiKey: boolean;
  hasOAuth: boolean;
  oauthExpiresAt: number | null;
  models: LlmModelItem[];
  modelsFetched?: boolean;
  modelsError?: string;
}

export interface LlmBrandStatus {
  brandId: LlmBrandId;
  label: string;
  shortLabel: string;
  configured: boolean;
  channels: LlmChannelStatus[];
}

export interface LlmCatalogSnapshot {
  brands: LlmBrandStatus[];
  active: {
    brandId: LlmBrandId;
    providerId: string;
    modelId: string;
    authType: "api_key" | "oauth";
  } | null;
  custom: CustomEndpointConfig;
}

export type LlmOAuthUiEvent =
  | {
      kind: "device_code";
      userCode: string;
      verificationUri: string;
      expiresInSeconds?: number;
    }
  | { kind: "auth_url"; url: string; instructions?: string }
  | { kind: "awaiting_callback"; message: string; placeholder: string }
  | { kind: "progress"; message: string };

/** One foreground app owns the database and executor. No Hub endpoint exists. */
export class MobileRuntime {
  private readonly database = new DatabaseSync("/home/looi.sqlite");
  private readonly storage = new SqliteRuntimeStore(this.database);
  private readonly recoveredTasks = new AgentTaskStore(
    "/home/agent/tasks",
    this.storage.tasks,
  );
  private readonly home: HomeRuntime;
  private readonly credentialStore: VaultCredentialStore;
  private readonly modelsRegistry: MutableModels;
  private readonly fetchedModels = new Map<string, OnlineModel[]>();
  private readonly modelFetchErrors = new Map<string, string>();
  private readonly modelFetchVersions = new Map<string, number>();
  private executor?: PiAgentExecutor;
  private conversationId = `session_${randomUUID()}`;
  private conversationPersisted = false;
  private taskId?: string;
  private closed = false;
  private busy = false;
  private loginPending = false;
  private loginAttempt = 0;
  private closing?: Promise<void>;
  private llmOAuthAbort?: AbortController;
  private llmOAuthManualPrompt?: {
    resolve: (value: string) => void;
    reject: (error: Error) => void;
  };
  readonly uiSessionId = `ui_${randomUUID()}`;

  constructor(
    private readonly vault: Vault,
    private readonly releaseHost: () => void,
  ) {
    try {
      this.database.exec(
        "CREATE TABLE IF NOT EXISTS home_action_evidence (request_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, evidence TEXT NOT NULL)",
      );
      this.home = new HomeRuntime({ vault });
      this.credentialStore = new VaultCredentialStore(vault, {
        conversationId: () => this.conversationId,
      });
      this.modelsRegistry = createLooiModelsRegistry(this.credentialStore);

      const raw = vault.get("model");
      if (raw) {
        const stored = JSON.parse(raw);
        const envelope = this.credentialStore.readEnvelope();
        if (
          typeof stored?.conversationId === "string" &&
          /^[a-zA-Z0-9_-]{1,100}$/.test(stored.conversationId)
        ) {
          this.conversationId = stored.conversationId;
          this.conversationPersisted = true;
        }
        if (
          envelope.active &&
          envelope.credentials[envelope.active.providerId]
        ) {
          let customValid = true;
          if (envelope.active.providerId === "custom") {
            customValid = this.isValidCustomEndpoint(envelope.custom);
          }
          if (customValid) {
            syncLooiModelsRegistry(this.modelsRegistry, envelope);
            this.executor = this.createExecutorForSelection(envelope.active);
          }
        }
      }
    } catch (error) {
      this.storage.close();
      throw error;
    }
  }

  homeConfiguration() {
    return this.home.configuration();
  }

  homeConnection() {
    return this.home.connection();
  }

  async configureHome(input: HomeSettings, action: UserActionRef) {
    if (
      this.closed ||
      this.busy ||
      this.loginPending ||
      Boolean(this.llmOAuthAbort)
    )
      throw new Error("请先停止当前任务或取消登录");
    assertFreshUiAction(action);
    if (action.ui_session_id !== this.uiSessionId)
      throw new Error("页面已过期，请重新打开");
    const result = await this.home.configure(input);
    const envelope = this.credentialStore.readEnvelope();
    if (
      envelope.active &&
      envelope.credentials[envelope.active.providerId] &&
      !this.closed
    ) {
      await this.executor?.close();
      this.executor = this.createExecutorForSelection(envelope.active);
    }
    return result;
  }

  async connectHome() {
    if (this.loginPending) throw new Error("请先完成或取消米家登录");
    return this.home.connect();
  }

  async beginMiotLogin(
    region: NonNullable<HomeSettings["region"]>,
    action: UserActionRef,
  ) {
    if (
      this.closed ||
      this.busy ||
      this.loginPending ||
      Boolean(this.llmOAuthAbort)
    )
      throw new Error("请先停止当前任务或取消登录");
    assertFreshUiAction(action);
    if (action.ui_session_id !== this.uiSessionId)
      throw new Error("页面已过期，请重新打开");
    const attempt = ++this.loginAttempt;
    this.loginPending = true;
    try {
      const session = await this.home.beginMiotLogin(region);
      if (attempt !== this.loginAttempt || this.closed)
        throw new Error("米家登录已取消");
      return { ...session, attempt };
    } catch (error) {
      if (attempt === this.loginAttempt) this.cancelMiotLogin();
      throw error;
    }
  }

  async finishMiotLogin(
    attempt: number,
    callback: string,
    isCurrent: () => boolean,
  ) {
    if (!this.loginPending || attempt !== this.loginAttempt || this.closed)
      throw new Error("米家登录已取消");
    try {
      const result = this.home.interceptMiotCallback(callback);
      if (!result.intercepted || "error" in result)
        throw new Error("米家授权回调无效或已过期");
      return await this.home.finishMiotLogin(
        result.code,
        () =>
          this.loginPending &&
          attempt === this.loginAttempt &&
          !this.closed &&
          isCurrent(),
      );
    } catch (error) {
      if (attempt === this.loginAttempt) this.cancelMiotLogin();
      throw error;
    } finally {
      if (attempt === this.loginAttempt) this.loginPending = false;
    }
  }

  cancelMiotLogin() {
    ++this.loginAttempt;
    if (!this.loginPending) return;
    this.loginPending = false;
    // Invalidate the pending OAuth exchange and abort its native network request.
    this.home.suspend();
  }

  async logoutMiot(action: UserActionRef) {
    if (
      this.closed ||
      this.busy ||
      this.loginPending ||
      Boolean(this.llmOAuthAbort)
    )
      throw new Error("请先停止当前任务或取消登录");
    assertFreshUiAction(action);
    if (action.ui_session_id !== this.uiSessionId)
      throw new Error("页面已过期，请重新打开");
    await this.home.logoutMiot();
  }

  async listHome(query = "", offset = 0) {
    if (this.loginPending) throw new Error("请先完成或取消米家登录");
    return this.home.list(query, offset);
  }

  configuration(): { baseUrl: string; model: string; hasKey: boolean } {
    const envelope = this.credentialStore.readEnvelope();
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

  recoveryCount(): number {
    return this.allTasks().filter((task) => task.state === "unknown").length;
  }

  private allTasks(): AgentTask[] {
    if (this.closed) throw new Error("运行时已关闭");
    return (this.executor?.listTasks() ?? this.recoveredTasks.list()).map(
      (task) =>
        this.hasUnknownHome(task.id)
          ? { ...task, state: "unknown", runtimeExited: false }
          : task,
    );
  }

  private hasUnknownHome(taskId: string): boolean {
    return this.database
      .prepare("SELECT evidence FROM home_action_evidence WHERE task_id = ?")
      .all(taskId)
      .some((row) => JSON.parse(String(row.evidence)).status === "unknown");
  }

  taskPage(offset = 0) {
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new Error("无效任务页");
    const tasks = this.allTasks().sort(
      (a, b) =>
        Number(b.state === "unknown") - Number(a.state === "unknown") ||
        b.updatedAt.localeCompare(a.updatedAt),
    );
    return {
      total: tasks.length,
      offset,
      items: tasks.slice(offset, offset + 10).map((task) => ({
        id: task.id,
        prompt: task.prompt.slice(0, 160),
        state: task.state,
        updatedAt: task.updatedAt,
      })),
    };
  }

  taskDetails(id: string) {
    const task = this.allTasks().find((item) => item.id === id);
    if (!task) throw new Error("找不到这项任务");
    const homeActions = this.database
      .prepare(
        "SELECT evidence FROM home_action_evidence WHERE task_id = ? ORDER BY rowid",
      )
      .all(task.id)
      .map((row) => JSON.parse(String(row.evidence)));
    return { ...structuredClone(task), homeActions };
  }

  newConversation(action: UserActionRef): void {
    if (
      this.closed ||
      this.busy ||
      this.loginPending ||
      Boolean(this.llmOAuthAbort)
    )
      throw new Error("请先停止当前任务或取消登录");
    assertFreshUiAction(action);
    if (action.ui_session_id !== this.uiSessionId)
      throw new Error("页面已过期，请重新打开");
    const conversationId = `session_${randomUUID()}`;
    const raw = this.vault.get("model");
    if (raw) {
      this.credentialStore.updateEnvelope((draft) => {
        draft.conversationId = conversationId;
        return draft;
      });
      this.conversationPersisted = true;
    } else {
      this.conversationPersisted = false;
    }
    this.conversationId = conversationId;
  }

  private validate(config: ModelConfiguration): ModelConfiguration {
    if (
      typeof config?.baseUrl !== "string" ||
      typeof config.model !== "string" ||
      typeof config.apiKey !== "string"
    )
      throw new Error("模型配置不完整");
    let url: URL;
    try {
      url = new URL(config.baseUrl);
    } catch {
      throw new Error("模型地址需要使用不含账号或查询参数的 HTTPS 地址");
    }
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error("模型地址需要使用不含账号或查询参数的 HTTPS 地址");
    if (
      !config.model.trim() ||
      config.model.length > 256 ||
      !config.apiKey.trim() ||
      config.apiKey.length > 8192
    )
      throw new Error("请填写模型名称和 API Key");
    return {
      baseUrl: url.href.replace(/\/$/, ""),
      model: config.model.trim(),
      apiKey: config.apiKey.trim(),
    };
  }

  private isValidCustomEndpoint(custom?: CustomEndpointConfig): boolean {
    if (
      !custom ||
      typeof custom.baseUrl !== "string" ||
      typeof custom.modelId !== "string"
    )
      return false;
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
    )
      return false;
    return Boolean(custom.modelId.trim() && custom.modelId.length <= 256);
  }

  private validateCustomEndpoint(
    custom?: CustomEndpointConfig,
  ): CustomEndpointConfig {
    if (
      !custom ||
      typeof custom.baseUrl !== "string" ||
      typeof custom.modelId !== "string"
    )
      throw new Error("自定义端点配置不完整");
    let url: URL;
    try {
      url = new URL(custom.baseUrl);
    } catch {
      throw new Error("模型地址需要使用不含账号或查询参数的 HTTPS 地址");
    }
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error("模型地址需要使用不含账号或查询参数的 HTTPS 地址");
    const model = custom.modelId.trim();
    if (!model || model.length > 256) throw new Error("请填写模型名称");
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

  async configure(input: ModelConfiguration): Promise<void> {
    if (
      this.closed ||
      this.busy ||
      this.loginPending ||
      Boolean(this.llmOAuthAbort)
    )
      throw new Error("请先停止当前任务或取消登录");
    const prevEnvelope = this.credentialStore.readEnvelope();
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
    const next = this.validate({
      ...input,
      apiKey: input.apiKey || (sameOrigin ? existingCustomKey : ""),
    });
    this.busy = true;
    const prevConversationId = this.conversationId;
    const prevConversationPersisted = this.conversationPersisted;
    try {
      await this.executor?.close();
      this.executor = undefined;
      if (this.closed) throw new Error("页面已关闭");
      const conversationId = `session_${randomUUID()}`;
      let nextEnvelope: ModelVaultEnvelope;
      try {
        nextEnvelope = await this.credentialStore.updateEnvelopeAsync((draft) => {
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
        });
      } catch (error) {
        // A native vault failure must leave the previous configuration usable.
        this.conversationId = prevConversationId;
        this.conversationPersisted = prevConversationPersisted;
        syncLooiModelsRegistry(this.modelsRegistry, prevEnvelope);
        if (
          prevEnvelope.active &&
          prevEnvelope.credentials[prevEnvelope.active.providerId]
        ) {
          let customValid = true;
          if (prevEnvelope.active.providerId === "custom") {
            customValid = this.isValidCustomEndpoint(prevEnvelope.custom);
          }
          if (customValid) {
            this.executor = this.createExecutorForSelection(prevEnvelope.active);
          }
        }
        throw error;
      }
      this.conversationId = conversationId;
      this.conversationPersisted = true;
      syncLooiModelsRegistry(this.modelsRegistry, nextEnvelope);
      this.executor = this.createExecutorForSelection(nextEnvelope.active!);
    } finally {
      this.busy = false;
    }
  }

  private createExecutorForSelection(
    selection: ActiveLlmSelection,
  ): PiAgentExecutor {
    const homeEnabled = this.home.configuration().mode !== "disabled";
    return new PiAgentExecutor({
      modelsRegistry: this.modelsRegistry,
      providerId: selection.providerId,
      model: selection.modelId,
      stateDirectory: "/home/agent",
      workspaceRoot: "/workspace",
      taskPersistence: this.storage.tasks,
      approvalUiSessionId: this.uiSessionId,
      requireApprovalForAllWrites: true,
      maxConcurrentTasks: 1,
      additionalTools: homeEnabled ? [...this.homeTools()] : [],
      approvalRequiredTools: homeEnabled ? ["control_home_device"] : [],
    });
  }

  private homeTools(): AgentTool<any>[] {
    const result = (value: unknown) => ({
      content: [{ type: "text" as const, text: JSON.stringify(value) }],
      details: { value },
    });
    return [
      {
        name: "list_home_devices",
        label: "查看家居设备",
        description:
          "Find devices and current readbacks. Use actual entity_id and connectionId for control. Simulation is explicitly labelled and never represents real devices. Ask when multiple matches exist.",
        parameters: obj({
          query: opt(str()),
          offset: opt(int({ minimum: 0 })),
        }),
        execute: async (_, args) =>
          result(await this.home.list(args.query, args.offset)),
      },
      {
        name: "control_home_device",
        label: "控制家居设备",
        description:
          "Control one device after explicit UI approval. Requires entity_id and connectionId from a recent list. Only a verified receipt confirms success; unknown must not be retried automatically. Simulation changes no real device.",
        parameters: obj({
          entity_id: str(),
          connectionId: str(),
          service: oneOf(["turn_on", "turn_off"]),
          brightness: opt(int({ minimum: 1, maximum: 255 })),
          color_temp_kelvin: opt(int()),
        }),
        execute: async (callId, args, signal) => {
          if (signal?.aborted || !this.taskId) throw new Error("任务已停止");
          const service_data: Record<string, number> = {};
          if (args.brightness !== undefined)
            service_data.brightness = args.brightness;
          if (args.color_temp_kelvin !== undefined)
            service_data.color_temp_kelvin = args.color_temp_kelvin;
          const taskId = this.taskId;
          const requestId = createHash("sha256")
            .update(`${taskId}:${callId}`)
            .digest("hex");
          const command = {
            entity_id: args.entity_id,
            domain: args.entity_id.split(".")[0],
            service: args.service,
            service_data,
          };
          const evidence = {
            requestId,
            connectionId: args.connectionId,
            command,
            simulation: this.home.configuration().mode === "simulation",
            recordedAt: new Date().toISOString(),
            status: "unknown",
            receipt: null as unknown,
          };
          // Commit intent before any possible side effect; a crash retains unknown.
          this.database
            .prepare(
              "INSERT INTO home_action_evidence (request_id, task_id, evidence) VALUES (?, ?, ?)",
            )
            .run(requestId, taskId, JSON.stringify(evidence));
          const outcome = await this.home.control(command, {
            connectionId: args.connectionId,
            requestId,
            signal,
          });
          evidence.status = outcome.receipt.status;
          evidence.receipt = outcome.receipt;
          this.database
            .prepare(
              "UPDATE home_action_evidence SET evidence = ? WHERE request_id = ?",
            )
            .run(JSON.stringify(evidence), requestId);
          return result(outcome);
        },
      },
    ];
  }

  async run(
    prompt: string,
    action: UserActionRef,
    onStep: (event: AgentStepEvent) => void,
    options: { agentOnly?: boolean; mode?: "text" | "voice" } = {},
  ): Promise<{ answer: string; taskId: string; runtimeExited: boolean }> {
    if (
      this.closed ||
      this.busy ||
      this.loginPending ||
      Boolean(this.llmOAuthAbort)
    )
      throw new Error("当前已有任务或登录，请先停止");
    assertFreshUiAction(action);
    if (action.ui_session_id !== this.uiSessionId)
      throw new Error("页面已过期，请重新打开");
    const text = prompt.trim();
    if (!text) throw new Error("请输入内容");
    this.busy = true;
    try {
      if (!this.executor) throw new Error("请先在连接设置中配置对话模型");
      if (
        this.allTasks().some(
          (task) =>
            task.sessionId === this.conversationId && task.state === "unknown",
        )
      )
        throw new Error(
          "这段对话有待核实的操作，请先查看任务记录，再开始新对话",
        );
      if (!this.conversationPersisted && this.vault.get("model")) {
        this.credentialStore.updateEnvelope((draft) => {
          draft.conversationId = this.conversationId;
          return draft;
        });
        this.conversationPersisted = true;
      }
      this.taskId = `task_${randomUUID()}`;
      const result = await this.executor.run(text, {
        taskId: this.taskId,
        sessionId: this.conversationId,
        mode: options.mode,
        onStep,
      });
      return {
        answer: result.answer,
        taskId: result.taskId,
        runtimeExited:
          result.runtimeExited && !this.hasUnknownHome(result.taskId),
      };
    } finally {
      this.busy = false;
      this.taskId = undefined;
    }
  }

  respond(taskId: string, requestId: string, answer: AgentInteractionAnswer) {
    if (this.closed || !this.executor) throw new Error("运行时不可用");
    this.executor.respond(taskId, requestId, answer);
  }

  async cancel() {
    this.cancelMiotLogin();
    this.cancelProviderOAuth();
    this.home.suspend();
    const taskId = this.taskId;
    const result =
      taskId && this.executor
        ? await this.executor.cancel(taskId)
        : { state: "cancelled", runtimeExited: true, confirmed: true };
    return taskId && !this.closed && this.hasUnknownHome(taskId)
      ? { state: "unknown", runtimeExited: false, confirmed: false }
      : result;
  }

  async close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.cancelProviderOAuth();
    this.home.close();
    this.closing = (async () => {
      try {
        await this.executor?.close();
      } finally {
        this.storage.close();
        this.releaseHost();
      }
    })();
    return this.closing;
  }

  llmSnapshot(): LlmCatalogSnapshot {
    const envelope = this.credentialStore.readEnvelope();
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
            const known = this.modelsRegistry.getModel(ch.providerId, m.id);
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

  async refreshProviderModels(providerId: string, signal?: AbortSignal): Promise<LlmCatalogSnapshot> {
    const envelope = this.credentialStore.readEnvelope();
    const credential = envelope.credentials[providerId];
    if (!credential) return this.llmSnapshot();
    const channel = LLM_PROVIDER_CATALOG.flatMap((brand) => brand.channels)
      .find((item) => item.providerId === providerId);
    if (!channel) throw new Error(`未知服务商: ${providerId}`);

    const version = this.invalidateFetchedModels(providerId);
    try {
      const auth = await this.modelsRegistry.getAuth(providerId, { signal });
      if (!auth) throw new Error("请先连接模型服务");
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(auth.auth.headers ?? {})) {
        if (value !== null) headers[name] = value;
      }
      if (auth.auth.apiKey) headers.Authorization = `Bearer ${auth.auth.apiKey}`;
      const baseUrl = providerId === "custom"
        ? envelope.custom?.baseUrl
        : channel.baseUrl;
      if (!baseUrl) return this.llmSnapshot();
      const knownChatIds = credential.type === "api_key"
        ? new Set(this.modelsRegistry.getModels(providerId).map((model) => model.id))
        : undefined;
      const models = await fetchOnlineModels(baseUrl, headers, { knownChatIds, signal });
      signal?.throwIfAborted();
      if (this.modelFetchVersions.get(providerId) !== version) return this.llmSnapshot();
      this.fetchedModels.set(providerId, models);
    } catch (error) {
      if (signal?.aborted) throw error;
      if (this.modelFetchVersions.get(providerId) === version) {
        this.modelFetchErrors.set(
          providerId,
          error instanceof Error ? error.message : "获取在线模型列表失败",
        );
      }
    }
    return this.llmSnapshot();
  }

  private invalidateFetchedModels(providerId: string): number {
    const version = (this.modelFetchVersions.get(providerId) ?? 0) + 1;
    this.modelFetchVersions.set(providerId, version);
    this.fetchedModels.delete(providerId);
    this.modelFetchErrors.delete(providerId);
    return version;
  }

  async saveProviderApiKey(
    input: {
      providerId: string;
      apiKey?: string;
      modelId?: string;
      custom?: CustomEndpointConfig;
      setActive?: boolean;
    },
    action: UserActionRef,
  ): Promise<LlmCatalogSnapshot> {
    if (
      this.closed ||
      this.busy ||
      this.loginPending ||
      Boolean(this.llmOAuthAbort)
    )
      throw new Error("请先停止当前任务或取消登录");
    assertFreshUiAction(action);
    if (action.ui_session_id !== this.uiSessionId)
      throw new Error("页面已过期，请重新打开");

    let targetChannel: LlmChannelSpec | undefined;
    for (const b of LLM_PROVIDER_CATALOG) {
      const ch = b.channels.find((c) => c.providerId === input.providerId);
      if (ch) {
        targetChannel = ch;
        break;
      }
    }
    if (!targetChannel) throw new Error(`未知服务商: ${input.providerId}`);

    let validatedCustom: CustomEndpointConfig | undefined;
    if (input.providerId === "custom") {
      validatedCustom = this.validateCustomEndpoint(input.custom);
    }

    const envelope = this.credentialStore.readEnvelope();
    const existingCred = envelope.credentials[input.providerId];
    let nextCred: Credential;
    const trimmedKey = input.apiKey?.trim();
    if (trimmedKey) {
      if (trimmedKey.length > 8192) throw new Error("API Key 过长");
      nextCred = { type: "api_key", key: trimmedKey };
    } else if (existingCred) {
      nextCred = existingCred;
    } else {
      throw new Error("请填写 API Key");
    }

    const targetModelId =
      input.modelId?.trim() ||
      (input.providerId === "custom" ? validatedCustom?.modelId : "") ||
      targetChannel.defaultModelId;
    if (!targetModelId) throw new Error("请选择或填写模型 ID");

    const isKnownModel = Boolean(
      this.modelsRegistry.getModel(input.providerId, targetModelId),
    );

    const shouldSetActive = input.setActive !== false;
    const prevEnvelope = envelope;
    const prevConversationId = this.conversationId;
    const prevConversationPersisted = this.conversationPersisted;
    const nextConversationId = shouldSetActive
      ? `session_${randomUUID()}`
      : this.conversationId;

    this.busy = true;
    try {
      if (shouldSetActive) {
        await this.executor?.close();
        this.executor = undefined;
      }
      let nextEnvelope: ModelVaultEnvelope;
      try {
        nextEnvelope = await this.credentialStore.updateEnvelopeAsync((draft) => {
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
              draft.customModelsByProvider[input.providerId].push(
                targetModelId,
              );
            }
          }
          if (shouldSetActive) {
            draft.conversationId = nextConversationId;
            draft.active = {
              providerId: input.providerId,
              modelId: targetModelId,
              authType: nextCred.type,
            };
          }
          return draft;
        });
      } catch (error) {
        // Rollback
        this.conversationId = prevConversationId;
        this.conversationPersisted = prevConversationPersisted;
        syncLooiModelsRegistry(this.modelsRegistry, prevEnvelope);
        if (
          prevEnvelope.active &&
          prevEnvelope.credentials[prevEnvelope.active.providerId]
        ) {
          let customValid = true;
          if (prevEnvelope.active.providerId === "custom") {
            customValid = this.isValidCustomEndpoint(prevEnvelope.custom);
          }
          if (customValid) {
            this.executor = this.createExecutorForSelection(prevEnvelope.active);
          }
        }
        throw error;
      }

      if (shouldSetActive) {
        this.conversationId = nextConversationId;
        this.conversationPersisted = true;
      }
      syncLooiModelsRegistry(this.modelsRegistry, nextEnvelope);
      if (
        nextEnvelope.active &&
        nextEnvelope.credentials[nextEnvelope.active.providerId]
      ) {
        this.executor = this.createExecutorForSelection(nextEnvelope.active);
      }
      this.invalidateFetchedModels(input.providerId);
      return this.llmSnapshot();
    } finally {
      this.busy = false;
    }
  }

  async selectActiveModel(
    input: { providerId: string; modelId: string; addCustomModel?: boolean },
    action: UserActionRef,
  ): Promise<LlmCatalogSnapshot> {
    if (
      this.closed ||
      this.busy ||
      this.loginPending ||
      Boolean(this.llmOAuthAbort)
    )
      throw new Error("请先停止当前任务或取消登录");
    assertFreshUiAction(action);
    if (action.ui_session_id !== this.uiSessionId)
      throw new Error("页面已过期，请重新打开");

    const envelope = this.credentialStore.readEnvelope();
    const cred = envelope.credentials[input.providerId];
    if (!cred) throw new Error("请先配置该服务商的 API Key 或登录账号");

    const targetModelId = input.modelId.trim();
    if (!targetModelId) throw new Error("请选择或填写模型 ID");

    const isKnownModel = Boolean(
      this.modelsRegistry.getModel(input.providerId, targetModelId),
    );

    const changed =
      envelope.active?.providerId !== input.providerId ||
      envelope.active?.modelId !== targetModelId;

    const prevEnvelope = envelope;
    const prevConversationId = this.conversationId;
    const prevConversationPersisted = this.conversationPersisted;
    const nextConversationId = changed
      ? `session_${randomUUID()}`
      : this.conversationId;

    this.busy = true;
    try {
      if (changed) {
        await this.executor?.close();
        this.executor = undefined;
      }
      let nextEnvelope: ModelVaultEnvelope;
      try {
        nextEnvelope = await this.credentialStore.updateEnvelopeAsync((draft) => {
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
              draft.customModelsByProvider[input.providerId].push(
                targetModelId,
              );
            }
          }
          if (input.providerId === "custom" && draft.custom) {
            draft.custom.modelId = targetModelId;
          }
          if (changed) {
            draft.conversationId = nextConversationId;
          }
          draft.active = {
            providerId: input.providerId,
            modelId: targetModelId,
            authType: cred.type,
          };
          return draft;
        });
      } catch (error) {
        // Rollback
        this.conversationId = prevConversationId;
        this.conversationPersisted = prevConversationPersisted;
        syncLooiModelsRegistry(this.modelsRegistry, prevEnvelope);
        if (
          prevEnvelope.active &&
          prevEnvelope.credentials[prevEnvelope.active.providerId]
        ) {
          let customValid = true;
          if (prevEnvelope.active.providerId === "custom") {
            customValid = this.isValidCustomEndpoint(prevEnvelope.custom);
          }
          if (customValid) {
            this.executor = this.createExecutorForSelection(prevEnvelope.active);
          }
        }
        throw error;
      }

      if (changed) {
        this.conversationId = nextConversationId;
        this.conversationPersisted = true;
      }
      syncLooiModelsRegistry(this.modelsRegistry, nextEnvelope);
      if (
        nextEnvelope.active &&
        nextEnvelope.credentials[nextEnvelope.active.providerId]
      ) {
        this.executor = this.createExecutorForSelection(nextEnvelope.active);
      }
      return this.llmSnapshot();
    } finally {
      this.busy = false;
    }
  }

  async removeProviderCredential(
    providerId: string,
    action: UserActionRef,
  ): Promise<LlmCatalogSnapshot> {
    if (
      this.closed ||
      this.busy ||
      this.loginPending ||
      Boolean(this.llmOAuthAbort)
    )
      throw new Error("请先停止当前任务或取消登录");
    assertFreshUiAction(action);
    if (action.ui_session_id !== this.uiSessionId)
      throw new Error("页面已过期，请重新打开");

    const envelope = this.credentialStore.readEnvelope();
    const isActive = envelope.active?.providerId === providerId;
    const nextConversationId = `session_${randomUUID()}`;

    this.busy = true;
    try {
      if (isActive) {
        await this.executor?.close();
        this.executor = undefined;
      }
      const nextEnvelope = await this.credentialStore.updateEnvelopeAsync(
        (draft) => {
          delete draft.credentials[providerId];
          if (draft.active?.providerId === providerId) {
            draft.active = undefined;
            draft.conversationId = nextConversationId;
          }
          return draft;
        },
      );
      if (isActive) {
        this.conversationId = nextConversationId;
        this.conversationPersisted = true;
      }
      syncLooiModelsRegistry(this.modelsRegistry, nextEnvelope);
      this.invalidateFetchedModels(providerId);
      return this.llmSnapshot();
    } finally {
      this.busy = false;
    }
  }

  async startProviderOAuth(
    providerId: string,
    action: UserActionRef,
    onEvent: (event: LlmOAuthUiEvent) => void,
  ): Promise<LlmCatalogSnapshot> {
    if (
      this.closed ||
      this.busy ||
      this.loginPending ||
      Boolean(this.llmOAuthAbort)
    )
      throw new Error("请先停止当前任务或取消登录");
    assertFreshUiAction(action);
    if (action.ui_session_id !== this.uiSessionId)
      throw new Error("页面已过期，请重新打开");

    let targetChannel: LlmChannelSpec | undefined;
    for (const b of LLM_PROVIDER_CATALOG) {
      const ch = b.channels.find((c) => c.providerId === providerId);
      if (ch) {
        targetChannel = ch;
        break;
      }
    }
    if (!targetChannel) throw new Error(`未知服务商: ${providerId}`);

    const abort = new AbortController();
    this.llmOAuthAbort = abort;

    try {
      await this.modelsRegistry.login(
        providerId,
        "oauth",
        {
          signal: abort.signal,
          notify: (ev: {
            type: string;
            userCode?: string;
            verificationUri?: string;
            expiresInSeconds?: number;
            url?: string;
            instructions?: string;
            message?: string;
          }) => {
            if (ev.type === "device_code" && ev.userCode && ev.verificationUri) {
              onEvent({
                kind: "device_code",
                userCode: ev.userCode,
                verificationUri: ev.verificationUri,
                expiresInSeconds: ev.expiresInSeconds,
              });
            } else if (ev.type === "auth_url" && ev.url) {
              onEvent({
                kind: "auth_url",
                url: ev.url,
                instructions: ev.instructions,
              });
            } else if (
              (ev.type === "progress" || ev.type === "info") &&
              typeof ev.message === "string"
            ) {
              onEvent({
                kind: "progress",
                message: ev.message,
              });
            }
          },
          prompt: async (p: {
            type: string;
            message: string;
            placeholder?: string;
            signal?: AbortSignal;
          }) => {
            if (p.type === "manual_code") {
              onEvent({
                kind: "awaiting_callback",
                message: p.message,
                placeholder: p.placeholder ?? "",
              });
              return await new Promise<string>((resolve, reject) => {
                this.llmOAuthManualPrompt = { resolve, reject };
                const onAbort = () => {
                  if (this.llmOAuthManualPrompt) {
                    this.llmOAuthManualPrompt = undefined;
                    reject(new Error("登录已取消"));
                  }
                };
                p.signal?.addEventListener("abort", onAbort, { once: true });
                abort.signal.addEventListener("abort", onAbort, { once: true });
              });
            }
            throw new Error("不支持的交互提示类型");
          },
        },
        {
          getDeviceId: () => this.credentialStore.readEnvelope().deviceId,
          agentName: "Super LOOI",
        },
      );

      abort.signal.throwIfAborted();
      await this.refreshProviderModels(providerId, abort.signal);
      const envelope = this.credentialStore.readEnvelope();
      const targetModelId = chooseConnectedModelId(
        this.fetchedModels.get(providerId),
        envelope.active?.providerId === providerId ? envelope.active.modelId : "",
        targetChannel.defaultModelId,
        this.modelsRegistry.getModels(providerId)[0]?.id ?? "",
      );

      this.busy = true;
      try {
        const conversationId = `session_${randomUUID()}`;
        await this.executor?.close();
        this.executor = undefined;
        abort.signal.throwIfAborted();

        const nextEnvelope = await this.credentialStore.updateEnvelopeAsync(
          (draft) => {
            draft.conversationId = conversationId;
            draft.active = {
              providerId,
              modelId: targetModelId,
              authType: "oauth",
            };
            return draft;
          },
          { signal: abort.signal },
        );

        this.conversationId = conversationId;
        this.conversationPersisted = true;
        syncLooiModelsRegistry(this.modelsRegistry, nextEnvelope);
        this.executor = this.createExecutorForSelection(nextEnvelope.active!);
        return this.llmSnapshot();
      } finally {
        this.busy = false;
      }
    } finally {
      if (this.llmOAuthAbort === abort) {
        this.llmOAuthAbort = undefined;
        this.llmOAuthManualPrompt = undefined;
      }
    }
  }

  submitProviderOAuthCallback(callbackUrl: string): void {
    const prompt = this.llmOAuthManualPrompt;
    if (!prompt) throw new Error("当前没有等待回调的登录流程");
    this.llmOAuthManualPrompt = undefined;
    prompt.resolve(callbackUrl.trim());
  }

  cancelProviderOAuth(): void {
    if (this.llmOAuthManualPrompt) {
      const prompt = this.llmOAuthManualPrompt;
      this.llmOAuthManualPrompt = undefined;
      prompt.reject(new Error("登录已取消"));
    }
    if (this.llmOAuthAbort) {
      const abort = this.llmOAuthAbort;
      this.llmOAuthAbort = undefined;
      abort.abort();
    }
  }
}
