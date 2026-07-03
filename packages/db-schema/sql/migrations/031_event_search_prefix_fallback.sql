CREATE TABLE IF NOT EXISTS event_search_corpus_stats (
    id            BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
    total_docs    BIGINT NOT NULL DEFAULT 0 CHECK (total_docs >= 0),
    total_doc_len BIGINT NOT NULL DEFAULT 0 CHECK (total_doc_len >= 0),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION event_search_adjust_corpus_stats(
    p_doc_delta     INTEGER,
    p_doc_len_delta INTEGER
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO event_search_corpus_stats (id, total_docs, total_doc_len, updated_at)
    VALUES (TRUE, 0, 0, NOW())
    ON CONFLICT (id) DO NOTHING;

    UPDATE event_search_corpus_stats
    SET total_docs = GREATEST(total_docs + p_doc_delta, 0),
        total_doc_len = GREATEST(total_doc_len + p_doc_len_delta, 0),
        updated_at = NOW()
    WHERE id = TRUE;
END;
$$;

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

    IF v_old_doc_len IS NOT NULL THEN
        PERFORM event_search_adjust_corpus_stats(-1, -v_old_doc_len);
    END IF;

    DELETE FROM event_search_terms
    WHERE session_id = NEW.session_id
      AND event_id = NEW.id;

    v_tokens := event_search_tokenize(NEW.searchable_text);
    v_doc_len := cardinality(v_tokens);

    IF v_doc_len > 0 THEN
        INSERT INTO event_search_terms (
            session_id, event_id, term, term_freq, doc_len
        )
        SELECT NEW.session_id, NEW.id, term, COUNT(*)::INTEGER, v_doc_len
        FROM unnest(v_tokens) AS token(term)
        GROUP BY term;

        PERFORM event_search_adjust_corpus_stats(1, v_doc_len);
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION decrement_event_search_corpus_stats() RETURNS TRIGGER AS $$
DECLARE
    v_old_doc_len INTEGER;
BEGIN
    SELECT MAX(doc_len) INTO v_old_doc_len
    FROM event_search_terms
    WHERE session_id = OLD.session_id
      AND event_id = OLD.id;

    IF v_old_doc_len IS NOT NULL THEN
        PERFORM event_search_adjust_corpus_stats(-1, -v_old_doc_len);
    END IF;

    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_event_search_terms ON events;
CREATE TRIGGER trg_event_search_terms
    AFTER INSERT OR UPDATE OF searchable_text ON events
    FOR EACH ROW EXECUTE FUNCTION refresh_event_search_terms();

DROP TRIGGER IF EXISTS trg_event_search_corpus_stats_delete ON events;
CREATE TRIGGER trg_event_search_corpus_stats_delete
    BEFORE DELETE ON events
    FOR EACH ROW EXECUTE FUNCTION decrement_event_search_corpus_stats();

INSERT INTO event_search_corpus_stats (id, total_docs, total_doc_len, updated_at)
SELECT
    TRUE,
    COUNT(*)::BIGINT,
    COALESCE(SUM(doc_len), 0)::BIGINT,
    NOW()
FROM (
    SELECT DISTINCT session_id, event_id, doc_len
    FROM event_search_terms
) docs
ON CONFLICT (id) DO UPDATE
SET total_docs = EXCLUDED.total_docs,
    total_doc_len = EXCLUDED.total_doc_len,
    updated_at = NOW();

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
    doc_freq AS (
        SELECT t.term, COUNT(DISTINCT (t.session_id, t.event_id))::FLOAT AS doc_count
        FROM query_terms q
        JOIN event_search_terms t ON t.term = q.term
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
        FROM query_terms q
        JOIN event_search_terms t ON t.term = q.term
        JOIN doc_freq df ON df.term = t.term
        JOIN corpus c ON c.total_docs > 0
        JOIN events e
          ON e.session_id = t.session_id
         AND e.id = t.event_id
        WHERE (p_session_ids IS NULL OR e.session_id = ANY(p_session_ids))
          AND (p_event_types IS NULL OR e.event_type = ANY(p_event_types))
        GROUP BY
            e.id, e.session_id, e.event_type, e.payload,
            e.searchable_text, e.created_at
    ),
    exact_count AS (
        SELECT COUNT(*) AS count FROM scored
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
        JOIN events e
          ON e.session_id = t.session_id
         AND e.id = t.event_id
        WHERE t.term ~ '[가-힣]'
          AND (p_session_ids IS NULL OR e.session_id = ANY(p_session_ids))
          AND (p_event_types IS NULL OR e.event_type = ANY(p_event_types))
          AND (p_limit IS NULL OR (SELECT count FROM exact_count) < p_limit)
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
