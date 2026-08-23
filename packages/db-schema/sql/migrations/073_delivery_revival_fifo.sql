-- 073: recover exhausted deliveries and index strict per-target ordering

CREATE INDEX IF NOT EXISTS idx_session_deliveries_target_enqueue_open
    ON session_deliveries(target_session_id, enqueue_sequence)
    WHERE aggregate_state IN ('pending', 'delivered')
      AND state NOT IN ('consumed', 'superseded');

UPDATE session_deliveries
SET
    aggregate_state = 'pending',
    next_attempt_at = NOW(),
    dead_letter_reason = NULL,
    dead_lettered_at = NULL,
    updated_at = NOW()
WHERE state = 'uncertain'
  AND aggregate_state = 'dead_letter'
  AND target_receipt_id IS NULL
  AND attempt_count >= 16
  AND COALESCE(dead_letter_reason, '') NOT IN (
      'delivery identity conflict',
      'delivery_result_not_accepted',
      'stale_self_completion_delivery'
  );
