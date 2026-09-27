-- Remove procedures retained for the retired Python-only migration and runtime paths.
DROP FUNCTION IF EXISTS migration_upsert_folder(TEXT, TEXT, INTEGER);
DROP FUNCTION IF EXISTS migration_upsert_session(TEXT, JSONB);
DROP FUNCTION IF EXISTS migration_insert_event(TEXT, INTEGER, TEXT, JSONB, TEXT, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS migration_ensure_session(TEXT, JSONB);
DROP FUNCTION IF EXISTS migration_update_last_event_id(TEXT, INTEGER);
DROP FUNCTION IF EXISTS migration_verify(TEXT);
DROP FUNCTION IF EXISTS session_register_with_review(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, BOOLEAN, BOOLEAN, TEXT);
DROP FUNCTION IF EXISTS session_register_with_predecessor(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, BOOLEAN, BOOLEAN, TEXT, TEXT);
DROP FUNCTION IF EXISTS shutdown_mark_running(TEXT[]);
DROP FUNCTION IF EXISTS shutdown_get_sessions(TEXT);
DROP FUNCTION IF EXISTS shutdown_clear_flags(TEXT);
DROP FUNCTION IF EXISTS shutdown_repair_read_positions();
DROP FUNCTION IF EXISTS session_upsert(TEXT, TEXT[], TEXT[], TIMESTAMPTZ, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS session_list_summary(TEXT, TEXT, INTEGER, INTEGER, TEXT, TEXT);
DROP FUNCTION IF EXISTS folder_get(TEXT);
DROP FUNCTION IF EXISTS folder_delete(TEXT);
DROP FUNCTION IF EXISTS folder_ensure_defaults(JSONB);
