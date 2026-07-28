export const config = {
  llm: {
    provider: (process.env.LLM_PROVIDER || "openai") as "openai" | "anthropic" | "gemini",
    baseUrl: process.env.LLM_BASE_URL || "https://api.openai.com/v1",
    apiKey: process.env.LLM_API_KEY || "",
    model: process.env.LLM_MODEL || "gpt-4o",
    timeoutMs: Number.parseInt(process.env.LLM_TIMEOUT_MS || "60000", 10),
    // mem0's internal fact-extraction LLM. Kept separate from the main chat
    // model because it always sends a raw `temperature` value, which newer
    // Claude models (Sonnet 5, Opus 5+) reject outright.
    memoryModel: process.env.MEM0_LLM_MODEL || "",
  },
  // Anthropic has no embeddings API, so memory's vector search always needs
  // a separate embedding provider/key regardless of what LLM_PROVIDER is set to.
  embedding: {
    provider: process.env.EMBEDDING_PROVIDER || "openai",
    baseUrl: process.env.EMBEDDING_BASE_URL || "https://api.openai.com/v1",
    apiKey: process.env.EMBEDDING_API_KEY || process.env.LLM_API_KEY || "",
    model: process.env.EMBEDDING_MODEL || "text-embedding-3-small",
  },
  minimax: {
    apiKey: process.env.MINIMAX_API_KEY || "",
    groupId: process.env.MINIMAX_GROUP_ID || "",
  },
  database: {
    url: process.env.DATABASE_URL || "postgresql://looi:superlooi123!@localhost:5432/looi",
  },
  server: {
    port: parseInt(process.env.PORT || "8080", 10),
    host: process.env.HOST || "0.0.0.0",
  },
  vision: {
    serverUrl: process.env.VISION_SERVER_URL || "http://localhost:8082",
    enabled: process.env.VISION_ENABLED !== "false",
  },
} as const;
