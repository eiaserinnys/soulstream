-- schema.sql — DDL 정본 파일
-- 모든 테이블, 인덱스, 트리거, 함수를 멱등하게 정의한다.
-- CREATE OR REPLACE / IF NOT EXISTS로 반복 실행 가능.

-- ============================================================
-- 1. 테이블
-- ============================================================

CREATE TABLE IF NOT EXISTS folders (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 기존 테이블에 settings 컬럼 추가 (멱등)
ALTER TABLE folders ADD COLUMN IF NOT EXISTS settings JSONB NOT NULL DEFAULT '{}';
-- 기존 테이블에 created_at 컬럼 추가 (멱등)
ALTER TABLE folders ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

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
    agent_id                VARCHAR,
    caller_session_id       TEXT
);

-- 기존 테이블에 caller_session_id 컬럼 추가 (멱등)
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS caller_session_id TEXT;

-- away_summary 컬럼 추가 (멱등)
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS away_summary TEXT;

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

CREATE TABLE IF NOT EXISTS soulstream_schedules (
    schedule_id     TEXT PRIMARY KEY,
    session_id      TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    kind            TEXT NOT NULL CHECK (kind IN ('wakeup', 'cron')),
    status          TEXT NOT NULL CHECK (
        status IN (
            'active',
            'dispatching',
            'firing',
            'completed',
            'cancelled',
            'failed',
            'orphaned'
        )
    ),
    prompt          TEXT NOT NULL,
    source_tool     TEXT NOT NULL,
    tool_use_id     TEXT,
    cron_expression TEXT,
    run_once_at     TIMESTAMPTZ,
    timezone        TEXT NOT NULL DEFAULT 'UTC',
    recurring       BOOLEAN NOT NULL DEFAULT FALSE,
    next_run_at     TIMESTAMPTZ,
    last_fired_at   TIMESTAMPTZ,
    fired_count     INTEGER NOT NULL DEFAULT 0,
    last_error      TEXT,
    claim_token     TEXT,
    claimed_until   TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS soulstream_node_heartbeats (
    node_id      TEXT PRIMARY KEY,
    last_seen_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS event_search_terms (
    session_id TEXT NOT NULL,
    event_id   INTEGER NOT NULL,
    term       TEXT NOT NULL,
    term_freq  INTEGER NOT NULL,
    doc_len    INTEGER NOT NULL,
    PRIMARY KEY (session_id, event_id, term),
    FOREIGN KEY (session_id, event_id)
        REFERENCES events(session_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS task_items (
    id                    TEXT PRIMARY KEY,
    parent_id             TEXT REFERENCES task_items(id) ON DELETE SET NULL,
    position_key          DOUBLE PRECISION NOT NULL DEFAULT 0,
    title                 TEXT NOT NULL,
    description           TEXT NOT NULL DEFAULT '',
    acceptance_criteria   TEXT NOT NULL DEFAULT '',
    verification_owner    TEXT NOT NULL DEFAULT 'agent',
    status                TEXT NOT NULL DEFAULT 'open',
    linked_session_id     TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
    linked_node_id        TEXT,
    active_for_session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
    created_from_session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
    created_from_event_id INTEGER,
    navigation_session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
    navigation_node_id    TEXT,
    navigation_event_id   INTEGER,
    archived              BOOLEAN NOT NULL DEFAULT FALSE,
    pinned                BOOLEAN NOT NULL DEFAULT FALSE,
    version               INTEGER NOT NULL DEFAULT 1,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (status IN (
        'open',
        'in_progress',
        'agent_done',
        'verified_done',
        'reopened',
        'blocked',
        'cancelled'
    )),
    CHECK (verification_owner IN ('agent', 'user', 'both'))
);

ALTER TABLE task_items ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS task_operations (
    id                 TEXT PRIMARY KEY,
    task_id            TEXT REFERENCES task_items(id) ON DELETE SET NULL,
    operation_type     TEXT NOT NULL,
    actor_kind         TEXT NOT NULL DEFAULT 'agent',
    actor_session_id   TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
    actor_event_id     INTEGER,
    actor_user_id      TEXT,
    idempotency_key    TEXT,
    payload_json       JSONB NOT NULL DEFAULT '{}',
    reason             TEXT,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS claude_transcript_entries (
    id          BIGSERIAL PRIMARY KEY,
    project_key TEXT NOT NULL,
    session_id  TEXT NOT NULL,
    subpath     TEXT NOT NULL DEFAULT '',
    entry_uuid  TEXT,
    entry       JSONB NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 뷰포트 가상화 지원: parent_event_id 컬럼 승격 (payload → 정본 컬럼)
ALTER TABLE events ADD COLUMN IF NOT EXISTS parent_event_id INTEGER;

-- FK 제약은 IF NOT EXISTS를 지원하지 않으므로 pg_constraint 확인 후 추가 (멱등)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'events_parent_fk'
    ) THEN
        ALTER TABLE events
            ADD CONSTRAINT events_parent_fk
            FOREIGN KEY (session_id, parent_event_id)
            REFERENCES events(session_id, id) ON DELETE CASCADE;
    END IF;
END$$;

-- 뷰포트 가상화 지원: subtree_height — DFS로 계산된 자기 포함 서브트리 크기
ALTER TABLE events ADD COLUMN IF NOT EXISTS subtree_height INTEGER NOT NULL DEFAULT 1;

-- ============================================================
-- 2. 인덱스
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_events_session_id_id ON events (session_id, id);
CREATE INDEX IF NOT EXISTS idx_events_search_vector ON events USING GIN (search_vector);
CREATE INDEX IF NOT EXISTS idx_event_search_terms_term ON event_search_terms (term);
CREATE INDEX IF NOT EXISTS idx_soulstream_schedules_session
    ON soulstream_schedules (session_id, status, next_run_at);
CREATE INDEX IF NOT EXISTS idx_soulstream_schedules_due
    ON soulstream_schedules (next_run_at)
    WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_soulstream_node_heartbeats_seen
    ON soulstream_node_heartbeats (last_seen_at);

CREATE INDEX IF NOT EXISTS idx_task_items_parent ON task_items (parent_id, position_key);
CREATE INDEX IF NOT EXISTS idx_task_items_status ON task_items (status) WHERE archived = FALSE;
CREATE INDEX IF NOT EXISTS idx_task_items_active_session ON task_items (active_for_session_id) WHERE active_for_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_task_items_linked_session ON task_items (linked_session_id) WHERE linked_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_task_items_sibling_sort ON task_items (parent_id, pinned DESC, updated_at DESC) WHERE archived = FALSE;
CREATE INDEX IF NOT EXISTS idx_task_operations_task ON task_operations (task_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_operations_idempotency
    ON task_operations (idempotency_key)
    WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_claude_transcript_load
    ON claude_transcript_entries (project_key, session_id, subpath, id);
CREATE INDEX IF NOT EXISTS idx_claude_transcript_sessions
    ON claude_transcript_entries (project_key, session_id, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_claude_transcript_entry_uuid
    ON claude_transcript_entries (project_key, session_id, subpath, entry_uuid)
    WHERE entry_uuid IS NOT NULL;

CREATE OR REPLACE FUNCTION task_tree_notify_change()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
    v_payload JSONB;
BEGIN
    IF TG_TABLE_NAME = 'task_items' THEN
        v_payload := jsonb_build_object(
            'table', TG_TABLE_NAME,
            'action', TG_OP,
            'task_id', NEW.id,
            'updated_at', NEW.updated_at
        );
    ELSE
        v_payload := jsonb_build_object(
            'table', TG_TABLE_NAME,
            'action', TG_OP,
            'task_id', NEW.task_id,
            'operation_id', NEW.id,
            'operation_type', NEW.operation_type,
            'actor_event_id', NEW.actor_event_id
        );
    END IF;
    PERFORM pg_notify('task_tree_changed', v_payload::text);
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_task_items_notify ON task_items;
CREATE TRIGGER trg_task_items_notify
AFTER INSERT OR UPDATE ON task_items
FOR EACH ROW EXECUTE FUNCTION task_tree_notify_change();

DROP TRIGGER IF EXISTS trg_task_operations_notify ON task_operations;
CREATE TRIGGER trg_task_operations_notify
AFTER INSERT OR UPDATE ON task_operations
FOR EACH ROW EXECUTE FUNCTION task_tree_notify_change();

-- 뷰포트 가상화 지원: parent_event_id 기반 자식 조회 인덱스
CREATE INDEX IF NOT EXISTS idx_events_parent ON events (session_id, parent_event_id);

-- /messages 페이지네이션용 복합 인덱스 (created_at DESC + id DESC 커서 지원)
CREATE INDEX IF NOT EXISTS idx_events_created_at ON events (session_id, created_at DESC, id DESC);

-- ============================================================
-- 3. 트리거 (search_vector 자동 갱신)
-- ============================================================

CREATE OR REPLACE FUNCTION event_search_tokenize(p_text TEXT)
RETURNS TEXT[] LANGUAGE sql IMMUTABLE AS $$
    SELECT COALESCE(array_agg(term), ARRAY[]::TEXT[])
    FROM regexp_split_to_table(
        lower(coalesce(p_text, '')),
        '[^[:alnum:]_가-힣]+'
    ) AS token(term)
    WHERE term <> '';
$$;

CREATE OR REPLACE FUNCTION update_search_vector() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.searchable_text IS NOT NULL AND NEW.searchable_text != '' THEN
        NEW.search_vector := to_tsvector('simple', NEW.searchable_text);
    ELSE
        NEW.search_vector := NULL;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_events_search_vector ON events;
CREATE TRIGGER trg_events_search_vector
    BEFORE INSERT OR UPDATE OF searchable_text ON events
    FOR EACH ROW EXECUTE FUNCTION update_search_vector();

CREATE OR REPLACE FUNCTION refresh_event_search_terms() RETURNS TRIGGER AS $$
DECLARE
    v_tokens TEXT[];
    v_doc_len INTEGER;
BEGIN
    DELETE FROM event_search_terms
    WHERE session_id = NEW.session_id
      AND event_id = NEW.id;

    v_tokens := event_search_tokenize(NEW.searchable_text);
    v_doc_len := cardinality(v_tokens);

    IF v_doc_len > 0 THEN
        INSERT INTO event_search_terms (
            session_id, event_id, term, term_freq, doc_len
        )
        SELECT NEW.session_id, NEW.id, term, COUNT(*)::INTEGER, v_doc_len
        FROM unnest(v_tokens) AS token(term)
        GROUP BY term;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_event_search_terms ON events;
CREATE TRIGGER trg_event_search_terms
    AFTER INSERT OR UPDATE OF searchable_text ON events
    FOR EACH ROW EXECUTE FUNCTION refresh_event_search_terms();

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

    -- UPDATE SET 생성: session_id, created_at 제외; 불변 필드는 COALESCE로 보호
    set_list := 'updated_at = EXCLUDED.updated_at';
    FOR i IN 1..array_length(p_columns, 1) LOOP
        col := p_columns[i];
        IF col NOT IN ('created_at') THEN
            IF col = ANY(ARRAY['node_id', 'agent_id', 'claude_session_id']) THEN
                -- 불변 필드: 기존 값이 있으면 유지, 없을 때만 새 값 사용
                set_list := set_list || ', ' || col
                    || ' = COALESCE(sessions.' || col || ', EXCLUDED.' || col || ')';
            ELSE
                set_list := set_list || ', ' || col || ' = EXCLUDED.' || col;
            END IF;
        END IF;
    END LOOP;

    EXECUTE format(
        'INSERT INTO sessions (%s) VALUES (%s) ON CONFLICT (session_id) DO UPDATE SET %s',
        col_list, val_list, set_list
    );
END;
$$;

-- session_register (4-ID 최초 등록 — 순수 INSERT, ON CONFLICT 없음)
CREATE OR REPLACE FUNCTION session_register(
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
    p_caller_session_id TEXT DEFAULT NULL
) RETURNS void LANGUAGE sql AS $$
    INSERT INTO sessions (
        session_id, node_id, agent_id, claude_session_id,
        session_type, prompt, client_id, status,
        created_at, updated_at, caller_session_id
    ) VALUES (
        p_session_id, p_node_id, p_agent_id, p_claude_session_id,
        p_session_type, p_prompt, p_client_id, p_status,
        p_created_at, p_updated_at, p_caller_session_id
    );
$$;

-- session_set_claude_id (claude_session_id 불변 설정)
-- NULL → SET (최초 설정)
-- 같은 값 → no-op (idempotent, 컴팩션/재시작 재진입 허용)
-- 다른 값 → RAISE EXCEPTION (버그 탐지)
CREATE OR REPLACE FUNCTION session_set_claude_id(
    p_session_id        TEXT,
    p_claude_session_id TEXT
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
    v_existing TEXT;
BEGIN
    SELECT claude_session_id INTO v_existing
    FROM sessions
    WHERE session_id = p_session_id;

    IF v_existing IS NULL THEN
        UPDATE sessions
        SET claude_session_id = p_claude_session_id,
            updated_at = NOW()
        WHERE session_id = p_session_id;
    ELSIF v_existing = p_claude_session_id THEN
        NULL;
    ELSE
        RAISE EXCEPTION 'claude_session_id immutability violation: session_id=%, existing=%, new=%',
            p_session_id, v_existing, p_claude_session_id;
    END IF;
END;
$$;

-- session_update (불변 필드 제외 동적 UPDATE)
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
        'last_event_id', 'last_read_event_id'
    ];
    set_list  TEXT;
    i         INTEGER;
    col       TEXT;
    jsonb_cols TEXT[] := ARRAY['last_message', 'metadata'];
    bool_cols  TEXT[] := ARRAY['was_running_at_shutdown'];
    int_cols   TEXT[] := ARRAY['last_event_id', 'last_read_event_id'];
BEGIN
    -- 화이트리스트 검증 (불변 필드는 화이트리스트에 없음)
    FOR i IN 1..array_length(p_columns, 1) LOOP
        IF NOT (p_columns[i] = ANY(allowed)) THEN
            RAISE EXCEPTION 'Invalid or immutable session column: %', p_columns[i];
        END IF;
    END LOOP;

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
    q TEXT := 'SELECT s.* FROM sessions s LEFT JOIN folders f ON s.folder_id = f.id WHERE TRUE';
BEGIN
    IF p_filters IS NOT NULL AND p_filters ? 'session_type' THEN
        q := q || ' AND session_type = ' || quote_literal(p_filters->>'session_type');
    END IF;
    IF p_filters IS NOT NULL AND p_filters ? 'folder_id' THEN
        q := q || ' AND s.folder_id = ' || quote_literal(p_filters->>'folder_id');
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
    IF p_filters IS NOT NULL AND p_filters ? 'feed_only' AND (p_filters->>'feed_only')::boolean THEN
        q := q || ' AND (s.folder_id IS NULL OR COALESCE(f.settings->>''excludeFromFeed'', ''false'') != ''true'')';
        q := q || ' AND COALESCE(session_type, ''claude'') != ''llm''';
    END IF;

    q := q || ' ORDER BY s.updated_at DESC';

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
    q TEXT := 'SELECT COUNT(*) FROM sessions s LEFT JOIN folders f ON s.folder_id = f.id WHERE TRUE';
    result BIGINT;
BEGIN
    IF p_filters IS NOT NULL AND p_filters ? 'session_type' THEN
        q := q || ' AND session_type = ' || quote_literal(p_filters->>'session_type');
    END IF;
    IF p_filters IS NOT NULL AND p_filters ? 'folder_id' THEN
        q := q || ' AND s.folder_id = ' || quote_literal(p_filters->>'folder_id');
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
    IF p_filters IS NOT NULL AND p_filters ? 'feed_only' AND (p_filters->>'feed_only')::boolean THEN
        q := q || ' AND (s.folder_id IS NULL OR COALESCE(f.settings->>''excludeFromFeed'', ''false'') != ''true'')';
        q := q || ' AND COALESCE(session_type, ''claude'') != ''llm''';
    END IF;

    EXECUTE q INTO result;
    RETURN result;
END;
$$;

-- 5. session_delete
CREATE OR REPLACE FUNCTION session_delete(
    p_session_id TEXT
) RETURNS void LANGUAGE sql AS $$
    DELETE FROM claude_transcript_entries
    WHERE session_id = p_session_id
       OR session_id = (
            SELECT claude_session_id
            FROM sessions
            WHERE sessions.session_id = p_session_id
       );

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

    -- 행 잠금으로 동시 append 직렬화
    PERFORM session_id FROM sessions WHERE session_id = p_session_id FOR UPDATE;

    INSERT INTO events (id, session_id, event_type, payload, searchable_text,
                        created_at, parent_event_id)
    VALUES (
        (SELECT COALESCE(MAX(id), 0) + 1 FROM events WHERE session_id = p_session_id),
        p_session_id, p_event_type, v_payload, p_searchable_text,
        p_created_at, v_parent
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

-- 20b. events_viewport — 가상 Y축 범위 [y_min, y_max]와 겹치는 이벤트 조회
--
-- 전제 조건 (§9 참조):
--   - session_id에 parent_event_id IS NULL인 이벤트는 정확히 1개(단일 루트)여야 한다.
--   - subtree_height는 미리 백필되어 있어야 한다(backfill_subtree_height.py).
--   - 여러 루트가 있으면 y_start가 루트별로 독립적으로 시작하여 구간이 겹치거나 어긋난다.
--     Python 측 read_viewport()가 이 경우 경고 로그를 남긴다.
--
-- y_start/y_end는 1-based 가상 Y축 좌표이며, 자식들의 y_start는
-- (부모 y_start + 1) + 형제 중 id가 더 작은 자식들의 subtree_height 합으로 계산한다.
-- depth는 루트=0부터 계단식 증가.
CREATE OR REPLACE FUNCTION events_viewport(
    p_session_id TEXT,
    p_y_min BIGINT,
    p_y_max BIGINT
) RETURNS TABLE (
    id              INTEGER,
    parent_event_id INTEGER,
    event_type      TEXT,
    depth           INTEGER,
    y_start         BIGINT,
    y_end           BIGINT,
    payload         JSONB
) LANGUAGE sql STABLE AS $$
    WITH RECURSIVE tree AS (
        SELECT e.id, e.parent_event_id, e.event_type, e.payload, e.subtree_height,
               0::INTEGER AS depth,
               1::BIGINT AS y_start
        FROM events e
        WHERE e.session_id = p_session_id AND e.parent_event_id IS NULL
        UNION ALL
        SELECT c.id, c.parent_event_id, c.event_type, c.payload, c.subtree_height,
               t.depth + 1,
               t.y_start + 1 + COALESCE((
                   SELECT SUM(s.subtree_height)
                   FROM events s
                   WHERE s.session_id = p_session_id
                     AND s.parent_event_id = c.parent_event_id
                     AND s.id < c.id
               ), 0)
        FROM events c
        JOIN tree t ON c.parent_event_id = t.id
        WHERE c.session_id = p_session_id
    )
    SELECT id, parent_event_id, event_type, depth, y_start,
           y_start + subtree_height - 1 AS y_end, payload
    FROM tree
    WHERE NOT (y_start + subtree_height - 1 < p_y_min OR y_start > p_y_max)
    ORDER BY y_start;
$$;

-- 21. event_search
DROP FUNCTION IF EXISTS event_search(TEXT, TEXT[], INTEGER);
DROP FUNCTION IF EXISTS event_search(TEXT, TEXT[], INTEGER, TEXT[]);
CREATE OR REPLACE FUNCTION event_search(
    p_query       TEXT,
    p_session_ids TEXT[] DEFAULT NULL,
    p_limit       INTEGER DEFAULT 50,
    p_event_types TEXT[] DEFAULT NULL
) RETURNS TABLE(
    id              INTEGER,
    session_id      TEXT,
    event_type      TEXT,
    payload         JSONB,
    searchable_text TEXT,
    created_at      TIMESTAMPTZ,
    score           FLOAT
) LANGUAGE sql STABLE AS $$
    WITH query_terms AS (
        SELECT DISTINCT term
        FROM unnest(event_search_tokenize(p_query)) AS token(term)
    ),
    filtered_events AS (
        SELECT e.*
        FROM events e
        WHERE EXISTS (SELECT 1 FROM query_terms)
          AND (p_session_ids IS NULL OR e.session_id = ANY(p_session_ids))
          AND (p_event_types IS NULL OR e.event_type = ANY(p_event_types))
    ),
    docs AS (
        SELECT DISTINCT t.session_id, t.event_id, t.doc_len
        FROM event_search_terms t
        JOIN filtered_events e
          ON e.session_id = t.session_id
         AND e.id = t.event_id
    ),
    corpus AS (
        SELECT COUNT(*)::FLOAT AS total_docs,
               COALESCE(AVG(doc_len), 0)::FLOAT AS avg_doc_len
        FROM docs
    ),
    doc_freq AS (
        SELECT t.term, COUNT(DISTINCT (t.session_id, t.event_id))::FLOAT AS doc_count
        FROM event_search_terms t
        JOIN query_terms q ON q.term = t.term
        JOIN filtered_events e
          ON e.session_id = t.session_id
         AND e.id = t.event_id
        GROUP BY t.term
    ),
    scored AS (
        SELECT
            e.id,
            e.session_id,
            e.event_type,
            e.payload,
            e.searchable_text,
            e.created_at,
            SUM(
                ln(1 + ((c.total_docs - df.doc_count + 0.5) / (df.doc_count + 0.5))) *
                (
                    (t.term_freq * 2.2) /
                    (
                        t.term_freq +
                        1.2 * (
                            0.25 +
                            0.75 * (t.doc_len::FLOAT / GREATEST(c.avg_doc_len, 1))
                        )
                    )
                )
            )::FLOAT AS score
        FROM event_search_terms t
        JOIN query_terms q ON q.term = t.term
        JOIN doc_freq df ON df.term = t.term
        JOIN corpus c ON c.total_docs > 0
        JOIN filtered_events e
          ON e.session_id = t.session_id
         AND e.id = t.event_id
        GROUP BY
            e.id, e.session_id, e.event_type, e.payload,
            e.searchable_text, e.created_at
    )
    SELECT id, session_id, event_type, payload, searchable_text, created_at, score
    FROM scored
    ORDER BY score DESC, created_at DESC
    LIMIT p_limit;
$$;

-- 35. session_list_summary
DROP FUNCTION IF EXISTS session_list_summary(TEXT, TEXT, INTEGER, INTEGER, TEXT, TEXT);
CREATE OR REPLACE FUNCTION session_list_summary(
    p_search       TEXT DEFAULT NULL,
    p_session_type TEXT DEFAULT NULL,
    p_limit        INTEGER DEFAULT 20,
    p_offset       INTEGER DEFAULT 0,
    p_folder_id    TEXT DEFAULT NULL,
    p_node_id      TEXT DEFAULT NULL
) RETURNS TABLE(
    session_id    TEXT,
    display_name  TEXT,
    status        TEXT,
    session_type  TEXT,
    created_at    TIMESTAMPTZ,
    updated_at    TIMESTAMPTZ,
    event_count   BIGINT,
    away_summary  TEXT,
    caller_session_id TEXT,
    total_count   BIGINT
) LANGUAGE sql STABLE AS $$
    WITH filtered AS (
        SELECT s.session_id, s.display_name, s.status, s.session_type,
               s.created_at, s.updated_at,
               (SELECT COUNT(*) FROM events e WHERE e.session_id = s.session_id) AS event_count,
               s.away_summary, s.caller_session_id
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
    allowed TEXT[] := ARRAY['name', 'sort_order', 'settings'];
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
        ELSIF col = 'settings' THEN
            set_list := set_list || col || ' = ' || quote_literal(p_values[i]) || '::jsonb';
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
        -- 불변 필드: 기존 값이 있으면 유지, 없을 때만 새 값 사용
        node_id = COALESCE(sessions.node_id, EXCLUDED.node_id),
        session_type = EXCLUDED.session_type,
        status = EXCLUDED.status,
        prompt = EXCLUDED.prompt,
        client_id = EXCLUDED.client_id,
        claude_session_id = COALESCE(sessions.claude_session_id, EXCLUDED.claude_session_id),
        last_message = EXCLUDED.last_message,
        metadata = EXCLUDED.metadata,
        was_running_at_shutdown = EXCLUDED.was_running_at_shutdown,
        last_event_id = EXCLUDED.last_event_id,
        last_read_event_id = EXCLUDED.last_read_event_id,
        updated_at = EXCLUDED.updated_at,
        agent_id = COALESCE(sessions.agent_id, EXCLUDED.agent_id);
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

CREATE OR REPLACE FUNCTION claude_transcript_append(
    p_project_key TEXT,
    p_session_id  TEXT,
    p_subpath     TEXT,
    p_entries     JSONB,
    p_now         TIMESTAMPTZ
) RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE
    v_subpath TEXT := COALESCE(p_subpath, '');
    v_entry JSONB;
    v_uuid TEXT;
    v_count INTEGER := 0;
BEGIN
    FOR v_entry IN SELECT value FROM jsonb_array_elements(COALESCE(p_entries, '[]'::jsonb))
    LOOP
        v_uuid := v_entry->>'uuid';
        INSERT INTO claude_transcript_entries (
            project_key,
            session_id,
            subpath,
            entry_uuid,
            entry,
            created_at,
            updated_at
        ) VALUES (
            p_project_key,
            p_session_id,
            v_subpath,
            v_uuid,
            v_entry,
            p_now,
            p_now
        )
        ON CONFLICT (project_key, session_id, subpath, entry_uuid)
        WHERE entry_uuid IS NOT NULL
        DO UPDATE SET entry = EXCLUDED.entry, updated_at = EXCLUDED.updated_at;

        v_count := v_count + 1;
    END LOOP;
    RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION claude_transcript_load(
    p_project_key TEXT,
    p_session_id  TEXT,
    p_subpath     TEXT
) RETURNS TABLE(entry JSONB) LANGUAGE sql STABLE AS $$
    SELECT e.entry
    FROM claude_transcript_entries e
    WHERE e.project_key = p_project_key
      AND e.session_id = p_session_id
      AND e.subpath = COALESCE(p_subpath, '')
    ORDER BY e.id ASC;
$$;

CREATE OR REPLACE FUNCTION claude_transcript_list_sessions(
    p_project_key TEXT
) RETURNS TABLE(session_id TEXT, mtime DOUBLE PRECISION) LANGUAGE sql STABLE AS $$
    SELECT
        e.session_id,
        EXTRACT(EPOCH FROM MAX(e.updated_at)) * 1000 AS mtime
    FROM claude_transcript_entries e
    WHERE e.project_key = p_project_key
      AND e.subpath = ''
    GROUP BY e.session_id;
$$;

CREATE OR REPLACE FUNCTION claude_transcript_list_subkeys(
    p_project_key TEXT,
    p_session_id  TEXT
) RETURNS TABLE(subpath TEXT) LANGUAGE sql STABLE AS $$
    SELECT DISTINCT e.subpath
    FROM claude_transcript_entries e
    WHERE e.project_key = p_project_key
      AND e.session_id = p_session_id
      AND e.subpath <> ''
    ORDER BY e.subpath ASC;
$$;

CREATE OR REPLACE FUNCTION claude_transcript_delete(
    p_project_key TEXT,
    p_session_id  TEXT,
    p_subpath     TEXT
) RETURNS void LANGUAGE sql AS $$
    DELETE FROM claude_transcript_entries e
    WHERE e.project_key = p_project_key
      AND e.session_id = p_session_id
      AND (p_subpath IS NULL OR e.subpath = p_subpath);
$$;

-- 백필: parent_event_id 컬럼이 NULL이지만 payload에 정수 형식 값이 있는 기존 이벤트 채우기
-- 멱등: parent_event_id가 이미 채워진 행은 WHERE 조건으로 건너뜀
-- event_append가 parent_event_id 컬럼을 INSERT에 포함하지 않던 결함(2026-05-02 발견) 보정
-- 길이 + INT 범위 가드: payload.parent_event_id에 tool_use_id/UUID/timestamp 같은
-- 비정상 값이 섞여 있어 (1) 비정수 문자열, (2) INT 범위 초과 정수 모두 백필 대상 아님.
-- ^\d{1,10}$로 BIGINT 캐스트 overflow 차단, BIGINT 범위 비교로 INT 한계 검증.
-- FK 가드: 같은 session_id에 해당 id의 행이 실제로 존재해야만 백필. 레거시 데이터에는
-- payload.parent_event_id가 정수이지만 부모 이벤트 행 자체가 사라진 케이스가 있어
-- (events_parent_fk 위반으로 startup 실패) NULL로 둔다 — event_append의 v_parent 가드와 일관.
UPDATE events e
SET parent_event_id = (e.payload->>'parent_event_id')::INTEGER
WHERE e.parent_event_id IS NULL
  AND e.payload->>'parent_event_id' ~ '^\d{1,10}$'
  AND (e.payload->>'parent_event_id')::BIGINT BETWEEN 1 AND 2147483647
  AND EXISTS (
    SELECT 1 FROM events p
    WHERE p.session_id = e.session_id
      AND p.id = (e.payload->>'parent_event_id')::INTEGER
  );


-- ─── 010_push_tokens.sql ─────────────────────────────────────────────────────
-- Expo Push 토큰 저장 (orch-server가 사용).
-- 자세한 설명은 migrations/010_push_tokens.sql 참조.

CREATE TABLE IF NOT EXISTS push_tokens (
    user_email TEXT NOT NULL,
    device_id TEXT NOT NULL,
    expo_token TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_email, device_id)
);

CREATE INDEX IF NOT EXISTS idx_push_tokens_email ON push_tokens(user_email);
