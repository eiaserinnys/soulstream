CREATE OR REPLACE FUNCTION session_expire_dead_execution_owner(
    p_session_id               TEXT,
    p_ownership_generation     BIGINT,
    p_pid                      INTEGER,
    p_start_identity           TEXT,
    p_failure_reason           TEXT,
    p_failed_at                TIMESTAMPTZ
) RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE
    v_row_count INTEGER;
BEGIN
    IF p_start_identity IS NULL OR p_start_identity = '' THEN
        RAISE EXCEPTION 'dead owner start identity required';
    END IF;

    UPDATE session_execution_ownerships
       SET phase = 'failed', failure_reason = p_failure_reason,
           terminal_at = p_failed_at, reservation_expires_at = NULL
     WHERE session_id = p_session_id
       AND ownership_generation = p_ownership_generation
       AND phase IN ('identity_proven', 'active')
       AND pid = p_pid
       AND start_identity = p_start_identity;
    GET DIAGNOSTICS v_row_count = ROW_COUNT;
    RETURN v_row_count = 1;
END;
$$;
