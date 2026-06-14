-- Claude transcript append JSONB shape guard.
-- Existing deployed databases already have the table and indexes from migration 015.
-- This migration only replaces the append function so scalar or single-object
-- mirror payloads cannot make jsonb_array_elements fail before storage.

CREATE OR REPLACE FUNCTION claude_transcript_append(
    p_project_key TEXT,
    p_session_id  TEXT,
    p_subpath     TEXT,
    p_entries     JSONB,
    p_now         TIMESTAMPTZ
) RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE
    v_subpath TEXT := COALESCE(p_subpath, '');
    v_entries JSONB := CASE jsonb_typeof(p_entries)
        WHEN 'array' THEN p_entries
        WHEN 'object' THEN jsonb_build_array(p_entries)
        ELSE '[]'::jsonb
    END;
    v_entry JSONB;
    v_uuid TEXT;
    v_count INTEGER := 0;
BEGIN
    FOR v_entry IN SELECT value FROM jsonb_array_elements(v_entries)
    LOOP
        v_uuid := v_entry->>'uuid';
        INSERT INTO claude_transcript_entries (
            project_key,
            session_id,
            subpath,
            entry_uuid,
            entry,
            created_at,
            updated_at
        ) VALUES (
            p_project_key,
            p_session_id,
            v_subpath,
            v_uuid,
            v_entry,
            p_now,
            p_now
        )
        ON CONFLICT (project_key, session_id, subpath, entry_uuid)
        WHERE entry_uuid IS NOT NULL
        DO UPDATE SET entry = EXCLUDED.entry, updated_at = EXCLUDED.updated_at;

        v_count := v_count + 1;
    END LOOP;
    RETURN v_count;
END;
$$;
