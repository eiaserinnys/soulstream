-- Session search incremental refresh reads events turn_summary rows index-only,
-- so recent pages need their visibility map set quickly: without this insert
-- autovacuum only runs every 0.2 x table rows, and stale pages force heap
-- fetches. At the current insert rate the new threshold runs about every
-- 30-40 minutes, and VACUUM skips all-visible pages so its cost tracks pages
-- changed since the previous pass.
ALTER TABLE events
    SET (autovacuum_vacuum_insert_scale_factor = 0,
         autovacuum_vacuum_insert_threshold = 200000);
