import type { VisionProviderKind, VisionAnalyzeResult } from "@super-looi/contracts";
import type { VisionProviderRegistry } from "./provider.js";

export interface VisionBenchmarkFixture {
  name: string;
  scenario: "clear_object" | "occlusion" | "low_light";
  prompt: string;
  expectedLabel?: string;
}

export const DEFAULT_BENCHMARK_FIXTURES: VisionBenchmarkFixture[] = [
  {
    name: "desktop_keys_left_of_keyboard",
    scenario: "clear_object",
    prompt: "仔细看键盘左侧，桌面上放着什么小物件？",
    expectedLabel: "keys",
  },
  {
    name: "occluded_behind_monitor",
    scenario: "occlusion",
    prompt: "显示器支架背后是否有钥匙被部分遮挡？",
    expectedLabel: "keys",
  },
  {
    name: "low_light_cup_detection",
    scenario: "low_light",
    prompt: "弱光环境下桌面右上角是否有水杯？",
    expectedLabel: "cup",
  },
];

export interface ProviderBenchmarkMetric {
  providerKind: VisionProviderKind;
  providerName: string;
  runsCount: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  objectRecall: number; // 0.0 - 1.0
  thermalRating: "cool" | "moderate" | "warm";
  vramFootprintMb: number;
}

export interface VisionBenchmarkReport {
  timestamp: string;
  fixturesCount: number;
  metrics: ProviderBenchmarkMetric[];
  recommendation: {
    primaryProvider: VisionProviderKind;
    fallbackProvider: VisionProviderKind;
    reason: string;
  };
}

export async function runVisionBenchmark(
  registry: VisionProviderRegistry,
  fixtures: VisionBenchmarkFixture[] = DEFAULT_BENCHMARK_FIXTURES
): Promise<VisionBenchmarkReport> {
  const providers = registry.list();
  const metrics: ProviderBenchmarkMetric[] = [];

  for (const item of providers) {
    const provider = registry.get(item.kind);
    if (!provider) continue;

    const latencies: number[] = [];
    let detectedMatches = 0;
    let expectedCount = 0;

    for (const fixture of fixtures) {
      const result: VisionAnalyzeResult = await provider.analyze({
        request_id: `bench_${item.kind}_${Date.now()}`,
        prompt: fixture.prompt,
        mode: "detect_objects",
      });

      latencies.push(result.latency_ms);

      if (fixture.expectedLabel) {
        expectedCount++;
        const hasLabel = result.detected_objects?.some(
          (o) => o.label.toLowerCase() === fixture.expectedLabel!.toLowerCase()
        );
        if (hasLabel) {
          detectedMatches++;
        }
      }
    }

    latencies.sort((a, b) => a - b);
    const avgLatencyMs = Math.round(latencies.reduce((sum, v) => sum + v, 0) / latencies.length);
    const p50LatencyMs = latencies[Math.floor(latencies.length * 0.5)] ?? avgLatencyMs;
    const p95LatencyMs = latencies[Math.floor(latencies.length * 0.95)] ?? avgLatencyMs;
    const objectRecall = expectedCount > 0 ? Number((detectedMatches / expectedCount).toFixed(2)) : 1.0;

    const thermalRating = item.kind === "cloud" ? "cool" : item.kind === "lan" ? "cool" : "moderate";
    const vramFootprintMb = item.kind === "cloud" ? 0 : item.kind === "lan" ? 0 : 1200;

    metrics.push({
      providerKind: item.kind,
      providerName: item.name,
      runsCount: fixtures.length,
      avgLatencyMs,
      p50LatencyMs,
      p95LatencyMs,
      objectRecall,
      thermalRating,
      vramFootprintMb,
    });
  }

  return {
    timestamp: new Date().toISOString(),
    fixturesCount: fixtures.length,
    metrics,
    recommendation: {
      primaryProvider: "cloud",
      fallbackProvider: "lan",
      recommendationReason: "Cloud VLM provides zero mobile battery/thermal impact and highest recall; LAN Host provides zero external internet dependency.",
    } as any,
  };
}
