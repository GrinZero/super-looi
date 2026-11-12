import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { isIosSimulatorBuild, isLangfuseRunning, loadRuntimeVariables } from "../scripts/build-env.mjs";

test("Android debug telemetry follows collector availability", async () => {
  const server = createServer((request, response) => {
    assert.equal(request.url, "/api/public/health");
    response.writeHead(200).end('{"status":"OK"}');
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const values = {
    LANGFUSE_BASE_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    LANGFUSE_PUBLIC_KEY: "test-public",
    LANGFUSE_SECRET_KEY: "test-secret",
  };
  try {
    assert.equal(await isLangfuseRunning(values), true);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  assert.equal(await isLangfuseRunning(values), false);
});

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

test("simulator proxy is explicit and omitted from device and ordinary builds", () => {
  const before = process.env.LOOI_SIMULATOR_PROXY;
  try {
    process.env.LOOI_SIMULATOR_PROXY = "http://127.0.0.1:18888";
    assert.equal(loadRuntimeVariables({ simulator: true, release: true }).LOOI_CODEX_PROXY, "http://127.0.0.1:18888");
    assert.equal(loadRuntimeVariables({ release: true }).LOOI_CODEX_PROXY, "");
    assert.equal(loadRuntimeVariables().LOOI_CODEX_PROXY, "");
  } finally {
    if (before === undefined) delete process.env.LOOI_SIMULATOR_PROXY;
    else process.env.LOOI_SIMULATOR_PROXY = before;
  }
});

test("physical iOS packaging excludes simulator proxy without a device argument", () => {
  assert.equal(isIosSimulatorBuild("package", "ios", undefined), false);
  assert.equal(isIosSimulatorBuild("package", "ios-simulator", undefined), true);
  assert.equal(isIosSimulatorBuild("run", "ios", "device-udid"), false);
  assert.equal(isIosSimulatorBuild("dev", "ios", undefined), true);
  assert.equal(isIosSimulatorBuild("package", "android", undefined), false);
});
