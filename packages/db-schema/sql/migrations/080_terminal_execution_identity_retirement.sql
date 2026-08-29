CREATE OR REPLACE FUNCTION session_retire_recorded_terminal_execution_identity(
    p_session_id               TEXT,
    p_ownership_generation     BIGINT,
    p_manifest_id              TEXT,
    p_runtime_env_identity     TEXT,
    p_registration_id          TEXT,
    p_pid                      INTEGER,
    p_start_identity           TEXT,
    p_execution_command_id     TEXT,
    p_terminal_event_id        INTEGER
) RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE
    v_row_count INTEGER;
    v_already_retired BOOLEAN;
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
        RAISE EXCEPTION 'terminal execution retirement requires complete identity';
    END IF;
    IF p_terminal_event_id IS NULL OR p_terminal_event_id <= 0 THEN
        RAISE EXCEPTION 'terminal execution retirement requires a terminal receipt';
    END IF;

    UPDATE sessions AS session
       SET execution_manifest_id = NULL,
           execution_runtime_env_identity = NULL,
           execution_registration_id = NULL,
           execution_pid = NULL,
           execution_start_identity = NULL,
           execution_command_id = NULL,
           execution_lease_expires_at = NULL
     WHERE session.session_id = p_session_id
       AND session.status IN ('completed', 'error', 'interrupted')
       AND session.termination_event_id = p_terminal_event_id
       AND session.execution_generation = p_ownership_generation
       AND session.execution_manifest_id = p_manifest_id
       AND session.execution_runtime_env_identity = p_runtime_env_identity
       AND session.execution_registration_id = p_registration_id
       AND session.execution_pid = p_pid
       AND session.execution_start_identity = p_start_identity
       AND session.execution_command_id = p_execution_command_id;
    GET DIAGNOSTICS v_row_count = ROW_COUNT;
    IF v_row_count = 1 THEN
        RETURN TRUE;
    END IF;

    SELECT EXISTS (
        SELECT 1
          FROM sessions AS session
         WHERE session.session_id = p_session_id
           AND session.status IN ('completed', 'error', 'interrupted')
           AND session.termination_event_id = p_terminal_event_id
           AND session.execution_generation = p_ownership_generation
           AND session.execution_manifest_id IS NULL
           AND session.execution_runtime_env_identity IS NULL
           AND session.execution_registration_id IS NULL
           AND session.execution_pid IS NULL
           AND session.execution_start_identity IS NULL
           AND session.execution_command_id IS NULL
           AND session.execution_lease_expires_at IS NULL
    ) INTO v_already_retired;
    RETURN v_already_retired;
END;
$$;
