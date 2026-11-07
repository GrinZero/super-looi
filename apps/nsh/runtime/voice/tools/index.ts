import { createEndConversation } from "./end-conversation.js";
import { createRunAgentTask } from "./run-agent-task.js";
import type { VoiceToolHost } from "./types.js";

export function createVoiceTools(host: VoiceToolHost) {
  const context = {
    ...host,
    reply(callId: string, output: unknown, generation: number) {
      return host.send({
        type: "conversation.item.create",
        items: [{
          call_id: callId,
          role: "tool",
          content: [{ type: "input_text", text: JSON.stringify(output) }],
        }],
      }, generation);
    },
  };
  const task = createRunAgentTask(context);
  const farewell = createEndConversation(context);
  const definitions = [task, farewell];
  const calls = new Set<string>();

  return {
    schemas: definitions.map(({ schema }) => schema),
    get busy() { return task.busy; },
    get closingAfterFarewell() { return farewell.closing; },
    get farewellComplete() { return farewell.complete; },
    onAudioStarted: farewell.onAudioStarted,
    onAudioDone: farewell.onAudioDone,
    onResponseDone: farewell.onResponseDone,
    handle(item: Record<string, unknown>, generation: number, responseId: string): void {
      const callId = typeof item.call_id === "string" ? item.call_id : "";
      if (!callId || callId.length > 256 || calls.has(callId)) return;
      if (calls.size >= 128) {
        host.fail("本次语音任务较多，请重新开启");
        return;
      }
      calls.add(callId);
      const definition = definitions.find(({ schema }) => schema.name === item.name) ?? task;
      definition.execute(item, callId, generation, responseId);
    },
    reset(): void {
      calls.clear();
      task.reset();
      farewell.reset();
    },
  };
}

export type VoiceTools = ReturnType<typeof createVoiceTools>;
