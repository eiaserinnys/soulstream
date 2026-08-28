CREATE OR REPLACE FUNCTION session_apply_running_transition(
    p_session_id                 TEXT,
    p_review_state               TEXT,
    p_expected_terminal_event_id INTEGER,
    p_terminal_resume            BOOLEAN,
    p_updated_at                 TIMESTAMPTZ
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
    IF p_terminal_resume THEN
        UPDATE sessions AS session
           SET status = 'running',
               termination_reason = NULL,
               termination_detail = NULL,
               termination_event_id = NULL,
               last_assistant_text = NULL,
               review_state = p_review_state,
               updated_at = p_updated_at
         WHERE session.session_id = p_session_id
           AND session.status IN ('completed', 'error', 'interrupted')
           AND session.termination_event_id IS NOT DISTINCT FROM p_expected_terminal_event_id;
    ELSE
        UPDATE sessions AS session
           SET status = 'running',
               termination_reason = NULL,
               termination_detail = NULL,
               review_state = p_review_state,
               updated_at = p_updated_at
         WHERE session.session_id = p_session_id
           AND session.status NOT IN ('completed', 'error', 'interrupted');
    END IF;
    GET DIAGNOSTICS v_row_count = ROW_COUNT;

    IF p_terminal_resume AND v_row_count = 1 THEN
        UPDATE session_deliveries
           SET state = 'superseded',
               aggregate_state = 'consumed',
               consumed_at = p_updated_at,
               consumed_reason = 'superseded by terminal resume',
               superseded_at = p_updated_at,
               superseded_terminal_revision = p_expected_terminal_event_id::text,
               lease_owner = NULL,
               lease_expires_at = NULL,
               updated_at = p_updated_at
         WHERE source_session_id = p_session_id
           AND intent = 'completion_notification'
           AND source = 'completion_notifier'
           AND producer_kind = 'child_session'
           AND producer_terminal_revision = p_expected_terminal_event_id::text
           AND state IN ('pending', 'claimed', 'dispatching', 'queued');
    END IF;

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

CREATE OR REPLACE FUNCTION session_project_runner_terminal_fact(
    p_session_id               TEXT,
    p_ownership_generation     BIGINT,
    p_execution_command_id     TEXT,
    p_runner_fact              TEXT,
    p_termination_detail       TEXT,
    p_review_state             TEXT,
    p_last_assistant_text      TEXT,
    p_terminal_event_id        INTEGER,
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
) LANGUAGE sql AS $$
    SELECT * FROM session_release_execution_ownership(
        p_session_id,
        p_ownership_generation,
        p_execution_command_id,
        p_runner_fact,
        p_termination_detail,
        p_review_state,
        p_last_assistant_text,
        p_terminal_event_id,
        p_updated_at
    );
$$;
