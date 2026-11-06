-- Super-LOOI Traceable Evidence Ledger Schema
-- Database: PostgreSQL 16 + pgvector

CREATE EXTENSION IF NOT EXISTS vector;

-- 1. Privacy Epochs (tracks active capture epoch and deletion generation per scope)
CREATE TABLE IF NOT EXISTS privacy_epochs (
    scope_id TEXT PRIMARY KEY,
    household_id TEXT NOT NULL,
    capture_epoch INTEGER NOT NULL DEFAULT 1,
    deletion_generation INTEGER NOT NULL DEFAULT 0,
    capture_mode TEXT NOT NULL,
    camera TEXT NOT NULL,
    microphone TEXT NOT NULL,
    background_processing BOOLEAN NOT NULL DEFAULT true,
    retention_policy_id TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Evidence Events (immutable audit log of raw observations)
CREATE TABLE IF NOT EXISTS evidence_events (
    event_id TEXT PRIMARY KEY,
    household_id TEXT NOT NULL,
    subject_id TEXT,
    source_id TEXT NOT NULL,
    source_device_id TEXT NOT NULL,
    boot_epoch TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    observed_at TIMESTAMPTZ NOT NULL,
    monotonic_ms BIGINT NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    source_kind TEXT NOT NULL,
    derivation_roots JSONB NOT NULL DEFAULT '[]'::jsonb,
    privacy_scope JSONB NOT NULL,
    epoch_binding JSONB NOT NULL,
    retention_policy JSONB NOT NULL,
    payload JSONB NOT NULL,
    UNIQUE(source_id, boot_epoch, sequence)
);

CREATE INDEX IF NOT EXISTS idx_events_observed ON evidence_events(observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_source ON evidence_events(source_id, boot_epoch, sequence);

-- 3. Episodes (temporal groupings of multimodal context)
CREATE TABLE IF NOT EXISTS episodes (
    episode_id TEXT PRIMARY KEY,
    started_at TIMESTAMPTZ NOT NULL,
    ended_at TIMESTAMPTZ,
    trigger_source_kind TEXT NOT NULL,
    evidence_root_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    summary TEXT
);

-- 4. Memory Claims (verifiable knowledge ledger with dual-time and vector embeddings)
CREATE TABLE IF NOT EXISTS memory_claims (
    claim_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    household_id TEXT NOT NULL,
    subject_id TEXT,
    project_id TEXT,
    predicate TEXT NOT NULL,
    object_json JSONB NOT NULL,
    status TEXT NOT NULL,
    source_kind TEXT NOT NULL,
    evidence_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    derivation_roots JSONB NOT NULL DEFAULT '[]'::jsonb,
    confidence REAL,
    observed_at TIMESTAMPTZ NOT NULL,
    valid_from TIMESTAMPTZ NOT NULL,
    valid_to TIMESTAMPTZ,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revised_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ,
    supersedes_json JSONB,
    revision_reason TEXT NOT NULL,
    source_availability TEXT NOT NULL DEFAULT 'retained',
    sensitivity TEXT NOT NULL DEFAULT 'ordinary',
    deletion_generation INTEGER NOT NULL DEFAULT 0,
    suppression_key TEXT,
    embedding vector(1536),
    PRIMARY KEY (claim_id, revision)
);

CREATE INDEX IF NOT EXISTS idx_claims_predicate ON memory_claims(predicate, status);
CREATE INDEX IF NOT EXISTS idx_claims_valid ON memory_claims(valid_from, valid_to);
CREATE INDEX IF NOT EXISTS idx_claims_suppression ON memory_claims(suppression_key) WHERE suppression_key IS NOT NULL;

-- 5. Context Packs (immutable bounded packs delivered to LLM/tools with audit)
CREATE TABLE IF NOT EXISTS context_packs (
    context_pack_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    task_id TEXT,
    consumer_session_id TEXT NOT NULL,
    claim_refs_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    evidence_refs_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    derivation_roots JSONB NOT NULL DEFAULT '[]'::jsonb,
    epoch_bindings_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    instruction_trust TEXT NOT NULL DEFAULT 'untrusted_context_data',
    status TEXT NOT NULL DEFAULT 'active',
    invalidated_at TIMESTAMPTZ,
    invalidation_reason TEXT,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (context_pack_id, revision)
);

-- 6. Deletion Tombstones (irreversible generation markers)
CREATE TABLE IF NOT EXISTS deletion_tombstones (
    tombstone_id TEXT PRIMARY KEY,
    scope_id TEXT NOT NULL,
    deletion_generation INTEGER NOT NULL,
    target_evidence_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    target_derivation_roots JSONB NOT NULL DEFAULT '[]'::jsonb,
    target_claim_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tombstones_scope_gen ON deletion_tombstones(scope_id, deletion_generation);
