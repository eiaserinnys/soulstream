-- Claude Agent SDK SessionStore transcript mirror.
-- The SDK still writes local transcripts first; this table stores the secondary
-- mirror used for resume materialization and cross-node handoff resilience.

CREATE TABLE IF NOT EXISTS claude_transcript_entries (
    id          BIGSERIAL PRIMARY KEY,
    project_key TEXT NOT NULL,
    session_id  TEXT NOT NULL,
    subpath     TEXT NOT NULL DEFAULT '',
    entry_uuid  TEXT,
    entry       JSONB NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_claude_transcript_load
    ON claude_transcript_entries (project_key, session_id, subpath, id);
CREATE INDEX IF NOT EXISTS idx_claude_transcript_sessions
    ON claude_transcript_entries (project_key, session_id, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_claude_transcript_entry_uuid
    ON claude_transcript_entries (project_key, session_id, subpath, entry_uuid)
    WHERE entry_uuid IS NOT NULL;

CREATE OR REPLACE FUNCTION claude_transcript_append(
    p_project_key TEXT,
    p_session_id  TEXT,
    p_subpath     TEXT,
    p_entries     JSONB,
    p_now         TIMESTAMPTZ
) RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE
    v_subpath TEXT := COALESCE(p_subpath, '');
    v_entry JSONB;
    v_uuid TEXT;
    v_count INTEGER := 0;
BEGIN
    FOR v_entry IN SELECT value FROM jsonb_array_elements(COALESCE(p_entries, '[]'::jsonb))
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

CREATE OR REPLACE FUNCTION claude_transcript_load(
    p_project_key TEXT,
    p_session_id  TEXT,
    p_subpath     TEXT
) RETURNS TABLE(entry JSONB) LANGUAGE sql STABLE AS $$
    SELECT e.entry
    FROM claude_transcript_entries e
    WHERE e.project_key = p_project_key
      AND e.session_id = p_session_id
      AND e.subpath = COALESCE(p_subpath, '')
    ORDER BY e.id ASC;
$$;

CREATE OR REPLACE FUNCTION claude_transcript_list_sessions(
    p_project_key TEXT
) RETURNS TABLE(session_id TEXT, mtime DOUBLE PRECISION) LANGUAGE sql STABLE AS $$
    SELECT
        e.session_id,
        EXTRACT(EPOCH FROM MAX(e.updated_at)) * 1000 AS mtime
    FROM claude_transcript_entries e
    WHERE e.project_key = p_project_key
      AND e.subpath = ''
    GROUP BY e.session_id;
$$;

CREATE OR REPLACE FUNCTION claude_transcript_list_subkeys(
    p_project_key TEXT,
    p_session_id  TEXT
) RETURNS TABLE(subpath TEXT) LANGUAGE sql STABLE AS $$
    SELECT DISTINCT e.subpath
    FROM claude_transcript_entries e
    WHERE e.project_key = p_project_key
      AND e.session_id = p_session_id
      AND e.subpath <> ''
    ORDER BY e.subpath ASC;
$$;

CREATE OR REPLACE FUNCTION claude_transcript_delete(
    p_project_key TEXT,
    p_session_id  TEXT,
    p_subpath     TEXT
) RETURNS void LANGUAGE sql AS $$
    DELETE FROM claude_transcript_entries e
    WHERE e.project_key = p_project_key
      AND e.session_id = p_session_id
      AND (p_subpath IS NULL OR e.subpath = p_subpath);
$$;

CREATE OR REPLACE FUNCTION session_delete(
    p_session_id TEXT
) RETURNS void LANGUAGE sql AS $$
    DELETE FROM claude_transcript_entries
    WHERE session_id = p_session_id
       OR session_id = (
            SELECT claude_session_id
            FROM sessions
            WHERE sessions.session_id = p_session_id
       );

    DELETE FROM sessions WHERE session_id = p_session_id;
$$;
