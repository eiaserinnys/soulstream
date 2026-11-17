-- Production creates this index CONCURRENTLY before release;
-- IF NOT EXISTS makes its migration a no-op there. The migration runner is
-- transactional, so do not use CONCURRENTLY here (as in migrations 128 and 130).
-- Turn usage only reads usage from result events with success=false, so this
-- partial index serves their created_at range without scanning every result.
CREATE INDEX IF NOT EXISTS idx_events_failed_result
    ON events (created_at) INCLUDE (session_id, id)
    WHERE event_type = 'result' AND (payload->>'success') = 'false';
