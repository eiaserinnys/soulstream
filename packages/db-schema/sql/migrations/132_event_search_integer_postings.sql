CREATE TABLE IF NOT EXISTS event_search_session_keys (
    session_key INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    session_id TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS event_search_dictionary (
    term_id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    term TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS event_search_postings (
    session_key INTEGER NOT NULL
        REFERENCES event_search_session_keys(session_key),
    event_id INTEGER NOT NULL,
    term_id INTEGER NOT NULL
        REFERENCES event_search_dictionary(term_id),
    term_freq INTEGER NOT NULL,
    doc_len INTEGER NOT NULL
) WITH (autovacuum_vacuum_insert_scale_factor = 0.05);

CREATE UNIQUE INDEX IF NOT EXISTS event_search_postings_term_cover
    ON event_search_postings (term_id, session_key, event_id)
    INCLUDE (term_freq, doc_len);
CREATE INDEX IF NOT EXISTS idx_event_search_postings_event
    ON event_search_postings (session_key, event_id);

CREATE OR REPLACE FUNCTION mirror_event_search_postings()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP IN ('DELETE', 'UPDATE') THEN
        DELETE FROM event_search_postings posting
        USING old_rows old_posting
        JOIN event_search_session_keys session_key
          ON session_key.session_id = old_posting.session_id
        JOIN event_search_dictionary dictionary
          ON dictionary.term = old_posting.term
        WHERE posting.session_key = session_key.session_key
          AND posting.event_id = old_posting.event_id
          AND posting.term_id = dictionary.term_id;
    END IF;

    IF TG_OP IN ('INSERT', 'UPDATE') THEN
        INSERT INTO event_search_session_keys (session_id)
        SELECT missing.session_id
        FROM (
            SELECT DISTINCT rows.session_id
            FROM new_rows rows
            WHERE NOT EXISTS (
                SELECT 1
                FROM event_search_session_keys existing
                WHERE existing.session_id = rows.session_id
            )
        ) missing
        ORDER BY missing.session_id COLLATE "C"
        ON CONFLICT (session_id) DO NOTHING;

        INSERT INTO event_search_dictionary (term)
        SELECT missing.term
        FROM (
            SELECT DISTINCT rows.term
            FROM new_rows rows
            WHERE NOT EXISTS (
                SELECT 1
                FROM event_search_dictionary existing
                WHERE existing.term = rows.term
            )
        ) missing
        ORDER BY missing.term COLLATE "C"
        ON CONFLICT (term) DO NOTHING;

        INSERT INTO event_search_postings (
            session_key, event_id, term_id, term_freq, doc_len
        )
        SELECT session_key.session_key,
               rows.event_id,
               dictionary.term_id,
               rows.term_freq,
               rows.doc_len
        FROM new_rows rows
        JOIN event_search_session_keys session_key
          ON session_key.session_id = rows.session_id
        JOIN event_search_dictionary dictionary
          ON dictionary.term = rows.term
        ORDER BY dictionary.term_id, session_key.session_key, rows.event_id
        ON CONFLICT (term_id, session_key, event_id) DO UPDATE
        SET term_freq = EXCLUDED.term_freq,
            doc_len = EXCLUDED.doc_len;
    END IF;

    IF TG_OP NOT IN ('INSERT', 'UPDATE', 'DELETE') THEN
        RAISE EXCEPTION 'unexpected event_search_terms operation: %', TG_OP;
    END IF;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_event_search_postings_insert ON event_search_terms;
CREATE TRIGGER trg_event_search_postings_insert
    AFTER INSERT ON event_search_terms
    REFERENCING NEW TABLE AS new_rows
    FOR EACH STATEMENT EXECUTE FUNCTION mirror_event_search_postings();

DROP TRIGGER IF EXISTS trg_event_search_postings_update ON event_search_terms;
CREATE TRIGGER trg_event_search_postings_update
    AFTER UPDATE ON event_search_terms
    REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
    FOR EACH STATEMENT EXECUTE FUNCTION mirror_event_search_postings();

DROP TRIGGER IF EXISTS trg_event_search_postings_delete ON event_search_terms;
CREATE TRIGGER trg_event_search_postings_delete
    AFTER DELETE ON event_search_terms
    REFERENCING OLD TABLE AS old_rows
    FOR EACH STATEMENT EXECUTE FUNCTION mirror_event_search_postings();
