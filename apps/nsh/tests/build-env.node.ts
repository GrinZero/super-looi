import assert from "node:assert/strict";
import { test } from "node:test";
import { loadRuntimeVariables } from "../scripts/build-env.mjs";

test("ordinary and release bundles omit Langfuse secret even with debug env enabled", () => {
  const before = { ...process.env };
  try {
    process.env.LOOI_DEBUG_TELEMETRY = "1";
    process.env.LANGFUSE_SECRET_KEY = "test-secret";
    process.env.LANGFUSE_PUBLIC_KEY = "test-public";
    process.env.LANGFUSE_BASE_URL = "http://localhost:3000";
    assert.equal(loadRuntimeVariables().LANGFUSE_SECRET_KEY, "");
    assert.equal(loadRuntimeVariables({ release: true, debugTelemetry: true }).LANGFUSE_SECRET_KEY, "");
    assert.equal(loadRuntimeVariables({ debugTelemetry: true }).LANGFUSE_SECRET_KEY, "test-secret");
  } finally {
    process.env = before;
  }
});
