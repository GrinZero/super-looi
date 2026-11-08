import { voicePrompts } from "./prompts.js";
import type { VoiceToolSchema } from "./tools/types.js";
import { createDoubaoDuplexV3Protocol, resolveRealtimeProtocol } from "../../../../packages/looi-runtime/src/voice/realtime-protocol.js";
export type { RealtimeProtocolAdapter, NormalizedRealtimeEvent } from "../../../../packages/looi-runtime/src/voice/realtime-protocol.js";

export const doubaoDuplexV3Protocol = createDoubaoDuplexV3Protocol({ instructions: voicePrompts.instructions });
export function createVoiceProtocol(config: { providerId?: string; baseUrl?: string; model?: string } = {}) {
  return resolveRealtimeProtocol({ ...config, instructions: voicePrompts.instructions });
}

export const voiceEndpoint =
  "wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue";

export function createSessionMessage(tools: VoiceToolSchema[]) {
  return doubaoDuplexV3Protocol.createHandshakeMessages(tools)[0];
}
