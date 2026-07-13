-- 040: first-class predecessor link for session succession.

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS predecessor_session_id TEXT;
ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_predecessor_session_id_fkey;
ALTER TABLE sessions ADD CONSTRAINT sessions_predecessor_session_id_fkey
    FOREIGN KEY (predecessor_session_id) REFERENCES sessions(session_id) ON DELETE SET NULL;

DROP FUNCTION IF EXISTS session_register_with_predecessor(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, BOOLEAN, BOOLEAN, TEXT, TEXT);
CREATE OR REPLACE FUNCTION session_register_with_predecessor(
    p_session_id            TEXT,
    p_node_id               TEXT,
    p_agent_id              TEXT,
    p_claude_session_id     TEXT,
    p_session_type          TEXT,
    p_prompt                TEXT,
    p_client_id             TEXT,
    p_status                TEXT,
    p_created_at            TIMESTAMPTZ,
    p_updated_at            TIMESTAMPTZ,
    p_caller_session_id     TEXT,
    p_notify_completion     BOOLEAN,
    p_review_required       BOOLEAN,
    p_review_state          TEXT,
    p_predecessor_session_id TEXT
) RETURNS void LANGUAGE sql AS $$
    INSERT INTO sessions (
        session_id, node_id, agent_id, claude_session_id,
        session_type, prompt, client_id, status,
        created_at, updated_at, caller_session_id, notify_completion,
        review_required, review_state, predecessor_session_id
    ) VALUES (
        p_session_id, p_node_id, p_agent_id, p_claude_session_id,
        p_session_type, p_prompt, p_client_id, p_status,
        p_created_at, p_updated_at, p_caller_session_id,
        COALESCE(p_notify_completion, TRUE),
        COALESCE(p_review_required, FALSE),
        COALESCE(p_review_state, 'not_required'),
        p_predecessor_session_id
    );
$$;
