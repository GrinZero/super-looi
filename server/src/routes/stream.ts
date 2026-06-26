import { FastifyInstance } from "fastify";
import { RawData } from "ws";

/**
 * WebSocket stream routes — /ws/frames
 * Receives real-time camera frames for continuous scene analysis
 */
export async function streamRoutes(fastify: FastifyInstance) {
  fastify.get("/frames", { websocket: true }, (socket, request) => {
    fastify.log.info("WebSocket client connected for frame streaming");

    let frameCount = 0;
    const frameBuffer: string[] = [];
    const MAX_BUFFER = 30; // Keep last 30 frames

    socket.on("message", (data: RawData) => {
      frameCount++;

      // Expect base64-encoded frame data
      const frameData = data.toString();
      frameBuffer.push(frameData);

      if (frameBuffer.length > MAX_BUFFER) {
        frameBuffer.shift();
      }

      // Acknowledge receipt every 10 frames
      if (frameCount % 10 === 0) {
        socket.send(
          JSON.stringify({
            type: "ack",
            frameCount,
            bufferSize: frameBuffer.length,
          })
        );
      }
    });

    socket.on("close", () => {
      fastify.log.info(`WebSocket closed. Total frames received: ${frameCount}`);
    });

    socket.on("error", (err: Error) => {
      fastify.log.error(err, "WebSocket error");
    });
  });
}
