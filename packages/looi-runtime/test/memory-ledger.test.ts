import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MemoryLedgerService } from "../src/memory/ledger.js";
import {
  createMemoryClaim,
  LateWritebackRejectedError,
  type EventEnvelope,
  type ContextPackManifest,
} from "@super-looi/contracts";

describe("MemoryLedgerService (Phase 2)", () => {
  it("enforces event idempotency and detects content hash conflicts", async () => {
    const ledger = new MemoryLedgerService();
    const event1: EventEnvelope = {
      schema_version: "0.2",
      event_id: "evt_1",
      household_id: "h1",
      subject_id: "user_1",
      source_id: "phone_front_camera",
      source_device_id: "dev_phone",
      boot_epoch: "boot_100",
      sequence: 1,
      content_hash: "hash_abc_123",
      observed_at: new Date().toISOString(),
      monotonic_ms: 1000,
      monotonic_clock: "android_elapsed_realtime",
      received_at: new Date().toISOString(),
      time_uncertainty_ms: null,
      source_kind: "camera_frame",
      evidence_refs: [],
      derivation_roots: ["root_frame_1"],
      caused_by_action_id: null,
      parser_version: "v1",
      privacy_scope: {
        household_id: "h1",
        subject_id: "user_1",
        project_id: null,
        audience: "household",
        acl_policy_id: "acl_default",
        acl_policy_revision: 1,
      },
      epoch_binding: { scope_id: "s1", capture_epoch: 1, deletion_generation: 0 },
      retention_policy: { policy_id: "p1", revision: 1, expires_at: null, raw_expiry_behavior: "cascade" },
      payload: { detected: "keys" },
    };

    // First ingestion -> success, not deduplicated
    const res1 = await ledger.ingestEvent(event1);
    assert.equal(res1.deduplicated, false);

    // Second ingestion with identical key and same hash -> deduplicated idempotent success
    const res2 = await ledger.ingestEvent(event1);
    assert.equal(res2.deduplicated, true);

    // Third ingestion with same sequence but different hash -> integrity conflict!
    const corruptedEvent: EventEnvelope = {
      ...event1,
      content_hash: "hash_tampered_999",
      payload: { detected: "wallet" },
    };

    await assert.rejects(
      async () => {
        await ledger.ingestEvent(corruptedEvent);
      },
      /Event integrity conflict/
    );
  });

  it("queries last-seen object with honest epistemic phrasing", async () => {
    const ledger = new MemoryLedgerService();

    const claim = createMemoryClaim({
      claim_id: "claim_keys_1",
      predicate: "object_last_seen",
      object: { target: "keys", location: "键盘左侧", confidence: 0.95 },
      status: "observed",
      source_kind: "camera_frame",
      evidence_ids: ["ev_frame_881"],
      derivation_roots: ["root_frame_881"],
      observed_at: "2026-11-03T19:42:00.000Z",
    });

    await ledger.upsertClaim(claim);

    const result = await ledger.queryObjectLastSeen("keys");
    assert.ok(result);
    assert.equal(result.locationText, "键盘左侧");
    assert.equal(result.status, "observed");
    assert.ok(result.epistemicAnswer.includes("看到它在 键盘左侧"));
    assert.ok(result.epistemicAnswer.includes("不排除之后已被移动"));
  });

  it("handles fact correction by superseding previous revision and creating confirmed revision", async () => {
    const ledger = new MemoryLedgerService();

    const originalClaim = createMemoryClaim({
      claim_id: "claim_keys_cor",
      predicate: "object_last_seen",
      object: { target: "keys", location: "书架上" },
      status: "inferred",
      source_kind: "camera_frame",
      evidence_ids: ["ev_1"],
      derivation_roots: ["root_1"],
    });
    await ledger.upsertClaim(originalClaim);

    // User corrects: "不是书架，是在抽屉里"
    const corrected = await ledger.correctClaim(
      "claim_keys_cor",
      { target: "keys", location: "抽屉里" },
      "evt_user_tap_correct"
    );

    assert.equal(corrected.revision, 2);
    assert.equal(corrected.status, "confirmed");
    assert.equal(corrected.revision_reason, "user_correction");
    assert.equal(corrected.confirmed_by_user_event_id, "evt_user_tap_correct");
    assert.equal((corrected.object as any).location, "抽屉里");

    // Previous revision is marked superseded and valid_to closed
    const prev = (await ledger.getClaim("claim_keys_cor"))!;
    assert.equal(prev.status, "confirmed"); // latest revision
  });

  it("rejects inference and blocks future reinference via suppression key", async () => {
    const ledger = new MemoryLedgerService();

    const claim = createMemoryClaim({
      claim_id: "claim_infer_1",
      predicate: "user_preference",
      object: { preference: "熬夜" },
      status: "inferred",
      source_kind: "app_context",
      evidence_ids: ["ev_ctx_1"],
      derivation_roots: ["root_ctx_1"],
    });
    claim.suppression_key = "suppress_late_night";
    await ledger.upsertClaim(claim);

    // User clicks "忘记这个推断"
    await ledger.rejectInference("claim_infer_1", "suppress_late_night");

    const retracted = await ledger.getClaim("claim_infer_1");
    assert.equal(retracted?.status, "retracted");

    // Later asynchronous pipeline tries to reinfer the same thing -> BLOCKED!
    const reinferClaim = createMemoryClaim({
      claim_id: "claim_infer_2",
      predicate: "user_preference",
      object: { preference: "熬夜" },
      status: "inferred",
      source_kind: "app_context",
      evidence_ids: ["ev_ctx_2"],
      derivation_roots: ["root_ctx_2"],
    });
    reinferClaim.suppression_key = "suppress_late_night";

    await assert.rejects(
      async () => {
        await ledger.upsertClaim(reinferClaim);
      },
      /suppression key 'suppress_late_night' is active/
    );
  });

  it("cascades evidence source deletion to claims and invalidates active ContextPacks", async () => {
    const ledger = new MemoryLedgerService();

    const claim = createMemoryClaim({
      claim_id: "claim_to_delete",
      predicate: "object_last_seen",
      object: { target: "passport", location: "桌上" },
      status: "observed",
      source_kind: "camera_frame",
      evidence_ids: ["ev_frame_delete_target"],
      derivation_roots: ["root_frame_delete_target"],
    });
    await ledger.upsertClaim(claim);

    // Register active ContextPack referencing this evidence
    const pack: ContextPackManifest = {
      schema_version: "0.2",
      context_pack_id: "pack_101",
      revision: 1,
      task_id: "task_1",
      consumer_session_id: "sess_1",
      authorized_principal_id: "user_1",
      scope: {
        household_id: "h1",
        subject_id: null,
        project_id: null,
        audience: "household",
        acl_policy_id: "p1",
        acl_policy_revision: 1,
      },
      source_allowlist: ["ev_frame_delete_target"],
      observed_time_range: { from: new Date().toISOString(), to: new Date().toISOString() },
      claim_refs: [{ claim_id: "claim_to_delete", revision: 1 }],
      evidence_refs: [
        {
          evidence_id: "ev_frame_delete_target",
          revision: 1,
          source_event_id: "evt_1",
          derivation_root_id: "root_1",
          episode_id: null,
          media_type: "image/jpeg",
          captured_at: new Date().toISOString(),
          availability: "retained",
          object_ref: "obj_1",
          expires_at: null,
        },
      ],
      derivation_roots: ["root_frame_delete_target"],
      epoch_bindings: [],
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60000).toISOString(),
      instruction_trust: "untrusted_context_data",
      status: "active",
    };
    ledger.registerContextPack(pack);

    // Delete evidence source
    const deleteResult = await ledger.deleteEvidenceSource("ev_frame_delete_target", "scope_household_default");
    assert.equal(deleteResult.retractedClaimsCount, 1);
    assert.equal(deleteResult.tombstone.target_evidence_ids[0], "ev_frame_delete_target");

    // Claim is retracted and availability set to source_expired
    const retractedClaim = await ledger.getClaim("claim_to_delete");
    assert.equal(retractedClaim?.status, "retracted");
    assert.equal(retractedClaim?.source_availability, "source_expired");

    // ContextPack is marked invalidated
    const updatedPack = ledger.getContextPack("pack_101");
    assert.equal(updatedPack?.status, "invalidated");
    assert.equal(updatedPack?.invalidation_reason, "source_deleted");
  });

  it("Late Writeback Guard: strictly rejects writes if deletion generation or capture epoch advanced", async () => {
    const ledger = new MemoryLedgerService();
    ledger.setScopeState("scope_household_default", 1, 0);

    const claim = createMemoryClaim({
      claim_id: "claim_late_write",
      predicate: "object_last_seen",
      object: { target: "keys", location: "桌上" },
      status: "inferred",
      source_kind: "camera_frame",
      evidence_ids: ["ev_late"],
      derivation_roots: ["root_late"],
    });

    // 1. Advance deletion generation (simulating user deleted source while worker was processing)
    ledger.setScopeState("scope_household_default", 1, 2);

    // Job finishes with old deletion_generation 0
    await assert.rejects(
      async () => {
        await ledger.commitDerivedWrite(claim, {
          scope_id: "scope_household_default",
          capture_epoch: 1,
          deletion_generation: 0,
        });
      },
      (err: any) => err instanceof LateWritebackRejectedError && err.message.includes("deletion generation 0 < current 2")
    );

    // 2. Advance capture epoch (simulating user toggled privacy pause during inference)
    ledger.setScopeState("scope_household_default", 3, 2);

    // Job finishes with old capture_epoch 1
    await assert.rejects(
      async () => {
        await ledger.commitDerivedWrite(claim, {
          scope_id: "scope_household_default",
          capture_epoch: 1,
          deletion_generation: 2,
        });
      },
      (err: any) => err instanceof LateWritebackRejectedError && err.message.includes("capture epoch 1 < current 3")
    );
  });
});
