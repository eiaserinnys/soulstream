-- 164: event ingress receipt commit time index for delivery latency (card #1595)
--
-- event_ingress_receipts had no index on created_at, so the delivery latency
-- query (a created_at range on receipts) scanned the table. Migrations run
-- inside one transaction, so CONCURRENTLY is not available; the table is small
-- enough that a regular build is acceptable.

CREATE INDEX IF NOT EXISTS idx_event_ingress_receipts_created_at
    ON event_ingress_receipts (created_at);
