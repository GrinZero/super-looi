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
import { resolvePiModelAndStream, type ModelStreamConfig } from "./model-resolver.js";
import { NOOP_TRACER, type LangfuseTracer, type TraceContext } from "../../telemetry/langfuse.js";
import { wrapStreamFnWithLangfuse } from "../../telemetry/llm-observer.js";

export interface PiSessionConfig extends ModelStreamConfig {
  taskTools?: (context: { taskId: string; workspaceRoot: string; approvalMode: "ask" | "local_auto" | "yolo"; commandTimeoutMs: number }) => { tools: AgentTool<any>[]; skillPaths?: readonly string[] };
  customTools?: AgentTool<any>[];
  agentDirectory?: string;
  credentialStore?: CredentialStore;
  settings?: Parameters<SettingsManager["applyOverrides"]>[0];
  resources?: Omit<ConstructorParameters<typeof DefaultResourceLoader>[0], "cwd" | "agentDir" | "settingsManager">;
}

/** Bind the official SDK to App-owned credentials, resources, and model observations. */
export async function createPiSession(input: {
  config: PiSessionConfig;
  workspaceRoot: string;
  stateDirectory: string;
  sessionManager: import("@earendil-works/pi-coding-agent").SessionManager;
  extension: ExtensionFactory;
  tools: AgentTool<any>[];
  tracer?: LangfuseTracer;
  getTraceContext: () => TraceContext | undefined;
  onGeneration: (context: TraceContext) => void;
}) {
  const { config } = input;
  const agentDir = path.resolve(config.agentDirectory ?? input.stateDirectory);
  const settingsManager = config.settings
    ? SettingsManager.inMemory(config.settings, { projectTrusted: true })
    : SettingsManager.create(input.workspaceRoot, agentDir, { projectTrusted: true });
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
  const resources = new DefaultResourceLoader({
    ...config.resources,
    cwd: input.workspaceRoot,
    agentDir,
    settingsManager,
    noThemes: true,
    extensionFactories: [
      createCodemodeExtension(),
      createToolSearchExtension(),
      createMcpExtension({ logPath: path.join(agentDir, "mcp.log") }),
      ...(config.resources?.extensionFactories ?? []),
      input.extension,
    ],
  });
  await resources.reload();
  const settingsErrors = settingsManager.drainErrors();
  if (settingsErrors.length) {
    throw new Error(`Pi settings load failed: ${settingsErrors.map(item => `${item.scope} ${item.path ?? ""}: ${item.error.message}`).join("; ")}`);
  }
  if (settingsManager.getDefaultTools() === undefined) {
    settingsManager.applyOverrides({ defaultTools: ["read", "bash", "edit", "write", "codemode", "tool_search"] });
  }
  const failures = resources.getExtensions().errors;
  if (failures.length) {
    throw new Error(`Pi resource loading failed: ${failures.map(item => `${item.path}: ${item.error}`).join("; ")}`);
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
    ...(config.customTools ? { noTools: "builtin" as const } : {}),
  });
  // The App owns one native interaction surface and serial device command receipts.
  session.agent.toolExecution = "sequential";
  return session;
}
