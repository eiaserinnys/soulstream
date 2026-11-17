-- 162: sessions partial indexes for card occupancy and board reads (card #1476)
--
-- A. The card status reminder walks child sessions by caller_session_id and had no
--    index, so every recursion step scanned sessions. NULL never matches the walk.
-- B. syncCard finds sessions whose persistent report carries a card marker. The query
--    literal in persistent_report_service.ts must stay equal to this index predicate.
-- C. idx_sessions_updated_at_session_id was created by the orchestrator at boot with
--    CREATE INDEX CONCURRENTLY as a role that is not the table owner, failing on every
--    start with "must be owner of table sessions". Migrations run as the owner, so the
--    index moves here; existing databases already have it and IF NOT EXISTS does nothing.
--
-- Migrations run inside one transaction, so CONCURRENTLY is not available. sessions is
-- small enough that a regular build is acceptable.

CREATE INDEX IF NOT EXISTS idx_sessions_caller_session_id
    ON sessions (caller_session_id)
    WHERE caller_session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sessions_persistent_report
    ON sessions (session_id)
    WHERE metadata @> '[{"type":"persistent_report"}]'::jsonb;

CREATE INDEX IF NOT EXISTS idx_sessions_updated_at_session_id
    ON sessions (updated_at DESC, session_id DESC);
