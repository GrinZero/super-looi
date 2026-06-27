import { FastifyInstance } from "fastify";
import { Memory } from "mem0ai/oss";
import { config } from "../config.js";

// Mem0 initialization — uses pgvector for persistent vector storage
let memory: Memory | null = null;

function getMemory(): Memory {
  if (!memory) {
    const databaseUrl = new URL(config.database.url);
    memory = new Memory({
      vectorStore: {
        provider: "pgvector",
        config: {
          collectionName: "looi_memories",
          dbname: databaseUrl.pathname.replace(/^\//, ""),
          host: databaseUrl.hostname,
          port: Number(databaseUrl.port || 5432),
          user: decodeURIComponent(databaseUrl.username),
          password: decodeURIComponent(databaseUrl.password),
          embeddingModelDims: 1536,
          hnsw: true,
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
    });
  }
  return memory;
}

const USER_ID = "owner-1"; // Phase 1: single owner

type MemoryMessage = Array<{ role: string; content: string }>;
interface MemoryRouteDependencies {
  addMemory: typeof addMemory;
  searchMemories: typeof searchMemories;
  getAllMemories: typeof getAllMemories;
}

export function buildOwnerMemoryFilters(filters?: { category?: string }): Record<string, any> {
  const memoryFilters: Record<string, any> = { user_id: USER_ID };
  if (filters?.category) {
    memoryFilters.category = filters.category;
  }

  return memoryFilters;
}

export async function addMemory(
  messages: MemoryMessage,
  metadata?: Record<string, any>,
  options?: { infer?: boolean }
): Promise<unknown> {
  return getMemory().add(messages, {
    userId: USER_ID,
    metadata: metadata || {},
    infer: options?.infer,
  });
}

export async function searchMemories(
  query: string,
  filters?: { category?: string },
  topK = 5
): Promise<unknown[]> {
  const result = await getMemory().search(query, {
    filters: buildOwnerMemoryFilters(filters),
    topK,
  });

  return result.results || [];
}

export async function getAllMemories(filters?: { category?: string }): Promise<unknown[]> {
  const result = await getMemory().getAll({
    filters: buildOwnerMemoryFilters(filters),
  });

  return result.results || [];
}

export function createMemoryRoutes(
  dependencies: MemoryRouteDependencies = {
    addMemory,
    searchMemories,
    getAllMemories,
  }
) {
  /**
   * Memory routes — /api/memory/*
   */
  return async function memoryRoutes(fastify: FastifyInstance) {
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
      const result = await dependencies.addMemory(messages, metadata);

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
      const results = await dependencies.searchMemories(query, filters, topK || 5);
      return { results };
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
      const results = await dependencies.getAllMemories({ category });
      return { results };
    } catch (error: any) {
      fastify.log.error(error, "Memory getAll failed");
      return reply.status(500).send({
        error: "Failed to get memories",
        details: error.message,
      });
    }
  });
  };
}

export const memoryRoutes = createMemoryRoutes();
