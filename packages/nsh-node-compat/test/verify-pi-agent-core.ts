import { Agent } from "@earendil-works/pi-agent-core";
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { obj, num } from "@earendil-works/pi-schema";
import { writeFileSync, readFileSync } from "node:fs";
import { assert, equal } from "./assert.js";
const faux = createFauxCore({ provider: "compat", api: "compat" });
faux.setResponses([
  fauxAssistantMessage(fauxToolCall("sum", { a: 20, b: 22 }), {
    stopReason: "toolUse",
  }),
  fauxAssistantMessage("工具完成"),
  fauxAssistantMessage("后续完成"),
]);
const events: string[] = [];
let toolCount = 0;
let steered = false;
const agent = new Agent({
  streamFn: faux.streamSimple,
  initialState: {
    model: faux.getModel(),
    tools: [
      {
        name: "sum",
        label: "计算",
        description: "sum numbers and write result",
        parameters: obj({ a: num(), b: num() }),
        async execute(_id, args) {
          toolCount++;
          const text = String(args.a + args.b);
          writeFileSync("/workspace/result.txt", text);
          return { content: [{ type: "text", text }], details: {} };
        },
      },
    ],
  },
});
agent.subscribe((event) => {
  events.push(event.type);
  if (event.type === "tool_execution_end" && !steered) {
    steered = true;
    agent.steer({
      role: "user",
      content: "检查计算结果",
      timestamp: Date.now(),
    });
  }
});
agent.followUp({ role: "user", content: "再确认一次", timestamp: Date.now() });
await agent.prompt("计算20+22");
equal(toolCount, 1);
equal(readFileSync("/workspace/result.txt", "utf8"), "42");
assert(events.includes("agent_end") && events.includes("tool_execution_end"));
assert(!agent.hasQueuedMessages());
equal(faux.state.callCount, 3);
const abortCore = createFauxCore({ tokensPerSecond: 1000 });
abortCore.setResponses([fauxAssistantMessage("abort response")]);
const aborted = new Agent({
  streamFn: abortCore.streamSimple,
  initialState: { model: abortCore.getModel() },
});
aborted.subscribe((e) => {
  if (e.type === "message_start" && e.message.role === "assistant")
    aborted.abort();
});
await aborted.prompt("cancel");
await aborted.waitForIdle();
assert(!aborted.state.isStreaming);
console.log(
  "PASS pi-agent-core@1.5.0: real Agent loop, tool I/O, steer, followUp, events, abort",
);
