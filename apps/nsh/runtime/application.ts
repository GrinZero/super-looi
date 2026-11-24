import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { UserActionRef } from "@super-looi/contracts";
import {
  AgentTaskStore,
  assertFreshUiAction,
  type AgentStopResult,
} from "@super-looi/runtime/agent";
import { SqliteRuntimeStore } from "@super-looi/runtime/storage";
import { createLangfuseTracer } from "@super-looi/runtime/telemetry";
import { AgentRuntime } from "./agent.js";
import { BodyRuntime } from "./body.js";
import { deviceControlInstructions } from "./device-control-instructions.js";
import { HomeController } from "./home-controller.js";
import { PluginController } from "./plugins/controller.js";
import { uint8ArrayToBase64 } from "./plugins/embodied-drivers.js";
import { ScheduleRuntime } from "./schedule.js";
import {
  createBodyTools,
  createGitHubCredentials,
  createGitHubPrStatusTool,
  createHomeTools,
  readGitHubToken,
  type GitHubCredentials,
} from "./tools/index.js";
import type { Vault } from "./vault.js";
import { directVoiceToolName } from "./voice-tool-history.js";

const AGENT_SYSTEM_PROMPT =
  deviceControlInstructions +
  "\n家居查询使用 list_home_devices；仅在用户要求控制时，再用返回的 entity_id 和 connectionId 调用 control_home_device。不要先检查底座状态。工具未提供时，说明当前未启用对应能力。" +
  "\nPR 与云端任务只读查询：使用 github_pr_status 查询 GitHub PR 状态、checks 与 reviews；使用 codex_cloud_status 查询 Codex 云端任务状态。需要定时或延后无打扰复查同一 PR/任务时，调用 manage_schedule（origin 设为 \"agent_inferred\"，executionPolicy 设为 \"check_only\"，使用唯一 dedupeKey，prompt 必须自包含完整 owner/repo/pullNumber 或 taskId 等标识）。";

/** Composition root for the mobile runtime; owns shared resources and domain sub-facades. */
export class MobileRuntime {
  private readonly database = new DatabaseSync("/home/looi.sqlite");
  private readonly storage = new SqliteRuntimeStore(this.database);
  readonly uiSessionId = `ui_${randomUUID()}`;
  readonly tracer = createLangfuseTracer({
    baseUrl: process.env.LANGFUSE_BASE_URL,
    publicKey: process.env.LANGFUSE_PUBLIC_KEY,
    secretKey: process.env.LANGFUSE_SECRET_KEY,
    onObservation: (observation) => {
      this.storage.saveObservation(observation);
      this.agent?.history.emit(Boolean(directVoiceToolName(observation)));
    },
  });
  readonly agent: AgentRuntime;
  readonly schedule: ScheduleRuntime;
  readonly home: HomeController;
  readonly body: BodyRuntime;
  readonly plugins: PluginController;
  readonly github: GitHubCredentials;
  private closed = false;
  private closing?: Promise<void>;

  constructor(
    private readonly vault: Vault,
    private readonly releaseHost: () => void,
  ) {
    try {
      new AgentTaskStore("/home/agent/tasks", this.storage.tasks);
      this.database.exec(
        "CREATE TABLE IF NOT EXISTS home_action_evidence (request_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, evidence TEXT NOT NULL)",
      );
      this.database.exec(
        "CREATE TABLE IF NOT EXISTS body_action_evidence (request_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, evidence TEXT NOT NULL)",
      );

      this.home = new HomeController({
        vault,
        database: this.database,
        assertUiAction: (action) => this.assertUiAction(action),
        isClosed: () => this.closed,
      });

      this.body = new BodyRuntime({
        vault,
        assertUiAction: (action) => {
          if (!action) {
            this.assertOpen();
            throw new Error("@looi:runtimeThisPageExpiredOpenItAgain");
          }
          this.assertUiAction(action);
        },
      });

      this.plugins = new PluginController({
        database: this.database,
        body: this.body,
        tracer: this.tracer,
        traceContext: () => this.agent?.activeForegroundTraceContext("codex"),
        runBackgroundTask: ({ pluginId, prompt }) =>
          this.agent.runPluginBackgroundTask(pluginId, prompt),
        assertUiAction: (action) => this.assertUiAction(action),
        isClosed: () => this.closed,
      });

      this.github = createGitHubCredentials({
        vault,
        assertOpen: () => this.assertOpen(),
        assertUiAction: (action) => this.assertUiAction(action),
        onSecretChanged: (token) => this.registerGitHubSecret(token),
      });
      this.registerGitHubSecret();

      this.schedule = new ScheduleRuntime({
        store: this.storage,
        getExecutor: () => this.agent?.currentExecutor(),
        getModelStreamConfig: () => this.agent?.models.resolveStreamConfig(),
        tracer: this.tracer,
        defaultLanguage: () => this.agent?.defaultLanguage() ?? "zh-CN",
        assertUiAction: (action) => this.assertUiAction(action),
        isClosed: () => this.closed,
        redactSecrets: (text) => this.redactSecrets(text),
      });

      this.agent = new AgentRuntime({
        vault,
        database: this.database,
        storage: this.storage,
        tracer: this.tracer,
        uiSessionId: this.uiSessionId,
        assertUiAction: (action) => this.assertUiAction(action),
        redactSecrets: (text) => this.redactSecrets(text),
        isClosed: () => this.closed,
        systemPrompt: AGENT_SYSTEM_PROMPT,
        additionalTools: [createGitHubPrStatusTool({ vault: this.vault })],
        approvalRequiredTools: ["control_home_device"],
        resolveTaskTools: (context) => {
          const pluginContribution = this.plugins.contribution(context);
          const homeEnabled = this.home.configuration().mode !== "disabled";
          const bodyEnabled = this.body.configuration().mode !== "disabled";
          const scheduleTools = this.schedule.createTaskTools({
            taskId: context.taskId,
            sessionId: context.sessionId,
            checkOnly: context.scheduleExecutionPolicy === "check_only",
            isForegroundTask: context.isForegroundTask,
          });
          return {
            tools: [
              ...pluginContribution.tools,
              ...(homeEnabled
                ? createHomeTools({
                    home: this.home.raw,
                    database: this.database,
                    getActiveTaskId: () => context.taskId,
                    isLoginPending: () => this.home.isLoginPending,
                  })
                : []),
              ...(bodyEnabled
                ? createBodyTools({
                    body: this.body,
                    database: this.database,
                    getActiveTaskId: () => context.taskId,
                  })
                : []),
              ...scheduleTools,
            ],
            ...(pluginContribution.skillPaths
              ? { skillPaths: pluginContribution.skillPaths }
              : {}),
          };
        },
        evaluateUserTurn: (text) =>
          this.plugins.ai.evaluateUserTurn({ channel: "task", text }),
        beforeToolCall: (call) =>
          this.plugins.ai.evaluateToolCall({
            channel: "task",
            toolName: call.toolName,
            approvalMode: call.approvalMode,
            arguments: call.arguments,
            scheduleExecutionPolicy: call.scheduleExecutionPolicy,
          }),
        assembleTurnContext: async (turn) => {
          const draft = await this.plugins.ai.assembleTurn({
            channel: "task",
            userText: turn.prompt,
          });
          const contextText = draft.contextBlocks
            .map((block) => block.text.trim())
            .filter(Boolean)
            .join("\n");
          const images = draft.ephemeralImages.map((img) => ({
            type: "image" as const,
            data: uint8ArrayToBase64(img.bytes),
            mimeType: img.mimeType,
          }));
          if (!contextText && images.length === 0) return undefined;
          return {
            ...(contextText ? { contextText } : {}),
            ...(images.length > 0 ? { images } : {}),
          };
        },
        beforeExecutorClose: () => this.schedule.cancelActiveRun(),
        onExecutorReady: () => {
          if (!this.closed) {
            void this.schedule.reconcileDueRules().catch(() => {});
          }
        },
        onTaskPersisted: (task) => this.schedule.handlePersistedTask(task),
        onForegroundTurnSucceeded: (input) =>
          this.schedule.observeForegroundTurn(input),
        onForegroundTurnFinished: (taskId) =>
          this.schedule.clearMutatedTask(taskId),
      });
    } catch (error) {
      this.storage.close();
      throw error;
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("@looi:runtimeRuntimeClosed");
  }

  private assertUiAction(action: UserActionRef): void {
    this.assertOpen();
    assertFreshUiAction(action);
    if (action.ui_session_id !== this.uiSessionId) {
      throw new Error("@looi:runtimeThisPageExpiredOpenItAgain");
    }
  }

  private registerGitHubSecret(token = readGitHubToken(this.vault)): void {
    if (token && token.length >= 4) {
      this.tracer.registerSecret(token);
    }
  }

  redactSecrets(text: string): string {
    if (!text) return text;
    let scrubbed = text;
    try {
      for (const secret of this.agent.models.secretValues()) {
        scrubbed = scrubbed.replaceAll(secret, "[redacted]");
      }
      for (const slot of ["home", "voice"]) {
        const rawSlot = this.vault.get(slot);
        if (!rawSlot) continue;
        try {
          const parsed = JSON.parse(rawSlot) as Record<string, unknown>;
          for (const val of Object.values(parsed)) {
            if (typeof val === "string" && val.length >= 8 && !val.startsWith("http")) {
              scrubbed = scrubbed.replaceAll(val, "[redacted]");
            }
          }
        } catch {
          // Non-JSON slot or empty.
        }
      }
      const githubToken = readGitHubToken(this.vault);
      if (githubToken && githubToken.length >= 4) {
        scrubbed = scrubbed.replaceAll(githubToken, "[redacted]");
      }
    } catch {
      // Never throw during error redaction.
    }
    return scrubbed;
  }

  async cancelForeground(): Promise<AgentStopResult> {
    this.home.cancelMiotLogin();
    this.home.suspend();
    void this.body.control({ action: "stop" });
    return this.agent.cancelForeground();
  }

  async close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.agent.models.cancelOAuth();
    this.plugins.deactivateBrokers();
    this.home.close();
    this.body.close();
    this.closing = (async () => {
      try {
        await this.schedule.close().catch(() => {});
        await this.agent.close();
      } finally {
        try {
          await this.plugins.close();
        } finally {
          try {
            await this.tracer.shutdown();
          } finally {
            this.storage.close();
            this.releaseHost();
          }
        }
      }
    })();
    return this.closing;
  }
}
