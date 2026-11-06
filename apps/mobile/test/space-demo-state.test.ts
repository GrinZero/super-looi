import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { correctDemoMemory, createDemoArtifactReadback, createDemoMemoryClaims, createDemoTaskEvent, removeDemoMemoryItem, requestDemoTaskCancellation, resolveDemoTaskCancellation } from "../src/ui/spaces/space-demo-state.js";

const now = "2026-11-04T12:00:00.000Z";
describe("local conformal space demonstrations preserve evidence boundaries", () => {
  it("correction promotes a new revision without fabricating retained source evidence", () => {
    const expired = createDemoMemoryClaims(Date.parse(now)).find((claim) => claim.source_availability === "source_expired")!;
    const corrected = correctDemoMemory(expired, "显示器右侧", now);
    assert.equal(corrected.status, "confirmed");
    assert.equal(corrected.revision, expired.revision + 1);
    assert.deepEqual(corrected.supersedes, { claim_id: expired.claim_id, revision: expired.revision });
    assert.equal(corrected.source_kind, "authenticated_user_statement");
    assert.equal(corrected.source_availability, "source_expired");
    assert.deepEqual(corrected.evidence_ids, []);
    assert.ok(corrected.confirmed_by_user_event_id);
    assert.equal(expired.status, "inferred");
  });

  it("item removal closes the old location validity with a retained revision trail", () => {
    const claim = createDemoMemoryClaims(Date.parse(now))[0]!;
    const removed = removeDemoMemoryItem(claim, now);
    assert.equal(removed.status, "retracted");
    assert.equal(removed.valid_to, now);
    assert.equal(removed.revision_reason, "world_changed");
    assert.equal(removed.revision, claim.revision + 1);
  });

  it("cancellation stays pending until explicit simulated runner-exit evidence", () => {
    const initial = createDemoTaskEvent(now);
    const pending = requestDemoTaskCancellation(initial, now);
    assert.equal(pending.state, "cancelling");
    assert.equal(pending.cancellation.phase, "pending");
    assert.equal(pending.event_seq, initial.event_seq + 1);
    const confirmed = resolveDemoTaskCancellation(pending, "cancelled", now);
    assert.equal(confirmed.state, "cancelled");
    assert.equal(confirmed.cancellation.phase, "confirmed");
    if (confirmed.cancellation.phase === "confirmed") assert.deepEqual(confirmed.cancellation.termination_evidence_ids, ["demo_runner_exit_0"]);
    assert.equal(confirmed.artifact_refs.length, 0);
    assert.equal(resolveDemoTaskCancellation(initial, "cancelled", now), initial);
  });

  it("transport loss is unknown and cannot fabricate termination or success evidence", () => {
    const pending = requestDemoTaskCancellation(createDemoTaskEvent(now), now);
    const unknown = resolveDemoTaskCancellation(pending, "unknown", now);
    assert.equal(unknown.state, "unknown");
    assert.equal(unknown.cancellation.phase, "unknown");
    assert.equal(unknown.uncertainty_reason, "transport_lost");
    assert.equal("termination_evidence_ids" in unknown.cancellation, false);
    assert.deepEqual(unknown.artifact_refs, []);
    const retry = requestDemoTaskCancellation(unknown, now);
    assert.equal(retry.state, "cancelling");
  });

  it("readback fixture is explicitly simulated and independently carries probe evidence", () => {
    const readback = createDemoArtifactReadback(now);
    assert.equal(readback.kind, "artifact_probe");
    assert.equal(readback.value.simulation, true);
    assert.equal(readback.value.exists, true);
    assert.equal(readback.evidence_ids.length, 1);
    assert.equal(readback.observed_at, now);
  });
});
