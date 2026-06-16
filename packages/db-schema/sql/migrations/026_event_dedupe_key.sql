-- Durable event idempotency for Claude SDK resume re-yields.

ALTER TABLE events ADD COLUMN IF NOT EXISTS dedupe_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_events_session_dedupe_key
    ON events (session_id, dedupe_key)
    WHERE dedupe_key IS NOT NULL;

DROP FUNCTION IF EXISTS event_append(TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ);

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

    PERFORM session_id FROM sessions WHERE session_id = p_session_id FOR UPDATE;

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
        p_session_id, p_event_type, v_payload, p_searchable_text,
        p_created_at, v_parent, p_dedupe_key
    ) RETURNING id INTO v_event_id;

    UPDATE sessions SET last_event_id = v_event_id WHERE session_id = p_session_id;

    RETURN v_event_id;
END;
$$;
