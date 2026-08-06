CREATE TABLE IF NOT EXISTS session_mutation_receipts (
    idempotency_key TEXT PRIMARY KEY,
    operation       TEXT NOT NULL,
    session_id      TEXT NOT NULL,
    request_hash    TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    result_json     JSONB NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_session_mutation_receipts_session
    ON session_mutation_receipts (session_id, created_at DESC);

CREATE OR REPLACE FUNCTION session_apply_metadata_entry(
    p_session_id           TEXT,
    p_metadata_json        TEXT,
    p_replace_existing_type TEXT,
    p_updated_at           TIMESTAMPTZ
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
    v_metadata JSONB;
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

    UPDATE sessions
       SET metadata = v_metadata || jsonb_build_array(p_metadata_json::jsonb),
           updated_at = p_updated_at
     WHERE session_id = p_session_id;
END;
$$;
