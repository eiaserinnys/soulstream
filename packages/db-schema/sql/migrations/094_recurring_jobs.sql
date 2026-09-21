-- 094: central recurring jobs. A run reserves its stable session ID before a
-- node creates that session, so recurring_job_runs.session_id deliberately has
-- no sessions foreign key.

CREATE TABLE IF NOT EXISTS recurring_jobs (
    job_id                      TEXT PRIMARY KEY,
    owner_email                 TEXT NOT NULL,
    execution_caller            JSONB NOT NULL,
    name                        TEXT NOT NULL,
    prompt                      TEXT NOT NULL,
    schedule_expressions        JSONB NOT NULL,
    timezone                    TEXT NOT NULL,
    node_id                     TEXT NOT NULL,
    agent_id                    TEXT NOT NULL,
    model_preset                TEXT,
    container_kind              TEXT NOT NULL,
    container_id                TEXT NOT NULL,
    folder_id                   TEXT NOT NULL,
    enabled                     BOOLEAN NOT NULL DEFAULT TRUE,
    archived_at                 TIMESTAMPTZ,
    late_run_window_seconds     INTEGER NOT NULL DEFAULT 1800,
    next_run_at                 TIMESTAMPTZ,
    version                     BIGINT NOT NULL DEFAULT 1,
    created_idempotency_key     TEXT NOT NULL,
    created_by                  TEXT NOT NULL,
    updated_by                  TEXT NOT NULL,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT recurring_jobs_owner_email_nonempty CHECK (length(btrim(owner_email)) > 0),
    CONSTRAINT recurring_jobs_name_nonempty CHECK (length(btrim(name)) > 0),
    CONSTRAINT recurring_jobs_prompt_nonempty CHECK (length(btrim(prompt)) > 0),
    CONSTRAINT recurring_jobs_schedule_array CHECK (
        jsonb_typeof(schedule_expressions) = 'array'
        AND jsonb_array_length(schedule_expressions) > 0
    ),
    CONSTRAINT recurring_jobs_timezone_nonempty CHECK (length(btrim(timezone)) > 0),
    CONSTRAINT recurring_jobs_node_nonempty CHECK (length(btrim(node_id)) > 0),
    CONSTRAINT recurring_jobs_agent_nonempty CHECK (length(btrim(agent_id)) > 0),
    CONSTRAINT recurring_jobs_model_preset_nonempty CHECK (
        model_preset IS NULL OR length(btrim(model_preset)) > 0
    ),
    CONSTRAINT recurring_jobs_container_kind CHECK (container_kind IN ('folder', 'task')),
    CONSTRAINT recurring_jobs_container_id_nonempty CHECK (length(btrim(container_id)) > 0),
    CONSTRAINT recurring_jobs_folder_id_nonempty CHECK (length(btrim(folder_id)) > 0),
    CONSTRAINT recurring_jobs_late_window_positive CHECK (late_run_window_seconds > 0),
    CONSTRAINT recurring_jobs_version_positive CHECK (version > 0),
    CONSTRAINT recurring_jobs_idempotency_nonempty CHECK (length(btrim(created_idempotency_key)) > 0),
    CONSTRAINT recurring_jobs_created_by_nonempty CHECK (length(btrim(created_by)) > 0),
    CONSTRAINT recurring_jobs_updated_by_nonempty CHECK (length(btrim(updated_by)) > 0),
    CONSTRAINT recurring_jobs_owner_create_idempotency_unique
        UNIQUE (owner_email, created_idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_recurring_jobs_owner_active
    ON recurring_jobs(owner_email, archived_at, enabled, next_run_at);
CREATE INDEX IF NOT EXISTS idx_recurring_jobs_due
    ON recurring_jobs(next_run_at)
    WHERE archived_at IS NULL AND enabled = TRUE;

CREATE TABLE IF NOT EXISTS recurring_job_runs (
    run_id                      TEXT PRIMARY KEY,
    job_id                      TEXT NOT NULL REFERENCES recurring_jobs(job_id),
    trigger                     TEXT NOT NULL,
    scheduled_for               TIMESTAMPTZ,
    manual_idempotency_key      TEXT,
    session_id                  TEXT NOT NULL,
    job_snapshot                JSONB NOT NULL,
    state                       TEXT NOT NULL,
    reason_code                 TEXT,
    reason_message              TEXT,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at                  TIMESTAMPTZ,
    finished_at                 TIMESTAMPTZ,
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT recurring_job_runs_trigger CHECK (trigger IN ('scheduled', 'manual')),
    CONSTRAINT recurring_job_runs_scheduled_for CHECK (
        (trigger = 'scheduled' AND scheduled_for IS NOT NULL)
        OR (trigger = 'manual' AND scheduled_for IS NULL)
    ),
    CONSTRAINT recurring_job_runs_manual_idempotency CHECK (
        trigger <> 'manual' OR manual_idempotency_key IS NOT NULL
    ),
    CONSTRAINT recurring_job_runs_session_id_nonempty CHECK (length(btrim(session_id)) > 0),
    CONSTRAINT recurring_job_runs_snapshot_object CHECK (jsonb_typeof(job_snapshot) = 'object'),
    CONSTRAINT recurring_job_runs_state CHECK (state IN (
        'queued', 'waiting_for_node', 'dispatching', 'awaiting_session', 'running',
        'completed', 'error', 'interrupted', 'skipped_overlap', 'skipped_late', 'cancelled'
    )),
    CONSTRAINT recurring_job_runs_reason_pair CHECK (
        (reason_code IS NULL AND reason_message IS NULL)
        OR (reason_code IS NOT NULL AND reason_message IS NOT NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS recurring_job_runs_scheduled_unique
    ON recurring_job_runs(job_id, scheduled_for)
    WHERE trigger = 'scheduled';
CREATE UNIQUE INDEX IF NOT EXISTS recurring_job_runs_manual_idempotency_unique
    ON recurring_job_runs(job_id, manual_idempotency_key)
    WHERE trigger = 'manual';
CREATE UNIQUE INDEX IF NOT EXISTS recurring_job_runs_one_active_per_job
    ON recurring_job_runs(job_id)
    WHERE state IN ('queued', 'waiting_for_node', 'dispatching', 'awaiting_session', 'running');
CREATE INDEX IF NOT EXISTS idx_recurring_job_runs_job_created
    ON recurring_job_runs(job_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_recurring_job_runs_session
    ON recurring_job_runs(session_id);
