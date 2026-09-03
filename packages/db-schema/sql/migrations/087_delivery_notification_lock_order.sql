DROP TRIGGER IF EXISTS trg_session_discard_notification_projection
    ON session_deliveries;
DROP FUNCTION IF EXISTS session_discard_notification_projection_on_consumed();
