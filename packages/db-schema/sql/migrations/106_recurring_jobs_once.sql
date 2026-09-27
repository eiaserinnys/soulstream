ALTER TABLE recurring_jobs
    ADD COLUMN IF NOT EXISTS schedule_kind TEXT NOT NULL DEFAULT 'recurring',
    ADD COLUMN IF NOT EXISTS run_at TIMESTAMPTZ;

ALTER TABLE recurring_jobs
    DROP CONSTRAINT IF EXISTS recurring_jobs_schedule_array;

ALTER TABLE recurring_jobs
    DROP CONSTRAINT IF EXISTS recurring_jobs_schedule_shape;

ALTER TABLE recurring_jobs
    ADD CONSTRAINT recurring_jobs_schedule_shape CHECK (
        jsonb_typeof(schedule_expressions) = 'array'
        AND (
            (schedule_kind = 'recurring' AND jsonb_array_length(schedule_expressions) > 0 AND run_at IS NULL)
            OR (schedule_kind = 'once' AND jsonb_array_length(schedule_expressions) = 0 AND run_at IS NOT NULL)
        )
    );
