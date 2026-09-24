-- Tune insert-triggered autovacuum only for the high-churn posting table.
-- This is a visibility-map maintenance setting, not a BM25 scoring fix.
ALTER TABLE public.event_search_terms
    SET (autovacuum_vacuum_insert_scale_factor = 0.05);
