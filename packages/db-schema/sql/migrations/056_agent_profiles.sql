CREATE TABLE IF NOT EXISTS agent_profiles (
    agent_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    atom_contexts JSONB NOT NULL DEFAULT '[]'::jsonb,
    default_preset TEXT,
    aliases JSONB NOT NULL DEFAULT '[]'::jsonb,
    portrait_blob BYTEA,
    portrait_mime TEXT,
    portrait_sha256 TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT agent_profiles_agent_id_nonempty CHECK (length(agent_id) > 0),
    CONSTRAINT agent_profiles_name_nonempty CHECK (length(name) > 0),
    CONSTRAINT agent_profiles_atom_contexts_array CHECK (jsonb_typeof(atom_contexts) = 'array'),
    CONSTRAINT agent_profiles_aliases_array CHECK (jsonb_typeof(aliases) = 'array'),
    CONSTRAINT agent_profiles_version_positive CHECK (version > 0),
    CONSTRAINT agent_profiles_portrait_complete CHECK (
        (portrait_blob IS NULL AND portrait_mime IS NULL AND portrait_sha256 IS NULL)
        OR
        (portrait_blob IS NOT NULL AND portrait_mime IS NOT NULL AND portrait_sha256 IS NOT NULL)
    ),
    CONSTRAINT agent_profiles_portrait_mime_supported CHECK (
        portrait_mime IS NULL OR portrait_mime IN (
            'image/png', 'image/jpeg', 'image/webp', 'image/gif'
        )
    ),
    CONSTRAINT agent_profiles_portrait_sha256_format CHECK (
        portrait_sha256 IS NULL OR portrait_sha256 ~ '^[0-9a-f]{64}$'
    )
);

CREATE INDEX IF NOT EXISTS idx_agent_profiles_updated_at
    ON agent_profiles(updated_at DESC, agent_id ASC);
