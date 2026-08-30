CREATE OR REPLACE FUNCTION session_acquire_execution_ownership(
    p_session_id TEXT, p_manifest_id TEXT, p_runtime_env_identity TEXT,
    p_registration_id TEXT, p_pid INTEGER, p_start_identity TEXT,
    p_execution_command_id TEXT, p_lease_expires_at TIMESTAMPTZ,
    p_review_state TEXT, p_expected_terminal_event_id INTEGER,
    p_terminal_resume BOOLEAN, p_acquired_at TIMESTAMPTZ,
    p_delivery_id TEXT, p_delivery_lease_owner TEXT,
    p_previous_execution_generation BIGINT,
    p_previous_execution_command_id TEXT
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
    v_handoff BOOLEAN := FALSE;
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
    IF (p_delivery_id IS NULL) <> (p_delivery_lease_owner IS NULL) THEN
        RAISE EXCEPTION 'delivery id and claim owner must be supplied together';
    END IF;
    IF (p_previous_execution_generation IS NULL)
       <> (p_previous_execution_command_id IS NULL) THEN
        RAISE EXCEPTION 'previous execution generation and command must be supplied together';
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

    IF p_delivery_id IS NOT NULL THEN
        PERFORM 1
          FROM session_deliveries AS delivery
         WHERE delivery.delivery_id = p_delivery_id
           AND delivery.target_session_id = p_session_id
           AND delivery.aggregate_state IN ('pending', 'delivered')
           AND delivery.state IN ('claimed', 'dispatching', 'queued', 'delivered')
           AND delivery.lease_owner IN (p_delivery_lease_owner, p_execution_command_id)
         FOR UPDATE;
        IF NOT FOUND THEN
            RETURN QUERY SELECT FALSE, session.execution_generation,
                session.execution_lease_expires_at, session.status,
                session.termination_reason, session.termination_detail,
                session.review_state, session.last_assistant_text,
                session.termination_event_id, session.updated_at, session.last_event_id
              FROM sessions AS session WHERE session.session_id = p_session_id;
            RETURN;
        END IF;
    END IF;

    v_handoff := p_previous_execution_generation IS NOT NULL
        AND p_delivery_id IS NOT NULL
        AND v_session.execution_generation = p_previous_execution_generation
        AND v_session.execution_command_id = p_previous_execution_command_id
        AND v_session.status NOT IN ('completed', 'error', 'interrupted');

    IF v_session.execution_manifest_id IS NOT NULL
       AND v_session.execution_lease_expires_at > p_acquired_at
       AND NOT v_handoff THEN
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

    IF v_handoff THEN
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
           AND session.execution_generation = p_previous_execution_generation
           AND session.execution_command_id = p_previous_execution_command_id
           AND session.status NOT IN ('completed', 'error', 'interrupted');
    ELSIF p_terminal_resume THEN
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
           AND session.status IN ('completed', 'error', 'interrupted')
           AND session.termination_event_id IS NOT DISTINCT FROM p_expected_terminal_event_id;
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
           AND session.status NOT IN ('completed', 'error', 'interrupted');
    END IF;
    GET DIAGNOSTICS v_row_count = ROW_COUNT;

    IF v_row_count = 1 AND p_delivery_id IS NOT NULL THEN
        UPDATE session_deliveries AS delivery SET
            state = CASE WHEN delivery.state = 'delivered' THEN 'delivered' ELSE 'queued' END,
            aggregate_state = CASE
                WHEN delivery.aggregate_state = 'delivered' THEN 'delivered'
                ELSE 'pending'
            END,
            queued_at = COALESCE(delivery.queued_at, p_acquired_at),
            lease_owner = p_execution_command_id,
            lease_expires_at = NULL,
            updated_at = p_acquired_at
         WHERE delivery.delivery_id = p_delivery_id
           AND delivery.target_session_id = p_session_id
           AND delivery.aggregate_state IN ('pending', 'delivered')
           AND delivery.state IN ('claimed', 'dispatching', 'queued', 'delivered')
           AND delivery.lease_owner IN (p_delivery_lease_owner, p_execution_command_id);
        GET DIAGNOSTICS v_row_count = ROW_COUNT;
        IF v_row_count <> 1 THEN
            RAISE EXCEPTION 'delivery claim changed during execution acquisition';
        END IF;
    END IF;

    IF v_row_count = 1 AND p_terminal_resume THEN
        UPDATE session_deliveries SET
            state = 'superseded', aggregate_state = 'consumed',
            consumed_at = p_acquired_at,
            consumed_reason = 'superseded by terminal resume',
            superseded_at = p_acquired_at,
            superseded_terminal_revision = p_expected_terminal_event_id::text,
            lease_owner = NULL, lease_expires_at = NULL,
            updated_at = p_acquired_at
         WHERE source_session_id = p_session_id
           AND intent = 'completion_notification'
           AND source = 'completion_notifier'
           AND producer_kind = 'child_session'
           AND producer_terminal_revision = p_expected_terminal_event_id::text
           AND state IN ('pending', 'claimed', 'dispatching', 'queued');
    END IF;

    RETURN QUERY SELECT v_row_count = 1, session.execution_generation,
        session.execution_lease_expires_at, session.status,
        session.termination_reason, session.termination_detail,
        session.review_state, session.last_assistant_text,
        session.termination_event_id, session.updated_at, session.last_event_id
      FROM sessions AS session WHERE session.session_id = p_session_id;
END;
$$;

DROP FUNCTION IF EXISTS session_acquire_execution_ownership(
    TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT, TIMESTAMPTZ,
    TEXT, INTEGER, BOOLEAN, TIMESTAMPTZ
);
