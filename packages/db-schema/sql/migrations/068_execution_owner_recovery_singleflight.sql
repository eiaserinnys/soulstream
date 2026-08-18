-- 068: orphaned spawn handoff through the generation-fenced ownership ledger

CREATE OR REPLACE FUNCTION session_mark_execution_orphaned_spawn(
    p_session_id               TEXT,
    p_ownership_generation     BIGINT,
    p_registration_id          TEXT,
    p_pid                      INTEGER,
    p_start_identity           TEXT,
    p_execution_command_id     TEXT,
    p_updated_at               TIMESTAMPTZ
) RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE
    v_row_count INTEGER;
BEGIN
    IF p_registration_id IS NULL OR p_registration_id = ''
       OR p_pid IS NULL OR p_pid <= 0
       OR p_start_identity IS NULL OR p_start_identity = ''
       OR p_execution_command_id IS NULL OR p_execution_command_id = '' THEN
        RAISE EXCEPTION 'complete orphaned spawn identity required';
    END IF;
    UPDATE session_execution_ownerships
       SET registration_id = p_registration_id,
           pid = p_pid,
           start_identity = p_start_identity,
           execution_command_id = p_execution_command_id,
           phase = 'identity_proven',
           identity_proven_at = p_updated_at,
           reservation_expires_at = p_updated_at + INTERVAL '5 minutes',
           failure_reason = 'orphaned_spawn'
     WHERE session_id = p_session_id
       AND ownership_generation = p_ownership_generation
       AND phase = 'reserved'
       AND reservation_expires_at > p_updated_at;
    GET DIAGNOSTICS v_row_count = ROW_COUNT;
    RETURN v_row_count = 1;
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
            'reserved', p_updated_at, p_updated_at + INTERVAL '5 minutes'
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
               AND session.status IN ('completed', 'error', 'interrupted')
               AND session.termination_event_id IS NOT DISTINCT FROM p_expected_terminal_event_id;
        ELSE
            UPDATE sessions AS session
               SET status = 'running', termination_reason = NULL,
                   termination_detail = NULL, review_state = p_review_state,
                   updated_at = p_updated_at
             WHERE session.session_id = p_session_id
               AND session.status NOT IN ('completed', 'error', 'interrupted');
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
            IF p_terminal_resume THEN
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
