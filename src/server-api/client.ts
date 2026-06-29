import {
  ChatMessage,
  ContextService,
  LLMStreamEvent,
  LLMService,
  SessionSummary,
  VisionService,
  ObserveService,
  Message,
  MemoryResult,
  UserIntent,
} from "../core/context-service";
import { MemoryCategory, ObservationMetadata } from "../core/observation";

const DEFAULT_SERVER_URL = "http://192.168.3.71:8080";

function getServerUrl(): string {
  // In React Native, env vars are injected at build time
  return process.env.EXPO_PUBLIC_LOOI_SERVER_URL || DEFAULT_SERVER_URL;
}


export function getConfiguredServerUrl(): string {
  return getServerUrl();
}

async function fetchJSON<T>(path: string, options?: RequestInit): Promise<T> {
  const url = `${getServerUrl()}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Server error ${res.status}: ${text}`);
  }

  return res.json() as Promise<T>;
}

function normalizeParams(params?: Record<string, string | number | undefined>): string {
  const searchParams = new URLSearchParams();
  Object.entries(params ?? {}).forEach(([key, value]) => {
    if (value !== undefined) {
      searchParams.set(key, String(value));
    }
  });
  const query = searchParams.toString();
  return query ? `?${query}` : "";
}

async function* parseSSE(response: Response): AsyncGenerator<LLMStreamEvent> {
  if (!response.body) {
    throw new Error("Streaming response body is not available");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const emitEvent = (chunk: string): LLMStreamEvent | null => {
    const lines = chunk.split(/\r?\n/);
    let eventName = "message";
    const dataLines: string[] = [];

    for (const line of lines) {
      if (line.startsWith("event:")) {
        eventName = line.slice("event:".length).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trim());
      }
    }

    if (dataLines.length === 0) {
      return null;
    }

    const data = JSON.parse(dataLines.join("\n")) as Record<string, unknown>;
    if (eventName === "token") {
      return { type: "token", text: String(data.text ?? "") };
    }
    if (eventName === "done") {
      return {
        type: "done",
        fullText: String(data.fullText ?? ""),
        evidenceUri: typeof data.evidenceUri === "string" ? data.evidenceUri : undefined,
      };
    }
    if (eventName === "error") {
      return { type: "error", message: String(data.message ?? "Stream failed") };
    }
    return null;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });

      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() ?? "";

      for (const eventChunk of events) {
        const event = emitEvent(eventChunk);
        if (event) {
          yield event;
        }
      }

      if (done) {
        if (buffer.trim()) {
          const event = emitEvent(buffer);
          if (event) {
            yield event;
          }
        }
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Memory service — communicates with local server's memory endpoints
 */
export const memoryService: ContextService = {
  async remember(messages: Message[], metadata: ObservationMetadata): Promise<void> {
    await fetchJSON("/api/memory/add", {
      method: "POST",
      body: JSON.stringify({ messages, metadata }),
    });
  },

  async search(query: string, filters?: { category?: MemoryCategory }): Promise<MemoryResult[]> {
    const result = await fetchJSON<{ results: MemoryResult[] }>("/api/memory/search", {
      method: "POST",
      body: JSON.stringify({ query, filters }),
    });
    return result.results;
  },

  async getAll(filters?: { category?: MemoryCategory }): Promise<MemoryResult[]> {
    const params = new URLSearchParams();
    if (filters?.category) params.set("category", filters.category);
    const result = await fetchJSON<{ results: MemoryResult[] }>(
      `/api/memory/getAll?${params.toString()}`
    );
    return result.results;
  },
};

/**
 * LLM service — communicates with local server's LLM endpoints
 */
export const llmService: LLMService = {
  async classifyIntent(transcript: string): Promise<UserIntent> {
    const result = await fetchJSON<{ intent: UserIntent }>("/api/llm/classify-intent", {
      method: "POST",
      body: JSON.stringify({ transcript }),
    });
    return result.intent;
  },

  async generateResponse(
    intent: UserIntent,
    context: { facts: MemoryResult[]; transcript: string }
  ): Promise<string> {
    const result = await fetchJSON<{ response: string }>("/api/llm/generate-response", {
      method: "POST",
      body: JSON.stringify({ intent, ...context }),
    });
    return result.response;
  },

  async *generateResponseStream(context) {
    const response = await fetch(`${getServerUrl()}/api/llm/generate-response-stream`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(context),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Server error ${response.status}: ${text}`);
    }

    yield* parseSSE(response);
  },
};

export const sessionService = {
  async touch(): Promise<{ sessionId: string; isNew: boolean; previousSummary?: string }> {
    return fetchJSON("/api/session/touch", {
      method: "POST",
      body: JSON.stringify({}),
    });
  },

  async addMessage(
    sessionId: string,
    message: { role: "user" | "assistant"; content: string; evidenceUri?: string }
  ): Promise<{ messageId: string }> {
    return fetchJSON(`/api/session/${encodeURIComponent(sessionId)}/message`, {
      method: "POST",
      body: JSON.stringify(message),
    });
  },

  async listSessions(params?: {
    limit?: number;
    offset?: number;
  }): Promise<{ sessions: SessionSummary[] }> {
    return fetchJSON(`/api/session/list${normalizeParams(params)}`);
  },

  async getMessages(
    sessionId: string,
    params?: { limit?: number; offset?: number }
  ): Promise<{ messages: ChatMessage[] }> {
    return fetchJSON(
      `/api/session/${encodeURIComponent(sessionId)}/messages${normalizeParams(params)}`
    );
  },
};

/**
 * Vision service — communicates with local server's vision endpoint
 */
export const visionService: VisionService = {
  async describe(imageBase64: string, prompt?: string): Promise<string> {
    const result = await fetchJSON<{ description: string }>("/api/vision/describe", {
      method: "POST",
      body: JSON.stringify({ image: imageBase64, prompt }),
    });
    return result.description;
  },
};

export const observeService: ObserveService = {
  async voiceVisual(transcript, imageBase64, metadata) {
    return fetchJSON("/api/observe/voice-visual", {
      method: "POST",
      body: JSON.stringify({ transcript, imageBase64, metadata }),
    });
  },
};

/**
 * Health check
 */
export async function checkServerHealth(): Promise<boolean> {
  try {
    const result = await fetchJSON<{ status: string }>("/health");
    return result.status === "ok";
  } catch {
    return false;
  }
}
