import type { UserActionRef } from "@super-looi/contracts";

/** High-risk task approvals require a recent local UI action. Speech alone has
 * no authenticated speaker proof in UserActionRef, so cannot approve a task. */
export function assertFreshUiAction(
  action: UserActionRef,
  now = Date.now(),
): void {
  const validId = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0 && value.length <= 512;
  if (
    !action ||
    !["tap", "gesture"].includes(action.kind) ||
    !validId(action.event_id) ||
    !validId(action.ui_session_id) ||
    typeof action.captured_at !== "string" ||
    typeof action.expires_at !== "string"
  )
    throw new Error("A fresh explicit UI action is required");
  const captured = Date.parse(action.captured_at),
    expires = Date.parse(action.expires_at);
  if (
    !Number.isFinite(captured) ||
    !Number.isFinite(expires) ||
    captured > now + 1000 ||
    captured < now - 30_000 ||
    expires <= now ||
    expires <= captured
  )
    throw new Error("User approval has expired or has invalid timestamps");
}
