-- Remove unused tsvector storage and indexes duplicated by events_pkey.
DROP TRIGGER IF EXISTS trg_events_search_vector ON events;
DROP FUNCTION IF EXISTS update_search_vector();
DROP INDEX IF EXISTS idx_events_search;
DROP INDEX IF EXISTS idx_events_search_vector;
ALTER TABLE events DROP COLUMN IF EXISTS search_vector;
DROP INDEX IF EXISTS idx_events_session_id_id;
