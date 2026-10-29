TRUNCATE TABLE event_search_postings;

DROP INDEX IF EXISTS event_search_postings_term_cover;
ALTER TABLE event_search_postings DROP COLUMN IF EXISTS doc_len;

CREATE UNIQUE INDEX IF NOT EXISTS event_search_postings_term_cover
    ON event_search_postings (term_id, session_key, event_id)
    INCLUDE (term_freq);

CREATE TABLE IF NOT EXISTS event_search_event_types (
    event_type_id SMALLINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_type TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS event_search_documents (
    session_key INTEGER NOT NULL
        REFERENCES event_search_session_keys(session_key),
    event_id INTEGER NOT NULL,
    doc_len INTEGER NOT NULL,
    event_type_id SMALLINT NOT NULL
        REFERENCES event_search_event_types(event_type_id),
    created_at TIMESTAMPTZ,
    PRIMARY KEY (session_key, event_id)
        INCLUDE (doc_len, event_type_id, created_at)
) WITH (autovacuum_vacuum_insert_scale_factor = 0.05);

CREATE INDEX IF NOT EXISTS event_search_dictionary_prefix_cover
    ON event_search_dictionary ((term COLLATE "C"))
    INCLUDE (term_id, term);

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

        DELETE FROM event_search_documents document
        USING (
            SELECT DISTINCT session_key.session_key, old_posting.event_id
            FROM old_rows old_posting
            JOIN event_search_session_keys session_key
              ON session_key.session_id = old_posting.session_id
        ) old_document
        WHERE document.session_key = old_document.session_key
          AND document.event_id = old_document.event_id
          AND NOT EXISTS (
              SELECT 1
              FROM event_search_postings posting
              WHERE posting.session_key = document.session_key
                AND posting.event_id = document.event_id
          );
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

        INSERT INTO event_search_event_types (event_type)
        SELECT missing.event_type
        FROM (
            SELECT DISTINCT event.event_type
            FROM (
                SELECT DISTINCT session_id, event_id
                FROM new_rows
            ) new_document
            JOIN events event
              ON event.session_id = new_document.session_id
             AND event.id = new_document.event_id
        ) missing
        WHERE NOT EXISTS (
            SELECT 1
            FROM event_search_event_types existing
            WHERE existing.event_type = missing.event_type
        )
        ORDER BY missing.event_type COLLATE "C"
        ON CONFLICT (event_type) DO NOTHING;

        INSERT INTO event_search_documents (
            session_key, event_id, doc_len, event_type_id, created_at
        )
        SELECT session_key.session_key,
               new_document.event_id,
               new_document.doc_len,
               event_type.event_type_id,
               event.created_at
        FROM (
            SELECT session_id, event_id, MAX(doc_len) AS doc_len
            FROM new_rows
            GROUP BY session_id, event_id
        ) new_document
        JOIN events event
          ON event.session_id = new_document.session_id
         AND event.id = new_document.event_id
        JOIN event_search_session_keys session_key
          ON session_key.session_id = new_document.session_id
        JOIN event_search_event_types event_type
          ON event_type.event_type = event.event_type
        ORDER BY session_key.session_key, new_document.event_id
        ON CONFLICT (session_key, event_id) DO UPDATE
        SET doc_len = EXCLUDED.doc_len,
            event_type_id = EXCLUDED.event_type_id,
            created_at = EXCLUDED.created_at
        WHERE (event_search_documents.doc_len,
               event_search_documents.event_type_id,
               event_search_documents.created_at)
              IS DISTINCT FROM
              (EXCLUDED.doc_len, EXCLUDED.event_type_id, EXCLUDED.created_at);

        INSERT INTO event_search_postings (
            session_key, event_id, term_id, term_freq
        )
        SELECT session_key.session_key,
               rows.event_id,
               dictionary.term_id,
               rows.term_freq
        FROM new_rows rows
        JOIN event_search_session_keys session_key
          ON session_key.session_id = rows.session_id
        JOIN event_search_dictionary dictionary
          ON dictionary.term = rows.term
        ORDER BY dictionary.term_id, session_key.session_key, rows.event_id
        ON CONFLICT (term_id, session_key, event_id) DO UPDATE
        SET term_freq = EXCLUDED.term_freq;
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
