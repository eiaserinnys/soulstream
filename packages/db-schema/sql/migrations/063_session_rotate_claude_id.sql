-- Migration 063 recovers a Claude session that exhausted its context window without changing
-- Soulstream's external agent_session_id. The expected predecessor fences the
-- one-shot replacement; accepting the new ID makes ingress replay idempotent.
CREATE OR REPLACE FUNCTION session_rotate_claude_id(
    p_session_id                 TEXT,
    p_expected_claude_session_id TEXT,
    p_new_claude_session_id      TEXT
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
    v_existing TEXT;
BEGIN
    SELECT claude_session_id INTO v_existing
    FROM sessions
    WHERE session_id = p_session_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Session not found: %', p_session_id;
    ELSIF v_existing = p_new_claude_session_id THEN
        NULL;
    ELSIF v_existing IS DISTINCT FROM p_expected_claude_session_id THEN
        RAISE EXCEPTION 'claude_session_id rotation predecessor mismatch: session_id=%, expected=%, existing=%, new=%',
            p_session_id, p_expected_claude_session_id, v_existing, p_new_claude_session_id;
    ELSE
        UPDATE sessions
        SET claude_session_id = p_new_claude_session_id,
            updated_at = NOW()
        WHERE session_id = p_session_id;
    END IF;
END;
$$;
