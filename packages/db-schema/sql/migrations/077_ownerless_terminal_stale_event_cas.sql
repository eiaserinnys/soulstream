-- A generation-0 ownerless row can retain an older terminal event pointer after
-- legacy status reopening. Permit reconciliation to advance that pointer to the
-- newly appended terminal event without weakening the owner or status fences.
CREATE OR REPLACE FUNCTION session_apply_terminal_transition(
    p_session_id           TEXT,
    p_status               TEXT,
    p_termination_reason   TEXT,
    p_termination_detail   TEXT,
    p_review_state         TEXT,
    p_last_assistant_text  TEXT,
    p_terminal_event_id    INTEGER,
    p_updated_at           TIMESTAMPTZ
) RETURNS TABLE (
    applied                BOOLEAN,
    status                 TEXT,
    termination_reason     TEXT,
    termination_detail     TEXT,
    review_state           TEXT,
    last_assistant_text    TEXT,
    termination_event_id   INTEGER,
    updated_at             TIMESTAMPTZ,
    last_event_id          INTEGER
) LANGUAGE plpgsql AS $$
DECLARE
    v_row_count INTEGER;
BEGIN
    IF p_terminal_event_id IS NULL OR p_terminal_event_id <= 0 THEN
        RAISE EXCEPTION 'terminal event id must be a positive integer';
    END IF;

    UPDATE sessions AS session
       SET status = p_status,
           termination_reason = p_termination_reason,
           termination_detail = p_termination_detail,
           review_state = p_review_state,
           last_assistant_text = p_last_assistant_text,
           termination_event_id = p_terminal_event_id,
           updated_at = p_updated_at
     WHERE session.session_id = p_session_id
       AND session.execution_generation = 0
       AND session.execution_manifest_id IS NULL
       AND session.execution_runtime_env_identity IS NULL
       AND session.execution_registration_id IS NULL
       AND session.execution_pid IS NULL
       AND session.execution_start_identity IS NULL
       AND session.execution_command_id IS NULL
       AND session.execution_lease_expires_at IS NULL
       AND session.status NOT IN ('completed', 'error', 'interrupted')
       AND (
           session.termination_event_id IS NULL
           OR session.termination_event_id < p_terminal_event_id
       );
    GET DIAGNOSTICS v_row_count = ROW_COUNT;

    RETURN QUERY
    SELECT v_row_count = 1,
           session.status,
           session.termination_reason,
           session.termination_detail,
           session.review_state,
           session.last_assistant_text,
           session.termination_event_id,
           session.updated_at,
           session.last_event_id
      FROM sessions AS session
     WHERE session.session_id = p_session_id;
END;
$$;
