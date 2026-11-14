import { tool } from "@openai/agents-realtime";
import { createControlLooiBody } from "./control-looi-body.js";
import { createManageAgentTask } from "./manage-agent-task.js";
import { createRunAgentTask } from "./run-agent-task.js";
import type { VoiceToolHost } from "./types.js";

export function createVoiceTools(host: VoiceToolHost, apiKey: string) {
  const definitions = [
    createRunAgentTask(host),
    ...(host.taskBridge ? [createManageAgentTask(host)] : []),
    ...(host.controlBody ? [createControlLooiBody(host)] : []),
  ];
  return definitions.map(({ schema, execute }) =>
    tool({
      name: schema.name,
      description: schema.description,
      parameters: schema.parameters,
      // Preserve the provider/native failure in the model-visible receipt as well
      // as the socket observer's execution record.
      errorFunction: (_context, error) =>
        JSON.stringify({
          error: toolFailure(`tool.${schema.name}`, error),
        }).replaceAll(apiKey, "[redacted]"),
      execute: (args, _context, details) =>
        execute(
          args as Record<string, unknown>,
          details?.toolCall?.callId ?? "",
        ),
    }),
  );
}

function toolFailure(stage: string, error: unknown): Record<string, unknown> {
  if (!error || typeof error !== "object")
    return { stage, message: String(error) };
  const info = error as Record<string, unknown>;
  return {
    stage: typeof info.stage === "string" ? info.stage : stage,
    message: typeof info.message === "string" ? info.message : String(error),
    ...Object.fromEntries(
      ["code", "errno", "domain", "status", "statusCode"]
        .filter((key) => info[key] !== undefined)
        .map((key) => [key, info[key]]),
    ),
    ...(info.cause !== undefined
      ? { cause: toolFailure(stage, info.cause) }
      : {}),
  };
}
