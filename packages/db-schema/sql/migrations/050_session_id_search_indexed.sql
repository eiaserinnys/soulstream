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
    WITH matched_sessions AS (
        SELECT s.session_id
        FROM sessions s
        WHERE s.session_id ILIKE '%' || p_query || '%'
        ORDER BY s.updated_at DESC
        LIMIT p_limit
    )
    SELECT latest.id, latest.session_id, latest.event_type, latest.payload,
           latest.searchable_text, latest.created_at,
           0.5::FLOAT AS score
    FROM matched_sessions matched
    CROSS JOIN LATERAL (
        SELECT e.id, e.session_id, e.event_type,
               e.payload, e.searchable_text, e.created_at
        FROM events e
        WHERE e.session_id = matched.session_id
          AND (p_event_types IS NULL OR e.event_type = ANY(p_event_types))
        ORDER BY e.id DESC
        LIMIT 1
    ) latest
    ORDER BY latest.id DESC
    LIMIT p_limit;
$$;
