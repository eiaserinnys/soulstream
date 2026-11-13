-- 160: event search stats off the hot path, sessions row locks, session delete indexes (card #1332)
--
-- A. The two event search triggers on events become DEFERRABLE INITIALLY DEFERRED constraint
--    triggers (AFTER INSERT OR UPDATE OF searchable_text, AFTER DELETE). The search tables
--    and the single event_search_corpus_stats row are written at commit, so a transaction
--    never holds the stats row while it waits for a session row. Deferred events run in the
--    order they were queued. refresh_event_search_terms returns before the stats row when
--    the event has no old search document and no term in its new text; a term-changing
--    update with a (0, 0) delta still takes the stats row first (it serializes DF writes).
--    The stats row, its values and the search results are unchanged.
-- B. Session row locks that never delete the row or change session_id use FOR NO KEY UPDATE
--    so the KEY SHARE of a foreign key check on events, cards and the like does not queue
--    behind them: event_append, session_apply_metadata_entry, session_apply_last_chat_message,
--    session_apply_running_transition, session_record_execution_registration and
--    session_rotate_claude_id. The bodies below equal the previous definitions except for
--    that lock clause.
-- C. Deleting a session or an event runs the ON DELETE SET NULL checks of the tables that
--    reference it. The columns below had no usable index, so each check scanned the table.
--    cards.assignee_session_id only has a partial unique index (NOT archived) that the
--    check cannot use, so it gets its own.

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
 -- Nothing to write: no old search document and no term in the new text. Return
 -- before the stats row so an event that needs no search row never queues on it.
 IF v_old_doc_len IS NULL AND v_doc_len = 0 THEN
  RETURN NULL;
 END IF;
 -- Same serialization point as the old writer, before DF or mapping writes. A
 -- term-changing update with a (0, 0) delta still takes the stats row first.
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
 RETURN NULL;
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
 RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_event_search_terms ON events;
CREATE CONSTRAINT TRIGGER trg_event_search_terms
    AFTER INSERT OR UPDATE OF searchable_text ON events
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION refresh_event_search_terms();

DROP TRIGGER IF EXISTS trg_event_search_corpus_stats_delete ON events;
CREATE CONSTRAINT TRIGGER trg_event_search_corpus_stats_delete
    AFTER DELETE ON events
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION decrement_event_search_corpus_stats();

CREATE OR REPLACE FUNCTION event_append(
    p_session_id      TEXT,
    p_event_type      TEXT,
    p_payload         TEXT,
    p_searchable_text TEXT,
    p_created_at      TIMESTAMPTZ,
    p_dedupe_key      TEXT DEFAULT NULL
) RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE
    v_event_id INTEGER;
    v_payload  JSONB := p_payload::jsonb;
    v_parent   INTEGER;
BEGIN
    -- payload에서 parent_event_id 추출. 다음 케이스는 모두 NULL로 떨어진다:
    --   1) 키 자체가 없는 경우
    --   2) 비정수 문자열 (tool_use_id 'toolu_...', UUID 등 — 의미가 다른 레거시 키)
    --   3) INTEGER 범위(1..2147483647) 밖의 값 (timestamp 등 잘못 들어간 값)
    -- 길이 가드 ^\d{1,10}$로 BIGINT 캐스트 자체의 overflow 차단, BIGINT 범위 비교로 INT 한계 검증.
    -- events.id가 INTEGER SERIAL이므로 진짜 ancestor의 ID는 항상 1..INT_MAX 범위에 있음.
    v_parent := CASE
        WHEN v_payload->>'parent_event_id' ~ '^\d{1,10}$'
             AND (v_payload->>'parent_event_id')::BIGINT BETWEEN 1 AND 2147483647
        THEN (v_payload->>'parent_event_id')::INTEGER
        ELSE NULL
    END;
    IF v_parent IS NOT NULL AND NOT EXISTS (
        SELECT 1
        FROM events e
        WHERE e.session_id = p_session_id
          AND e.id = v_parent
    ) THEN
        v_parent := NULL;
    END IF;

    -- 행 잠금으로 동시 append 직렬화
    PERFORM session_id FROM sessions WHERE session_id = p_session_id FOR NO KEY UPDATE;

    IF p_dedupe_key IS NOT NULL THEN
        SELECT e.id INTO v_event_id
        FROM events e
        WHERE e.session_id = p_session_id
          AND e.dedupe_key = p_dedupe_key
        LIMIT 1;

        IF v_event_id IS NOT NULL THEN
            UPDATE sessions
            SET last_event_id = GREATEST(COALESCE(last_event_id, 0), v_event_id)
            WHERE session_id = p_session_id;
            RETURN v_event_id;
        END IF;
    END IF;

    INSERT INTO events (id, session_id, event_type, payload, searchable_text,
                        created_at, parent_event_id, dedupe_key)
    VALUES (
        (SELECT COALESCE(MAX(id), 0) + 1 FROM events WHERE session_id = p_session_id),
        p_session_id, p_event_type, v_payload, COALESCE(p_searchable_text, ''),
        p_created_at, v_parent, p_dedupe_key
    ) RETURNING id INTO v_event_id;

    UPDATE sessions SET last_event_id = v_event_id WHERE session_id = p_session_id;

    RETURN v_event_id;
END;
$$;

CREATE OR REPLACE FUNCTION session_apply_metadata_entry(
    p_session_id            TEXT,
    p_metadata_json         TEXT,
    p_replace_existing_type TEXT,
    p_updated_at            TIMESTAMPTZ
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
    v_metadata JSONB;
    v_entry    JSONB;
BEGIN
    SELECT COALESCE(metadata, '[]'::jsonb)
      INTO v_metadata
      FROM sessions
     WHERE session_id = p_session_id
     FOR NO KEY UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Session not found: %', p_session_id;
    END IF;

    IF p_replace_existing_type IS NOT NULL THEN
        SELECT COALESCE(jsonb_agg(entry), '[]'::jsonb)
          INTO v_metadata
          FROM jsonb_array_elements(v_metadata) AS entry
         WHERE entry->>'type' IS DISTINCT FROM p_replace_existing_type;
    END IF;

    v_entry := p_metadata_json::jsonb;
    v_metadata := v_metadata || jsonb_build_array(v_entry);

    -- caller_info is appended on every caller change and was never trimmed, so a
    -- long-lived session row grew to hundreds of KB. Keep the first entry (the
    -- session origin) and the last 20; other types and the order stay as they are.
    IF p_replace_existing_type IS NULL AND v_entry->>'type' = 'caller_info' THEN
        SELECT COALESCE(jsonb_agg(ranked.entry ORDER BY ranked.ord), '[]'::jsonb)
          INTO v_metadata
          FROM (
              SELECT t.entry,
                     t.ord,
                     row_number() OVER (PARTITION BY t.entry->>'type' ORDER BY t.ord) AS from_start,
                     row_number() OVER (PARTITION BY t.entry->>'type' ORDER BY t.ord DESC) AS from_end
                FROM jsonb_array_elements(v_metadata) WITH ORDINALITY AS t(entry, ord)
          ) AS ranked
         WHERE ranked.entry->>'type' IS DISTINCT FROM 'caller_info'
            OR ranked.from_start = 1
            OR ranked.from_end <= 20;
    END IF;

    UPDATE sessions
       SET metadata = v_metadata,
           updated_at = p_updated_at
     WHERE session_id = p_session_id;
END;
$$;

CREATE OR REPLACE FUNCTION session_apply_last_chat_message(
    p_session_id   TEXT,
    p_event_id     INTEGER,
    p_last_message JSONB,
    p_created_at   TIMESTAMPTZ
) RETURNS TABLE(applied BOOLEAN, last_message JSONB) LANGUAGE plpgsql AS $$
DECLARE
    v_existing JSONB;
    v_existing_timestamp TIMESTAMPTZ;
    v_existing_event_id INTEGER := 0;
    v_canonical JSONB;
BEGIN
    IF p_event_id IS NULL OR p_event_id <= 0
       OR p_created_at IS NULL
       OR jsonb_typeof(p_last_message) IS DISTINCT FROM 'object'
       OR p_last_message->>'type' NOT IN ('user_message', 'assistant_message')
       OR jsonb_typeof(p_last_message->'preview') IS DISTINCT FROM 'string'
       OR btrim(p_last_message->>'preview') = '' THEN
        RAISE EXCEPTION 'invalid canonical last chat message';
    END IF;

    SELECT sessions.last_message
      INTO v_existing
      FROM sessions
     WHERE session_id = p_session_id
     FOR NO KEY UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Session not found: %', p_session_id;
    END IF;

    v_existing_timestamp := session_feed_try_timestamptz(v_existing->>'timestamp');
    IF COALESCE(v_existing->>'eventId', v_existing->>'event_id', '') ~ '^[1-9][0-9]{0,9}$' THEN
        BEGIN
            v_existing_event_id := COALESCE(
                (v_existing->>'eventId')::INTEGER,
                (v_existing->>'event_id')::INTEGER,
                0
            );
        EXCEPTION WHEN numeric_value_out_of_range THEN
            v_existing_event_id := 0;
        END;
    END IF;

    v_canonical := jsonb_build_object(
        'type', p_last_message->>'type',
        'eventId', p_event_id,
        'preview', substring(btrim(p_last_message->>'preview') FROM 1 FOR 200),
        'timestamp', p_created_at
    );

    IF v_existing_timestamp IS NULL
       OR (p_created_at, p_event_id) > (v_existing_timestamp, v_existing_event_id) THEN
        UPDATE sessions
           SET last_message = v_canonical,
               updated_at = GREATEST(updated_at, p_created_at)
         WHERE session_id = p_session_id;
        RETURN QUERY SELECT TRUE, v_canonical;
    ELSE
        RETURN QUERY SELECT FALSE, v_existing;
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION session_apply_running_transition(
    p_session_id                 TEXT,
    p_review_state               TEXT,
    p_expected_terminal_event_id INTEGER,
    p_terminal_resume            BOOLEAN,
    p_updated_at                 TIMESTAMPTZ
) RETURNS TABLE (
    applied BOOLEAN, status TEXT, termination_reason TEXT,
    termination_detail TEXT, review_state TEXT, last_assistant_text TEXT,
    termination_event_id INTEGER, updated_at TIMESTAMPTZ, last_event_id INTEGER
) LANGUAGE plpgsql AS $$
DECLARE
    v_row_count INTEGER := 0;
    v_worktree_id TEXT;
    v_worktree_state TEXT;
    v_setup_required BOOLEAN;
    v_setup_status TEXT;
BEGIN
    SELECT session.worktree_id INTO v_worktree_id
      FROM sessions AS session
     WHERE session.session_id = p_session_id
     FOR NO KEY UPDATE;

    IF v_worktree_id IS NOT NULL THEN
        SELECT worktree.state, worktree.setup_required, worktree.setup_status
          INTO v_worktree_state, v_setup_required, v_setup_status
          FROM worktrees AS worktree
         WHERE worktree.id = v_worktree_id
         FOR UPDATE;
        IF NOT FOUND
           OR v_worktree_state <> 'ready'
           OR (v_setup_required AND v_setup_status <> 'ready')
           OR EXISTS (
             SELECT 1 FROM sessions AS active
              WHERE active.worktree_id = v_worktree_id
                AND active.session_id <> p_session_id
                AND active.status IN ('initializing', 'running')
           ) THEN
            RETURN QUERY
            SELECT FALSE, session.status, session.termination_reason,
                   session.termination_detail, session.review_state,
                   session.last_assistant_text, session.termination_event_id,
                   session.updated_at, session.last_event_id
              FROM sessions AS session
             WHERE session.session_id = p_session_id;
            RETURN;
        END IF;
    END IF;

    IF p_terminal_resume THEN
        UPDATE sessions AS session
           SET status = 'running', termination_reason = NULL,
               termination_detail = NULL, termination_event_id = NULL,
               last_assistant_text = NULL, review_state = p_review_state,
               updated_at = p_updated_at
         WHERE session.session_id = p_session_id
           AND session.status IN ('completed', 'error', 'interrupted')
           AND session.termination_event_id IS NOT DISTINCT FROM p_expected_terminal_event_id;
    ELSE
        UPDATE sessions AS session
           SET status = 'running', termination_reason = NULL,
               termination_detail = NULL, review_state = p_review_state,
               updated_at = p_updated_at
         WHERE session.session_id = p_session_id
           AND session.status NOT IN ('completed', 'error', 'interrupted');
    END IF;
    GET DIAGNOSTICS v_row_count = ROW_COUNT;

    IF p_terminal_resume AND v_row_count = 1 THEN
        UPDATE session_deliveries
           SET state = 'superseded', aggregate_state = 'consumed',
               consumed_at = p_updated_at,
               consumed_reason = 'superseded by terminal resume',
               superseded_at = p_updated_at,
               superseded_terminal_revision = p_expected_terminal_event_id::text,
               attempt_token = NULL, attempt_expires_at = NULL,
               updated_at = p_updated_at
         WHERE source_session_id = p_session_id
           AND intent = 'completion_notification'
           AND source = 'completion_notifier'
           AND producer_kind = 'child_session'
           AND producer_terminal_revision = p_expected_terminal_event_id::text
           AND state IN ('pending', 'claimed', 'dispatching', 'queued');
    END IF;

    RETURN QUERY
    SELECT v_row_count = 1, session.status, session.termination_reason,
           session.termination_detail, session.review_state,
           session.last_assistant_text, session.termination_event_id,
           session.updated_at, session.last_event_id
      FROM sessions AS session
     WHERE session.session_id = p_session_id;
END;
$$;

CREATE OR REPLACE FUNCTION session_record_execution_registration(
    p_session_id                 TEXT,
    p_registration_id            TEXT,
    p_execution_command_id       TEXT,
    p_review_state               TEXT,
    p_expected_terminal_event_id INTEGER,
    p_terminal_resume            BOOLEAN,
    p_recorded_at                TIMESTAMPTZ
) RETURNS TABLE (
    applied                      BOOLEAN,
    execution_registration_id    TEXT,
    execution_command_id         TEXT,
    status                       TEXT,
    termination_reason           TEXT,
    termination_detail           TEXT,
    review_state                 TEXT,
    last_assistant_text          TEXT,
    termination_event_id         INTEGER,
    updated_at                   TIMESTAMPTZ,
    last_event_id                INTEGER
) LANGUAGE plpgsql AS $$
DECLARE
    v_row_count INTEGER := 0;
    v_worktree_id TEXT;
    v_worktree_state TEXT;
    v_setup_required BOOLEAN;
    v_setup_status TEXT;
BEGIN
    IF p_registration_id IS NULL OR p_registration_id = ''
       OR p_execution_command_id IS NULL OR p_execution_command_id = '' THEN
        RAISE EXCEPTION 'complete execution registration required';
    END IF;
    IF p_review_state NOT IN ('not_required', 'needs_review', 'acknowledged') THEN
        RAISE EXCEPTION 'unsupported review state: %', p_review_state;
    END IF;

    SELECT session.worktree_id INTO v_worktree_id
      FROM sessions AS session
     WHERE session.session_id = p_session_id
     FOR NO KEY UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'session not found: %', p_session_id;
    END IF;

    IF v_worktree_id IS NOT NULL THEN
        SELECT worktree.state, worktree.setup_required, worktree.setup_status
          INTO v_worktree_state, v_setup_required, v_setup_status
          FROM worktrees AS worktree
         WHERE worktree.id = v_worktree_id
         FOR UPDATE;
        IF NOT FOUND
           OR v_worktree_state <> 'ready'
           OR (v_setup_required AND v_setup_status <> 'ready')
           OR EXISTS (
             SELECT 1 FROM sessions AS active
              WHERE active.worktree_id = v_worktree_id
                AND active.session_id <> p_session_id
                AND active.status IN ('initializing', 'running')
           ) THEN
            RETURN QUERY
            SELECT FALSE,
                   session.execution_registration_id,
                   session.execution_command_id,
                   session.status,
                   session.termination_reason,
                   session.termination_detail,
                   session.review_state,
                   session.last_assistant_text,
                   session.termination_event_id,
                   session.updated_at,
                   session.last_event_id
              FROM sessions AS session
             WHERE session.session_id = p_session_id;
            RETURN;
        END IF;
    END IF;

    IF p_terminal_resume THEN
        UPDATE sessions AS session
           SET status = 'running',
               termination_reason = NULL,
               termination_detail = NULL,
               termination_event_id = NULL,
               last_assistant_text = NULL,
               review_state = p_review_state,
               execution_registration_id = p_registration_id,
               execution_command_id = p_execution_command_id,
               updated_at = p_recorded_at
         WHERE session.session_id = p_session_id
           AND session.status IN ('completed', 'error', 'interrupted')
           AND session.termination_event_id IS NOT DISTINCT FROM p_expected_terminal_event_id;
    ELSE
        UPDATE sessions AS session
           SET status = 'running',
               termination_reason = NULL,
               termination_detail = NULL,
               review_state = p_review_state,
               execution_registration_id = p_registration_id,
               execution_command_id = p_execution_command_id,
               updated_at = p_recorded_at
         WHERE session.session_id = p_session_id
           AND session.status NOT IN ('completed', 'error', 'interrupted');
    END IF;
    GET DIAGNOSTICS v_row_count = ROW_COUNT;

    IF v_row_count = 1 AND p_terminal_resume THEN
        UPDATE session_deliveries
           SET state = 'superseded',
               aggregate_state = 'consumed',
               consumed_at = p_recorded_at,
               consumed_reason = 'superseded by terminal resume',
               superseded_at = p_recorded_at,
               superseded_terminal_revision = p_expected_terminal_event_id::text,
               attempt_token = NULL,
               attempt_expires_at = NULL,
               updated_at = p_recorded_at
         WHERE source_session_id = p_session_id
           AND intent = 'completion_notification'
           AND source = 'completion_notifier'
           AND producer_kind = 'child_session'
           AND producer_terminal_revision = p_expected_terminal_event_id::text
           AND state IN ('pending', 'claimed', 'dispatching', 'queued');
    END IF;

    RETURN QUERY
    SELECT v_row_count = 1,
           session.execution_registration_id,
           session.execution_command_id,
           session.status,
           session.termination_reason,
           session.termination_detail,
           session.review_state,
           session.last_assistant_text,
           session.termination_event_id,
           session.updated_at,
           session.last_event_id
      FROM sessions AS session
     WHERE session.session_id = p_session_id;
END;
$$;

CREATE OR REPLACE FUNCTION session_rotate_claude_id(
    p_session_id                TEXT,
    p_expected_claude_session_id TEXT,
    p_new_claude_session_id     TEXT
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
    v_existing TEXT;
BEGIN
    SELECT claude_session_id INTO v_existing
    FROM sessions
    WHERE session_id = p_session_id
    FOR NO KEY UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Session not found: %', p_session_id;
    ELSIF v_existing = p_new_claude_session_id THEN
        NULL;
    ELSIF v_existing IS DISTINCT FROM p_expected_claude_session_id THEN
        RAISE EXCEPTION 'claude_session_id rotation predecessor mismatch: session_id=%, expected=%, existing=%, new=%',
            p_session_id, p_expected_claude_session_id, v_existing, p_new_claude_session_id;
    ELSE
        UPDATE sessions
        SET claude_session_id = p_new_claude_session_id,
            updated_at = NOW()
        WHERE session_id = p_session_id;
    END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_folder_operations_actor_session
    ON folder_operations(actor_session_id, actor_event_id)
    WHERE actor_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cards_assignee_session_id
    ON cards(assignee_session_id) WHERE assignee_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cards_created_session_id
    ON cards(created_session_id) WHERE created_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cards_updated_session_id
    ON cards(updated_session_id) WHERE updated_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cards_completed_session_id
    ON cards(completed_session_id) WHERE completed_session_id IS NOT NULL;
