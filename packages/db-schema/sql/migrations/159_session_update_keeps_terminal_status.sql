-- 159: session_update no longer revives a finished session (card #1315)
--
-- session_update accepts `status` as a column and had no state check, so a
-- generic update could write status = 'running' onto a completed, error or
-- interrupted row. Resuming a finished session goes through the state machine
-- functions (session_record_execution_registration, session_apply_running_transition
-- and the startup reconcile restore), not through this generic update.
-- When the call asks for status = 'running' and the row is already terminal, the
-- call returns without changing the row: no column of that call is written,
-- including updated_at. Every other call behaves as before.
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
    writes_running BOOLEAN := FALSE;
    current_status TEXT;
BEGIN
    -- 화이트리스트 검증 (불변 필드는 화이트리스트에 없음)
    FOR i IN 1..array_length(p_columns, 1) LOOP
        IF NOT (p_columns[i] = ANY(allowed)) THEN
            RAISE EXCEPTION 'Invalid or immutable session column: %', p_columns[i];
        END IF;
        IF p_columns[i] = 'status' AND p_values[i] = 'running' THEN
            writes_running := TRUE;
        END IF;
    END LOOP;

    -- 종료 줄은 범용 갱신으로 running으로 되살리지 않는다 (줄을 바꾸지 않고 끝낸다)
    IF writes_running THEN
        SELECT status INTO current_status
          FROM sessions
         WHERE session_id = p_session_id
         FOR UPDATE;
        IF current_status IN ('completed', 'error', 'interrupted') THEN
            RETURN;
        END IF;
    END IF;

    -- UPDATE SET 생성
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
