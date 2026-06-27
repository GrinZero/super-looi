import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { createObserveRoutes } from "../src/routes/observe.js";

const IMAGE_BASE64 = "abc123";

test("voice visual observe route stores combined memory and returns evidence", async () => {
  const stored: Array<{
    messages: Array<{ role: string; content: string }>;
    metadata?: Record<string, any>;
    options?: { infer?: boolean };
  }> = [];

  const server = Fastify({ logger: false });
  await server.register(
    createObserveRoutes({
      describeImage: async (imageBase64, transcript) => {
        assert.equal(imageBase64, IMAGE_BASE64);
        assert.equal(transcript, "记住这个放这了");
        return "一串钥匙在蓝色抽屉里";
      },
      saveEvidenceImage: async () => ({
        url: "http://127.0.0.1:8080/api/evidence/test.png",
        filename: "test.png",
      }),
      addMemory: async (messages, metadata, options) => {
        stored.push({ messages, metadata, options });
        return { ok: true };
      },
      searchMemories: async () => [],
      generateConfirmation: async () => "好的，记住钥匙在蓝色抽屉里。",
    }),
    { prefix: "/api/observe" }
  );

  try {
    const response = await server.inject({
      method: "POST",
      url: "/api/observe/voice-visual",
      payload: {
        transcript: "记住这个放这了",
        imageBase64: IMAGE_BASE64,
        metadata: { category: "placement", timestamp: "2026-06-27T00:00:00.000Z" },
      },
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      response: "好的，记住钥匙在蓝色抽屉里。",
      evidenceUri: "http://127.0.0.1:8080/api/evidence/test.png",
      description: "一串钥匙在蓝色抽屉里",
    });

    assert.equal(stored.length, 1);
    assert.equal(stored[0].messages[0].role, "user");
    assert.match(stored[0].messages[0].content, /记住这个放这了/);
    assert.match(stored[0].messages[0].content, /一串钥匙在蓝色抽屉里/);
    assert.equal(stored[0].metadata?.source, "voice+camera");
    assert.equal(stored[0].metadata?.evidenceUri, "http://127.0.0.1:8080/api/evidence/test.png");
    assert.equal(stored[0].metadata?.description, "一串钥匙在蓝色抽屉里");
    assert.equal(stored[0].options?.infer, false);
  } finally {
    await server.close();
  }
});
