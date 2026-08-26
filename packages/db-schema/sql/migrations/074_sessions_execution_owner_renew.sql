-- V1 execution owner lease renewal. The caller supplies the complete owner
-- identity already acquired on sessions; a stale or expired owner updates no
-- row and cannot resurrect itself through the heartbeat path.

CREATE OR REPLACE FUNCTION session_renew_execution_ownership(
    p_session_id                 TEXT,
    p_ownership_generation       BIGINT,
    p_manifest_id                TEXT,
    p_runtime_env_identity       TEXT,
    p_registration_id            TEXT,
    p_pid                        INTEGER,
    p_start_identity             TEXT,
    p_execution_command_id       TEXT,
    p_lease_expires_at           TIMESTAMPTZ,
    p_renewed_at                 TIMESTAMPTZ
)
RETURNS TABLE(
    applied                      BOOLEAN,
    execution_generation         BIGINT,
    execution_lease_expires_at   TIMESTAMPTZ,
    status                       TEXT,
    termination_reason           TEXT,
    termination_detail           TEXT,
    review_state                 TEXT,
    last_assistant_text           TEXT,
    termination_event_id         INTEGER,
    updated_at                   TIMESTAMPTZ,
    last_event_id                INTEGER
)
LANGUAGE plpgsql
AS $$
DECLARE
    v_row_count INTEGER := 0;
BEGIN
    IF p_session_id IS NULL OR btrim(p_session_id) = ''
       OR p_ownership_generation IS NULL OR p_ownership_generation <= 0
       OR p_manifest_id IS NULL OR btrim(p_manifest_id) = ''
       OR p_runtime_env_identity IS NULL OR btrim(p_runtime_env_identity) = ''
       OR p_registration_id IS NULL OR btrim(p_registration_id) = ''
       OR p_pid IS NULL OR p_pid <= 0
       OR p_start_identity IS NULL OR btrim(p_start_identity) = ''
       OR p_execution_command_id IS NULL OR btrim(p_execution_command_id) = '' THEN
        RAISE EXCEPTION 'execution renew requires a complete owner identity';
    END IF;
    IF p_renewed_at IS NULL
       OR p_lease_expires_at IS NULL
       OR p_lease_expires_at <= p_renewed_at THEN
        RAISE EXCEPTION 'execution renew requires a future lease';
    END IF;

    UPDATE sessions AS session
       SET execution_lease_expires_at = p_lease_expires_at,
           updated_at = p_renewed_at
     WHERE session.session_id = p_session_id
       AND session.execution_generation = p_ownership_generation
       AND session.execution_manifest_id = p_manifest_id
       AND session.execution_runtime_env_identity = p_runtime_env_identity
       AND session.execution_registration_id = p_registration_id
       AND session.execution_pid = p_pid
       AND session.execution_start_identity = p_start_identity
       AND session.execution_command_id = p_execution_command_id
       AND session.execution_lease_expires_at > p_renewed_at;
    GET DIAGNOSTICS v_row_count = ROW_COUNT;

    RETURN QUERY
    SELECT v_row_count = 1,
           session.execution_generation,
           session.execution_lease_expires_at,
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
