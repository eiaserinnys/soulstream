-- Retire the complete supervisor subsystem after code-level removal.
-- Deployment precondition: a verified external PostgreSQL backup and a
-- cluster-wide writer fence. This migration is committed for a later,
-- human-approved deployment and must never be applied by CI.

DROP FUNCTION IF EXISTS supervisor_event_append(TEXT, TEXT, INTEGER, TEXT, TEXT, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS supervisor_event_read_after(BIGINT, INTEGER);
DROP FUNCTION IF EXISTS supervisor_source_cursor_set(TEXT, TEXT, INTEGER, INTEGER, INTEGER, INTEGER);
DROP FUNCTION IF EXISTS supervisor_source_cursor_get(TEXT, TEXT);
DROP FUNCTION IF EXISTS supervisor_source_cursor_recompute(TEXT, TEXT);
DROP FUNCTION IF EXISTS supervisor_consumer_cursor_set(TEXT, BIGINT);
DROP FUNCTION IF EXISTS supervisor_consumer_cursor_get(TEXT);
DROP FUNCTION IF EXISTS supervisor_registry_set_wake_dispatch_state(
    TEXT, TEXT, TEXT, INTEGER, TEXT, TIMESTAMPTZ
);
DROP FUNCTION IF EXISTS supervisor_registry_record_usage_delta(TEXT, BIGINT, INTEGER, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS supervisor_registry_touch(TEXT, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS supervisor_registry_upsert(
    TEXT, TEXT, BIGINT, BIGINT, TEXT, BIGINT, INTEGER, TIMESTAMPTZ
);
DROP FUNCTION IF EXISTS supervisor_registry_get(TEXT);
DROP FUNCTION IF EXISTS supervisor_registry_list();
DROP FUNCTION IF EXISTS supervisor_registry_delete(TEXT);

-- These rows existed only to resolve a supervisor role into a target session.
-- Normal target_session_id-based completion delivery is intentionally retained.
DELETE FROM session_deliveries
WHERE supervisor_role IS NOT NULL;

ALTER TABLE session_deliveries
    DROP COLUMN IF EXISTS supervisor_role;

DROP INDEX IF EXISTS idx_supervisor_events_source;
DROP INDEX IF EXISTS idx_supervisor_events_inserted_at;
DROP INDEX IF EXISTS idx_supervisor_registry_last_seen;

DROP TABLE IF EXISTS supervisor_consumers;
DROP TABLE IF EXISTS supervisor_source_cursors;
DROP TABLE IF EXISTS supervisor_events;
DROP TABLE IF EXISTS supervisor_registry;
