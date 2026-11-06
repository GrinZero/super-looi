-- Super-LOOI Phase 4: Smart Home Gateway & Automation Rules Schema
-- PostgreSQL DDL for Home Assistant entity registries, cached state snapshots,
-- verified action receipts, and user-promoted preference rules.

-- 1. Home Entities Table: Whitelisted capabilities & safe operational boundaries
CREATE TABLE IF NOT EXISTS home_entities (
    entity_id VARCHAR(128) PRIMARY KEY,
    friendly_name VARCHAR(128) NOT NULL,
    room VARCHAR(64) NOT NULL DEFAULT 'default_room',
    domain VARCHAR(32) NOT NULL,
    supported_features JSONB NOT NULL DEFAULT '[]'::jsonb,
    allowed_range JSONB NOT NULL DEFAULT '{}'::jsonb,
    is_whitelisted BOOLEAN NOT NULL DEFAULT FALSE,
    max_state_age_ms INTEGER NOT NULL DEFAULT 15000,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_home_entities_room ON home_entities (room);
CREATE INDEX IF NOT EXISTS idx_home_entities_domain ON home_entities (domain);
CREATE INDEX IF NOT EXISTS idx_home_entities_whitelisted ON home_entities (is_whitelisted);

-- 2. Home State Snapshots: Cached telemetry and last verified state
CREATE TABLE IF NOT EXISTS home_state_snapshots (
    entity_id VARCHAR(128) PRIMARY KEY REFERENCES home_entities(entity_id) ON DELETE CASCADE,
    state VARCHAR(64) NOT NULL,
    attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
    last_changed TIMESTAMPTZ NOT NULL,
    last_updated TIMESTAMPTZ NOT NULL,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Home Action Receipts: Audit trail for physical actuation & readback evidence
CREATE TABLE IF NOT EXISTS home_action_receipts (
    receipt_id VARCHAR(64) PRIMARY KEY,
    action_id VARCHAR(64) NOT NULL,
    entity_id VARCHAR(128) NOT NULL REFERENCES home_entities(entity_id) ON DELETE CASCADE,
    service VARCHAR(64) NOT NULL,
    target_state JSONB NOT NULL DEFAULT '{}'::jsonb,
    status VARCHAR(32) NOT NULL,
    outcome VARCHAR(32),
    reason_code VARCHAR(64),
    readbacks JSONB NOT NULL DEFAULT '[]'::jsonb,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_home_receipts_entity ON home_action_receipts (entity_id);

-- 4. Home Automation Rules: Deterministic user-confirmed rules promoted from manual adjustments
CREATE TABLE IF NOT EXISTS home_automation_rules (
    rule_id VARCHAR(64) PRIMARY KEY,
    entity_id VARCHAR(128) NOT NULL REFERENCES home_entities(entity_id) ON DELETE CASCADE,
    condition TEXT NOT NULL,
    desired_state JSONB NOT NULL DEFAULT '{}'::jsonb,
    status VARCHAR(32) NOT NULL DEFAULT 'active',
    confirmed_by_user_event_id VARCHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_home_rules_entity ON home_automation_rules (entity_id, status);
