-- 174: Central agent portrait store (card #1864)
--
-- One row per agent_id, independent of agent_profiles, so YAML-only agents can
-- have a portrait too. blob, mime, sha256 and byte_size are all present or all
-- NULL; an all-NULL row is a deletion marker that a later node registration
-- must not resurrect. Data is moved in by the orchestrator at startup, not here.
CREATE TABLE IF NOT EXISTS agent_portraits (
    agent_id        TEXT PRIMARY KEY,
    portrait_blob   BYTEA,
    portrait_mime   TEXT,
    portrait_sha256 TEXT,
    byte_size       INTEGER,
    source          TEXT NOT NULL,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT agent_portraits_agent_id_nonempty CHECK (length(agent_id) > 0),
    CONSTRAINT agent_portraits_source_known CHECK (source IN ('upload', 'profile', 'node')),
    CONSTRAINT agent_portraits_complete CHECK (
        (portrait_blob IS NULL AND portrait_mime IS NULL AND portrait_sha256 IS NULL AND byte_size IS NULL)
        OR
        (portrait_blob IS NOT NULL AND portrait_mime IS NOT NULL AND portrait_sha256 IS NOT NULL AND byte_size IS NOT NULL)
    ),
    CONSTRAINT agent_portraits_mime_supported CHECK (
        portrait_mime IS NULL OR portrait_mime IN (
            'image/png', 'image/jpeg', 'image/webp', 'image/gif'
        )
    ),
    CONSTRAINT agent_portraits_sha256_format CHECK (
        portrait_sha256 IS NULL OR portrait_sha256 ~ '^[0-9a-f]{64}$'
    )
);
