-- 047: semantic completion relations consumed before a late notifier arrives
--
-- Apply after 045 so late completion notifiers can converge to consumed.

CREATE TABLE IF NOT EXISTS session_delivery_relation_consumptions (
    relation_key       TEXT PRIMARY KEY,
    completion_id      TEXT NOT NULL,
    caller_session_id  TEXT NOT NULL,
    consumed_turn_id   TEXT NOT NULL,
    consumed_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_session_delivery_relation_consumptions_caller
    ON session_delivery_relation_consumptions(caller_session_id, consumed_at);
