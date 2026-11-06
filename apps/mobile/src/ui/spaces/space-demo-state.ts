import { createMemoryClaim, type MemoryClaim, type ReadbackEvidence, type TaskEvent } from "@super-looi/contracts";

/** Local fixtures only. No fixture is a receipt from a connected camera or runner. */
export function createDemoMemoryClaims(nowMs = Date.now()): MemoryClaim[] {
  return [
    { id: "keys", target: "钥匙", location: "书桌键盘左侧", status: "confirmed", minutes: 20, source: "authenticated_user_statement", expired: false },
    { id: "earbuds", target: "耳机盒", location: "显示器右侧", status: "observed", minutes: 45, source: "camera_frame", expired: false },
    { id: "cup", target: "保温杯", location: "书架第二层", status: "inferred", minutes: 120, source: "camera_frame", expired: true },
    { id: "notebook", target: "充电线", location: "右侧抽屉里", status: "observed", minutes: 180, source: "camera_frame", expired: true },
  ].map((item) => createMemoryClaim({
    claim_id: `demo_memory_${item.id}`,
    predicate: "object_last_seen",
    object: { target: item.target, location: item.location },
    status: item.status as MemoryClaim["status"],
    source_kind: item.source as MemoryClaim["source_kind"],
    evidence_ids: item.expired ? [] : [`demo_evidence_${item.id}`],
    derivation_roots: [`demo_root_${item.id}`],
    observed_at: new Date(nowMs - item.minutes * 60_000).toISOString(),
    source_availability: item.expired ? "source_expired" : "retained",
    confirmed_by_user_event_id: item.status === "confirmed" ? "demo_user_confirmation" : null,
  }));
}

export function correctDemoMemory(claim: MemoryClaim, location: string, now = new Date().toISOString()): MemoryClaim {
  if (!location.trim()) return claim;
  const object = typeof claim.object === "object" && claim.object !== null && !Array.isArray(claim.object) ? claim.object : {};
  return {
    ...claim,
    object: { ...object, location: location.trim() },
    status: "confirmed",
    revision: claim.revision + 1,
    supersedes: { claim_id: claim.claim_id, revision: claim.revision },
    revision_reason: "user_correction",
    source_kind: "authenticated_user_statement",
    confirmed_by_user_event_id: `demo_location_confirmation_${claim.revision + 1}`,
    observed_at: now,
    valid_from: now,
    valid_to: null,
    revised_at: now,
  };
}

export function removeDemoMemoryItem(claim: MemoryClaim, now = new Date().toISOString()): MemoryClaim {
  return {
    ...claim,
    status: "retracted",
    revision: claim.revision + 1,
    supersedes: { claim_id: claim.claim_id, revision: claim.revision },
    revision_reason: "world_changed",
    valid_to: now,
    revised_at: now,
  };
}

export function createDemoTaskEvent(now = new Date().toISOString()): TaskEvent {
  return {
    schema_version: "0.2", task_id: "demo_task_stairs", event_seq: 7,
    event_id: "demo_task_event_7", recorded_at: now,
    state: "awaiting_approval", summary: "修复楼梯碰撞并准备远程分支更新",
    action_receipt_ids: [], artifact_refs: [],
    cancellation: { phase: "not_requested" }, uncertainty_reason: null,
  };
}

export function requestDemoTaskCancellation(event: TaskEvent, now = new Date().toISOString()): TaskEvent {
  if (!["running", "awaiting_approval", "unknown"].includes(event.state)) return event;
  return {
    ...event, event_seq: event.event_seq + 1, event_id: `demo_task_event_${event.event_seq + 1}`,
    state: "cancelling", summary: "请求取消中... 等待进程退出证据", recorded_at: now,
    cancellation: { phase: "pending", request_id: `demo_cancel_${event.event_seq + 1}`, requested_at: now, stop_sent_at: now },
    uncertainty_reason: null,
  };
}

export function resolveDemoTaskCancellation(event: TaskEvent, outcome: "cancelled" | "unknown", now = new Date().toISOString()): TaskEvent {
  if (event.state !== "cancelling" || event.cancellation.phase !== "pending") return event;
  const cancellation = event.cancellation;
  return {
    ...event, event_seq: event.event_seq + 1, event_id: `demo_task_event_${event.event_seq + 1}`,
    recorded_at: now, state: outcome,
    summary: outcome === "cancelled" ? "已确认进程退出 (cancelled)" : "连接中断 结果待核实 (unknown)",
    cancellation: outcome === "cancelled"
      ? { phase: "confirmed", request_id: cancellation.request_id, requested_at: cancellation.requested_at, confirmed_at: now, termination_evidence_ids: ["demo_runner_exit_0"] }
      : { ...cancellation, phase: "unknown" },
    uncertainty_reason: outcome === "unknown" ? "transport_lost" : null,
  };
}

export function createDemoArtifactReadback(now = new Date().toISOString()): ReadbackEvidence {
  return {
    kind: "artifact_probe", evidence_ids: ["demo_probe_report_1"], observed_at: now, received_at: now,
    state_version: "demo_revision_1",
    value: { path: "reports/collision-review.md", bytes: 1482, exists: true, simulation: true },
  };
}
