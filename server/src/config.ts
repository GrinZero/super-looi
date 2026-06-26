export const config = {
  llm: {
    baseUrl: process.env.LLM_BASE_URL || "https://api.openai.com/v1",
    apiKey: process.env.LLM_API_KEY || "",
    model: process.env.LLM_MODEL || "gpt-4o",
    embeddingModel: process.env.EMBEDDING_MODEL || "text-embedding-3-small",
  },
  supabase: {
    url: process.env.SUPABASE_URL || "",
    anonKey: process.env.SUPABASE_ANON_KEY || "",
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || "",
  },
  minimax: {
    apiKey: process.env.MINIMAX_API_KEY || "",
    groupId: process.env.MINIMAX_GROUP_ID || "",
  },
  server: {
    port: parseInt(process.env.PORT || "8080", 10),
    host: process.env.HOST || "0.0.0.0",
  },
  vision: {
    // MiniCPM-V model path (for llama.cpp integration)
    modelPath: process.env.VISION_MODEL_PATH || "./models/minicpm-v-4.6.gguf",
    enabled: process.env.VISION_ENABLED !== "false",
  },
} as const;
