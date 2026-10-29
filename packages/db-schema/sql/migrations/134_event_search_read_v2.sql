CREATE OR REPLACE FUNCTION public.event_search_document_frequency(p_term TEXT)
RETURNS BIGINT LANGUAGE plpgsql STABLE PARALLEL SAFE AS $function$
DECLARE
    v_document_count BIGINT;
BEGIN
    SELECT document_count INTO v_document_count
    FROM event_search_term_document_frequency
    WHERE term = p_term;

    IF FOUND THEN
        IF v_document_count = 0 AND EXISTS (
            SELECT 1
            FROM event_search_dictionary dictionary
            JOIN event_search_postings posting USING (term_id)
            WHERE dictionary.term = p_term
        ) THEN
            RAISE EXCEPTION 'event search term document frequency is inconsistent for term %', p_term
                USING ERRCODE = '55000';
        END IF;
        RETURN v_document_count;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM event_search_dictionary dictionary
        JOIN event_search_postings posting USING (term_id)
        WHERE dictionary.term = p_term
    ) THEN
        RAISE EXCEPTION 'event search term document frequency is missing for term %', p_term
            USING ERRCODE = '55000';
    END IF;
    RETURN 0;
END;
$function$;

CREATE OR REPLACE FUNCTION public.event_search(p_query text, p_session_ids text[] DEFAULT NULL::text[], p_limit integer DEFAULT 50, p_event_types text[] DEFAULT NULL::text[], p_allowed_folder_ids text[] DEFAULT NULL::text[], p_per_session_limit integer DEFAULT NULL::integer, p_prefix_limit integer DEFAULT 0, p_node_id text DEFAULT NULL::text, p_statuses text[] DEFAULT NULL::text[], p_updated_after timestamp with time zone DEFAULT NULL::timestamp with time zone, p_backends text[] DEFAULT NULL::text[], p_backend_catalog jsonb DEFAULT '[]'::jsonb)
 RETURNS TABLE(id integer, session_id text, event_type text, payload jsonb, searchable_text text, created_at timestamp with time zone, score double precision)
 LANGUAGE sql
 STABLE
AS $function$
    WITH document_rows AS NOT MATERIALIZED (
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
    -- A session-scoped query uses the (session_id, event_id, term) primary key
    -- for candidate postings. Global document frequencies remain exact, but
    -- only their term keys are read before the scope is applied.
    scoped_matching_postings AS (
        SELECT q.term, t.session_id, t.event_id, t.term_freq, t.doc_len,
               df.doc_count, t.created_at
        FROM scoped_events e
        JOIN posting_rows t
          ON t.session_id = e.session_id
         AND t.event_id = e.id
        JOIN query_terms q ON q.term = t.term
        JOIN query_term_document_frequencies df ON df.term = q.term
    ),
    -- Unscoped searches keep the term-first path, which avoids scanning every
    -- event when the caller supplied no session IDs.
    global_matching_postings AS (
        SELECT q.term, t.session_id, t.event_id, t.term_freq, t.doc_len,
               df.doc_count, t.created_at
        FROM query_terms q
        JOIN query_term_document_frequencies df ON df.term = q.term
        JOIN posting_rows t ON t.term = q.term
        WHERE p_session_ids IS NULL
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
          ON t.term COLLATE "C" >= q.prefix COLLATE "C"
         AND t.term COLLATE "C" <
             (left(q.prefix,2) || chr(ascii(right(q.prefix,1))+1)) COLLATE "C"
         AND left(t.term,3) COLLATE "C" = q.prefix COLLATE "C"
        WHERE t.term ~ '[가-힣]'
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
        SELECT t.session_id, t.event_id, MAX(t.created_at) AS created_at,
            MAX(
                0.000001 +
                LEAST(
                    length(q.term)::FLOAT /
                    GREATEST(length(t.term), 1)::FLOAT,
                    1.0
                ) * 0.000001
            )::FLOAT AS score
        FROM korean_prefix_terms q
        JOIN posting_rows t
          ON t.term COLLATE "C" >= q.prefix COLLATE "C"
         AND t.term COLLATE "C" <
             (left(q.prefix,2) || chr(ascii(right(q.prefix,1))+1)) COLLATE "C"
         AND left(t.term,3) COLLATE "C" = q.prefix COLLATE "C"
        WHERE p_session_ids IS NULL
          AND t.term ~ '[가-힣]'
          AND (p_prefix_limit > 0 OR p_limit IS NULL
               OR (SELECT count FROM exact_count) < p_limit)
          AND NOT EXISTS (
              SELECT 1 FROM scored_candidates s
              WHERE s.session_id = t.session_id AND s.id = t.event_id
          )
        GROUP BY t.session_id, t.event_id
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
$function$

;
