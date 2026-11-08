-- Global search reads newest postings index-only, so recent rows need their
-- visibility map set quickly: insert autovacuum now runs about hourly for
-- postings (~2.7M rows/day) and every two hours for documents; it skips
-- all-visible pages, so its cost tracks new rows.
ALTER TABLE event_search_postings
    SET (autovacuum_vacuum_insert_scale_factor = 0,
         autovacuum_vacuum_insert_threshold = 100000);

ALTER TABLE event_search_documents
    SET (autovacuum_vacuum_insert_scale_factor = 0,
         autovacuum_vacuum_insert_threshold = 5000);
