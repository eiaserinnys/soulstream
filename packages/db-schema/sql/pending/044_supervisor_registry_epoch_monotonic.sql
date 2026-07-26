-- 044: enforce monotonic supervisor epochs at the database boundary
--
-- Intentionally NOT listed in migration-manifest.json. Runtime v2 remains
-- disabled by default, and an operator must approve this function replacement
-- before the delivery ledger can be enabled.
--
-- Same-target writes may reuse the current epoch because handover-state and
-- usage refreshes legitimately share one supervisor incarnation. A target
-- change must advance the epoch, and no write may regress it.

CREATE OR REPLACE FUNCTION supervisor_registry_upsert(
    p_role               TEXT,
    p_active_session_id  TEXT,
    p_epoch              BIGINT,
    p_cursor_offset      BIGINT,
    p_handover_state     TEXT,
    p_cumulative_tokens  BIGINT,
    p_compaction_count   INTEGER,
    p_last_seen_at       TIMESTAMPTZ
) RETURNS TABLE(
    role               TEXT,
    active_session_id  TEXT,
    epoch              BIGINT,
    cursor_offset      BIGINT,
    handover_state     TEXT,
    cumulative_tokens  BIGINT,
    compaction_count   INTEGER,
    last_seen_at       TIMESTAMPTZ,
    wake_dispatch_state TEXT,
    wake_last_signature TEXT,
    wake_repeat_count   INTEGER,
    wake_blocked_reason TEXT,
    wake_blocked_at     TIMESTAMPTZ,
    created_at         TIMESTAMPTZ,
    updated_at         TIMESTAMPTZ
) LANGUAGE plpgsql AS $$
DECLARE
    v_active_session_id TEXT;
    v_epoch BIGINT;
BEGIN
    IF p_epoch < 0 OR p_cursor_offset < 0 OR p_cumulative_tokens < 0 OR p_compaction_count < 0 THEN
        RAISE EXCEPTION 'epoch, cursor_offset, cumulative_tokens, and compaction_count must be non-negative';
    END IF;

    -- A same-role first insert has no row to lock yet. Serialize every role
    -- before reading so concurrent initial writes cannot bypass monotonicity.
    PERFORM pg_advisory_xact_lock(
        hashtext('supervisor_registry'),
        hashtext(p_role)
    );

    SELECT sr.active_session_id, sr.epoch
    INTO v_active_session_id, v_epoch
    FROM supervisor_registry AS sr
    WHERE sr.role = p_role
    FOR UPDATE;

    IF FOUND THEN
        IF p_epoch < v_epoch THEN
            RAISE EXCEPTION
                'supervisor epoch regression for role %: current %, requested %',
                p_role, v_epoch, p_epoch;
        END IF;
        IF p_active_session_id IS DISTINCT FROM v_active_session_id
           AND p_epoch <= v_epoch THEN
            RAISE EXCEPTION
                'supervisor target change requires epoch increase for role %: current %, requested %',
                p_role, v_epoch, p_epoch;
        END IF;
    END IF;

    INSERT INTO supervisor_registry (
        role,
        active_session_id,
        epoch,
        cursor_offset,
        handover_state,
        cumulative_tokens,
        compaction_count,
        last_seen_at,
        updated_at
    )
    VALUES (
        p_role,
        p_active_session_id,
        p_epoch,
        p_cursor_offset,
        p_handover_state,
        p_cumulative_tokens,
        p_compaction_count,
        p_last_seen_at,
        NOW()
    )
    ON CONFLICT ON CONSTRAINT supervisor_registry_pkey DO UPDATE
    SET active_session_id = EXCLUDED.active_session_id,
        epoch = EXCLUDED.epoch,
        cursor_offset = EXCLUDED.cursor_offset,
        handover_state = EXCLUDED.handover_state,
        cumulative_tokens = EXCLUDED.cumulative_tokens,
        compaction_count = EXCLUDED.compaction_count,
        last_seen_at = EXCLUDED.last_seen_at,
        updated_at = NOW();

    RETURN QUERY
    SELECT *
    FROM supervisor_registry_get(p_role);
END;
$$;
