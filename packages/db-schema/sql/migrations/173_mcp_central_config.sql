-- 173: MCP central configuration store (card #1786)
--
-- Central source of truth for MCP servers, profiles, agent bindings and the
-- secret values they reference. Server and profile JSON only ever store
-- {{secret:...}} or {{env:...}} references; plaintext values live in
-- mcp_secrets and never leave this store through list/detail responses.
--
-- Writes serialize on the single mcp_config_state row. Config writes bump
-- current_revision in their first statement; record writes lock the row without
-- bumping it; display acknowledgements touch only mcp_managed_nodes.
CREATE TABLE IF NOT EXISTS mcp_config_state (
    id               SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    current_revision BIGINT NOT NULL DEFAULT 0,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS mcp_managed_nodes (
    node_id                TEXT PRIMARY KEY,
    central_active         BOOLEAN NOT NULL DEFAULT FALSE,
    activated_at           TIMESTAMPTZ,
    applied_mode           TEXT,
    applied_revision       BIGINT NOT NULL DEFAULT 0,
    last_sync_at           TIMESTAMPTZ,
    last_sync_error        TEXT,
    last_compare_id        UUID,
    last_verified_revision BIGINT,
    last_verified_at       TIMESTAMPTZ,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS mcp_secrets (
    name       TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS mcp_servers (
    id             TEXT PRIMARY KEY,
    name           TEXT,
    type           TEXT NOT NULL CHECK (type IN ('stdio', 'streamable_http', 'sse')),
    config         JSONB NOT NULL,
    node_scope     JSONB NOT NULL,
    node_overrides JSONB NOT NULL DEFAULT '{}'::jsonb,
    icon           JSONB,
    version        INTEGER NOT NULL DEFAULT 1,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS mcp_server_icons (
    id           UUID PRIMARY KEY,
    server_id    TEXT REFERENCES mcp_servers(id) ON DELETE SET NULL,
    mime         TEXT NOT NULL CHECK (mime IN ('image/png', 'image/jpeg', 'image/webp')),
    body         BYTEA NOT NULL,
    width        INTEGER NOT NULL CHECK (width BETWEEN 1 AND 512),
    height       INTEGER NOT NULL CHECK (height BETWEEN 1 AND 512),
    content_hash TEXT NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mcp_server_icons_server
    ON mcp_server_icons (server_id);

CREATE INDEX IF NOT EXISTS idx_mcp_server_icons_created_at
    ON mcp_server_icons (created_at);

CREATE TABLE IF NOT EXISTS mcp_profiles (
    id          TEXT PRIMARY KEY,
    name        TEXT,
    description TEXT,
    mcp_servers JSONB NOT NULL DEFAULT '[]'::jsonb,
    hosted_tools JSONB NOT NULL DEFAULT '[]'::jsonb,
    node_scope  JSONB NOT NULL DEFAULT '[]'::jsonb,
    version     INTEGER NOT NULL DEFAULT 1,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS mcp_agent_bindings (
    agent_id       TEXT NOT NULL,
    node_id        TEXT NOT NULL REFERENCES mcp_managed_nodes(node_id) ON DELETE RESTRICT,
    mcp_profile_id TEXT NOT NULL REFERENCES mcp_profiles(id) ON DELETE RESTRICT,
    version        INTEGER NOT NULL DEFAULT 1,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (agent_id, node_id)
);

CREATE TABLE IF NOT EXISTS mcp_config_revisions (
    id         BIGSERIAL PRIMARY KEY,
    target     TEXT NOT NULL CHECK (target IN ('server', 'profile', 'binding')),
    target_id  TEXT NOT NULL,
    snapshot   JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mcp_config_revisions_target
    ON mcp_config_revisions (target, target_id, id DESC);
