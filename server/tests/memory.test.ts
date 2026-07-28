import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { config } from "../src/config.js";
import { buildMemoryConfig, buildOwnerMemoryFilters, createMemoryRoutes } from "../src/routes/memory.js";

test("memory config disables Mem0 sqlite history while keeping pgvector storage", () => {
  const memoryConfig = buildMemoryConfig();

  assert.equal(memoryConfig?.disableHistory, true);
  assert.ok(memoryConfig?.vectorStore);
  assert.equal(memoryConfig.vectorStore.provider, "pgvector");
});

test("memory llm falls back to a temperature-tolerant model on anthropic, embedder stays independent", () => {
  const llm = config.llm as { provider: string; model: string; memoryModel: string };
  const originalProvider = llm.provider;
  const originalMemoryModel = llm.memoryModel;

  try {
    llm.provider = "anthropic";
    llm.memoryModel = "";

    const memoryConfig = buildMemoryConfig();
    assert.ok(memoryConfig);
    assert.ok(memoryConfig.llm);
    assert.ok(memoryConfig.embedder);

    assert.equal(memoryConfig.llm.provider, "anthropic");
    assert.equal(memoryConfig.llm.config.model, "claude-haiku-4-5-20251001");
    assert.equal(memoryConfig.llm.config.baseURL, undefined);

    assert.equal(memoryConfig.embedder.provider, config.embedding.provider);
    assert.equal(memoryConfig.embedder.config.model, config.embedding.model);
    assert.equal(memoryConfig.embedder.config.baseURL, config.embedding.baseUrl);
    assert.equal(memoryConfig.embedder.config.apiKey, config.embedding.apiKey);

    llm.memoryModel = "claude-explicit-override";
    const overridden = buildMemoryConfig();
    assert.ok(overridden);
    assert.ok(overridden.llm);
    assert.equal(overridden.llm.config.model, "claude-explicit-override");
  } finally {
    llm.provider = originalProvider;
    llm.memoryModel = originalMemoryModel;
  }
});

test("memory filters always scope to owner and preserve metadata category", () => {
  assert.deepEqual(buildOwnerMemoryFilters(), { user_id: "owner-1" });
  assert.deepEqual(buildOwnerMemoryFilters({ category: "placement" }), {
    user_id: "owner-1",
    category: "placement",
  });
});

test("memory routes pass metadata, filters, and topK to dependencies", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const server = Fastify({ logger: false });

  await server.register(
    createMemoryRoutes({
      addMemory: async (messages, metadata) => {
        calls.push({ type: "add", messages, metadata });
        return { id: "memory-1" };
      },
      searchMemories: async (query, filters, topK) => {
        calls.push({ type: "search", query, filters, topK });
        return [{ memory: "钥匙在抽屉里" }];
      },
      getAllMemories: async (filters) => {
        calls.push({ type: "getAll", filters });
        return [{ memory: "日历提醒" }];
      },
    }),
    { prefix: "/api/memory" }
  );

  try {
    const add = await server.inject({
      method: "POST",
      url: "/api/memory/add",
      payload: {
        messages: [{ role: "user", content: "钥匙在抽屉里" }],
        metadata: { category: "placement" },
      },
    });
    assert.equal(add.statusCode, 200);
    assert.deepEqual(add.json(), { success: true, result: { id: "memory-1" } });

    const search = await server.inject({
      method: "POST",
      url: "/api/memory/search",
      payload: {
        query: "钥匙在哪",
        filters: { category: "placement" },
        topK: 3,
      },
    });
    assert.equal(search.statusCode, 200);
    assert.deepEqual(search.json(), { results: [{ memory: "钥匙在抽屉里" }] });

    const getAll = await server.inject({
      method: "GET",
      url: "/api/memory/getAll?category=reminder",
    });
    assert.equal(getAll.statusCode, 200);
    assert.deepEqual(getAll.json(), { results: [{ memory: "日历提醒" }] });

    assert.deepEqual(calls, [
      {
        type: "add",
        messages: [{ role: "user", content: "钥匙在抽屉里" }],
        metadata: { category: "placement" },
      },
      {
        type: "search",
        query: "钥匙在哪",
        filters: { category: "placement" },
        topK: 3,
      },
      {
        type: "getAll",
        filters: { category: "reminder" },
      },
    ]);
  } finally {
    await server.close();
  }
});

test("memory routes reject missing required fields", async () => {
  const server = Fastify({ logger: false });
  await server.register(createMemoryRoutes(), { prefix: "/api/memory" });

  try {
    const add = await server.inject({
      method: "POST",
      url: "/api/memory/add",
      payload: { messages: [] },
    });
    assert.equal(add.statusCode, 400);
    assert.deepEqual(add.json(), { error: "messages array is required" });

    const search = await server.inject({
      method: "POST",
      url: "/api/memory/search",
      payload: {},
    });
    assert.equal(search.statusCode, 400);
    assert.deepEqual(search.json(), { error: "query is required" });
  } finally {
    await server.close();
  }
});
