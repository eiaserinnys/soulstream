-- Production already received this index CONCURRENTLY on 2026-10-22;
-- IF NOT EXISTS makes its migration a no-op. The migration runner is
-- transactional, so do not use CONCURRENTLY here (as in migration 128).
-- Per-session reads filtered by event_type otherwise combine
-- idx_events_session_id with the global idx_events_event_type_cover in a
-- BitmapAnd that walks every event of that type across all sessions.
CREATE INDEX IF NOT EXISTS idx_events_session_type_id
    ON events (session_id, event_type, id);
