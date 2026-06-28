import { FastifyInstance } from "fastify";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import { chatComplete, chatStream, type ChatMessage } from "../infra/llm.js";
import { DefaultSessionService, type SessionService } from "../session/service.js";

export type UserIntent = "store" | "search" | "remind" | "chat";
const STREAM_CONTEXT_MESSAGE_LIMIT = 6;

/**
 * LLM routes — /api/llm/*
 * Intent classification and response generation
 */
export interface LlmRouteDependencies {
  chatComplete: typeof chatComplete;
  chatStream: typeof chatStream;
  sessionService: SessionService;
}

export function createLlmRoutes(
  dependencies: LlmRouteDependencies = {
    chatComplete,
    chatStream,
    sessionService: new DefaultSessionService(undefined, {
      onBackgroundError: (error) => console.error("Session background task failed", error),
    }),
  }
) {
  return async function llmRoutes(fastify: FastifyInstance) {
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

    // Keep this endpoint deterministic and low-latency. Ambiguous utterances
    // are treated as chat so response streaming can start without a preflight
    // LLM call on the critical path.
    return { intent: ruleBasedClassify(transcript) };
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
      if (intent === "search") {
        return { response: buildGroundedSearchResponse(facts) };
      }

      const systemPrompt = buildSystemPrompt(intent, facts);

      const text = await dependencies.chatComplete(
        [
          { role: "system", content: systemPrompt },
          { role: "user", content: transcript },
        ],
        { temperature: 0.7, maxTokens: 200 }
      );

      return { response: text || getDefaultResponse(intent) };
    } catch (error: any) {
      fastify.log.error(error, "Response generation failed");
      return { response: getDefaultResponse(intent) };
    }
  });

  /**
   * POST /api/llm/generate-response-stream
   * Stream natural language response as Server-Sent Events.
   */
  fastify.post<{
    Body: {
      intent?: UserIntent;
      facts?: Array<{ memory: string; metadata?: Record<string, any> }>;
      transcript: string;
      sessionId?: string;
      previousSummary?: string;
    };
  }>("/generate-response-stream", async (request, reply) => {
    const { intent = "chat", facts = [], transcript, sessionId, previousSummary } = request.body;

    if (!transcript) {
      return reply.status(400).send({ error: "transcript is required" });
    }

    if (intent === "search") {
      const response = buildGroundedSearchResponse(facts);
      reply.raw.writeHead(200, sseHeaders);
      writeSse(reply.raw, "token", { text: response });
      writeSse(reply.raw, "done", { fullText: response, evidenceUri: findEvidenceUri(facts) });
      reply.raw.end();
      return;
    }

    const systemPrompt = buildSystemPrompt(intent, facts, previousSummary);
    const messages = await buildLlmMessages({
      sessionService: dependencies.sessionService,
      sessionId,
      systemPrompt,
      transcript,
    });
    let fullText = "";

    reply.raw.writeHead(200, sseHeaders);

    try {
      const stream = dependencies.chatStream(messages, {
        temperature: 0.7,
        maxTokens: getResponseMaxTokens(intent),
        sessionId,
      });

      for await (const event of stream) {
        if (isTextDeltaEvent(event)) {
          fullText += event.delta;
          writeSse(reply.raw, "token", { text: event.delta });
        }
      }

      writeSse(reply.raw, "done", { fullText, evidenceUri: findEvidenceUri(facts) });
    } catch (error: any) {
      fastify.log.error(error, "Streaming response generation failed");
      if (!fullText) {
        fullText = getDefaultResponse(intent);
        writeSse(reply.raw, "token", { text: fullText });
      }
      writeSse(reply.raw, "done", { fullText, error: error.message });
    } finally {
      reply.raw.end();
    }
  });
  };
}

export const llmRoutes = createLlmRoutes();

/**
 * Rule-based intent classification fallback
 */
export function ruleBasedClassify(transcript: string): UserIntent {
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
export function buildSystemPrompt(
  intent: UserIntent,
  facts: Array<{ memory: string; metadata?: Record<string, any> }>,
  previousSummary?: string
): string {
  const base =
    "你是 LOOI，一个记忆助手。你帮助主人记录和回忆事情。说话简短、自然、温暖。用中文回答。";
  const summaryHint = previousSummary ? `\n上一段对话摘要：${previousSummary}` : "";

  switch (intent) {
    case "store":
      return `${base}${summaryHint}\n用户想记录一条信息。请简短确认你已经记住了，可以复述关键信息。不超过 20 字。`;

    case "search": {
      if (facts.length === 0) {
        return `${base}${summaryHint}\n用户想查找之前记录的信息，但没有找到相关记忆。请诚实告诉用户"我不记得这个"，不要编造信息。`;
      }
      const factsText = facts.map((f) => `- ${f.memory}`).join("\n");
      return `${base}${summaryHint}\n用户想查找之前记录的信息。以下是找到的相关记忆：\n${factsText}\n\n请根据这些记忆回答用户的问题。如果记忆不够明确，也要诚实说明。`;
    }

    case "remind": {
      const factsText = facts.length > 0
        ? `\n相关记忆：\n${facts.map((f) => `- ${f.memory}`).join("\n")}`
        : "";
      return `${base}${summaryHint}\n以下是一个日历/提醒事件。请用简短友好的方式提醒用户。${factsText}`;
    }

    case "chat":
    default:
      return `${base}${summaryHint}\n这是一般对话。请简短、自然地回复，不超过 12 个字。`;
  }
}

function getResponseMaxTokens(intent: UserIntent): number {
  return intent === "chat" ? 40 : 200;
}

export function buildGroundedSearchResponse(
  facts: Array<{ memory: string; metadata?: Record<string, any> }>
): string {
  if (facts.length === 0) {
    return "抱歉，我不记得这个信息。";
  }

  const topFact = facts[0];
  const placementFact = typeof topFact.metadata?.placementFact === "string"
    ? topFact.metadata.placementFact.trim()
    : "";
  const description = typeof topFact.metadata?.description === "string"
    ? topFact.metadata.description.trim()
    : "";
  const memory = topFact.memory.trim();
  const factText = placementFact || description || memory;

  if (!factText) {
    return "抱歉，我不记得这个信息。";
  }

  return `我记得：${factText}`;
}

/**
 * Default responses when LLM fails
 */
export function getDefaultResponse(intent: UserIntent): string {
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

const sseHeaders = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
} as const;

function writeSse(raw: NodeJS.WritableStream, event: string, data: unknown): void {
  raw.write(`event: ${event}\n`);
  raw.write(`data: ${JSON.stringify(data)}\n\n`);
}

function isTextDeltaEvent(event: AssistantMessageEvent): event is Extract<
  AssistantMessageEvent,
  { type: "text_delta" }
> {
  return event.type === "text_delta" && event.delta.length > 0;
}

async function buildLlmMessages(input: {
  sessionService: SessionService;
  sessionId?: string;
  systemPrompt: string;
  transcript: string;
}): Promise<ChatMessage[]> {
  const messages: ChatMessage[] = [{ role: "system", content: input.systemPrompt }];

  if (input.sessionId) {
    const history = await input.sessionService.getRecentMessages(
      input.sessionId,
      STREAM_CONTEXT_MESSAGE_LIMIT
    );
    messages.push(
      ...history.map((message) => ({
        role: message.role,
        content: message.content,
      }))
    );
  }

  messages.push({ role: "user", content: input.transcript });
  return messages;
}

function findEvidenceUri(facts: Array<{ memory: string; metadata?: Record<string, any> }>): string | undefined {
  for (const fact of facts) {
    if (typeof fact.metadata?.evidenceUri === "string" && fact.metadata.evidenceUri.trim()) {
      return fact.metadata.evidenceUri;
    }
  }

  return undefined;
}
