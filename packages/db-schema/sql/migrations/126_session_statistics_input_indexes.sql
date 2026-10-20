-- Production already received these indexes CONCURRENTLY on 2026-10-20;
-- IF NOT EXISTS makes its migration a no-op. The migration runner is
-- transactional, so do not use CONCURRENTLY here (as in migration 101).
CREATE INDEX IF NOT EXISTS idx_session_statistics_facts_usage_input
    ON session_statistics_facts (session_id, input_id)
    WHERE fact_kind = 'usage' AND input_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_session_statistics_facts_boundary_input
    ON session_statistics_facts (session_id, input_id)
    WHERE fact_kind = 'boundary' AND input_id IS NOT NULL;
