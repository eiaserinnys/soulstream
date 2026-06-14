-- Session list queries order by updated_at DESC. Build concurrently for existing deployments.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sessions_updated_at
    ON sessions (updated_at DESC);
