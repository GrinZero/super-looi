export type VoiceToolSchema = {
  type: "function";
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, { type: "string"; enum?: string[] }>;
    required?: string[];
    additionalProperties: false;
  };
};

export interface VoiceToolHost {
  send(value: unknown, generation: number): Promise<void>;
  current(generation: number): boolean;
  requestTask(prompt: string, traceContext?: TraceContext): Promise<string>;
  controlBody?(action: string, durationMs?: number): Promise<unknown>;
  toolTraceContext?(callId: string): TraceContext | undefined;
  beginFarewell(): void;
  endSession(): void;
  taskFinished(generation: number): void;
  fail(message: string): void;
}

export type VoiceToolContext = VoiceToolHost & {
  reply(callId: string, output: unknown, generation: number): Promise<void>;
};
import type { TraceContext } from "../../../../../packages/looi-runtime/src/telemetry/langfuse.js";
