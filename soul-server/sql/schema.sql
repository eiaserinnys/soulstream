-- schema.sql — DDL 정본 파일
-- 모든 테이블, 인덱스, 트리거, 함수를 멱등하게 정의한다.
-- CREATE OR REPLACE / IF NOT EXISTS로 반복 실행 가능.

-- ============================================================
-- 1. 테이블
-- ============================================================

CREATE TABLE IF NOT EXISTS folders (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    sort_order  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
    session_id              TEXT PRIMARY KEY,
    folder_id               TEXT REFERENCES folders(id),
    display_name            TEXT,
    node_id                 TEXT,
    session_type            TEXT,
    status                  TEXT,
    prompt                  TEXT,
    client_id               TEXT,
    claude_session_id       TEXT,
    last_message            JSONB,
    metadata                JSONB,
    was_running_at_shutdown BOOLEAN DEFAULT FALSE,
    last_event_id           INTEGER,
    last_read_event_id      INTEGER,
    created_at              TIMESTAMPTZ DEFAULT NOW(),
    updated_at              TIMESTAMPTZ DEFAULT NOW(),
    agent_id                VARCHAR
);

CREATE TABLE IF NOT EXISTS events (
    session_id      TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    id              INTEGER NOT NULL,
    event_type      TEXT NOT NULL,
    payload         JSONB,
    searchable_text TEXT,
    search_vector   TSVECTOR,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (session_id, id)
);

-- ============================================================
-- 2. 인덱스
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_events_session_id_id ON events (session_id, id);
CREATE INDEX IF NOT EXISTS idx_events_search_vector ON events USING GIN (search_vector);

-- ============================================================
-- 3. 트리거 (search_vector 자동 갱신)
-- ============================================================

CREATE OR REPLACE FUNCTION update_search_vector() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.searchable_text IS NOT NULL AND NEW.searchable_text != '' THEN
        NEW.search_vector := to_tsvector('simple', NEW.searchable_text);
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_events_search_vector ON events;
CREATE TRIGGER trg_events_search_vector
    BEFORE INSERT OR UPDATE OF searchable_text ON events
    FOR EACH ROW EXECUTE FUNCTION update_search_vector();

-- ============================================================
-- 4. 프로시저/함수
-- ============================================================

-- 세션 도메인 --------------------------------------------------

-- 1. session_upsert
CREATE OR REPLACE FUNCTION session_upsert(
    p_session_id  TEXT,
    p_columns     TEXT[],
    p_values      TEXT[],
    p_created_at  TIMESTAMPTZ,
    p_updated_at  TIMESTAMPTZ
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
    allowed TEXT[] := ARRAY[
        'folder_id', 'display_name', 'session_type', 'status',
        'prompt', 'client_id', 'claude_session_id', 'last_message',
        'metadata', 'was_running_at_shutdown',
        'last_event_id', 'last_read_event_id',
        'created_at', 'updated_at', 'node_id', 'agent_id'
    ];
    col_list  TEXT;
    val_list  TEXT;
    set_list  TEXT;
    i         INTEGER;
    col       TEXT;
    jsonb_cols TEXT[] := ARRAY['last_message', 'metadata'];
    bool_cols  TEXT[] := ARRAY['was_running_at_shutdown'];
    int_cols   TEXT[] := ARRAY['last_event_id', 'last_read_event_id'];
    ts_cols    TEXT[] := ARRAY['created_at', 'updated_at'];
BEGIN
    -- 화이트리스트 검증
    FOR i IN 1..array_length(p_columns, 1) LOOP
        IF NOT (p_columns[i] = ANY(allowed)) THEN
            RAISE EXCEPTION 'Invalid session column: %', p_columns[i];
        END IF;
    END LOOP;

    -- INSERT 컬럼/값 생성: session_id + created_at + updated_at + 동적 컬럼
    col_list := 'session_id, created_at, updated_at';
    val_list := quote_literal(p_session_id) || ', ' ||
                quote_literal(p_created_at::text) || '::timestamptz, ' ||
                quote_literal(p_updated_at::text) || '::timestamptz';

    FOR i IN 1..array_length(p_columns, 1) LOOP
        col := p_columns[i];
        col_list := col_list || ', ' || col;

        IF p_values[i] IS NULL THEN
            val_list := val_list || ', NULL';
        ELSIF col = ANY(jsonb_cols) THEN
            val_list := val_list || ', ' || quote_literal(p_values[i]) || '::jsonb';
        ELSIF col = ANY(bool_cols) THEN
            val_list := val_list || ', ' || p_values[i] || '::boolean';
        ELSIF col = ANY(int_cols) THEN
            val_list := val_list || ', ' || p_values[i] || '::integer';
        ELSIF col = ANY(ts_cols) THEN
            val_list := val_list || ', ' || quote_literal(p_values[i]) || '::timestamptz';
        ELSE
            val_list := val_list || ', ' || quote_literal(p_values[i]);
        END IF;
    END LOOP;

    -- UPDATE SET 생성: session_id, created_at 제외
    set_list := 'updated_at = EXCLUDED.updated_at';
    FOR i IN 1..array_length(p_columns, 1) LOOP
        col := p_columns[i];
        IF col NOT IN ('created_at') THEN
            set_list := set_list || ', ' || col || ' = EXCLUDED.' || col;
        END IF;
    END LOOP;

    EXECUTE format(
        'INSERT INTO sessions (%s) VALUES (%s) ON CONFLICT (session_id) DO UPDATE SET %s',
        col_list, val_list, set_list
    );
END;
$$;

-- 2. session_get
CREATE OR REPLACE FUNCTION session_get(
    p_session_id TEXT
) RETURNS SETOF sessions LANGUAGE sql STABLE AS $$
    SELECT * FROM sessions WHERE session_id = p_session_id;
$$;

-- 3. session_get_all
CREATE OR REPLACE FUNCTION session_get_all(
    p_filters JSONB DEFAULT NULL,
    p_limit   INTEGER DEFAULT NULL,
    p_offset  INTEGER DEFAULT NULL
) RETURNS SETOF sessions LANGUAGE plpgsql STABLE AS $$
DECLARE
    q TEXT := 'SELECT * FROM sessions WHERE TRUE';
BEGIN
    IF p_filters IS NOT NULL AND p_filters ? 'session_type' THEN
        q := q || ' AND session_type = ' || quote_literal(p_filters->>'session_type');
    END IF;
    IF p_filters IS NOT NULL AND p_filters ? 'folder_id' THEN
        q := q || ' AND folder_id = ' || quote_literal(p_filters->>'folder_id');
    END IF;
    IF p_filters IS NOT NULL AND p_filters ? 'node_id' THEN
        q := q || ' AND node_id = ' || quote_literal(p_filters->>'node_id');
    END IF;
    IF p_filters IS NOT NULL AND p_filters ? 'status' THEN
        IF jsonb_typeof(p_filters->'status') = 'array' THEN
            q := q || ' AND status IN (' ||
                (SELECT string_agg(quote_literal(elem), ', ')
                 FROM jsonb_array_elements_text(p_filters->'status') AS elem) || ')';
        ELSE
            q := q || ' AND status = ' || quote_literal(p_filters->>'status');
        END IF;
    END IF;

    q := q || ' ORDER BY updated_at DESC';

    IF p_limit IS NOT NULL THEN
        q := q || ' LIMIT ' || p_limit;
    END IF;
    IF p_offset IS NOT NULL AND p_offset > 0 THEN
        q := q || ' OFFSET ' || p_offset;
    END IF;

    RETURN QUERY EXECUTE q;
END;
$$;

-- 4. session_count
CREATE OR REPLACE FUNCTION session_count(
    p_filters JSONB DEFAULT NULL
) RETURNS BIGINT LANGUAGE plpgsql STABLE AS $$
DECLARE
    q TEXT := 'SELECT COUNT(*) FROM sessions WHERE TRUE';
    result BIGINT;
BEGIN
    IF p_filters IS NOT NULL AND p_filters ? 'session_type' THEN
        q := q || ' AND session_type = ' || quote_literal(p_filters->>'session_type');
    END IF;
    IF p_filters IS NOT NULL AND p_filters ? 'folder_id' THEN
        q := q || ' AND folder_id = ' || quote_literal(p_filters->>'folder_id');
    END IF;
    IF p_filters IS NOT NULL AND p_filters ? 'node_id' THEN
        q := q || ' AND node_id = ' || quote_literal(p_filters->>'node_id');
    END IF;
    IF p_filters IS NOT NULL AND p_filters ? 'status' THEN
        IF jsonb_typeof(p_filters->'status') = 'array' THEN
            q := q || ' AND status IN (' ||
                (SELECT string_agg(quote_literal(elem), ', ')
                 FROM jsonb_array_elements_text(p_filters->'status') AS elem) || ')';
        ELSE
            q := q || ' AND status = ' || quote_literal(p_filters->>'status');
        END IF;
    END IF;

    EXECUTE q INTO result;
    RETURN result;
END;
$$;

-- 5. session_delete
CREATE OR REPLACE FUNCTION session_delete(
    p_session_id TEXT
) RETURNS void LANGUAGE sql AS $$
    DELETE FROM sessions WHERE session_id = p_session_id;
$$;

-- 6. session_append_metadata
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
        p_session_id, p_event_type, p_event_payload::jsonb, p_searchable_text, p_now
    ) RETURNING id INTO v_event_id;

    -- last_event_id 갱신
    UPDATE sessions SET last_event_id = v_event_id WHERE session_id = p_session_id;

    RETURN v_event_id;
END;
$$;

-- 7. session_update_last_message
CREATE OR REPLACE FUNCTION session_update_last_message(
    p_session_id   TEXT,
    p_last_message TEXT,
    p_updated_at   TIMESTAMPTZ
) RETURNS void LANGUAGE sql AS $$
    UPDATE sessions
    SET last_message = p_last_message::jsonb, updated_at = p_updated_at
    WHERE session_id = p_session_id;
$$;

-- 8. session_update_read_position
CREATE OR REPLACE FUNCTION session_update_read_position(
    p_session_id         TEXT,
    p_last_read_event_id INTEGER
) RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE
    result TEXT;
BEGIN
    UPDATE sessions SET last_read_event_id = p_last_read_event_id
    WHERE session_id = p_session_id;
    GET DIAGNOSTICS result = ROW_COUNT;
    RETURN 'UPDATE ' || result;
END;
$$;

-- 9. session_get_read_position
CREATE OR REPLACE FUNCTION session_get_read_position(
    p_session_id TEXT
) RETURNS TABLE(last_event_id INTEGER, last_read_event_id INTEGER)
LANGUAGE sql STABLE AS $$
    SELECT last_event_id, last_read_event_id
    FROM sessions WHERE session_id = p_session_id;
$$;

-- 10. session_rename
CREATE OR REPLACE FUNCTION session_rename(
    p_session_id   TEXT,
    p_display_name TEXT
) RETURNS void LANGUAGE sql AS $$
    UPDATE sessions SET display_name = p_display_name WHERE session_id = p_session_id;
$$;

-- 11. session_assign_folder
CREATE OR REPLACE FUNCTION session_assign_folder(
    p_session_id TEXT,
    p_folder_id  TEXT
) RETURNS void LANGUAGE sql AS $$
    UPDATE sessions SET folder_id = p_folder_id WHERE session_id = p_session_id;
$$;

-- Graceful Shutdown -----------------------------------------------

-- 12. shutdown_mark_running
CREATE OR REPLACE FUNCTION shutdown_mark_running(
    p_session_ids TEXT[] DEFAULT NULL
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    IF p_session_ids IS NULL THEN
        UPDATE sessions SET was_running_at_shutdown = TRUE WHERE status = 'running';
    ELSIF array_length(p_session_ids, 1) IS NULL THEN
        -- 빈 배열: no-op
        RETURN;
    ELSE
        UPDATE sessions SET was_running_at_shutdown = TRUE
        WHERE session_id = ANY(p_session_ids);
    END IF;
END;
$$;

-- 13. shutdown_get_sessions
CREATE OR REPLACE FUNCTION shutdown_get_sessions(p_node_id TEXT DEFAULT NULL)
RETURNS SETOF sessions LANGUAGE sql STABLE AS $$
    SELECT * FROM sessions
    WHERE was_running_at_shutdown = TRUE
    AND (p_node_id IS NULL OR node_id = p_node_id);
$$;

-- 14. shutdown_clear_flags
CREATE OR REPLACE FUNCTION shutdown_clear_flags(p_node_id TEXT DEFAULT NULL)
RETURNS void LANGUAGE sql AS $$
    UPDATE sessions SET was_running_at_shutdown = FALSE
    WHERE was_running_at_shutdown = TRUE
    AND (p_node_id IS NULL OR node_id = p_node_id);
$$;

-- 15. shutdown_repair_read_positions
CREATE OR REPLACE FUNCTION shutdown_repair_read_positions()
RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE
    v_count INTEGER;
BEGIN
    UPDATE sessions
    SET last_read_event_id = last_event_id
    WHERE status != 'running'
      AND last_read_event_id < last_event_id;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$;

-- 이벤트 도메인 ---------------------------------------------------

-- 16. event_append
CREATE OR REPLACE FUNCTION event_append(
    p_session_id      TEXT,
    p_event_type      TEXT,
    p_payload         TEXT,
    p_searchable_text TEXT,
    p_created_at      TIMESTAMPTZ
) RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE
    v_event_id INTEGER;
BEGIN
    -- 행 잠금으로 동시 append 직렬화
    PERFORM session_id FROM sessions WHERE session_id = p_session_id FOR UPDATE;

    INSERT INTO events (id, session_id, event_type, payload, searchable_text, created_at)
    VALUES (
        (SELECT COALESCE(MAX(id), 0) + 1 FROM events WHERE session_id = p_session_id),
        p_session_id, p_event_type, p_payload::jsonb, p_searchable_text, p_created_at
    ) RETURNING id INTO v_event_id;

    UPDATE sessions SET last_event_id = v_event_id WHERE session_id = p_session_id;

    RETURN v_event_id;
END;
$$;

-- 17. event_read
CREATE OR REPLACE FUNCTION event_read(
    p_session_id   TEXT,
    p_after_id     INTEGER DEFAULT 0,
    p_limit        INTEGER DEFAULT NULL,
    p_event_types  TEXT[] DEFAULT NULL
) RETURNS TABLE(
    id              INTEGER,
    session_id      TEXT,
    event_type      TEXT,
    payload         JSONB,
    searchable_text TEXT,
    created_at      TIMESTAMPTZ
) LANGUAGE sql STABLE AS $$
    SELECT e.id, e.session_id, e.event_type, e.payload, e.searchable_text, e.created_at
    FROM events e
    WHERE e.session_id = p_session_id
      AND e.id > p_after_id
      AND (p_event_types IS NULL OR e.event_type = ANY(p_event_types))
    ORDER BY e.id
    LIMIT p_limit;
$$;

-- 18. event_read_one
CREATE OR REPLACE FUNCTION event_read_one(
    p_session_id TEXT,
    p_event_id   INTEGER
) RETURNS TABLE(
    id              INTEGER,
    session_id      TEXT,
    event_type      TEXT,
    payload         JSONB,
    searchable_text TEXT,
    created_at      TIMESTAMPTZ
) LANGUAGE sql STABLE AS $$
    SELECT id, session_id, event_type, payload, searchable_text, created_at
    FROM events
    WHERE session_id = p_session_id AND id = p_event_id;
$$;

-- 19. event_stream_raw
CREATE OR REPLACE FUNCTION event_stream_raw(
    p_session_id TEXT,
    p_after_id   INTEGER DEFAULT 0
) RETURNS TABLE(
    id           INTEGER,
    event_type   TEXT,
    payload_text TEXT
) LANGUAGE sql STABLE AS $$
    SELECT id, event_type, payload::text AS payload_text
    FROM events
    WHERE session_id = p_session_id AND id > p_after_id
    ORDER BY id;
$$;

-- 20. event_count
CREATE OR REPLACE FUNCTION event_count(
    p_session_id TEXT
) RETURNS BIGINT LANGUAGE sql STABLE AS $$
    SELECT COUNT(*) FROM events WHERE session_id = p_session_id;
$$;

-- 21. event_search
CREATE OR REPLACE FUNCTION event_search(
    p_query       TEXT,
    p_session_ids TEXT[] DEFAULT NULL,
    p_limit       INTEGER DEFAULT 50
) RETURNS TABLE(
    id              INTEGER,
    session_id      TEXT,
    event_type      TEXT,
    payload         JSONB,
    searchable_text TEXT,
    created_at      TIMESTAMPTZ,
    score           FLOAT
) LANGUAGE plpgsql STABLE AS $$
BEGIN
    IF p_session_ids IS NOT NULL THEN
        RETURN QUERY
            SELECT e.id, e.session_id, e.event_type, e.payload,
                   e.searchable_text, e.created_at,
                   ts_rank(e.search_vector, plainto_tsquery('simple', p_query))::FLOAT AS score
            FROM events e
            WHERE e.search_vector @@ plainto_tsquery('simple', p_query)
              AND e.session_id = ANY(p_session_ids)
            ORDER BY score DESC
            LIMIT p_limit;
    ELSE
        RETURN QUERY
            SELECT e.id, e.session_id, e.event_type, e.payload,
                   e.searchable_text, e.created_at,
                   ts_rank(e.search_vector, plainto_tsquery('simple', p_query))::FLOAT AS score
            FROM events e
            WHERE e.search_vector @@ plainto_tsquery('simple', p_query)
            ORDER BY score DESC
            LIMIT p_limit;
    END IF;
END;
$$;

-- 35. session_list_summary
CREATE OR REPLACE FUNCTION session_list_summary(
    p_search       TEXT DEFAULT NULL,
    p_session_type TEXT DEFAULT NULL,
    p_limit        INTEGER DEFAULT 20,
    p_offset       INTEGER DEFAULT 0,
    p_folder_id    TEXT DEFAULT NULL,
    p_node_id      TEXT DEFAULT NULL
) RETURNS TABLE(
    session_id   TEXT,
    display_name TEXT,
    status       TEXT,
    session_type TEXT,
    created_at   TIMESTAMPTZ,
    updated_at   TIMESTAMPTZ,
    event_count  BIGINT,
    total_count  BIGINT
) LANGUAGE sql STABLE AS $$
    WITH filtered AS (
        SELECT s.session_id, s.display_name, s.status, s.session_type,
               s.created_at, s.updated_at,
               (SELECT COUNT(*) FROM events e WHERE e.session_id = s.session_id) AS event_count
        FROM sessions s
        WHERE (p_session_type IS NULL OR s.session_type = p_session_type)
          AND (p_search IS NULL OR s.display_name ILIKE '%' || p_search || '%')
          AND (p_folder_id IS NULL OR s.folder_id = p_folder_id)
          AND (p_node_id IS NULL OR s.node_id = p_node_id)
        ORDER BY s.updated_at DESC
    )
    SELECT f.*, (SELECT COUNT(*) FROM filtered)::BIGINT AS total_count
    FROM filtered f
    LIMIT p_limit OFFSET p_offset;
$$;

-- 폴더 도메인 ----------------------------------------------------

-- 22. folder_create
CREATE OR REPLACE FUNCTION folder_create(
    p_id         TEXT,
    p_name       TEXT,
    p_sort_order INTEGER DEFAULT 0
) RETURNS void LANGUAGE sql AS $$
    INSERT INTO folders (id, name, sort_order) VALUES (p_id, p_name, p_sort_order);
$$;

-- 23. folder_update
CREATE OR REPLACE FUNCTION folder_update(
    p_id      TEXT,
    p_columns TEXT[],
    p_values  TEXT[]
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
    allowed TEXT[] := ARRAY['name', 'sort_order'];
    set_list TEXT := '';
    i INTEGER;
    col TEXT;
BEGIN
    FOR i IN 1..array_length(p_columns, 1) LOOP
        col := p_columns[i];
        IF NOT (col = ANY(allowed)) THEN
            RAISE EXCEPTION 'Invalid folder column: %', col;
        END IF;
        IF set_list != '' THEN
            set_list := set_list || ', ';
        END IF;
        IF col = 'sort_order' THEN
            set_list := set_list || col || ' = ' || p_values[i] || '::integer';
        ELSE
            set_list := set_list || col || ' = ' || quote_literal(p_values[i]);
        END IF;
    END LOOP;

    EXECUTE format('UPDATE folders SET %s WHERE id = %s', set_list, quote_literal(p_id));
END;
$$;

-- 24. folder_get
CREATE OR REPLACE FUNCTION folder_get(
    p_id TEXT
) RETURNS SETOF folders LANGUAGE sql STABLE AS $$
    SELECT * FROM folders WHERE id = p_id;
$$;

-- 25. folder_delete
CREATE OR REPLACE FUNCTION folder_delete(
    p_id TEXT
) RETURNS void LANGUAGE sql AS $$
    DELETE FROM folders WHERE id = p_id;
$$;

-- 26. folder_get_all
CREATE OR REPLACE FUNCTION folder_get_all()
RETURNS SETOF folders LANGUAGE sql STABLE AS $$
    SELECT * FROM folders ORDER BY sort_order, name;
$$;

-- 27. folder_get_default
CREATE OR REPLACE FUNCTION folder_get_default(
    p_name TEXT
) RETURNS SETOF folders LANGUAGE sql STABLE AS $$
    SELECT * FROM folders WHERE name = p_name;
$$;

-- 28. folder_ensure_defaults
CREATE OR REPLACE FUNCTION folder_ensure_defaults(
    p_folders JSONB
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
    item JSONB;
BEGIN
    FOR item IN SELECT jsonb_array_elements(p_folders) LOOP
        INSERT INTO folders (id, name, sort_order)
        VALUES (item->>'id', item->>'name', COALESCE((item->>'sort_order')::integer, 0))
        ON CONFLICT (id) DO NOTHING;
    END LOOP;
END;
$$;

-- 카탈로그 --------------------------------------------------------

-- 29. catalog_get_sessions
CREATE OR REPLACE FUNCTION catalog_get_sessions()
RETURNS TABLE(session_id TEXT, folder_id TEXT, display_name TEXT)
LANGUAGE sql STABLE AS $$
    SELECT session_id, folder_id, display_name FROM sessions;
$$;

-- 마이그레이션 ----------------------------------------------------

-- 30. migration_upsert_folder
CREATE OR REPLACE FUNCTION migration_upsert_folder(
    p_id         TEXT,
    p_name       TEXT,
    p_sort_order INTEGER
) RETURNS void LANGUAGE sql AS $$
    INSERT INTO folders (id, name, sort_order)
    VALUES (p_id, p_name, p_sort_order)
    ON CONFLICT (id) DO NOTHING;
$$;

-- 31. migration_upsert_session
CREATE OR REPLACE FUNCTION migration_upsert_session(
    p_session_id TEXT,
    p_data       JSONB
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO sessions (
        session_id, folder_id, display_name, node_id, session_type,
        status, prompt, client_id, claude_session_id,
        last_message, metadata, was_running_at_shutdown,
        last_event_id, last_read_event_id, created_at, updated_at,
        agent_id
    ) VALUES (
        p_session_id,
        p_data->>'folder_id',
        p_data->>'display_name',
        p_data->>'node_id',
        p_data->>'session_type',
        p_data->>'status',
        p_data->>'prompt',
        p_data->>'client_id',
        p_data->>'claude_session_id',
        CASE WHEN p_data ? 'last_message' THEN (p_data->'last_message') ELSE NULL END,
        CASE WHEN p_data ? 'metadata' THEN (p_data->'metadata') ELSE NULL END,
        COALESCE((p_data->>'was_running_at_shutdown')::boolean, FALSE),
        (p_data->>'last_event_id')::integer,
        (p_data->>'last_read_event_id')::integer,
        COALESCE((p_data->>'created_at')::timestamptz, NOW()),
        COALESCE((p_data->>'updated_at')::timestamptz, NOW()),
        p_data->>'agent_id'
    )
    ON CONFLICT (session_id) DO UPDATE SET
        folder_id = EXCLUDED.folder_id,
        display_name = EXCLUDED.display_name,
        node_id = EXCLUDED.node_id,
        session_type = EXCLUDED.session_type,
        status = EXCLUDED.status,
        prompt = EXCLUDED.prompt,
        client_id = EXCLUDED.client_id,
        claude_session_id = EXCLUDED.claude_session_id,
        last_message = EXCLUDED.last_message,
        metadata = EXCLUDED.metadata,
        was_running_at_shutdown = EXCLUDED.was_running_at_shutdown,
        last_event_id = EXCLUDED.last_event_id,
        last_read_event_id = EXCLUDED.last_read_event_id,
        updated_at = EXCLUDED.updated_at,
        agent_id = EXCLUDED.agent_id;
END;
$$;

-- 32. migration_insert_event
CREATE OR REPLACE FUNCTION migration_insert_event(
    p_session_id      TEXT,
    p_id              INTEGER,
    p_event_type      TEXT,
    p_payload         JSONB,
    p_searchable_text TEXT,
    p_created_at      TIMESTAMPTZ
) RETURNS void LANGUAGE sql AS $$
    INSERT INTO events (session_id, id, event_type, payload, searchable_text, created_at)
    VALUES (p_session_id, p_id, p_event_type, p_payload, p_searchable_text, p_created_at)
    ON CONFLICT DO NOTHING;
$$;

-- 33. migration_ensure_session
CREATE OR REPLACE FUNCTION migration_ensure_session(
    p_session_id TEXT,
    p_data       JSONB
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM sessions WHERE session_id = p_session_id) THEN
        INSERT INTO sessions (
            session_id, folder_id, display_name, node_id, session_type,
            status, prompt, client_id, claude_session_id,
            last_message, metadata, was_running_at_shutdown,
            last_event_id, last_read_event_id, created_at, updated_at,
            agent_id
        ) VALUES (
            p_session_id,
            p_data->>'folder_id',
            p_data->>'display_name',
            p_data->>'node_id',
            p_data->>'session_type',
            p_data->>'status',
            p_data->>'prompt',
            p_data->>'client_id',
            p_data->>'claude_session_id',
            CASE WHEN p_data ? 'last_message' THEN (p_data->'last_message') ELSE NULL END,
            CASE WHEN p_data ? 'metadata' THEN (p_data->'metadata') ELSE NULL END,
            COALESCE((p_data->>'was_running_at_shutdown')::boolean, FALSE),
            (p_data->>'last_event_id')::integer,
            (p_data->>'last_read_event_id')::integer,
            COALESCE((p_data->>'created_at')::timestamptz, NOW()),
            COALESCE((p_data->>'updated_at')::timestamptz, NOW()),
            p_data->>'agent_id'
        );
    END IF;
END;
$$;

-- 34. migration_update_last_event_id
CREATE OR REPLACE FUNCTION migration_update_last_event_id(
    p_session_id    TEXT,
    p_last_event_id INTEGER
) RETURNS void LANGUAGE sql AS $$
    UPDATE sessions
    SET last_event_id = p_last_event_id
    WHERE session_id = p_session_id
      AND (last_event_id IS NULL OR last_event_id < p_last_event_id);
$$;

-- 35. migration_verify
CREATE OR REPLACE FUNCTION migration_verify(
    p_node_id TEXT
) RETURNS TABLE(session_count BIGINT, event_count BIGINT, folder_count BIGINT)
LANGUAGE sql STABLE AS $$
    SELECT
        (SELECT COUNT(*) FROM sessions WHERE node_id = p_node_id) AS session_count,
        (SELECT COUNT(*) FROM events e
         JOIN sessions s ON e.session_id = s.session_id
         WHERE s.node_id = p_node_id) AS event_count,
        (SELECT COUNT(*) FROM folders) AS folder_count;
$$;
