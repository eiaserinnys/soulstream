DROP TRIGGER IF EXISTS trg_session_discard_notification_projection
    ON session_deliveries;
DROP FUNCTION IF EXISTS session_discard_notification_projection_on_consumed();
DROP FUNCTION IF EXISTS session_record_execution_registration(
    TEXT, TEXT, TEXT, TEXT, INTEGER, BOOLEAN, TIMESTAMPTZ
);
DROP FUNCTION IF EXISTS session_apply_running_transition(
    TEXT, TEXT, INTEGER, BOOLEAN, TIMESTAMPTZ
);

ALTER TABLE session_deliveries
    RENAME COLUMN lease_owner TO attempt_token;
ALTER TABLE session_deliveries
    RENAME COLUMN lease_expires_at TO attempt_expires_at;
ALTER TABLE session_delivery_notification_outbox
    RENAME COLUMN lease_owner TO attempt_token;
ALTER TABLE session_delivery_notification_outbox
    RENAME COLUMN lease_expires_at TO attempt_expires_at;
ALTER TABLE session_delivery_attempts
    RENAME COLUMN lease_owner TO attempt_token;

CREATE FUNCTION session_record_execution_registration(
    p_session_id                 TEXT,
    p_registration_id            TEXT,
    p_execution_command_id       TEXT,
    p_review_state               TEXT,
    p_expected_terminal_event_id INTEGER,
    p_terminal_resume            BOOLEAN,
    p_recorded_at                TIMESTAMPTZ
) RETURNS TABLE (
    applied                      BOOLEAN,
    execution_registration_id    TEXT,
    execution_command_id         TEXT,
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
    v_row_count INTEGER := 0;
BEGIN
    IF p_registration_id IS NULL OR p_registration_id = ''
       OR p_execution_command_id IS NULL OR p_execution_command_id = '' THEN
        RAISE EXCEPTION 'complete execution registration required';
    END IF;
    IF p_review_state NOT IN ('not_required', 'needs_review', 'acknowledged') THEN
        RAISE EXCEPTION 'unsupported review state: %', p_review_state;
    END IF;

    PERFORM 1 FROM sessions WHERE session_id = p_session_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'session not found: %', p_session_id;
    END IF;

    IF p_terminal_resume THEN
        UPDATE sessions AS session
           SET status = 'running',
               termination_reason = NULL,
               termination_detail = NULL,
               termination_event_id = NULL,
               last_assistant_text = NULL,
               review_state = p_review_state,
               execution_registration_id = p_registration_id,
               execution_command_id = p_execution_command_id,
               updated_at = p_recorded_at
         WHERE session.session_id = p_session_id
           AND session.status IN ('completed', 'error', 'interrupted')
           AND session.termination_event_id IS NOT DISTINCT FROM p_expected_terminal_event_id;
    ELSE
        UPDATE sessions AS session
           SET status = 'running',
               termination_reason = NULL,
               termination_detail = NULL,
               review_state = p_review_state,
               execution_registration_id = p_registration_id,
               execution_command_id = p_execution_command_id,
               updated_at = p_recorded_at
         WHERE session.session_id = p_session_id
           AND session.status NOT IN ('completed', 'error', 'interrupted');
    END IF;
    GET DIAGNOSTICS v_row_count = ROW_COUNT;

    IF v_row_count = 1 AND p_terminal_resume THEN
        UPDATE session_deliveries
           SET state = 'superseded',
               aggregate_state = 'consumed',
               consumed_at = p_recorded_at,
               consumed_reason = 'superseded by terminal resume',
               superseded_at = p_recorded_at,
               superseded_terminal_revision = p_expected_terminal_event_id::text,
               attempt_token = NULL,
               attempt_expires_at = NULL,
               updated_at = p_recorded_at
         WHERE source_session_id = p_session_id
           AND intent = 'completion_notification'
           AND source = 'completion_notifier'
           AND producer_kind = 'child_session'
           AND producer_terminal_revision = p_expected_terminal_event_id::text
           AND state IN ('pending', 'claimed', 'dispatching', 'queued');
    END IF;

    RETURN QUERY
    SELECT v_row_count = 1,
           session.execution_registration_id,
           session.execution_command_id,
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

CREATE FUNCTION session_apply_running_transition(
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
           AND session.status IN ('completed', 'error', 'interrupted')
           AND session.termination_event_id IS NOT DISTINCT FROM p_expected_terminal_event_id;
    ELSE
        UPDATE sessions AS session
           SET status = 'running',
               termination_reason = NULL,
               termination_detail = NULL,
               review_state = p_review_state,
               updated_at = p_updated_at
         WHERE session.session_id = p_session_id
           AND session.status NOT IN ('completed', 'error', 'interrupted');
    END IF;
    GET DIAGNOSTICS v_row_count = ROW_COUNT;

    IF p_terminal_resume AND v_row_count = 1 THEN
        UPDATE session_deliveries
           SET state = 'superseded',
               aggregate_state = 'consumed',
               consumed_at = p_updated_at,
               consumed_reason = 'superseded by terminal resume',
               superseded_at = p_updated_at,
               superseded_terminal_revision = p_expected_terminal_event_id::text,
               attempt_token = NULL,
               attempt_expires_at = NULL,
               updated_at = p_updated_at
         WHERE source_session_id = p_session_id
           AND intent = 'completion_notification'
           AND source = 'completion_notifier'
           AND producer_kind = 'child_session'
           AND producer_terminal_revision = p_expected_terminal_event_id::text
           AND state IN ('pending', 'claimed', 'dispatching', 'queued');
    END IF;

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

CREATE FUNCTION session_discard_notification_projection_on_consumed()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.aggregate_state = 'consumed'
       AND OLD.aggregate_state IS DISTINCT FROM NEW.aggregate_state THEN
        UPDATE session_delivery_notification_outbox
           SET state = 'dead_letter',
               projection_state = 'discarded',
               attempt_token = NULL,
               attempt_expires_at = NULL,
               last_error = 'delivery aggregate consumed before notification projection',
               dead_lettered_at = COALESCE(dead_lettered_at, NOW()),
               updated_at = NOW()
         WHERE delivery_id = NEW.delivery_id
           AND state IN ('pending', 'claimed');
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_session_discard_notification_projection
AFTER UPDATE OF aggregate_state ON session_deliveries
FOR EACH ROW
EXECUTE FUNCTION session_discard_notification_projection_on_consumed();
