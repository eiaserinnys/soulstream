-- Replace the term-only posting index with an index that can return every
-- posting field consumed by global BM25 scoring without visiting the heap.
-- This migration runner applies SQL transactionally, so do not use CONCURRENTLY.
-- A failed build/validation rolls back this transaction and retains the legacy index.

DO $$
DECLARE
    v_table oid;
    v_btree oid;
    v_text_ops oid;
    v_term_att smallint;
    v_session_id_att smallint;
    v_event_id_att smallint;
    v_term_freq_att smallint;
    v_doc_len_att smallint;
    v_term_collation oid;
    v_term_index oid;
    v_staging_index oid;
    v_index_is_covering boolean := false;
BEGIN
    v_table := to_regclass('public.event_search_terms');
    IF v_table IS NULL THEN
        RAISE EXCEPTION 'event_search_terms is missing';
    END IF;

    v_term_index := to_regclass('public.idx_event_search_terms_term');
    v_staging_index := to_regclass('public.idx_event_search_terms_term_covering_101');

    -- A leftover staging object requires inspection even when the canonical
    -- name already points at a covering index; never silently accept two.
    IF v_staging_index IS NOT NULL THEN
        RAISE EXCEPTION
            'event search term staging index already exists; inspect it before retrying';
    END IF;

    SELECT oid INTO v_btree
    FROM pg_am
    WHERE amname = 'btree';

    SELECT oid INTO v_text_ops
    FROM pg_opclass
    WHERE opcnamespace = 'pg_catalog'::regnamespace
      AND opcname = 'text_ops'
      AND opcmethod = v_btree
      AND opcintype = 'text'::regtype
      AND opcdefault;

    SELECT attnum, attcollation INTO v_term_att, v_term_collation
    FROM pg_attribute
    WHERE attrelid = v_table AND attname = 'term' AND NOT attisdropped;
    SELECT attnum INTO v_session_id_att
    FROM pg_attribute
    WHERE attrelid = v_table AND attname = 'session_id' AND NOT attisdropped;
    SELECT attnum INTO v_event_id_att
    FROM pg_attribute
    WHERE attrelid = v_table AND attname = 'event_id' AND NOT attisdropped;
    SELECT attnum INTO v_term_freq_att
    FROM pg_attribute
    WHERE attrelid = v_table AND attname = 'term_freq' AND NOT attisdropped;
    SELECT attnum INTO v_doc_len_att
    FROM pg_attribute
    WHERE attrelid = v_table AND attname = 'doc_len' AND NOT attisdropped;

    IF v_btree IS NULL OR v_text_ops IS NULL OR v_term_att IS NULL
       OR v_session_id_att IS NULL OR v_event_id_att IS NULL
       OR v_term_freq_att IS NULL OR v_doc_len_att IS NULL THEN
        RAISE EXCEPTION 'event search term index contract is unavailable';
    END IF;

    -- Fresh installs already contain the canonical final index. A ledger-recovery
    -- pass may replay later migrations, so accept only that exact valid shape.
    IF v_term_index IS NOT NULL THEN
        SELECT EXISTS (
            SELECT 1
            FROM pg_index i
            JOIN pg_class index_relation ON index_relation.oid = i.indexrelid
            JOIN pg_am access_method ON access_method.oid = index_relation.relam
            WHERE i.indexrelid = v_term_index
              AND i.indrelid = v_table
              AND access_method.oid = v_btree
              AND i.indisvalid
              AND i.indisready
              AND i.indislive
              AND NOT i.indisunique
              AND i.indnkeyatts = 1
              AND i.indnatts = 5
              AND i.indkey[0] = v_term_att
              AND i.indkey[1] = v_session_id_att
              AND i.indkey[2] = v_event_id_att
              AND i.indkey[3] = v_term_freq_att
              AND i.indkey[4] = v_doc_len_att
              AND i.indclass[0] = v_text_ops
              AND i.indcollation[0] = v_term_collation
              AND i.indoption[0] = 0
              AND i.indpred IS NULL
              AND i.indexprs IS NULL
        ) INTO v_index_is_covering;
    END IF;

    IF NOT v_index_is_covering THEN
        IF NOT EXISTS (
            SELECT 1
            FROM pg_index i
            JOIN pg_class index_relation ON index_relation.oid = i.indexrelid
            JOIN pg_am access_method ON access_method.oid = index_relation.relam
            WHERE i.indexrelid = v_term_index
              AND i.indrelid = v_table
              AND access_method.oid = v_btree
              AND i.indisvalid
              AND i.indisready
              AND i.indislive
              AND NOT i.indisunique
              AND i.indnkeyatts = 1
              AND i.indnatts = 1
              AND i.indkey[0] = v_term_att
              AND i.indclass[0] = v_text_ops
              AND i.indcollation[0] = v_term_collation
              AND i.indoption[0] = 0
              AND i.indpred IS NULL
              AND i.indexprs IS NULL
        ) THEN
            RAISE EXCEPTION 'legacy event search term index is missing or invalid';
        END IF;

        EXECUTE $create_index$
            CREATE INDEX idx_event_search_terms_term_covering_101
                ON public.event_search_terms USING btree (term)
                INCLUDE (session_id, event_id, term_freq, doc_len)
        $create_index$;

        v_staging_index := to_regclass('public.idx_event_search_terms_term_covering_101');
        SELECT EXISTS (
            SELECT 1
            FROM pg_index i
            JOIN pg_class index_relation ON index_relation.oid = i.indexrelid
            JOIN pg_am access_method ON access_method.oid = index_relation.relam
            WHERE i.indexrelid = v_staging_index
              AND i.indrelid = v_table
              AND access_method.oid = v_btree
              AND i.indisvalid
              AND i.indisready
              AND i.indislive
              AND NOT i.indisunique
              AND i.indnkeyatts = 1
              AND i.indnatts = 5
              AND i.indkey[0] = v_term_att
              AND i.indkey[1] = v_session_id_att
              AND i.indkey[2] = v_event_id_att
              AND i.indkey[3] = v_term_freq_att
              AND i.indkey[4] = v_doc_len_att
              AND i.indclass[0] = v_text_ops
              AND i.indcollation[0] = v_term_collation
              AND i.indoption[0] = 0
              AND i.indpred IS NULL
              AND i.indexprs IS NULL
        ) INTO v_index_is_covering;

        IF NOT v_index_is_covering THEN
            RAISE EXCEPTION 'covering event search term index did not become valid and ready';
        END IF;

        EXECUTE 'DROP INDEX public.idx_event_search_terms_term';
        EXECUTE 'ALTER INDEX public.idx_event_search_terms_term_covering_101 '
            || 'RENAME TO idx_event_search_terms_term';
    END IF;
END;
$$;
