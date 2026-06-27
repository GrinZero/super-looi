import assert from "node:assert/strict";
import test from "node:test";
import { buildServer } from "../src/index.js";

test("server does not expose a fallback STT transcription endpoint", async () => {
  const server = await buildServer({ logger: false });

  try {
    const response = await server.inject({
      method: "POST",
      url: "/api/stt/transcribe",
      payload: {},
    });

    assert.equal(response.statusCode, 404);
  } finally {
    await server.close();
  }
});
