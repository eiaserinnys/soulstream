CREATE OR REPLACE FUNCTION session_retire_terminal_execution_ownership(
    p_session_id               TEXT,
    p_ownership_generation     BIGINT,
    p_manifest_id              TEXT,
    p_registration_id          TEXT,
    p_pid                      INTEGER,
    p_start_identity           TEXT,
    p_execution_command_id     TEXT,
    p_runner_fact              TEXT,
    p_retired_at               TIMESTAMPTZ
) RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE
    v_row_count INTEGER;
BEGIN
    IF p_ownership_generation IS NULL OR p_ownership_generation <= 0 THEN
        RAISE EXCEPTION 'ownership generation must be positive';
    END IF;
    IF p_manifest_id IS NULL OR p_manifest_id = ''
       OR p_registration_id IS NULL OR p_registration_id = ''
       OR p_pid IS NULL OR p_pid <= 0
       OR p_start_identity IS NULL OR p_start_identity = ''
       OR p_execution_command_id IS NULL OR p_execution_command_id = '' THEN
        RAISE EXCEPTION 'terminal ownership retirement requires complete identity';
    END IF;
    IF p_runner_fact NOT IN ('completed', 'failed', 'reaped', 'closed') THEN
        RAISE EXCEPTION 'unsupported runner terminal fact: %', p_runner_fact;
    END IF;
    IF p_retired_at IS NULL THEN
        RAISE EXCEPTION 'terminal ownership retirement timestamp is required';
    END IF;

    UPDATE session_execution_ownerships AS ownership
       SET phase = 'terminal',
           runner_fact = p_runner_fact,
           identity_proven_at = COALESCE(ownership.identity_proven_at, p_retired_at),
           terminal_at = p_retired_at,
           reservation_expires_at = NULL,
           failure_reason = NULL
     WHERE ownership.session_id = p_session_id
       AND ownership.ownership_generation = p_ownership_generation
       AND ownership.manifest_id = p_manifest_id
       AND ownership.registration_id = p_registration_id
       AND ownership.pid = p_pid
       AND ownership.start_identity = p_start_identity
       AND ownership.execution_command_id = p_execution_command_id
       AND ownership.phase IN ('reserved', 'identity_proven', 'active');
    GET DIAGNOSTICS v_row_count = ROW_COUNT;
    RETURN v_row_count = 1;
END;
$$;
