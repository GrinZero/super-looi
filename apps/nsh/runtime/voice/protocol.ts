import { voicePrompts } from "./prompts.js";
import type { VoiceToolSchema } from "./tools/types.js";

export const voiceEndpoint =
  "wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue";

export function createSessionMessage(tools: VoiceToolSchema[]) {
  return {
    type: "session.create",
    session: {
      model: "1.2.6.1",
      instructions: voicePrompts.instructions,
      tools,
      audio: {
        input: { format: { type: "pcm", rate: 16000 } },
        output: {
          format: { type: "pcm_s16le", rate: 24000 },
          voice: "zh_female_vv_jupiter_bigtts",
        },
      },
    },
    extension: {
      tts: { extra: { max_length_to_filter_parenthesis: 100 } },
      asr: {
        extra: { end_smooth_window_ms: 2500, enable_custom_vad: true },
      },
    },
  };
}
