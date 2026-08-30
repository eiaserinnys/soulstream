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
           AND p_expected_terminal_event_id IS NOT NULL
           AND session.termination_event_id = p_expected_terminal_event_id;
    ELSE
        UPDATE sessions AS session
           SET status = 'running',
               termination_reason = NULL,
               termination_detail = NULL,
               review_state = p_review_state,
               updated_at = p_updated_at
         WHERE session.session_id = p_session_id
           AND session.termination_event_id IS NULL;
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
CREATE OR REPLACE FUNCTION session_activate_execution_ownership(
    p_session_id                 TEXT,
    p_ownership_generation       BIGINT,
    p_review_state               TEXT,
    p_expected_terminal_event_id INTEGER,
    p_terminal_resume            BOOLEAN,
    p_updated_at                 TIMESTAMPTZ
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
    v_owner_kind TEXT;
    v_manifest_id TEXT;
    v_registration_id TEXT;
    v_pid INTEGER;
    v_start_identity TEXT;
    v_execution_command_id TEXT;
BEGIN
    SELECT owner_kind, manifest_id, registration_id, pid, start_identity,
           execution_command_id
      INTO v_owner_kind, v_manifest_id, v_registration_id, v_pid,
           v_start_identity, v_execution_command_id
      FROM session_execution_ownerships
     WHERE session_id = p_session_id
       AND ownership_generation = p_ownership_generation
       AND phase = 'identity_proven'
       AND reservation_expires_at > p_updated_at
     FOR UPDATE;
    IF FOUND THEN
        IF v_owner_kind = 'adopted_runner' THEN
            PERFORM 1
             FROM session_execution_ownerships
             WHERE session_id = p_session_id
               AND ownership_generation <> p_ownership_generation
               AND (
                   phase = 'active'
                   OR (
                       phase = 'identity_proven'
                       AND failure_reason = 'orphaned_spawn'
                       AND reservation_expires_at > p_updated_at
                   )
               )
               AND manifest_id = v_manifest_id
               AND registration_id = v_registration_id
               AND pid = v_pid
               AND start_identity = v_start_identity
               AND execution_command_id = v_execution_command_id
             FOR UPDATE;
            IF NOT FOUND THEN
                RETURN QUERY
                SELECT FALSE, session.status, session.termination_reason,
                       session.termination_detail, session.review_state,
                       session.last_assistant_text, session.termination_event_id,
                       session.updated_at, session.last_event_id
                  FROM sessions AS session
                 WHERE session.session_id = p_session_id;
                RETURN;
            END IF;
        END IF;
        IF p_terminal_resume THEN
            UPDATE sessions AS session
               SET status = 'running', termination_reason = NULL,
                   termination_detail = NULL, termination_event_id = NULL,
                   last_assistant_text = NULL, review_state = p_review_state,
                   updated_at = p_updated_at
             WHERE session.session_id = p_session_id
               AND p_expected_terminal_event_id IS NOT NULL
               AND session.termination_event_id = p_expected_terminal_event_id;
        ELSE
            UPDATE sessions AS session
               SET status = 'running', termination_reason = NULL,
                   termination_detail = NULL, review_state = p_review_state,
                   updated_at = p_updated_at
             WHERE session.session_id = p_session_id
               AND session.termination_event_id IS NULL;
        END IF;
        GET DIAGNOSTICS v_row_count = ROW_COUNT;
        IF v_row_count = 1 THEN
            IF v_owner_kind = 'adopted_runner' THEN
                UPDATE session_execution_ownerships
                   SET phase = 'terminal', terminal_at = p_updated_at,
                       reservation_expires_at = NULL,
                       failure_reason = 'ownership handed to adopting host'
                 WHERE session_id = p_session_id
                   AND ownership_generation <> p_ownership_generation
                   AND (
                       phase = 'active'
                       OR (
                           phase = 'identity_proven'
                           AND failure_reason = 'orphaned_spawn'
                       )
                   )
                   AND manifest_id = v_manifest_id
                   AND registration_id = v_registration_id
                   AND pid = v_pid
                   AND start_identity = v_start_identity
                   AND execution_command_id = v_execution_command_id;
            END IF;
            UPDATE session_execution_ownerships
               SET phase = 'active', activated_at = p_updated_at,
                   reservation_expires_at = NULL
             WHERE session_id = p_session_id
               AND ownership_generation = p_ownership_generation
               AND phase = 'identity_proven';
        END IF;
    END IF;

    RETURN QUERY
    SELECT v_row_count = 1, session.status, session.termination_reason,
           session.termination_detail, session.review_state,
           session.last_assistant_text, session.termination_event_id,
           session.updated_at, session.last_event_id
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
    v_exact_identity BOOLEAN;
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
    IF p_lease_expires_at IS NULL OR p_lease_expires_at <= p_acquired_at THEN
        RAISE EXCEPTION 'future execution lease required';
    END IF;
    IF p_review_state NOT IN ('not_required', 'needs_review', 'acknowledged') THEN
        RAISE EXCEPTION 'unsupported review state: %', p_review_state;
    END IF;

    SELECT * INTO v_session FROM sessions
     WHERE session_id = p_session_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'session not found: %', p_session_id; END IF;

    v_exact_identity := v_session.execution_manifest_id = p_manifest_id
        AND v_session.execution_runtime_env_identity = p_runtime_env_identity
        AND v_session.execution_registration_id = p_registration_id
        AND v_session.execution_pid = p_pid
        AND v_session.execution_start_identity = p_start_identity
        AND v_session.execution_command_id = p_execution_command_id;

    IF v_session.execution_manifest_id IS NOT NULL
       AND v_session.execution_lease_expires_at > p_acquired_at THEN
        IF v_exact_identity THEN
            UPDATE sessions SET execution_lease_expires_at = p_lease_expires_at,
                   updated_at = p_acquired_at WHERE session_id = p_session_id;
            GET DIAGNOSTICS v_row_count = ROW_COUNT;
        END IF;
        RETURN QUERY SELECT v_exact_identity AND v_row_count = 1,
            session.execution_generation, session.execution_lease_expires_at,
            session.status, session.termination_reason, session.termination_detail,
            session.review_state, session.last_assistant_text,
            session.termination_event_id, session.updated_at, session.last_event_id
          FROM sessions AS session WHERE session.session_id = p_session_id;
        RETURN;
    END IF;

    IF EXISTS (
        SELECT 1 FROM session_execution_ownerships
         WHERE session_id = p_session_id
           AND phase IN ('reserved', 'identity_proven', 'active')
    ) THEN
        RETURN QUERY SELECT FALSE, session.execution_generation,
            session.execution_lease_expires_at, session.status,
            session.termination_reason, session.termination_detail,
            session.review_state, session.last_assistant_text,
            session.termination_event_id, session.updated_at, session.last_event_id
          FROM sessions AS session WHERE session.session_id = p_session_id;
        RETURN;
    END IF;

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
            execution_lease_expires_at = p_lease_expires_at,
            updated_at = p_acquired_at
         WHERE session.session_id = p_session_id
           AND p_expected_terminal_event_id IS NOT NULL
           AND session.termination_event_id = p_expected_terminal_event_id;
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
            execution_lease_expires_at = p_lease_expires_at,
            updated_at = p_acquired_at
         WHERE session.session_id = p_session_id
           AND session.termination_event_id IS NULL;
    END IF;
    GET DIAGNOSTICS v_row_count = ROW_COUNT;

    RETURN QUERY SELECT v_row_count = 1, session.execution_generation,
        session.execution_lease_expires_at, session.status,
        session.termination_reason, session.termination_detail,
        session.review_state, session.last_assistant_text,
        session.termination_event_id, session.updated_at, session.last_event_id
      FROM sessions AS session WHERE session.session_id = p_session_id;
END;
$$;
