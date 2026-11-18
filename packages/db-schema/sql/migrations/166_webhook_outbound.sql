-- Outbound webhook subscriptions and deliveries (card #1458).
--
-- Subscriptions are per target session and owner. A subscription cursor is the
-- last session event id already turned into a delivery, so publishing never
-- re-scans the whole history. Deliveries carry the fixed notification body and
-- the retry state; the signing secret stays on the subscription row.

CREATE TABLE IF NOT EXISTS webhook_subscriptions (
    id                   UUID PRIMARY KEY,
    owner_email          TEXT NOT NULL,
    label                TEXT NOT NULL CHECK (btrim(label) <> ''),
    target_session_id    TEXT NOT NULL,
    event_types          TEXT[] NOT NULL CHECK (
        cardinality(event_types) > 0
        AND event_types <@ ARRAY[
            'session.reply',
            'session.question',
            'session.failed',
            'session.ended'
        ]::TEXT[]
    ),
    url                  TEXT NOT NULL,
    signing_secret       TEXT NOT NULL,
    cursor_event_id      INTEGER NOT NULL DEFAULT 0,
    active               BOOLEAN NOT NULL DEFAULT TRUE,
    disabled_reason      TEXT,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_webhook_subscriptions_target_session
    ON webhook_subscriptions (target_session_id);

CREATE INDEX IF NOT EXISTS idx_webhook_subscriptions_owner_email
    ON webhook_subscriptions (owner_email);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id                UUID PRIMARY KEY,
    subscription_id   UUID NOT NULL REFERENCES webhook_subscriptions(id) ON DELETE CASCADE,
    session_id        TEXT NOT NULL,
    event_id          INTEGER NOT NULL,
    event_type        TEXT NOT NULL,
    payload           JSONB NOT NULL,
    state             TEXT NOT NULL CHECK (state IN ('pending', 'delivered', 'dead')),
    attempt_count     INTEGER NOT NULL DEFAULT 0,
    next_attempt_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    window_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_status       INTEGER,
    last_error        TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    delivered_at      TIMESTAMPTZ,
    UNIQUE (subscription_id, session_id, event_id)
);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_pending_next_attempt
    ON webhook_deliveries (next_attempt_at)
    WHERE state = 'pending';
