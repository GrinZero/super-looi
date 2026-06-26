import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import { visionRoutes } from "./routes/vision.js";
import { memoryRoutes } from "./routes/memory.js";
import { streamRoutes } from "./routes/stream.js";
import { llmRoutes } from "./routes/llm.js";

const server = Fastify({ logger: true });

async function main() {
  await server.register(cors, { origin: true });
  await server.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } });
  await server.register(websocket);

  // Routes
  await server.register(visionRoutes, { prefix: "/api/vision" });
  await server.register(memoryRoutes, { prefix: "/api/memory" });
  await server.register(streamRoutes, { prefix: "/ws" });
  await server.register(llmRoutes, { prefix: "/api/llm" });

  // Health check
  server.get("/health", async () => ({ status: "ok", timestamp: new Date().toISOString() }));

  const port = parseInt(process.env.PORT || "8080", 10);
  const host = process.env.HOST || "0.0.0.0";

  await server.listen({ port, host });
  console.log(`🚀 LOOI Server running at http://${host}:${port}`);
}

main().catch((err) => {
  server.log.error(err);
  process.exit(1);
});
