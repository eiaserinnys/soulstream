-- Recovered registrations exist for both centrally-owned and ownerless turns.
-- Release an exact active owner, protect any real successor, and otherwise use
-- the canonical ownerless terminal CAS in the same transaction.
CREATE OR REPLACE FUNCTION session_project_recovered_runner_terminal_fact(
    p_session_id               TEXT,
    p_manifest_id              TEXT,
    p_registration_id          TEXT,
    p_pid                      INTEGER,
    p_start_identity           TEXT,
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
) LANGUAGE plpgsql AS $$
DECLARE
    v_ownership_generation BIGINT;
    v_status TEXT;
    v_termination_reason TEXT;
BEGIN
    PERFORM 1
      FROM sessions
     WHERE session_id = p_session_id
     FOR UPDATE;
    IF NOT FOUND THEN
        RETURN;
    END IF;

    SELECT ownership.ownership_generation
      INTO v_ownership_generation
      FROM session_execution_ownerships AS ownership
     WHERE ownership.session_id = p_session_id
       AND ownership.manifest_id = p_manifest_id
       AND ownership.registration_id = p_registration_id
       AND ownership.pid = p_pid
       AND ownership.start_identity = p_start_identity
       AND ownership.execution_command_id = p_execution_command_id
       AND ownership.phase = 'active'
     FOR UPDATE;

    IF FOUND THEN
        RETURN QUERY
        SELECT *
          FROM session_project_runner_terminal_fact(
              p_session_id,
              v_ownership_generation,
              p_execution_command_id,
              p_runner_fact,
              p_termination_detail,
              p_review_state,
              p_last_assistant_text,
              p_terminal_event_id,
              p_updated_at
          );
        RETURN;
    END IF;

    IF EXISTS (
        SELECT 1
          FROM session_execution_ownerships AS ownership
         WHERE ownership.session_id = p_session_id
           AND (
               ownership.phase = 'active'
               OR (
                   ownership.phase IN ('reserved', 'identity_proven')
                   AND ownership.reservation_expires_at > CURRENT_TIMESTAMP
               )
           )
    ) THEN
        RETURN QUERY
        SELECT FALSE, session.status, session.termination_reason,
               session.termination_detail, session.review_state,
               session.last_assistant_text, session.termination_event_id,
               session.updated_at, session.last_event_id
          FROM sessions AS session
         WHERE session.session_id = p_session_id;
        RETURN;
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

    RETURN QUERY
    SELECT *
      FROM session_apply_terminal_transition(
          p_session_id,
          v_status,
          v_termination_reason,
          p_termination_detail,
          p_review_state,
          p_last_assistant_text,
          p_terminal_event_id,
          p_updated_at
      );
END;
$$;
