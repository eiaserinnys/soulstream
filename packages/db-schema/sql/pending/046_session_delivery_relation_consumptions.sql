-- 046: semantic completion relations consumed before a late notifier arrives
--
-- Intentionally NOT listed in migration-manifest.json. Runtime v2 remains
-- default-off until operator-approved migration and disposable canary gates.

CREATE TABLE IF NOT EXISTS session_delivery_relation_consumptions (
    relation_key       TEXT PRIMARY KEY,
    completion_id      TEXT NOT NULL,
    caller_session_id  TEXT NOT NULL,
    consumed_turn_id   TEXT NOT NULL,
    consumed_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_session_delivery_relation_consumptions_caller
    ON session_delivery_relation_consumptions(caller_session_id, consumed_at);
