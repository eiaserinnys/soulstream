-- Cover the global event-type eligibility path used by event_search.
CREATE INDEX IF NOT EXISTS idx_events_event_type_cover
    ON public.events USING btree (event_type)
    INCLUDE (session_id, id, created_at);
