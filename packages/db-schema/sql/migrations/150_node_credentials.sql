CREATE TABLE IF NOT EXISTS node_credentials (
    credential_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    node_id TEXT NOT NULL,
    company_pc BOOLEAN NOT NULL,
    token_sha256 CHAR(64) NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_node_credentials_active_node
    ON node_credentials (node_id)
    WHERE revoked_at IS NULL;
