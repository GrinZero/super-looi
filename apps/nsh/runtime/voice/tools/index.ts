import { createEndConversation } from "./end-conversation.js";
import { createRunAgentTask } from "./run-agent-task.js";
import type { VoiceToolHost } from "./types.js";
import type { RealtimeProtocolAdapter } from "../protocol.js";

export function createVoiceTools(host: VoiceToolHost, protocol: RealtimeProtocolAdapter) {
  const context = {
    ...host,
    async reply(callId: string, output: unknown, generation: number) {
      for (const message of protocol.encodeToolReply(callId, output)) await host.send(message, generation);
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
        host.fail("@looi:voiceTaskLimit");
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
