import { createControlLooiBody } from "./control-looi-body.js";
import { createManageAgentTask } from "./manage-agent-task.js";
import { createRunAgentTask } from "./run-agent-task.js";
import type { VoiceToolDefinition, VoiceToolHost } from "./types.js";
import type { RealtimeProtocolAdapter } from "../protocol.js";

export function createVoiceTools(host: VoiceToolHost, protocol: RealtimeProtocolAdapter) {
  const context = {
    ...host,
    async reply(callId: string, output: unknown) {
      for (const message of protocol.encodeToolReply(callId, output)) {
        await host.send(message);
      }
    },
  };
  const task = createRunAgentTask(context);
  const manageTask = createManageAgentTask(context);
  const body = createControlLooiBody(context);
  const definitions: VoiceToolDefinition[] = [
    task,
    ...(host.taskBridge ? [manageTask] : []),
    ...(host.controlBody ? [body] : []),
  ];
  const calls = new Set<string>();

  return {
    schemas: definitions.map(({ schema }) => schema),
    get busy() {
      return definitions.some((definition) => Boolean(definition.busy));
    },
    handle(item: Record<string, unknown>, responseId: string): void {
      const callId = typeof item.call_id === "string" ? item.call_id : "";
      if (!callId || callId.length > 256 || calls.has(callId)) return;
      if (calls.size >= 128) {
        host.fail("@looi:voiceTaskLimit");
        return;
      }
      calls.add(callId);
      const definition =
        definitions.find(({ schema }) => schema.name === item.name) ?? task;
      definition.execute(item, callId, responseId);
    },
    reset(): void {
      calls.clear();
      for (const definition of definitions) {
        definition.reset();
      }
    },
  };
}

export type VoiceTools = ReturnType<typeof createVoiceTools>;
