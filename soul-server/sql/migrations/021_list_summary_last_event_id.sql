-- 021: Expose last_event_id in session_list_summary for supervisor reconnect replay.

DROP FUNCTION IF EXISTS session_list_summary(TEXT, TEXT, INTEGER, INTEGER, TEXT, TEXT);

CREATE OR REPLACE FUNCTION session_list_summary(
    p_search       TEXT DEFAULT NULL,
    p_session_type TEXT DEFAULT NULL,
    p_limit        INTEGER DEFAULT 20,
    p_offset       INTEGER DEFAULT 0,
    p_folder_id    TEXT DEFAULT NULL,
    p_node_id      TEXT DEFAULT NULL
) RETURNS TABLE(
    session_id    TEXT,
    display_name  TEXT,
    status        TEXT,
    session_type  TEXT,
    created_at    TIMESTAMPTZ,
    updated_at    TIMESTAMPTZ,
    event_count   BIGINT,
    away_summary  TEXT,
    caller_session_id TEXT,
    last_event_id INTEGER,
    last_read_event_id INTEGER,
    node_id TEXT,
    total_count   BIGINT
) LANGUAGE sql STABLE AS $$
    WITH filtered AS (
        SELECT s.session_id, s.display_name, s.status, s.session_type,
               s.created_at, s.updated_at,
               (SELECT COUNT(*) FROM events e WHERE e.session_id = s.session_id) AS event_count,
               s.away_summary, s.caller_session_id,
               s.last_event_id, s.last_read_event_id, s.node_id
        FROM sessions s
        WHERE (p_session_type IS NULL OR s.session_type = p_session_type)
          AND (p_search IS NULL OR s.display_name ILIKE '%' || p_search || '%')
          AND (p_folder_id IS NULL OR s.folder_id = p_folder_id)
          AND (p_node_id IS NULL OR s.node_id = p_node_id)
        ORDER BY s.updated_at DESC
    )
    SELECT f.*, (SELECT COUNT(*) FROM filtered)::BIGINT AS total_count
    FROM filtered f
    LIMIT p_limit OFFSET p_offset;
$$;
