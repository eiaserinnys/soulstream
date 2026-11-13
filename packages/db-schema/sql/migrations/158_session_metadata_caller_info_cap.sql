-- 158: cap the caller_info entries that session_apply_metadata_entry keeps
--
-- caller_info was appended to sessions.metadata every time the caller changed and
-- never trimmed, so a session many callers talk to (a persistent session) reached
-- ~580KB and the whole-row read that routes a message timed out (card #1319).
-- When a caller_info entry is appended (no replace_existing_type), keep the first
-- caller_info and the last 20. Entries of other types and the overall order are
-- untouched, and every other call path behaves as before. Rows that are already
-- large shrink the next time a caller_info is appended; there is no backfill.
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
     FOR UPDATE;
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
