import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { TaskRequest } from "@super-looi/contracts";
import { buildApp } from "../src/app.js";
import { HomeAssistantGateway, InMemoryHaTransportAdapter } from "../src/home/gateway.js";
import { HubTaskSupervisor } from "../src/productivity/task-supervisor.js";

function task(taskId: string): TaskRequest {
  return {
    schema_version: "0.2",
    task_id: taskId,
    client_request_id: `request_${taskId}`,
    requested_by_principal_id: "owner",
    intent: "Review workspace changes",
    scope: {
      household_id: "household_default",
      subject_id: null,
      project_id: "project_study",
      audience: "project",
      acl_policy_id: "policy_project_default",
      acl_policy_revision: 1,
    },
    workspace_id: "workspace_study",
    executor_id: "dsh_runner",
    context_pack_id: "pack_study",
    requested_at: new Date().toISOString(),
    deadline_at: new Date(Date.now() + 60_000).toISOString(),
  };
}

describe("Console read-only API", () => {
  it("reports simulation separately from physical connectivity and adapter health", async (t) => {
    const transport = new InMemoryHaTransportAdapter();
    const app = buildApp({ homeGateway: new HomeAssistantGateway({ transport }) });
    t.after(() => app.close());
    const response = await app.inject("/api/console/status");
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.transportMode, "simulation");
    assert.deepEqual(body.ble, { connected: false, physicalStopVerified: false });
    assert.equal(body.home.transportMode, "simulation");
    assert.equal(body.home.healthy, true);
    assert.equal(body.voice.active, "doubao");
    assert.equal(body.vision.active, "cloud");
    transport.setHealthy(false);
    assert.equal((await app.inject("/api/console/status")).json().home.healthy, false);
  });

  it("returns whitelisted snapshots with original units and timestamps, leaving missing readings null", async (t) => {
    const timestamp = "2026-11-04T00:00:00.000Z";
    const transport = new InMemoryHaTransportAdapter({
      "sensor.study_temperature": {
        entity_id: "sensor.study_temperature",
        state: "23.8",
        attributes: { unit_of_measurement: "°C" },
        last_changed: timestamp,
        last_updated: timestamp,
      },
    });
    const gateway = new HomeAssistantGateway({ transport });
    gateway.registerEntity({ entity_id: "sensor.private", friendly_name: "Private", domain: "sensor", supported_features: [], is_whitelisted: false });
    const app = buildApp({ homeGateway: gateway });
    t.after(() => app.close());
    const response = await app.inject("/api/home/states");
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.transportMode, "simulation");
    assert.equal(body.entities.some((entity: { entity_id: string }) => entity.entity_id === "sensor.private"), false);
    const reading = body.entities.find((entity: { entity_id: string }) => entity.entity_id === "sensor.study_temperature").snapshot;
    assert.equal(reading.state, "23.8");
    assert.equal(reading.attributes.unit_of_measurement, "°C");
    assert.equal(reading.last_updated, timestamp);
    assert.equal(body.entities.find((entity: { entity_id: string }) => entity.entity_id === "light.study_ceiling").snapshot, null);
    transport.setHealthy(false);
    const offline = (await app.inject("/api/home/states")).json();
    assert.equal(offline.healthy, false);
    assert.ok(offline.entities.every((entity: { snapshot: unknown }) => entity.snapshot === null));
  });

  it("returns only the requested task's grants without altering their actual scope or status", async (t) => {
    const supervisor = new HubTaskSupervisor();
    const first = task("first");
    await supervisor.submitTask(first);
    await supervisor.submitTask(task("second"));
    const params = {
      issued_by_principal_id: "system_policy_gate",
      executor_id: "dsh_runner",
      trigger: { kind: "authorized_rule" as const, rule_id: "rule_high_risk_gate", rule_revision: 1, trigger_event_id: "event_1" },
      scope: first.scope,
      not_before: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      max_uses: 1,
    };
    const firstGrant = await supervisor.issueActionGrant("first", params);
    await supervisor.issueActionGrant("second", params);
    const app = buildApp({ taskSupervisor: supervisor });
    t.after(() => app.close());
    const response = await app.inject("/api/tasks/first/grants");
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().grants, [firstGrant]);
    assert.equal((await app.inject("/api/tasks/missing/grants")).statusCode, 404);
    await supervisor.requestCancel("first");
    const revoked = (await app.inject("/api/tasks/first/grants")).json().grants;
    assert.equal(revoked[0].status, "revoked");
    assert.equal(revoked[0].scope.project_id, "project_study");
    assert.equal(revoked[0].max_uses, 1);
  });

  it("rejects cross-task approval without changing the grant or either task", async (t) => {
    const supervisor = new HubTaskSupervisor();
    const first = task("first");
    await supervisor.submitTask(first);
    await supervisor.submitTask(task("second"));
    const grant = await supervisor.issueActionGrant("first", {
      issued_by_principal_id: "system_policy_gate",
      executor_id: "dsh_runner",
      trigger: { kind: "authorized_rule", rule_id: "gate", rule_revision: 1, trigger_event_id: "event" },
      scope: first.scope,
      not_before: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      max_uses: 1,
    });
    const app = buildApp({ taskSupervisor: supervisor });
    t.after(() => app.close());
    const response = await app.inject({
      method: "POST",
      url: "/api/tasks/second/approve",
      payload: {
        grantId: grant.grant_id,
        userAction: { kind: "tap", event_id: "tap_1", ui_session_id: "console", captured_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60_000).toISOString() },
      },
    });
    assert.equal(response.statusCode, 400);
    assert.match(response.json().error, /does not belong to task/);
    assert.equal((await supervisor.getActionGrant(grant.grant_id))?.trigger.kind, "authorized_rule");
    assert.equal((await supervisor.getTaskStatus("first"))?.state, "queued");
    assert.equal((await supervisor.getTaskStatus("second"))?.state, "queued");
  });
});
