import test from "node:test";
import assert from "node:assert/strict";
import { assertFreshUiAction } from "../src/productivity/authorization.js";
import { HubTaskSupervisor } from "../src/productivity/task-supervisor.js";

test("one UI tap cannot approve two grants or mutate a stored grant", async () => {
  const supervisor = new HubTaskSupervisor();
  const scope = {
    household_id: "household_default",
    subject_id: null,
    project_id: "project_a",
    audience: "project" as const,
    acl_policy_id: "explicit",
    acl_policy_revision: 1,
  };
  const now = Date.now();
  await supervisor.submitTask({
    schema_version: "0.2",
    task_id: "task_a",
    client_request_id: "request_a",
    requested_by_principal_id: "owner",
    intent: "test",
    scope,
    workspace_id: "workspace_a",
    executor_id: "local",
    context_pack_id: "pack_a",
    requested_at: new Date(now).toISOString(),
    deadline_at: new Date(now + 60000).toISOString(),
  });
  const params = {
    issued_by_principal_id: "owner",
    executor_id: "local",
    scope,
    trigger: {
      kind: "authorized_rule" as const,
      rule_id: "pending",
      rule_revision: 1,
      trigger_event_id: "event_a",
    },
    not_before: new Date(now).toISOString(),
    expires_at: new Date(now + 60000).toISOString(),
    max_uses: 1,
  };
  const first = await supervisor.issueActionGrant("task_a", params),
    second = await supervisor.issueActionGrant("task_a", params);
  const action = {
    event_id: "tap_a",
    ui_session_id: "ui_a",
    kind: "tap" as const,
    captured_at: new Date(now).toISOString(),
    expires_at: new Date(now + 10000).toISOString(),
  };
  const approved = await supervisor.approveTaskAction(
    "task_a",
    first.grant_id,
    action,
  );
  approved.grant.status = "revoked";
  assert.equal(
    (await supervisor.getActionGrant(first.grant_id))?.status,
    "active",
  );
  await assert.rejects(
    supervisor.approveTaskAction("task_a", second.grant_id, action),
    /another grant/,
  );
  supervisor.consumeActionGrant("task_a", first.grant_id);
  assert.throws(() => supervisor.consumeActionGrant("task_a", first.grant_id));
});

test("approval references require bounded scalar identities and timestamps", () => {
  const now = Date.now(),
    action = {
      event_id: "tap_a",
      ui_session_id: "ui_a",
      kind: "tap" as const,
      captured_at: new Date(now).toISOString(),
      expires_at: new Date(now + 10000).toISOString(),
    };
  assert.doesNotThrow(() => assertFreshUiAction(action));
  for (const event_id of [{}, [], 1, "", " ", "a".repeat(513)])
    assert.throws(() =>
      assertFreshUiAction({ ...action, event_id: event_id as string }),
    );
  assert.throws(() =>
    assertFreshUiAction({ ...action, captured_at: now as unknown as string }),
  );
});
