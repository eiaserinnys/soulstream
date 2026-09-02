CREATE OR REPLACE FUNCTION session_record_execution_registration(
    p_session_id                 TEXT,
    p_registration_id            TEXT,
    p_execution_command_id       TEXT,
    p_review_state               TEXT,
    p_expected_terminal_event_id INTEGER,
    p_terminal_resume            BOOLEAN,
    p_recorded_at                TIMESTAMPTZ
) RETURNS TABLE (
    applied                      BOOLEAN,
    execution_registration_id    TEXT,
    execution_command_id         TEXT,
    status                       TEXT,
    termination_reason           TEXT,
    termination_detail           TEXT,
    review_state                 TEXT,
    last_assistant_text          TEXT,
    termination_event_id         INTEGER,
    updated_at                   TIMESTAMPTZ,
    last_event_id                INTEGER
) LANGUAGE plpgsql AS $$
DECLARE
    v_row_count INTEGER := 0;
BEGIN
    IF p_registration_id IS NULL OR p_registration_id = ''
       OR p_execution_command_id IS NULL OR p_execution_command_id = '' THEN
        RAISE EXCEPTION 'complete execution registration required';
    END IF;
    IF p_review_state NOT IN ('not_required', 'needs_review', 'acknowledged') THEN
        RAISE EXCEPTION 'unsupported review state: %', p_review_state;
    END IF;

    PERFORM 1 FROM sessions WHERE session_id = p_session_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'session not found: %', p_session_id;
    END IF;

    IF p_terminal_resume THEN
        UPDATE sessions AS session
           SET status = 'running',
               termination_reason = NULL,
               termination_detail = NULL,
               termination_event_id = NULL,
               last_assistant_text = NULL,
               review_state = p_review_state,
               execution_registration_id = p_registration_id,
               execution_command_id = p_execution_command_id,
               updated_at = p_recorded_at
         WHERE session.session_id = p_session_id
           AND session.status IN ('completed', 'error', 'interrupted')
           AND session.termination_event_id IS NOT DISTINCT FROM p_expected_terminal_event_id;
    ELSE
        UPDATE sessions AS session
           SET status = 'running',
               termination_reason = NULL,
               termination_detail = NULL,
               review_state = p_review_state,
               execution_registration_id = p_registration_id,
               execution_command_id = p_execution_command_id,
               updated_at = p_recorded_at
         WHERE session.session_id = p_session_id
           AND session.status NOT IN ('completed', 'error', 'interrupted');
    END IF;
    GET DIAGNOSTICS v_row_count = ROW_COUNT;

    IF v_row_count = 1 AND p_terminal_resume THEN
        UPDATE session_deliveries
           SET state = 'superseded',
               aggregate_state = 'consumed',
               consumed_at = p_recorded_at,
               consumed_reason = 'superseded by terminal resume',
               superseded_at = p_recorded_at,
               superseded_terminal_revision = p_expected_terminal_event_id::text,
               lease_owner = NULL,
               lease_expires_at = NULL,
               updated_at = p_recorded_at
         WHERE source_session_id = p_session_id
           AND intent = 'completion_notification'
           AND source = 'completion_notifier'
           AND producer_kind = 'child_session'
           AND producer_terminal_revision = p_expected_terminal_event_id::text
           AND state IN ('pending', 'claimed', 'dispatching', 'queued');
    END IF;

    RETURN QUERY
    SELECT v_row_count = 1,
           session.execution_registration_id,
           session.execution_command_id,
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
    last_event_id           INTEGER
) LANGUAGE plpgsql AS $$
DECLARE
    v_row_count INTEGER;
BEGIN
    IF p_terminal_event_id IS NULL OR p_terminal_event_id <= 0 THEN
        RAISE EXCEPTION 'terminal event id must be a positive integer';
    END IF;

    IF EXISTS (
        SELECT 1
          FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'sessions'
           AND column_name = 'execution_manifest_id'
    ) THEN
        -- 085a is deployed before the code rollout. Keep the previous release's
        -- all-or-none row constraint valid without retaining a static dependency
        -- on columns that 085b removes.
        EXECUTE $update$
            UPDATE sessions AS session
               SET status = $1,
                   termination_reason = $2,
                   termination_detail = $3,
                   review_state = $4,
                   last_assistant_text = $5,
                   termination_event_id = $6,
                   execution_manifest_id = NULL,
                   execution_runtime_env_identity = NULL,
                   execution_registration_id = NULL,
                   execution_pid = NULL,
                   execution_start_identity = NULL,
                   execution_command_id = NULL,
                   execution_lease_expires_at = NULL,
                   updated_at = $7
             WHERE session.session_id = $8
               AND session.status NOT IN ('completed', 'error', 'interrupted')
               AND (
                   session.termination_event_id IS NULL
                   OR session.termination_event_id < $6
               )
        $update$ USING p_status, p_termination_reason, p_termination_detail,
            p_review_state, p_last_assistant_text, p_terminal_event_id,
            p_updated_at, p_session_id;
    ELSE
        UPDATE sessions AS session
           SET status = p_status,
               termination_reason = p_termination_reason,
               termination_detail = p_termination_detail,
               review_state = p_review_state,
               last_assistant_text = p_last_assistant_text,
               termination_event_id = p_terminal_event_id,
               execution_registration_id = NULL,
               execution_command_id = NULL,
               updated_at = p_updated_at
         WHERE session.session_id = p_session_id
           AND session.status NOT IN ('completed', 'error', 'interrupted')
           AND (
               session.termination_event_id IS NULL
               OR session.termination_event_id < p_terminal_event_id
           );
    END IF;
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
