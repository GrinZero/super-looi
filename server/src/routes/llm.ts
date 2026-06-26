import { FastifyInstance } from "fastify";
import OpenAI from "openai";
import { config } from "../config.js";

const openai = new OpenAI({
  baseURL: config.llm.baseUrl,
  apiKey: config.llm.apiKey,
});

type UserIntent = "store" | "search" | "remind" | "chat";

/**
 * LLM routes — /api/llm/*
 * Intent classification and response generation
 */
export async function llmRoutes(fastify: FastifyInstance) {
  /**
   * POST /api/llm/classify-intent
   * Classify user intent from transcript
   */
  fastify.post<{
    Body: { transcript: string };
  }>("/classify-intent", async (request, reply) => {
    const { transcript } = request.body;

    if (!transcript) {
      return reply.status(400).send({ error: "transcript is required" });
    }

    // Use rule-based classification as primary (reliable for Chinese)
    // LLM classification as backup for ambiguous cases
    const ruleIntent = ruleBasedClassify(transcript);

    if (ruleIntent !== "chat") {
      // Rule-based gave a clear signal
      return { intent: ruleIntent };
    }

    // Try LLM for ambiguous cases
    try {
      const response = await openai.chat.completions.create({
        model: config.llm.model,
        messages: [
          {
            role: "system",
            content: `你是一个意图分类器。根据用户说的话，判断意图类别。
只返回以下四个类别中的一个单词（不要任何其他内容）：
store, search, remind, chat

- store: 用户想记录/存储信息
- search: 用户想查找/检索之前记录的信息
- remind: 用户想设置提醒或与日程相关
- chat: 一般性对话、闲聊或问答`,
          },
          { role: "user", content: transcript },
        ],
        temperature: 0,
        max_tokens: 5,
      });

      const intentRaw = (response.choices[0]?.message?.content || "chat").trim().toLowerCase();
      // Extract just the keyword from potentially longer response
      const matched = intentRaw.match(/\b(store|search|remind|chat)\b/);
      const intent: UserIntent = matched ? (matched[1] as UserIntent) : "chat";

      return { intent };
    } catch (error: any) {
      fastify.log.error(error, "Intent classification failed");
      return { intent: "chat" };
    }
  });

  /**
   * POST /api/llm/generate-response
   * Generate natural language response based on intent and context
   */
  fastify.post<{
    Body: {
      intent: UserIntent;
      facts: Array<{ memory: string; metadata?: Record<string, any> }>;
      transcript: string;
    };
  }>("/generate-response", async (request, reply) => {
    const { intent, facts, transcript } = request.body;

    if (!transcript) {
      return reply.status(400).send({ error: "transcript is required" });
    }

    try {
      const systemPrompt = buildSystemPrompt(intent, facts);

      const response = await openai.chat.completions.create({
        model: config.llm.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: transcript },
        ],
        temperature: 0.7,
        max_tokens: 200,
      });

      const text = response.choices[0]?.message?.content || getDefaultResponse(intent);
      return { response: text };
    } catch (error: any) {
      fastify.log.error(error, "Response generation failed");
      return { response: getDefaultResponse(intent) };
    }
  });

  /**
   * POST /api/stt/transcribe
   * Proxy STT transcription — accepts audio file, returns text
   * Uses Whisper-compatible API
   */
  fastify.post("/stt/transcribe", async (request, reply) => {
    // In the actual implementation, this would forward to Whisper API
    // For Phase 1, we'll use the LLM proxy's transcription endpoint if available
    try {
      const data = await request.file();
      if (!data) {
        return reply.status(400).send({ error: "No audio file provided" });
      }

      // Read file buffer
      const buffer = await data.toBuffer();

      // Forward to Whisper-compatible endpoint
      const formData = new FormData();
      const blob = new Blob([new Uint8Array(buffer)], { type: "audio/m4a" });
      formData.append("file", blob, "audio.m4a");
      formData.append("model", "whisper-1");
      formData.append("language", "zh");

      const response = await fetch(`${config.llm.baseUrl}/audio/transcriptions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.llm.apiKey}`,
        },
        body: formData,
      });

      if (!response.ok) {
        throw new Error(`Transcription failed: ${response.status}`);
      }

      const result = await response.json();
      return { text: result.text || "" };
    } catch (error: any) {
      fastify.log.error(error, "STT transcription failed");
      return reply.status(500).send({
        error: "Transcription failed",
        details: error.message,
      });
    }
  });
}

/**
 * Rule-based intent classification fallback
 */
function ruleBasedClassify(transcript: string): UserIntent {
  const t = transcript.toLowerCase();

  // Store indicators
  if (/(放|搁|记住|记一下|我把|我的.*在)/.test(t) && !/(在哪|在哪里|在哪儿|放哪)/.test(t)) {
    return "store";
  }

  // Search indicators
  if (/(在哪|在哪里|在哪儿|放哪|哪里|找不到|上次)/.test(t)) {
    return "search";
  }

  // Remind indicators
  if (/(提醒|别忘|记得.*点|定时|闹钟)/.test(t)) {
    return "remind";
  }

  return "chat";
}

/**
 * Build system prompt based on intent and available facts
 */
function buildSystemPrompt(
  intent: UserIntent,
  facts: Array<{ memory: string; metadata?: Record<string, any> }>
): string {
  const base =
    "你是 LOOI，一个记忆助手。你帮助主人记录和回忆事情。说话简短、自然、温暖。用中文回答。";

  switch (intent) {
    case "store":
      return `${base}\n用户想记录一条信息。请简短确认你已经记住了，可以复述关键信息。不超过 20 字。`;

    case "search": {
      if (facts.length === 0) {
        return `${base}\n用户想查找之前记录的信息，但没有找到相关记忆。请诚实告诉用户"我不记得这个"，不要编造信息。`;
      }
      const factsText = facts.map((f) => `- ${f.memory}`).join("\n");
      return `${base}\n用户想查找之前记录的信息。以下是找到的相关记忆：\n${factsText}\n\n请根据这些记忆回答用户的问题。如果记忆不够明确，也要诚实说明。`;
    }

    case "remind": {
      const factsText = facts.length > 0
        ? `\n相关记忆：\n${facts.map((f) => `- ${f.memory}`).join("\n")}`
        : "";
      return `${base}\n以下是一个日历/提醒事件。请用简短友好的方式提醒用户。${factsText}`;
    }

    case "chat":
    default:
      return `${base}\n这是一般对话。请简短、自然地回复。`;
  }
}

/**
 * Default responses when LLM fails
 */
function getDefaultResponse(intent: UserIntent): string {
  switch (intent) {
    case "store":
      return "好的，我记住了。";
    case "search":
      return "抱歉，我不记得这个信息。";
    case "remind":
      return "好的，我会提醒你的。";
    case "chat":
    default:
      return "你好！有什么我能帮你的吗？";
  }
}
