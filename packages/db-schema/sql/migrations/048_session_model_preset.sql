-- 048: persist the selected model preset and its resolved model for restart-safe resume.

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS model_preset TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS model TEXT;

DROP FUNCTION IF EXISTS session_register_with_model_preset(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, BOOLEAN, BOOLEAN, TEXT, TEXT, TEXT, TEXT);
CREATE OR REPLACE FUNCTION session_register_with_model_preset(
    p_session_id             TEXT,
    p_node_id                TEXT,
    p_agent_id               TEXT,
    p_claude_session_id      TEXT,
    p_session_type           TEXT,
    p_prompt                 TEXT,
    p_client_id              TEXT,
    p_status                 TEXT,
    p_created_at             TIMESTAMPTZ,
    p_updated_at             TIMESTAMPTZ,
    p_caller_session_id      TEXT,
    p_notify_completion      BOOLEAN,
    p_review_required        BOOLEAN,
    p_review_state           TEXT,
    p_predecessor_session_id TEXT,
    p_model_preset           TEXT,
    p_model                  TEXT
) RETURNS void LANGUAGE sql AS $$
    INSERT INTO sessions (
        session_id, node_id, agent_id, claude_session_id,
        session_type, prompt, client_id, status,
        created_at, updated_at, caller_session_id, notify_completion,
        review_required, review_state, predecessor_session_id,
        model_preset, model
    ) VALUES (
        p_session_id, p_node_id, p_agent_id, p_claude_session_id,
        p_session_type, p_prompt, p_client_id, p_status,
        p_created_at, p_updated_at, p_caller_session_id,
        COALESCE(p_notify_completion, TRUE),
        COALESCE(p_review_required, FALSE),
        COALESCE(p_review_state, 'not_required'),
        p_predecessor_session_id, p_model_preset, p_model
    );
$$;

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
    model_preset TEXT,
    model TEXT,
    total_count   BIGINT
) LANGUAGE sql STABLE AS $$
    WITH filtered AS (
        SELECT s.session_id, s.display_name, s.status, s.session_type,
               s.created_at, s.updated_at,
               (SELECT COUNT(*) FROM events e WHERE e.session_id = s.session_id) AS event_count,
               s.away_summary, s.caller_session_id,
               s.last_event_id, s.last_read_event_id, s.node_id,
               s.model_preset, s.model
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
