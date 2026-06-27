import { randomUUID } from "node:crypto";
import { createReadStream, existsSync, mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { FastifyInstance } from "fastify";

const EVIDENCE_DIR = path.resolve(process.cwd(), "data", "evidence");

function ensureEvidenceDir(): void {
  if (!existsSync(EVIDENCE_DIR)) {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
  }
}

function parseImageBase64(imageBase64: string): { data: string; extension: "jpg" | "png"; mime: string } {
  const dataUriMatch = imageBase64.match(/^data:(image\/(jpeg|jpg|png));base64,(.+)$/);
  if (!dataUriMatch) {
    return { data: imageBase64, extension: "jpg", mime: "image/jpeg" };
  }

  const mime = dataUriMatch[1];
  const extension = dataUriMatch[2] === "png" ? "png" : "jpg";
  return { data: dataUriMatch[3], extension, mime };
}

function getPublicEvidenceUrl(
  request: { protocol: string; hostname: string; headers?: { host?: string } },
  filename: string
): string {
  const host = request.headers?.host || request.hostname;
  return `${request.protocol}://${host}/api/evidence/${filename}`;
}

export async function saveEvidenceImage(
  imageBase64: string,
  request: { protocol: string; hostname: string; headers?: { host?: string } }
): Promise<{ url: string; filename: string }> {
  ensureEvidenceDir();

  const parsed = parseImageBase64(imageBase64);
  const filename = `${randomUUID()}.${parsed.extension}`;
  const filepath = path.join(EVIDENCE_DIR, filename);

  await writeFile(filepath, Buffer.from(parsed.data, "base64"));

  return {
    url: getPublicEvidenceUrl(request, filename),
    filename,
  };
}

export async function evidenceRoutes(fastify: FastifyInstance) {
  fastify.post<{
    Body: { imageBase64: string };
  }>("/upload", async (request, reply) => {
    const { imageBase64 } = request.body;
    if (!imageBase64) {
      return reply.status(400).send({ error: "imageBase64 is required" });
    }

    const result = await saveEvidenceImage(imageBase64, request);
    return result;
  });

  fastify.get<{
    Params: { filename: string };
  }>("/:filename", async (request, reply) => {
    const filename = path.basename(request.params.filename);
    const filepath = path.join(EVIDENCE_DIR, filename);

    if (!existsSync(filepath)) {
      return reply.status(404).send({ error: "Evidence image not found" });
    }

    const contentType = filename.endsWith(".png") ? "image/png" : "image/jpeg";
    reply.header("Content-Type", contentType);
    reply.header("Cache-Control", "public, max-age=31536000, immutable");
    return reply.send(createReadStream(filepath));
  });
}
