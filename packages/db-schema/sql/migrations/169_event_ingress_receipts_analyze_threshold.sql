-- This append-heavy table's default 0.1 scale factor sets the analyze threshold
-- to about 810,000 rows, leaving statistics stale for days.
ALTER TABLE event_ingress_receipts
    SET (autovacuum_analyze_scale_factor = 0,
         autovacuum_analyze_threshold = 50000);
