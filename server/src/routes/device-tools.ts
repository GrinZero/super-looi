import { FastifyInstance } from "fastify";
import {
  listDeviceTools,
  pollDeviceToolCalls,
  registerDeviceTools,
  resolveDeviceToolCall,
  type DeviceToolRegistration,
} from "../device-tools/registry.js";

export async function deviceToolRoutes(fastify: FastifyInstance) {
  fastify.post<{ Body: { deviceId: string; tools: Omit<DeviceToolRegistration, "deviceId">[] } }>(
    "/register",
    async (request, reply) => {
      const { deviceId, tools } = request.body;
      if (!deviceId || !Array.isArray(tools)) {
        return reply.status(400).send({ error: "deviceId and tools are required" });
      }
      registerDeviceTools(deviceId, tools);
      return { ok: true, count: tools.length };
    }
  );

  fastify.get<{ Querystring: { deviceId?: string } }>("/poll", async (request, reply) => {
    const deviceId = request.query.deviceId;
    if (!deviceId) return reply.status(400).send({ error: "deviceId is required" });
    return { calls: pollDeviceToolCalls(deviceId) };
  });

  fastify.post<{ Body: { callId: string; result?: unknown; error?: unknown } }>("/result", async (request, reply) => {
    const { callId, result, error } = request.body;
    if (!callId) return reply.status(400).send({ error: "callId is required" });
    const ok = resolveDeviceToolCall(callId, error ?? result, error !== undefined);
    return { ok };
  });

  fastify.get("/list", async () => ({ tools: listDeviceTools() }));
}
