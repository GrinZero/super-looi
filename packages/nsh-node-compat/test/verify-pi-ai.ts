import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import {
  createModels,
  createProvider,
  ToolCallArgumentsStream,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { installFixtureHttp, sseResponse } from "./http-fixture.js";
import { assert, equal } from "./assert.js";
installFixtureHttp();
const model = {
  id: "compat-model",
  name: "Compat Model",
  provider: "compat",
  api: "openai-completions" as const,
  baseUrl: "https://fixture.invalid/v1",
  reasoning: false,
  input: ["text" as const],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 512,
};
const models = createModels();
const provider = createProvider({
  id: "compat",
  name: "Compat",
  api: openAICompletionsApi(),
  models: [model],
  auth: { apiKey: "fixture-key" },
});
models.setProvider(provider);
equal(models.getModel("compat", model.id)?.id, model.id);
let pulled = 0,
  requests = 0;
const fakeFetch = async (_url: unknown, init: any) => {
  requests++;
  assert(JSON.parse(init.body).stream === true);
  return sseResponse(
    [
      {
        id: "chat-1",
        object: "chat.completion.chunk",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "你好" },
            finish_reason: null,
          },
        ],
      },
      {
        id: "chat-1",
        object: "chat.completion.chunk",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "tool-1",
                  type: "function",
                  function: { name: "sum", arguments: '{"a":' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: "chat-1",
        object: "chat.completion.chunk",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, function: { arguments: "42}" } }],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
      "[DONE]",
    ],
    () => pulled++,
  );
};
const stream = streamSimple(
  model,
  {
    messages: [
      { role: "user", content: "say hello then sum", timestamp: Date.now() },
    ],
  },
  { apiKey: "fixture-key", fetch: fakeFetch as typeof fetch, maxRetries: 0 },
);
const events: string[] = [];
for await (const event of stream) events.push(event.type);
const result = await stream.result();
assert(result.stopReason === "toolUse", JSON.stringify(result));
equal(requests, 1);
assert(pulled > 10);
assert(events.includes("text_delta") && events.includes("toolcall_delta"));
const tool = result.content.find((c) => c.type === "toolCall");
assert(tool?.type === "toolCall");
equal(tool.arguments, { a: 42 });
const args = new ToolCallArgumentsStream();
args.append('{"中文":"');
args.append('世界"}');
equal(args.finish().arguments, { 中文: "世界" });
console.log(
  "PASS pi-ai@1.5.0: model registry, real OpenAI SDK SSE parser, 7-byte UTF-8 chunks and tool JSON",
);
