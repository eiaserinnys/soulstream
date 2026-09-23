CREATE OR REPLACE FUNCTION session_search_compact(p_text TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT regexp_replace(
        lower(normalize(coalesce(p_text, ''), NFKC)),
        '[[:space:][:punct:]]+',
        '',
        'g'
    );
$$;

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS display_name_search_key TEXT
    GENERATED ALWAYS AS (session_search_compact(display_name)) STORED;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS prompt_search_key TEXT
    GENERATED ALWAYS AS (session_search_compact(prompt)) STORED;
CREATE INDEX IF NOT EXISTS idx_sessions_display_name_search_key
    ON sessions(display_name_search_key text_pattern_ops)
    WHERE display_name_search_key <> '';
CREATE INDEX IF NOT EXISTS idx_sessions_prompt_search_key
    ON sessions(prompt_search_key text_pattern_ops)
    WHERE prompt_search_key <> '';

-- 21. event_search
DROP FUNCTION IF EXISTS event_search(TEXT, TEXT[], INTEGER);
DROP FUNCTION IF EXISTS event_search(TEXT, TEXT[], INTEGER, TEXT[]);
DROP FUNCTION IF EXISTS event_search(TEXT, TEXT[], INTEGER, TEXT[], TEXT[]);
DROP FUNCTION IF EXISTS event_search(TEXT, TEXT[], INTEGER, TEXT[], TEXT[], INTEGER);
DROP FUNCTION IF EXISTS event_search(TEXT, TEXT[], INTEGER, TEXT[], TEXT[], INTEGER, INTEGER);
CREATE OR REPLACE FUNCTION event_search(
    p_query       TEXT,
    p_session_ids TEXT[] DEFAULT NULL,
    p_limit       INTEGER DEFAULT 50,
    p_event_types TEXT[] DEFAULT NULL,
    p_allowed_folder_ids TEXT[] DEFAULT NULL,
    p_per_session_limit INTEGER DEFAULT NULL,
    p_prefix_limit INTEGER DEFAULT 0
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
    corpus AS (
        SELECT
            total_docs::FLOAT AS total_docs,
            CASE
                WHEN total_docs > 0 THEN total_doc_len::FLOAT / total_docs::FLOAT
                ELSE 0
            END AS avg_doc_len
        FROM event_search_corpus_stats
        WHERE id = TRUE
    ),
    -- The event_search_terms primary key guarantees one posting per document/term.
    matching_postings AS (
        SELECT q.term, t.session_id, t.event_id, t.term_freq, t.doc_len,
               COUNT(*) OVER (PARTITION BY q.term)::FLOAT AS doc_count
        FROM query_terms q
        JOIN event_search_terms t ON t.term = q.term
    ),
    -- Reuse only the exact top-k identities when deciding whether prefix fallback is needed.
    scored_exact AS (
        SELECT
            e.id,
            e.session_id,
            e.event_type,
            e.created_at,
            SUM(
                ln(1 + ((c.total_docs - posting.doc_count + 0.5) / (posting.doc_count + 0.5))) *
                (
                    (posting.term_freq * 2.2) /
                    (
                        posting.term_freq +
                        1.2 * (
                            0.25 +
                            0.75 * (posting.doc_len::FLOAT / GREATEST(c.avg_doc_len, 1))
                        )
                    )
                )
            )::FLOAT AS score
        FROM matching_postings posting
        JOIN corpus c ON c.total_docs > 0
        JOIN events e
          ON e.session_id = posting.session_id
         AND e.id = posting.event_id
        JOIN sessions scoped_session ON scoped_session.session_id = e.session_id
        WHERE (p_session_ids IS NULL OR e.session_id = ANY(p_session_ids))
          AND (p_event_types IS NULL OR e.event_type = ANY(p_event_types))
          AND (p_allowed_folder_ids IS NULL
               OR scoped_session.folder_id = ANY(p_allowed_folder_ids))
        GROUP BY e.id, e.session_id, e.event_type, e.created_at
    ),
    scored_candidates AS MATERIALIZED (
        SELECT id, session_id, event_type, created_at, score
        FROM (
            SELECT scored_exact.*,
                   ROW_NUMBER() OVER (
                       PARTITION BY session_id
                       ORDER BY score DESC, created_at DESC, id ASC
                   ) AS session_rank
            FROM scored_exact
        ) ranked_exact
        WHERE p_per_session_limit IS NULL OR session_rank <= p_per_session_limit
        ORDER BY score DESC, created_at DESC, id ASC
        LIMIT p_limit
    ),
    exact_count AS (
        SELECT COUNT(*) AS count FROM scored_candidates
    ),
    prefix_scored AS (
        SELECT
            e.id,
            e.session_id,
            e.event_type,
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
        JOIN events e
          ON e.session_id = t.session_id
         AND e.id = t.event_id
        JOIN sessions scoped_session ON scoped_session.session_id = e.session_id
        WHERE t.term ~ '[가-힣]'
          AND (p_session_ids IS NULL OR e.session_id = ANY(p_session_ids))
          AND (p_event_types IS NULL OR e.event_type = ANY(p_event_types))
          AND (p_allowed_folder_ids IS NULL
               OR scoped_session.folder_id = ANY(p_allowed_folder_ids))
          AND (p_prefix_limit > 0 OR p_limit IS NULL
               OR (SELECT count FROM exact_count) < p_limit)
          AND NOT EXISTS (
              SELECT 1
              FROM scored_candidates s
              WHERE s.session_id = e.session_id
                AND s.id = e.id
          )
        GROUP BY e.id, e.session_id, e.event_type, e.created_at
    ),
    prefix_candidates AS MATERIALIZED (
        SELECT id, session_id, event_type, created_at, score
        FROM (
            SELECT prefix_scored.*,
                   ROW_NUMBER() OVER (
                   PARTITION BY session_id
                   ORDER BY score DESC, created_at DESC, id ASC
                   ) AS session_rank
            FROM prefix_scored
        ) ranked_prefix
        WHERE p_per_session_limit IS NULL OR session_rank <= p_per_session_limit
        ORDER BY score DESC, created_at DESC, id ASC
        LIMIT CASE
            WHEN p_prefix_limit > 0 THEN p_prefix_limit
            WHEN p_limit IS NULL THEN NULL
            ELSE GREATEST(p_limit - (SELECT count FROM exact_count), 0)
        END
    ),
    candidate_ids AS MATERIALIZED (
        SELECT id, session_id, event_type, created_at, score FROM scored_candidates
        UNION ALL
        SELECT id, session_id, event_type, created_at, score FROM prefix_candidates
    )
    SELECT e.id, e.session_id, e.event_type, e.payload,
           e.searchable_text, e.created_at, candidate.score
    FROM candidate_ids candidate
    JOIN events e ON e.session_id = candidate.session_id AND e.id = candidate.id
    ORDER BY candidate.score DESC, candidate.created_at DESC;
$$;

DROP FUNCTION IF EXISTS session_id_search(TEXT, TEXT[], INTEGER);
DROP FUNCTION IF EXISTS session_id_search(TEXT, TEXT[], INTEGER, TEXT[]);
CREATE OR REPLACE FUNCTION session_id_search(
    p_query       TEXT,
    p_event_types TEXT[] DEFAULT NULL,
    p_limit       INTEGER DEFAULT 50,
    p_allowed_folder_ids TEXT[] DEFAULT NULL
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
          AND (p_allowed_folder_ids IS NULL
               OR s.folder_id = ANY(p_allowed_folder_ids))
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
