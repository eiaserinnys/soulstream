-- 043: async intervention/completion exactly-once delivery ledger
--
-- Intentionally NOT listed in migration-manifest.json yet. The runtime v2 gate
-- defaults to legacy/off, and the next operator-approved release must first
-- promote this additive migration into the manifest after backup/preflight.

CREATE TABLE IF NOT EXISTS session_deliveries (
    delivery_id                TEXT PRIMARY KEY,
    target_session_id          TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
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
    supervisor_role            TEXT,
    payload_hash               TEXT NOT NULL,
    payload                    JSONB NOT NULL DEFAULT '{}'::jsonb,
    state                      TEXT NOT NULL DEFAULT 'pending',
    created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    claimed_at                 TIMESTAMPTZ,
    dispatching_at             TIMESTAMPTZ,
    lease_owner                TEXT,
    lease_expires_at           TIMESTAMPTZ,
    attempt_count              INTEGER NOT NULL DEFAULT 0,
    next_attempt_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_error                 TEXT,
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
            'dispatching',
            'queued',
            'delivered',
            'consumed',
            'uncertain'
    ))
);

-- Re-running the pending migration over a canary DB created by the earlier
-- gate-OFF schema must preserve deliveries when a target session disappears.
ALTER TABLE session_deliveries
    DROP CONSTRAINT IF EXISTS session_deliveries_target_session_id_fkey;
ALTER TABLE session_deliveries
    ALTER COLUMN target_session_id DROP NOT NULL;
ALTER TABLE session_deliveries
    ADD CONSTRAINT session_deliveries_target_session_id_fkey
    FOREIGN KEY (target_session_id)
    REFERENCES sessions(session_id)
    ON DELETE SET NULL;
ALTER TABLE session_deliveries
    ADD COLUMN IF NOT EXISTS supervisor_role TEXT,
    ADD COLUMN IF NOT EXISTS dispatching_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS lease_owner TEXT,
    ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ADD COLUMN IF NOT EXISTS last_error TEXT;
ALTER TABLE session_deliveries
    DROP CONSTRAINT IF EXISTS session_deliveries_state_check;
ALTER TABLE session_deliveries
    ADD CONSTRAINT session_deliveries_state_check
    CHECK (state IN (
        'pending',
        'claimed',
        'dispatching',
        'queued',
        'delivered',
        'consumed',
        'uncertain'
    ));

CREATE INDEX IF NOT EXISTS idx_session_deliveries_target_state
    ON session_deliveries(target_session_id, state, created_at);
CREATE INDEX IF NOT EXISTS idx_session_deliveries_recovery
    ON session_deliveries(state, next_attempt_at, lease_expires_at, created_at);
CREATE INDEX IF NOT EXISTS idx_session_deliveries_completion
    ON session_deliveries(completion_id)
    WHERE completion_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS session_delivery_notification_outbox (
    delivery_id        TEXT PRIMARY KEY
        REFERENCES session_deliveries(delivery_id) ON DELETE CASCADE,
    target_session_id  TEXT NOT NULL,
    payload            JSONB NOT NULL,
    disposition        TEXT NOT NULL,
    state              TEXT NOT NULL DEFAULT 'claimed',
    lease_owner        TEXT,
    lease_expires_at   TIMESTAMPTZ,
    attempt_count      INTEGER NOT NULL DEFAULT 0,
    next_attempt_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_error         TEXT,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    published_at       TIMESTAMPTZ,
    CONSTRAINT session_delivery_notification_disposition_check
        CHECK (disposition IN ('queued', 'auto_resume')),
    CONSTRAINT session_delivery_notification_state_check
        CHECK (state IN ('pending', 'claimed', 'published'))
);

CREATE INDEX IF NOT EXISTS idx_session_delivery_notification_recovery
    ON session_delivery_notification_outbox(
        state,
        next_attempt_at,
        lease_expires_at,
        created_at
    );
