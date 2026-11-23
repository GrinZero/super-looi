import path from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { InMemoryCredentialStore, type CredentialStore } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SettingsManager,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { CHECK_ONLY_ALLOWED_TOOLS } from "../../schedule/check-policy.js";
import type { AgentScheduleExecutionPolicy } from "../executor.js";
import { resolvePiModelAndStream, type ModelStreamConfig } from "./model-resolver.js";
import { NOOP_TRACER, type LangfuseTracer, type TraceContext } from "../../telemetry/langfuse.js";
import { wrapStreamFnWithLangfuse } from "../../telemetry/llm-observer.js";

export interface PiSessionConfig extends ModelStreamConfig {
  taskTools?: (context: {
    taskId: string;
    sessionId?: string;
    workspaceRoot: string;
    approvalMode: "ask" | "local_auto" | "yolo";
    commandTimeoutMs: number;
    scheduleExecutionPolicy?: AgentScheduleExecutionPolicy;
  }) => { tools: AgentTool<any>[]; skillPaths?: readonly string[] };
  beforeToolCall?: (context: {
    callId: string;
    toolName: string;
    arguments: Record<string, unknown>;
    sessionId: string;
    workspaceRoot: string;
    approvalMode: "ask" | "local_auto" | "yolo";
    scheduleExecutionPolicy?: AgentScheduleExecutionPolicy;
  }) =>
    | Promise<
        | undefined
        | { readonly decision: "allow" }
        | { readonly decision: "ask"; readonly promptPayload: Record<string, unknown> }
        | { readonly decision: "deny"; readonly stage?: string; readonly code: string; readonly reason: string }
      >
    | undefined;
  assembleTurnContext?: (input: {
    taskId: string;
    sessionId: string;
    prompt: string;
  }) =>
    | Promise<
        | {
            readonly contextText?: string;
            readonly images?: Array<{ type: "image"; data: string; mimeType: string }>;
          }
        | undefined
      >
    | {
        readonly contextText?: string;
        readonly images?: Array<{ type: "image"; data: string; mimeType: string }>;
      }
    | undefined;
  customTools?: AgentTool<any>[];
  agentDirectory?: string;
  credentialStore?: CredentialStore;
  redactSecrets?: (text: string) => string;
  settings?: Parameters<SettingsManager["applyOverrides"]>[0];
  resources?: Omit<ConstructorParameters<typeof DefaultResourceLoader>[0], "cwd" | "agentDir" | "settingsManager">;
}

const BUILTIN_PI_TOOL_NAMES = [
  "read",
  "bash",
  "powershell",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
] as const;

/** Bind the official SDK to App-owned credentials, resources, and model observations. */
export async function createPiSession(input: {
  config: PiSessionConfig;
  workspaceRoot: string;
  stateDirectory: string;
  sessionManager: import("@earendil-works/pi-coding-agent").SessionManager;
  extension: ExtensionFactory;
  tools: AgentTool<any>[];
  scheduleExecutionPolicy?: AgentScheduleExecutionPolicy;
  tracer?: LangfuseTracer;
  getTraceContext: () => TraceContext | undefined;
  onGeneration: (context: TraceContext) => void;
}) {
  const { config } = input;
  const isCheckOnly = input.scheduleExecutionPolicy === "check_only";
  const agentDir = path.resolve(config.agentDirectory ?? input.stateDirectory);
  const settingsManager = config.settings
    ? SettingsManager.inMemory(config.settings, { projectTrusted: true })
    : SettingsManager.create(input.workspaceRoot, agentDir, { projectTrusted: true });
  if (typeof WebAssembly === "undefined" && config.settings?.images?.autoResize === undefined) {
    // QuickJS mobile runtimes do not expose WebAssembly for Photon image resizing;
    // native camera frames are already downscaled by DeviceCameraHost.
    settingsManager.applyOverrides({ images: { autoResize: false } });
  }
  const { model, streamFn, models } = resolvePiModelAndStream(config);
  const modelRuntime = await ModelRuntime.create({
    credentials: config.credentialStore ?? new InMemoryCredentialStore(),
    modelsPath: path.join(agentDir, "models.json"),
    refreshOnCreate: false,
  });
  for (const provider of models?.getProviders() ?? []) modelRuntime.registerNativeProvider(provider);
  if (config.apiKey) await modelRuntime.setRuntimeApiKey(model.provider, config.apiKey);
  const stream = config.streamFn ? streamFn : modelRuntime.streamSimple.bind(modelRuntime);
  // Keep the SDK's stream function intact: it owns routing, provider hooks and summary auth.
  modelRuntime.streamSimple = wrapStreamFnWithLangfuse(stream, {
    tracer: input.tracer ?? NOOP_TRACER,
    getTraceContext: input.getTraceContext,
    onGeneration: input.onGeneration,
  });

  const extensionFactories = isCheckOnly
    ? [...(config.resources?.extensionFactories ?? []), input.extension]
    : [
        createCodemodeExtension(),
        createToolSearchExtension(),
        createMcpExtension({ logPath: path.join(agentDir, "mcp.log") }),
        ...(config.resources?.extensionFactories ?? []),
        input.extension,
      ];

  const resources = new DefaultResourceLoader({
    ...config.resources,
    cwd: input.workspaceRoot,
    agentDir,
    settingsManager,
    noThemes: true,
    extensionFactories,
  });
  await resources.reload();
  const settingsErrors = settingsManager.drainErrors();
  if (settingsErrors.length) {
    throw new Error(`Pi settings load failed: ${settingsErrors.map(item => `${item.scope} ${item.path ?? ""}: ${item.error.message}`).join("; ")}`);
  }
  if (isCheckOnly) {
    settingsManager.applyOverrides({ defaultTools: ["read", "ls", "find", "grep"] });
  } else if (settingsManager.getDefaultTools() === undefined) {
    settingsManager.applyOverrides({ defaultTools: ["read", "bash", "edit", "write", "codemode", "tool_search"] });
  }
  const failures = resources.getExtensions().errors;
  if (failures.length) {
    throw new Error(`Pi resource loading failed: ${failures.map(item => `${item.path}: ${item.error}`).join("; ")}`);
  }

  let sessionToolOptions: Partial<Parameters<typeof createAgentSession>[0]> = {};
  if (isCheckOnly) {
    if (config.customTools) {
      const customNames = new Set(input.tools.map((tool) => tool.name));
      const builtinToExclude = BUILTIN_PI_TOOL_NAMES.filter((name) => !customNames.has(name));
      sessionToolOptions = {
        noTools: "builtin" as const,
        tools: [...CHECK_ONLY_ALLOWED_TOOLS],
        excludeTools: builtinToExclude,
      };
    } else {
      sessionToolOptions = {
        tools: [...CHECK_ONLY_ALLOWED_TOOLS],
      };
    }
  } else if (config.customTools) {
    sessionToolOptions = { noTools: "builtin" as const };
  }

  const { session } = await createAgentSession({
    cwd: input.workspaceRoot,
    agentDir,
    model,
    modelRuntime,
    settingsManager,
    resourceLoader: resources,
    sessionManager: input.sessionManager,
    customTools: input.tools,
    ...sessionToolOptions,
  });
  // The App owns one native interaction surface and serial device command receipts.
  session.agent.toolExecution = "sequential";
  return session;
}
