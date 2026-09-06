-- 089: persist the reasoning effort a session was created with.
--
-- Effort was previously in-memory only: it reached the engine adapter on the
-- first execution and was lost on eviction or restart, after which the codex
-- adapter silently substituted its hardcoded default. Storing it alongside
-- model_preset makes it a first-class session attribute that resume, restart
-- and successor creation can all read.
--
-- The column is nullable on purpose. Existing rows stay NULL and keep their
-- legacy behaviour; nothing is backfilled.

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS reasoning_effort TEXT;

-- Arity change: the 17-argument overload must be dropped explicitly, otherwise
-- CREATE OR REPLACE leaves both signatures resolvable and callers bind to the
-- stale one.
DROP FUNCTION IF EXISTS session_register_with_model_preset(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, BOOLEAN, BOOLEAN, TEXT, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS session_register_with_model_preset(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, BOOLEAN, BOOLEAN, TEXT, TEXT, TEXT, TEXT, TEXT);
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
    p_model                  TEXT,
    -- New parameters are appended last so existing positional callers keep
    -- their argument order.
    p_reasoning_effort       TEXT
) RETURNS void LANGUAGE sql AS $$
    INSERT INTO sessions (
        session_id, node_id, agent_id, claude_session_id,
        session_type, prompt, client_id, status,
        created_at, updated_at, caller_session_id, notify_completion,
        review_required, review_state, predecessor_session_id,
        model_preset, model, reasoning_effort
    ) VALUES (
        p_session_id, p_node_id, p_agent_id, p_claude_session_id,
        p_session_type, p_prompt, p_client_id, p_status,
        p_created_at, p_updated_at, p_caller_session_id,
        COALESCE(p_notify_completion, TRUE),
        COALESCE(p_review_required, FALSE),
        COALESCE(p_review_state, 'not_required'),
        p_predecessor_session_id, p_model_preset, p_model, p_reasoning_effort
    );
$$;
