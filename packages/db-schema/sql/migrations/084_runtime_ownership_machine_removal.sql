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
    updated_at              TIMESTAMPTZ,
    last_event_id           INTEGER
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

CREATE OR REPLACE FUNCTION session_acquire_execution_ownership(
    p_session_id TEXT, p_manifest_id TEXT, p_runtime_env_identity TEXT,
    p_registration_id TEXT, p_pid INTEGER, p_start_identity TEXT,
    p_execution_command_id TEXT, p_lease_expires_at TIMESTAMPTZ,
    p_review_state TEXT, p_expected_terminal_event_id INTEGER,
    p_terminal_resume BOOLEAN, p_acquired_at TIMESTAMPTZ
) RETURNS TABLE (
    applied BOOLEAN, execution_generation BIGINT,
    execution_lease_expires_at TIMESTAMPTZ, status TEXT,
    termination_reason TEXT, termination_detail TEXT, review_state TEXT,
    last_assistant_text TEXT, termination_event_id INTEGER,
    updated_at TIMESTAMPTZ, last_event_id INTEGER
) LANGUAGE plpgsql AS $$
DECLARE
    v_session sessions%ROWTYPE;
    v_row_count INTEGER := 0;
BEGIN
    IF p_manifest_id IS NULL OR p_manifest_id = ''
       OR p_runtime_env_identity IS NULL OR p_runtime_env_identity = ''
       OR p_registration_id IS NULL OR p_registration_id = ''
       OR p_pid IS NULL OR p_pid <= 0
       OR p_start_identity IS NULL OR p_start_identity = ''
       OR p_execution_command_id IS NULL OR p_execution_command_id = '' THEN
        RAISE EXCEPTION 'complete execution identity required';
    END IF;
    IF p_review_state NOT IN ('not_required', 'needs_review', 'acknowledged') THEN
        RAISE EXCEPTION 'unsupported review state: %', p_review_state;
    END IF;

    SELECT * INTO v_session FROM sessions WHERE session_id = p_session_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'session not found: %', p_session_id; END IF;

    IF p_terminal_resume THEN
        UPDATE sessions AS session SET
            status = 'running', termination_reason = NULL,
            termination_detail = NULL, termination_event_id = NULL,
            last_assistant_text = NULL, review_state = p_review_state,
            execution_generation = session.execution_generation + 1,
            execution_manifest_id = p_manifest_id,
            execution_runtime_env_identity = p_runtime_env_identity,
            execution_registration_id = p_registration_id,
            execution_pid = p_pid, execution_start_identity = p_start_identity,
            execution_command_id = p_execution_command_id,
            execution_lease_expires_at = p_acquired_at,
            updated_at = p_acquired_at
         WHERE session.session_id = p_session_id
           AND session.status IN ('completed', 'error', 'interrupted')
           AND session.termination_event_id IS NOT DISTINCT FROM p_expected_terminal_event_id;
    ELSE
        UPDATE sessions AS session SET
            status = 'running', termination_reason = NULL,
            termination_detail = NULL, review_state = p_review_state,
            execution_generation = session.execution_generation + 1,
            execution_manifest_id = p_manifest_id,
            execution_runtime_env_identity = p_runtime_env_identity,
            execution_registration_id = p_registration_id,
            execution_pid = p_pid, execution_start_identity = p_start_identity,
            execution_command_id = p_execution_command_id,
            execution_lease_expires_at = p_acquired_at,
            updated_at = p_acquired_at
         WHERE session.session_id = p_session_id
           AND session.status NOT IN ('completed', 'error', 'interrupted');
    END IF;
    GET DIAGNOSTICS v_row_count = ROW_COUNT;

    IF v_row_count = 1 AND p_terminal_resume THEN
        UPDATE session_deliveries SET
            state = 'superseded', aggregate_state = 'consumed',
            consumed_at = p_acquired_at,
            consumed_reason = 'superseded by terminal resume',
            superseded_at = p_acquired_at,
            superseded_terminal_revision = p_expected_terminal_event_id::text,
            lease_owner = NULL, lease_expires_at = NULL,
            updated_at = p_acquired_at
         WHERE source_session_id = p_session_id
           AND intent = 'completion_notification'
           AND source = 'completion_notifier'
           AND producer_kind = 'child_session'
           AND producer_terminal_revision = p_expected_terminal_event_id::text
           AND state IN ('pending', 'claimed', 'dispatching', 'queued');
    END IF;

    RETURN QUERY SELECT v_row_count = 1, session.execution_generation,
        session.execution_lease_expires_at, session.status,
        session.termination_reason, session.termination_detail,
        session.review_state, session.last_assistant_text,
        session.termination_event_id, session.updated_at, session.last_event_id
      FROM sessions AS session WHERE session.session_id = p_session_id;
END;
$$;
