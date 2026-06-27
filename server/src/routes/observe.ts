import { FastifyInstance } from "fastify";
import OpenAI from "openai";
import { config } from "../config.js";
import { saveEvidenceImage } from "./evidence.js";
import { addMemory, searchMemories } from "./memory.js";

const openai = new OpenAI({
  baseURL: config.llm.baseUrl,
  apiKey: config.llm.apiKey,
});

async function describeImage(imageBase64: string, transcript: string): Promise<string> {
  const imageUrl = imageBase64.startsWith("data:")
    ? imageBase64
    : `data:image/jpeg;base64,${imageBase64}`;

  const response = await fetch(`${config.vision.serverUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "minicpm-v-2.6",
      messages: [{
        role: "user",
        content: [
          {
            type: "text",
            text: `用户说："${transcript}"。请描述画面中的物品、位置和环境，用一句简洁中文回答。`,
          },
          { type: "image_url", image_url: { url: imageUrl } },
        ],
      }],
      max_tokens: 500,
      temperature: 0.2,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Vision server error ${response.status}: ${errText}`);
  }

  const data = await response.json() as any;
  return data.choices?.[0]?.message?.content || "无法识别图片内容";
}

async function generateConfirmation(transcript: string, description: string): Promise<string> {
  try {
    const response = await openai.chat.completions.create({
      model: config.llm.model,
      messages: [
        {
          role: "system",
          content: "你是 LOOI，一个记忆助手。用户正在让你记住眼前物品的位置。请基于视觉描述简短确认，不超过 30 字，不要编造未出现的信息。",
        },
        {
          role: "user",
          content: `用户原话：${transcript}\n视觉描述：${description}`,
        },
      ],
      temperature: 0.4,
      max_tokens: 80,
    });

    return response.choices[0]?.message?.content || "好的，我记住了，也保存了证据图片。";
  } catch {
    return "好的，我记住了，也保存了证据图片。";
  }
}

export async function observeRoutes(fastify: FastifyInstance) {
  fastify.post<{
    Body: {
      transcript: string;
      imageBase64: string;
      metadata?: Record<string, any>;
    };
  }>("/voice-visual", async (request, reply) => {
    const { transcript, imageBase64, metadata } = request.body;

    if (!transcript) {
      return reply.status(400).send({ error: "transcript is required" });
    }
    if (!imageBase64) {
      return reply.status(400).send({ error: "imageBase64 is required" });
    }
    if (!config.vision.enabled) {
      return reply.status(503).send({ error: "Vision service is disabled" });
    }

    try {
      const description = await describeImage(imageBase64, transcript);
      const evidence = await saveEvidenceImage(imageBase64, request);

      const memoryText = `用户说：${transcript}\n视觉观察：${description}`;
      const memoryMetadata = {
        ...metadata,
        category: metadata?.category || "placement",
        source: "voice+camera",
        timestamp: metadata?.timestamp || new Date().toISOString(),
        evidenceUri: evidence.url,
        description,
      };

      await addMemory([{ role: "user", content: memoryText }], memoryMetadata);

      const response = await generateConfirmation(transcript, description);
      return {
        response,
        evidenceUri: evidence.url,
        description,
      };
    } catch (error: any) {
      fastify.log.error(error, "Voice visual observation failed");
      return reply.status(500).send({
        error: "Failed to process voice visual observation",
        details: error.message,
      });
    }
  });

  fastify.post<{
    Body: { query: string; topK?: number };
  }>("/search-with-evidence", async (request, reply) => {
    const { query, topK } = request.body;
    if (!query) {
      return reply.status(400).send({ error: "query is required" });
    }

    const results = await searchMemories(query, undefined, topK);
    return { results };
  });
}
