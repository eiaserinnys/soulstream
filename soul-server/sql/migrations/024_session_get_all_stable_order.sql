-- Migration 024: session_get_all 안정 정렬 tie-break 추가
--
-- 배포 메커니즘: soul-server-ts Haniel pre_start가 apply-schema.mjs를 실행하고,
-- apply-schema.mjs는 soul-server/sql/schema.sql 전체를 적용한다.
-- 이 파일은 변경 이력 문서화 목적이며 DB에 직접 실행하지 않는다.

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
