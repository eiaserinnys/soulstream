-- Feed unread uses the raw event-id coordinate, but historical raw ids are not
-- evidence that the old event changed the compact feed. NULL remains an
-- explicit legacy-unknown state until a new semantic projection advances it.
ALTER TABLE session_feed_state
  ADD COLUMN IF NOT EXISTS feed_last_event_id INTEGER
  CHECK (feed_last_event_id IS NULL OR feed_last_event_id > 0);
