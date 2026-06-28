import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import {
  buildGroundedSearchResponse,
  buildSystemPrompt,
  createLlmRoutes,
  getDefaultResponse,
  ruleBasedClassify,
} from "../src/routes/llm.js";

test("ruleBasedClassify handles core Chinese memory intents", () => {
  assert.equal(ruleBasedClassify("记住钥匙在蓝色抽屉里"), "store");
  assert.equal(ruleBasedClassify("钥匙放哪了"), "search");
  assert.equal(ruleBasedClassify("明早提醒我带钥匙"), "remind");
  assert.equal(ruleBasedClassify("今天天气怎么样"), "chat");
});

test("search prompt with no facts requires honest no-memory response", () => {
  const prompt = buildSystemPrompt("search", []);

  assert.match(prompt, /没有找到相关记忆/);
  assert.match(prompt, /我不记得这个/);
  assert.match(prompt, /不要编造信息/);
  assert.equal(getDefaultResponse("search"), "抱歉，我不记得这个信息。");
});

test("system prompt can include previous session summary", () => {
  const prompt = buildSystemPrompt("chat", [], "用户刚刚提到钥匙在蓝色抽屉里");

  assert.match(prompt, /上一段对话摘要：用户刚刚提到钥匙在蓝色抽屉里/);
  assert.match(prompt, /这是一般对话/);
});

test("search prompt includes only provided facts", () => {
  const prompt = buildSystemPrompt("search", [
    { memory: "黄色钥匙在蓝色抽屉上", metadata: { evidenceUri: "http://example.test/key.png" } },
  ]);

  assert.match(prompt, /黄色钥匙在蓝色抽屉上/);
  assert.doesNotMatch(prompt, /没有找到相关记忆/);
  assert.doesNotMatch(prompt, /example\.test/);
});

test("search response is grounded in the top retrieved fact", () => {
  const response = buildGroundedSearchResponse([
    {
      memory: "用户说：记住衣服现在放在桌子下\n位置事实：衣服在桌子下\n视觉观察：桌子上有衣服，下面有一个狗窝。",
      metadata: {
        placementFact: "衣服在桌子下",
        description: "桌子上有衣服，下面有一个狗窝。",
        evidenceUri: "http://example.test/clothes.jpg",
      },
    },
    {
      memory: "用户说：记住这个放这了\n视觉观察：纯色图片，没有可辨认的物品。",
    },
  ]);

  assert.equal(response, "我记得：衣服在桌子下");
  assert.doesNotMatch(response, /狗窝|衣柜|沙发/);
});

test("search response without facts uses no-memory response", () => {
  assert.equal(buildGroundedSearchResponse([]), "抱歉，我不记得这个信息。");
});

test("generate-response-stream emits token and done SSE events with session history", async () => {
  const seenMessages: unknown[] = [];
  const seenOptions: unknown[] = [];
  const server = Fastify({ logger: false });
  await server.register(
    createLlmRoutes({
      chatComplete: async () => "unused",
      chatStream: (messages, options) => {
        seenMessages.push(messages);
        seenOptions.push(options);
        return (async function* () {
          yield {
            type: "text_delta",
            contentIndex: 0,
            delta: "你",
            partial: {} as any,
          };
          yield {
            type: "text_delta",
            contentIndex: 0,
            delta: "好",
            partial: {} as any,
          };
          yield {
            type: "done",
            reason: "stop",
            message: {} as any,
          };
        })() as any;
      },
      sessionService: {
        async touch() {
          return { sessionId: "sess_test", isNew: false };
        },
        async addMessage() {
          return { messageId: "msg_test" };
        },
        async listSessions() {
          return { sessions: [] };
        },
        async getMessages() {
          return { messages: [] };
        },
        async getRecentMessages(sessionId, maxMessages) {
          assert.equal(sessionId, "sess_test");
          assert.equal(maxMessages, 6);
          return [
            {
              id: "msg_1",
              sessionId,
              role: "user",
              content: "之前的问题",
              evidenceUri: null,
              createdAt: "2026-06-28T00:00:00.000Z",
            },
            {
              id: "msg_2",
              sessionId,
              role: "assistant",
              content: "之前的回答",
              evidenceUri: null,
              createdAt: "2026-06-28T00:00:01.000Z",
            },
          ];
        },
      },
    }),
    { prefix: "/api/llm" }
  );

  try {
    const response = await server.inject({
      method: "POST",
      url: "/api/llm/generate-response-stream",
      payload: {
        transcript: "现在的问题",
        sessionId: "sess_test",
        previousSummary: "上一段摘要",
        facts: [{ memory: "钥匙在抽屉里", metadata: { evidenceUri: "http://example.test/key.png" } }],
      },
    });

    assert.equal(response.statusCode, 200);
    assert.match(response.headers["content-type"] as string, /text\/event-stream/);
    assert.match(response.body, /event: token\ndata: \{"text":"你"\}/);
    assert.match(response.body, /event: token\ndata: \{"text":"好"\}/);
    assert.match(
      response.body,
      /event: done\ndata: \{"fullText":"你好","evidenceUri":"http:\/\/example.test\/key.png"\}/
    );
    assert.deepEqual(seenMessages, [
      [
        {
          role: "system",
          content:
            "你是 LOOI，一个记忆助手。你帮助主人记录和回忆事情。说话简短、自然、温暖。用中文回答。\n上一段对话摘要：上一段摘要\n这是一般对话。请简短、自然地回复，不超过 12 个字。",
        },
        { role: "user", content: "之前的问题" },
        { role: "assistant", content: "之前的回答" },
        { role: "user", content: "现在的问题" },
      ],
    ]);
    assert.deepEqual(seenOptions, [{ temperature: 0.7, maxTokens: 40, sessionId: "sess_test" }]);
  } finally {
    await server.close();
  }
});
