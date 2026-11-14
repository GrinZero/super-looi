import { tool } from "@openai/agents-realtime";
import { createControlLooiBody } from "./control-looi-body.js";
import { createManageAgentTask } from "./manage-agent-task.js";
import { createRunAgentTask } from "./run-agent-task.js";
import type { VoiceToolHost, VoiceToolSchema } from "./types.js";

export function createVoiceTools(host: VoiceToolHost, apiKey: string) {
  const redactText = (raw: string): string => {
    const step1 = host.redactSecrets ? host.redactSecrets(raw) : raw;
    return apiKey.length > 0 ? step1.replaceAll(apiKey, "[redacted]") : step1;
  };

  const guardVoiceTool = async (toolName: string, args: Record<string, unknown>) => {
    const decision = await host.evaluateToolCall?.({ toolName, arguments: args });
    if (!decision) return;
    if (decision.decision === "deny") {
      throw Object.assign(new Error(decision.reason), {
        stage: decision.stage ?? "plugin.voice.tool_guard",
        code: decision.code,
        ...(decision.cause !== undefined ? { cause: decision.cause } : {}),
      });
    }
    if (decision.decision === "ask") {
      throw Object.assign(
        new Error("Tool requires interactive user approval; delegate via run_agent_task or confirm in UI"),
        {
          stage: "plugin.voice.tool_guard",
          code: "ERR_VOICE_TOOL_APPROVAL_REQUIRED",
        },
      );
    }
  };

  const definitions = [
    createRunAgentTask(host),
    ...(host.taskBridge ? [createManageAgentTask(host)] : []),
    ...(host.controlBody ? [createControlLooiBody(host)] : []),
  ];

  const builtinTools = definitions.map(({ schema, execute }) =>
    tool({
      name: schema.name,
      description: schema.description,
      parameters: schema.parameters,
      // Preserve the provider/native failure in the model-visible receipt as well
      // as the socket observer's execution record.
      errorFunction: (_context, error) =>
        redactText(
          JSON.stringify({
            error: toolFailure(`tool.${schema.name}`, error),
          }),
        ),
      execute: async (args, _context, details) => {
        const record = (args ?? {}) as Record<string, unknown>;
        await guardVoiceTool(schema.name, record);
        return execute(record, details?.toolCall?.callId ?? "");
      },
    }),
  );

  const contributedTools = (host.pluginTools ?? []).map((pluginTool) => {
    const rawParams = pluginTool.parametersJsonSchema ?? {};
    const parameters: VoiceToolSchema["parameters"] = {
      type: "object",
      properties:
        (rawParams.properties as VoiceToolSchema["parameters"]["properties"]) ?? {},
      required: Array.isArray(rawParams.required)
        ? (rawParams.required as string[])
        : [],
      additionalProperties: false,
    };
    return tool({
      name: pluginTool.name,
      description: pluginTool.description,
      parameters,
      errorFunction: (_context, error) =>
        redactText(
          JSON.stringify({
            error: toolFailure(`tool.${pluginTool.name}`, error),
          }),
        ),
      execute: async (args) => {
        const record = (args ?? {}) as Record<string, unknown>;
        await guardVoiceTool(pluginTool.name, record);
        return pluginTool.execute(record, {
          sessionId: host.sessionId ?? "",
          signal: AbortSignal.timeout(30_000),
        });
      },
    });
  });

  return [...builtinTools, ...contributedTools];
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
