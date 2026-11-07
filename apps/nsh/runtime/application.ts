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

import { HomeRuntime, type HomeSettings } from "./home.js";

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

/** One foreground app owns the database and executor. No Hub endpoint exists. */
export class MobileRuntime {
  private readonly database = new DatabaseSync("/home/looi.sqlite");
  private readonly storage = new SqliteRuntimeStore(this.database);
  private readonly recoveredTasks = new AgentTaskStore(
    "/home/agent/tasks",
    this.storage.tasks,
  );
  private readonly home: HomeRuntime;
  private executor?: PiAgentExecutor;
  private config?: ModelConfiguration;
  private conversationId = `session_${randomUUID()}`;
  private conversationPersisted = false;
  private taskId?: string;
  private closed = false;
  private busy = false;
  private loginPending = false;
  private loginAttempt = 0;
  private closing?: Promise<void>;
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
      const raw = vault.get("model");
      if (raw) {
        const stored = JSON.parse(raw);
        this.config = this.validate(stored);
        if (
          typeof stored.conversationId === "string" &&
          /^[a-zA-Z0-9_-]{1,100}$/.test(stored.conversationId)
        ) {
          this.conversationId = stored.conversationId;
          this.conversationPersisted = true;
        }
        this.executor = this.createExecutor(this.config);
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
    if (this.closed || this.busy || this.loginPending) throw new Error("请先停止当前任务或取消登录");
    assertFreshUiAction(action);
    if (action.ui_session_id !== this.uiSessionId)
      throw new Error("页面已过期，请重新打开");
    const result = await this.home.configure(input);
    if (this.config && !this.closed) {
      await this.executor?.close();
      this.executor = this.createExecutor(this.config);
    }
    return result;
  }
  async connectHome() {
    if (this.loginPending) throw new Error("请先完成或取消米家登录");
    return this.home.connect();
  }
  async beginMiotLogin(region: NonNullable<HomeSettings["region"]>, action: UserActionRef) {
    if (this.closed || this.busy || this.loginPending) throw new Error("请先停止当前任务或取消登录");
    assertFreshUiAction(action);
    if (action.ui_session_id !== this.uiSessionId) throw new Error("页面已过期，请重新打开");
    const attempt = ++this.loginAttempt;
    this.loginPending = true;
    try {
      const session = await this.home.beginMiotLogin(region);
      if (attempt !== this.loginAttempt || this.closed) throw new Error("米家登录已取消");
      return { ...session, attempt };
    } catch (error) {
      if (attempt === this.loginAttempt) this.cancelMiotLogin();
      throw error;
    }
  }
  async finishMiotLogin(attempt: number, callback: string, isCurrent: () => boolean) {
    if (!this.loginPending || attempt !== this.loginAttempt || this.closed) throw new Error("米家登录已取消");
    try {
      const result = this.home.interceptMiotCallback(callback);
      if (!result.intercepted || "error" in result) throw new Error("米家授权回调无效或已过期");
      return await this.home.finishMiotLogin(result.code, () =>
        this.loginPending && attempt === this.loginAttempt && !this.closed && isCurrent());
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
    if (this.closed || this.busy || this.loginPending) throw new Error("请先停止当前任务或取消登录");
    assertFreshUiAction(action);
    if (action.ui_session_id !== this.uiSessionId) throw new Error("页面已过期，请重新打开");
    await this.home.logoutMiot();
  }
  async listHome(query = "", offset = 0) {
    if (this.loginPending) throw new Error("请先完成或取消米家登录");
    return this.home.list(query, offset);
  }

  configuration() {
    return {
      baseUrl: this.config?.baseUrl ?? "",
      model: this.config?.model ?? "",
      hasKey: Boolean(this.config?.apiKey),
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
    if (this.closed || this.busy || this.loginPending) throw new Error("请先停止当前任务或取消登录");
    assertFreshUiAction(action);
    if (action.ui_session_id !== this.uiSessionId)
      throw new Error("页面已过期，请重新打开");
    const conversationId = `session_${randomUUID()}`;
    if (this.config)
      this.vault.set(
        "model",
        JSON.stringify({ ...this.config, conversationId }),
      );
    this.conversationId = conversationId;
    this.conversationPersisted = Boolean(this.config);
  }
  private validate(config: ModelConfiguration): ModelConfiguration {
    if (
      typeof config?.baseUrl !== "string" ||
      typeof config.model !== "string" ||
      typeof config.apiKey !== "string"
    )
      throw new Error("模型配置不完整");
    const url = new URL(config.baseUrl);
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

  async configure(input: ModelConfiguration): Promise<void> {
    if (this.closed || this.busy || this.loginPending) throw new Error("请先停止当前任务或取消登录");
    const sameOrigin =
      this.config &&
      new URL(input.baseUrl).origin === new URL(this.config.baseUrl).origin;
    const next = this.validate({
      ...input,
      apiKey: input.apiKey || (sameOrigin ? this.config!.apiKey : ""),
    });
    this.busy = true;
    try {
      await this.executor?.close();
      if (this.closed) throw new Error("页面已关闭");
      const conversationId = `session_${randomUUID()}`;
      try {
        this.vault.set("model", JSON.stringify({ ...next, conversationId }));
      } catch (error) {
        // A native vault failure must leave the previous configuration usable.
        this.executor = this.config
          ? this.createExecutor(this.config)
          : undefined;
        throw error;
      }
      this.config = next;
      this.conversationId = conversationId;
      this.conversationPersisted = true;
      this.executor = this.createExecutor(next);
    } finally {
      this.busy = false;
    }
  }

  private createExecutor(config: ModelConfiguration): PiAgentExecutor {
    const homeEnabled = this.home.configuration().mode !== "disabled";
    return new PiAgentExecutor({
      ...config,
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
    if (this.closed || this.busy || this.loginPending) throw new Error("当前已有任务或登录，请先停止");
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
      if (!this.conversationPersisted) {
        this.vault.set(
          "model",
          JSON.stringify({
            ...this.config,
            conversationId: this.conversationId,
          }),
        );
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
}
