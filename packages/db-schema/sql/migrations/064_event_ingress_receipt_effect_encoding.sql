-- Migration 064 normalises event_ingress_receipts.effect_application rows that were
-- stored double-encoded. The writer bound JSON.stringify(...) to a JSONB parameter, and
-- postgres.js serialises a JS string destined for JSONB as a JSON *string* -- so every
-- receipt this path ever wrote landed as jsonb 'string' instead of 'object'.
--
-- The reader (findCanonicalEffectApplication) selects on `effect_application IS NOT NULL`
-- and then requires a record, so a double-encoded row is found but unreadable. That threw
-- inside the batch transaction, rolled the whole batch back, and dropped the node socket --
-- which reconnected and replayed the identical head forever. One such row halted every
-- later event on that node's stream (260813: eias-linegames-wsl, ~4h, 0 events delivered).
--
-- Rewriting is per-row and guarded: a payload that does not parse to a JSON object is left
-- exactly as it is. Leaving one row behind costs a single quarantined envelope once the
-- accompanying orch fix ships; aborting the migration would leave every row behind.
DO $$
DECLARE
    r            RECORD;
    v_decoded    JSONB;
    v_normalised INTEGER := 0;
    v_skipped    INTEGER := 0;
BEGIN
    FOR r IN
        SELECT node_id, stream_id, source_seq, effect_application #>> '{}' AS raw
        FROM event_ingress_receipts
        WHERE jsonb_typeof(effect_application) = 'string'
    LOOP
        BEGIN
            v_decoded := r.raw::jsonb;
        EXCEPTION WHEN others THEN
            v_skipped := v_skipped + 1;
            CONTINUE;
        END;

        IF jsonb_typeof(v_decoded) <> 'object' THEN
            v_skipped := v_skipped + 1;
            CONTINUE;
        END IF;

        UPDATE event_ingress_receipts
           SET effect_application = v_decoded
         WHERE node_id   = r.node_id
           AND stream_id = r.stream_id
           AND source_seq = r.source_seq;

        v_normalised := v_normalised + 1;
    END LOOP;

    RAISE NOTICE 'migration 064: normalised % receipt(s), left % unparsable row(s) in place',
        v_normalised, v_skipped;
END
$$;
