import type { NativeObservation } from "../generated/looi-runtime.js";

export const traceInput = (node: NativeObservation) => node.attributes["langfuse.observation.input"];
export const traceOutput = (node: NativeObservation) => node.attributes["langfuse.observation.output"];
export const traceError = (node: NativeObservation) => node.attributes["langfuse.observation.status_message"];

export function traceState(node: NativeObservation): "active" | "ended" | "error" | "cancelled" | "interrupted" {
  if (node.attributes["langfuse.observation.metadata.interrupted"] === true) return "interrupted";
  if (node.attributes["langfuse.observation.metadata.state"] === "cancelled" || node.attributes["langfuse.observation.metadata.cancelled"] === true) return "cancelled";
  if (node.attributes["langfuse.observation.level"] === "ERROR") return "error";
  return node.endedAt === undefined ? "active" : "ended";
}

/** Parent IDs, rather than completion order, define the call tree. */
export function traceRows(observations: NativeObservation[]): Array<{ node: NativeObservation; depth: number }> {
  const ids = new Set(observations.map(node => node.spanId));
  const children = new Map<string, NativeObservation[]>();
  for (const node of [...observations].sort((a, b) => a.startedAt - b.startedAt)) {
    const parent = node.parentSpanId && ids.has(node.parentSpanId) ? node.parentSpanId : "";
    const siblings = children.get(parent) ?? [];
    siblings.push(node);
    children.set(parent, siblings);
  }
  const rows: Array<{ node: NativeObservation; depth: number }> = [];
  function visit(parent: string, depth: number) {
    for (const node of children.get(parent) ?? []) {
      rows.push({ node, depth });
      visit(node.spanId, depth + 1);
    }
  }
  visit("", 0);
  return rows;
}

export function traceText(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(part => {
    if (part?.type === "text") return String(part.text);
    if (part?.role && part.content !== undefined) return `${part.role}\n${traceText(part.content)}`;
    return JSON.stringify(part, null, 2);
  }).join("\n\n");
  return JSON.stringify(value, null, 2);
}

export function tracePreview(node: NativeObservation): string {
  const input = traceInput(node) as Record<string, unknown> | undefined;
  const output = traceOutput(node) as Record<string, unknown> | undefined;
  if (node.name === "agent.context") return String(output?.historyMessages ?? "");
  if (node.name === "agent.tool.web_search") {
    const action = output?.action as { queries?: string[]; url?: string } | undefined;
    return action?.queries?.join(" · ") ?? action?.url ?? traceText(action);
  }
  if (node.type === "generation") return String(node.attributes["langfuse.observation.model.name"] ?? "");
  if (node.name === "realtime.tool_call") return String(input?.name ?? "");
  return traceText(traceError(node) ?? traceInput(node) ?? traceOutput(node)).replace(/\s+/g, " ").slice(0, 160);
}

export function contextMessages(value: unknown): Array<{ role: string; content: unknown }> {
  if (!value || typeof value !== "object") return [];
  const input = value as Record<string, unknown>;
  const messages = Array.isArray(value) ? value : input.history ?? input.messages;
  return Array.isArray(messages) ? messages.map(message => ({ role: String(message.role), content: message.content })) : [];
}
