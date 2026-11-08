import type { TraceContext } from "../../../../../packages/looi-runtime/src/telemetry/langfuse.js";

export type VoiceToolSchema = {
  type: "function";
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, { type: "string"; enum?: string[]; description?: string }>;
    required?: string[];
    additionalProperties: false;
  };
};

export interface VoiceToolDefinition {
  readonly schema: VoiceToolSchema;
  readonly busy?: boolean;
  reset(): void;
  execute(item: Record<string, unknown>, callId: string, responseId: string): void;
}

export interface VoiceToolHost {
  send(value: unknown): Promise<void>;
  active(): boolean;
  requestTask(prompt: string, traceContext?: TraceContext): Promise<string>;
  controlBody?(action: string, durationMs?: number): Promise<unknown>;
  toolTraceContext?(callId: string): TraceContext | undefined;
  beginFarewell(): void;
  endSession(): void;
  taskFinished(): void;
  fail(message: string): void;
}

export type VoiceToolContext = VoiceToolHost & {
  reply(callId: string, output: unknown): Promise<void>;
};
