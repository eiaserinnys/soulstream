-- Durable transport receipts for worker JSONL outbox retries.

CREATE TABLE IF NOT EXISTS event_ingress_receipts (
    node_id      TEXT NOT NULL,
    stream_id    UUID NOT NULL,
    source_seq   BIGINT NOT NULL CHECK (source_seq > 0),
    session_id   TEXT NOT NULL,
    payload_hash TEXT NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
    event_id     INTEGER NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (node_id, stream_id, source_seq),
    FOREIGN KEY (session_id, event_id)
        REFERENCES events(session_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_event_ingress_receipts_event
    ON event_ingress_receipts (session_id, event_id);
