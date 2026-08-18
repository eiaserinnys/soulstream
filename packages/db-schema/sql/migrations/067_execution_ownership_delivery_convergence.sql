-- 067: generation-fenced execution ownership and delivery convergence
--
-- This migration is intentionally additive. Existing state columns and
-- transition functions remain available while orch and node releases roll.

CREATE TABLE IF NOT EXISTS session_execution_ownerships (
    session_id                 TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    ownership_generation       BIGINT NOT NULL,
    owner_kind                 TEXT NOT NULL,
    manifest_id                TEXT NOT NULL,
    registration_id            TEXT,
    pid                        INTEGER,
    start_identity             TEXT,
    execution_command_id       TEXT,
    phase                      TEXT NOT NULL DEFAULT 'reserved',
    runner_fact                TEXT,
    reserved_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    identity_proven_at         TIMESTAMPTZ,
    activated_at               TIMESTAMPTZ,
    terminal_at                TIMESTAMPTZ,
    failure_reason             TEXT,
    PRIMARY KEY (session_id, ownership_generation),
    CONSTRAINT session_execution_ownership_owner_kind_check
        CHECK (owner_kind IN ('runner_process', 'adopted_runner', 'in_process')),
    CONSTRAINT session_execution_ownership_phase_check
        CHECK (phase IN ('reserved', 'identity_proven', 'active', 'terminal', 'failed')),
    CONSTRAINT session_execution_ownership_runner_fact_check
        CHECK (runner_fact IS NULL OR runner_fact IN ('completed', 'failed', 'reaped', 'closed')),
    CONSTRAINT session_execution_ownership_identity_shape_check
        CHECK (
            phase IN ('reserved', 'failed')
            OR (
                registration_id IS NOT NULL
                AND pid IS NOT NULL
                AND start_identity IS NOT NULL
                AND execution_command_id IS NOT NULL
                AND identity_proven_at IS NOT NULL
            )
        )
);

DROP INDEX IF EXISTS idx_session_execution_ownership_open;
CREATE UNIQUE INDEX idx_session_execution_ownership_open
    ON session_execution_ownerships(session_id)
    WHERE phase = 'active';

CREATE INDEX IF NOT EXISTS idx_session_execution_ownership_identity
    ON session_execution_ownerships(registration_id, pid, start_identity)
    WHERE registration_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS session_execution_ownership_migration_audit (
    audit_id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    session_id                 TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    action                     TEXT NOT NULL,
    manifest_id                TEXT,
    registration_id            TEXT,
    pid                        INTEGER,
    start_identity             TEXT,
    first_observed_at          TIMESTAMPTZ,
    second_observed_at         TIMESTAMPTZ,
    detail                     TEXT NOT NULL,
    created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT session_execution_ownership_audit_action_check
        CHECK (action IN ('observed', 'backfilled', 'interrupted'))
);

CREATE OR REPLACE VIEW session_owner_null_running_inventory AS
SELECT session.session_id, session.node_id, session.updated_at
FROM sessions AS session
WHERE session.status = 'running'
  AND NOT EXISTS (
      SELECT 1
      FROM session_execution_ownerships AS ownership
      WHERE ownership.session_id = session.session_id
        AND ownership.phase = 'active'
  );

CREATE OR REPLACE FUNCTION session_reserve_execution_ownership(
    p_session_id               TEXT,
    p_ownership_generation     BIGINT,
    p_owner_kind               TEXT,
    p_manifest_id              TEXT,
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
BEGIN
    IF p_owner_kind NOT IN ('runner_process', 'adopted_runner', 'in_process') THEN
        RAISE EXCEPTION 'unsupported execution owner kind: %', p_owner_kind;
    END IF;
    IF p_manifest_id IS NULL OR p_manifest_id = '' THEN
        RAISE EXCEPTION 'execution manifest id required';
    END IF;
    IF p_ownership_generation IS NULL OR p_ownership_generation <= 0 THEN
        RAISE EXCEPTION 'positive execution ownership generation required';
    END IF;

    PERFORM 1 FROM sessions WHERE session_id = p_session_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'session not found: %', p_session_id;
    END IF;

    IF EXISTS (
        SELECT 1 FROM session_execution_ownerships
        WHERE session_id = p_session_id
          AND phase IN ('reserved', 'identity_proven', 'active')
    ) THEN
        RETURN QUERY
        SELECT FALSE, ownership.ownership_generation,
               session.status, session.termination_reason,
               session.termination_detail, session.review_state,
               session.last_assistant_text, session.termination_event_id,
               session.updated_at, session.last_event_id
        FROM sessions AS session
        JOIN session_execution_ownerships AS ownership
          ON ownership.session_id = session.session_id
         AND ownership.phase IN ('reserved', 'identity_proven', 'active')
        WHERE session.session_id = p_session_id;
        RETURN;
    END IF;

    INSERT INTO session_execution_ownerships (
        session_id, ownership_generation, owner_kind, manifest_id,
        phase, reserved_at
    ) VALUES (
        p_session_id, p_ownership_generation, p_owner_kind, p_manifest_id,
        'reserved', p_updated_at
    );

    RETURN QUERY
    SELECT TRUE, p_ownership_generation,
           session.status, session.termination_reason,
           session.termination_detail, session.review_state,
           session.last_assistant_text, session.termination_event_id,
           session.updated_at, session.last_event_id
      FROM sessions AS session
     WHERE session.session_id = p_session_id;
END;
$$;

CREATE OR REPLACE FUNCTION session_prove_execution_ownership(
    p_session_id               TEXT,
    p_ownership_generation     BIGINT,
    p_registration_id          TEXT,
    p_pid                      INTEGER,
    p_start_identity           TEXT,
    p_execution_command_id     TEXT,
    p_proven_at                TIMESTAMPTZ
) RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE
    v_row_count INTEGER;
BEGIN
    IF p_registration_id IS NULL OR p_registration_id = ''
       OR p_pid IS NULL OR p_pid <= 0
       OR p_start_identity IS NULL OR p_start_identity = ''
       OR p_execution_command_id IS NULL OR p_execution_command_id = '' THEN
        RAISE EXCEPTION 'complete execution identity proof required';
    END IF;
    UPDATE session_execution_ownerships
       SET registration_id = p_registration_id,
           pid = p_pid,
           start_identity = p_start_identity,
           execution_command_id = p_execution_command_id,
           phase = 'identity_proven',
           identity_proven_at = p_proven_at
     WHERE session_id = p_session_id
       AND ownership_generation = p_ownership_generation
       AND phase = 'reserved';
    GET DIAGNOSTICS v_row_count = ROW_COUNT;
    RETURN v_row_count = 1;
END;
$$;

CREATE OR REPLACE FUNCTION session_reserve_execution_adoption(
    p_session_id               TEXT,
    p_ownership_generation     BIGINT,
    p_manifest_id              TEXT,
    p_previous_registration_id TEXT,
    p_pid                      INTEGER,
    p_start_identity           TEXT,
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
    v_row_count INTEGER := 0;
BEGIN
    PERFORM 1 FROM sessions WHERE session_id = p_session_id FOR UPDATE;
    PERFORM 1
      FROM session_execution_ownerships
     WHERE session_id = p_session_id
       AND phase = 'active'
       AND manifest_id = p_manifest_id
       AND registration_id = p_previous_registration_id
       AND pid = p_pid
       AND start_identity = p_start_identity
     FOR UPDATE;
    IF FOUND AND NOT EXISTS (
        SELECT 1 FROM session_execution_ownerships
         WHERE session_id = p_session_id
           AND phase IN ('reserved', 'identity_proven')
    ) THEN
        INSERT INTO session_execution_ownerships (
            session_id, ownership_generation, owner_kind, manifest_id,
            phase, reserved_at
        ) VALUES (
            p_session_id, p_ownership_generation, 'adopted_runner', p_manifest_id,
            'reserved', p_updated_at
        );
        v_row_count := 1;
    END IF;
    RETURN QUERY
    SELECT v_row_count = 1, session.status, session.termination_reason,
           session.termination_detail, session.review_state,
           session.last_assistant_text, session.termination_event_id,
           session.updated_at, session.last_event_id
      FROM sessions AS session
     WHERE session.session_id = p_session_id;
END;
$$;

CREATE OR REPLACE FUNCTION session_activate_execution_ownership(
    p_session_id                 TEXT,
    p_ownership_generation       BIGINT,
    p_review_state               TEXT,
    p_expected_terminal_event_id INTEGER,
    p_terminal_resume            BOOLEAN,
    p_updated_at                 TIMESTAMPTZ
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
    v_row_count INTEGER := 0;
    v_owner_kind TEXT;
    v_manifest_id TEXT;
    v_registration_id TEXT;
    v_pid INTEGER;
    v_start_identity TEXT;
BEGIN
    SELECT owner_kind, manifest_id, registration_id, pid, start_identity
      INTO v_owner_kind, v_manifest_id, v_registration_id, v_pid, v_start_identity
      FROM session_execution_ownerships
     WHERE session_id = p_session_id
       AND ownership_generation = p_ownership_generation
       AND phase = 'identity_proven'
     FOR UPDATE;
    IF FOUND THEN
        IF v_owner_kind = 'adopted_runner' THEN
            PERFORM 1
              FROM session_execution_ownerships
             WHERE session_id = p_session_id
               AND ownership_generation <> p_ownership_generation
               AND phase = 'active'
               AND manifest_id = v_manifest_id
               AND registration_id = v_registration_id
               AND pid = v_pid
               AND start_identity = v_start_identity
             FOR UPDATE;
            IF NOT FOUND THEN
                RETURN QUERY
                SELECT FALSE, session.status, session.termination_reason,
                       session.termination_detail, session.review_state,
                       session.last_assistant_text, session.termination_event_id,
                       session.updated_at, session.last_event_id
                  FROM sessions AS session
                 WHERE session.session_id = p_session_id;
                RETURN;
            END IF;
        END IF;
        IF p_terminal_resume THEN
            UPDATE sessions AS session
               SET status = 'running', termination_reason = NULL,
                   termination_detail = NULL, termination_event_id = NULL,
                   last_assistant_text = NULL, review_state = p_review_state,
                   updated_at = p_updated_at
             WHERE session.session_id = p_session_id
               AND session.status IN ('completed', 'error', 'interrupted')
               AND session.termination_event_id IS NOT DISTINCT FROM p_expected_terminal_event_id;
        ELSE
            UPDATE sessions AS session
               SET status = 'running', termination_reason = NULL,
                   termination_detail = NULL, review_state = p_review_state,
                   updated_at = p_updated_at
             WHERE session.session_id = p_session_id
               AND session.status NOT IN ('completed', 'error', 'interrupted');
        END IF;
        GET DIAGNOSTICS v_row_count = ROW_COUNT;
        IF v_row_count = 1 THEN
            IF v_owner_kind = 'adopted_runner' THEN
                UPDATE session_execution_ownerships
                   SET phase = 'terminal', terminal_at = p_updated_at,
                       failure_reason = 'ownership handed to adopting host'
                 WHERE session_id = p_session_id
                   AND ownership_generation <> p_ownership_generation
                   AND phase = 'active'
                   AND manifest_id = v_manifest_id
                   AND registration_id = v_registration_id
                   AND pid = v_pid
                   AND start_identity = v_start_identity;
            END IF;
            UPDATE session_execution_ownerships
               SET phase = 'active', activated_at = p_updated_at
             WHERE session_id = p_session_id
               AND ownership_generation = p_ownership_generation
               AND phase = 'identity_proven';
            IF p_terminal_resume THEN
                UPDATE session_deliveries
                   SET state = 'superseded',
                       aggregate_state = 'consumed',
                       consumed_at = p_updated_at,
                       consumed_reason = 'superseded by terminal resume',
                       superseded_at = p_updated_at,
                       superseded_terminal_revision = p_expected_terminal_event_id::text,
                       lease_owner = NULL,
                       lease_expires_at = NULL,
                       updated_at = p_updated_at
                 WHERE source_session_id = p_session_id
                   AND intent = 'completion_notification'
                   AND source = 'completion_notifier'
                   AND producer_kind = 'child_session'
                   AND producer_terminal_revision = p_expected_terminal_event_id::text
                   AND state IN ('pending', 'claimed', 'dispatching', 'queued');
            END IF;
        END IF;
    END IF;

    RETURN QUERY
    SELECT v_row_count = 1, session.status, session.termination_reason,
           session.termination_detail, session.review_state,
           session.last_assistant_text, session.termination_event_id,
           session.updated_at, session.last_event_id
      FROM sessions AS session
     WHERE session.session_id = p_session_id;
END;
$$;

CREATE OR REPLACE FUNCTION session_project_runner_terminal_fact(
    p_session_id               TEXT,
    p_ownership_generation     BIGINT,
    p_runner_fact              TEXT,
    p_termination_detail       TEXT,
    p_review_state             TEXT,
    p_last_assistant_text      TEXT,
    p_terminal_event_id        INTEGER,
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
    v_status TEXT;
    v_reason TEXT;
    v_row_count INTEGER := 0;
BEGIN
    IF p_runner_fact NOT IN ('completed', 'failed', 'reaped', 'closed') THEN
        RAISE EXCEPTION 'unsupported runner terminal fact: %', p_runner_fact;
    END IF;
    IF p_terminal_event_id IS NULL OR p_terminal_event_id <= 0 THEN
        RAISE EXCEPTION 'terminal event id must be a positive integer';
    END IF;
    v_status := CASE p_runner_fact
        WHEN 'completed' THEN 'completed'
        WHEN 'closed' THEN 'interrupted'
        ELSE 'error'
    END;
    v_reason := CASE p_runner_fact
        WHEN 'completed' THEN 'completed_ok'
        WHEN 'closed' THEN 'killed'
        ELSE 'error_aborted'
    END;

    UPDATE session_execution_ownerships AS ownership
       SET phase = 'terminal', runner_fact = p_runner_fact,
           terminal_at = p_updated_at
     WHERE ownership.session_id = p_session_id
       AND ownership.ownership_generation = p_ownership_generation
       AND ownership.phase = 'active';
    GET DIAGNOSTICS v_row_count = ROW_COUNT;

    IF v_row_count = 1 THEN
        UPDATE sessions AS session
           SET status = v_status, termination_reason = v_reason,
               termination_detail = p_termination_detail,
               review_state = p_review_state,
               last_assistant_text = p_last_assistant_text,
               termination_event_id = p_terminal_event_id,
               updated_at = p_updated_at
         WHERE session.session_id = p_session_id;
    END IF;

    RETURN QUERY
    SELECT v_row_count = 1, session.status, session.termination_reason,
           session.termination_detail, session.review_state,
           session.last_assistant_text, session.termination_event_id,
           session.updated_at, session.last_event_id
      FROM sessions AS session
     WHERE session.session_id = p_session_id;
END;
$$;

CREATE OR REPLACE FUNCTION session_project_recovered_runner_terminal_fact(
    p_session_id               TEXT,
    p_manifest_id              TEXT,
    p_registration_id          TEXT,
    p_pid                      INTEGER,
    p_start_identity           TEXT,
    p_runner_fact              TEXT,
    p_termination_detail       TEXT,
    p_review_state             TEXT,
    p_last_assistant_text      TEXT,
    p_terminal_event_id        INTEGER,
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
    v_ownership_generation BIGINT;
BEGIN
    SELECT ownership.ownership_generation
      INTO v_ownership_generation
      FROM session_execution_ownerships AS ownership
     WHERE ownership.session_id = p_session_id
       AND ownership.manifest_id = p_manifest_id
       AND ownership.registration_id = p_registration_id
       AND ownership.pid = p_pid
       AND ownership.start_identity = p_start_identity
       AND ownership.phase = 'active'
     FOR UPDATE;

    IF FOUND THEN
        RETURN QUERY
        SELECT *
          FROM session_project_runner_terminal_fact(
              p_session_id,
              v_ownership_generation,
              p_runner_fact,
              p_termination_detail,
              p_review_state,
              p_last_assistant_text,
              p_terminal_event_id,
              p_updated_at
          );
        RETURN;
    END IF;

    RETURN QUERY
    SELECT FALSE, session.status, session.termination_reason,
           session.termination_detail, session.review_state,
           session.last_assistant_text, session.termination_event_id,
           session.updated_at, session.last_event_id
      FROM sessions AS session
     WHERE session.session_id = p_session_id;
END;
$$;

CREATE OR REPLACE FUNCTION session_fail_execution_ownership(
    p_session_id               TEXT,
    p_ownership_generation     BIGINT,
    p_failure_reason           TEXT,
    p_failed_at                TIMESTAMPTZ
) RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE
    v_row_count INTEGER;
BEGIN
    UPDATE session_execution_ownerships
       SET phase = 'failed', failure_reason = p_failure_reason,
           terminal_at = p_failed_at
     WHERE session_id = p_session_id
       AND ownership_generation = p_ownership_generation
       AND phase IN ('reserved', 'identity_proven');
    GET DIAGNOSTICS v_row_count = ROW_COUNT;
    RETURN v_row_count = 1;
END;
$$;

CREATE OR REPLACE FUNCTION session_backfill_execution_ownership(
    p_session_id               TEXT,
    p_manifest_id              TEXT,
    p_registration_id          TEXT,
    p_pid                      INTEGER,
    p_start_identity           TEXT,
    p_execution_command_id     TEXT,
    p_first_observed_at        TIMESTAMPTZ,
    p_second_observed_at       TIMESTAMPTZ,
    p_minimum_lease_interval   INTERVAL
) RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE
    v_generation BIGINT;
    v_identity_complete BOOLEAN;
BEGIN
    PERFORM 1 FROM sessions
     WHERE session_id = p_session_id AND status = 'running'
     FOR UPDATE;
    IF NOT FOUND THEN RETURN 'not_running'; END IF;
    IF EXISTS (
        SELECT 1 FROM session_execution_ownerships
        WHERE session_id = p_session_id AND phase = 'active'
    ) THEN RETURN 'already_owned'; END IF;

    v_identity_complete := p_manifest_id <> '' AND p_registration_id <> ''
      AND p_pid > 0 AND p_start_identity <> '' AND p_execution_command_id <> ''
      AND p_second_observed_at - p_first_observed_at >= p_minimum_lease_interval;
    IF v_identity_complete THEN
        SELECT COALESCE(MAX(ownership_generation), 0) + 1 INTO v_generation
          FROM session_execution_ownerships WHERE session_id = p_session_id;
        INSERT INTO session_execution_ownerships (
            session_id, ownership_generation, owner_kind, manifest_id,
            registration_id, pid, start_identity, execution_command_id,
            phase, reserved_at, identity_proven_at, activated_at
        ) VALUES (
            p_session_id, v_generation, 'adopted_runner', p_manifest_id,
            p_registration_id, p_pid, p_start_identity, p_execution_command_id,
            'active', p_first_observed_at, p_second_observed_at, p_second_observed_at
        );
        INSERT INTO session_execution_ownership_migration_audit (
            session_id, action, manifest_id, registration_id, pid,
            start_identity, first_observed_at, second_observed_at, detail
        ) VALUES (
            p_session_id, 'backfilled', p_manifest_id, p_registration_id, p_pid,
            p_start_identity, p_first_observed_at, p_second_observed_at,
            'stable identity observed across lease interval'
        );
        RETURN 'backfilled';
    END IF;

    UPDATE sessions
       SET status = 'interrupted', termination_reason = 'unknown',
           termination_detail = 'owner-null running migration could not prove a stable runner identity',
           updated_at = NOW()
     WHERE session_id = p_session_id AND status = 'running';
    INSERT INTO session_execution_ownership_migration_audit (
        session_id, action, manifest_id, registration_id, pid,
        start_identity, first_observed_at, second_observed_at, detail
    ) VALUES (
        p_session_id, 'interrupted', NULLIF(p_manifest_id, ''),
        NULLIF(p_registration_id, ''), p_pid, NULLIF(p_start_identity, ''),
        p_first_observed_at, p_second_observed_at,
        'stable identity proof missing; session converged to interrupted'
    );
    RETURN 'interrupted';
END;
$$;

ALTER TABLE session_deliveries
    ADD COLUMN IF NOT EXISTS aggregate_state TEXT NOT NULL DEFAULT 'pending',
    ADD COLUMN IF NOT EXISTS target_receipt_id TEXT,
    ADD COLUMN IF NOT EXISTS target_receipt_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS consumed_reason TEXT,
    ADD COLUMN IF NOT EXISTS dead_letter_reason TEXT,
    ADD COLUMN IF NOT EXISTS dead_lettered_at TIMESTAMPTZ;

ALTER TABLE session_deliveries
    DROP CONSTRAINT IF EXISTS session_deliveries_aggregate_state_check;
ALTER TABLE session_deliveries
    ADD CONSTRAINT session_deliveries_aggregate_state_check
    CHECK (aggregate_state IN ('pending', 'delivered', 'consumed', 'dead_letter'));

CREATE TABLE IF NOT EXISTS session_delivery_attempts (
    delivery_id                TEXT NOT NULL REFERENCES session_deliveries(delivery_id) ON DELETE CASCADE,
    attempt_number             INTEGER NOT NULL,
    lease_owner                TEXT,
    payload_hash               TEXT NOT NULL,
    outcome                    TEXT NOT NULL,
    reason                     TEXT,
    target_receipt_id          TEXT,
    created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (delivery_id, attempt_number),
    CONSTRAINT session_delivery_attempts_outcome_check
        CHECK (outcome IN ('accepted', 'retryable', 'rejected'))
);

ALTER TABLE session_delivery_notification_outbox
    ADD COLUMN IF NOT EXISTS projection_state TEXT NOT NULL DEFAULT 'staged',
    ADD COLUMN IF NOT EXISTS target_receipt_id TEXT,
    ADD COLUMN IF NOT EXISTS target_receipt_at TIMESTAMPTZ;
ALTER TABLE session_delivery_notification_outbox
    DROP CONSTRAINT IF EXISTS session_delivery_notification_projection_state_check;
ALTER TABLE session_delivery_notification_outbox
    ADD CONSTRAINT session_delivery_notification_projection_state_check
    CHECK (projection_state IN ('staged', 'publishing', 'published', 'discarded'));

UPDATE session_deliveries
SET aggregate_state = CASE
    WHEN state = 'consumed' THEN 'consumed'
    WHEN state = 'superseded' THEN 'consumed'
    WHEN state = 'delivered' THEN 'delivered'
    WHEN state = 'uncertain' AND EXISTS (
        SELECT 1 FROM session_delivery_notification_outbox AS outbox
        WHERE outbox.delivery_id = session_deliveries.delivery_id
          AND outbox.state = 'published'
    ) THEN 'delivered'
    WHEN state = 'uncertain'
      AND attempt_count < 16
      AND created_at > NOW() - INTERVAL '24 hours' THEN 'pending'
    WHEN state = 'uncertain' THEN 'dead_letter'
    ELSE 'pending'
END,
consumed_reason = CASE
    WHEN state = 'superseded' THEN COALESCE(superseded_terminal_revision, 'superseded')
    ELSE consumed_reason
END,
dead_letter_reason = CASE
    WHEN state = 'uncertain'
      AND NOT (
        attempt_count < 16
        AND created_at > NOW() - INTERVAL '24 hours'
      ) THEN COALESCE(last_error, 'legacy uncertain retry budget exhausted')
    ELSE dead_letter_reason
END,
dead_lettered_at = CASE
    WHEN state = 'uncertain'
      AND NOT (
        attempt_count < 16
        AND created_at > NOW() - INTERVAL '24 hours'
      ) THEN COALESCE(dead_lettered_at, NOW())
    ELSE dead_lettered_at
END;

INSERT INTO session_delivery_attempts (
    delivery_id, attempt_number, lease_owner, payload_hash, outcome, reason, created_at
)
SELECT delivery_id, attempt_count + 1, lease_owner, payload_hash,
       CASE WHEN aggregate_state = 'dead_letter' THEN 'rejected' ELSE 'retryable' END,
       COALESCE(last_error, 'legacy uncertain backfill'), updated_at
FROM session_deliveries
WHERE state = 'uncertain'
ON CONFLICT (delivery_id, attempt_number) DO NOTHING;

UPDATE session_delivery_notification_outbox AS outbox
SET projection_state = CASE
        WHEN outbox.state = 'published' THEN 'published'
        WHEN delivery.aggregate_state = 'consumed' THEN 'discarded'
        WHEN outbox.state = 'claimed' THEN 'publishing'
        ELSE 'staged'
    END,
    state = CASE
        WHEN delivery.aggregate_state = 'consumed'
          AND outbox.state <> 'published' THEN 'dead_letter'
        ELSE outbox.state
    END,
    lease_owner = CASE
        WHEN delivery.aggregate_state = 'consumed' THEN NULL
        ELSE outbox.lease_owner
    END,
    lease_expires_at = CASE
        WHEN delivery.aggregate_state = 'consumed' THEN NULL
        ELSE outbox.lease_expires_at
    END,
    last_error = CASE
        WHEN delivery.aggregate_state = 'consumed'
          AND outbox.state <> 'published'
        THEN 'delivery aggregate consumed before notification projection'
        ELSE outbox.last_error
    END,
    dead_lettered_at = CASE
        WHEN delivery.aggregate_state = 'consumed'
          AND outbox.state <> 'published'
        THEN COALESCE(outbox.dead_lettered_at, NOW())
        ELSE outbox.dead_lettered_at
    END,
    updated_at = CASE
        WHEN delivery.aggregate_state = 'consumed'
          AND outbox.state <> 'published' THEN NOW()
        ELSE outbox.updated_at
    END
FROM session_deliveries AS delivery
WHERE delivery.delivery_id = outbox.delivery_id;

CREATE OR REPLACE FUNCTION session_discard_notification_projection_on_consumed()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.aggregate_state = 'consumed'
       AND OLD.aggregate_state IS DISTINCT FROM NEW.aggregate_state THEN
        UPDATE session_delivery_notification_outbox
           SET state = 'dead_letter',
               projection_state = 'discarded',
               lease_owner = NULL,
               lease_expires_at = NULL,
               last_error = 'delivery aggregate consumed before notification projection',
               dead_lettered_at = COALESCE(dead_lettered_at, NOW()),
               updated_at = NOW()
         WHERE delivery_id = NEW.delivery_id
           AND state IN ('pending', 'claimed');
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_session_discard_notification_projection
    ON session_deliveries;
CREATE TRIGGER trg_session_discard_notification_projection
AFTER UPDATE OF aggregate_state ON session_deliveries
FOR EACH ROW
EXECUTE FUNCTION session_discard_notification_projection_on_consumed();

CREATE INDEX IF NOT EXISTS idx_session_delivery_aggregate_recovery
    ON session_deliveries(aggregate_state, next_attempt_at, created_at);
CREATE INDEX IF NOT EXISTS idx_session_delivery_attempt_outcome
    ON session_delivery_attempts(outcome, created_at);

CREATE OR REPLACE FUNCTION session_apply_running_transition(
    p_session_id                 TEXT,
    p_review_state               TEXT,
    p_expected_terminal_event_id INTEGER,
    p_terminal_resume            BOOLEAN,
    p_updated_at                 TIMESTAMPTZ
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
    IF p_terminal_resume THEN
        UPDATE sessions AS session
           SET status = 'running',
               termination_reason = NULL,
               termination_detail = NULL,
               termination_event_id = NULL,
               last_assistant_text = NULL,
               review_state = p_review_state,
               updated_at = p_updated_at
         WHERE session.session_id = p_session_id
           AND session.status IN ('completed', 'error', 'interrupted')
           AND session.termination_event_id IS NOT DISTINCT FROM p_expected_terminal_event_id;
    ELSE
        UPDATE sessions AS session
           SET status = 'running',
               termination_reason = NULL,
               termination_detail = NULL,
               review_state = p_review_state,
               updated_at = p_updated_at
         WHERE session.session_id = p_session_id
           AND session.status NOT IN ('completed', 'error');
    END IF;
    GET DIAGNOSTICS v_row_count = ROW_COUNT;

    IF p_terminal_resume AND v_row_count = 1 THEN
        UPDATE session_deliveries
           SET state = 'superseded',
               aggregate_state = 'consumed',
               consumed_at = p_updated_at,
               consumed_reason = 'superseded by terminal resume',
               superseded_at = p_updated_at,
               superseded_terminal_revision = p_expected_terminal_event_id::text,
               lease_owner = NULL,
               lease_expires_at = NULL,
               updated_at = p_updated_at
         WHERE source_session_id = p_session_id
           AND intent = 'completion_notification'
           AND source = 'completion_notifier'
           AND producer_kind = 'child_session'
           AND producer_terminal_revision = p_expected_terminal_event_id::text
           AND state IN ('pending', 'claimed', 'dispatching', 'queued');
    END IF;

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
