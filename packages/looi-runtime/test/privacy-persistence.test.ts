import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createMemoryClaim } from "@super-looi/contracts";
import {
  MemoryLedgerService,
  type LedgerSnapshot,
} from "../src/memory/ledger.js";
import { ContextPackAssembler } from "../src/productivity/context-pack-assembler.js";
import { assertFreshUiAction } from "../src/productivity/authorization.js";
import { SqliteRuntimeStore } from "../src/storage/sqlite.js";
import { HubTaskSupervisor } from "../src/productivity/task-supervisor.js";

const claim = () =>
  createMemoryClaim({
    claim_id: "project_claim",
    predicate: "project.notes",
    object: { project_id: "project_a", text: "deleted secret" },
    status: "confirmed",
    source_kind: "authenticated_user_statement",
    evidence_ids: ["evidence_a"],
    derivation_roots: ["evidence_a"],
  });

test("deletion during context assembly rejects the entire stale context", async () => {
  const ledger = new MemoryLedgerService();
  await ledger.upsertClaim(claim());
  const assembler = new ContextPackAssembler(ledger);
  const pending = assembler.assemble({
    taskId: "task_a",
    projectId: "project_a",
    consumerSessionId: "session_a",
  });
  await ledger.deleteEvidenceSource("evidence_a");
  await assert.rejects(pending, /sources changed/);
  const rebuilt = await assembler.assemble({
    taskId: "task_a",
    projectId: "project_a",
    consumerSessionId: "session_a",
  });
  assert.equal(rebuilt.contextText.includes("deleted secret"), false);
  assert.deepEqual(rebuilt.includedClaimIds, []);
});

test("malformed backup never changes live or reopened capture epochs", async () => {
  let saved: LedgerSnapshot | undefined;
  const persistence = {
    load: () => saved,
    save: (snapshot: LedgerSnapshot) => {
      saved = JSON.parse(JSON.stringify(snapshot));
    },
  };
  const ledger = new MemoryLedgerService(persistence);
  ledger.setScopeState("scope_household_default", 4, 3);
  for (const corrupt of ["corrupt", null, NaN, Infinity, -1, 1.5]) {
    const snapshot = ledger.exportSnapshot();
    snapshot.scopeCaptureEpochs[0][1] = corrupt as number;
    assert.throws(() => ledger.restoreSnapshot(snapshot), /snapshot epoch/);
    assert.equal(ledger.getCaptureEpoch(), 4);
  }
  const reopened = new MemoryLedgerService(persistence);
  assert.equal(reopened.getCaptureEpoch(), 4);
  await assert.rejects(
    reopened.commitDerivedWrite(claim(), {
      scope_id: "scope_household_default",
      capture_epoch: 1,
      deletion_generation: 3,
    }),
    /Late write/,
  );
});

test("SQLite deletion history survives importing a pre-deletion backup", async () => {
  const storage = new SqliteRuntimeStore(new DatabaseSync(":memory:"));
  const ledger = new MemoryLedgerService(storage.ledger);
  await ledger.upsertClaim(claim());
  const backup = ledger.exportSnapshot();
  await ledger.deleteEvidenceSource("evidence_a");
  // Simulate replacing the snapshot row while leaving the durable deletion log.
  storage.ledger.save(backup);
  const restored = new MemoryLedgerService(storage.ledger);
  assert.equal((await restored.getClaim("project_claim"))?.status, "retracted");
  assert.equal(restored.getDeletionGeneration(), 1);
  await assert.rejects(
    restored.upsertClaim({ ...claim(), claim_id: "resurrection" }),
    /deleted evidence/,
  );
  storage.close();
});

test("storage failure stops ledger reads and further writes", async () => {
  const ledger = new MemoryLedgerService({
    load: () => undefined,
    save: () => {
      throw new Error("disk full");
    },
  });
  await assert.rejects(ledger.upsertClaim(claim()), /disk full/);
  await assert.rejects(ledger.queryClaims(), /storage failed/);
  assert.throws(() => ledger.exportSnapshot(), /storage failed/);
});

test("an old backup cannot revoke a user's inference rejection", async () => {
  const ledger = new MemoryLedgerService();
  await ledger.upsertClaim({
    ...claim(),
    status: "inferred",
    suppression_key: "do_not_infer",
  });
  const backup = ledger.exportSnapshot();
  await ledger.rejectInference("project_claim", "do_not_infer");
  ledger.restoreSnapshot(backup);
  assert.equal((await ledger.getClaim("project_claim"))?.status, "retracted");
  assert.equal((await ledger.queryClaims({ status: "inferred" })).length, 0);
});

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
