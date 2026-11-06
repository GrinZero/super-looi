import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.js";
import { VoiceProviderRegistry } from "../src/voice/provider.js";
import { VisionProviderRegistry } from "../src/vision/provider.js";
import { HomeAssistantGateway } from "../src/home/gateway.js";

describe("Hub Fastify Server and Registries", () => {
  it("serves /health endpoint with correct providers and module statuses", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/health",
    });

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.status, "ok");
    assert.equal(body.version, "0.2.0");
    assert.equal(body.activeVoiceProvider, "doubao");
    assert.equal(body.activeVisionProvider, "cloud");
    assert.equal(body.modules.memory.eventsCount, 0);
    assert.equal(body.modules.productivity.activeTasks, 0);
    assert.equal(body.modules.home.status, "ready");

    await app.close();
  });

  it("manages pluggable VoiceProvider registration and active switching", async () => {
    const voiceRegistry = new VoiceProviderRegistry();
    assert.equal(voiceRegistry.getActiveKind(), "doubao");

    voiceRegistry.setActive("modular");
    assert.equal(voiceRegistry.getActiveKind(), "modular");
    assert.equal(voiceRegistry.getActive().name, "Modular Pipeline (ASR + LLM + TTS)");

    assert.throws(
      () => {
        // @ts-expect-error testing invalid kind
        voiceRegistry.setActive("unknown_provider");
      },
      /not registered/
    );
  });

  it("manages pluggable VisionProvider registration and active switching", async () => {
    const visionRegistry = new VisionProviderRegistry();
    assert.equal(visionRegistry.getActiveKind(), "cloud");

    visionRegistry.setActive("lan");
    assert.equal(visionRegistry.getActiveKind(), "lan");
    assert.equal(visionRegistry.getActive().name, "LAN Local Host VLM (Ollama / vLLM)");

    visionRegistry.setActive("edge");
    assert.equal(visionRegistry.getActiveKind(), "edge");

    const list = visionRegistry.list();
    assert.equal(list.length, 3);
    const edgeItem = list.find((i) => i.kind === "edge");
    assert.equal(edgeItem?.isActive, true);
  });

  it("executes home gateway commands with idempotent readback verification", async () => {
    const gateway = new HomeAssistantGateway();

    // 1. Turn on light from initial off state -> verified applied
    const receipt1 = await gateway.executeCommand({
      entity_id: "light.study_ceiling",
      domain: "light",
      service: "turn_on",
      service_data: { brightness: 255 },
    });

    assert.equal(receipt1.status, "verified");
    assert.equal(receipt1.outcome, "applied");
    assert.equal(receipt1.readbacks[0].value.state, "on");

    // 2. Turn on light again when already on -> verified noop
    const receipt2 = await gateway.executeCommand({
      entity_id: "light.study_ceiling",
      domain: "light",
      service: "turn_on",
      service_data: { brightness: 255 },
    });

    assert.equal(receipt2.status, "verified");
    assert.equal(receipt2.outcome, "noop");

    // 3. Command on unwhitelisted entity -> rejected
    const receipt3 = await gateway.executeCommand({
      entity_id: "lock.front_door",
      domain: "lock",
      service: "unlock",
      service_data: {},
    });

    assert.equal(receipt3.status, "rejected");
    assert.match(receipt3.reason_code || "", /forbidden_high_risk_domain|ENTITY_NOT_WHITELISTED/i);
  });
});
