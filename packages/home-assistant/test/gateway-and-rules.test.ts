import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  HomeAssistantGateway,
  InMemoryHaTransportAdapter,
  FORBIDDEN_HIGH_RISK_DOMAINS,
} from "../src/index.js";
import { HomeRulesEngine } from "../src/index.js";
import type { UserActionRef, HomeControlCommand } from "@super-looi/contracts";

describe("Smart Home Gateway: Whitelist, Idempotency, Disambiguation & Sensor Truth (Phase 4)", () => {
  it("strictly rejects high-risk forbidden domains and non-whitelisted entities", async () => {
    const gateway = new HomeAssistantGateway();

    // 1. High risk domain (smart door lock)
    const lockCmd: HomeControlCommand = {
      entity_id: "lock.front_door",
      domain: "lock",
      service: "unlock",
      service_data: {},
    };
    const r1 = await gateway.executeCommand(lockCmd);
    assert.equal(r1.status, "rejected");
    assert.equal(r1.reason_code, "forbidden_high_risk_domain");

    // 2. Alarm control panel
    const alarmCmd: HomeControlCommand = {
      entity_id: "alarm_control_panel.home",
      domain: "alarm_control_panel",
      service: "disarm",
      service_data: {},
    };
    const r2 = await gateway.executeCommand(alarmCmd);
    assert.equal(r2.status, "rejected");
    assert.equal(r2.reason_code, "forbidden_high_risk_domain");

    // 3. Non-whitelisted random device
    const unknownCmd: HomeControlCommand = {
      entity_id: "light.neighbor_balcony",
      domain: "light",
      service: "turn_on",
      service_data: {},
    };
    const r3 = await gateway.executeCommand(unknownCmd);
    assert.equal(r3.status, "rejected");
    assert.equal(r3.reason_code, "entity_not_whitelisted");
  });

  it("disambiguates ambiguous target entities honestly instead of guessing", async () => {
    const gateway = new HomeAssistantGateway();

    // "书房灯" matches both study ceiling light and study desk lamp!
    const ambig = await gateway.resolveTargets("书房灯", "书房");
    assert.equal(ambig.status, "ambiguous");
    assert.equal(ambig.candidates?.length, 2);
    assert.ok(ambig.clarificationPrompt);
    assert.match(ambig.clarificationPrompt, /你想调哪一盏/);

    // Specific query matches exactly 1
    const exact = await gateway.resolveTargets("吸顶灯", "书房");
    assert.equal(exact.status, "resolved");
    assert.equal(exact.entity?.entity_id, "light.study_ceiling");

    // Unknown query matches 0
    const none = await gateway.resolveTargets("不存在的空调");
    assert.equal(none.status, "none");
    assert.match(none.clarificationPrompt || "", /未找到匹配/);
  });

  it("enforces No-Toggle discipline and validates parameter bounds", async () => {
    const gateway = new HomeAssistantGateway();

    // Rejects non-idempotent toggle
    const toggleCmd: HomeControlCommand = {
      entity_id: "light.study_ceiling",
      domain: "light",
      service: "toggle",
      service_data: {},
    };
    const r1 = await gateway.executeCommand(toggleCmd);
    assert.equal(r1.status, "rejected");
    assert.equal(r1.reason_code, "non_idempotent_toggle_forbidden");

    // Parameter out of range: brightness 300 (allowed: 1..255)
    const outOfBoundsCmd: HomeControlCommand = {
      entity_id: "light.study_ceiling",
      domain: "light",
      service: "turn_on",
      service_data: { brightness: 300 },
    };
    const r2 = await gateway.executeCommand(outOfBoundsCmd);
    assert.equal(r2.status, "rejected");
    assert.equal(r2.reason_code, "parameter_out_of_range:brightness");
  });

  it("returns verified noop on fresh matching state, verified applied on change, and unverified on timeout", async () => {
    const adapter = new InMemoryHaTransportAdapter({
      "light.study_ceiling": {
        entity_id: "light.study_ceiling",
        state: "off",
        attributes: { brightness: 0 },
        last_changed: new Date().toISOString(),
        last_updated: new Date().toISOString(),
      },
    });

    const gateway = new HomeAssistantGateway({ transport: adapter });

    // 1. Fresh Noop: Ceiling light is already off and fresh
    const r1 = await gateway.executeCommand({
      entity_id: "light.study_ceiling",
      domain: "light",
      service: "turn_off",
      service_data: {},
    });
    assert.equal(r1.status, "verified");
    assert.equal(r1.outcome, "noop");
    assert.equal(r1.readbacks[0].state_version, "fresh_cached");

    // 2. Verified Applied: Turn on ceiling light
    const r2 = await gateway.executeCommand({
      entity_id: "light.study_ceiling",
      domain: "light",
      service: "turn_on",
      service_data: { brightness: 80 },
    });
    assert.equal(r2.status, "verified");
    assert.equal(r2.outcome, "applied");
    assert.equal(r2.readbacks[0].value.state, "on");

    // 3. The write did not return an acknowledgement; this is not a readback timeout.
    adapter.setSimulateTimeout(true);
    const r3 = await gateway.executeCommand({
      entity_id: "light.study_ceiling",
      domain: "light",
      service: "turn_off",
      service_data: {},
    });
    assert.equal(r3.status, "unverified");
    assert.equal(r3.reason_code, "home_service_call_timeout");
    assert.equal(r3.diagnostics?.stage, "write");
  });

  it("handles batch scene execution and reports partial failure honestly", async () => {
    const gateway = new HomeAssistantGateway();

    // Batch with 1 whitelisted entity and 1 non-whitelisted entity
    const batch = await gateway.executeBatch([
      {
        entity_id: "light.study_ceiling",
        domain: "light",
        service: "turn_on",
        service_data: {},
      },
      {
        entity_id: "light.kitchen_unknown",
        domain: "light",
        service: "turn_on",
        service_data: {},
      },
    ]);

    assert.equal(batch.outcome, "partial");
    assert.equal(batch.receipts.length, 2);
    assert.equal(batch.failedEntities.length, 1);
    assert.equal(batch.failedEntities[0].entityId, "light.kitchen_unknown");
  });

  it("enforces sensor truth exclusivity and reconciles physical state with visual descriptions", async () => {
    const adapter = new InMemoryHaTransportAdapter({
      "sensor.study_temperature": {
        entity_id: "sensor.study_temperature",
        state: "24.5",
        attributes: { unit_of_measurement: "°C" },
        last_changed: new Date().toISOString(),
        last_updated: new Date().toISOString(),
      },
      "light.study_ceiling": {
        entity_id: "light.study_ceiling",
        state: "on",
        attributes: { brightness: 100 },
        last_changed: new Date().toISOString(),
        last_updated: new Date().toISOString(),
      },
    });

    const gateway = new HomeAssistantGateway({ transport: adapter });

    // 1. Read environmental metric from verified sensor
    const temp = await gateway.readEnvironmentalMetric("temperature");
    assert.equal(temp.source, "sensor");
    assert.equal(temp.value, 24.5);
    assert.equal(temp.unit, "°C");

    // 2. Reject sensor metric that has no whitelisted sensor
    await assert.rejects(
      async () => {
        await gateway.readEnvironmentalMetric("pm25");
      },
      /No whitelisted sensor entity found/
    );

    // 3. Reconcile device state with visual description
    const recon = await gateway.reconcileDeviceAndVisualState(
      "light.study_ceiling",
      "The room looks very dark and dim"
    );
    assert.equal(recon.isConsistent, false);
    assert.match(
      recon.explanation,
      /书房灯设备已回报开启，但镜头画面仍偏暗（可能受遮挡或曝光影响）/
    );
    // Preserves physical state as 'on'
    assert.equal(recon.deviceState.state, "on");
  });
});

describe("HomeRulesEngine: 3-Adjustment Pattern Promotion (Phase 4)", () => {
  it("tracks manual adjustments, generates proposal after 3 occurrences, and promotes on confirmation", () => {
    const engine = new HomeRulesEngine();

    // 1st adjustment: recorded, no proposal
    const r1 = engine.recordManualAdjustment({
      entityId: "light.study_desk",
      service: "turn_on",
      serviceData: { brightness: 30, color_temp: 3000 },
      contextHint: "evening_study",
    });
    assert.equal(r1.recorded, true);
    assert.equal(r1.newProposal, undefined);
    assert.equal(engine.listPendingProposals().length, 0);

    // 2nd adjustment: recorded, no proposal
    const r2 = engine.recordManualAdjustment({
      entityId: "light.study_desk",
      service: "turn_on",
      serviceData: { brightness: 30, color_temp: 3000 },
      contextHint: "evening_study",
    });
    assert.equal(r2.newProposal, undefined);

    // 3rd adjustment: generates proposal!
    const r3 = engine.recordManualAdjustment({
      entityId: "light.study_desk",
      service: "turn_on",
      serviceData: { brightness: 30, color_temp: 3000 },
      contextHint: "evening_study",
    });
    assert.ok(r3.newProposal);
    assert.equal(r3.newProposal.entity_id, "light.study_desk");
    assert.equal(r3.newProposal.observed_count, 3);
    assert.match(r3.newProposal.explanation, /你最近 3 次/);

    const proposals = engine.listPendingProposals();
    assert.equal(proposals.length, 1);

    // User confirms proposal via explicit UserActionRef
    const userAction: UserActionRef = {
      event_id: "evt_confirm_rule_01",
      ui_session_id: "sess_mobile_ui",
      kind: "tap",
      captured_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60000).toISOString(),
    };

    const rule = engine.confirmRuleProposal(proposals[0].proposal_id, userAction);
    assert.equal(rule.status, "active");
    assert.equal(rule.entity_id, "light.study_desk");
    assert.equal(rule.confirmed_by_user_event_id, "evt_confirm_rule_01");

    // Pending proposal is consumed
    assert.equal(engine.listPendingProposals().length, 0);
    assert.equal(engine.listRules().length, 1);

    // User revokes rule
    const revoked = engine.revokeRule(rule.rule_id);
    assert.equal(revoked.status, "revoked");
    assert.ok(revoked.revoked_at);
  });
});
