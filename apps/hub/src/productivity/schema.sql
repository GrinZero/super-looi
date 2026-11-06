-- Super-LOOI Phase 3: Remote Productivity Supervisor & DSH Execution Schema
-- PostgreSQL DDL for persistent task state machines, cursor-based event streams,
-- action grants, receipts, and verified task artifacts.

-- 1. Tasks Table: Core metadata and state snapshot
CREATE TABLE IF NOT EXISTS productivity_tasks (
    task_id VARCHAR(64) PRIMARY KEY,
    client_request_id VARCHAR(64) NOT NULL UNIQUE,
    requested_by_principal_id VARCHAR(64) NOT NULL,
    intent TEXT NOT NULL,
    scope VARCHAR(32) NOT NULL DEFAULT 'project_internal',
    workspace_id VARCHAR(64),
    executor_id VARCHAR(64) NOT NULL DEFAULT 'dsh_runner',
    context_pack_id VARCHAR(64),
    current_state VARCHAR(32) NOT NULL DEFAULT 'queued',
    current_seq INTEGER NOT NULL DEFAULT 1,
    cancellation_phase VARCHAR(32) NOT NULL DEFAULT 'not_requested',
    uncertainty_reason VARCHAR(64),
    requested_at TIMESTAMPTZ NOT NULL,
    deadline_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tasks_client_req ON productivity_tasks (client_request_id);
CREATE INDEX IF NOT EXISTS idx_tasks_state ON productivity_tasks (current_state);
CREATE INDEX IF NOT EXISTS idx_tasks_workspace ON productivity_tasks (workspace_id);

-- 2. Task Events: Monotonically ordered event stream for cursor-based resumption
CREATE TABLE IF NOT EXISTS task_events (
    event_id VARCHAR(64) PRIMARY KEY,
    task_id VARCHAR(64) NOT NULL REFERENCES productivity_tasks(task_id) ON DELETE CASCADE,
    event_seq INTEGER NOT NULL,
    state VARCHAR(32) NOT NULL,
    summary TEXT NOT NULL,
    action_receipt_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    artifact_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
    cancellation JSONB NOT NULL DEFAULT '{"phase": "not_requested"}'::jsonb,
    uncertainty_reason VARCHAR(64),
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_task_events_seq UNIQUE (task_id, event_seq)
);

CREATE INDEX IF NOT EXISTS idx_task_events_cursor ON task_events (task_id, event_seq);

-- 3. Action Grants: Pre-authorization or high-risk approval gates
CREATE TABLE IF NOT EXISTS action_grants (
    grant_id VARCHAR(64) PRIMARY KEY,
    revision INTEGER NOT NULL DEFAULT 1,
    task_id VARCHAR(64) REFERENCES productivity_tasks(task_id) ON DELETE CASCADE,
    issued_by_principal_id VARCHAR(64) NOT NULL,
    executor_id VARCHAR(64) NOT NULL,
    trigger_kind VARCHAR(32) NOT NULL,
    trigger_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    scope VARCHAR(32) NOT NULL DEFAULT 'project_internal',
    not_before TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    max_uses INTEGER NOT NULL DEFAULT 1,
    uses_count INTEGER NOT NULL DEFAULT 0,
    status VARCHAR(32) NOT NULL DEFAULT 'active',
    revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_grants_task ON action_grants (task_id, status);

-- 4. Action Receipts: Verified execution outcomes and readback evidence
CREATE TABLE IF NOT EXISTS action_receipts (
    receipt_id VARCHAR(64) PRIMARY KEY,
    action_id VARCHAR(64) NOT NULL,
    task_id VARCHAR(64) REFERENCES productivity_tasks(task_id) ON DELETE SET NULL,
    receipt_seq INTEGER NOT NULL DEFAULT 1,
    executor_id VARCHAR(64) NOT NULL,
    status VARCHAR(32) NOT NULL,
    outcome VARCHAR(32),
    reason_code VARCHAR(64),
    readbacks JSONB NOT NULL DEFAULT '[]'::jsonb,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_receipts_task ON action_receipts (task_id);

-- 5. Task Artifacts: Verified outputs produced by tasks
CREATE TABLE IF NOT EXISTS task_artifacts (
    artifact_id VARCHAR(64) PRIMARY KEY,
    task_id VARCHAR(64) NOT NULL REFERENCES productivity_tasks(task_id) ON DELETE CASCADE,
    workspace_id VARCHAR(64) NOT NULL,
    relative_path TEXT NOT NULL,
    content_hash VARCHAR(128) NOT NULL,
    size_bytes BIGINT NOT NULL,
    verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    readback_evidence_ids JSONB NOT NULL DEFAULT '[]'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_artifacts_task ON task_artifacts (task_id);
