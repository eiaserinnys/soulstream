DROP VIEW IF EXISTS session_owner_null_running_inventory;

DROP FUNCTION IF EXISTS session_project_recovered_runner_terminal_fact(TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS session_project_runner_terminal_fact(TEXT, BIGINT, TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS session_reconcile_recorded_runner_terminal_fact(TEXT, BIGINT, TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS session_acquire_execution_ownership(TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT, TIMESTAMPTZ, TEXT, INTEGER, BOOLEAN, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS session_activate_execution_ownership(TEXT, BIGINT, TEXT, INTEGER, BOOLEAN, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS session_backfill_execution_ownership(TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, INTEGER, TEXT, TEXT, TIMESTAMPTZ, TEXT, INTEGER, BOOLEAN);
DROP FUNCTION IF EXISTS session_backfill_execution_ownership_v2(TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT, TIMESTAMPTZ, TEXT, INTEGER, BOOLEAN);
DROP FUNCTION IF EXISTS session_expire_dead_execution_owner(TEXT, BIGINT, INTEGER, TEXT, TEXT, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS session_fail_execution_ownership(TEXT, BIGINT, TEXT, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS session_mark_execution_orphaned_spawn(TEXT, BIGINT, TEXT, INTEGER, TEXT, TEXT, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS session_prove_execution_ownership(TEXT, BIGINT, TEXT, INTEGER, TEXT, TEXT, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS session_release_execution_ownership(TEXT, BIGINT, TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS session_renew_execution_ownership(TEXT, BIGINT, TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS session_reserve_execution_adoption(TEXT, BIGINT, TEXT, TEXT, INTEGER, TEXT, TEXT, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS session_reserve_execution_adoption_v2(TEXT, BIGINT, TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS session_reserve_execution_ownership(TEXT, BIGINT, TEXT, TEXT, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS session_reserve_execution_ownership_v2(TEXT, BIGINT, TEXT, TEXT, TEXT, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS session_retire_recorded_terminal_execution_identity(TEXT, BIGINT, TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT, INTEGER);
DROP FUNCTION IF EXISTS session_retire_terminal_execution_ownership(TEXT, BIGINT, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, TIMESTAMPTZ);

DROP INDEX IF EXISTS idx_session_execution_ownership_open;
DROP INDEX IF EXISTS idx_session_execution_ownership_identity;

DROP TABLE IF EXISTS session_execution_ownership_migration_audit;
DROP TABLE IF EXISTS session_execution_ownerships;

ALTER TABLE sessions
    DROP CONSTRAINT IF EXISTS sessions_execution_owner_all_or_none_check,
    DROP COLUMN IF EXISTS execution_generation,
    DROP COLUMN IF EXISTS execution_manifest_id,
    DROP COLUMN IF EXISTS execution_runtime_env_identity,
    DROP COLUMN IF EXISTS execution_pid,
    DROP COLUMN IF EXISTS execution_start_identity,
    DROP COLUMN IF EXISTS execution_lease_expires_at;

CREATE OR REPLACE FUNCTION session_apply_terminal_transition(
    p_session_id           TEXT,
    p_status               TEXT,
    p_termination_reason   TEXT,
    p_termination_detail   TEXT,
    p_review_state         TEXT,
    p_last_assistant_text  TEXT,
    p_terminal_event_id    INTEGER,
    p_updated_at           TIMESTAMPTZ
) RETURNS TABLE (
    applied                BOOLEAN,
    status                 TEXT,
    termination_reason     TEXT,
    termination_detail     TEXT,
    review_state           TEXT,
    last_assistant_text    TEXT,
    termination_event_id   INTEGER,
    updated_at              TIMESTAMPTZ,
    last_event_id           INTEGER
) LANGUAGE plpgsql AS $$
DECLARE
    v_row_count INTEGER;
BEGIN
    IF p_terminal_event_id IS NULL OR p_terminal_event_id <= 0 THEN
        RAISE EXCEPTION 'terminal event id must be a positive integer';
    END IF;

    UPDATE sessions AS session
       SET status = p_status,
           termination_reason = p_termination_reason,
           termination_detail = p_termination_detail,
           review_state = p_review_state,
           last_assistant_text = p_last_assistant_text,
           termination_event_id = p_terminal_event_id,
           execution_registration_id = NULL,
           execution_command_id = NULL,
           updated_at = p_updated_at
     WHERE session.session_id = p_session_id
       AND session.status NOT IN ('completed', 'error', 'interrupted')
       AND (
           session.termination_event_id IS NULL
           OR session.termination_event_id < p_terminal_event_id
       );
    GET DIAGNOSTICS v_row_count = ROW_COUNT;

    RETURN QUERY
    SELECT v_row_count = 1,
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
