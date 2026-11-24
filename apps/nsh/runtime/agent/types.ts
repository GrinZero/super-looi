import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { DatabaseSync } from "node:sqlite";
import type {
  AgentRunOptions,
  AgentRunResult,
  AgentScheduleExecutionPolicy,
  AgentTask,
  PiExecutorConfig,
} from "@super-looi/runtime/agent";
import type {
  CompatibleApiProtocol,
  CustomEndpointConfig,
  LlmBrandId,
} from "@super-looi/runtime/agent/llm-providers";
import type { SqliteRuntimeStore } from "@super-looi/runtime/storage";
import type { LangfuseTracer, TraceContext } from "@super-looi/runtime/telemetry";
import type { UiActionGuard, Vault } from "../vault.js";

export interface ModelConfiguration {
  baseUrl: string;
  model: string;
  apiKey: string;
}

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

export interface LlmModelStreamConfig {
  modelsRegistry: NonNullable<PiExecutorConfig["modelsRegistry"]>;
  providerId: string;
  model: string;
  apiKey?: string;
  baseUrl?: string;
}

export interface AgentTaskToolContext {
  taskId: string;
  sessionId?: string;
  workspaceRoot: string;
  approvalMode: "ask" | "local_auto" | "yolo";
  commandTimeoutMs: number;
  scheduleExecutionPolicy?: AgentScheduleExecutionPolicy;
  isForegroundTask: boolean;
}

export interface AgentRunInputOptions {
  onShellOutput?: AgentRunOptions["onShellOutput"];
  agentOnly?: boolean;
  defaultLanguage?: "zh-CN" | "en-US";
  mode?: "text" | "voice";
  approvalMode?: "ask" | "local_auto" | "yolo";
  traceContext?: TraceContext;
}

export type AgentUserTurnGuardResult =
  | {
      readonly decision: "block";
      readonly pluginId?: string;
      readonly stage?: string;
      readonly code?: string;
      readonly reason: string;
      readonly spokenReply?: string;
      readonly cause?: unknown;
    }
  | {
      readonly decision: "handled";
      readonly pluginId?: string;
      readonly spokenReply?: string;
      readonly answer?: string;
    };

export interface AgentRuntimeOptions {
  vault: Vault;
  database: DatabaseSync;
  storage: SqliteRuntimeStore;
  tracer: LangfuseTracer;
  uiSessionId: string;
  assertUiAction: UiActionGuard;
  redactSecrets: (text: string) => string;
  isClosed?: () => boolean;
  stateDirectory?: string;
  workspaceRoot?: string;
  systemPrompt?: string;
  additionalTools?: AgentTool<any>[];
  resolveTaskTools?: (context: AgentTaskToolContext) => {
    tools: AgentTool<any>[];
    skillPaths?: readonly string[];
  };
  approvalRequiredTools?: readonly string[];
  evaluateUserTurn?: (text: string) => Promise<AgentUserTurnGuardResult | undefined>;
  beforeToolCall?: PiExecutorConfig["beforeToolCall"];
  assembleTurnContext?: PiExecutorConfig["assembleTurnContext"];
  beforeExecutorClose?: () => Promise<void>;
  onExecutorReady?: () => void;
  onTaskPersisted?: (task: AgentTask) => void;
  onForegroundTurnSucceeded?: (input: {
    task: AgentTask;
    result: AgentRunResult;
    userPrompt: string;
  }) => void;
  onForegroundTurnFinished?: (taskId: string) => void;
}

export type { CompatibleApiProtocol, CustomEndpointConfig, LlmBrandId };
