-- Migration 044: 세션 제목·폴더명·노드 자유 텍스트 검색
--
-- session_get_all과 session_count가 같은 검색 조건을 사용한다.

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
    IF p_filters IS NOT NULL AND p_filters ? 'search' THEN
        q := q || ' AND (' ||
            'COALESCE(s.display_name, '''') ILIKE ' ||
                quote_literal('%' || (p_filters->>'search') || '%') ||
            ' OR s.session_id ILIKE ' ||
                quote_literal('%' || (p_filters->>'search') || '%') ||
            ' OR COALESCE(s.node_id, '''') ILIKE ' ||
                quote_literal('%' || (p_filters->>'search') || '%') ||
            ' OR COALESCE(f.name, '''') ILIKE ' ||
                quote_literal('%' || (p_filters->>'search') || '%') ||
            ')';
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

    q := q || ' ORDER BY s.updated_at DESC, s.session_id DESC';

    IF p_limit IS NOT NULL THEN
        q := q || ' LIMIT ' || p_limit;
    END IF;
    IF p_offset IS NOT NULL AND p_offset > 0 THEN
        q := q || ' OFFSET ' || p_offset;
    END IF;

    RETURN QUERY EXECUTE q;
END;
$$;

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
    IF p_filters IS NOT NULL AND p_filters ? 'search' THEN
        q := q || ' AND (' ||
            'COALESCE(s.display_name, '''') ILIKE ' ||
                quote_literal('%' || (p_filters->>'search') || '%') ||
            ' OR s.session_id ILIKE ' ||
                quote_literal('%' || (p_filters->>'search') || '%') ||
            ' OR COALESCE(s.node_id, '''') ILIKE ' ||
                quote_literal('%' || (p_filters->>'search') || '%') ||
            ' OR COALESCE(f.name, '''') ILIKE ' ||
                quote_literal('%' || (p_filters->>'search') || '%') ||
            ')';
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
