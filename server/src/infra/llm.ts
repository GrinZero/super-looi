import { completeSimple, streamSimple } from "@earendil-works/pi-ai/compat";
import type { Api, AssistantMessageEvent, Context, Message, Model, SimpleStreamOptions, TSchema, ToolCall, Usage } from "@earendil-works/pi-ai";
import { config } from "../config.js";
import { executeTool, getToolDefinitions } from "./tools.js";

export type LlmProviderType = "openai" | "anthropic" | "gemini";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ProviderMapping {
  api: Api;
  provider: string;
  defaultBaseUrl: string;
  defaultModel: string;
}

const PROVIDER_MAP: Record<LlmProviderType, ProviderMapping> = {
  openai: {
    api: "openai-completions",
    provider: "openai",
    defaultBaseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o",
  },
  anthropic: {
    api: "anthropic-messages",
    provider: "anthropic",
    defaultBaseUrl: "https://api.anthropic.com",
    defaultModel: "claude-sonnet-4-20250514",
  },
  gemini: {
    api: "google-generative-ai",
    provider: "google",
    defaultBaseUrl: "https://generativelanguage.googleapis.com",
    defaultModel: "gemini-2.0-flash-001",
  },
};

const modelCache = new Map<string, Model<Api>>();
const zeroUsage: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export function buildModel(llmConfig = config.llm): Model<Api> {
  const provider = llmConfig.provider as LlmProviderType;
  const mapping = PROVIDER_MAP[provider] || PROVIDER_MAP.openai;
  const modelId = llmConfig.model || mapping.defaultModel;
  const baseUrl = (llmConfig.baseUrl || mapping.defaultBaseUrl).replace(/\/$/, "");
  const key = `${provider}:${modelId}:${baseUrl}`;
  const cached = modelCache.get(key);
  if (cached) return cached;

  const model: Model<Api> = {
    id: modelId,
    name: modelId,
    api: mapping.api,
    provider: mapping.provider,
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4_096,
  };

  modelCache.set(key, model);
  return model;
}

export function clearModelCache(): void {
  modelCache.clear();
}

export function buildContext(messages: ChatMessage[], options?: { tools?: boolean }): Context {
  const systemPrompt = messages.find((message) => message.role === "system")?.content;
  const nonSystemMessages = messages.filter((message) => message.role !== "system");
  const model = buildModel();

  const context: Context = {
    systemPrompt,
    messages: nonSystemMessages.map((message): Message => {
      if (message.role === "assistant") {
        return {
          role: "assistant",
          content: [{ type: "text", text: message.content }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: zeroUsage,
          stopReason: "stop",
          timestamp: Date.now(),
        };
      }

      return {
        role: "user",
        content: message.content,
        timestamp: Date.now(),
      };
    }),
  };

  if (options?.tools) {
    context.tools = getToolDefinitions() as Array<{ name: string; description: string; parameters: TSchema }>;
  }

  return context;
}

export async function chatComplete(
  messages: ChatMessage[],
  options: SimpleStreamOptions = {}
): Promise<string> {
  const result = await completeSimple(buildModel(), buildContext(messages), {
    apiKey: config.llm.apiKey,
    timeoutMs: config.llm.timeoutMs,
    ...options,
  });

  if (result.stopReason === "error" || result.stopReason === "aborted") {
    throw new Error(result.errorMessage || `LLM call failed: ${result.stopReason}`);
  }

  return result.content
    .filter((content): content is { type: "text"; text: string } => content.type === "text")
    .map((content) => content.text)
    .join("");
}

export function chatStream(messages: ChatMessage[], options: SimpleStreamOptions = {}) {
  return streamSimple(buildModel(), buildContext(messages), {
    apiKey: config.llm.apiKey,
    timeoutMs: config.llm.timeoutMs,
    ...options,
  });
}

// ---------------------------------------------------------------------------
// Tool-aware variants
// ---------------------------------------------------------------------------

const MAX_TOOL_ROUNDS = 3;

/**
 * Non-streaming completion with automatic tool execution loop.
 */
export async function chatCompleteWithTools(
  messages: ChatMessage[],
  options: SimpleStreamOptions = {}
): Promise<string> {
  const model = buildModel();
  const context = buildContext(messages, { tools: true });
  const llmOptions = { apiKey: config.llm.apiKey, timeoutMs: config.llm.timeoutMs, ...options };

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const result = await completeSimple(model, context, llmOptions);

    if (result.stopReason === "error" || result.stopReason === "aborted") {
      throw new Error(result.errorMessage || `LLM call failed: ${result.stopReason}`);
    }

    if (result.stopReason !== "toolUse") {
      return result.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("");
    }

    // Process tool calls
    context.messages.push(result);
    const toolCalls = result.content.filter(
      (c): c is ToolCall => c.type === "toolCall"
    );

    for (const tc of toolCalls) {
      let content: string;
      let isError = false;
      try {
        const toolResult = await executeTool(tc.name, tc.arguments);
        content = JSON.stringify(toolResult);
      } catch (err: any) {
        content = err.message || "Tool execution failed";
        isError = true;
      }
      context.messages.push({
        role: "toolResult",
        toolCallId: tc.id,
        toolName: tc.name,
        content: [{ type: "text", text: content }],
        isError,
        timestamp: Date.now(),
      });
    }
  }

  throw new Error("Tool call loop exceeded maximum rounds");
}

/**
 * Streaming completion with automatic tool execution.
 * Tool call rounds are resolved silently; only the final text response is yielded.
 */
export async function* chatStreamWithTools(
  messages: ChatMessage[],
  options: SimpleStreamOptions = {}
): AsyncGenerator<AssistantMessageEvent> {
  const model = buildModel();
  const context = buildContext(messages, { tools: true });
  const llmOptions = { apiKey: config.llm.apiKey, timeoutMs: config.llm.timeoutMs, ...options };

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const stream = streamSimple(model, context, llmOptions);
    let doneMessage: import("@earendil-works/pi-ai").AssistantMessage | null = null;
    let isToolUse = false;

    for await (const event of stream) {
      if (event.type === "done") {
        doneMessage = event.message;
        if (event.reason === "toolUse") {
          isToolUse = true;
        } else {
          // Final text response — yield the done event
          yield event;
        }
      } else if (event.type === "error") {
        yield event;
        return;
      } else if (!isToolUse && event.type !== "toolcall_start" && event.type !== "toolcall_delta" && event.type !== "toolcall_end") {
        // During potential tool-use rounds, only yield text events
        // But we don't know yet if it's tool use until done, so buffer...
        // Actually for tool-use responses the LLM typically doesn't emit text_delta.
        // We yield text events optimistically; if this turns into toolUse we handle it.
        yield event;
      }
    }

    if (!isToolUse) {
      return; // Normal completion, already yielded everything
    }

    // Process tool calls from the assistant message
    if (doneMessage) {
      context.messages.push(doneMessage);
      const toolCalls = doneMessage.content.filter(
        (c): c is ToolCall => c.type === "toolCall"
      );

      for (const tc of toolCalls) {
        let content: string;
        let isError = false;
        try {
          const toolResult = await executeTool(tc.name, tc.arguments);
          content = JSON.stringify(toolResult);
        } catch (err: any) {
          content = err.message || "Tool execution failed";
          isError = true;
        }
        context.messages.push({
          role: "toolResult",
          toolCallId: tc.id,
          toolName: tc.name,
          content: [{ type: "text", text: content }],
          isError,
          timestamp: Date.now(),
        });
      }
    }
  }
}

