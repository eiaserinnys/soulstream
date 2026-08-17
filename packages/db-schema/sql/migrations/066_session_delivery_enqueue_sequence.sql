-- 066: monotonic runtime-followup admission order
--
-- UUID lexical order is not enqueue order. This identity is the canonical
-- third comparator after followup_attempt and created_at, including recovery.

ALTER TABLE session_deliveries
    ADD COLUMN IF NOT EXISTS enqueue_sequence BIGINT GENERATED ALWAYS AS IDENTITY;

CREATE INDEX IF NOT EXISTS idx_session_deliveries_runtime_followup_latest
    ON session_deliveries (
        target_session_id,
        (payload->>'followup_key'),
        created_at,
        enqueue_sequence
    )
    WHERE intent = 'runtime_followup'
      AND source = 'claude_runtime_task_followup';
