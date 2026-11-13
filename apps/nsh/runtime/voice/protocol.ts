import { voicePrompts } from "./prompts.js";
import {
  createDoubaoDuplexV3Protocol,
  createMossLiveProtocol,
  createOpenAiRealtimeProtocol,
  resolveRealtimeProtocol,
} from "../../../../packages/looi-runtime/src/voice/realtime-protocol.js";
export {
  createDoubaoDuplexV3Protocol,
  createMossLiveProtocol,
  createOpenAiRealtimeProtocol,
};
export type {
  RealtimeProviderId,
  RealtimeProtocolAdapter,
  NormalizedRealtimeEvent,
} from "../../../../packages/looi-runtime/src/voice/realtime-protocol.js";

export function createVoiceProtocol(
  config: { providerId?: string; baseUrl?: string; model?: string } = {},
) {
  return resolveRealtimeProtocol({
    ...config,
    instructions: voicePrompts.instructions,
  });
}
