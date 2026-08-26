-- Emergency rollback artifact. Do not include this file in the forward migration ledger.
-- It restores only the legacy reserve/adopt writers replaced by migration 073.

CREATE OR REPLACE FUNCTION session_reserve_execution_ownership(
    p_session_id               TEXT,
    p_ownership_generation     BIGINT,
    p_owner_kind               TEXT,
    p_manifest_id              TEXT,
    p_updated_at               TIMESTAMPTZ
) RETURNS TABLE (
    applied                    BOOLEAN,
    ownership_generation       BIGINT,
    status                     TEXT,
    termination_reason         TEXT,
    termination_detail         TEXT,
    review_state               TEXT,
    last_assistant_text        TEXT,
    termination_event_id       INTEGER,
    updated_at                 TIMESTAMPTZ,
    last_event_id              INTEGER
) LANGUAGE plpgsql AS $$
BEGIN
    IF p_owner_kind NOT IN ('runner_process', 'adopted_runner', 'in_process') THEN
        RAISE EXCEPTION 'unsupported execution owner kind: %', p_owner_kind;
    END IF;
    IF p_manifest_id IS NULL OR p_manifest_id = '' THEN
        RAISE EXCEPTION 'execution manifest id required';
    END IF;
    IF p_ownership_generation IS NULL OR p_ownership_generation <= 0 THEN
        RAISE EXCEPTION 'positive execution ownership generation required';
    END IF;

    PERFORM 1 FROM sessions WHERE session_id = p_session_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'session not found: %', p_session_id;
    END IF;

    UPDATE session_execution_ownerships
       SET phase = 'failed', failure_reason = 'reservation lease expired',
           terminal_at = p_updated_at, reservation_expires_at = NULL
     WHERE session_id = p_session_id
       AND phase IN ('reserved', 'identity_proven')
       AND reservation_expires_at <= p_updated_at;

    IF EXISTS (
        SELECT 1 FROM session_execution_ownerships
        WHERE session_id = p_session_id
          AND phase IN ('reserved', 'identity_proven', 'active')
    ) THEN
        RETURN QUERY
        SELECT FALSE, ownership.ownership_generation,
               session.status, session.termination_reason,
               session.termination_detail, session.review_state,
               session.last_assistant_text, session.termination_event_id,
               session.updated_at, session.last_event_id
        FROM sessions AS session
        JOIN LATERAL (
            SELECT candidate.ownership_generation
              FROM session_execution_ownerships AS candidate
             WHERE candidate.session_id = session.session_id
               AND candidate.phase IN ('reserved', 'identity_proven', 'active')
             ORDER BY CASE candidate.phase WHEN 'active' THEN 0 ELSE 1 END,
                      candidate.ownership_generation DESC
             LIMIT 1
        ) AS ownership ON TRUE
        WHERE session.session_id = p_session_id;
        RETURN;
    END IF;

    INSERT INTO session_execution_ownerships (
        session_id, ownership_generation, owner_kind, manifest_id,
        phase, reserved_at, reservation_expires_at
    ) VALUES (
        p_session_id, p_ownership_generation, p_owner_kind, p_manifest_id,
        'reserved', p_updated_at, p_updated_at + INTERVAL '60 seconds'
    );

    RETURN QUERY
    SELECT TRUE, p_ownership_generation,
           session.status, session.termination_reason,
           session.termination_detail, session.review_state,
           session.last_assistant_text, session.termination_event_id,
           session.updated_at, session.last_event_id
      FROM sessions AS session
     WHERE session.session_id = p_session_id;
END;
$$;

CREATE OR REPLACE FUNCTION session_reserve_execution_adoption(
    p_session_id               TEXT,
    p_ownership_generation     BIGINT,
    p_manifest_id              TEXT,
    p_previous_registration_id TEXT,
    p_pid                      INTEGER,
    p_start_identity           TEXT,
    p_execution_command_id     TEXT,
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
    v_row_count INTEGER := 0;
    v_previous_generation BIGINT;
BEGIN
    PERFORM 1 FROM sessions WHERE session_id = p_session_id FOR UPDATE;
    UPDATE session_execution_ownerships
       SET phase = 'failed', failure_reason = 'reservation lease expired',
           terminal_at = p_updated_at, reservation_expires_at = NULL
     WHERE session_id = p_session_id
       AND phase IN ('reserved', 'identity_proven')
       AND reservation_expires_at <= p_updated_at;
    SELECT ownership_generation
      INTO v_previous_generation
      FROM session_execution_ownerships
     WHERE session_id = p_session_id
       AND (
           phase = 'active'
           OR (
               phase = 'identity_proven'
               AND failure_reason = 'orphaned_spawn'
               AND reservation_expires_at > p_updated_at
           )
       )
       AND manifest_id = p_manifest_id
       AND registration_id = p_previous_registration_id
       AND pid = p_pid
       AND start_identity = p_start_identity
       AND execution_command_id = p_execution_command_id
     ORDER BY CASE phase WHEN 'active' THEN 0 ELSE 1 END
     LIMIT 1
     FOR UPDATE;
    IF FOUND AND NOT EXISTS (
        SELECT 1 FROM session_execution_ownerships
         WHERE session_id = p_session_id
           AND ownership_generation <> v_previous_generation
           AND phase IN ('reserved', 'identity_proven')
    ) THEN
        INSERT INTO session_execution_ownerships (
            session_id, ownership_generation, owner_kind, manifest_id,
            phase, reserved_at, reservation_expires_at
        ) VALUES (
            p_session_id, p_ownership_generation, 'adopted_runner', p_manifest_id,
            'reserved', p_updated_at, p_updated_at + INTERVAL '60 seconds'
        );
        v_row_count := 1;
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
