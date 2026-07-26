-- Snapshot of the pre-manifest session deliveries migration.
-- from origin/main commit 408c36b0. This fixture is the deployed gate-OFF
-- baseline used to prove the promoted migration remains upgrade-safe.

-- Pre-manifest async intervention/completion exactly-once delivery ledger
--
-- Intentionally NOT listed in migration-manifest.json yet. The runtime v2 gate
-- defaults to legacy/off, and the next operator-approved release must first
-- promote this additive migration into the manifest after backup/preflight.

CREATE TABLE IF NOT EXISTS session_deliveries (
    delivery_id                TEXT PRIMARY KEY,
    target_session_id          TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    source_session_id          TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
    relation_key               TEXT NOT NULL,
    completion_id              TEXT,
    intent                     TEXT NOT NULL,
    source                     TEXT NOT NULL,
    producer_kind              TEXT,
    producer_id                TEXT,
    producer_terminal_revision TEXT,
    parent_delivery_id         TEXT,
    caller_turn_id             TEXT,
    payload_hash               TEXT NOT NULL,
    payload                    JSONB NOT NULL DEFAULT '{}'::jsonb,
    state                      TEXT NOT NULL DEFAULT 'pending',
    created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    claimed_at                 TIMESTAMPTZ,
    queued_at                  TIMESTAMPTZ,
    delivered_at               TIMESTAMPTZ,
    consumed_at                TIMESTAMPTZ,
    CONSTRAINT session_deliveries_relation_unique
        UNIQUE (relation_key),
    CONSTRAINT session_deliveries_intent_check
        CHECK (intent IN (
            'human_live_steer',
            'durable_next_turn',
            'completion_notification',
            'runtime_followup'
        )),
    CONSTRAINT session_deliveries_state_check
        CHECK (state IN (
            'pending',
            'claimed',
            'queued',
            'delivered',
            'consumed',
            'uncertain'
        ))
);

CREATE INDEX IF NOT EXISTS idx_session_deliveries_target_state
    ON session_deliveries(target_session_id, state, created_at);
CREATE INDEX IF NOT EXISTS idx_session_deliveries_completion
    ON session_deliveries(completion_id)
    WHERE completion_id IS NOT NULL;
