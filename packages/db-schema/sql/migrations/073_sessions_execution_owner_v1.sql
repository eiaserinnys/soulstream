ALTER TABLE sessions
    ADD COLUMN IF NOT EXISTS execution_generation BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS execution_manifest_id TEXT,
    ADD COLUMN IF NOT EXISTS execution_runtime_env_identity TEXT,
    ADD COLUMN IF NOT EXISTS execution_registration_id TEXT,
    ADD COLUMN IF NOT EXISTS execution_pid INTEGER,
    ADD COLUMN IF NOT EXISTS execution_start_identity TEXT,
    ADD COLUMN IF NOT EXISTS execution_command_id TEXT,
    ADD COLUMN IF NOT EXISTS execution_lease_expires_at TIMESTAMPTZ;

ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_execution_owner_all_or_none_check;
ALTER TABLE sessions ADD CONSTRAINT sessions_execution_owner_all_or_none_check
    CHECK (
        (
            execution_manifest_id IS NULL
            AND execution_runtime_env_identity IS NULL
            AND execution_registration_id IS NULL
            AND execution_pid IS NULL
            AND execution_start_identity IS NULL
            AND execution_command_id IS NULL
            AND execution_lease_expires_at IS NULL
        )
        OR
        (
            execution_manifest_id IS NOT NULL
            AND execution_runtime_env_identity IS NOT NULL
            AND execution_registration_id IS NOT NULL
            AND execution_pid IS NOT NULL
            AND execution_pid > 0
            AND execution_start_identity IS NOT NULL
            AND execution_command_id IS NOT NULL
            AND execution_lease_expires_at IS NOT NULL
        )
    );

CREATE OR REPLACE FUNCTION session_acquire_execution_ownership(
    p_session_id                 TEXT,
    p_manifest_id                TEXT,
    p_runtime_env_identity       TEXT,
    p_registration_id            TEXT,
    p_pid                        INTEGER,
    p_start_identity             TEXT,
    p_execution_command_id       TEXT,
    p_lease_expires_at           TIMESTAMPTZ,
    p_review_state               TEXT,
    p_expected_terminal_event_id INTEGER,
    p_terminal_resume            BOOLEAN,
    p_acquired_at                TIMESTAMPTZ
) RETURNS TABLE (
    applied                      BOOLEAN,
    execution_generation         BIGINT,
    execution_lease_expires_at   TIMESTAMPTZ,
    status                       TEXT,
    termination_reason           TEXT,
    termination_detail           TEXT,
    review_state                 TEXT,
    last_assistant_text          TEXT,
    termination_event_id         INTEGER,
    updated_at                   TIMESTAMPTZ,
    last_event_id                INTEGER
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

    SELECT * INTO v_session
      FROM sessions
     WHERE session_id = p_session_id
     FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'session not found: %', p_session_id;
    END IF;

    v_exact_identity := v_session.execution_manifest_id = p_manifest_id
        AND v_session.execution_runtime_env_identity = p_runtime_env_identity
        AND v_session.execution_registration_id = p_registration_id
        AND v_session.execution_pid = p_pid
        AND v_session.execution_start_identity = p_start_identity
        AND v_session.execution_command_id = p_execution_command_id;

    IF v_session.execution_manifest_id IS NOT NULL
       AND v_session.execution_lease_expires_at > p_acquired_at THEN
        IF v_exact_identity THEN
            UPDATE sessions AS session
               SET execution_lease_expires_at = p_lease_expires_at,
                   updated_at = p_acquired_at
             WHERE session.session_id = p_session_id;
            GET DIAGNOSTICS v_row_count = ROW_COUNT;
        END IF;
        RETURN QUERY
        SELECT v_exact_identity AND v_row_count = 1,
               session.execution_generation,
               session.execution_lease_expires_at,
               session.status, session.termination_reason,
               session.termination_detail, session.review_state,
               session.last_assistant_text, session.termination_event_id,
               session.updated_at, session.last_event_id
          FROM sessions AS session
         WHERE session.session_id = p_session_id;
        RETURN;
    END IF;

    -- Pre-cut legacy ownership drains in place. The sessions-row owner does
    -- not take over until every legacy row for this session is closed.
    IF EXISTS (
        SELECT 1
          FROM session_execution_ownerships
         WHERE session_id = p_session_id
           AND phase IN ('reserved', 'identity_proven', 'active')
    ) THEN
        RETURN QUERY
        SELECT FALSE, session.execution_generation,
               session.execution_lease_expires_at,
               session.status, session.termination_reason,
               session.termination_detail, session.review_state,
               session.last_assistant_text, session.termination_event_id,
               session.updated_at, session.last_event_id
          FROM sessions AS session
         WHERE session.session_id = p_session_id;
        RETURN;
    END IF;

    IF p_terminal_resume THEN
        UPDATE sessions AS session
           SET status = 'running', termination_reason = NULL,
               termination_detail = NULL, termination_event_id = NULL,
               last_assistant_text = NULL, review_state = p_review_state,
               execution_generation = session.execution_generation + 1,
               execution_manifest_id = p_manifest_id,
               execution_runtime_env_identity = p_runtime_env_identity,
               execution_registration_id = p_registration_id,
               execution_pid = p_pid,
               execution_start_identity = p_start_identity,
               execution_command_id = p_execution_command_id,
               execution_lease_expires_at = p_lease_expires_at,
               updated_at = p_acquired_at
         WHERE session.session_id = p_session_id
           AND session.status IN ('completed', 'error', 'interrupted')
           AND session.termination_event_id IS NOT DISTINCT FROM p_expected_terminal_event_id;
    ELSE
        UPDATE sessions AS session
           SET status = 'running', termination_reason = NULL,
               termination_detail = NULL, review_state = p_review_state,
               execution_generation = session.execution_generation + 1,
               execution_manifest_id = p_manifest_id,
               execution_runtime_env_identity = p_runtime_env_identity,
               execution_registration_id = p_registration_id,
               execution_pid = p_pid,
               execution_start_identity = p_start_identity,
               execution_command_id = p_execution_command_id,
               execution_lease_expires_at = p_lease_expires_at,
               updated_at = p_acquired_at
         WHERE session.session_id = p_session_id
           AND session.status NOT IN ('completed', 'error', 'interrupted');
    END IF;
    GET DIAGNOSTICS v_row_count = ROW_COUNT;

    IF v_row_count = 1 AND p_terminal_resume THEN
        UPDATE session_deliveries
           SET state = 'superseded', aggregate_state = 'consumed',
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

    RETURN QUERY
    SELECT v_row_count = 1, session.execution_generation,
           session.execution_lease_expires_at,
           session.status, session.termination_reason,
           session.termination_detail, session.review_state,
           session.last_assistant_text, session.termination_event_id,
           session.updated_at, session.last_event_id
      FROM sessions AS session
     WHERE session.session_id = p_session_id;
END;
$$;

-- V1 rolling compatibility is drain-only: old binaries may advance pre-cut
-- rows, but reserve/adopt may never create a new legacy owner after this cut.
CREATE OR REPLACE FUNCTION session_reserve_execution_ownership(
    p_session_id TEXT, p_ownership_generation BIGINT, p_owner_kind TEXT,
    p_manifest_id TEXT, p_updated_at TIMESTAMPTZ
) RETURNS TABLE (
    applied BOOLEAN, ownership_generation BIGINT, status TEXT,
    termination_reason TEXT, termination_detail TEXT, review_state TEXT,
    last_assistant_text TEXT, termination_event_id INTEGER,
    updated_at TIMESTAMPTZ, last_event_id INTEGER
) LANGUAGE plpgsql AS $$
BEGIN
    PERFORM 1 FROM sessions WHERE session_id = p_session_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'session not found: %', p_session_id; END IF;
    RETURN QUERY
    SELECT FALSE,
           COALESCE(ownership.ownership_generation, p_ownership_generation),
           session.status, session.termination_reason,
           session.termination_detail, session.review_state,
           session.last_assistant_text, session.termination_event_id,
           session.updated_at, session.last_event_id
      FROM sessions AS session
      LEFT JOIN LATERAL (
          SELECT candidate.ownership_generation
            FROM session_execution_ownerships AS candidate
           WHERE candidate.session_id = session.session_id
             AND candidate.phase IN ('reserved', 'identity_proven', 'active')
           ORDER BY candidate.ownership_generation DESC LIMIT 1
      ) AS ownership ON TRUE
     WHERE session.session_id = p_session_id;
END;
$$;

CREATE OR REPLACE FUNCTION session_reserve_execution_adoption(
    p_session_id TEXT, p_ownership_generation BIGINT, p_manifest_id TEXT,
    p_previous_registration_id TEXT, p_pid INTEGER, p_start_identity TEXT,
    p_execution_command_id TEXT, p_updated_at TIMESTAMPTZ
) RETURNS TABLE (
    applied BOOLEAN, status TEXT, termination_reason TEXT,
    termination_detail TEXT, review_state TEXT, last_assistant_text TEXT,
    termination_event_id INTEGER, updated_at TIMESTAMPTZ,
    last_event_id INTEGER
) LANGUAGE plpgsql AS $$
BEGIN
    PERFORM 1 FROM sessions WHERE session_id = p_session_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'session not found: %', p_session_id; END IF;
    RETURN QUERY
    SELECT FALSE, session.status, session.termination_reason,
           session.termination_detail, session.review_state,
           session.last_assistant_text, session.termination_event_id,
           session.updated_at, session.last_event_id
      FROM sessions AS session
     WHERE session.session_id = p_session_id;
END;
$$;
