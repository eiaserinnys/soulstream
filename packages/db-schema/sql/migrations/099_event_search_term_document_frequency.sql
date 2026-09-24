-- Maintain exact per-term document frequencies and remove request-time posting counts.
CREATE TABLE IF NOT EXISTS event_search_term_document_frequency (
    term TEXT PRIMARY KEY,
    document_count BIGINT NOT NULL CHECK (document_count >= 0)
);

CREATE OR REPLACE FUNCTION event_search_adjust_term_document_frequency(
    p_term TEXT,
    p_delta BIGINT
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    IF p_delta = 0 THEN
        RETURN;
    END IF;

    IF p_delta > 0 THEN
        INSERT INTO event_search_term_document_frequency (term, document_count)
        VALUES (p_term, p_delta)
        ON CONFLICT (term) DO UPDATE
        SET document_count =
            event_search_term_document_frequency.document_count + EXCLUDED.document_count;
    ELSE
        UPDATE event_search_term_document_frequency
        SET document_count = document_count + p_delta
        WHERE term = p_term;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'event search term document frequency is missing for term %', p_term
                USING ERRCODE = '55000';
        END IF;
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION update_event_search_term_document_frequency()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
    v_delta RECORD;
BEGIN
    IF TG_OP = 'INSERT' THEN
        FOR v_delta IN
            SELECT term, COUNT(*)::BIGINT AS delta
            FROM new_rows
            GROUP BY term
            ORDER BY term COLLATE "C"
        LOOP
            PERFORM event_search_adjust_term_document_frequency(v_delta.term, v_delta.delta);
        END LOOP;
    ELSIF TG_OP = 'DELETE' THEN
        FOR v_delta IN
            SELECT term, -COUNT(*)::BIGINT AS delta
            FROM old_rows
            GROUP BY term
            ORDER BY term COLLATE "C"
        LOOP
            PERFORM event_search_adjust_term_document_frequency(v_delta.term, v_delta.delta);
        END LOOP;
    ELSIF TG_OP = 'UPDATE' THEN
        FOR v_delta IN
            SELECT term, SUM(delta)::BIGINT AS delta
            FROM (
                SELECT term, COUNT(*)::BIGINT AS delta
                FROM new_rows
                GROUP BY term
                UNION ALL
                SELECT term, -COUNT(*)::BIGINT AS delta
                FROM old_rows
                GROUP BY term
            ) changed_terms
            GROUP BY term
            HAVING SUM(delta) <> 0
            ORDER BY term COLLATE "C"
        LOOP
            PERFORM event_search_adjust_term_document_frequency(v_delta.term, v_delta.delta);
        END LOOP;
    ELSE
        RAISE EXCEPTION 'unexpected event_search_terms operation: %', TG_OP;
    END IF;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_event_search_term_df_insert ON event_search_terms;
CREATE TRIGGER trg_event_search_term_df_insert
    AFTER INSERT ON event_search_terms
    REFERENCING NEW TABLE AS new_rows
    FOR EACH STATEMENT EXECUTE FUNCTION update_event_search_term_document_frequency();

DROP TRIGGER IF EXISTS trg_event_search_term_df_update ON event_search_terms;
CREATE TRIGGER trg_event_search_term_df_update
    AFTER UPDATE ON event_search_terms
    REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
    FOR EACH STATEMENT EXECUTE FUNCTION update_event_search_term_document_frequency();

DROP TRIGGER IF EXISTS trg_event_search_term_df_delete ON event_search_terms;
CREATE TRIGGER trg_event_search_term_df_delete
    AFTER DELETE ON event_search_terms
    REFERENCING OLD TABLE AS old_rows
    FOR EACH STATEMENT EXECUTE FUNCTION update_event_search_term_document_frequency();

CREATE OR REPLACE FUNCTION event_search_document_frequency(p_term TEXT)
RETURNS BIGINT LANGUAGE plpgsql STABLE PARALLEL SAFE AS $$
DECLARE
    v_document_count BIGINT;
BEGIN
    SELECT document_count INTO v_document_count
    FROM event_search_term_document_frequency
    WHERE term = p_term;

    IF FOUND THEN
        IF v_document_count = 0 AND EXISTS (
            SELECT 1 FROM event_search_terms WHERE term = p_term
        ) THEN
            RAISE EXCEPTION 'event search term document frequency is inconsistent for term %', p_term
                USING ERRCODE = '55000';
        END IF;
        RETURN v_document_count;
    END IF;

    IF EXISTS (
        SELECT 1 FROM event_search_terms WHERE term = p_term
    ) THEN
        RAISE EXCEPTION 'event search term document frequency is missing for term %', p_term
            USING ERRCODE = '55000';
    END IF;
    RETURN 0;
END;
$$;

LOCK TABLE event_search_terms IN SHARE ROW EXCLUSIVE MODE;

INSERT INTO event_search_term_document_frequency (term, document_count)
SELECT term, COUNT(*)::BIGINT
FROM event_search_terms
GROUP BY term
ORDER BY term COLLATE "C"
ON CONFLICT (term) DO UPDATE
SET document_count = EXCLUDED.document_count;

CREATE OR REPLACE FUNCTION refresh_event_search_terms() RETURNS TRIGGER AS $$
DECLARE
    v_tokens TEXT[];
    v_doc_len INTEGER;
    v_old_doc_len INTEGER;
BEGIN
    SELECT MAX(doc_len) INTO v_old_doc_len
    FROM event_search_terms
    WHERE session_id = NEW.session_id
      AND event_id = NEW.id;

    v_tokens := event_search_tokenize(NEW.searchable_text);
    v_doc_len := cardinality(v_tokens);

    -- Acquire the corpus-stat row before ordered per-term DF locks to serialize event-index rewrites.
    PERFORM event_search_adjust_corpus_stats(
        CASE WHEN v_doc_len > 0 THEN 1 ELSE 0 END
          - CASE WHEN v_old_doc_len IS NOT NULL THEN 1 ELSE 0 END,
        v_doc_len - COALESCE(v_old_doc_len, 0)
    );

    DELETE FROM event_search_terms
    WHERE session_id = NEW.session_id
      AND event_id = NEW.id;

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
