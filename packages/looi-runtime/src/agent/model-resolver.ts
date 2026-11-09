import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  createModels,
  createProvider,
  type Api,
  type Model,
  type Models,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

export interface ModelStreamConfig {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  streamFn?: StreamFn;
  modelSpec?: Model<Api>;
  modelsRegistry?: Models;
  providerId?: string;
}

/**
 * Resolves the active `Model<Api>` and `StreamFn` from explicit injection,
 * a shared `Models` registry, or direct OpenAI-compatible gateway credentials.
 */
export function resolvePiModelAndStream(config: ModelStreamConfig): {
  model: Model<Api>;
  streamFn: StreamFn;
} {
  if (config.streamFn && config.modelSpec) {
    return { model: config.modelSpec, streamFn: config.streamFn };
  }
  if (config.streamFn) {
    const fallbackModel: Model<"openai-completions"> = {
      id: config.model ?? "pi-custom-model",
      name: config.model ?? "pi-custom-model",
      api: "openai-completions",
      provider: "looi",
      baseUrl: config.baseUrl ?? "https://example.invalid/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32768,
      maxTokens: 4096,
    };
    return { model: fallbackModel, streamFn: config.streamFn };
  }

  if (config.modelsRegistry && config.providerId) {
    const modelId = config.model;
    if (!modelId) {
      throw new Error(
        "PiAgentExecutor requires a model when using modelsRegistry",
      );
    }
    const found = config.modelsRegistry.getModel(config.providerId, modelId);
    if (!found) {
      throw new Error(
        `Model ${modelId} not found in provider ${config.providerId}`,
      );
    }
    return {
      model: found,
      streamFn: config.modelsRegistry.streamSimple.bind(config.modelsRegistry),
    };
  }

  const baseUrl = config.baseUrl ?? process.env.LLM_BASE_URL;
  const apiKey = config.apiKey ?? process.env.LLM_API_KEY;
  const modelId = config.model ?? process.env.LLM_MODEL;
  if (!baseUrl || !apiKey || !modelId) {
    throw new Error(
      "PiAgentExecutor requires LLM_BASE_URL, LLM_API_KEY and LLM_MODEL",
    );
  }

  const modelSpec: Model<"openai-completions"> = {
    id: modelId,
    name: modelId,
    api: "openai-completions",
    provider: "looi",
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32768,
    maxTokens: 4096,
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsStore: false,
      maxTokensField: "max_tokens",
    },
  };

  const models = createModels();
  const provider = createProvider({
    id: "looi",
    name: "LOOI OpenAI Gateway",
    baseUrl,
    auth: {
      apiKey: {
        name: "LOOI API Key",
        resolve: async () => ({ auth: { apiKey } }),
      },
    },
    models: [modelSpec],
    api: openAICompletionsApi(),
  });
  models.setProvider(provider);

  return {
    model: modelSpec,
    streamFn: models.streamSimple.bind(models),
  };
}
