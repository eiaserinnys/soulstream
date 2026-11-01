ALTER TABLE events ALTER COLUMN searchable_text SET DEFAULT '';

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM pg_attribute
        WHERE attrelid = 'events'::regclass
          AND attname = 'searchable_text'
          AND NOT attnotnull
    ) THEN
        UPDATE events SET searchable_text = '' WHERE searchable_text IS NULL;
        ALTER TABLE events ALTER COLUMN searchable_text SET NOT NULL;
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION session_append_metadata(
    p_session_id      TEXT,
    p_metadata_json   TEXT,
    p_event_type      TEXT,
    p_event_payload   TEXT,
    p_searchable_text TEXT,
    p_now             TIMESTAMPTZ
) RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE
    v_event_id INTEGER;
BEGIN
    -- 행 잠금
    PERFORM session_id FROM sessions WHERE session_id = p_session_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Session not found: %', p_session_id;
    END IF;

    -- metadata JSONB 배열 append
    UPDATE sessions
    SET metadata = COALESCE(metadata, '[]'::jsonb) || p_metadata_json::jsonb,
        updated_at = p_now
    WHERE session_id = p_session_id;

    -- 이벤트 삽입
    INSERT INTO events (id, session_id, event_type, payload, searchable_text, created_at)
    VALUES (
        (SELECT COALESCE(MAX(id), 0) + 1 FROM events WHERE session_id = p_session_id),
        p_session_id, p_event_type, p_event_payload::jsonb, COALESCE(p_searchable_text, ''), p_now
    ) RETURNING id INTO v_event_id;

    -- last_event_id 갱신
    UPDATE sessions SET last_event_id = v_event_id WHERE session_id = p_session_id;

    RETURN v_event_id;
END;
$$;

CREATE OR REPLACE FUNCTION event_append(
    p_session_id      TEXT,
    p_event_type      TEXT,
    p_payload         TEXT,
    p_searchable_text TEXT,
    p_created_at      TIMESTAMPTZ,
    p_dedupe_key      TEXT DEFAULT NULL
) RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE
    v_event_id INTEGER;
    v_payload  JSONB := p_payload::jsonb;
    v_parent   INTEGER;
BEGIN
    -- payload에서 parent_event_id 추출. 다음 케이스는 모두 NULL로 떨어진다:
    --   1) 키 자체가 없는 경우
    --   2) 비정수 문자열 (tool_use_id 'toolu_...', UUID 등 — 의미가 다른 레거시 키)
    --   3) INTEGER 범위(1..2147483647) 밖의 값 (timestamp 등 잘못 들어간 값)
    -- 길이 가드 ^\d{1,10}$로 BIGINT 캐스트 자체의 overflow 차단, BIGINT 범위 비교로 INT 한계 검증.
    -- events.id가 INTEGER SERIAL이므로 진짜 ancestor의 ID는 항상 1..INT_MAX 범위에 있음.
    v_parent := CASE
        WHEN v_payload->>'parent_event_id' ~ '^\d{1,10}$'
             AND (v_payload->>'parent_event_id')::BIGINT BETWEEN 1 AND 2147483647
        THEN (v_payload->>'parent_event_id')::INTEGER
        ELSE NULL
    END;
    IF v_parent IS NOT NULL AND NOT EXISTS (
        SELECT 1
        FROM events e
        WHERE e.session_id = p_session_id
          AND e.id = v_parent
    ) THEN
        v_parent := NULL;
    END IF;

    -- 행 잠금으로 동시 append 직렬화
    PERFORM session_id FROM sessions WHERE session_id = p_session_id FOR UPDATE;

    IF p_dedupe_key IS NOT NULL THEN
        SELECT e.id INTO v_event_id
        FROM events e
        WHERE e.session_id = p_session_id
          AND e.dedupe_key = p_dedupe_key
        LIMIT 1;

        IF v_event_id IS NOT NULL THEN
            UPDATE sessions
            SET last_event_id = GREATEST(COALESCE(last_event_id, 0), v_event_id)
            WHERE session_id = p_session_id;
            RETURN v_event_id;
        END IF;
    END IF;

    INSERT INTO events (id, session_id, event_type, payload, searchable_text,
                        created_at, parent_event_id, dedupe_key)
    VALUES (
        (SELECT COALESCE(MAX(id), 0) + 1 FROM events WHERE session_id = p_session_id),
        p_session_id, p_event_type, v_payload, COALESCE(p_searchable_text, ''),
        p_created_at, v_parent, p_dedupe_key
    ) RETURNING id INTO v_event_id;

    UPDATE sessions SET last_event_id = v_event_id WHERE session_id = p_session_id;

    RETURN v_event_id;
END;
$$;
