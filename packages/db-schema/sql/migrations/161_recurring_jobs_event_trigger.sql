-- 161: recurring jobs can wake when a node connects (card #1443)
--
-- A. An event job keeps an empty cron array and no run_at; event_trigger is the
--    JSON object describing the node-connected condition. next_run_at stays NULL,
--    so the existing due-job query never selects it.
-- B. Event runs record the firing instant in scheduled_for and use the 'event'
--    trigger value.
-- C. recurring_node_presence is the orchestrator's per-node connected episode.
--    A disconnect of at most 600 seconds keeps the same episode across an
--    orchestrator restart. soulstream_node_heartbeats is a separate worker-owned
--    signal; it is neither read nor changed here.

ALTER TABLE recurring_jobs
    ADD COLUMN IF NOT EXISTS event_trigger JSONB,
    ADD COLUMN IF NOT EXISTS event_last_fired_at TIMESTAMPTZ;

ALTER TABLE recurring_jobs
    DROP CONSTRAINT IF EXISTS recurring_jobs_schedule_shape;

ALTER TABLE recurring_jobs
    ADD CONSTRAINT recurring_jobs_schedule_shape CHECK (
        jsonb_typeof(schedule_expressions) = 'array'
        AND (
            (schedule_kind = 'recurring'
                AND jsonb_array_length(schedule_expressions) > 0
                AND run_at IS NULL
                AND event_trigger IS NULL)
            OR (schedule_kind = 'once'
                AND jsonb_array_length(schedule_expressions) = 0
                AND run_at IS NOT NULL
                AND event_trigger IS NULL)
            OR (schedule_kind = 'event'
                AND jsonb_array_length(schedule_expressions) = 0
                AND run_at IS NULL
                AND jsonb_typeof(event_trigger) = 'object')
        )
    );

ALTER TABLE recurring_job_runs
    DROP CONSTRAINT IF EXISTS recurring_job_runs_trigger;

ALTER TABLE recurring_job_runs
    ADD CONSTRAINT recurring_job_runs_trigger
    CHECK (trigger IN ('scheduled', 'manual', 'event'));

ALTER TABLE recurring_job_runs
    DROP CONSTRAINT IF EXISTS recurring_job_runs_scheduled_for;

ALTER TABLE recurring_job_runs
    ADD CONSTRAINT recurring_job_runs_scheduled_for CHECK (
        (trigger = 'scheduled' AND scheduled_for IS NOT NULL)
        OR (trigger = 'manual' AND scheduled_for IS NULL)
        OR (trigger = 'event' AND scheduled_for IS NOT NULL)
    );

CREATE TABLE IF NOT EXISTS recurring_node_presence (
    node_id             TEXT PRIMARY KEY,
    episode_started_at  TIMESTAMPTZ NOT NULL,
    last_seen_at        TIMESTAMPTZ NOT NULL
);
