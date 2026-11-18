-- Production creates this index CONCURRENTLY before release;
-- IF NOT EXISTS makes its migration a no-op there. The migration runner is
-- transactional, so do not use CONCURRENTLY here (as in migration 163).
-- Card #1631: enable index-only nested-loop lookups for delivery latency.
CREATE INDEX IF NOT EXISTS idx_events_id_created_at_cover ON events (session_id, id) INCLUDE (created_at);
