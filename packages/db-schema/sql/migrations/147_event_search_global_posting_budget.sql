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
    WITH RECURSIVE document_rows AS NOT MATERIALIZED (
 SELECT k.session_id,m.event_id AS id,m.created_at,m.doc_len
 FROM event_search_documents m
 JOIN event_search_session_keys k USING(session_key)
 WHERE (p_event_types IS NULL OR m.event_type_id = ANY(
    ARRAY(SELECT event_type_id FROM event_search_event_types WHERE event_type=ANY(p_event_types))))
), posting_rows AS NOT MATERIALIZED (
 SELECT k.session_id,p.event_id,d.term,p.term_freq,m.doc_len,m.created_at
 FROM event_search_postings p
 JOIN event_search_session_keys k USING(session_key)
 JOIN event_search_dictionary d USING(term_id)
 JOIN event_search_documents m USING(session_key,event_id)
 WHERE (p_event_types IS NULL OR m.event_type_id = ANY(
    ARRAY(SELECT event_type_id FROM event_search_event_types WHERE event_type=ANY(p_event_types))))
), query_terms AS (
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
        SELECT e.id, e.session_id, e.created_at
        FROM document_rows e
        JOIN sessions scoped_session ON scoped_session.session_id = e.session_id
        WHERE p_session_ids IS NOT NULL
          AND e.session_id = ANY(p_session_ids)
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
    -- Resolve terms before reading postings for the requested sessions.
    resolved_terms AS MATERIALIZED (
        SELECT d.term_id, q.term, df.doc_count
        FROM query_terms q
        JOIN query_term_document_frequencies df USING(term)
        JOIN event_search_dictionary d USING(term)
    ),
    scoped_matching_postings AS (
        SELECT q.term, k.session_id, p.event_id, p.term_freq, m.doc_len,
               q.doc_count, m.created_at
        FROM resolved_terms q
        CROSS JOIN event_search_session_keys k
        CROSS JOIN LATERAL (
            SELECT p.event_id,p.term_freq FROM event_search_postings p
            WHERE p.term_id=q.term_id AND p.session_key=k.session_key OFFSET 0
        ) p
        JOIN event_search_documents m ON m.session_key=k.session_key AND m.event_id=p.event_id
        WHERE p_session_ids IS NOT NULL AND k.session_id=ANY(p_session_ids)
          AND (p_event_types IS NULL OR m.event_type_id=ANY(ARRAY(
             SELECT event_type_id FROM event_search_event_types WHERE event_type=ANY(p_event_types))))
    ),
    global_term_pool AS MATERIALIZED (
        SELECT term_id, term, doc_count, 'exact'::text AS kind, NULL::float AS prefix_score
        FROM resolved_terms WHERE p_session_ids IS NULL
        UNION ALL
        SELECT d.term_id, d.term, event_search_document_frequency(d.term)::float,
               'prefix', max(0.000001 + LEAST(length(q.term)::float / GREATEST(length(d.term),1),1.0)*0.000001)
        FROM korean_prefix_terms q
        JOIN event_search_dictionary d ON left(d.term,3)=q.prefix AND d.term ~ '[가-힣]'
        WHERE p_session_ids IS NULL
        GROUP BY d.term_id,d.term
    ),
    global_ordered_terms AS MATERIALIZED (
        SELECT *, row_number() OVER (PARTITION BY kind ORDER BY doc_count,term_id) AS rn,
                  count(*) OVER (PARTITION BY kind) AS n
        FROM global_term_pool
    ),
    -- A global query reads at most 40000 postings. Exact terms get the whole
    -- budget unless Korean prefix expansion applies, in which case 10000 is
    -- reserved for prefix terms so common exact terms cannot starve them.
    global_budget AS (
        SELECT 'exact'::text AS kind,
               (CASE WHEN EXISTS (SELECT 1 FROM korean_prefix_terms)
                     THEN 30000 ELSE 40000 END)::bigint AS budget
        UNION ALL
        SELECT 'prefix'::text, 10000::bigint
    ),
    -- Each term's share is the remaining budget divided by the terms left.
    -- A term never reads more than 4000 postings once its share exceeds that,
    -- so a query mixing several common terms keeps only each term's newest.
    global_allocations AS (
        SELECT t.*,
               CASE WHEN t.doc_count <= b.budget/t.n THEN t.doc_count::bigint
                    ELSE LEAST(4000::bigint, b.budget/t.n) END AS quota,
               b.budget AS remaining
        FROM global_ordered_terms t
        JOIN global_budget b USING(kind)
        WHERE t.rn=1
        UNION ALL
        SELECT t.*, CASE WHEN t.doc_count <= (a.remaining-a.quota)/(t.n-t.rn+1) THEN t.doc_count::bigint ELSE LEAST(4000::bigint,(a.remaining-a.quota)/(t.n-t.rn+1)) END,a.remaining-a.quota
        FROM global_allocations a JOIN global_ordered_terms t ON t.kind=a.kind AND t.rn=a.rn+1
    ),
    global_bounded_postings AS MATERIALIZED (
        SELECT q.*,p.session_key,p.event_id,p.term_freq
        FROM global_allocations q
        CROSS JOIN LATERAL (
            SELECT p.session_key,p.event_id,p.term_freq
            FROM event_search_postings p WHERE p.term_id=q.term_id
            ORDER BY p.session_key DESC,p.event_id DESC LIMIT q.quota
        ) p
        WHERE q.kind='exact'
    ),
    global_matching_postings AS (
        SELECT q.term,k.session_id,q.event_id,q.term_freq,m.doc_len,q.doc_count,m.created_at
        FROM global_bounded_postings q
        JOIN event_search_documents m USING(session_key,event_id)
        JOIN event_search_session_keys k USING(session_key)
        WHERE q.kind='exact'
          AND (p_event_types IS NULL OR m.event_type_id=ANY(ARRAY(
             SELECT event_type_id FROM event_search_event_types WHERE event_type=ANY(p_event_types))))
    ),
    matching_postings AS (
        SELECT * FROM scoped_matching_postings
        UNION ALL
        SELECT * FROM global_matching_postings
    ),
    -- Sum exact BM25 term contributions once per event before the eligible-event join.
    scored_postings AS (
        SELECT
            posting.session_id,
            posting.event_id,
            MAX(posting.created_at) AS created_at,
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
        SELECT posting.event_id AS id, posting.session_id, posting.created_at, posting.score
        FROM scored_postings posting
        JOIN sessions scoped_session ON scoped_session.session_id=posting.session_id
        WHERE TRUE
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
    scored_candidates AS MATERIALIZED (
        SELECT id, session_id, created_at, score
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
        JOIN posting_rows t
          ON t.session_id = e.session_id
         AND t.event_id = e.id
        JOIN korean_prefix_terms q
          ON left(t.term, 3) = q.prefix
        WHERE t.term ~ '[가-힣]'
          AND EXISTS (SELECT 1 FROM korean_prefix_terms)
          AND (p_prefix_limit > 0 OR p_limit IS NULL
               OR (SELECT count FROM exact_count) < p_limit)
          AND NOT EXISTS (
              SELECT 1
              FROM scored_candidates s
              WHERE s.session_id = e.session_id
                AND s.id = e.id
          )
        GROUP BY e.id, e.session_id, e.created_at
    ),
    global_prefix_postings AS MATERIALIZED (
        SELECT k.session_id,p.event_id,MAX(m.created_at) AS created_at,MAX(q.prefix_score)::float AS score
        FROM global_allocations q
        CROSS JOIN LATERAL (
            SELECT p.session_key,p.event_id FROM event_search_postings p
            WHERE p.term_id=q.term_id
            ORDER BY p.session_key DESC,p.event_id DESC LIMIT q.quota
        ) p
        JOIN event_search_documents m USING(session_key,event_id)
        JOIN event_search_session_keys k USING(session_key)
        WHERE q.kind='prefix'
          AND (p_event_types IS NULL OR m.event_type_id=ANY(ARRAY(
             SELECT event_type_id FROM event_search_event_types WHERE event_type=ANY(p_event_types))))
          AND (p_prefix_limit>0 OR p_limit IS NULL OR (SELECT count FROM exact_count)<p_limit)
          AND NOT EXISTS(SELECT 1 FROM scored_candidates s WHERE s.session_id=k.session_id AND s.id=p.event_id)
        GROUP BY k.session_id,p.event_id
    ),
    global_prefix_scored AS (
        SELECT posting.event_id AS id, posting.session_id, posting.created_at, posting.score
        FROM global_prefix_postings posting
        JOIN sessions scoped_session ON scoped_session.session_id=posting.session_id
        WHERE TRUE
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
    prefix_scored AS (
        SELECT * FROM scoped_prefix_scored
        UNION ALL
        SELECT * FROM global_prefix_scored
    ),
    prefix_candidates AS MATERIALIZED (
        SELECT id, session_id, created_at, score
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
        SELECT id, session_id, created_at, score FROM scored_candidates
        UNION ALL
        SELECT id, session_id, created_at, score FROM prefix_candidates
    )
    SELECT e.id, e.session_id, e.event_type, e.payload,
           e.searchable_text, e.created_at, candidate.score
    FROM candidate_ids candidate
    CROSS JOIN LATERAL (
        SELECT ev.* FROM events ev
        WHERE ev.session_id = candidate.session_id AND ev.id = candidate.id
        OFFSET 0
    ) e
    ORDER BY candidate.score DESC, candidate.created_at DESC;
$$;
