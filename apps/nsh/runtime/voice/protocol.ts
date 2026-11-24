import { voicePrompts } from "./prompts.js";
import {
  createDoubaoDuplexV3Protocol,
  createMossLiveProtocol,
  createOpenAiRealtimeProtocol,
  resolveRealtimeProtocol,
} from "@super-looi/runtime/voice";
export {
  createDoubaoDuplexV3Protocol,
  createMossLiveProtocol,
  createOpenAiRealtimeProtocol,
};
export type {
  RealtimeProviderId,
  RealtimeProtocolAdapter,
  NormalizedRealtimeEvent,
} from "@super-looi/runtime/voice";

export function createVoiceProtocol(
  config: { providerId?: string; baseUrl?: string; model?: string } = {},
) {
  return resolveRealtimeProtocol({
    ...config,
    instructions: voicePrompts.instructions,
  });
}
