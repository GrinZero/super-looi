import { FastifyInstance } from "fastify";
import OpenAI from "openai";
import { config } from "../config.js";

const openai = new OpenAI({
  baseURL: config.llm.baseUrl,
  apiKey: config.llm.apiKey,
});

/**
 * Vision routes — POST /api/vision/describe
 * Accepts image (base64) and returns a scene description using vision-capable LLM
 */
export async function visionRoutes(fastify: FastifyInstance) {
  fastify.post<{
    Body: { image: string; prompt?: string };
  }>("/describe", async (request, reply) => {
    const { image, prompt } = request.body;

    if (!image) {
      return reply.status(400).send({ error: "image is required (base64)" });
    }

    const systemPrompt =
      prompt ||
      "你是一个视觉助手。请详细描述图片中的场景，重点描述物品的位置和环境。用简洁的中文回答。";

    try {
      const response = await openai.chat.completions.create({
        model: config.llm.model,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: systemPrompt },
              {
                type: "image_url",
                image_url: {
                  url: image.startsWith("data:")
                    ? image
                    : `data:image/jpeg;base64,${image}`,
                },
              },
            ],
          },
        ],
        max_tokens: 500,
      });

      const description = response.choices[0]?.message?.content || "无法识别图片内容";

      return { description };
    } catch (error: any) {
      fastify.log.error(error, "Vision describe failed");
      return reply.status(500).send({
        error: "Vision processing failed",
        details: error.message,
      });
    }
  });
}
