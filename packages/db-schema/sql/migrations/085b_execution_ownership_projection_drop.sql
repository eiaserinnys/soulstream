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
