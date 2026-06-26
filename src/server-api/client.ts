import {
  ContextService,
  LLMService,
  VisionService,
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
