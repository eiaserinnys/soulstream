-- Migration 085b destroys historical ownership rows and columns. Restore the
-- verified pre-085b database backup before running this artifact. The guard
-- prevents rebuilding only the function over an unrestored schema.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'sessions'
           AND column_name = 'execution_manifest_id'
    ) THEN
        RAISE EXCEPTION '085b rollback requires restoration of the pre-migration database backup';
    END IF;
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
