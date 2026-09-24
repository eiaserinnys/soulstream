-- Score exact term postings per event before event and session row lookups.

CREATE OR REPLACE FUNCTION event_search(
    p_query       TEXT,
    p_session_ids TEXT[] DEFAULT NULL,
    p_limit       INTEGER DEFAULT 50,
    p_event_types TEXT[] DEFAULT NULL,
    p_allowed_folder_ids TEXT[] DEFAULT NULL,
    p_per_session_limit INTEGER DEFAULT NULL,
    p_prefix_limit INTEGER DEFAULT 0,
    p_node_id TEXT DEFAULT NULL,
    p_statuses TEXT[] DEFAULT NULL,
    p_updated_after TIMESTAMPTZ DEFAULT NULL,
    p_backends TEXT[] DEFAULT NULL,
    p_backend_catalog JSONB DEFAULT '[]'::jsonb
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
    query_term_document_frequencies AS MATERIALIZED (
        SELECT term, event_search_document_frequency(term)::FLOAT AS doc_count
        FROM query_terms
    ),
    scoped_events AS MATERIALIZED (
        SELECT e.id, e.session_id, e.event_type, e.created_at
        FROM events e
        JOIN sessions scoped_session ON scoped_session.session_id = e.session_id
        WHERE p_session_ids IS NOT NULL
          AND e.session_id = ANY(p_session_ids)
          AND (p_event_types IS NULL OR e.event_type = ANY(p_event_types))
          AND (p_allowed_folder_ids IS NULL
               OR scoped_session.folder_id = ANY(p_allowed_folder_ids))
          AND (p_node_id IS NULL OR scoped_session.node_id = p_node_id)
          AND (p_statuses IS NULL OR scoped_session.status = ANY(p_statuses))
          AND (p_updated_after IS NULL OR scoped_session.updated_at >= p_updated_after)
          AND (p_backends IS NULL OR COALESCE(
            (SELECT mapping.value->>'backend'
             FROM jsonb_array_elements(p_backend_catalog) AS mapping(value)
             WHERE mapping.value->>'kind' = 'preset'
               AND mapping.value->>'node_id' = scoped_session.node_id
               AND mapping.value->>'model_preset' = scoped_session.model_preset
             LIMIT 1),
            (SELECT mapping.value->>'backend'
             FROM jsonb_array_elements(p_backend_catalog) AS mapping(value)
             WHERE mapping.value->>'kind' = 'agent'
               AND mapping.value->>'node_id' = scoped_session.node_id
               AND mapping.value->>'agent_id' = scoped_session.agent_id
             LIMIT 1)
          ) = ANY(p_backends))
    ),
    -- A session-scoped query uses the (session_id, event_id, term) primary key
    -- for candidate postings. Global document frequencies remain exact, but
    -- only their term keys are read before the scope is applied.
    scoped_matching_postings AS (
        SELECT q.term, t.session_id, t.event_id, t.term_freq, t.doc_len,
               df.doc_count
        FROM scoped_events e
        JOIN event_search_terms t
          ON t.session_id = e.session_id
         AND t.event_id = e.id
        JOIN query_terms q ON q.term = t.term
        JOIN query_term_document_frequencies df ON df.term = q.term
    ),
    -- Unscoped searches keep the term-first path, which avoids scanning every
    -- event when the caller supplied no session IDs.
    global_matching_postings AS (
        SELECT q.term, t.session_id, t.event_id, t.term_freq, t.doc_len,
               df.doc_count
        FROM query_terms q
        JOIN query_term_document_frequencies df ON df.term = q.term
        JOIN event_search_terms t ON t.term = q.term
        WHERE p_session_ids IS NULL
    ),
    matching_postings AS (
        SELECT * FROM scoped_matching_postings
        UNION ALL
        SELECT * FROM global_matching_postings
    ),
    -- Build the eligible event set once; scoped searches reuse their session-first path.
    eligible_events AS MATERIALIZED (
        SELECT id, session_id, event_type, created_at
        FROM scoped_events
        UNION ALL
        SELECT
            e.id,
            e.session_id,
            e.event_type,
            e.created_at
        FROM events e
        JOIN sessions scoped_session ON scoped_session.session_id = e.session_id
        WHERE p_session_ids IS NULL
          AND (p_event_types IS NULL OR e.event_type = ANY(p_event_types))
          AND (p_allowed_folder_ids IS NULL
               OR scoped_session.folder_id = ANY(p_allowed_folder_ids))
          AND (p_node_id IS NULL OR scoped_session.node_id = p_node_id)
          AND (p_statuses IS NULL OR scoped_session.status = ANY(p_statuses))
          AND (p_updated_after IS NULL OR scoped_session.updated_at >= p_updated_after)
          AND (p_backends IS NULL OR COALESCE(
            (SELECT mapping.value->>'backend'
             FROM jsonb_array_elements(p_backend_catalog) AS mapping(value)
             WHERE mapping.value->>'kind' = 'preset'
               AND mapping.value->>'node_id' = scoped_session.node_id
               AND mapping.value->>'model_preset' = scoped_session.model_preset
             LIMIT 1),
            (SELECT mapping.value->>'backend'
             FROM jsonb_array_elements(p_backend_catalog) AS mapping(value)
             WHERE mapping.value->>'kind' = 'agent'
               AND mapping.value->>'node_id' = scoped_session.node_id
               AND mapping.value->>'agent_id' = scoped_session.agent_id
             LIMIT 1)
          ) = ANY(p_backends))
    ),
    -- Sum exact BM25 term contributions once per event before the eligible-event join.
    scored_postings AS (
        SELECT
            posting.session_id,
            posting.event_id,
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
        GROUP BY posting.session_id, posting.event_id
    ),
    -- Apply event and session filters before per-session ranking and global top-k.
    scored_exact AS (
        SELECT
            e.id,
            e.session_id,
            e.event_type,
            e.created_at,
            posting.score
        FROM scored_postings posting
        JOIN eligible_events e
          ON e.session_id = posting.session_id
         AND e.id = posting.event_id
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
    scoped_prefix_scored AS (
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
        FROM scoped_events e
        JOIN event_search_terms t
          ON t.session_id = e.session_id
         AND t.event_id = e.id
        JOIN korean_prefix_terms q
          ON t.term >= q.prefix
         AND t.term < q.prefix || U&'\FFFF'
        WHERE t.term ~ '[가-힣]'
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
    global_prefix_scored AS (
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
          AND (p_node_id IS NULL OR scoped_session.node_id = p_node_id)
          AND (p_statuses IS NULL OR scoped_session.status = ANY(p_statuses))
          AND (p_updated_after IS NULL OR scoped_session.updated_at >= p_updated_after)
          AND (p_backends IS NULL OR COALESCE(
            (SELECT mapping.value->>'backend'
             FROM jsonb_array_elements(p_backend_catalog) AS mapping(value)
             WHERE mapping.value->>'kind' = 'preset'
               AND mapping.value->>'node_id' = scoped_session.node_id
               AND mapping.value->>'model_preset' = scoped_session.model_preset
             LIMIT 1),
            (SELECT mapping.value->>'backend'
             FROM jsonb_array_elements(p_backend_catalog) AS mapping(value)
             WHERE mapping.value->>'kind' = 'agent'
               AND mapping.value->>'node_id' = scoped_session.node_id
               AND mapping.value->>'agent_id' = scoped_session.agent_id
             LIMIT 1)
          ) = ANY(p_backends))
          AND p_session_ids IS NULL
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
    prefix_scored AS (
        SELECT * FROM scoped_prefix_scored
        UNION ALL
        SELECT * FROM global_prefix_scored
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
