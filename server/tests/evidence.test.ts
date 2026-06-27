import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import Fastify from "fastify";
import { evidenceRoutes } from "../src/routes/evidence.js";

const ONE_PIXEL_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

test("evidence upload returns a fetchable URL with host port", async () => {
  const previousCwd = process.cwd();
  const tempDir = await mkdtemp(path.join(tmpdir(), "looi-evidence-"));
  process.chdir(tempDir);

  const server = Fastify({ logger: false });
  await server.register(evidenceRoutes, { prefix: "/api/evidence" });

  try {
    const upload = await server.inject({
      method: "POST",
      url: "/api/evidence/upload",
      headers: { host: "127.0.0.1:8080" },
      payload: { imageBase64: ONE_PIXEL_PNG },
    });

    assert.equal(upload.statusCode, 200);
    const body = upload.json<{ url: string; filename: string }>();
    assert.match(body.url, /^http:\/\/127\.0\.0\.1:8080\/api\/evidence\/.+\.png$/);

    const image = await server.inject({
      method: "GET",
      url: `/api/evidence/${body.filename}`,
    });

    assert.equal(image.statusCode, 200);
    assert.equal(image.headers["content-type"], "image/png");
  } finally {
    await server.close();
    process.chdir(previousCwd);
    await rm(tempDir, { recursive: true, force: true });
  }
});
