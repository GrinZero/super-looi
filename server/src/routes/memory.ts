import { FastifyInstance } from "fastify";
import { Memory } from "mem0ai/oss";
import path from "path";
import { config } from "../config.js";

// Mem0 initialization — uses local SQLite vector store (no external DB needed)
let memory: Memory | null = null;

function getMemory(): Memory {
  if (!memory) {
    const dbPath = path.resolve(process.cwd(), "data", "memories.db");
    memory = new Memory({
      vectorStore: {
        provider: "memory",
        config: {
          collectionName: "looi_memories",
          dimension: 1536,
          dbPath,
        },
      },
      llm: {
        provider: "openai",
        config: {
          apiKey: config.llm.apiKey,
          model: config.llm.model,
          baseURL: config.llm.baseUrl,
        },
      },
      embedder: {
        provider: "openai",
        config: {
          apiKey: config.llm.apiKey,
          model: config.llm.embeddingModel,
          baseURL: config.llm.baseUrl,
        },
      },
      historyStore: {
        provider: "sqlite",
        config: {
          historyDbPath: path.resolve(process.cwd(), "data", "history.db"),
        },
      },
    });
  }
  return memory;
}

const USER_ID = "owner-1"; // Phase 1: single owner

/**
 * Memory routes — /api/memory/*
 */
export async function memoryRoutes(fastify: FastifyInstance) {
  /**
   * POST /api/memory/add
   * Store a new memory
   */
  fastify.post<{
    Body: {
      messages: Array<{ role: string; content: string }>;
      metadata?: Record<string, any>;
    };
  }>("/add", async (request, reply) => {
    const { messages, metadata } = request.body;

    if (!messages || messages.length === 0) {
      return reply.status(400).send({ error: "messages array is required" });
    }

    try {
      const result = await getMemory().add(messages, {
        userId: USER_ID,
        metadata: metadata || {},
      });

      return { success: true, result };
    } catch (error: any) {
      fastify.log.error(error, "Memory add failed");
      return reply.status(500).send({
        error: "Failed to add memory",
        details: error.message,
      });
    }
  });

  /**
   * POST /api/memory/search
   * Semantic search for memories
   */
  fastify.post<{
    Body: { query: string; filters?: { category?: string }; topK?: number };
  }>("/search", async (request, reply) => {
    const { query, filters, topK } = request.body;

    if (!query) {
      return reply.status(400).send({ error: "query is required" });
    }

    try {
      const searchFilters: Record<string, any> = { user_id: USER_ID };
      if (filters?.category) {
        searchFilters.category = filters.category;
      }

      const result = await getMemory().search(query, {
        filters: searchFilters,
        topK: topK || 5,
      });

      return { results: result.results || [] };
    } catch (error: any) {
      fastify.log.error(error, "Memory search failed");
      return reply.status(500).send({
        error: "Failed to search memories",
        details: error.message,
      });
    }
  });

  /**
   * GET /api/memory/getAll
   * Get all memories with optional category filter
   */
  fastify.get<{
    Querystring: { category?: string };
  }>("/getAll", async (request, reply) => {
    const { category } = request.query;

    try {
      const filters: Record<string, any> = { user_id: USER_ID };
      if (category) {
        filters.category = category;
      }

      const result = await getMemory().getAll({
        filters,
      });

      return { results: result.results || [] };
    } catch (error: any) {
      fastify.log.error(error, "Memory getAll failed");
      return reply.status(500).send({
        error: "Failed to get memories",
        details: error.message,
      });
    }
  });
}
