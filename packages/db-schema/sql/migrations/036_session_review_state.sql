ALTER TABLE sessions ADD COLUMN IF NOT EXISTS review_required BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS review_state TEXT NOT NULL DEFAULT 'not_required';

ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_review_state_check;
ALTER TABLE sessions ADD CONSTRAINT sessions_review_state_check
    CHECK (review_state IN ('not_required', 'needs_review', 'acknowledged'));

DROP FUNCTION IF EXISTS session_register_with_review(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, BOOLEAN, BOOLEAN, TEXT);
CREATE OR REPLACE FUNCTION session_register_with_review(
    p_session_id        TEXT,
    p_node_id           TEXT,
    p_agent_id          TEXT,
    p_claude_session_id TEXT,
    p_session_type      TEXT,
    p_prompt            TEXT,
    p_client_id         TEXT,
    p_status            TEXT,
    p_created_at        TIMESTAMPTZ,
    p_updated_at        TIMESTAMPTZ,
    p_caller_session_id TEXT,
    p_notify_completion BOOLEAN,
    p_review_required   BOOLEAN,
    p_review_state      TEXT
) RETURNS void LANGUAGE sql AS $$
    INSERT INTO sessions (
        session_id, node_id, agent_id, claude_session_id,
        session_type, prompt, client_id, status,
        created_at, updated_at, caller_session_id, notify_completion,
        review_required, review_state
    ) VALUES (
        p_session_id, p_node_id, p_agent_id, p_claude_session_id,
        p_session_type, p_prompt, p_client_id, p_status,
        p_created_at, p_updated_at, p_caller_session_id,
        COALESCE(p_notify_completion, TRUE),
        COALESCE(p_review_required, FALSE),
        COALESCE(p_review_state, 'not_required')
    );
$$;

CREATE OR REPLACE FUNCTION session_acknowledge_review(
    p_session_id TEXT,
    p_updated_at TIMESTAMPTZ
) RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE
    v_review_required BOOLEAN;
    v_review_state TEXT;
BEGIN
    SELECT review_required, review_state
      INTO v_review_required, v_review_state
      FROM sessions
     WHERE session_id = p_session_id
     FOR UPDATE;

    IF NOT FOUND THEN RETURN 'not_found';
    ELSIF NOT v_review_required THEN RETURN 'not_required';
    ELSIF v_review_state = 'acknowledged' THEN RETURN 'already_acknowledged';
    ELSIF v_review_state <> 'needs_review' THEN RETURN 'not_pending';
    END IF;

    UPDATE sessions
       SET review_state = 'acknowledged', updated_at = p_updated_at
     WHERE session_id = p_session_id;
    RETURN 'acknowledged';
END;
$$;

CREATE OR REPLACE FUNCTION session_update(
    p_session_id TEXT,
    p_columns    TEXT[],
    p_values     TEXT[],
    p_updated_at TIMESTAMPTZ
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
    allowed TEXT[] := ARRAY[
        'folder_id', 'display_name', 'status',
        'prompt', 'client_id', 'last_message',
        'metadata', 'was_running_at_shutdown',
        'last_event_id', 'last_read_event_id',
        'termination_reason', 'termination_detail', 'review_state'
    ];
    set_list  TEXT;
    i         INTEGER;
    col       TEXT;
    jsonb_cols TEXT[] := ARRAY['last_message', 'metadata'];
    bool_cols  TEXT[] := ARRAY['was_running_at_shutdown'];
    int_cols   TEXT[] := ARRAY['last_event_id', 'last_read_event_id'];
BEGIN
    FOR i IN 1..array_length(p_columns, 1) LOOP
        IF NOT (p_columns[i] = ANY(allowed)) THEN
            RAISE EXCEPTION 'Invalid or immutable session column: %', p_columns[i];
        END IF;
    END LOOP;

    set_list := 'updated_at = ' || quote_literal(p_updated_at::text) || '::timestamptz';
    FOR i IN 1..array_length(p_columns, 1) LOOP
        col := p_columns[i];
        IF p_values[i] IS NULL THEN
            set_list := set_list || ', ' || col || ' = NULL';
        ELSIF col = ANY(jsonb_cols) THEN
            set_list := set_list || ', ' || col || ' = ' || quote_literal(p_values[i]) || '::jsonb';
        ELSIF col = ANY(bool_cols) THEN
            set_list := set_list || ', ' || col || ' = ' || p_values[i] || '::boolean';
        ELSIF col = ANY(int_cols) THEN
            set_list := set_list || ', ' || col || ' = ' || p_values[i] || '::integer';
        ELSE
            set_list := set_list || ', ' || col || ' = ' || quote_literal(p_values[i]);
        END IF;
    END LOOP;

    EXECUTE format(
        'UPDATE sessions SET %s WHERE session_id = %s',
        set_list, quote_literal(p_session_id)
    );
END;
$$;
