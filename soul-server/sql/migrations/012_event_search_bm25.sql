-- Migration 012: BM25 event search index and ranking
--
-- event_search_terms stores per-event term frequency and document length.
-- event_search() ranks matching events with BM25 instead of PostgreSQL ts_rank.

CREATE TABLE IF NOT EXISTS event_search_terms (
    session_id TEXT NOT NULL,
    event_id   INTEGER NOT NULL,
    term       TEXT NOT NULL,
    term_freq  INTEGER NOT NULL,
    doc_len    INTEGER NOT NULL,
    PRIMARY KEY (session_id, event_id, term),
    FOREIGN KEY (session_id, event_id)
        REFERENCES events(session_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_event_search_terms_term ON event_search_terms (term);

CREATE OR REPLACE FUNCTION event_search_tokenize(p_text TEXT)
RETURNS TEXT[] LANGUAGE sql IMMUTABLE AS $$
    SELECT COALESCE(array_agg(term), ARRAY[]::TEXT[])
    FROM regexp_split_to_table(
        lower(coalesce(p_text, '')),
        '[^[:alnum:]_가-힣]+'
    ) AS token(term)
    WHERE term <> '';
$$;

CREATE OR REPLACE FUNCTION refresh_event_search_terms() RETURNS TRIGGER AS $$
DECLARE
    v_tokens TEXT[];
    v_doc_len INTEGER;
BEGIN
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
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_event_search_terms ON events;
CREATE TRIGGER trg_event_search_terms
    AFTER INSERT OR UPDATE OF searchable_text ON events
    FOR EACH ROW EXECUTE FUNCTION refresh_event_search_terms();

DELETE FROM event_search_terms;

INSERT INTO event_search_terms (session_id, event_id, term, term_freq, doc_len)
SELECT session_id, id, term, COUNT(*)::INTEGER, cardinality(tokens)
FROM (
    SELECT e.session_id,
           e.id,
           event_search_tokenize(e.searchable_text) AS tokens
    FROM events e
    WHERE e.searchable_text IS NOT NULL
      AND e.searchable_text <> ''
) tokenized
CROSS JOIN LATERAL unnest(tokens) AS token(term)
WHERE cardinality(tokens) > 0
GROUP BY session_id, id, term, cardinality(tokens);

DROP FUNCTION IF EXISTS event_search(TEXT, TEXT[], INTEGER);
DROP FUNCTION IF EXISTS event_search(TEXT, TEXT[], INTEGER, TEXT[]);
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
    )
    SELECT id, session_id, event_type, payload, searchable_text, created_at, score
    FROM scored
    ORDER BY score DESC, created_at DESC
    LIMIT p_limit;
$$;
