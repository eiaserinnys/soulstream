ALTER TABLE file_assets
    ADD COLUMN storage_purpose TEXT NOT NULL DEFAULT 'board'
        CHECK (storage_purpose IN ('board', 'attachment')),
    ADD COLUMN storage_endpoint TEXT,
    ADD COLUMN storage_bucket TEXT,
    ADD COLUMN owner_kind TEXT CHECK (owner_kind IN ('user_email', 'agent_session')),
    ADD COLUMN owner_key TEXT,
    ADD COLUMN registration_scope JSONB,
    ADD COLUMN source_node_id TEXT,
    ADD COLUMN source_session_id TEXT,
    ADD COLUMN output_command_id TEXT;

CREATE TABLE attachment_legacy_aliases (
    node_id         TEXT NOT NULL,
    normalized_path TEXT NOT NULL,
    asset_id        TEXT REFERENCES file_assets(id) ON DELETE RESTRICT,
    original_path   TEXT NOT NULL,
    availability    TEXT NOT NULL CHECK (availability IN ('resolved', 'missing')),
    checked_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (node_id, normalized_path),
    CHECK (
        (availability = 'resolved' AND asset_id IS NOT NULL)
        OR (availability = 'missing' AND asset_id IS NULL)
    )
);

ALTER TABLE cards
    ADD COLUMN attachment_refs JSONB NOT NULL DEFAULT '[]'::jsonb
        CHECK (jsonb_typeof(attachment_refs) = 'array');

ALTER TABLE card_reports
    ADD COLUMN attachment_refs JSONB NOT NULL DEFAULT '[]'::jsonb
        CHECK (jsonb_typeof(attachment_refs) = 'array');

ALTER TABLE card_comments
    ADD COLUMN attachment_refs JSONB NOT NULL DEFAULT '[]'::jsonb
        CHECK (jsonb_typeof(attachment_refs) = 'array');
