import { FastifyInstance } from "fastify";
import { config } from "../config.js";

/**
 * STT routes — /api/stt/*
 * Speech-to-Text transcription
 */
export async function sttRoutes(fastify: FastifyInstance) {
  /**
   * POST /api/stt/transcribe
   * Accepts audio file upload, returns transcribed text
   * Uses Whisper-compatible API
   */
  fastify.post("/transcribe", async (request, reply) => {
    try {
      const data = await request.file();
      if (!data) {
        return reply.status(400).send({ error: "No audio file provided" });
      }

      const buffer = await data.toBuffer();
      const language = (data.fields as any)?.language?.value || "zh";

      fastify.log.info(
        `STT: Received audio file, size=${buffer.length}, lang=${language}`
      );

      // Forward to Whisper-compatible endpoint
      const formData = new FormData();
      const blob = new Blob([new Uint8Array(buffer)], { type: data.mimetype || "audio/m4a" });
      formData.append("file", blob, data.filename || "audio.m4a");
      formData.append("model", "gpt-4o-transcribe");
      formData.append("language", language);

      const response = await fetch(`${config.llm.baseUrl}/audio/transcriptions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.llm.apiKey}`,
        },
        body: formData,
      });

      if (!response.ok) {
        const errorText = await response.text();
        fastify.log.error(`Whisper API error ${response.status}: ${errorText}`);
        throw new Error(`Transcription API error: ${response.status}`);
      }

      const result = (await response.json()) as any;
      return { text: result.text || "" };
    } catch (error: any) {
      fastify.log.error(error, "STT transcription failed");
      return reply.status(500).send({
        error: "Transcription failed",
        details: error.message,
      });
    }
  });
}
