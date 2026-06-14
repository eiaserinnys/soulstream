-- 022: Persist supervisor wake dispatch circuit-breaker state.

ALTER TABLE IF EXISTS supervisor_registry
    ADD COLUMN IF NOT EXISTS wake_dispatch_state TEXT NOT NULL DEFAULT 'active';
ALTER TABLE IF EXISTS supervisor_registry
    ADD COLUMN IF NOT EXISTS wake_last_signature TEXT;
ALTER TABLE IF EXISTS supervisor_registry
    ADD COLUMN IF NOT EXISTS wake_repeat_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE IF EXISTS supervisor_registry
    ADD COLUMN IF NOT EXISTS wake_blocked_reason TEXT;
ALTER TABLE IF EXISTS supervisor_registry
    ADD COLUMN IF NOT EXISTS wake_blocked_at TIMESTAMPTZ;

DO $$
BEGIN
    ALTER TABLE supervisor_registry
        ADD CONSTRAINT supervisor_registry_wake_dispatch_state_check
        CHECK (wake_dispatch_state IN ('active', 'retrying', 'blocked'));
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE supervisor_registry
        ADD CONSTRAINT supervisor_registry_wake_repeat_count_check
        CHECK (wake_repeat_count >= 0);
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DROP FUNCTION IF EXISTS supervisor_registry_upsert(
    TEXT,
    TEXT,
    BIGINT,
    BIGINT,
    TEXT,
    BIGINT,
    INTEGER,
    TIMESTAMPTZ
);
DROP FUNCTION IF EXISTS supervisor_registry_touch(TEXT, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS supervisor_registry_record_usage_delta(TEXT, BIGINT, INTEGER, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS supervisor_registry_set_wake_dispatch_state(
    TEXT,
    TEXT,
    TEXT,
    INTEGER,
    TEXT,
    TIMESTAMPTZ
);
DROP FUNCTION IF EXISTS supervisor_registry_get(TEXT);
DROP FUNCTION IF EXISTS supervisor_registry_list();

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
BEGIN
    IF p_epoch < 0 OR p_cursor_offset < 0 OR p_cumulative_tokens < 0 OR p_compaction_count < 0 THEN
        RAISE EXCEPTION 'epoch, cursor_offset, cumulative_tokens, and compaction_count must be non-negative';
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

CREATE OR REPLACE FUNCTION supervisor_registry_get(
    p_role TEXT
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
) LANGUAGE sql STABLE AS $$
    SELECT
        r.role,
        r.active_session_id,
        r.epoch,
        r.cursor_offset,
        r.handover_state,
        r.cumulative_tokens,
        r.compaction_count,
        r.last_seen_at,
        r.wake_dispatch_state,
        r.wake_last_signature,
        r.wake_repeat_count,
        r.wake_blocked_reason,
        r.wake_blocked_at,
        r.created_at,
        r.updated_at
    FROM supervisor_registry r
    WHERE r.role = p_role;
$$;

CREATE OR REPLACE FUNCTION supervisor_registry_list()
RETURNS TABLE(
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
) LANGUAGE sql STABLE AS $$
    SELECT
        r.role,
        r.active_session_id,
        r.epoch,
        r.cursor_offset,
        r.handover_state,
        r.cumulative_tokens,
        r.compaction_count,
        r.last_seen_at,
        r.wake_dispatch_state,
        r.wake_last_signature,
        r.wake_repeat_count,
        r.wake_blocked_reason,
        r.wake_blocked_at,
        r.created_at,
        r.updated_at
    FROM supervisor_registry r
    ORDER BY r.role;
$$;

CREATE OR REPLACE FUNCTION supervisor_registry_touch(
    p_role         TEXT,
    p_last_seen_at TIMESTAMPTZ
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
BEGIN
    UPDATE supervisor_registry r
    SET last_seen_at = p_last_seen_at,
        updated_at = NOW()
    WHERE r.role = p_role;

    RETURN QUERY
    SELECT *
    FROM supervisor_registry_get(p_role);
END;
$$;

CREATE OR REPLACE FUNCTION supervisor_registry_set_wake_dispatch_state(
    p_role                TEXT,
    p_wake_dispatch_state TEXT,
    p_wake_last_signature TEXT DEFAULT NULL,
    p_wake_repeat_count   INTEGER DEFAULT 0,
    p_wake_blocked_reason TEXT DEFAULT NULL,
    p_wake_blocked_at     TIMESTAMPTZ DEFAULT NULL
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
BEGIN
    IF p_wake_dispatch_state NOT IN ('active', 'retrying', 'blocked') THEN
        RAISE EXCEPTION 'invalid supervisor wake dispatch state: %', p_wake_dispatch_state;
    END IF;
    IF p_wake_repeat_count < 0 THEN
        RAISE EXCEPTION 'wake_repeat_count must be non-negative';
    END IF;

    UPDATE supervisor_registry r
    SET wake_dispatch_state = p_wake_dispatch_state,
        wake_last_signature = p_wake_last_signature,
        wake_repeat_count = p_wake_repeat_count,
        wake_blocked_reason = CASE
            WHEN p_wake_dispatch_state = 'blocked' THEN p_wake_blocked_reason
            ELSE NULL
        END,
        wake_blocked_at = CASE
            WHEN p_wake_dispatch_state = 'blocked' THEN COALESCE(p_wake_blocked_at, NOW())
            ELSE NULL
        END,
        updated_at = NOW()
    WHERE r.role = p_role;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'supervisor registry not found: %', p_role;
    END IF;

    RETURN QUERY
    SELECT *
    FROM supervisor_registry_get(p_role);
END;
$$;

CREATE OR REPLACE FUNCTION supervisor_registry_record_usage_delta(
    p_role             TEXT,
    p_token_delta      BIGINT,
    p_compaction_delta INTEGER DEFAULT 0,
    p_last_seen_at     TIMESTAMPTZ DEFAULT NULL
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
BEGIN
    IF p_token_delta < 0 OR p_compaction_delta < 0 THEN
        RAISE EXCEPTION 'usage deltas must be non-negative';
    END IF;

    UPDATE supervisor_registry r
    SET cumulative_tokens = r.cumulative_tokens + p_token_delta,
        compaction_count = r.compaction_count + p_compaction_delta,
        last_seen_at = COALESCE(p_last_seen_at, r.last_seen_at),
        updated_at = NOW()
    WHERE r.role = p_role;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'supervisor registry not found: %', p_role;
    END IF;

    RETURN QUERY
    SELECT *
    FROM supervisor_registry_get(p_role);
END;
$$;
