import type { TraceContext } from "../../../../../packages/looi-runtime/src/telemetry/langfuse.js";
import type { VoiceTaskBridge } from "../types.js";

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
  execute(item: Record<string, unknown>, callId: string): void;
}

export interface VoiceBodyControlOptions {
  headDegrees?: number;
  brightness?: number;
  speed?: number;
  turn?: number;
}

export interface VoiceToolHost {
  send(value: unknown): Promise<void>;
  active(): boolean;
  requestTask?(prompt: string, traceContext?: TraceContext): Promise<string>;
  taskBridge?: VoiceTaskBridge;
  controlBody?(
    action: string,
    durationMs?: number,
    options?: VoiceBodyControlOptions,
  ): Promise<unknown>;
  toolTraceContext?(callId: string): TraceContext | undefined;
  taskFinished(): void;
  fail(message: string): void;
}

export type VoiceToolContext = VoiceToolHost & {
  reply(callId: string, output: unknown): Promise<void>;
};
