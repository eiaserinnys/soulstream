CREATE TABLE IF NOT EXISTS pages (
    id                 TEXT PRIMARY KEY,
    title              TEXT NOT NULL CHECK (btrim(title) <> ''),
    title_key          TEXT GENERATED ALWAYS AS (lower(btrim(title))) STORED,
    daily_date         DATE,
    version            INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    archived           BOOLEAN NOT NULL DEFAULT FALSE,
    metadata           JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
    created_event_id   INTEGER,
    updated_session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
    updated_event_id   INTEGER,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT pages_created_event_fkey
        FOREIGN KEY (created_session_id, created_event_id)
        REFERENCES events(session_id, id) ON DELETE SET NULL,
    CONSTRAINT pages_updated_event_fkey
        FOREIGN KEY (updated_session_id, updated_event_id)
        REFERENCES events(session_id, id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_pages_title_key ON pages(title_key);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pages_daily_date
    ON pages(daily_date) WHERE daily_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pages_active_updated
    ON pages(archived, updated_at DESC);

CREATE TABLE IF NOT EXISTS blocks (
    id                 TEXT PRIMARY KEY,
    page_id            TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    parent_id          TEXT,
    position_key       TEXT NOT NULL CHECK (position_key <> ''),
    block_type         TEXT NOT NULL DEFAULT 'paragraph',
    text_plain         TEXT NOT NULL DEFAULT '',
    properties         JSONB NOT NULL DEFAULT '{}'::JSONB,
    collapsed          BOOLEAN NOT NULL DEFAULT FALSE,
    created_session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
    created_event_id   INTEGER,
    updated_session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
    updated_event_id   INTEGER,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_blocks_page_id_id UNIQUE (page_id, id),
    CONSTRAINT blocks_not_own_parent CHECK (parent_id IS NULL OR parent_id <> id),
    CONSTRAINT blocks_parent_same_page_fkey
        FOREIGN KEY (page_id, parent_id)
        REFERENCES blocks(page_id, id) ON DELETE CASCADE,
    CONSTRAINT blocks_created_event_fkey
        FOREIGN KEY (created_session_id, created_event_id)
        REFERENCES events(session_id, id) ON DELETE SET NULL,
    CONSTRAINT blocks_updated_event_fkey
        FOREIGN KEY (updated_session_id, updated_event_id)
        REFERENCES events(session_id, id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_blocks_tree
    ON blocks(page_id, parent_id, position_key, id);
CREATE INDEX IF NOT EXISTS idx_blocks_type
    ON blocks(page_id, block_type);

CREATE TABLE IF NOT EXISTS block_operations (
    id               TEXT PRIMARY KEY,
    page_id          TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    target_block_id  TEXT REFERENCES blocks(id) ON DELETE SET NULL,
    operation_type   TEXT NOT NULL,
    actor_kind       TEXT NOT NULL CHECK (actor_kind IN ('agent','user','system')),
    actor_session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
    actor_event_id   INTEGER,
    actor_user_id    TEXT,
    idempotency_key  TEXT NOT NULL,
    expected_version INTEGER NOT NULL,
    result_version   INTEGER NOT NULL,
    payload_json     JSONB NOT NULL DEFAULT '{}'::JSONB,
    reason           TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT block_operations_actor_event_fkey
        FOREIGN KEY (actor_session_id, actor_event_id)
        REFERENCES events(session_id, id) ON DELETE SET NULL,
    CONSTRAINT block_operations_agent_actor_check
        CHECK (actor_kind <> 'agent' OR actor_session_id IS NOT NULL),
    CONSTRAINT block_operations_user_actor_check
        CHECK (actor_kind <> 'user' OR actor_user_id IS NOT NULL),
    CONSTRAINT block_operations_version_check
        CHECK (result_version = expected_version + 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_block_operations_idempotency
    ON block_operations(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_block_operations_page
    ON block_operations(page_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_block_operations_target
    ON block_operations(target_block_id, created_at, id)
    WHERE target_block_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS block_links (
    id                 TEXT PRIMARY KEY,
    source_block_id    TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
    link_kind          TEXT NOT NULL CHECK (link_kind IN ('mount','inline_page','block_ref')),
    ordinal            INTEGER NOT NULL CHECK (ordinal >= 0),
    source_start       INTEGER NOT NULL CHECK (source_start >= 0),
    source_end         INTEGER NOT NULL CHECK (source_end > source_start),
    target_page_id     TEXT REFERENCES pages(id) ON DELETE SET NULL,
    target_title       TEXT,
    target_title_key   TEXT,
    target_block_id    TEXT REFERENCES blocks(id) ON DELETE SET NULL,
    target_block_ref   TEXT,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_block_links_source_ordinal UNIQUE (source_block_id, ordinal),
    CONSTRAINT block_links_target_shape_check CHECK (
      (link_kind IN ('mount','inline_page')
       AND target_title IS NOT NULL AND target_title_key IS NOT NULL
       AND target_block_ref IS NULL)
      OR
      (link_kind = 'block_ref'
       AND target_block_ref IS NOT NULL
       AND target_title IS NULL AND target_title_key IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_block_links_target_page
    ON block_links(target_page_id, link_kind, created_at)
    WHERE target_page_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_block_links_unresolved_page
    ON block_links(target_title_key)
    WHERE target_page_id IS NULL AND target_title_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_block_links_target_block
    ON block_links(target_block_id, created_at)
    WHERE target_block_id IS NOT NULL;
