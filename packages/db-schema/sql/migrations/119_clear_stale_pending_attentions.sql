-- Clear stale rows left by migration 090's backfill for sessions that have ended.
-- Unresolved input requests only exist while their session is running.
DELETE FROM session_pending_attentions AS attention
USING sessions AS session
WHERE session.session_id = attention.session_id
  AND session.status <> 'running';
