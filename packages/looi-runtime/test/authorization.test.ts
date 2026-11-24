import test from "node:test";
import assert from "node:assert/strict";
import { assertFreshUiAction } from "../src/agent/governance/authorization.js";
import { ApprovalActionReplayGuard } from "../src/agent/governance/interaction-gate.js";

test("ApprovalActionReplayGuard rejects replay, missing action, and cross-session actions", () => {
  const guard = new ApprovalActionReplayGuard("ui_a");
  const now = Date.now();
  const makeAction = (eventId: string, uiSessionId = "ui_a") => ({
    event_id: eventId,
    ui_session_id: uiSessionId,
    kind: "tap" as const,
    captured_at: new Date(now).toISOString(),
    expires_at: new Date(now + 10_000).toISOString(),
  });

  assert.throws(() => guard.verifyAndConsume(undefined), /fresh explicit UI action/);

  const first = makeAction("tap_a");
  assert.doesNotThrow(() => guard.verifyAndConsume(first));
  assert.throws(() => guard.verifyAndConsume(first), /already consumed/);

  assert.throws(
    () => guard.verifyAndConsume(makeAction("tap_b", "ui_other")),
    /different UI session/,
  );
});

test("approval references require bounded scalar identities and timestamps", () => {
  const now = Date.now();
  const action = {
    event_id: "tap_a",
    ui_session_id: "ui_a",
    kind: "tap" as const,
    captured_at: new Date(now).toISOString(),
    expires_at: new Date(now + 10_000).toISOString(),
  };
  assert.doesNotThrow(() => assertFreshUiAction(action));
  assert.throws(() =>
    assertFreshUiAction({ ...action, kind: "voice_command" as unknown as typeof action.kind }, now),
  );
  assert.throws(() =>
    assertFreshUiAction({ ...action, expires_at: new Date(now - 1).toISOString() }, now),
  );
  for (const event_id of [{}, [], 1, "", " ", "a".repeat(513)]) {
    assert.throws(() =>
      assertFreshUiAction({ ...action, event_id: event_id as string }),
    );
  }
  assert.throws(() =>
    assertFreshUiAction({ ...action, captured_at: now as unknown as string }),
  );
});
