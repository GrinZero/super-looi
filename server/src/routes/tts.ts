import { FastifyInstance } from "fastify";
import { config } from "../config.js";

const MINIMAX_TTS_URL = "https://api.minimax.chat/v1/t2a_v2";

/**
 * TTS routes — /api/tts/*
 * Text-to-Speech via MiniMax API
 */
export async function ttsRoutes(fastify: FastifyInstance) {
  /**
   * POST /api/tts/synthesize
   * Convert text to speech audio (returns hex-encoded MP3)
   */
  fastify.post<{
    Body: { text: string; voiceId?: string; speed?: number };
  }>("/synthesize", async (request, reply) => {
    const { text, voiceId = "male-qn-qingse", speed = 1.0 } = request.body;

    if (!text?.trim()) {
      return reply.status(400).send({ error: "text is required" });
    }

    try {
      const response = await fetch(MINIMAX_TTS_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.minimax.apiKey}`,
        },
        body: JSON.stringify({
          model: "speech-02-hd",
          text,
          stream: false,
          voice_setting: {
            voice_id: voiceId,
            speed,
            vol: 1.0,
            pitch: 0,
          },
          audio_setting: {
            sample_rate: 32000,
            bitrate: 128000,
            format: "mp3",
          },
        }),
      });

      if (!response.ok) {
        throw new Error(`MiniMax API error: ${response.status}`);
      }

      const data = await response.json() as any;

      if (data.base_resp?.status_code !== 0) {
        throw new Error(`TTS error: ${data.base_resp?.status_msg || "unknown"}`);
      }

      const audioHex = data.data?.audio;
      if (!audioHex) {
        throw new Error("No audio in response");
      }

      // Convert hex to binary buffer
      const audioBuffer = Buffer.from(audioHex, "hex");

      // Return as MP3 binary
      reply.header("Content-Type", "audio/mpeg");
      reply.header("Content-Length", audioBuffer.length);
      return reply.send(audioBuffer);
    } catch (error: any) {
      fastify.log.error(error, "TTS synthesis failed");
      return reply.status(500).send({
        error: "TTS synthesis failed",
        details: error.message,
      });
    }
  });
}
