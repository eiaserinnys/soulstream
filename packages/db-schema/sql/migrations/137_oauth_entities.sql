CREATE TABLE IF NOT EXISTS oauth_entities (
    kind TEXT NOT NULL,
    id TEXT NOT NULL,
    payload JSONB NOT NULL,
    expires_at TIMESTAMPTZ,
    grant_id TEXT,
    consumed_at TIMESTAMPTZ,
    PRIMARY KEY (kind, id)
);
CREATE INDEX IF NOT EXISTS oauth_entities_grant_id_idx ON oauth_entities (grant_id);
CREATE INDEX IF NOT EXISTS oauth_entities_uid_idx ON oauth_entities ((payload->>'uid')) WHERE kind = 'Session';
