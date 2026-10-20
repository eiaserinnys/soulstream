-- Production already received this index CONCURRENTLY on 2026-10-20;
-- IF NOT EXISTS makes its migration a no-op. The migration runner is
-- transactional, so do not use CONCURRENTLY here (as in migration 126).
-- Previous/next input boundary lookups otherwise scan every boundary kind
-- in the session and filter boundary_type row by row.
CREATE INDEX IF NOT EXISTS idx_session_statistics_facts_input_boundary_event
    ON session_statistics_facts (session_id, event_id)
    WHERE fact_kind = 'boundary' AND boundary_type = 'input';
