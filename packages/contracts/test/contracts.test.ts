import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isActionReceiptVerified,
  isTaskTerminated,
  createBodyStopRequest,
  createSelfEventWindow,
  createMemoryClaim,
  type ActionReceipt,
  type TaskStatus,
} from "../src/index.js";

describe("Contracts Type Guards and Helpers", () => {
  it("verifies action receipts correctly", () => {
    const verifiedReceipt: ActionReceipt = {
      schema_version: "0.2",
      receipt_id: "rec_1",
      action_id: "act_1",
      task_id: null,
      receipt_seq: 1,
      executor_id: "ha_executor",
      recorded_at: new Date().toISOString(),
      status: "verified",
      outcome: "applied",
      readbacks: [],
    };

    const unverifiedReceipt: ActionReceipt = {
      schema_version: "0.2",
      receipt_id: "rec_2",
      action_id: "act_2",
      task_id: null,
      receipt_seq: 2,
      executor_id: "ha_executor",
      recorded_at: new Date().toISOString(),
      status: "unverified",
      reason_code: "TIMEOUT",
      readbacks: [],
    };

    assert.equal(isActionReceiptVerified(verifiedReceipt), true);
    assert.equal(isActionReceiptVerified(unverifiedReceipt), false);
  });

  it("checks task termination status accurately", () => {
    const terminatedStates: TaskStatus[] = ["succeeded", "failed", "cancelled"];
    const activeStates: TaskStatus[] = ["queued", "running", "awaiting_approval", "cancelling", "unknown"];

    for (const state of terminatedStates) {
      assert.equal(isTaskTerminated(state), true, `State ${state} should be terminated`);
    }

    for (const state of activeStates) {
      assert.equal(isTaskTerminated(state), false, `State ${state} should not be terminated`);
    }
  });

  it("creates valid BodyStopRequest with high-priority reason", () => {
    const stopReq = createBodyStopRequest("sess_101", 3, "undocked");

    assert.equal(stopReq.schema_version, "0.2");
    assert.equal(stopReq.body_session_epoch, "sess_101");
    assert.equal(stopReq.revoke_through_lease_epoch, 3);
    assert.equal(stopReq.reason, "undocked");
    assert.ok(stopReq.local_stop_id.startsWith("stop_"));
    assert.ok(stopReq.requested_monotonic_ms > 0);
  });

  it("creates SelfEventWindow to suppress sensor observation during motion/speech", () => {
    const selfWindow = createSelfEventWindow("motor_drive", 350, ["camera", "imu"]);

    assert.equal(selfWindow.cause, "motor_drive");
    assert.equal(selfWindow.estimated_settling_ms, 350);
    assert.deepEqual(selfWindow.suppress_sensors, ["camera", "imu"]);
    assert.ok(selfWindow.window_id.startsWith("self_"));
  });

  it("creates well-formed MemoryClaim with evidence roots", () => {
    const claim = createMemoryClaim({
      claim_id: "claim_desk_keys",
      predicate: "object_last_seen",
      object: { object: "keys", location: "desk" },
      status: "confirmed",
      source_kind: "camera_frame",
      evidence_ids: ["ev_frame_9921"],
      derivation_roots: ["root_frame_9921"],
    });

    assert.equal(claim.schema_version, "0.2");
    assert.equal(claim.claim_id, "claim_desk_keys");
    assert.equal(claim.status, "confirmed");
    assert.equal(claim.predicate, "object_last_seen");
    assert.deepEqual(claim.evidence_ids, ["ev_frame_9921"]);
    assert.deepEqual(claim.derivation_roots, ["root_frame_9921"]);
    assert.equal(claim.valid_to, null);
  });
});
