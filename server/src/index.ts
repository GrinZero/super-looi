import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import { visionRoutes } from "./routes/vision.js";
import { memoryRoutes } from "./routes/memory.js";
import { streamRoutes } from "./routes/stream.js";
import { llmRoutes } from "./routes/llm.js";
import { ttsRoutes } from "./routes/tts.js";
import { evidenceRoutes } from "./routes/evidence.js";
import { observeRoutes } from "./routes/observe.js";
import { sessionRoutes } from "./routes/session.js";
import { deviceToolRoutes } from "./routes/device-tools.js";

export async function buildServer(options: { logger?: boolean } = {}) {
  const server = Fastify({ logger: options.logger ?? true });

  await server.register(cors, { origin: true });
  await server.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } });
  await server.register(websocket);

  // Routes
  await server.register(visionRoutes, { prefix: "/api/vision" });
  await server.register(memoryRoutes, { prefix: "/api/memory" });
  await server.register(streamRoutes, { prefix: "/ws" });
  await server.register(llmRoutes, { prefix: "/api/llm" });
  await server.register(ttsRoutes, { prefix: "/api/tts" });
  await server.register(evidenceRoutes, { prefix: "/api/evidence" });
  await server.register(observeRoutes, { prefix: "/api/observe" });
  await server.register(sessionRoutes, { prefix: "/api/session" });
  await server.register(deviceToolRoutes, { prefix: "/api/device-tools" });

  // Health check
  server.get("/health", async () => ({ status: "ok", timestamp: new Date().toISOString() }));

  return server;
}

async function main() {
  const server = await buildServer();
  const port = parseInt(process.env.PORT || "8080", 10);
  const host = process.env.HOST || "0.0.0.0";

  await server.listen({ port, host });
  console.log(`🚀 LOOI Server running at http://${host}:${port}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
