import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { nativeFetch } from "./native-fetch.js";
import { assert } from "./assert.js";
const config = JSON.parse(__nsh_live_config) as {
  baseUrl: string;
  apiKey: string;
  model: string;
};
const model = {
  id: config.model,
  name: config.model,
  provider: "compat-live",
  api: "openai-completions" as const,
  baseUrl: config.baseUrl,
  reasoning: false,
  input: ["text" as const],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 256,
};
const stream = streamSimple(
  model,
  {
    messages: [
      {
        role: "user",
        content: "Reply with exactly the word OK.",
        timestamp: Date.now(),
      },
    ],
  },
  { apiKey: config.apiKey, fetch: nativeFetch, maxRetries: 0, maxTokens: 32 },
);
let deltas = 0;
for await (const event of stream) if (event.type === "text_delta") deltas++;
const response = await stream.result();
assert(response.stopReason !== "error", "Live provider request failed");
assert(
  deltas > 0 &&
    response.content.some((c) => c.type === "text" && c.text.length > 0),
  "Live provider returned no text deltas",
);
console.log(
  "PASS pi-ai live: Rust HTTPS streaming -> QuickJS -> upstream OpenAI SDK -> text deltas (credentials/output omitted)",
);
