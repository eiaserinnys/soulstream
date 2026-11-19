-- 171: central Claude account pool (card #1734)
--
-- One row per Claude account that the orchestrator signs in to directly. The
-- orchestrator refreshes tokens and samples usage here, then pushes a snapshot
-- to worker nodes on the claude_central_pool_sync command. Tokens are stored in
-- plaintext like the node-side account pool (card #1734 spec); this table is
-- the single source for the pool snapshot.
CREATE TABLE IF NOT EXISTS claude_central_accounts (
    id UUID PRIMARY KEY,
    email TEXT NOT NULL,
    plan TEXT,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    priority INTEGER NOT NULL DEFAULT 0,
    access_token TEXT,
    refresh_token TEXT,
    expires_at TIMESTAMPTZ,
    token_lifetime_sec INTEGER,
    scopes TEXT,
    auth_state TEXT NOT NULL DEFAULT 'ok',
    relogin_reason TEXT,
    refreshed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT claude_central_accounts_auth_state_check
        CHECK (auth_state IN ('ok', 'needs_relogin'))
);
