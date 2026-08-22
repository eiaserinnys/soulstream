-- The owner-null reconciler reports that nothing is running by sending an
-- entirely empty observation. Migration 070 wrapped the backfill in a guard
-- that requires a runtime env identity on every call, which rejected that
-- evidence outright: from 070 onward the reconciler raised on every real
-- sample and an owner-null running session had no path back to a settled
-- ownership. The identity is only meaningful when the observation names a
-- runtime, so the guard now applies only then.
CREATE OR REPLACE FUNCTION session_backfill_execution_ownership_v2(
    p_session_id                 TEXT,
    p_first_manifest_id          TEXT,
    p_first_runtime_env_identity TEXT,
    p_first_registration_id      TEXT,
    p_first_pid                  INTEGER,
    p_first_start_identity       TEXT,
    p_first_execution_command_id TEXT,
    p_first_observed_at          TIMESTAMPTZ,
    p_second_manifest_id         TEXT,
    p_second_runtime_env_identity TEXT,
    p_second_registration_id     TEXT,
    p_second_pid                 INTEGER,
    p_second_start_identity      TEXT,
    p_second_execution_command_id TEXT,
    p_second_observed_at         TIMESTAMPTZ,
    p_evidence_hash              TEXT,
    p_minimum_lease_interval_ms  INTEGER,
    p_probe_only                 BOOLEAN
) RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE
    v_action TEXT;
    v_row_count INTEGER;
BEGIN
    -- Only an observation that names a runtime can be required to identify it.
    -- The owner-null reconciler exists to report that *nothing* is running, and
    -- says so with an entirely empty observation; `session_backfill_execution_
    -- ownership` treats that as a first-class input and takes its incomplete
    -- identity branch. Requiring the identity unconditionally rejected exactly
    -- that evidence, so from migration 070 onward the reconciler threw on every
    -- real sample -- twenty-one times in one lab dead-owner run -- and an
    -- owner-null running session had nothing left that could converge it.
    IF (
        p_second_manifest_id IS NOT NULL
        OR p_second_registration_id IS NOT NULL
        OR p_second_pid IS NOT NULL
        OR p_second_start_identity IS NOT NULL
        OR p_second_execution_command_id IS NOT NULL
    ) AND (
        p_second_runtime_env_identity IS NULL OR p_second_runtime_env_identity = ''
    ) THEN
        RAISE EXCEPTION 'second runtime env identity required';
    END IF;
    IF p_first_runtime_env_identity IS NOT NULL
       AND p_first_runtime_env_identity <> p_second_runtime_env_identity THEN
        RAISE EXCEPTION 'backfill runtime env identity changed across observations';
    END IF;

    SELECT session_backfill_execution_ownership(
        p_session_id,
        p_first_manifest_id,
        p_first_registration_id,
        p_first_pid,
        p_first_start_identity,
        p_first_execution_command_id,
        p_first_observed_at,
        p_second_manifest_id,
        p_second_registration_id,
        p_second_pid,
        p_second_start_identity,
        p_second_execution_command_id,
        p_second_observed_at,
        p_evidence_hash,
        p_minimum_lease_interval_ms,
        p_probe_only
    ) INTO v_action;

    IF v_action = 'backfilled' THEN
        UPDATE session_execution_ownerships AS ownership
           SET runtime_env_identity = p_second_runtime_env_identity
         WHERE ownership.session_id = p_session_id
           AND ownership.manifest_id = p_second_manifest_id
           AND ownership.registration_id = p_second_registration_id
           AND ownership.pid = p_second_pid
           AND ownership.start_identity = p_second_start_identity
           AND ownership.execution_command_id = p_second_execution_command_id
           AND ownership.phase = 'active'
           AND (
               ownership.runtime_env_identity IS NULL
               OR ownership.runtime_env_identity = p_second_runtime_env_identity
           );
        GET DIAGNOSTICS v_row_count = ROW_COUNT;
        IF v_row_count <> 1 THEN
            RAISE EXCEPTION 'backfilled execution runtime env identity conflict';
        END IF;
    END IF;

    RETURN v_action;
END;
$$;
