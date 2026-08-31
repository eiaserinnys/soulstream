CREATE OR REPLACE FUNCTION session_reconcile_recorded_runner_terminal_fact(
    p_session_id               TEXT,
    p_ownership_generation     BIGINT,
    p_manifest_id              TEXT,
    p_runtime_env_identity     TEXT,
    p_registration_id          TEXT,
    p_pid                      INTEGER,
    p_start_identity           TEXT,
    p_execution_command_id     TEXT,
    p_terminal_event_id        INTEGER,
    p_runner_fact              TEXT,
    p_termination_detail       TEXT,
    p_review_state             TEXT,
    p_last_assistant_text      TEXT,
    p_updated_at               TIMESTAMPTZ
) RETURNS TABLE (
    applied                    BOOLEAN,
    status                     TEXT,
    termination_reason         TEXT,
    termination_detail         TEXT,
    review_state               TEXT,
    last_assistant_text        TEXT,
    termination_event_id       INTEGER,
    updated_at                 TIMESTAMPTZ,
    last_event_id              INTEGER
) LANGUAGE plpgsql AS $$
DECLARE
    v_row_count INTEGER := 0;
    v_status TEXT;
    v_termination_reason TEXT;
BEGIN
    IF p_ownership_generation IS NULL OR p_ownership_generation <= 0 THEN
        RAISE EXCEPTION 'ownership generation must be positive';
    END IF;
    IF p_manifest_id IS NULL OR p_manifest_id = ''
       OR p_runtime_env_identity IS NULL OR p_runtime_env_identity = ''
       OR p_registration_id IS NULL OR p_registration_id = ''
       OR p_pid IS NULL OR p_pid <= 0
       OR p_start_identity IS NULL OR p_start_identity = ''
       OR p_execution_command_id IS NULL OR p_execution_command_id = '' THEN
        RAISE EXCEPTION 'recorded terminal reconciliation requires complete identity';
    END IF;
    IF p_terminal_event_id IS NULL OR p_terminal_event_id <= 0 THEN
        RAISE EXCEPTION 'recorded terminal reconciliation requires a terminal receipt';
    END IF;
    IF p_review_state NOT IN ('not_required', 'needs_review', 'acknowledged') THEN
        RAISE EXCEPTION 'unsupported review state: %', p_review_state;
    END IF;
    IF p_updated_at IS NULL THEN
        RAISE EXCEPTION 'recorded terminal reconciliation timestamp is required';
    END IF;

    CASE p_runner_fact
        WHEN 'completed' THEN
            v_status := 'completed';
            v_termination_reason := 'completed_ok';
        WHEN 'closed' THEN
            v_status := 'interrupted';
            v_termination_reason := 'killed';
        WHEN 'failed' THEN
            v_status := 'error';
            v_termination_reason := 'error_aborted';
        WHEN 'reaped' THEN
            v_status := 'error';
            v_termination_reason := 'error_aborted';
        ELSE
            RAISE EXCEPTION 'unsupported runner terminal fact: %', p_runner_fact;
    END CASE;

    UPDATE sessions AS session
       SET status = v_status,
           termination_reason = v_termination_reason,
           termination_detail = p_termination_detail,
           review_state = p_review_state,
           last_assistant_text = p_last_assistant_text,
           execution_manifest_id = NULL,
           execution_runtime_env_identity = NULL,
           execution_registration_id = NULL,
           execution_pid = NULL,
           execution_start_identity = NULL,
           execution_command_id = NULL,
           execution_lease_expires_at = NULL,
           updated_at = p_updated_at
     WHERE session.session_id = p_session_id
       AND session.status NOT IN ('completed', 'error', 'interrupted')
       AND session.termination_event_id = p_terminal_event_id
       AND session.execution_generation = p_ownership_generation
       AND session.execution_manifest_id = p_manifest_id
       AND session.execution_runtime_env_identity = p_runtime_env_identity
       AND session.execution_registration_id = p_registration_id
       AND session.execution_pid = p_pid
       AND session.execution_start_identity = p_start_identity
       AND session.execution_command_id = p_execution_command_id
       AND EXISTS (
           SELECT 1
             FROM events AS event
            WHERE event.session_id = p_session_id
              AND event.id = p_terminal_event_id
              AND event.event_type = 'session_ended'
       );
    GET DIAGNOSTICS v_row_count = ROW_COUNT;

    RETURN QUERY
    SELECT (
               v_row_count = 1
               OR (
                   session.status IN ('completed', 'error', 'interrupted')
                   AND session.termination_event_id = p_terminal_event_id
                   AND session.execution_generation = p_ownership_generation
                   AND session.execution_manifest_id IS NULL
                   AND session.execution_runtime_env_identity IS NULL
                   AND session.execution_registration_id IS NULL
                   AND session.execution_pid IS NULL
                   AND session.execution_start_identity IS NULL
                   AND session.execution_command_id IS NULL
                   AND session.execution_lease_expires_at IS NULL
               )
           ) AS applied,
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
