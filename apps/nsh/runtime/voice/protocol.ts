import { voicePrompts } from "./prompts.js";
import { resolveRealtimeProtocol } from "../../../../packages/looi-runtime/src/voice/realtime-protocol.js";
export type {
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
