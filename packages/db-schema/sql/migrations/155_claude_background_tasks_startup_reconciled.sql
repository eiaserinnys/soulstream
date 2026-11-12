-- 155: record when a worker boot finished reconciling a terminal background task
--
-- The startup legacy-lost reconciliation used to re-read every terminal row on
-- every restart. Workers mark each row they concluded (recovered or skipped)
-- so the next boot reads only the rows still outstanding.
ALTER TABLE claude_background_tasks
  ADD COLUMN IF NOT EXISTS startup_reconciled_at TIMESTAMPTZ;
