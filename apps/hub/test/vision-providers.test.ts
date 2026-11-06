import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CloudVisionProvider,
  LanVisionProvider,
  EdgeVisionProvider,
  VisionProviderRegistry,
} from "../src/vision/provider.js";
import { runVisionBenchmark } from "../src/vision/benchmark.js";

describe("Pluggable Vision Providers & Benchmark (Phase 1)", () => {
  it("CloudVisionProvider parses OpenAI-compatible multimodal completions", async () => {
    let calledUrl = "";
    const mockFetch: typeof fetch = async (url, init) => {
      calledUrl = String(url);
      return {
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: "桌面上放着一串钥匙(keys)和一个杯子(cup)。",
              },
            },
          ],
        }),
      } as Response;
    };

    const cloud = new CloudVisionProvider({
      apiKey: "sk-mock-cloud-key",
      baseUrl: "https://api.openai.com/v1",
      fetchFn: mockFetch,
    });

    const result = await cloud.analyze({
      request_id: "req_cloud_1",
      prompt: "桌上有钥匙吗？",
      mode: "detect_objects",
      image_base64: "dGVzdA==",
    });

    assert.ok(calledUrl.includes("/chat/completions"));
    assert.equal(result.provider_kind, "cloud");
    assert.ok(result.detected_objects?.some((o) => o.label === "keys"));
    assert.ok(result.detected_objects?.some((o) => o.label === "cup"));
  });

  it("LanVisionProvider connects to local LAN host Ollama/vLLM endpoint", async () => {
    let calledPayload: any = null;
    const mockFetch: typeof fetch = async (_url, init) => {
      calledPayload = JSON.parse(String(init?.body));
      return {
        ok: true,
        json: async () => ({
          message: {
            content: "在左侧发现了钥匙(keys)。",
          },
        }),
      } as Response;
    };

    const lan = new LanVisionProvider({
      baseUrl: "http://192.168.1.100:11434",
      fetchFn: mockFetch,
    });

    const result = await lan.analyze({
      request_id: "req_lan_1",
      prompt: "查看左侧物体",
      mode: "detect_objects",
    });

    assert.equal(result.provider_kind, "lan");
    assert.equal(calledPayload.model, "qwen2.5-vl-7b-instruct");
    assert.ok(result.detected_objects?.some((o) => o.label === "keys"));
  });

  it("EdgeVisionProvider serializes concurrent inferences and auto-unloads on idle", async () => {
    const edge = new EdgeVisionProvider({
      idleUnloadMs: 60,
      inferenceDelayMs: 20,
    });

    assert.equal(edge.isLoaded(), false);

    // Launch 3 concurrent analyze requests simultaneously
    const p1 = edge.analyze({ request_id: "r1", prompt: "p1", mode: "detect_objects" });
    const p2 = edge.analyze({ request_id: "r2", prompt: "p2", mode: "detect_objects" });
    const p3 = edge.analyze({ request_id: "r3", prompt: "p3", mode: "detect_objects" });

    const results = await Promise.all([p1, p2, p3]);
    assert.equal(results.length, 3);
    assert.equal(edge.isLoaded(), true);

    // Peak active running count must be 1 (serialized mutex queue protects mobile RAM!)
    assert.equal(edge.concurrentPeakCount, 1);

    // Wait for idle timer (60ms) to auto-unload model to save battery & thermals
    await new Promise((resolve) => setTimeout(resolve, 90));
    assert.equal(edge.isLoaded(), false, "Model should auto-unload after idle period");
  });

  it("runVisionBenchmark executes test suite across all 3 tiers and computes metrics", async () => {
    const registry = new VisionProviderRegistry();
    const report = await runVisionBenchmark(registry);

    assert.ok(report.timestamp);
    assert.equal(report.fixturesCount, 3);
    assert.equal(report.metrics.length, 3);

    const cloudMetric = report.metrics.find((m) => m.providerKind === "cloud");
    const lanMetric = report.metrics.find((m) => m.providerKind === "lan");
    const edgeMetric = report.metrics.find((m) => m.providerKind === "edge");

    assert.ok(cloudMetric && cloudMetric.runsCount === 3);
    assert.ok(lanMetric && lanMetric.runsCount === 3);
    assert.ok(edgeMetric && edgeMetric.runsCount === 3);

    assert.ok(cloudMetric.avgLatencyMs >= 0);
    assert.ok(cloudMetric.objectRecall > 0.5);
    assert.equal(cloudMetric.vramFootprintMb, 0);
    assert.equal(edgeMetric.vramFootprintMb, 1200);
  });
});
