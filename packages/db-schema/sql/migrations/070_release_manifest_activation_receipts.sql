CREATE TABLE IF NOT EXISTS node_release_activation_receipts (
    activation_generation        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    node_id                      TEXT NOT NULL,
    manifest_id                  TEXT NOT NULL,
    release_cohort_id            TEXT NOT NULL,
    source_commit                TEXT NOT NULL,
    prewarmed_at                 TIMESTAMPTZ NOT NULL,
    activated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    verification                 JSONB NOT NULL,
    registration_idempotency_key TEXT NOT NULL,
    CONSTRAINT node_release_activation_receipts_registration_key_unique
        UNIQUE (node_id, registration_idempotency_key),
    CONSTRAINT node_release_activation_receipts_verification_check
        CHECK (
            verification = jsonb_build_object(
                'host', 'verified',
                'runner', 'verified',
                'env', 'verified',
                'executable', 'verified'
            )
        )
);

CREATE INDEX IF NOT EXISTS idx_node_release_activation_receipts_node_generation
    ON node_release_activation_receipts(node_id, activation_generation DESC);

CREATE INDEX IF NOT EXISTS idx_node_release_activation_receipts_manifest
    ON node_release_activation_receipts(manifest_id);

ALTER TABLE session_execution_ownerships
    ADD COLUMN IF NOT EXISTS runtime_env_identity TEXT;

CREATE OR REPLACE FUNCTION session_reserve_execution_ownership_v2(
    p_session_id               TEXT,
    p_ownership_generation     BIGINT,
    p_owner_kind               TEXT,
    p_manifest_id              TEXT,
    p_runtime_env_identity     TEXT,
    p_updated_at               TIMESTAMPTZ
) RETURNS TABLE (
    applied                    BOOLEAN,
    ownership_generation       BIGINT,
    status                     TEXT,
    termination_reason         TEXT,
    termination_detail         TEXT,
    review_state               TEXT,
    last_assistant_text        TEXT,
    termination_event_id       INTEGER,
    updated_at                 TIMESTAMPTZ,
    last_event_id              INTEGER
) LANGUAGE plpgsql AS $$
DECLARE
    v_application RECORD;
    v_row_count INTEGER;
BEGIN
    IF p_runtime_env_identity IS NULL OR p_runtime_env_identity = '' THEN
        RAISE EXCEPTION 'runtime env identity required';
    END IF;

    SELECT * INTO v_application
      FROM session_reserve_execution_ownership(
          p_session_id,
          p_ownership_generation,
          p_owner_kind,
          p_manifest_id,
          p_updated_at
      );

    IF v_application.applied
       AND v_application.ownership_generation = p_ownership_generation THEN
        UPDATE session_execution_ownerships AS ownership
           SET runtime_env_identity = p_runtime_env_identity
         WHERE ownership.session_id = p_session_id
           AND ownership.ownership_generation = p_ownership_generation
           AND ownership.manifest_id = p_manifest_id
           AND (
               ownership.runtime_env_identity IS NULL
               OR ownership.runtime_env_identity = p_runtime_env_identity
           );
        GET DIAGNOSTICS v_row_count = ROW_COUNT;
        IF v_row_count <> 1 THEN
            RAISE EXCEPTION 'execution runtime env identity conflict';
        END IF;
    END IF;

    RETURN QUERY SELECT
        v_application.applied,
        v_application.ownership_generation,
        v_application.status,
        v_application.termination_reason,
        v_application.termination_detail,
        v_application.review_state,
        v_application.last_assistant_text,
        v_application.termination_event_id,
        v_application.updated_at,
        v_application.last_event_id;
END;
$$;

CREATE OR REPLACE FUNCTION session_reserve_execution_adoption_v2(
    p_session_id               TEXT,
    p_ownership_generation     BIGINT,
    p_manifest_id              TEXT,
    p_runtime_env_identity     TEXT,
    p_previous_registration_id TEXT,
    p_pid                      INTEGER,
    p_start_identity           TEXT,
    p_execution_command_id     TEXT,
    p_updated_at               TIMESTAMPTZ
) RETURNS TABLE (
    applied                    BOOLEAN,
    status                     TEXT,
    termination_reason         TEXT,
    termination_detail         TEXT,
    review_state               TEXT,
    last_assistant_text        TEXT,
    termination_event_id       INTEGER,
    updated_at                 TIMESTAMPTZ,
    last_event_id              INTEGER
) LANGUAGE plpgsql AS $$
DECLARE
    v_application RECORD;
    v_row_count INTEGER;
BEGIN
    IF p_runtime_env_identity IS NULL OR p_runtime_env_identity = '' THEN
        RAISE EXCEPTION 'runtime env identity required';
    END IF;

    SELECT * INTO v_application
      FROM session_reserve_execution_adoption(
          p_session_id,
          p_ownership_generation,
          p_manifest_id,
          p_previous_registration_id,
          p_pid,
          p_start_identity,
          p_execution_command_id,
          p_updated_at
      );

    IF v_application.applied THEN
        UPDATE session_execution_ownerships AS ownership
           SET runtime_env_identity = p_runtime_env_identity
         WHERE ownership.session_id = p_session_id
           AND ownership.ownership_generation = p_ownership_generation
           AND ownership.manifest_id = p_manifest_id
           AND (
               ownership.runtime_env_identity IS NULL
               OR ownership.runtime_env_identity = p_runtime_env_identity
           );
        GET DIAGNOSTICS v_row_count = ROW_COUNT;
        IF v_row_count <> 1 THEN
            RAISE EXCEPTION 'adopted execution runtime env identity conflict';
        END IF;
    END IF;

    RETURN QUERY SELECT
        v_application.applied,
        v_application.status,
        v_application.termination_reason,
        v_application.termination_detail,
        v_application.review_state,
        v_application.last_assistant_text,
        v_application.termination_event_id,
        v_application.updated_at,
        v_application.last_event_id;
END;
$$;

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
    IF p_second_runtime_env_identity IS NULL OR p_second_runtime_env_identity = '' THEN
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
