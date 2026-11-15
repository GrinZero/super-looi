/**
 * Phone Agent protocol PROPOSAL v0.2 / 2026-11-02.
 * These are proposed PROJECT contracts, NOT existing upstream APIs from
 * DeepSeek Harness, dsh-Go, super-looi, Home Assistant, or Screenpipe.
 * Design-review types only. This is NOT a runnable product, network client,
 * permission implementation, BLE driver, or production SDK.
 * Screenpipe is an internal-mechanism research reference only, not a runtime,
 * API/MCP connector, desktop recorder, or storage dependency of this proposal.
 *
 * Runtime implementations must validate schemas, authentication, ACL revisions,
 * deadlines, calibration, revocations, and idempotency before side effects.
 * TypeScript types do not establish identity or enforce any of those checks.
 * IDs below are opaque references, never bearer credentials or raw media URLs.
 *
 * Source of design: drafts/technical.md and drafts/prd.md, with review corrections:
 * - event identity is (source_id, boot_epoch, sequence); hash checks consistency;
 * - capture epochs and deletion generations are separate;
 * - stopping a capture scope does not revoke unrelated work grants;
 * - BLE write/stop submission is not evidence of mechanical completion;
 * - a fresh already-satisfied state can produce a verified noop;
 * - audio and camera have distinct evidence roots even in the same episode.
 */

export type Timestamp = string; // RFC 3339; receivers validate, preserve source time.
export type Id = string;
export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export interface JsonObject { [key: string]: JsonValue }
export type SourceKind =
  | "camera_frame" | "audio_segment" | "asr_transcript" | "vision_description"
  | "app_context" | "home_state" | "authenticated_user_statement"
  | "self_event" | "runner_event";
export type Sensitivity = "ordinary" | "personal" | "sensitive";

export interface AclScope {
  household_id: Id;
  subject_id: Id | null; // Unknown people remain null; do not substitute owner.
  project_id: Id | null;
  audience: "subject_private" | "household" | "project";
  acl_policy_id: Id;
  acl_policy_revision: number;
}

export interface EpochBinding {
  scope_id: Id;
  capture_epoch: number | null;
  deletion_generation: number;
}

/** Root identifies original evidence. Derived ASR/summary shares the audio root;
 * a simultaneous camera frame has a DIFFERENT root. Episode ID groups them,
 * but neither shared episode nor distinct roots proves statistical independence. */
export interface EvidenceIdentity {
  evidence_id: Id;
  revision: number;
  source_event_id: Id;
  derivation_root_id: Id;
  episode_id: Id | null;
  media_type: string;
  captured_at: Timestamp;
}
export type EvidenceRef = EvidenceIdentity & (
  | { availability: "retained"; object_ref: Id; expires_at: Timestamp | null }
  | { availability: "expired" | "deleted"; object_ref: null; expires_at: Timestamp | null }
);

export interface RetentionPolicy {
  policy_id: Id;
  revision: number;
  expires_at: Timestamp | null;
  raw_expiry_behavior: "delete_raw_keep_separately_authorized_summary" | "cascade";
  // Explicit user deletion follows the deletion request, not this expiry rule.
}

export interface EventEnvelope<T = JsonObject> {
  schema_version: "0.2-proposal";
  event_id: Id;
  household_id: Id;
  subject_id: Id | null;
  source_id: Id; // Stable logical stream, e.g. paired-phone/front-camera.
  source_device_id: Id;
  boot_epoch: Id; // Source boot/session generation; sequence resets only with this.
  sequence: number; // Non-negative safe integer, increasing within this boot_epoch.
  content_hash: string; // SHA-256 of canonical immutable source body, not a unique key.
  // Same identity + same hash is a duplicate. Same identity + different hash is
  // a consistency error, not a new event. received_at is excluded from the hash.
  observed_at: Timestamp;
  monotonic_ms: number;
  monotonic_clock: "android_elapsed_realtime" | "source_monotonic";
  received_at: Timestamp;
  time_uncertainty_ms: number | null;
  source_kind: SourceKind;
  evidence_refs: EvidenceRef[];
  derivation_roots: Id[];
  caused_by_action_id: Id | null;
  parser_version: string;
  privacy_scope: AclScope;
  epoch_binding: EpochBinding;
  retention_policy: RetentionPolicy;
  payload: T; // Always observation data; never an authority-bearing instruction.
}

export interface ClaimRevisionRef { claim_id: Id; revision: number }
export type ClaimStatus = "candidate" | "inferred" | "confirmed" | "superseded" | "retracted";
export interface MemoryClaim {
  schema_version: "0.2-proposal";
  claim_id: Id;
  revision: number;
  household_id: Id;
  subject_id: Id | null;
  project_id: Id | null;
  predicate: string; // e.g. object_last_seen, lighting_preference; registry-owned.
  object: JsonValue;
  status: ClaimStatus;
  source_kind: SourceKind;
  evidence_ids: Id[];
  derivation_roots: Id[];
  parent_claim_revisions: ClaimRevisionRef[];
  confidence: number | null; // 0..1, evidence ranking only; never an action grant.
  valid_from: Timestamp;
  valid_to: Timestamp | null; // Real-world validity, separate from system time.
  recorded_at: Timestamp;
  revised_at: Timestamp;
  expires_at: Timestamp | null;
  supersedes: ClaimRevisionRef | null;
  revision_reason: "initial" | "user_correction" | "world_changed" | "attribution_fix" | "source_deleted";
  confirmed_by_user_event_id: Id | null;
  source_availability: "retained" | "partially_expired" | "source_expired";
  sensitivity: Sensitivity;
  acl_policy_id: Id;
  acl_policy_revision: number;
  privacy_scope: AclScope;
  deletion_generation: number;
  suppression_key: Id | null; // Optional reinference suppression after correction/forget.
}

export interface ContextPackManifest {
  schema_version: "0.2-proposal";
  context_pack_id: Id;
  revision: number;
  task_id: Id | null;
  consumer_session_id: Id;
  authorized_principal_id: Id;
  authorization_ref: Id;
  scope: AclScope;
  source_allowlist: Id[];
  observed_time_range: { from: Timestamp; to: Timestamp };
  claim_refs: ClaimRevisionRef[];
  evidence_refs: EvidenceRef[];
  explicit_user_event_ids: Id[];
  working_state_refs: Id[];
  derivation_roots: Id[];
  epoch_bindings: EpochBinding[];
  created_at: Timestamp;
  expires_at: Timestamp;
  acl_checked_at: Timestamp;
  instruction_trust: "untrusted_context_data";
  status: "active" | "invalidated" | "expired";
  invalidated_at: Timestamp | null;
  invalidation_reason: "source_deleted" | "acl_revoked" | "claim_revised" | "expired" | null;
  // Log actual copies so a later deletion can invalidate/clean consumer sessions.
  exported_copies: { destination_id: Id; copy_ref: Id; created_at: Timestamp; deletion_state: "present" | "pending" | "removed" | "unavailable" }[];
  // ACL/tombstones must be rechecked before model delivery. An older capture_epoch
  // is historical provenance, not by itself a reason to delete authorized history.
}

export type BodyPrimitive = "head_up" | "head_center" | "head_down" | "turn_left" | "turn_right" | "forward" | "backward";
export interface CalibrationRef { profile_id: Id; revision: number }
export interface ObservationRequest {
  schema_version: "0.2-proposal";
  observation_id: Id;
  task_id: Id | null;
  context_pack_id: Id;
  question: string;
  target_description: string;
  missing_fields: string[];
  reason_evidence_ids: Id[];
  already_seen_view_ids: Id[];
  allowed_region_ids: Id[];
  allowed_primitives: BodyPrimitive[];
  calibration_ref: CalibrationRef;
  budget: { max_attempts: number; max_vlm_calls: number; max_total_motion_ms: number; max_elapsed_ms: number };
  settling: {
    strategy: "calibrated_wait_plus_stability" | "telemetry_motion_end_plus_stability";
    min_wait_ms: number; // A calibrated minimum, not a promised mechanical stop time.
    stability_sources: ("image" | "imu")[];
    max_frame_age_ms: number;
  };
  grant_id: Id;
  body_session_epoch: Id;
  requested_at: Timestamp;
  expires_at: Timestamp;
  announce_before_motion: boolean;
  stop_conditions: ("no_information_gain" | "budget_exhausted" | "user_interrupt" | "not_ready" | "lease_expired")[];
}

/** Produced by the native BodySupervisor after authorization and calibration.
 * Do not expose raw BLE bytes, claimed degrees, metres, or m/s to the planner. */
export interface CalibratedBodyPulse {
  primitive: BodyPrimitive;
  calibration_ref: CalibrationRef;
  pulse_ms: number; // Positive integer; clamp to the validated primitive's bound.
  lease_id: Id;
  lease_epoch: number;
  body_session_epoch: Id;
  exclusive_owner_id: Id;
  // Executor derives a local monotonic deadline; a remote wall clock cannot
  // extend the local lease. Reconnect never replays or resumes this command.
}

export interface UserActionRef {
  event_id: Id;
  ui_session_id: Id;
  kind: "tap" | "gesture" | "voice_command";
  captured_at: Timestamp;
  expires_at: Timestamp;
  // Resolve against the trusted input router, not LLM-provided JSON assertions.
}
export type GrantTrigger =
  | { kind: "explicit_user_action"; user_action: UserActionRef }
  | { kind: "authorized_rule"; rule_id: Id; rule_revision: number; trigger_event_id: Id };
export type ParameterBound =
  | { kind: "number_range"; min: number; max: number }
  | { kind: "enum"; values: (string | number | boolean)[] }
  | { kind: "exact"; value: JsonValue };

export interface ActionGrant {
  schema_version: "0.2-proposal";
  grant_id: Id;
  revision: number;
  task_id: Id | null;
  issued_by_principal_id: Id;
  executor_id: Id;
  trigger: GrantTrigger;
  scope: AclScope;
  rules: {
    capability_id: Id;
    operations: string[];
    target_ids: Id[]; // Explicit allowlist; wildcard expansion is not implicit.
    parameter_bounds: Record<string, ParameterBound>;
    required_calibration: CalibrationRef | null;
  }[];
  affected_scope_ids: Id[];
  epoch_bindings: EpochBinding[];
  not_before: Timestamp;
  expires_at: Timestamp;
  max_uses: number;
  status: "active" | "revoked" | "expired";
  revoked_at: Timestamp | null;
  // Authority resolves this reference in its own grant ledger. Sending this
  // object does not mint permission; secrets/signatures are outside this draft.
}

export interface ActionRequestBase {
  schema_version: "0.2-proposal";
  action_id: Id;
  task_id: Id | null;
  capability_id: Id;
  capability_revision: number;
  target_id: Id;
  grant_id: Id;
  grant_revision: number;
  reason_evidence_ids: Id[];
  expected_state_version: string | null;
  requested_at: Timestamp;
  expires_at: Timestamp;
  idempotency_key: string | null;
}
export type ActionRequest = ActionRequestBase & (
  | { operation: "home.set_state"; args: { desired_state: JsonObject }; replay_policy: "never" | "readback_then_bounded_retry" }
  | { operation: "body.pulse"; args: CalibratedBodyPulse; replay_policy: "never" }
  | { operation: "work.execute"; args: { workspace_id: Id; approved_operation_ref: Id; change_preview_ref: Id | null }; replay_policy: "never" }
  | { operation: "app.invoke"; args: { app_id: Id; operation_ref: Id; parameters: JsonObject }; replay_policy: "never" }
);

export interface ReadbackEvidence {
  kind: "device_state" | "runner_exit" | "artifact_probe" | "stable_frame" | "mechanical_stop_telemetry";
  evidence_ids: Id[];
  observed_at: Timestamp;
  received_at: Timestamp;
  state_version: string | null;
  value: JsonObject;
}
export interface MotionObservation {
  stop_command_at: Timestamp | null;
  verified_motion_end_at: Timestamp | null; // Non-null only with actual motion-end evidence.
  calibration_ref: CalibrationRef | null;
  stable_capture_at: Timestamp | null;
  stability_evidence_ids: Id[];
  // Without stop telemetry, calibrated settling + image/IMU stability can qualify
  // a new frame. It does not prove a precise pose or hardware fail-safe behavior.
}
export interface ActionReceiptBase {
  schema_version: "0.2-proposal";
  receipt_id: Id;
  action_id: Id;
  task_id: Id | null;
  receipt_seq: number;
  executor_id: Id;
  executor_boot_epoch: Id;
  recorded_at: Timestamp;
  submission: "not_submitted" | "submitted" | "uncertain";
  effect_outcome: "none" | "applied" | "partial" | "unknown";
  readbacks: ReadbackEvidence[];
  motion: MotionObservation | null;
}
export type ActionReceipt = ActionReceiptBase & (
  | { status: "accepted" | "sent" | "observed"; reason_code: string | null; resolution: null }
  | { status: "verified"; reason_code: null; resolution: {
      kind: "executed" | "noop";
      verification_contract_id: Id;
      verification_contract_revision: number;
      verified_at: Timestamp;
      evidence_ids: Id[];
    } }
  | { status: "rejected" | "failed" | "unverified" | "unknown"; reason_code: string; resolution: null }
);
// rejected: known pre-execution refusal. failed: observed execution/verification
// failure (partial effects possible). unverified: submitted, insufficient success
// evidence. unknown: submission or effects cannot be determined. A verified noop
// requires a fresh authorized readback already satisfying the requested state;
// it has submission=not_submitted and effect_outcome=none. BLE write != verified.

export interface TaskRequest {
  schema_version: "0.2-proposal";
  task_id: Id;
  client_request_id: Id; // Submission dedupe, distinct from action key/event cursor.
  requested_by_principal_id: Id;
  user_action: UserActionRef;
  intent: string;
  scope: AclScope;
  workspace_id: Id | null;
  executor_id: Id;
  context_pack_id: Id;
  context_pack_revision: number;
  grant_ids: Id[];
  requested_at: Timestamp;
  deadline_at: Timestamp;
  allow_new_environment_input: boolean;
}
export type TaskState = "queued" | "running" | "awaiting_approval" | "cancelling" | "succeeded" | "failed" | "cancelled" | "unknown";
export type CancellationState =
  | { phase: "not_requested" }
  | { phase: "pending" | "unknown"; request_id: Id; requested_at: Timestamp; grants_revoked_at: Timestamp | null; stop_sent_at: Timestamp | null }
  | { phase: "confirmed"; request_id: Id; requested_at: Timestamp; confirmed_at: Timestamp; termination_evidence_ids: Id[] }
  | { phase: "too_late"; request_id: Id; requested_at: Timestamp; completion_evidence_ids: Id[] };
export interface TaskEvent {
  schema_version: "0.2-proposal";
  task_id: Id;
  event_seq: number; // Durable per-task monotonic order, independent of executor boots.
  event_id: Id;
  resume_cursor: string; // Opaque observation cursor; never an idempotency key.
  recorded_at: Timestamp;
  state: TaskState;
  step_id: Id | null;
  summary: string;
  action_receipt_ids: Id[];
  artifact_refs: { artifact_id: Id; verified_at: Timestamp; evidence_ids: Id[] }[];
  cancellation: CancellationState;
  uncertainty_reason: "transport_lost" | "stop_unconfirmed" | "execution_outcome_unknown" | null;
  // cancelled requires confirmed termination evidence. A late cancel may return
  // succeeded + too_late. Timeout alone never transitions to cancelled/succeeded.
}

export interface CapabilityRegistration {
  schema_version: "0.2-proposal";
  capability_id: Id;
  revision: number;
  executor_id: Id;
  source_device_id: Id;
  executor_boot_epoch: Id;
  operations: string[];
  input_schema: JsonObject; // Versioned JSON Schema, validated by the registry.
  implementation: "implemented" | "declared_only";
  availability: "ready" | "degraded" | "unavailable";
  unavailable_reason: string | null;
  last_validated_at: Timestamp | null;
  valid_until: Timestamp;
  supported_targets: Id[];
  calibrated_body_primitives: { primitive: BodyPrimitive; calibration_ref: CalibrationRef; max_pulse_ms: number; validated_at: Timestamp }[];
  completion_contract: {
    contract_id: Id;
    revision: number;
    criteria: ("fresh_device_readback_matches" | "runner_exit_zero_and_artifact_exists" | "fresh_stable_frame_available")[];
    readback_max_age_ms: number;
    supports_noop: boolean;
  };
  cancellation_support: "local_preempt" | "verified_remote_termination" | "request_only" | "unsupported";
  replay_policy: "never" | "readback_then_bounded_retry";
  known_limits: string[];
  // declared_only or expired registrations must never be discoverable as ready.
}

export interface PrivacyEpoch {
  scope_id: Id;
  household_id: Id;
  capture_epoch: number;
  deletion_generation: number;
  capture_mode: "off" | "foreground_explicit" | "docked_context";
  camera: "on" | "off";
  microphone: "on" | "off";
  background_processing: boolean;
  retention_policy_id: Id;
  changed_at: Timestamp;
  changed_by_principal_id: Id;
  local_buffer_state: "cleared" | "clearing" | "not_applicable";
}
export interface PrivacyChange {
  schema_version: "0.2-proposal";
  change_id: Id;
  reason: "pause_capture" | "resume_capture" | "scope_changed" | "delete";
  affected_scopes: {
    scope_id: Id;
    previous_capture_epoch: number;
    previous_deletion_generation: number;
    current: PrivacyEpoch;
    invalidates: ("new_capture" | "pending_derivation_writes" | "referencing_context_packs" | "scope_bound_grants")[];
  }[];
  tombstone_ids: Id[];
  changed_at: Timestamp;
  // Pause increments capture_epoch, not deletion_generation. Deletion advances
  // deletion_generation and writes tombstones. Only overlapping grants/scopes
  // are invalidated; unrelated work grants may remain active without new capture.
}

export interface BodyStopRequest {
  schema_version: "0.2-proposal";
  local_stop_id: Id;
  body_session_epoch: Id;
  revoke_through_lease_epoch: number;
  reason: "user_stop" | "lease_expired" | "undocked" | "disconnected" | "privacy_pause" | "fault";
  requested_monotonic_ms: number;
  // Native high-priority path. Do not wait for hub/model/network/ordinary grants.
}

export interface UiNavigateRequest {
  schema_version: "0.2-proposal";
  navigation_id: Id;
  destination: "companion" | "drawer" | "memory" | "memory_detail" | "tasks" | "task_detail" | "home" | "connections" | "privacy" | "setup";
  target_id: Id | null;
  originating_user_event: UserActionRef;
  issued_by: "trusted_input_router";
  // Router verifies current UI session, event purpose and expiry; task completion,
  // ambient observations and model output may suggest a page but cannot navigate.
}

/** Typed shape for the adjacent all-fictional protocol_examples.json. */
export interface ProtocolExamples {
  schema_version: "0.2-proposal";
  is_mock: true;
  notice: string;
  events: EventEnvelope[];
  memory_claim: MemoryClaim;
  context_pack: ContextPackManifest;
  observation_request: ObservationRequest;
  action_grants: ActionGrant[];
  action_requests: ActionRequest[];
  action_receipts: ActionReceipt[];
  task_request: TaskRequest;
  task_events: TaskEvent[];
  capability_registrations: CapabilityRegistration[];
  privacy_epoch: PrivacyEpoch;
  privacy_change: PrivacyChange;
  body_stop: BodyStopRequest;
  ui_navigation: UiNavigateRequest;
}
