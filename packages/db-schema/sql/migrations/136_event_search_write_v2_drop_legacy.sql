-- Run inside the migration runner transaction; preserve lock order on upgrade and replay.
LOCK TABLE events IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
    IF to_regclass('event_search_terms') IS NOT NULL THEN
        LOCK TABLE event_search_terms IN ACCESS EXCLUSIVE MODE;
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION refresh_event_search_terms() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
 v_tokens TEXT[];
 v_doc_len INTEGER;
 v_old_doc_len INTEGER;
 v_session_key INTEGER;
 v_event_type_id SMALLINT;
 v_delta RECORD;
BEGIN
 SELECT session_key INTO v_session_key FROM event_search_session_keys WHERE session_id=NEW.session_id;
 SELECT doc_len INTO v_old_doc_len FROM event_search_documents
 WHERE session_key=v_session_key AND event_id=NEW.id;
 v_tokens := event_search_tokenize(NEW.searchable_text);
 v_doc_len := cardinality(v_tokens);
 -- Same serialization point as the old writer, before DF or mapping writes.
 PERFORM event_search_adjust_corpus_stats(
  CASE WHEN v_doc_len>0 THEN 1 ELSE 0 END - CASE WHEN v_old_doc_len IS NOT NULL THEN 1 ELSE 0 END,
  v_doc_len-COALESCE(v_old_doc_len,0));
 FOR v_delta IN
  WITH removed AS (
   DELETE FROM event_search_postings WHERE session_key=v_session_key AND event_id=NEW.id RETURNING term_id
  )
  SELECT d.term,-COUNT(*)::BIGINT AS delta FROM removed r JOIN event_search_dictionary d USING(term_id)
  GROUP BY d.term ORDER BY d.term COLLATE "C"
 LOOP
  PERFORM event_search_adjust_term_document_frequency(v_delta.term,v_delta.delta);
 END LOOP;
 DELETE FROM event_search_documents WHERE session_key=v_session_key AND event_id=NEW.id;
 IF v_doc_len>0 THEN
  IF v_session_key IS NULL THEN
   INSERT INTO event_search_session_keys(session_id) VALUES(NEW.session_id) ON CONFLICT(session_id) DO NOTHING;
   SELECT session_key INTO STRICT v_session_key FROM event_search_session_keys WHERE session_id=NEW.session_id;
  END IF;
  INSERT INTO event_search_dictionary(term)
  SELECT missing.term FROM (SELECT DISTINCT term FROM unnest(v_tokens) token(term)) missing
  WHERE NOT EXISTS(SELECT 1 FROM event_search_dictionary d WHERE d.term=missing.term)
  ORDER BY missing.term COLLATE "C" ON CONFLICT(term) DO NOTHING;
  INSERT INTO event_search_event_types(event_type)
  SELECT NEW.event_type WHERE NOT EXISTS(SELECT 1 FROM event_search_event_types WHERE event_type=NEW.event_type)
  ON CONFLICT(event_type) DO NOTHING;
  SELECT event_type_id INTO STRICT v_event_type_id FROM event_search_event_types WHERE event_type=NEW.event_type;
  INSERT INTO event_search_documents(session_key,event_id,doc_len,event_type_id,created_at)
  VALUES(v_session_key,NEW.id,v_doc_len,v_event_type_id,NEW.created_at);
  FOR v_delta IN
   WITH added AS (
    INSERT INTO event_search_postings(session_key,event_id,term_id,term_freq)
    SELECT v_session_key,NEW.id,d.term_id,t.term_freq
    FROM (SELECT term,COUNT(*)::INTEGER AS term_freq FROM unnest(v_tokens) token(term) GROUP BY term) t
    JOIN event_search_dictionary d ON d.term=t.term ORDER BY d.term_id
    RETURNING term_id
   )
   SELECT d.term,COUNT(*)::BIGINT AS delta FROM added a JOIN event_search_dictionary d USING(term_id)
   GROUP BY d.term ORDER BY d.term COLLATE "C"
  LOOP
   PERFORM event_search_adjust_term_document_frequency(v_delta.term,v_delta.delta);
  END LOOP;
 END IF;
 RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION decrement_event_search_corpus_stats() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
 v_session_key INTEGER;
 v_doc_len INTEGER;
 v_delta RECORD;
BEGIN
 SELECT k.session_key,m.doc_len INTO v_session_key,v_doc_len
 FROM event_search_session_keys k JOIN event_search_documents m USING(session_key)
 WHERE k.session_id=OLD.session_id AND m.event_id=OLD.id;
 IF FOUND THEN
  PERFORM event_search_adjust_corpus_stats(-1,-v_doc_len);
  FOR v_delta IN
   WITH removed AS (
    DELETE FROM event_search_postings WHERE session_key=v_session_key AND event_id=OLD.id RETURNING term_id
   )
   SELECT d.term,-COUNT(*)::BIGINT AS delta FROM removed r JOIN event_search_dictionary d USING(term_id)
   GROUP BY d.term ORDER BY d.term COLLATE "C"
  LOOP
   PERFORM event_search_adjust_term_document_frequency(v_delta.term,v_delta.delta);
  END LOOP;
  DELETE FROM event_search_documents WHERE session_key=v_session_key AND event_id=OLD.id;
 END IF;
 RETURN OLD;
END;
$$;

DO $$
BEGIN
    IF to_regclass('event_search_terms') IS NOT NULL THEN
        DROP TRIGGER IF EXISTS trg_event_search_postings_insert ON event_search_terms;
        DROP TRIGGER IF EXISTS trg_event_search_postings_update ON event_search_terms;
        DROP TRIGGER IF EXISTS trg_event_search_postings_delete ON event_search_terms;
        DROP TRIGGER IF EXISTS trg_event_search_term_df_insert ON event_search_terms;
        DROP TRIGGER IF EXISTS trg_event_search_term_df_update ON event_search_terms;
        DROP TRIGGER IF EXISTS trg_event_search_term_df_delete ON event_search_terms;
    END IF;
END;
$$;
DROP FUNCTION IF EXISTS mirror_event_search_postings();
DROP FUNCTION IF EXISTS update_event_search_term_document_frequency();
DROP TABLE IF EXISTS event_search_terms RESTRICT;
