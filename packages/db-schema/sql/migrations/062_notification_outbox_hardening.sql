ALTER TABLE session_delivery_notification_outbox
    ADD COLUMN IF NOT EXISTS dead_lettered_at TIMESTAMPTZ;

ALTER TABLE session_delivery_notification_outbox
    DROP CONSTRAINT IF EXISTS session_delivery_notification_state_check;
ALTER TABLE session_delivery_notification_outbox
    ADD CONSTRAINT session_delivery_notification_state_check
    CHECK (state IN ('pending', 'claimed', 'published', 'dead_letter'));

UPDATE session_delivery_notification_outbox
   SET state = 'dead_letter',
       lease_owner = NULL,
       lease_expires_at = NULL,
       last_error = 'legacy camelCase deliveryIntent quarantined by migration 062',
       dead_lettered_at = NOW(),
       updated_at = NOW()
 WHERE state <> 'published'
   AND payload ? 'deliveryIntent'
   AND NOT payload ? 'delivery_intent';

UPDATE session_delivery_notification_outbox AS outbox
   SET state = 'dead_letter',
       lease_owner = NULL,
       lease_expires_at = NULL,
       last_error = 'notification target session has no owner node',
       dead_lettered_at = NOW(),
       updated_at = NOW()
 WHERE outbox.state <> 'published'
   AND NOT EXISTS (
       SELECT 1
         FROM sessions AS target
        WHERE target.session_id = outbox.target_session_id
          AND target.node_id IS NOT NULL
   );
