ALTER TABLE sessions ADD COLUMN IF NOT EXISTS termination_event_id INTEGER;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_assistant_text TEXT;

UPDATE sessions AS session
   SET termination_event_id = terminal.id
  FROM (
    SELECT DISTINCT ON (session_id) session_id, id
      FROM events
     WHERE event_type = 'session_ended'
     ORDER BY session_id, id
  ) AS terminal
 WHERE session.session_id = terminal.session_id
   AND session.termination_event_id IS NULL;

UPDATE sessions
   SET last_assistant_text = last_message->>'preview'
 WHERE last_assistant_text IS NULL
   AND last_message->>'type' = 'assistant_message';

CREATE OR REPLACE FUNCTION session_apply_terminal_transition(
    p_session_id           TEXT,
    p_status               TEXT,
    p_termination_reason   TEXT,
    p_termination_detail   TEXT,
    p_review_state         TEXT,
    p_last_assistant_text  TEXT,
    p_terminal_event_id    INTEGER,
    p_updated_at           TIMESTAMPTZ
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    IF p_terminal_event_id IS NULL OR p_terminal_event_id <= 0 THEN
        RAISE EXCEPTION 'terminal event id must be a positive integer';
    END IF;

    UPDATE sessions
       SET status = CASE
               WHEN termination_event_id IS NULL THEN p_status
               ELSE status
           END,
           termination_reason = CASE
               WHEN termination_event_id IS NULL
               THEN p_termination_reason ELSE termination_reason
           END,
           termination_detail = CASE
               WHEN termination_event_id IS NULL
               THEN p_termination_detail ELSE termination_detail
           END,
           review_state = CASE
               WHEN termination_event_id IS NULL
               THEN p_review_state ELSE review_state
           END,
           last_assistant_text = CASE
               WHEN termination_event_id IS NULL
               THEN p_last_assistant_text ELSE last_assistant_text
           END,
           termination_event_id = CASE
               WHEN termination_event_id IS NULL
               THEN p_terminal_event_id ELSE termination_event_id
           END,
           updated_at = CASE
               WHEN termination_event_id IS NULL
               THEN p_updated_at ELSE updated_at
           END
     WHERE session_id = p_session_id;
END;
$$;

CREATE OR REPLACE FUNCTION session_apply_running_transition(
    p_session_id                 TEXT,
    p_review_state               TEXT,
    p_expected_terminal_event_id INTEGER,
    p_terminal_resume            BOOLEAN,
    p_updated_at                 TIMESTAMPTZ
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    IF p_terminal_resume THEN
        UPDATE sessions
           SET status = 'running',
               termination_reason = NULL,
               termination_detail = NULL,
               termination_event_id = NULL,
               last_assistant_text = NULL,
               review_state = p_review_state,
               updated_at = p_updated_at
         WHERE session_id = p_session_id
           AND status IN ('completed', 'error', 'interrupted')
           AND termination_event_id IS NOT DISTINCT FROM p_expected_terminal_event_id;
    ELSE
        UPDATE sessions
           SET status = 'running',
               termination_reason = NULL,
               termination_detail = NULL,
               review_state = p_review_state,
               updated_at = p_updated_at
         WHERE session_id = p_session_id
           AND status NOT IN ('completed', 'error');
    END IF;
END;
$$;
