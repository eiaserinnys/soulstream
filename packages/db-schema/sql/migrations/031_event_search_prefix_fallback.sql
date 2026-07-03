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
    korean_prefix_terms AS (
        SELECT DISTINCT term, left(term, 3) AS prefix
        FROM query_terms
        WHERE term ~ '[가-힣]'
          AND length(term) >= 3
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
    ),
    prefix_scored AS (
        SELECT
            e.id,
            e.session_id,
            e.event_type,
            e.payload,
            e.searchable_text,
            e.created_at,
            MAX(
                0.000001 +
                LEAST(
                    length(q.term)::FLOAT /
                    GREATEST(length(t.term), 1)::FLOAT,
                    1.0
                ) * 0.000001
            )::FLOAT AS score
        FROM korean_prefix_terms q
        JOIN event_search_terms t
          ON t.term >= q.prefix
         AND t.term < q.prefix || U&'\FFFF'
        JOIN filtered_events e
          ON e.session_id = t.session_id
         AND e.id = t.event_id
        WHERE t.term ~ '[가-힣]'
          AND (p_limit IS NULL OR (SELECT COUNT(*) FROM scored) < p_limit)
          AND NOT EXISTS (
              SELECT 1
              FROM scored s
              WHERE s.session_id = e.session_id
                AND s.id = e.id
          )
        GROUP BY
            e.id, e.session_id, e.event_type, e.payload,
            e.searchable_text, e.created_at
    ),
    combined AS (
        SELECT id, session_id, event_type, payload, searchable_text, created_at, score
        FROM scored
        UNION ALL
        SELECT id, session_id, event_type, payload, searchable_text, created_at, score
        FROM prefix_scored
    )
    SELECT id, session_id, event_type, payload, searchable_text, created_at, score
    FROM combined
    ORDER BY score DESC, created_at DESC
    LIMIT p_limit;
$$;
