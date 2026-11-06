/**
 * @super-looi/contracts
 * Pure TypeScript contract definitions and type guards for the Super-LOOI architecture.
 */

export type Timestamp = string; // RFC 3339 formatted ISO string
export type Id = string;
export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export interface JsonObject { [key: string]: JsonValue }

/* ========================================================================== */
/* 1. Context & Evidence Contracts                                            */
/* ========================================================================== */

export type SourceKind =
  | "camera_frame"
  | "audio_segment"
  | "asr_transcript"
  | "vision_description"
  | "app_context"
  | "home_state"
  | "authenticated_user_statement"
  | "self_event"
  | "runner_event";

export type Sensitivity = "ordinary" | "personal" | "sensitive";

export interface AclScope {
  household_id: Id;
  subject_id: Id | null;
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
}

export interface EventEnvelope<T = JsonObject> {
  schema_version: "0.2";
  event_id: Id;
  household_id: Id;
  subject_id: Id | null;
  source_id: Id;
  source_device_id: Id;
  boot_epoch: Id;
  sequence: number;
  content_hash: string;
  observed_at: Timestamp;
  monotonic_ms: number;
  monotonic_clock: "android_elapsed_realtime" | "source_monotonic" | "system";
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
  payload: T;
}

export interface Episode {
  episode_id: Id;
  started_at: Timestamp;
  ended_at: Timestamp | null;
  trigger_source_kind: SourceKind;
  evidence_root_ids: Id[];
  summary: string | null;
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

export interface DeletionTombstone {
  schema_version: "0.2";
  tombstone_id: Id;
  scope_id: Id;
  deletion_generation: number;
  target_evidence_ids: Id[];
  target_derivation_roots: Id[];
  target_claim_ids: Id[];
  created_at: Timestamp;
}

export class LateWritebackRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LateWritebackRejectedError";
  }
}

export interface PrivacyChange {
  schema_version: "0.2";
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
}

/* ========================================================================== */
/* 2. Memory Ledger Contracts                                                 */
/* ========================================================================== */

export type ClaimStatus = "candidate" | "inferred" | "observed" | "confirmed" | "superseded" | "retracted";

export interface ClaimRevisionRef {
  claim_id: Id;
  revision: number;
}

export interface MemoryClaim {
  schema_version: "0.2";
  claim_id: Id;
  revision: number;
  household_id: Id;
  subject_id: Id | null;
  project_id: Id | null;
  predicate: string;
  object: JsonValue;
  status: ClaimStatus;
  source_kind: SourceKind;
  evidence_ids: Id[];
  derivation_roots: Id[];
  parent_claim_revisions: ClaimRevisionRef[];
  confidence: number | null; // 0..1 ranking
  observed_at: Timestamp;
  valid_from: Timestamp;
  valid_to: Timestamp | null;
  recorded_at: Timestamp;
  revised_at: Timestamp;
  expires_at: Timestamp | null;
  supersedes: ClaimRevisionRef | null;
  revision_reason: "initial" | "user_correction" | "world_changed" | "attribution_fix" | "source_deleted";
  confirmed_by_user_event_id: Id | null;
  source_availability: "retained" | "partially_expired" | "source_expired";
  sensitivity: Sensitivity;
  deletion_generation: number;
  suppression_key: Id | null;
}

export interface ContextPackManifest {
  schema_version: "0.2";
  context_pack_id: Id;
  revision: number;
  task_id: Id | null;
  consumer_session_id: Id;
  authorized_principal_id: Id;
  scope: AclScope;
  source_allowlist: Id[];
  observed_time_range: { from: Timestamp; to: Timestamp };
  claim_refs: ClaimRevisionRef[];
  evidence_refs: EvidenceRef[];
  derivation_roots: Id[];
  epoch_bindings: EpochBinding[];
  created_at: Timestamp;
  expires_at: Timestamp;
  instruction_trust: "untrusted_context_data";
  status: "active" | "invalidated" | "expired";
  invalidation_reason?: string;
}

export type ContextPack = ContextPackManifest;

/* ========================================================================== */
/* 3. Actions & Receipts Contracts                                            */
/* ========================================================================== */

export interface UserActionRef {
  event_id: Id;
  ui_session_id: Id;
  kind: "tap" | "gesture" | "voice_command";
  captured_at: Timestamp;
  expires_at: Timestamp;
}

export type GrantTrigger =
  | { kind: "explicit_user_action"; user_action: UserActionRef }
  | { kind: "authorized_rule"; rule_id: Id; rule_revision: number; trigger_event_id: Id };

export interface ActionGrant {
  schema_version: "0.2";
  grant_id: Id;
  revision: number;
  task_id: Id | null;
  issued_by_principal_id: Id;
  executor_id: Id;
  trigger: GrantTrigger;
  scope: AclScope;
  not_before: Timestamp;
  expires_at: Timestamp;
  max_uses: number;
  status: "active" | "revoked" | "expired";
  revoked_at: Timestamp | null;
}

export interface ActionRequestBase {
  schema_version: "0.2";
  action_id: Id;
  task_id: Id | null;
  capability_id: Id;
  grant_id: Id;
  grant_revision: number;
  reason_evidence_ids: Id[];
  requested_at: Timestamp;
  expires_at: Timestamp;
  idempotency_key: string | null;
}

export type ActionRequest = ActionRequestBase & (
  | { operation: "home.set_state"; args: { desired_state: JsonObject }; replay_policy: "never" | "readback_then_bounded_retry" }
  | { operation: "body.pulse"; args: CalibratedBodyPulse; replay_policy: "never" }
  | { operation: "work.execute"; args: { workspace_id: Id; command: string }; replay_policy: "never" }
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
  verified_motion_end_at: Timestamp | null;
  stable_capture_at: Timestamp | null;
  stability_evidence_ids: Id[];
}

export type ActionReceiptStatus =
  | "accepted"
  | "sent"
  | "observed"
  | "verified"
  | "rejected"
  | "failed"
  | "unverified"
  | "unknown";

export interface ActionReceipt {
  schema_version: "0.2";
  receipt_id: Id;
  action_id: Id;
  task_id: Id | null;
  receipt_seq: number;
  executor_id: Id;
  recorded_at: Timestamp;
  status: ActionReceiptStatus;
  outcome?: "applied" | "noop" | "partial";
  reason_code?: string | null;
  readbacks: ReadbackEvidence[];
  motion?: MotionObservation | null;
}

/* ========================================================================== */
/* 4. Body & Active Look Contracts                                            */
/* ========================================================================== */

export type BodySupervisorState =
  | "disconnected"
  | "connected_unarmed"
  | "ready"
  | "observing"
  | "manual"
  | "stopping"
  | "fault";

export type BodyPrimitive =
  | "head_up"
  | "head_center"
  | "head_down"
  | "turn_left"
  | "turn_right"
  | "forward"
  | "backward";

export interface BodyActionLease {
  lease_id: Id;
  lease_epoch: number;
  body_session_epoch: Id;
  holder: string;
  primitive: BodyPrimitive;
  duration_ms: number;
  granted_at_ms: number;
  expires_at_ms: number;
}

export interface CalibratedBodyPulse {
  primitive: BodyPrimitive;
  pulse_ms: number;
  lease_id: Id;
  lease_epoch: number;
  body_session_epoch: Id;
}

export interface BodyStopRequest {
  schema_version: "0.2";
  local_stop_id: Id;
  body_session_epoch: Id;
  revoke_through_lease_epoch: number;
  reason: "user_stop" | "lease_expired" | "undocked" | "disconnected" | "privacy_pause" | "fault";
  requested_monotonic_ms: number;
}

export interface SelfEventWindow {
  window_id: Id;
  cause: "motor_drive" | "head_tilt" | "light_pulse" | "tts_playback";
  started_at_ms: number;
  estimated_settling_ms: number;
  suppress_sensors: ("camera" | "microphone" | "imu")[];
}

export interface ObservationRequest {
  schema_version: "0.2";
  observation_id: Id;
  task_id: Id | null;
  question: string;
  target_description: string;
  allowed_primitives: BodyPrimitive[];
  budget: {
    max_attempts: number;
    max_vlm_calls: number;
    max_total_motion_ms: number;
    max_elapsed_ms: number;
  };
  settling_ms: number;
  requested_at: Timestamp;
  expires_at: Timestamp;
}

/* ========================================================================== */
/* 5. Productivity (Phase 3) Contracts                                        */
/* ========================================================================== */

export type TaskStatus =
  | "queued"
  | "running"
  | "awaiting_approval"
  | "cancelling"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "unknown";

export type CancellationState =
  | { phase: "not_requested" }
  | { phase: "pending" | "unknown"; request_id: Id; requested_at: Timestamp; stop_sent_at: Timestamp | null }
  | { phase: "confirmed"; request_id: Id; requested_at: Timestamp; confirmed_at: Timestamp; termination_evidence_ids: Id[] }
  | { phase: "too_late"; request_id: Id; requested_at: Timestamp; completion_evidence_ids: Id[] };

export interface TaskRequest {
  schema_version: "0.2";
  task_id: Id;
  client_request_id: Id;
  requested_by_principal_id: Id;
  intent: string;
  scope: AclScope;
  workspace_id: Id | null;
  executor_id: Id;
  context_pack_id: Id;
  requested_at: Timestamp;
  deadline_at: Timestamp;
}

export interface TaskEvent {
  schema_version: "0.2";
  task_id: Id;
  event_seq: number;
  event_id: Id;
  recorded_at: Timestamp;
  state: TaskStatus;
  summary: string;
  action_receipt_ids: Id[];
  artifact_refs: { artifact_id: Id; verified_at: Timestamp; evidence_ids: Id[] }[];
  cancellation: CancellationState;
  uncertainty_reason: "transport_lost" | "stop_unconfirmed" | "execution_outcome_unknown" | null;
}

/* ========================================================================== */
/* 6. Smart Home (Phase 4) Contracts                                          */
/* ========================================================================== */

export interface HomeEntityCapability {
  entity_id: string; // e.g., "light.study_ceiling"
  friendly_name: string;
  domain: string; // HA can import any device domain; supported_features controls permitted actions.
  supported_features: string[];
  is_whitelisted: boolean;
}

export interface HomeStateSnapshot {
  entity_id: string;
  state: string;
  attributes: JsonObject;
  last_changed: Timestamp;
  last_updated: Timestamp;
}

export interface HomeControlCommand {
  entity_id: string;
  domain: string;
  service: string;
  service_data: JsonObject;
  target_state?: JsonObject;
  timeout_ms?: number;
}

export interface HomeEntityDefinition extends HomeEntityCapability {
  device_id?: string;
  device_name?: string;
  entity_category?: string;
  room?: string;
  allowed_range?: Record<string, [number, number]>;
  max_state_age_ms?: number;
}

export interface HomeRuleProposal {
  proposal_id: Id;
  entity_id: string;
  context_pattern: string;
  suggested_state: JsonObject;
  observed_count: number;
  explanation: string;
  created_at: Timestamp;
}

export interface HomeAutomationRule {
  rule_id: Id;
  entity_id: string;
  condition: string;
  desired_state: JsonObject;
  status: "active" | "revoked";
  created_at: Timestamp;
  confirmed_by_user_event_id: Id;
  revoked_at?: Timestamp | null;
}

/* ========================================================================== */
/* 7. Pluggable Providers (Voice & Vision) Contracts                          */
/* ========================================================================== */

export type VoiceProviderKind = "doubao" | "modular";
export type VisionProviderKind = "cloud" | "lan" | "edge";

export type VoiceUpMessage =
  | { type: "audio_chunk"; pcm_base64: string; sample_rate: number; sequence: number }
  | { type: "mute_commit" }
  | { type: "unmute_commit" }
  | { type: "text_input"; text: string }
  | { type: "speak_text"; text: string }
  | { type: "tool_result"; call_id: string; output: JsonValue }
  | { type: "barge_in" }
  | { type: "session_close" };

export type VoiceDownMessage =
  | { type: "agent_status"; phase: string; tool: string; summary: string; task_id?: string; session_id?: string; interaction?: JsonObject }
  | { type: "session_ready"; session_id: string; provider: VoiceProviderKind }
  | { type: "audio_chunk"; pcm_base64: string; sample_rate: number; sequence: number }
  | { type: "transcript"; text: string; is_final: boolean; role: "user" | "assistant" }
  | { type: "state_change"; state: "idle" | "listening" | "thinking" | "speaking" }
  | { type: "tool_call"; call_id: string; name: string; arguments: JsonObject }
  | { type: "interrupted"; reason?: string }
  | { type: "self_event"; event_window: SelfEventWindow }
  | { type: "error"; code: string; message: string };

export interface VisionAnalyzeRequest {
  request_id: Id;
  image_base64?: string;
  image_url?: string;
  prompt: string;
  mode: "caption" | "detect_objects" | "answer_question";
  max_tokens?: number;
  temperature?: number;
}

export interface VisionAnalyzeResult {
  request_id: Id;
  provider_kind: VisionProviderKind;
  provider_model: string;
  description: string;
  detected_objects?: { label: string; confidence: number; bounding_box?: number[] }[];
  latency_ms: number;
  observed_at: Timestamp;
}

/* ========================================================================== */
/* 8. Helper Functions and Type Guards                                        */
/* ========================================================================== */

export function isActionReceiptVerified(receipt: ActionReceipt): boolean {
  return receipt.status === "verified";
}

export function isTaskTerminated(status: TaskStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

export function createBodyStopRequest(
  body_session_epoch: Id,
  revoke_through_lease_epoch: number,
  reason: BodyStopRequest["reason"]
): BodyStopRequest {
  return {
    schema_version: "0.2",
    local_stop_id: `stop_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
    body_session_epoch,
    revoke_through_lease_epoch,
    reason,
    requested_monotonic_ms: Date.now(),
  };
}

export function createSelfEventWindow(
  cause: SelfEventWindow["cause"],
  settling_ms: number,
  suppress_sensors: SelfEventWindow["suppress_sensors"] = ["camera", "microphone"]
): SelfEventWindow {
  return {
    window_id: `self_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
    cause,
    started_at_ms: Date.now(),
    estimated_settling_ms: settling_ms,
    suppress_sensors,
  };
}

export function createMemoryClaim(params: {
  claim_id: Id;
  predicate: string;
  object: JsonValue;
  status?: ClaimStatus;
  source_kind: SourceKind;
  evidence_ids: Id[];
  derivation_roots: Id[];
  observed_at?: Timestamp;
  revision?: number;
  household_id?: Id;
  subject_id?: Id | null;
  project_id?: Id | null;
  parent_claim_revisions?: ClaimRevisionRef[];
  confidence?: number;
  valid_from?: Timestamp;
  valid_to?: Timestamp | null;
  expires_at?: Timestamp | null;
  supersedes?: ClaimRevisionRef | null;
  revision_reason?: MemoryClaim["revision_reason"];
  confirmed_by_user_event_id?: Id | null;
  source_availability?: MemoryClaim["source_availability"];
  sensitivity?: Sensitivity;
  deletion_generation?: number;
  suppression_key?: string | null;
}): MemoryClaim {
  const now = new Date().toISOString();
  return {
    schema_version: "0.2",
    claim_id: params.claim_id,
    revision: params.revision ?? 1,
    household_id: params.household_id ?? "default_household",
    subject_id: params.subject_id ?? null,
    project_id: params.project_id ?? null,
    predicate: params.predicate,
    object: params.object,
    status: params.status ?? "inferred",
    source_kind: params.source_kind,
    evidence_ids: params.evidence_ids,
    derivation_roots: params.derivation_roots,
    parent_claim_revisions: params.parent_claim_revisions ?? [],
    confidence: params.confidence ?? 1.0,
    observed_at: params.observed_at ?? now,
    valid_from: params.valid_from ?? params.observed_at ?? now,
    valid_to: params.valid_to ?? null,
    recorded_at: now,
    revised_at: now,
    expires_at: params.expires_at ?? null,
    supersedes: params.supersedes ?? null,
    revision_reason: params.revision_reason ?? "initial",
    confirmed_by_user_event_id: params.confirmed_by_user_event_id ?? null,
    source_availability: params.source_availability ?? "retained",
    sensitivity: params.sensitivity ?? "ordinary",
    deletion_generation: params.deletion_generation ?? 0,
    suppression_key: params.suppression_key ?? null,
  };
}
