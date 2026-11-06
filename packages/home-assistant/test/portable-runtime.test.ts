import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { it } from "node:test";
import vm from "node:vm";
import ts from "typescript";
import type * as HomeRuntime from "../src/index.js";

it("loads the complete public API and executes the voice/gateway flow without Node globals or modules", async () => {
  const context = vm.createContext({ setTimeout, clearTimeout, URL, URLSearchParams, AbortController });
  const modules = new Map<string, { exports: Record<string, unknown> }>();
  function load(filename: string): Record<string, unknown> {
    const cached = modules.get(filename);
    if (cached) return cached.exports;
    const module = { exports: {} };
    modules.set(filename, module);
    const source = ts.transpileModule(readFileSync(filename, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const requireRelative = (specifier: string) => {
      assert.ok(specifier.startsWith("."), `Runtime import must be relative: ${specifier}`);
      return load(path.resolve(path.dirname(filename), specifier.replace(/\.js$/, ".ts")));
    };
    const evaluate = new vm.Script(`(function(exports, require, module) { ${source}\n})`, { filename }).runInContext(context);
    evaluate(module.exports, requireRelative, module);
    return module.exports;
  }
  const runtime = load(path.resolve(import.meta.dirname, "../src/index.ts")) as typeof HomeRuntime;
  assert.equal(vm.runInContext("typeof process", context), "undefined");
  assert.equal(vm.runInContext("typeof Buffer", context), "undefined");
  const now = new Date().toISOString();
  const transport = new runtime.InMemoryHaTransportAdapter({ "light.study_ceiling": {
    entity_id: "light.study_ceiling", state: "off", attributes: {}, last_changed: now, last_updated: now,
  } });
  const gateway = new runtime.HomeAssistantGateway({ transport });
  const discovered = await runtime.executeHomeVoiceTool("list_home_devices", { query: "吸顶灯" }, gateway);
  assert.equal(discovered.total, 1);
  const result = await runtime.executeHomeVoiceTool("control_home_device", {
    entity_id: "light.study_ceiling", service: "turn_on", brightness: 180,
  }, gateway);
  assert.equal((result.receipt as { status: string }).status, "verified");
  assert.equal((await gateway.getState("light.study_ceiling"))?.attributes.brightness, 180);
  const repeated = await gateway.executeCommand({ entity_id: "light.study_ceiling", domain: "light", service: "turn_on", service_data: { brightness: 180 } });
  assert.equal(repeated.outcome, "noop");
  assert.ok(new runtime.HomeRulesEngine());
  assert.ok(runtime.HomeAssistantRestTransport);
  assert.ok(runtime.readHomeRegistry);
  assert.equal(vm.runInContext("typeof crypto", context), "undefined");
  const credentials = new Map<string, string>();
  const oauth = new runtime.MiotOAuthClient({
    redirectUri: "http://homeassistant.local:8123/api/webhook/portable", now: () => 0,
    store: { async get(key) { return credentials.get(key) ?? null; }, async set(key, value) { credentials.set(key, value); }, async delete(key) { credentials.delete(key); } },
    crypto: { randomUUID: () => "12345678-1234-4234-9234-123456789abc", sha1: async () => "a".repeat(40) },
    fetch: (async () => new Response(JSON.stringify({ code: 0, result: { access_token: "portable-token", refresh_token: "portable-refresh", expires_in: 100 } }))) as typeof fetch,
  });
  const session = await oauth.beginAuthSession();
  oauth.tryInterceptCallbackUrl(`${session.redirectUri}?state=${session.state}&code=portable-code`);
  await oauth.completeAuthWithCode("portable-code");
  assert.equal(await oauth.tokens.getAccessToken(), "portable-token");
  const resolver = new runtime.MiotSpecResolver({ fetch: (async () => new Response(JSON.stringify({
    type: "urn:miot-spec-v2:device:light:1:test:1", services: [],
  }))) as typeof fetch });
  assert.equal((await resolver.resolve("urn:miot-spec-v2:device:light:1:test:1")).deviceType, "light");
});
