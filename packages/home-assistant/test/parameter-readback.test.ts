import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { HomeControlCommand, HomeStateSnapshot } from "@super-looi/contracts";
import { HomeAssistantGateway, InMemoryHaTransportAdapter, type HaTransportAdapter } from "../src/index.js";

const snapshot = (): HomeStateSnapshot => ({
  entity_id: "light.study_ceiling",
  state: "on",
  attributes: { brightness: 80, color_temp_kelvin: 3000 },
  last_changed: new Date().toISOString(),
  last_updated: new Date().toISOString(),
});

const command = (serviceData: HomeControlCommand["service_data"]): HomeControlCommand => ({
  entity_id: "light.study_ceiling",
  domain: "light",
  service: "turn_on",
  service_data: serviceData,
});

describe("Home parameter readback", () => {
  it("applies brightness and temperature adjustments to a fresh on light and noops only on matching parameters", async () => {
    const adapter = new InMemoryHaTransportAdapter({ "light.study_ceiling": snapshot() });
    const gateway = new HomeAssistantGateway({ transport: adapter });

    const brightness = await gateway.executeCommand(command({ brightness: 180 }));
    assert.equal(brightness.status, "verified");
    assert.equal(brightness.outcome, "applied");
    assert.equal((await gateway.getState("light.study_ceiling"))?.attributes.brightness, 180);

    const temperature = await gateway.executeCommand(command({ color_temp_kelvin: 4500 }));
    assert.equal(temperature.status, "verified");
    assert.equal(temperature.outcome, "applied");
    assert.deepEqual((await gateway.getState("light.study_ceiling"))?.attributes, {
      brightness: 180, color_temp_kelvin: 4500, entity_id: "light.study_ceiling",
    });

    adapter.setSimulateTimeout(true);
    const repeated = await gateway.executeCommand(command({ brightness: 180, color_temp_kelvin: 4500 }));
    assert.equal(repeated.status, "verified");
    assert.equal(repeated.outcome, "noop");
  });

  it("does not verify a successful service acknowledgement when requested parameter readback differs", async () => {
    let calls = 0;
    const state = snapshot();
    const adapter: HaTransportAdapter = {
      async callService() { calls += 1; return { success: true }; },
      async fetchState() { return state; },
      isHealthy() { return true; },
      getLastVerifiedAt() { return state.last_updated; },
    };
    const gateway = new HomeAssistantGateway({ transport: adapter });
    for (const parameters of [{ brightness: 180 }, { color_temp_kelvin: 4500 }]) {
      const receipt = await gateway.executeCommand(command(parameters));
      assert.equal(receipt.status, "unverified");
      assert.equal(receipt.reason_code, "readback_mismatch");
      assert.equal(receipt.outcome, undefined);
    }
    assert.equal(calls, 2);
  });
});
