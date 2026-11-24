import type { TraceContext } from "@super-looi/runtime/telemetry";
import type { PluginVoiceTool, ToolCallBailResult } from "../../plugins/contracts.js";
import type { VoiceTaskBridge } from "../types.js";
import type { VoiceHome, VoiceHomeReferences } from "./home.js";
import type { VoiceSchedule } from "./schedule.js";

export type VoiceToolSchema = {
  type: "function";
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<
      string,
      { type: "string"; enum?: string[]; description?: string }
    >;
    required: string[];
    additionalProperties: false;
  };
};

export interface VoiceBodyControlOptions {
  headDegrees?: number;
  brightness?: number;
  speed?: number;
  turn?: number;
}

export interface VoiceToolHost {
  requestTask?(prompt: string, traceContext?: TraceContext): Promise<string>;
  taskBridge?: VoiceTaskBridge;
  home?: { runtime: VoiceHome; references: VoiceHomeReferences };
  schedule?: VoiceSchedule;
  controlBody?(
    action: string,
    durationMs?: number,
    options?: VoiceBodyControlOptions,
  ): Promise<unknown>;
  toolTraceContext?(callId: string): TraceContext | undefined;
  redactSecrets?(text: string): string;
  sessionId?: string;
  pluginTools?: readonly PluginVoiceTool[];
  evaluateToolCall?(call: {
    toolName: string;
    arguments: Record<string, unknown>;
  }): Promise<(Exclude<ToolCallBailResult, undefined> & { readonly pluginId?: string }) | undefined>;
}
export type VoiceToolContext = VoiceToolHost;
