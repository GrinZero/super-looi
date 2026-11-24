import type { TraceObservation } from "@super-looi/runtime/telemetry";

export const voiceToolTaskPrefix = "voice_tool_";

function decodeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function directVoiceToolName(node: TraceObservation): string | undefined {
  if (node.name !== "realtime.tool_call") return;
  const name = object(node.attributes["langfuse.observation.input"])?.name;
  if (typeof name === "string" && name && name !== "run_agent_task" && name !== "manage_agent_task") return name;
}

/** Decode the stored wire receipt while preserving the tool's original result and error. */
export function readVoiceToolCall(node: TraceObservation) {
  const attributes = node.attributes;
  const input = decodeJson(object(attributes["langfuse.observation.input"])?.arguments);
  const wireOutput = attributes["langfuse.observation.output"];
  // The duplex transport can return a content block; OpenAI can return JSON text directly.
  const block = Array.isArray(wireOutput) && wireOutput.length === 1 ? object(wireOutput[0]) : undefined;
  const output = decodeJson(block?.type === "input_text" || block?.type === "text" ? block.text : wireOutput);
  const result = object(output);
  const receipt = object(result?.receipt);
  const status = receipt?.status ?? result?.status;
  const failure = object(result?.error);
  const interrupted = attributes["langfuse.observation.metadata.interrupted"] === true || status === "interrupted";
  const failed = (result?.error !== undefined && result.error !== null && result.error !== false)
    || result?.ok === false || result?.success === false
    || status === "failed" || status === "rejected" || status === "error" || attributes["langfuse.observation.level"] === "ERROR";
  const stage = text(failure?.stage);
  const code = text(failure?.code);
  const error = failed ? [stage, code, text(failure?.message) ?? text(result?.error)
    ?? text(receipt?.reason_code) ?? text(result?.reason_code) ?? text(result?.reason)
    ?? text(attributes["langfuse.observation.status_message"])].filter(Boolean).join(" · ") : undefined;
  return { input, output, status, failed, interrupted, error };
}

export function voiceToolTask(node: TraceObservation, name: string) {
  const { input, output, status, failed, interrupted, error } = readVoiceToolCall(node);
  const args = object(input);
  const target = object(args?.target);
  const prompt = text(target?.name) ?? text(target?.ref) ?? text(args?.query) ?? text(args?.action) ?? "";
  const state = failed ? "failed"
    : interrupted ? "unknown"
    : node.endedAt === undefined ? "running"
    : status === "needs_selection" ? "needs_selection"
    : output === undefined || status === "unknown" || status === "unverified" || status === "accepted" || status === "sent" || status === "observed" ? "unknown"
    : "succeeded";

  return {
    id: `${voiceToolTaskPrefix}${node.spanId}`,
    voiceToolName: name,
    prompt: prompt.slice(0, 160),
    state,
    createdAt: new Date(node.startedAt).toISOString(),
    updatedAt: new Date(node.endedAt ?? node.startedAt).toISOString(),
    trace: { traceId: node.traceId, spanId: node.spanId },
    error,
    voiceToolCall: { input, output },
  };
}
