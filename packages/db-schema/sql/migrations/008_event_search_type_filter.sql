-- Migration 008: event_search에 event_type 필터 추가, session_id 기반 검색 함수 신설
--
-- event_search()에 p_event_types 파라미터를 추가하여
-- 특정 이벤트 타입만 검색할 수 있도록 한다.
--
-- session_id_search()를 신설하여
-- session_id ILIKE 매칭으로 이벤트를 검색할 수 있도록 한다.

-- event_search에 p_event_types 파라미터 추가
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
) LANGUAGE plpgsql STABLE AS $$
BEGIN
    RETURN QUERY
        SELECT e.id, e.session_id, e.event_type, e.payload,
               e.searchable_text, e.created_at,
               ts_rank(e.search_vector, plainto_tsquery('simple', p_query))::FLOAT AS score
        FROM events e
        WHERE e.search_vector @@ plainto_tsquery('simple', p_query)
          AND (p_session_ids IS NULL OR e.session_id = ANY(p_session_ids))
          AND (p_event_types IS NULL OR e.event_type = ANY(p_event_types))
        ORDER BY score DESC
        LIMIT p_limit;
END;
$$;

-- 세션 아이디 기반 검색: text search 없이 session_id ILIKE 매칭
CREATE OR REPLACE FUNCTION session_id_search(
    p_query       TEXT,
    p_event_types TEXT[] DEFAULT NULL,
    p_limit       INTEGER DEFAULT 50
) RETURNS TABLE(
    id              INTEGER,
    session_id      TEXT,
    event_type      TEXT,
    payload         JSONB,
    searchable_text TEXT,
    created_at      TIMESTAMPTZ,
    score           FLOAT
) LANGUAGE sql STABLE AS $$
    SELECT e.id, e.session_id, e.event_type, e.payload,
           e.searchable_text, e.created_at,
           0.5::FLOAT AS score
    FROM events e
    WHERE e.session_id ILIKE '%' || p_query || '%'
      AND (p_event_types IS NULL OR e.event_type = ANY(p_event_types))
    ORDER BY e.created_at DESC
    LIMIT p_limit;
$$;
